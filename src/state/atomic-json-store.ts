import {
  buildBindingDocumentKey,
  buildInstallRecordKey,
  createEmptyBindingConsentDocument,
  decodeBindingConsentDocument,
  decodeInstallRecord,
  generateInstallNonce,
  reduceBindingIntent,
  reduceConsentIntent,
  type BindingConsentDocument,
  type BindingIntent,
  type ConsentIntent,
  type DocumentWriteExpectation,
  type InstallRecord,
} from "./documents"

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const INSTALL_NONCE_PATTERN = /^[0-9a-f]{32}$/
const TEMP_MARKER = ".tmp."
const QUARANTINE_MARKER = ".quarantine."

function normalizeListedPath(directory: string, listedPath: string): string | undefined {
  if (
    listedPath.length === 0 ||
    listedPath.includes("\u0000") ||
    listedPath.includes("\\") ||
    listedPath.startsWith("/") ||
    /^[A-Za-z]:\//.test(listedPath)
  ) {
    return undefined
  }
  const directoryPrefix = directory.length > 0 ? `${directory}/` : ""
  const candidate = listedPath.startsWith(directoryPrefix)
    ? listedPath
    : `${directoryPrefix}${listedPath}`
  const segments = candidate.split("/")
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return undefined
  }
  return candidate
}

/** The smallest host-specific boundary needed by AtomicJsonStore. */
export interface StorageAdapter {
  read(path: string): Promise<unknown>
  write(path: string, content: string): Promise<void>
  move(sourcePath: string, destinationPath: string): Promise<void>
  delete(path: string): Promise<void>
  exists(path: string): Promise<boolean>
  /** Optional enumeration lets a host remove orphaned temps after a restart. */
  list?(prefix: string): Promise<readonly string[]>
}

export type AtomicJsonStoreErrorCode =
  | "NOT_INITIALIZED"
  | "INVALID_HOST_INSTALLATION_ID"
  | "CORRUPT_INSTALL_RECORD"
  | "CORRUPT_DOCUMENT"
  | "INSTALL_MISMATCH"
  | "REVISION_MISMATCH"
  | "STORAGE_FAILURE"

export class AtomicJsonStoreError extends Error {
  readonly code: AtomicJsonStoreErrorCode
  readonly causeValue: unknown

  constructor(code: AtomicJsonStoreErrorCode, message: string, causeValue?: unknown) {
    super(message)
    this.name = "AtomicJsonStoreError"
    this.code = code
    this.causeValue = causeValue
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export type AtomicJsonStoreOptions = Readonly<{
  installRecordPath?: string
  nonceGenerator?: () => string
}>

type QueuedOperation<T> = () => Promise<T>

type ReadResult = Readonly<{
  path: string
  document: BindingConsentDocument
}>

function fail(
  code: AtomicJsonStoreErrorCode,
  message: string,
  causeValue?: unknown,
): never {
  throw new AtomicJsonStoreError(code, message, causeValue)
}

function assertHostInstallationId(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    return fail(
      "INVALID_HOST_INSTALLATION_ID",
      "Host extensionInstallationId must be a canonical lowercase UUID",
    )
  }
  return value
}

function assertInstallNonce(value: unknown, label: string): string {
  if (typeof value !== "string" || !INSTALL_NONCE_PATTERN.test(value)) {
    return fail("INSTALL_MISMATCH", `${label} must be a canonical install nonce`)
  }
  return value
}

function assertRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return fail("REVISION_MISMATCH", "Expected documentRevision must be a non-negative safe integer")
  }
  return value
}

function parseStorageValue(value: unknown, path: string): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as unknown
    } catch (error) {
      return fail("CORRUPT_DOCUMENT", `Stored JSON at ${path} is not valid JSON`, error)
    }
  }
  if (value instanceof Uint8Array) {
    try {
      return JSON.parse(new TextDecoder().decode(value)) as unknown
    } catch (error) {
      return fail("CORRUPT_DOCUMENT", `Stored JSON at ${path} is not valid UTF-8 JSON`, error)
    }
  }
  return value
}

function serialize(value: object, path: string): string {
  try {
    const encoded = JSON.stringify(value)
    if (typeof encoded !== "string") return fail("CORRUPT_DOCUMENT", `Could not serialize ${path}`)
    return encoded
  } catch (error) {
    return fail("CORRUPT_DOCUMENT", `Could not serialize ${path}`, error)
  }
}

