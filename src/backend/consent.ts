import type { ConnectionDispatchDescriptorDTO } from "lumiverse-spindle-types"
import {
  AtomicJsonStore,
  AtomicJsonStoreError,
} from "../state/atomic-json-store"
import { MAX_CONNECTION_SLOTS, MAX_THREADS } from "../config/limits"
import {
  buildBindingKey,
  buildConsentKey,
  reduceConsentIntent,
  type BindingConsentDocument,
  type ConsentRecord,
  type InstallPair,
} from "../state/documents"
import {
  cloneDispatchDescriptor,
  type HostDispatchDescriptor,
} from "./connection-bindings"

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const REVISION_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u
const SOURCE_KEY_PATTERN = /^slot:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u

const CONSENT_CACHE_TTL_MS = 5 * 60 * 1_000
const DEFAULT_CONSENT_CACHE_CAP = MAX_THREADS * (MAX_CONNECTION_SLOTS + 1) * 2
const DEFAULT_CONSENT_SCOPE_CAP = (MAX_CONNECTION_SLOTS + 1) * 2
const DOCUMENT_MUTATION_QUEUES = new WeakMap<AtomicJsonStore, Map<string, Promise<void>>>()

type BoundedCacheEntry<T> = Readonly<{
  key: string
  scope: string
  value: T
  createdAt: number
  sequence: number
}>

type BoundedCacheOptions = Readonly<{
  now: () => number
  ttlMs: number
  maxEntries: number
  maxEntriesPerScope: number
}>

class BoundedScopedCache<T> {
  private readonly entriesByKey = new Map<string, BoundedCacheEntry<T>>()
  private sequence = 0

  constructor(private readonly options: BoundedCacheOptions) {}

  private timestamp(): number {
    const value = this.options.now()
    if (!Number.isFinite(value)) throw new TypeError("Consent cache clock must return a finite number")
    return value
  }

  private nextSequence(): number {
    if (this.sequence >= Number.MAX_SAFE_INTEGER) {
      const ordered = [...this.entriesByKey.values()].sort((left, right) => left.sequence - right.sequence)
      this.sequence = 0
      for (const entry of ordered) {
        this.sequence += 1
        this.entriesByKey.set(entry.key, { ...entry, sequence: this.sequence })
      }
    }
    this.sequence += 1
    return this.sequence
  }

  private removeScope(scope: string): void {
    for (const [key, entry] of this.entriesByKey) {
      if (entry.scope === scope) this.entriesByKey.delete(key)
    }
  }

  private removeExpired(now: number): void {
    const expiredScopes = new Set<string>()
    for (const entry of this.entriesByKey.values()) {
      if (Math.max(0, now - entry.createdAt) >= this.options.ttlMs) {
        expiredScopes.add(entry.scope)
      }
    }
    for (const scope of expiredScopes) this.removeScope(scope)
  }

  private oldestScope(): string | undefined {
    let oldest: BoundedCacheEntry<T> | undefined
    for (const entry of this.entriesByKey.values()) {
      if (oldest === undefined || entry.sequence < oldest.sequence) oldest = entry
    }
    return oldest?.scope
  }

  private enforceBounds(): void {
    const scopeCounts = new Map<string, number>()
    for (const entry of this.entriesByKey.values()) {
      scopeCounts.set(entry.scope, (scopeCounts.get(entry.scope) ?? 0) + 1)
    }
    for (const [scope, count] of scopeCounts) {
      if (count > this.options.maxEntriesPerScope) this.removeScope(scope)
    }
    while (this.entriesByKey.size > this.options.maxEntries) {
      const oldest = this.oldestScope()
      if (oldest === undefined) break
      this.removeScope(oldest)
    }
  }

  set(key: string, scope: string, value: T): void {
    const now = this.timestamp()
    this.removeExpired(now)
    this.entriesByKey.set(key, {
      key,
      scope,
      value,
      createdAt: now,
      sequence: this.nextSequence(),
    })
    this.enforceBounds()
  }

  get(key: string): T | undefined {
    const now = this.timestamp()
    this.removeExpired(now)
    const entry = this.entriesByKey.get(key)
    if (entry === undefined) return undefined
    this.entriesByKey.set(key, { ...entry, sequence: this.nextSequence() })
    return entry.value
  }

  has(key: string): boolean {
    return this.get(key) !== undefined
  }

  touch(key: string): boolean {
    const now = this.timestamp()
    this.removeExpired(now)
    const entry = this.entriesByKey.get(key)
    if (entry === undefined) return false
    this.entriesByKey.set(key, { ...entry, sequence: this.nextSequence() })
    return true
  }

  delete(key: string): boolean {
    const now = this.timestamp()
    this.removeExpired(now)
    return this.entriesByKey.delete(key)
  }

  deleteIf(key: string, predicate: (value: T) => boolean): boolean {
    const now = this.timestamp()
    this.removeExpired(now)
    const entry = this.entriesByKey.get(key)
    if (entry === undefined || !predicate(entry.value)) return false
    return this.entriesByKey.delete(key)
  }

  entries(): readonly BoundedCacheEntry<T>[] {
    const now = this.timestamp()
    this.removeExpired(now)
    return [...this.entriesByKey.values()]
  }

  clear(): void {
    this.entriesByKey.clear()
  }

  get size(): number {
    const now = this.timestamp()
    this.removeExpired(now)
    return this.entriesByKey.size
  }
}