function pairEquals(
  left: InstallRecord,
  extensionInstallationId: string,
  installNonce: string,
): boolean {
  return (
    left.extensionInstallationId === extensionInstallationId && left.installNonce === installNonce
  )
}

function expectationFrom(
  expected: DocumentWriteExpectation | number,
  active: InstallRecord,
  expectedInstallId?: string,
  expectedNonce?: string,
): DocumentWriteExpectation {
  if (typeof expected === "number") {
    const extensionInstallationId = expectedInstallId ?? active.extensionInstallationId
    const installNonce = expectedNonce ?? active.installNonce
    return Object.freeze({
      documentRevision: assertRevision(expected),
      extensionInstallationId: assertHostInstallationId(extensionInstallationId),
      installNonce: assertInstallNonce(installNonce, "Expected installNonce"),
    })
  }

  const documentRevision = assertRevision(expected.documentRevision)
  const extensionInstallationId = assertHostInstallationId(expected.extensionInstallationId)
  const installNonce = assertInstallNonce(expected.installNonce, "Expected installNonce")
  return Object.freeze({ documentRevision, extensionInstallationId, installNonce })
}

export class AtomicJsonStore {
  private readonly storage: StorageAdapter
  private readonly installRecordPath: string
  private readonly nonceGenerator: () => string
  private readonly ownerToken: string
  private tempSequence = 0
  private installRecord: InstallRecord | undefined
  private rotatedInstall = false
  private rotatedInstallToken: string | undefined
  private readonly rotatedQuarantinesByPath = new Map<string, Promise<void>>()
  private readonly queues = new Map<string, Promise<void>>()
  private readonly tempCleanupByPath = new Map<string, Promise<void>>()
  private readonly activeTempPaths = new Set<string>()
  private lifecycleGeneration = 0
  private initializationBarrier: Promise<void> = Promise.resolve()
  private readonly activeOperations = new Map<Promise<unknown>, number>()

  constructor(storage: StorageAdapter, options: AtomicJsonStoreOptions = {}) {
    this.storage = storage
    this.installRecordPath = options.installRecordPath ?? buildInstallRecordKey()
    this.nonceGenerator = options.nonceGenerator ?? generateInstallNonce
    this.ownerToken = assertInstallNonce(this.nonceGenerator(), "Generated ownerToken")
  }

  /**
   * Removes orphaned install-record temporary files before initialization.
   * User-scoped state is cleaned lazily by cleanupPathTemps before path access.
   */
  private async cleanupStartupTemps(): Promise<void> {
    await this.cleanupPathTemps(this.installRecordPath)
  }

  private async cleanupPathTemps(canonicalPath: string): Promise<void> {
    if (typeof this.storage.list !== "function") return

    const separator = canonicalPath.lastIndexOf("/")
    const directory = separator < 0 ? "" : canonicalPath.slice(0, separator)
    const basename = separator < 0 ? canonicalPath : canonicalPath.slice(separator + 1)
    const directoryPrefix = directory.length > 0 ? `${directory}/` : ""
    const tempFilenamePrefix = `${basename}${TEMP_MARKER}`
    const quarantineTempPrefix = `${basename}${QUARANTINE_MARKER}`
    const current = this.tempCleanupByPath.get(canonicalPath)
    if (current) return current

    const list = this.storage.list.bind(this.storage)
    const cleanup = (async () => {
      let paths: readonly string[]
      try {
        paths = await list(directory)
      } catch (error) {
        return fail("STORAGE_FAILURE", `Could not enumerate temporary state files for ${canonicalPath}`, error)
      }
      for (const listedPath of paths) {
        const normalizedPath = normalizeListedPath(directory, listedPath)
        if (normalizedPath === undefined) continue
        const filename = normalizedPath.startsWith(directoryPrefix)
          ? normalizedPath.slice(directoryPrefix.length)
          : normalizedPath
        const isCanonicalTemp = filename.startsWith(tempFilenamePrefix)
        const quarantineSuffix = filename.startsWith(quarantineTempPrefix)
          ? filename.slice(quarantineTempPrefix.length)
          : ""
        const quarantineSeparator = quarantineSuffix.indexOf(TEMP_MARKER)
        const isQuarantineTemp =
          quarantineSeparator > 0 &&
          INSTALL_NONCE_PATTERN.test(quarantineSuffix.slice(0, quarantineSeparator))
        if (filename.includes("/") || (!isCanonicalTemp && !isQuarantineTemp)) continue
        if (this.activeTempPaths.has(normalizedPath)) continue
        try {
          await this.storage.delete(normalizedPath)
        } catch (error) {
          return fail("STORAGE_FAILURE", `Could not remove stale temporary state file ${normalizedPath}`, error)
        }
      }
    })()
    this.tempCleanupByPath.set(canonicalPath, cleanup)

    try {
      await cleanup
    } finally {
      if (this.tempCleanupByPath.get(canonicalPath) === cleanup) {
        this.tempCleanupByPath.delete(canonicalPath)
      }
    }
  }

  private nextTempPath(canonicalPath: string): string {
    this.tempSequence += 1
    return `${canonicalPath}${TEMP_MARKER}${this.ownerToken}.${this.tempSequence}`
  }

  private nextQuarantinePath(canonicalPath: string): string {
    const scopeToken = this.rotatedInstallToken ?? this.ownerToken
    return `${canonicalPath}${QUARANTINE_MARKER}${scopeToken}`
  }

  private async ensureRotatedPathMarker(path: string): Promise<void> {
    const rotationToken = this.rotatedInstallToken
    if (!this.rotatedInstall || rotationToken === undefined) return

    const markerPath = this.nextQuarantinePath(path)
    await this.cleanupPathTemps(markerPath)
    let present: boolean
    try {
      present = await this.storage.exists(markerPath)
    } catch (error) {
      return fail("STORAGE_FAILURE", `Could not check rotated state marker ${markerPath}`, error)
    }
    if (present) return

    const marker = Object.freeze({
      schemaVersion: 1 as const,
      rotationInstallNonce: rotationToken,
    })
    await this.persistJsonAtomically(markerPath, serialize(marker, markerPath))
  }

  private requireInstallRecord(): InstallRecord {
    if (!this.installRecord) return fail("NOT_INITIALIZED", "AtomicJsonStore.initialize must run first")
    return this.installRecord
  }

  private async removeOwnTemp(path: string): Promise<void> {
    try {
      if (await this.storage.exists(path)) await this.storage.delete(path)
    } catch {
      // The original storage/write/move error remains the actionable failure.
    }
  }

  private async persistJsonAtomically(canonicalPath: string, content: string): Promise<void> {
    const tempPath = this.nextTempPath(canonicalPath)
    this.activeTempPaths.add(tempPath)
    try {
      await this.storage.write(tempPath, content)
      await this.storage.move(tempPath, canonicalPath)
    } catch (error) {
      await this.removeOwnTemp(tempPath)
      return fail("STORAGE_FAILURE", `Atomic write failed for ${canonicalPath}`, error)
    } finally {
      this.activeTempPaths.delete(tempPath)
    }
  }

  private async readExisting(path: string): Promise<unknown | undefined> {
    let present: boolean
    try {
      present = await this.storage.exists(path)
    } catch (error) {
      return fail("STORAGE_FAILURE", `Could not check state path ${path}`, error)
    }
    if (!present) return undefined

    try {
      const raw = await this.storage.read(path)
      if (raw === null || raw === undefined) {
        return fail("CORRUPT_DOCUMENT", `State path ${path} exists but has no content`)
      }
      return parseStorageValue(raw, path)
    } catch (error) {
      if (error instanceof AtomicJsonStoreError) throw error
      return fail("STORAGE_FAILURE", `Could not read state path ${path}`, error)
    }
  }