function cacheCapacity(value: number | undefined, fallback: number, label: string): number {
  const capacity = value ?? fallback
  if (!Number.isSafeInteger(capacity) || capacity < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`)
  }
  return capacity
}

function cacheClock(value: (() => number) | undefined): () => number {
  return value ?? (() => Date.now())
}

function consentScope(userId: string, presetId: string, threadId: string): string {
  return JSON.stringify([userId, presetId, threadId])
}

function documentScope(userId: string, presetId: string): string {
  return JSON.stringify([userId, presetId])
}

export type ConsentWorkspaceSource = "native-blocks" | "main-context"
export type ConsentSourceKey = "main" | `slot:${string}`

/** A host-authenticated disclosure from which consent may be granted. */
export type ConsentDisclosure = Readonly<{
  userId: string
  presetId: string
  threadId: string
  workspaceSource: ConsentWorkspaceSource
  connectionSourceKey: ConsentSourceKey
  connectionId: string | null
  descriptor: HostDispatchDescriptor | ConnectionDispatchDescriptorDTO
  disclosureVersion?: number
}>

export type ConsentSelector = Readonly<{
  presetId: string
  threadId: string
  workspaceSource?: ConsentWorkspaceSource
  connectionSourceKey?: ConsentSourceKey
  connectionId?: string | null
  dispatchRevision?: string
  disclosureVersion?: number
}>

export type ConsentGrantInput = Readonly<{
  userId: string
  presetId?: string
  disclosure?: ConsentDisclosure
  /** Internal host-only path for restoring an already authenticated record. */
  consent?: ConsentRecord
  descriptor?: HostDispatchDescriptor | ConnectionDispatchDescriptorDTO
  expectedDocumentRevision?: number
}>

export type ConsentRevokeInput = Readonly<{
  userId: string
  selector: ConsentSelector
  expectedDocumentRevision?: number
}>

export type ConsentAuthorizationInput = Readonly<{
  userId: string
  presetId: string
  threadId: string
  workspaceSource: ConsentWorkspaceSource
  connectionSourceKey: ConsentSourceKey
  connectionId: string | null
  descriptor?: HostDispatchDescriptor | ConnectionDispatchDescriptorDTO
  dispatchRevision?: string
  disclosureVersion?: number
}>

export type AuthorizedConsent = Readonly<{
  userId: string
  key: string
  consent: ConsentRecord
  descriptor?: HostDispatchDescriptor
}>

export type ConsentSnapshot = Readonly<{
  userId: string
  presetId: string
  installId: string
  installNonce: string
  documentRevision: number
  consents: readonly ConsentRecord[]
}>

/** Authenticated backend input after frontend selector decoding. */
export type ConsentRpcRequest = Readonly<
  | {
      type: "approve_consent"
      presetId: string
      threadId: string
      workspaceSource?: ConsentWorkspaceSource
      connectionSourceKey?: ConsentSourceKey
      expectedDocumentRevision?: number
    }
  | {
      type: "revoke_consent"
      presetId: string
      threadId: string
      workspaceSource?: ConsentWorkspaceSource
      connectionSourceKey?: ConsentSourceKey
      connectionId?: string | null
      dispatchRevision?: string
      disclosureVersion?: number
      expectedDocumentRevision?: number
    }
>

export type ConsentRpcResponse = ConsentSnapshot

export type ConsentStatus = "approved" | "revoked" | "required"

export type ConsentErrorCode =
  | "INVALID_IDENTITY"
  | "INVALID_SELECTOR"
  | "MISSING_DISCLOSURE"
  | "MISSING_CONSENT"
  | "DUPLICATE_CONSENT"
  | "REVOKED_CONSENT"
  | "STALE_CONSENT"
  | "STALE_DOCUMENT"
  | "INSTALL_MISMATCH"
  | "WRONG_USER"
  | "DESCRIPTOR_INVALID"
  | "REVISION_REQUIRED"
  | "STORAGE_FAILURE"

export class ConsentError extends Error {
  readonly code: ConsentErrorCode
  readonly causeValue: unknown

  constructor(code: ConsentErrorCode, message: string, causeValue?: unknown) {
    super(message)
    this.name = "ConsentError"
    this.code = code
    this.causeValue = causeValue
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export type ConsentServiceDependencies = Readonly<{
  store: AtomicJsonStore
  disclosureVersion?: number
  /** Injectable clock and cache caps keep bounded-state tests deterministic. */
  now?: () => number
  pendingDisclosureCap?: number
  revokedSelectorCap?: number
}>

function fail(code: ConsentErrorCode, message: string, causeValue?: unknown): never {
  throw new ConsentError(code, message, causeValue)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
    return fail("INVALID_IDENTITY", `${label} must be a bounded non-empty string`)
  }
  return value
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    return fail("INVALID_IDENTITY", `${label} must be a canonical lowercase UUID`)
  }
  return value
}

function revision(value: unknown): string {
  if (typeof value !== "string" || !REVISION_PATTERN.test(value)) {
    return fail("REVISION_REQUIRED", "dispatchRevision must be a bounded opaque revision")
  }
  return value
}

function disclosureVersion(value: unknown, fallback: number): number {
  const candidate = value === undefined ? fallback : value
  if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate <= 0) {
    return fail("INVALID_SELECTOR", "disclosureVersion must be a positive safe integer")
  }
  return candidate
}

function assertInstallPair(pair: InstallPair): InstallPair {
  if (!isRecord(pair)) return fail("INSTALL_MISMATCH", "Install pair must be a plain object")
  if (typeof pair.extensionInstallationId !== "string" || !UUID_PATTERN.test(pair.extensionInstallationId)) {
    return fail("INSTALL_MISMATCH", "extensionInstallationId is invalid")
  }
  if (typeof pair.installNonce !== "string" || !/^[0-9a-f]{32}$/u.test(pair.installNonce)) {
    return fail("INSTALL_MISMATCH", "installNonce is invalid")
  }
  return Object.freeze({
    extensionInstallationId: pair.extensionInstallationId,
    installNonce: pair.installNonce,
  })
}

function sourceKey(value: unknown): ConsentSourceKey {
  if (value === "main") return value
  if (typeof value !== "string" || !SOURCE_KEY_PATTERN.test(value)) {
    return fail("INVALID_SELECTOR", "connectionSourceKey must be main or slot:<canonical UUID>")
  }
  return value as `slot:${string}`
}

function workspace(value: unknown): ConsentWorkspaceSource {
  if (value === "native-blocks" || value === "main-context") return value
  return fail("INVALID_SELECTOR", "workspaceSource is invalid")
}

function connectionId(value: unknown, key: ConsentSourceKey): string | null {
  if (key === "main") {
    if (value !== null) return fail("INVALID_SELECTOR", "Main consent cannot retain a connection ID")
    return null
  }
  return uuid(value, "connectionId")
}

function cloneRecord(value: ConsentRecord): ConsentRecord {
  if (!isRecord(value)) return fail("INVALID_SELECTOR", "Consent record must be a plain object")
  const connectionSourceKey = sourceKey(value.connectionSourceKey)
  const normalized = Object.freeze({
    installId: uuid(value.installId, "consent.installId"),
    nonce:
      typeof value.nonce === "string" && /^[0-9a-f]{32}$/u.test(value.nonce)
        ? value.nonce
        : fail("INSTALL_MISMATCH", "consent.nonce is invalid"),
    presetId: uuid(value.presetId, "consent.presetId"),
    threadId: text(value.threadId, "consent.threadId"),
    workspaceSource: workspace(value.workspaceSource),
    connectionSourceKey,
    connectionId: connectionId(value.connectionId, connectionSourceKey),
    dispatchRevision: revision(value.dispatchRevision),
    disclosureVersion: disclosureVersion(value.disclosureVersion, 1),
  })
  return normalized
}

function cloneDescriptor(value: HostDispatchDescriptor | ConnectionDispatchDescriptorDTO): HostDispatchDescriptor {
  try {
    return cloneDispatchDescriptor(value as ConnectionDispatchDescriptorDTO)
  } catch (error) {
    if (error instanceof ConsentError) throw error
    return fail("DESCRIPTOR_INVALID", "Dispatch descriptor is not a safe concrete host descriptor", error)
  }
}

function descriptorRevision(
  descriptor: HostDispatchDescriptor | ConnectionDispatchDescriptorDTO | undefined,
  suppliedRevision: string | undefined,
): string {
  if (descriptor !== undefined) return cloneDescriptor(descriptor).connectionDispatchRevision
  if (suppliedRevision !== undefined) return revision(suppliedRevision)
  return fail("REVISION_REQUIRED", "Consent requires an exact host dispatch revision")
}


function mapStoreError(error: unknown): never {
  if (error instanceof ConsentError) throw error
  if (error instanceof AtomicJsonStoreError) {
    if (error.code === "REVISION_MISMATCH") return fail("STALE_DOCUMENT", error.message, error)
    if (error.code === "INSTALL_MISMATCH") return fail("INSTALL_MISMATCH", error.message, error)
    if (error.code === "STORAGE_FAILURE") return fail("STORAGE_FAILURE", error.message, error)
  }
  throw error
}

function pendingKey(disclosure: Pick<ConsentDisclosure, "userId" | "presetId" | "threadId" | "workspaceSource" | "connectionSourceKey">): string {
  return JSON.stringify([
    disclosure.userId,
    disclosure.presetId,
    disclosure.threadId,
    disclosure.workspaceSource,
    disclosure.connectionSourceKey,
  ])
}

function selectorMatches(record: ConsentRecord, selector: ConsentSelector): boolean {
  if (record.presetId !== uuid(selector.presetId, "selector.presetId")) return false
  if (record.threadId !== text(selector.threadId, "selector.threadId")) return false
  if (selector.workspaceSource !== undefined && record.workspaceSource !== workspace(selector.workspaceSource)) return false
  if (selector.connectionSourceKey !== undefined && record.connectionSourceKey !== sourceKey(selector.connectionSourceKey)) return false
  if (selector.connectionId !== undefined && record.connectionId !== selector.connectionId) return false
  if (selector.dispatchRevision !== undefined && record.dispatchRevision !== revision(selector.dispatchRevision)) return false
  if (selector.disclosureVersion !== undefined && record.disclosureVersion !== disclosureVersion(selector.disclosureVersion, 1)) return false
  return true
}

function disclosureMatchesSelector(
  disclosure: NormalizedConsentDisclosure,
  selector: ConsentSelector,
): boolean {
  if (disclosure.presetId !== selector.presetId || disclosure.threadId !== selector.threadId) return false
  if (selector.workspaceSource !== undefined && disclosure.workspaceSource !== selector.workspaceSource) return false
  if (selector.connectionSourceKey !== undefined && disclosure.connectionSourceKey !== selector.connectionSourceKey) return false
  if (selector.connectionId !== undefined && disclosure.connectionId !== selector.connectionId) return false
  if (selector.dispatchRevision !== undefined && disclosure.descriptor.connectionDispatchRevision !== selector.dispatchRevision) return false
  if (selector.disclosureVersion !== undefined && disclosure.disclosureVersion !== selector.disclosureVersion) return false
  return true
}
function slotBindingMatches(
  document: Pick<BindingConsentDocument, "bindings">,
  consent: ConsentRecord,
): boolean {
  if (consent.connectionSourceKey === "main") return true
  const slotId = consent.connectionSourceKey.slice("slot:".length)
  const binding = document.bindings[buildBindingKey(consent.presetId, slotId)]
  return binding !== undefined &&
    binding.presetId === consent.presetId &&
    binding.slotId === slotId &&
    binding.connectionSourceKey === consent.connectionSourceKey &&
    binding.connectionId === consent.connectionId &&
    binding.dispatchRevision === consent.dispatchRevision
}


function supersededBy(
  record: ConsentRecord,
  current: ConsentRecord,
): boolean {
  return record.presetId === current.presetId &&
    record.threadId === current.threadId &&
    record.workspaceSource === current.workspaceSource &&
    record.connectionSourceKey === current.connectionSourceKey &&
    (
      record.connectionId !== current.connectionId ||
      record.dispatchRevision !== current.dispatchRevision ||
      record.disclosureVersion !== current.disclosureVersion
    )
}
function selectorFingerprint(userId: string, selector: ConsentSelector): string {
  const source = selector.connectionSourceKey === undefined ? "*" : sourceKey(selector.connectionSourceKey)
  const workspaceSource = selector.workspaceSource === undefined ? "*" : workspace(selector.workspaceSource)
  const connection = selector.connectionId === undefined ? "*" : selector.connectionId === null ? "none" : uuid(selector.connectionId, "selector.connectionId")
  const dispatch = selector.dispatchRevision === undefined ? "*" : revision(selector.dispatchRevision)
  const version = selector.disclosureVersion === undefined ? "*" : String(disclosureVersion(selector.disclosureVersion, 1))
  return JSON.stringify([
    userId,
    uuid(selector.presetId, "selector.presetId"),
    text(selector.threadId, "selector.threadId"),
    workspaceSource,
    source,
    connection,
    dispatch,
    version,
  ])
}

function snapshotFromDocument(
  userId: string,
  presetId: string,
  pair: InstallPair,
  document: { documentRevision: number; consents: Readonly<Record<string, ConsentRecord>> },
): ConsentSnapshot {
  const consents = Object.values(document.consents)
    .map(cloneRecord)
    .sort((left, right) => buildConsentKey(left).localeCompare(buildConsentKey(right)))
  return Object.freeze({
    userId,
    presetId,
    installId: pair.extensionInstallationId,
    installNonce: pair.installNonce,
    documentRevision: document.documentRevision,
    consents: Object.freeze(consents),
  })
}

type NormalizedConsentDisclosure = ConsentDisclosure & Readonly<{
  disclosureVersion: number
}>

type ConsentEphemeralState = Readonly<{
  pendingDisclosures: BoundedScopedCache<NormalizedConsentDisclosure>
  revokedSelectors: BoundedScopedCache<true>
}>

const CONSENT_EPHEMERAL_STATES = new WeakMap<AtomicJsonStore, ConsentEphemeralState>()

export class ConsentService {
  private readonly store: AtomicJsonStore
  private readonly disclosureVersion: number
  private readonly pendingDisclosures: BoundedScopedCache<NormalizedConsentDisclosure>
  private readonly revokedSelectors: BoundedScopedCache<true>
  private readonly documentMutationQueues: Map<string, Promise<void>>

  constructor(dependencies: ConsentServiceDependencies) {
    this.store = dependencies.store
    this.disclosureVersion = disclosureVersion(dependencies.disclosureVersion, 1)
    const queues = DOCUMENT_MUTATION_QUEUES.get(this.store)
    if (queues === undefined) {
      this.documentMutationQueues = new Map<string, Promise<void>>()
      DOCUMENT_MUTATION_QUEUES.set(this.store, this.documentMutationQueues)
    } else {
      this.documentMutationQueues = queues
    }
    const existingState = CONSENT_EPHEMERAL_STATES.get(this.store)
    if (existingState !== undefined) {
      this.pendingDisclosures = existingState.pendingDisclosures
      this.revokedSelectors = existingState.revokedSelectors
      return
    }
    const now = cacheClock(dependencies.now)
    const pendingCap = cacheCapacity(
      dependencies.pendingDisclosureCap,
      DEFAULT_CONSENT_CACHE_CAP,
      "pendingDisclosureCap",
    )
    const revokedCap = cacheCapacity(
      dependencies.revokedSelectorCap,
      DEFAULT_CONSENT_CACHE_CAP,
      "revokedSelectorCap",
    )
    const state: ConsentEphemeralState = {
      pendingDisclosures: new BoundedScopedCache<NormalizedConsentDisclosure>({
        now,
        ttlMs: CONSENT_CACHE_TTL_MS,
        maxEntries: pendingCap,
        maxEntriesPerScope: Math.min(pendingCap, DEFAULT_CONSENT_SCOPE_CAP),
      }),
      revokedSelectors: new BoundedScopedCache<true>({
        now,
        ttlMs: CONSENT_CACHE_TTL_MS,
        maxEntries: revokedCap,
        maxEntriesPerScope: Math.min(revokedCap, DEFAULT_CONSENT_SCOPE_CAP),
      }),
    }
    CONSENT_EPHEMERAL_STATES.set(this.store, state)
    this.pendingDisclosures = state.pendingDisclosures
    this.revokedSelectors = state.revokedSelectors
  }

  private enqueueDocumentMutation<T>(
    userId: string,
    presetId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = documentScope(userId, presetId)
    const prior = this.documentMutationQueues.get(key) ?? Promise.resolve()
    const next = prior.then(operation, operation)
    const settledTail = next.then(
      () => undefined,
      () => undefined,
    )
    this.documentMutationQueues.set(key, settledTail)
    void settledTail.then(() => {
      if (this.documentMutationQueues.get(key) === settledTail) this.documentMutationQueues.delete(key)
    })
    return next
  }

  private normalizeDisclosure(input: ConsentDisclosure): NormalizedConsentDisclosure {
    const userId = text(input.userId, "disclosure.userId")
    const presetId = uuid(input.presetId, "disclosure.presetId")
    const threadId = text(input.threadId, "disclosure.threadId")
    const workspaceSource = workspace(input.workspaceSource)
    const connectionSourceKey = sourceKey(input.connectionSourceKey)
    const normalizedConnectionId = connectionId(input.connectionId, connectionSourceKey)
    const descriptor = cloneDescriptor(input.descriptor)
    if (connectionSourceKey !== "main" && descriptor.connectionId !== normalizedConnectionId) {
      return fail("WRONG_USER", "Disclosure descriptor does not match the connection source")
    }
    const normalizedDisclosureVersion = disclosureVersion(input.disclosureVersion, this.disclosureVersion)
    return Object.freeze({
      userId,
      presetId,
      threadId,
      workspaceSource,
      connectionSourceKey,
      connectionId: normalizedConnectionId,
      descriptor,
      disclosureVersion: normalizedDisclosureVersion,
    })
  }

  rememberDisclosure(input: ConsentDisclosure): NormalizedConsentDisclosure {
    const normalized = this.normalizeDisclosure(input)
    this.pendingDisclosures.set(
      pendingKey(normalized),
      consentScope(normalized.userId, normalized.presetId, normalized.threadId),
      normalized,
    )
    return normalized
  }


  recordDisclosure(input: ConsentDisclosure): NormalizedConsentDisclosure {
    return this.rememberDisclosure(input)
  }
  /**
   * Returns the current host-authenticated disclosure for a selector without
   * exposing the private installation, user, or dispatch fields to callers.
   */
  resolveDisclosure(userIdInput: string, selector: ConsentSelector): ConsentDisclosure | undefined {
    const userId = text(userIdInput, "userId")
    const presetId = uuid(selector.presetId, "selector.presetId")
    const threadId = text(selector.threadId, "selector.threadId")
    const workspaceSource = selector.workspaceSource === undefined ? undefined : workspace(selector.workspaceSource)
    const connectionSourceKey = selector.connectionSourceKey === undefined ? undefined : sourceKey(selector.connectionSourceKey)
    const candidates = this.pendingDisclosures.entries()
      .map((entry) => entry.value)
      .filter((disclosure) => disclosure.userId === userId && disclosure.presetId === presetId && disclosure.threadId === threadId)
      .filter((disclosure) => workspaceSource === undefined || disclosure.workspaceSource === workspaceSource)
      .filter((disclosure) => connectionSourceKey === undefined || disclosure.connectionSourceKey === connectionSourceKey)
      .sort((left, right) => pendingKey(left).localeCompare(pendingKey(right)))
    if (candidates.length !== 1) return undefined
    const candidate = candidates[0]
    if (candidate === undefined) return undefined
    this.pendingDisclosures.touch(pendingKey(candidate))
    return Object.freeze({
      userId: candidate.userId,
      presetId: candidate.presetId,
      threadId: candidate.threadId,
      workspaceSource: candidate.workspaceSource,
      connectionSourceKey: candidate.connectionSourceKey,
      connectionId: candidate.connectionId,
      descriptor: candidate.descriptor,
      disclosureVersion: candidate.disclosureVersion,
    })
  }

  private disclosureToRecord(
    userIdInput: string,
    input: ConsentGrantInput,
  ): {
    userId: string
    record: ConsentRecord
    descriptor?: HostDispatchDescriptor
    pendingDisclosure?: NormalizedConsentDisclosure
  } {
    const userId = text(userIdInput, "userId")
    if (input.disclosure !== undefined) {
      const disclosure = this.normalizeDisclosure(input.disclosure)
      if (disclosure.userId !== userId) return fail("WRONG_USER", "Disclosure belongs to another user")
      const currentDisclosure = this.pendingDisclosures.get(pendingKey(disclosure))
      if (currentDisclosure === undefined) return fail("MISSING_DISCLOSURE", "Grant requires a current host disclosure")
      const currentDescriptor = currentDisclosure.descriptor
      const candidateDescriptor = disclosure.descriptor
      if (
        currentDisclosure.disclosureVersion !== disclosure.disclosureVersion ||
        currentDescriptor.connectionId !== candidateDescriptor.connectionId ||
        currentDescriptor.connectionName !== candidateDescriptor.connectionName ||
        currentDescriptor.provider !== candidateDescriptor.provider ||
        currentDescriptor.model !== candidateDescriptor.model ||
        currentDescriptor.endpointOrigin !== candidateDescriptor.endpointOrigin ||
        currentDescriptor.dispatchKind !== candidateDescriptor.dispatchKind ||
        currentDescriptor.connectionDispatchRevision !== candidateDescriptor.connectionDispatchRevision
      ) {
        return fail("STALE_CONSENT", "Consent disclosure is no longer current")
      }
      const pair = assertInstallPair(this.store.getInstallPair())
      const descriptor = cloneDescriptor(currentDescriptor)
      const dispatchRevision = descriptorRevision(descriptor, undefined)
      return {
        userId,
        descriptor,
        pendingDisclosure: currentDisclosure,
        record: cloneRecord({
          installId: pair.extensionInstallationId,
          nonce: pair.installNonce,
          presetId: currentDisclosure.presetId,
          threadId: currentDisclosure.threadId,
          workspaceSource: currentDisclosure.workspaceSource,
          connectionSourceKey: currentDisclosure.connectionSourceKey,
          connectionId: currentDisclosure.connectionId,
          dispatchRevision,
          disclosureVersion: currentDisclosure.disclosureVersion,
        }),
      }
    }
    if (input.consent === undefined) return fail("MISSING_DISCLOSURE", "Grant requires a host disclosure")
    const record = cloneRecord(input.consent)
    const pair = assertInstallPair(this.store.getInstallPair())
    if (record.installId !== pair.extensionInstallationId || record.nonce !== pair.installNonce) {
      return fail("INSTALL_MISMATCH", "Consent record belongs to another installation")
    }
    if (record.presetId !== input.presetId && input.presetId !== undefined) {
      return fail("WRONG_USER", "Consent preset identity mismatch")
    }
    const descriptor = input.descriptor === undefined ? undefined : cloneDescriptor(input.descriptor)
    if (descriptor !== undefined && descriptor.connectionDispatchRevision !== record.dispatchRevision) {
      return fail("STALE_CONSENT", "Consent descriptor revision does not match the record")
    }
    return { userId, record, descriptor }
  }
  private invalidatePendingDisclosure(
    userId: string,
    record: ConsentRecord,
    pendingDisclosure: NormalizedConsentDisclosure | undefined,
  ): void {
    if (pendingDisclosure === undefined) return
    const key = pendingKey({
      userId,
      presetId: record.presetId,
      threadId: record.threadId,
      workspaceSource: record.workspaceSource,
      connectionSourceKey: record.connectionSourceKey,
    })
    this.pendingDisclosures.deleteIf(key, (candidate) => candidate === pendingDisclosure)
  }


  async grant(input: ConsentGrantInput): Promise<ConsentSnapshot> {
    const userId = text(input.userId, "userId")
    const normalizedDisclosure = input.disclosure === undefined
      ? undefined
      : this.normalizeDisclosure(input.disclosure)
    const normalizedConsent =
      normalizedDisclosure === undefined && input.consent !== undefined
        ? cloneRecord(input.consent)
        : undefined
    const presetId = normalizedDisclosure?.presetId ?? normalizedConsent?.presetId
    if (presetId === undefined) return fail("MISSING_DISCLOSURE", "Grant requires a host disclosure")
    const queuedInput: ConsentGrantInput = normalizedDisclosure === undefined
      ? normalizedConsent === undefined
        ? input
        : { ...input, consent: normalizedConsent }
      : { ...input, disclosure: normalizedDisclosure }

    return this.enqueueDocumentMutation(userId, presetId, async () => {
      const { record, pendingDisclosure } = this.disclosureToRecord(userId, queuedInput)
      const initial = await this.store.readLatest(userId, record.presetId).catch(mapStoreError)
      if (!slotBindingMatches(initial, record)) {
        this.invalidatePendingDisclosure(userId, record, pendingDisclosure)
        return fail("STALE_CONSENT", "Consent disclosure does not match the current slot binding")
      }
      if (input.expectedDocumentRevision !== undefined) {
        if (!Number.isSafeInteger(input.expectedDocumentRevision) || input.expectedDocumentRevision < 0) {
          return fail("STALE_DOCUMENT", "expectedDocumentRevision is invalid")
        }
        if (input.expectedDocumentRevision !== initial.documentRevision) {
          return fail("STALE_DOCUMENT", "Consent was derived from a stale document revision")
        }
      }
      const expectedRevision = input.expectedDocumentRevision ?? initial.documentRevision
      const key = buildConsentKey(record)
      if (initial.consents[key] !== undefined) return fail("DUPLICATE_CONSENT", "Consent is already granted")
      const pair = assertInstallPair(this.store.getInstallPair())
      let replacement = reduceConsentIntent(initial, { type: "grant", consent: record })
      const superseded = Object.values(replacement.consents)
        .filter((candidate) => supersededBy(candidate, record))
      for (const candidate of superseded) {
        replacement = reduceConsentIntent(replacement, { type: "revoke", consent: candidate })
      }
      let current: BindingConsentDocument
      try {
        current = await this.store.writeDocument(
          userId,
          record.presetId,
          expectedRevision,
          replacement,
        )
      } catch (error) {
        if (pendingDisclosure !== undefined && error instanceof AtomicJsonStoreError && error.code === "REVISION_MISMATCH") {
          try {
            const latestAfterFailure = await this.store.readLatest(userId, record.presetId)
            if (!slotBindingMatches(latestAfterFailure, record)) {
              this.invalidatePendingDisclosure(userId, record, pendingDisclosure)
            }
          } catch {
            // Preserve the original write failure if the diagnostic read also fails.
          }
        }
        return mapStoreError(error)
      }
      const pendingKeyValue = pendingKey({
        userId,
        presetId: record.presetId,
        threadId: record.threadId,
        workspaceSource: record.workspaceSource,
        connectionSourceKey: record.connectionSourceKey,
      })
      if (pendingDisclosure === undefined) {
        this.pendingDisclosures.delete(pendingKeyValue)
      } else {
        this.pendingDisclosures.deleteIf(pendingKeyValue, (candidate) => candidate === pendingDisclosure)
      }
      this.revokedSelectors.delete(selectorFingerprint(userId, {
        presetId: record.presetId,
        threadId: record.threadId,
        workspaceSource: record.workspaceSource,
        connectionSourceKey: record.connectionSourceKey,
        connectionId: record.connectionId,
        dispatchRevision: record.dispatchRevision,
        disclosureVersion: record.disclosureVersion,
      }))
      this.revokedSelectors.delete(selectorFingerprint(userId, {
        presetId: record.presetId,
        threadId: record.threadId,
        workspaceSource: record.workspaceSource,
        connectionSourceKey: record.connectionSourceKey,
        connectionId: record.connectionId,
      }))
      return snapshotFromDocument(userId, record.presetId, pair, current)
    })
  }

  async grantConsent(input: ConsentGrantInput): Promise<ConsentSnapshot> {
    return this.grant(input)
  }

  async approveBySelector(
    userIdInput: string,
    selector: ConsentSelector,
    expectedDocumentRevision?: number,
  ): Promise<ConsentSnapshot> {
    const userId = text(userIdInput, "userId")
    const presetId = uuid(selector.presetId, "selector.presetId")
    const threadId = text(selector.threadId, "selector.threadId")
    const workspaceSource = selector.workspaceSource === undefined ? undefined : workspace(selector.workspaceSource)
    const connectionSourceKey = selector.connectionSourceKey === undefined ? undefined : sourceKey(selector.connectionSourceKey)
    let connectionId: string | null | undefined
    if (selector.connectionId === undefined) connectionId = undefined
    else if (selector.connectionId === null) connectionId = null
    else connectionId = uuid(selector.connectionId, "selector.connectionId")
    if (connectionSourceKey === "main" && connectionId !== undefined && connectionId !== null) {
      return fail("INVALID_SELECTOR", "Main consent cannot retain a connection ID")
    }
    const normalizedSelector: ConsentSelector = {
      presetId,
      threadId,
      ...(workspaceSource === undefined ? {} : { workspaceSource }),
      ...(connectionSourceKey === undefined ? {} : { connectionSourceKey }),
      ...(connectionId === undefined ? {} : { connectionId }),
      ...(selector.dispatchRevision === undefined ? {} : { dispatchRevision: revision(selector.dispatchRevision) }),
      ...(selector.disclosureVersion === undefined
        ? {}
        : { disclosureVersion: disclosureVersion(selector.disclosureVersion, this.disclosureVersion) }),
    }
    const candidates = this.pendingDisclosures.entries()
      .map((entry) => entry.value)
      .filter((candidate) => candidate.userId === userId && disclosureMatchesSelector(candidate, normalizedSelector))
      .sort((left, right) => pendingKey(left).localeCompare(pendingKey(right)))
    if (candidates.length !== 1) return fail("MISSING_DISCLOSURE", "Consent disclosure is missing or ambiguous")
    this.pendingDisclosures.touch(pendingKey(candidates[0]))
    return this.grant({ userId, disclosure: candidates[0], expectedDocumentRevision })
  }

  async revoke(input: ConsentRevokeInput): Promise<ConsentSnapshot> {
    const userId = text(input.userId, "userId")
    const selector = input.selector
    const presetId = uuid(selector.presetId, "selector.presetId")
    const threadId = text(selector.threadId, "selector.threadId")
    const workspaceSource = selector.workspaceSource === undefined ? undefined : workspace(selector.workspaceSource)
    const connectionSourceKey = selector.connectionSourceKey === undefined ? undefined : sourceKey(selector.connectionSourceKey)
    let normalizedConnectionId: string | null | undefined
    if (selector.connectionId === undefined) normalizedConnectionId = undefined
    else if (selector.connectionId === null) normalizedConnectionId = null
    else normalizedConnectionId = uuid(selector.connectionId, "selector.connectionId")
    if (connectionSourceKey === "main" && normalizedConnectionId !== undefined && normalizedConnectionId !== null) {
      return fail("INVALID_SELECTOR", "Main consent cannot retain a connection ID")
    }
    const normalizedSelector: ConsentSelector = {
      presetId,
      threadId,
      ...(workspaceSource === undefined ? {} : { workspaceSource }),
      ...(connectionSourceKey === undefined ? {} : { connectionSourceKey }),
      ...(normalizedConnectionId === undefined ? {} : { connectionId: normalizedConnectionId }),
      ...(selector.dispatchRevision === undefined ? {} : { dispatchRevision: revision(selector.dispatchRevision) }),
      ...(selector.disclosureVersion === undefined
        ? {}
        : { disclosureVersion: disclosureVersion(selector.disclosureVersion, this.disclosureVersion) }),
    }

    return this.enqueueDocumentMutation(userId, presetId, async () => {
      const initial = await this.store.readLatest(userId, presetId).catch(mapStoreError)
      if (input.expectedDocumentRevision !== undefined) {
        if (!Number.isSafeInteger(input.expectedDocumentRevision) || input.expectedDocumentRevision < 0) {
          return fail("STALE_DOCUMENT", "expectedDocumentRevision is invalid")
        }
        if (initial.documentRevision !== input.expectedDocumentRevision) {
          return fail("STALE_DOCUMENT", "Consent revoke was derived from a stale document revision")
        }
      }
      const matches = Object.entries(initial.consents)
        .filter(([, record]) => selectorMatches(record, normalizedSelector))
      const pendingToDelete = this.pendingDisclosures.entries()
        .filter((entry) => {
          const disclosure = entry.value
          return disclosure.userId === userId && disclosureMatchesSelector(disclosure, normalizedSelector)
        })
      let replacement = initial
      for (const [, record] of matches) {
        replacement = reduceConsentIntent(replacement, { type: "revoke", consent: record })
      }
      const current = matches.length === 0
        ? initial
        : await this.store.writeDocument(
            userId,
            presetId,
            initial.documentRevision,
            replacement,
          ).catch(mapStoreError)
      for (const entry of pendingToDelete) {
        this.pendingDisclosures.deleteIf(entry.key, (candidate) => candidate === entry.value)
      }
      this.revokedSelectors.set(
        selectorFingerprint(userId, normalizedSelector),
        consentScope(userId, presetId, threadId),
        true,
      )
      for (const [, record] of matches) {
        this.revokedSelectors.set(
          selectorFingerprint(userId, {
            presetId: record.presetId,
            threadId: record.threadId,
            workspaceSource: record.workspaceSource,
            connectionSourceKey: record.connectionSourceKey,
            connectionId: record.connectionId,
          }),
          consentScope(userId, record.presetId, record.threadId),
          true,
        )
      }
      const pair = assertInstallPair(this.store.getInstallPair())
      return snapshotFromDocument(userId, presetId, pair, current)
    })
  }

  async revokeConsent(input: ConsentRevokeInput): Promise<ConsentSnapshot> {
    return this.revoke(input)
  }

  async listConsents(userIdInput: string, presetIdInput: string): Promise<ConsentSnapshot> {
    const userId = text(userIdInput, "userId")
    const presetId = uuid(presetIdInput, "presetId")
    const pair = assertInstallPair(this.store.getInstallPair())
    const document = await this.store.readLatest(userId, presetId)
    return snapshotFromDocument(userId, presetId, pair, document)
  }

  async list(userId: string, presetId: string): Promise<ConsentSnapshot> {
    return this.listConsents(userId, presetId)
  }

  async authorize(input: ConsentAuthorizationInput): Promise<AuthorizedConsent> {
    const userId = text(input.userId, "userId")
    const presetId = uuid(input.presetId, "presetId")
    const threadId = text(input.threadId, "threadId")
    const workspaceSource = workspace(input.workspaceSource)
    const connectionSourceKey = sourceKey(input.connectionSourceKey)
    const normalizedConnectionId = connectionId(input.connectionId, connectionSourceKey)
    const descriptor = input.descriptor === undefined ? undefined : cloneDescriptor(input.descriptor)
    if (
      descriptor !== undefined &&
      input.dispatchRevision !== undefined &&
      descriptor.connectionDispatchRevision !== revision(input.dispatchRevision)
    ) {
      return fail("STALE_CONSENT", "Authorization descriptor does not match the supplied revision")
    }
    const dispatchRevision = descriptorRevision(descriptor, input.dispatchRevision)
    if (descriptor !== undefined && connectionSourceKey !== "main" && descriptor.connectionId !== normalizedConnectionId) {
      return fail("STALE_CONSENT", "Authorization descriptor does not match the source")
    }
    const pair = assertInstallPair(this.store.getInstallPair())
    const document = await this.store.readLatest(userId, presetId)
    const record = document.consents[buildConsentKey(
      pair.extensionInstallationId,
      pair.installNonce,
      presetId,
      threadId,
      workspaceSource,
      connectionSourceKey,
      normalizedConnectionId,
      dispatchRevision,
      disclosureVersion(input.disclosureVersion, this.disclosureVersion),
    )]
    if (!record) return fail("REVOKED_CONSENT", "Consent is missing, stale, or revoked")
    if (record.installId !== pair.extensionInstallationId || record.nonce !== pair.installNonce) {
      return fail("INSTALL_MISMATCH", "Consent belongs to another installation")
    }
    return Object.freeze({
      userId,
      key: buildConsentKey(record),
      consent: cloneRecord(record),
      descriptor,
    })
  }

  async saveConsent(input: ConsentGrantInput): Promise<ConsentSnapshot> {
    return this.grant(input)
  }

  async updateConsent(input: ConsentGrantInput): Promise<ConsentSnapshot> {
    return this.grant(input)
  }

  async removeConsent(input: ConsentRevokeInput): Promise<ConsentSnapshot> {
    return this.revoke(input)
  }

  async getConsents(userId: string, presetId: string): Promise<ConsentSnapshot> {
    return this.listConsents(userId, presetId)
  }
  async authorizeExecution(input: ConsentAuthorizationInput): Promise<AuthorizedConsent> {
    return this.authorize(input)
  }

  async hasConsent(input: ConsentAuthorizationInput): Promise<boolean> {
    try {
      await this.authorize(input)
      return true
    } catch (error) {
      if (error instanceof ConsentError && (error.code === "REVOKED_CONSENT" || error.code === "STALE_CONSENT")) return false
      throw error
    }
  }

  async status(input: ConsentAuthorizationInput): Promise<ConsentStatus> {
    const userId = text(input.userId, "userId")
    const presetId = uuid(input.presetId, "presetId")
    return this.enqueueDocumentMutation(userId, presetId, () => this.statusInternal(input))
  }

  private async statusInternal(input: ConsentAuthorizationInput): Promise<ConsentStatus> {
    if (await this.hasConsent(input)) return "approved"
    const dispatchRevision = input.descriptor === undefined
      ? input.dispatchRevision
      : cloneDescriptor(input.descriptor).connectionDispatchRevision
    const selector: ConsentSelector = {
      presetId: input.presetId,
      threadId: input.threadId,
      workspaceSource: input.workspaceSource,
      connectionSourceKey: input.connectionSourceKey,
      connectionId: input.connectionId,
      dispatchRevision,
      disclosureVersion: input.disclosureVersion,
    }
    const identitySelector: ConsentSelector = {
      presetId: input.presetId,
      threadId: input.threadId,
      workspaceSource: input.workspaceSource,
      connectionSourceKey: input.connectionSourceKey,
      connectionId: input.connectionId,
    }
    const current = await this.listConsents(input.userId, input.presetId)
    const identityPresent = current.consents.some((record) => selectorMatches(record, identitySelector))
    if (identityPresent) {
      try {
        await this.authorize(input)
        return "approved"
      } catch (error) {
        if (error instanceof ConsentError && (error.code === "REVOKED_CONSENT" || error.code === "STALE_CONSENT")) {
          return "revoked"
        }
        throw error
      }
    }
    return (
      this.revokedSelectors.has(selectorFingerprint(input.userId, selector)) ||
      this.revokedSelectors.has(selectorFingerprint(input.userId, identitySelector))
    )
      ? "revoked"
      : "required"
  }
  async applyRpc(userId: string, request: ConsentRpcRequest): Promise<ConsentRpcResponse> {
    if (request.type === "approve_consent") {
      return this.approveBySelector(
        userId,
        {
          presetId: request.presetId,
          threadId: request.threadId,
          workspaceSource: request.workspaceSource,
          connectionSourceKey: request.connectionSourceKey,
        },
        request.expectedDocumentRevision,
      )
    }
    return this.revoke({
      userId,
      selector: {
        presetId: request.presetId,
        threadId: request.threadId,
        workspaceSource: request.workspaceSource,
        connectionSourceKey: request.connectionSourceKey,
        connectionId: request.connectionId,
        dispatchRevision: request.dispatchRevision,
        disclosureVersion: request.disclosureVersion,
      },
      expectedDocumentRevision: request.expectedDocumentRevision,
    })
  }
}

export const ConsentManager = ConsentService
export const ConsentLifecycle = ConsentService

export function createConsentService(dependencies: ConsentServiceDependencies): ConsentService {
  return new ConsentService(dependencies)
}

export async function grantConsent(
  service: ConsentService,
  input: ConsentGrantInput,
): Promise<ConsentSnapshot> {
  return service.grant(input)
}

export async function revokeConsent(
  service: ConsentService,
  input: ConsentRevokeInput,
): Promise<ConsentSnapshot> {
  return service.revoke(input)
}

export async function listConsents(
  service: ConsentService,
  userId: string,
  presetId: string,
): Promise<ConsentSnapshot> {
  return service.listConsents(userId, presetId)
}

export async function authorizeConsent(
  service: ConsentService,
  input: ConsentAuthorizationInput,
): Promise<AuthorizedConsent> {
  return service.authorize(input)
}