  /**
   * Rotate the install nonce only when the host installation ID changes. A
   * prior install record is copied to quarantine before the canonical move, so
   * a failed replacement never destroys the old canonical record.
   */
  async initialize(hostInstallationId: string): Promise<InstallRecord> {
    const previousBarrier = this.initializationBarrier
    const previousGeneration = this.lifecycleGeneration
    let release!: () => void
    const transition = new Promise<void>((resolve) => {
      release = resolve
    })
    this.lifecycleGeneration = previousGeneration + 1
    this.initializationBarrier = previousBarrier.then(() => transition)
    const activeBefore = [...this.activeOperations.entries()]
      .filter(([, generation]) => generation <= previousGeneration)
      .map(([operation]) => operation)

    try {
      await previousBarrier
      await Promise.all(
        activeBefore.map((operation) => operation.then(() => undefined, () => undefined)),
      )
      await this.cleanupStartupTemps()
      const hostId = assertHostInstallationId(hostInstallationId)
      const raw = await this.readExisting(this.installRecordPath)

      if (raw === undefined) {
        if (this.installRecord) {
          return fail(
            "CORRUPT_INSTALL_RECORD",
            "Persisted install record disappeared; refusing implicit reset",
          )
        }
        const created = Object.freeze({
          schemaVersion: 1 as const,
          extensionInstallationId: hostId,
          installNonce: assertInstallNonce(this.nonceGenerator(), "Generated installNonce"),
        })
        await this.persistJsonAtomically(this.installRecordPath, serialize(created, this.installRecordPath))
        this.installRecord = created
        this.rotatedInstall = false
        this.rotatedInstallToken = undefined
        return created
      }

      let prior: InstallRecord
      try {
        prior = decodeInstallRecord(raw)
      } catch (error) {
        return fail("CORRUPT_INSTALL_RECORD", "Persisted install record is corrupt; refusing reset", error)
      }

      if (prior.extensionInstallationId === hostId) {
        const rotationMarkerPath = `${this.installRecordPath}${QUARANTINE_MARKER}${prior.installNonce}`
        let rotated: boolean
        try {
          rotated = await this.storage.exists(rotationMarkerPath)
        } catch (error) {
          return fail("STORAGE_FAILURE", `Could not check install rotation marker ${rotationMarkerPath}`, error)
        }
        this.installRecord = prior
        this.rotatedInstall = rotated
        this.rotatedInstallToken = rotated ? prior.installNonce : undefined
        return prior
      }

      const next = Object.freeze({
        schemaVersion: 1 as const,
        extensionInstallationId: hostId,
        installNonce: assertInstallNonce(this.nonceGenerator(), "Generated installNonce"),
      })
      const rotationToken = next.installNonce
      const quarantinePath = `${this.installRecordPath}${QUARANTINE_MARKER}${rotationToken}`
      await this.persistJsonAtomically(quarantinePath, serialize(prior, quarantinePath))
      await this.persistJsonAtomically(this.installRecordPath, serialize(next, this.installRecordPath))
      this.installRecord = next
      this.rotatedInstall = true
      this.rotatedInstallToken = rotationToken
      return next
    } finally {
      release()
    }
  }

  /** Alias used by adapters that call startup explicitly. */
  async startup(hostInstallationId: string): Promise<InstallRecord> {
    return this.initialize(hostInstallationId)
  }

  getInstallRecord(): InstallRecord {
    return this.requireInstallRecord()
  }

  getInstallPair(): Readonly<{ extensionInstallationId: string; installNonce: string }> {
    const record = this.requireInstallRecord()
    return Object.freeze({
      extensionInstallationId: record.extensionInstallationId,
      installNonce: record.installNonce,
    })
  }

  private async quarantineRotatedDocument(path: string): Promise<void> {
    if (!this.rotatedInstall || this.rotatedInstallToken === undefined) return

    const current = this.rotatedQuarantinesByPath.get(path)
    if (current) return current

    const operation = (async () => {
      const quarantinePath = this.nextQuarantinePath(path)
      await this.cleanupPathTemps(quarantinePath)
      let quarantined: boolean
      try {
        quarantined = await this.storage.exists(quarantinePath)
      } catch (error) {
        return fail("STORAGE_FAILURE", `Could not check rotated quarantine path ${quarantinePath}`, error)
      }
      if (quarantined) return

      let present: boolean
      try {
        present = await this.storage.exists(path)
      } catch (error) {
        return fail("STORAGE_FAILURE", `Could not check rotated state path ${path}`, error)
      }
      if (!present) return

      try {
        await this.storage.move(path, quarantinePath)
      } catch (error) {
        return fail("STORAGE_FAILURE", `Could not quarantine rotated state path ${path}`, error)
      }
    })()
    this.rotatedQuarantinesByPath.set(path, operation)

    try {
      await operation
    } finally {
      if (this.rotatedQuarantinesByPath.get(path) === operation) {
        this.rotatedQuarantinesByPath.delete(path)
      }
    }
  }

  private assertCurrentDocumentConsents(document: BindingConsentDocument): void {
    const active = this.requireInstallRecord()
    for (const consent of Object.values(document.consents)) {
      if (!pairEquals(active, consent.installId, consent.nonce)) {
        return fail(
          "INSTALL_MISMATCH",
          "Binding/consent document contains consent from another installation",
        )
      }
    }
  }

  private async readLatestInternal(userId: string, presetId: string): Promise<ReadResult> {
    this.requireInstallRecord()
    const path = buildBindingDocumentKey(userId, presetId)
    await this.cleanupPathTemps(path)
    await this.quarantineRotatedDocument(path)
    const raw = await this.readExisting(path)
    if (raw === undefined) return { path, document: createEmptyBindingConsentDocument() }

    try {
      const document = decodeBindingConsentDocument(raw, presetId)
      this.assertCurrentDocumentConsents(document)
      return { path, document }
    } catch (error) {
      if (error instanceof AtomicJsonStoreError) throw error
      return fail("CORRUPT_DOCUMENT", `Persisted binding/consent document at ${path} is invalid`, error)
    }
  }

  private trackOperation<T>(operation: Promise<T>, generation: number): Promise<T> {
    this.activeOperations.set(operation, generation)
    void operation.then(
      () => {
        this.activeOperations.delete(operation)
      },
      () => {
        this.activeOperations.delete(operation)
      },
    )
    return operation
  }

  /** Read the latest canonical document; missing state is an empty revision 0 document. */
  async readDocument(userId: string, presetId: string): Promise<BindingConsentDocument> {
    const generation = this.lifecycleGeneration
    const ready = this.initializationBarrier
    const operation = ready
      .then(() => this.readLatestInternal(userId, presetId))
      .then(({ document }) => document)
    return this.trackOperation(operation, generation)
  }

  async readLatest(userId: string, presetId: string): Promise<BindingConsentDocument> {
    return this.readDocument(userId, presetId)
  }

  private async commitDocumentInternal(
    userId: string,
    presetId: string,
    expected: DocumentWriteExpectation | number,
    nextDocument: BindingConsentDocument,
    expectedInstallId?: string,
    expectedNonce?: string,
  ): Promise<BindingConsentDocument> {
    const active = this.requireInstallRecord()
    const expectation = expectationFrom(expected, active, expectedInstallId, expectedNonce)
    if (!pairEquals(active, expectation.extensionInstallationId, expectation.installNonce)) {
      return fail("INSTALL_MISMATCH", "Write expectation does not match the active installation")
    }

    const latest = await this.readLatestInternal(userId, presetId)
    if (latest.document.documentRevision !== expectation.documentRevision) {
      return fail(
        "REVISION_MISMATCH",
        `Expected document revision ${expectation.documentRevision}, found ${latest.document.documentRevision}`,
      )
    }

    let candidate: BindingConsentDocument
    try {
      candidate = decodeBindingConsentDocument(nextDocument, presetId)
    } catch (error) {
      return fail("CORRUPT_DOCUMENT", "Replacement binding/consent document is invalid", error)
    }
    if (candidate.documentRevision !== expectation.documentRevision) {
      return fail("REVISION_MISMATCH", "Replacement document revision must match the expected revision")
    }
    this.assertCurrentDocumentConsents(candidate)

    const persisted = Object.freeze({
      schemaVersion: 1 as const,
      documentRevision: expectation.documentRevision + 1,
      bindings: candidate.bindings,
      consents: candidate.consents,
    })
    const path = latest.path
    await this.ensureRotatedPathMarker(path)
    await this.persistJsonAtomically(path, serialize(persisted, path))
    // The revision is intentionally created only in the value moved to the canonical path.
    return decodeBindingConsentDocument(persisted, presetId)
  }

  private enqueue<T>(path: string, operation: QueuedOperation<T>): Promise<T> {
    const generation = this.lifecycleGeneration
    const ready = this.initializationBarrier
    const prior = this.queues.get(path) ?? Promise.resolve()
    const run = () => ready.then(operation)
    const next = prior.then(run, run)
    let tail!: Promise<void>
    tail = next.then(
      () => {
        if (this.queues.get(path) === tail) this.queues.delete(path)
      },
      () => {
        if (this.queues.get(path) === tail) this.queues.delete(path)
      },
    )
    this.queues.set(path, tail)
    return this.trackOperation(next, generation)
  }

  writeDocument(
    userId: string,
    presetId: string,
    expected: DocumentWriteExpectation | number,
    nextDocument: BindingConsentDocument,
    expectedInstallId?: string,
    expectedNonce?: string,
  ): Promise<BindingConsentDocument> {
    const path = buildBindingDocumentKey(userId, presetId)
    return this.enqueue(path, () =>
      this.commitDocumentInternal(
        userId,
        presetId,
        expected,
        nextDocument,
        expectedInstallId,
        expectedNonce,
      ),
    )
  }

  commitDocument(
    userId: string,
    presetId: string,
    expected: DocumentWriteExpectation | number,
    nextDocument: BindingConsentDocument,
    expectedInstallId?: string,
    expectedNonce?: string,
  ): Promise<BindingConsentDocument> {
    return this.writeDocument(
      userId,
      presetId,
      expected,
      nextDocument,
      expectedInstallId,
      expectedNonce,
    )
  }

  private async applyBindingIntentInternal(
    userId: string,
    presetId: string,
    intent: BindingIntent,
    expected?: DocumentWriteExpectation | number,
  ): Promise<BindingConsentDocument> {
    const latest = await this.readLatestInternal(userId, presetId)
    const active = this.requireInstallRecord()
    const expectation = expected === undefined
      ? Object.freeze({
          documentRevision: latest.document.documentRevision,
          extensionInstallationId: active.extensionInstallationId,
          installNonce: active.installNonce,
        })
      : expectationFrom(expected, active)
    if (latest.document.documentRevision !== expectation.documentRevision) {
      return fail("REVISION_MISMATCH", "Binding intent was derived from a stale document revision")
    }
    if (!pairEquals(active, expectation.extensionInstallationId, expectation.installNonce)) {
      return fail("INSTALL_MISMATCH", "Binding intent uses a stale installation pair")
    }
    let next: BindingConsentDocument
    try {
      next = reduceBindingIntent(latest.document, intent, presetId)
    } catch (error) {
      return fail("CORRUPT_DOCUMENT", "Binding intent is invalid", error)
    }
    return this.commitDocumentInternal(userId, presetId, expectation, next)
  }

  private async applyConsentIntentInternal(
    userId: string,
    presetId: string,
    intent: ConsentIntent,
    expected?: DocumentWriteExpectation | number,
  ): Promise<BindingConsentDocument> {
    const latest = await this.readLatestInternal(userId, presetId)
    const active = this.requireInstallRecord()
    const expectation = expected === undefined
      ? Object.freeze({
          documentRevision: latest.document.documentRevision,
          extensionInstallationId: active.extensionInstallationId,
          installNonce: active.installNonce,
        })
      : expectationFrom(expected, active)
    if (latest.document.documentRevision !== expectation.documentRevision) {
      return fail("REVISION_MISMATCH", "Consent intent was derived from a stale document revision")
    }
    if (!pairEquals(active, expectation.extensionInstallationId, expectation.installNonce)) {
      return fail("INSTALL_MISMATCH", "Consent intent uses a stale installation pair")
    }
    let next: BindingConsentDocument
    try {
      next = reduceConsentIntent(latest.document, intent, presetId)
    } catch (error) {
      return fail("CORRUPT_DOCUMENT", "Consent intent is invalid", error)
    }
    return this.commitDocumentInternal(userId, presetId, expectation, next)
  }

  applyBindingIntent(
    userId: string,
    presetId: string,
    intent: BindingIntent,
    expected?: DocumentWriteExpectation | number,
  ): Promise<BindingConsentDocument> {
    const path = buildBindingDocumentKey(userId, presetId)
    return this.enqueue(path, () => this.applyBindingIntentInternal(userId, presetId, intent, expected))
  }

  applyConsentIntent(
    userId: string,
    presetId: string,
    intent: ConsentIntent,
    expected?: DocumentWriteExpectation | number,
  ): Promise<BindingConsentDocument> {
    const path = buildBindingDocumentKey(userId, presetId)
    return this.enqueue(path, () => this.applyConsentIntentInternal(userId, presetId, intent, expected))
  }

  applyIntent(
    userId: string,
    presetId: string,
    intent: BindingIntent | ConsentIntent,
    expected?: DocumentWriteExpectation | number,
  ): Promise<BindingConsentDocument> {
    const path = buildBindingDocumentKey(userId, presetId)
    return this.enqueue(path, async () => {
      const bindingLike =
        intent.type === "bind" ||
        intent.type === "unbind" ||
        "binding" in intent ||
        "slotId" in intent
      if (bindingLike) {
        return this.applyBindingIntentInternal(
          userId,
          presetId,
          intent as BindingIntent,
          expected,
        )
      }
      return this.applyConsentIntentInternal(
        userId,
        presetId,
        intent as ConsentIntent,
        expected,
      )
    })
  }
}
