// @ts-ignore Bun provides the test module at runtime; the extension bundle excludes this file.
import { describe, expect, it } from "bun:test"
import {
  AtomicJsonStore,
  AtomicJsonStoreError,
  type StorageAdapter,
} from "./atomic-json-store"
import { MAX_CONFIG_BYTES, MAX_CONNECTION_SLOTS } from "../config/limits"
import { MAX_CONSENT_VIEWS } from "../protocol/messages"
import {
  buildBindingDocumentKey,
  buildBindingKey,
  buildConsentKey,
  buildInstallRecordKey,
  createEmptyBindingConsentDocument,
  decodeBindingConsentDocument,
  decodeInstallRecord,
  DocumentValidationError,
  reduceBindingIntent,
  reduceConsentIntent,
} from "./documents"

const HOST_A = "11111111-1111-4111-8111-111111111111"
const HOST_B = "22222222-2222-4222-8222-222222222222"
const PRESET_ID = "33333333-3333-4333-8333-333333333333"
const SLOT_ID = "44444444-4444-4444-8444-444444444444"
const OTHER_PRESET_ID = "55555555-5555-4555-8555-555555555555"
const CONNECTION_ID = "66666666-6666-4666-8666-666666666666"
const OTHER_CONNECTION_ID = "77777777-7777-4777-8777-777777777777"
const INSTALL_NONCE_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const INSTALL_NONCE_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const TEMP_MARKER = ".tmp."

class MemoryStorage implements StorageAdapter {
  readonly files = new Map<string, string>()
  failWrite = false
  failMove = false
  readonly writes: string[] = []
  readonly moves: Array<readonly [string, string]> = []
  readonly lists: string[] = []
  readonly listGates: Array<() => Promise<void>> = []
  listFailures = 0
  failRepeatedList = false
  existsObserver?: (path: string) => void
  readonly moveGates: Array<() => Promise<void>> = []

  async read(path: string): Promise<unknown> {
    return this.files.get(path) ?? null
  }

  async write(path: string, content: string): Promise<void> {
    this.writes.push(path)
    if (this.failWrite) {
      this.failWrite = false
      throw new Error("write failure")
    }
    this.files.set(path, content)
  }

  async move(sourcePath: string, destinationPath: string): Promise<void> {
    const moveGate = this.moveGates.shift()
    if (moveGate) await moveGate()
    this.moves.push([sourcePath, destinationPath])
    if (this.failMove) {
      this.failMove = false
      throw new Error("move failure")
    }
    const content = this.files.get(sourcePath)
    if (content === undefined) throw new Error("missing source")
    this.files.delete(sourcePath)
    this.files.set(destinationPath, content)
  }

  async delete(path: string): Promise<void> {
    this.files.delete(path)
  }

  async exists(path: string): Promise<boolean> {
    const present = this.files.has(path)
    this.existsObserver?.(path)
    return present
  }

  async list(prefix: string): Promise<readonly string[]> {
    const repeated = this.lists.includes(prefix)
    this.lists.push(prefix)
    const listGate = this.listGates.shift()
    if (listGate) await listGate()
    if (this.listFailures > 0) {
      this.listFailures -= 1
      throw new Error("list failure")
    }
    if (this.failRepeatedList && repeated) {
      this.failRepeatedList = false
      throw new Error("repeated list failure")
    }
    return [...this.files.keys()].filter((path) => path.startsWith(prefix))
  }
}

class HostFaithfulMemoryStorage extends MemoryStorage {
  override async list(prefix: string): Promise<readonly string[]> {
    if (prefix.endsWith("/bindings.json")) throw new Error("ENOTDIR")
    const paths = await super.list(prefix)
    if (prefix === "") {
      const installPath = buildInstallRecordKey()
      return paths.filter(
        (path) => path === installPath || path.startsWith(`${installPath}${TEMP_MARKER}`),
      )
    }
    const directoryPrefix = `${prefix}/`
    return paths
      .filter((path) => path.startsWith(directoryPrefix))
      .map((path) => path.slice(directoryPrefix.length))
  }
}

function nonceFactory(...letters: readonly string[]): () => string {
  const values = [...letters]
  return () => {
    const value = values.shift() ?? "f"
    return `${/^[0-9a-f]$/.test(value) ? value : "c"}`.repeat(32)
  }
}

function bindingIntent(connectionId: string = CONNECTION_ID) {
  return {
    type: "bind" as const,
    presetId: PRESET_ID,
    slotId: SLOT_ID,
    connectionSourceKey: `slot:${SLOT_ID}`,
    connectionId,
    dispatchRevision: "revision-a",
  }
}

function generatedUuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`
}

function persistedBindingDocument(
  presetId: string,
  count: number,
  documentRevision = 0,
): Record<string, unknown> {
  const bindings: Record<string, unknown> = {}
  for (let index = 0; index < count; index += 1) {
    const slotId = index === 0 ? SLOT_ID : generatedUuid(index + 1)
    const connectionId = index === 0 ? CONNECTION_ID : generatedUuid(0x100 + index)
    bindings[buildBindingKey(presetId, slotId)] = {
      presetId,
      slotId,
      connectionSourceKey: `slot:${slotId}`,
      connectionId,
      dispatchRevision: `revision-${index}`,
    }
  }
  return {
    schemaVersion: 1,
    documentRevision,
    bindings,
    consents: {},
  }
}

function persistedConsentDocument(
  presetId: string,
  count: number,
  documentRevision = 0,
): Record<string, unknown> {
  const consents: Record<string, unknown> = {}
  const sourceKeys = [
    "main",
    ...Array.from(
      { length: MAX_CONNECTION_SLOTS },
      (_, index) => `slot:${generatedUuid(0x400 + index)}`,
    ),
  ]
  for (let index = 0; index < count; index += 1) {
    const sourceKey = sourceKeys[index % sourceKeys.length]!
    const threadIndex = Math.floor(index / sourceKeys.length)
    const threadId = threadIndex === 0 ? "main" : generatedUuid(0x500 + threadIndex)
    const connectionId = sourceKey === "main" ? null : generatedUuid(0x600 + index)
    const consent = {
      installId: HOST_A,
      nonce: INSTALL_NONCE_A,
      presetId,
      threadId,
      workspaceSource: "main-context" as const,
      connectionSourceKey: sourceKey,
      connectionId,
      dispatchRevision: `revision-${index}`,
      disclosureVersion: 1,
    }
    consents[buildConsentKey(consent)] = consent
  }
  return {
    schemaVersion: 1,
    documentRevision,
    bindings: {},
    consents,
  }
}

function expected(store: AtomicJsonStore, revision: number) {
  const pair = store.getInstallPair()
  return { documentRevision: revision, ...pair }
}

function deferred(): Readonly<{
  promise: Promise<void>
  resolve: () => void
}> {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

type QueueInspection = Readonly<{
  queues: ReadonlyMap<string, Promise<void>>
}>

function queueMap(store: AtomicJsonStore): ReadonlyMap<string, Promise<void>> {
  const inspection = store as unknown as QueueInspection
  return inspection.queues
}

type QuarantineInspection = Readonly<{
  rotatedQuarantinesByPath: ReadonlyMap<string, Promise<void>>
}>

function quarantineMap(store: AtomicJsonStore): ReadonlyMap<string, Promise<void>> {
  const inspection = store as unknown as QuarantineInspection
  return inspection.rotatedQuarantinesByPath
}

describe("state document codecs", () => {
  it("decodes canonical values and rejects hostile JSON shapes", () => {
    const install = decodeInstallRecord({
      schemaVersion: 1,
      extensionInstallationId: HOST_A,
      installNonce: INSTALL_NONCE_A,
    })
    expect(Object.isFrozen(install)).toBe(true)
    expect(() => decodeInstallRecord({
      schemaVersion: 1,
      extensionInstallationId: HOST_A,
      installNonce: INSTALL_NONCE_A,
      toJSON: () => "forged",
    })).toThrow()

    const cyclic: Record<string, unknown> = {
      schemaVersion: 1,
      documentRevision: 0,
      bindings: {},
      consents: {},
    }
    cyclic.consents = cyclic
    expect(() => decodeBindingConsentDocument(cyclic, PRESET_ID)).toThrow()
  })

  it("returns immutable intent reductions under canonical binding keys", () => {
    const before = createEmptyBindingConsentDocument()
    const after = reduceBindingIntent(before, bindingIntent(), PRESET_ID)
    expect(after.documentRevision).toBe(0)
    expect(after.bindings[buildBindingKey(PRESET_ID, SLOT_ID)]?.connectionId).toBe(CONNECTION_ID)
    expect(Object.isFrozen(after)).toBe(true)
    expect(Object.isFrozen(after.bindings)).toBe(true)
    expect(before.bindings).toEqual({})
    const consent = {
      installId: HOST_A,
      nonce: INSTALL_NONCE_A,
      presetId: PRESET_ID,
      threadId: "main",
      workspaceSource: "main-context" as const,
      connectionSourceKey: "main" as const,
      connectionId: null,
      dispatchRevision: "revision-a",
      disclosureVersion: 1,
    }
    const withConsent = reduceConsentIntent(after, { type: "grant", consent }, PRESET_ID)
    expect(withConsent.consents[buildConsentKey(consent)]).toEqual(consent)
  })
})

describe("AtomicJsonStore", () => {
  it("preserves state across restart with the same host installation ID", async () => {
    const storage = new MemoryStorage()
    const first = new AtomicJsonStore(storage, { nonceGenerator: nonceFactory("x", "a") })
    const install = await first.initialize(HOST_A)
    const saved = await first.applyBindingIntent("user-one", PRESET_ID, bindingIntent())

    const restarted = new AtomicJsonStore(storage, { nonceGenerator: nonceFactory("y") })
    const sameInstall = await restarted.initialize(HOST_A)
    expect(sameInstall.installNonce).toBe(install.installNonce)
    expect(await restarted.readDocument("user-one", PRESET_ID)).toEqual(saved)
  })

  it("rotates the install pair and quarantines old user state on host reinstall", async () => {
    const storage = new MemoryStorage()
    const first = new AtomicJsonStore(storage, { nonceGenerator: nonceFactory("x", "a") })
    await first.initialize(HOST_A)
    await first.applyBindingIntent("user-one", PRESET_ID, bindingIntent())
    await first.applyBindingIntent("user-two", PRESET_ID, bindingIntent(OTHER_CONNECTION_ID))

    const replacement = new AtomicJsonStore(storage, { nonceGenerator: nonceFactory("y", "b") })
    const install = await replacement.initialize(HOST_B)
    expect(install.extensionInstallationId).toBe(HOST_B)
    expect(install.installNonce).toBe(INSTALL_NONCE_B)
    expect(await replacement.readDocument("user-one", PRESET_ID)).toEqual(
      createEmptyBindingConsentDocument(),
    )
    const canonical = buildBindingDocumentKey("user-one", PRESET_ID)
    expect(storage.files.has(canonical)).toBe(false)
    expect([...storage.files.keys()].some((path) => path.includes(".quarantine."))).toBe(true)
    const restarted = new AtomicJsonStore(storage, { nonceGenerator: nonceFactory("z") })
    await restarted.initialize(HOST_B)
    expect(await restarted.readDocument("user-two", PRESET_ID)).toEqual(
      createEmptyBindingConsentDocument(),
    )
  })

  it("serializes rotated quarantine before a concurrent read/write can touch the path", async () => {
    const storage = new MemoryStorage()
    const userId = "rotated-race-user"
    const canonical = buildBindingDocumentKey(userId, PRESET_ID)
    storage.files.set(
      buildInstallRecordKey(),
      JSON.stringify({
        schemaVersion: 1,
        extensionInstallationId: HOST_A,
        installNonce: INSTALL_NONCE_A,
      }),
    )
    storage.files.set(canonical, JSON.stringify(createEmptyBindingConsentDocument()))

    const store = new AtomicJsonStore(storage, { nonceGenerator: nonceFactory("x", "b") })
    await store.initialize(HOST_B)

    const moveStarted = deferred()
    const releaseMove = deferred()
    storage.moveGates.push(async () => {
      moveStarted.resolve()
      await releaseMove.promise
    })
    const read = store.readDocument(userId, PRESET_ID)
    await moveStarted.promise

    const write = store.writeDocument(
      userId,
      PRESET_ID,
      expected(store, 0),
      createEmptyBindingConsentDocument(),
    )
    releaseMove.resolve()

    await expect(read).resolves.toMatchObject({ documentRevision: 0 })
    await expect(write).resolves.toMatchObject({ documentRevision: 1 })
    expect(
      storage.moves.filter(
        ([source, destination]) =>
          source === canonical && destination.startsWith(`${canonical}.quarantine.`),
      ),
    ).toHaveLength(1)
    expect((await store.readDocument(userId, PRESET_ID)).documentRevision).toBe(1)
  })

  it("waits for an in-flight quarantine before repeated initialization", async () => {
    const storage = new MemoryStorage()
    const userId = "reinitialize-race-user"
    const canonical = buildBindingDocumentKey(userId, PRESET_ID)
    storage.files.set(
      buildInstallRecordKey(),
      JSON.stringify({
        schemaVersion: 1,
        extensionInstallationId: HOST_A,
        installNonce: INSTALL_NONCE_A,
      }),
    )
    storage.files.set(canonical, JSON.stringify(createEmptyBindingConsentDocument()))

    const store = new AtomicJsonStore(storage, { nonceGenerator: nonceFactory("x", "b") })
    await store.initialize(HOST_B)
    const moveStarted = deferred()
    const releaseMove = deferred()
    storage.moveGates.push(async () => {
      moveStarted.resolve()
      await releaseMove.promise
    })
    const firstRead = store.readDocument(userId, PRESET_ID)
    await moveStarted.promise

    const reinitialize = store.initialize(HOST_B)
    const secondRead = store.readDocument(userId, PRESET_ID)
    releaseMove.resolve()

    await expect(firstRead).resolves.toMatchObject({ documentRevision: 0 })
    await expect(reinitialize).resolves.toMatchObject({ extensionInstallationId: HOST_B })
    await expect(secondRead).resolves.toMatchObject({ documentRevision: 0 })
    expect(
      storage.moves.filter(
        ([source, destination]) =>
          source === canonical && destination.startsWith(`${canonical}.quarantine.`),
      ),
    ).toHaveLength(1)
  })

  it("drains document work before publishing a rotated install", async () => {
    const storage = new MemoryStorage()
    const store = new AtomicJsonStore(storage, { nonceGenerator: nonceFactory("x", "a", "b") })
    await store.initialize(HOST_A)

    const moveStarted = deferred()
    const releaseMove = deferred()
    storage.moveGates.push(async () => {
      moveStarted.resolve()
      await releaseMove.promise
    })
    const write = store.writeDocument(
      "transition-user",
      PRESET_ID,
      expected(store, 0),
      createEmptyBindingConsentDocument(),
    )
    await moveStarted.promise

    const rotate = store.initialize(HOST_B)
    releaseMove.resolve()

    await expect(write).resolves.toMatchObject({ documentRevision: 1 })
    await expect(rotate).resolves.toMatchObject({ extensionInstallationId: HOST_B })
    expect(await store.readDocument("transition-user", PRESET_ID)).toEqual(
      createEmptyBindingConsentDocument(),
    )
  })

  it("does not delete user documents while cleaning install-record temps", async () => {
    const storage = new MemoryStorage()
    const first = new AtomicJsonStore(storage, { nonceGenerator: nonceFactory("x", "a") })
    await first.initialize(HOST_A)
    const saved = await first.applyBindingIntent("foo.tmp.user", PRESET_ID, bindingIntent())

    const restarted = new AtomicJsonStore(storage, { nonceGenerator: nonceFactory("y") })
    await restarted.initialize(HOST_A)
    expect(await restarted.readDocument("foo.tmp.user", PRESET_ID)).toEqual(saved)
  })

  it("marks a newly created rotated document as current across restart", async () => {
    const storage = new MemoryStorage()
    storage.files.set(
      buildInstallRecordKey(),
      JSON.stringify({
        schemaVersion: 1,
        extensionInstallationId: HOST_A,
        installNonce: INSTALL_NONCE_A,
      }),
    )
    const store = new AtomicJsonStore(storage, { nonceGenerator: nonceFactory("x", "b") })
    const install = await store.initialize(HOST_B)
    const userId = "rotated-new-user"
    const canonical = buildBindingDocumentKey(userId, PRESET_ID)
    const markerTemp = `${canonical}.quarantine.${install.installNonce}${TEMP_MARKER}crashed`
    storage.files.set(markerTemp, "orphan")

    await expect(
      store.writeDocument(
        userId,
        PRESET_ID,
        expected(store, 0),
        createEmptyBindingConsentDocument(),
      ),
    ).resolves.toMatchObject({ documentRevision: 1 })
    expect(storage.files.has(`${canonical}.quarantine.${install.installNonce}`)).toBe(true)
    expect(storage.files.has(markerTemp)).toBe(false)
    expect((await store.readDocument(userId, PRESET_ID)).documentRevision).toBe(1)
    const readOnlyMarkerTemp = `${canonical}.quarantine.${install.installNonce}${TEMP_MARKER}read-only`
    storage.files.set(readOnlyMarkerTemp, "orphan")
    expect((await store.readDocument(userId, PRESET_ID)).documentRevision).toBe(1)
    expect(storage.files.has(readOnlyMarkerTemp)).toBe(false)

    const restarted = new AtomicJsonStore(storage, { nonceGenerator: nonceFactory("z") })
    await restarted.initialize(HOST_B)
    expect((await restarted.readDocument(userId, PRESET_ID)).documentRevision).toBe(1)
  })

  it("does not retain absent rotated paths after quarantine probes settle", async () => {
    const storage = new MemoryStorage()
    storage.files.set(
      buildInstallRecordKey(),
      JSON.stringify({
        schemaVersion: 1,
        extensionInstallationId: HOST_A,
        installNonce: INSTALL_NONCE_A,
      }),
    )
    const store = new AtomicJsonStore(storage, { nonceGenerator: nonceFactory("x", "b") })
    await store.initialize(HOST_B)

    await Promise.all(
      Array.from({ length: 1_024 }, (_, index) =>
        store.readDocument(`rotated-absent-${index}`, PRESET_ID),
      ),
    )

    expect(quarantineMap(store).size).toBe(0)
    expect([...storage.files.keys()].some((path) => path.includes("rotated-absent-"))).toBe(false)
  })

  it("fails closed on a corrupt canonical install record", async () => {
    const storage = new MemoryStorage()
    storage.files.set(buildInstallRecordKey(), JSON.stringify({ schemaVersion: 1 }))
    const store = new AtomicJsonStore(storage, { nonceGenerator: nonceFactory("x") })
    await expect(store.initialize(HOST_A)).rejects.toMatchObject<Partial<AtomicJsonStoreError>>({
      code: "CORRUPT_INSTALL_RECORD",
    })
    expect(storage.files.has(buildInstallRecordKey())).toBe(true)
  })

  it("rejects reads before initialization even when state is absent", async () => {
    const store = new AtomicJsonStore(new MemoryStorage(), { nonceGenerator: nonceFactory("x") })
    await expect(store.readDocument("uninitialized-user", PRESET_ID)).rejects.toMatchObject<
      Partial<AtomicJsonStoreError>
    >({ code: "NOT_INITIALIZED" })
  })

  it("rejects stale intents without changing the canonical revision", async () => {
    const storage = new MemoryStorage()
    const store = new AtomicJsonStore(storage, { nonceGenerator: nonceFactory("x", "a") })
    await store.initialize(HOST_A)
    await store.applyBindingIntent("user-one", PRESET_ID, bindingIntent())
    const stale = expected(store, 0)

    await expect(
      store.applyBindingIntent("user-one", PRESET_ID, bindingIntent(OTHER_CONNECTION_ID), stale),
    ).rejects.toMatchObject<Partial<AtomicJsonStoreError>>({ code: "REVISION_MISMATCH" })
    expect((await store.readDocument("user-one", PRESET_ID)).documentRevision).toBe(1)
  })

  it("rejects bind and unbind intents whose preset differs from the outer scope", async () => {
    const storage = new MemoryStorage()
    const store = new AtomicJsonStore(storage, { nonceGenerator: nonceFactory("x", "a") })
    await store.initialize(HOST_A)
    const userId = "intent-scope-user"
    const path = buildBindingDocumentKey(userId, PRESET_ID)
    const before = await store.readDocument(userId, PRESET_ID)

    await expect(
      store.applyBindingIntent(userId, PRESET_ID, {
        ...bindingIntent(),
        presetId: OTHER_PRESET_ID,
      }),
    ).rejects.toMatchObject<Partial<AtomicJsonStoreError>>({ code: "CORRUPT_DOCUMENT" })
    await expect(
      store.applyBindingIntent(userId, PRESET_ID, {
        type: "unbind",
        presetId: OTHER_PRESET_ID,
        slotId: SLOT_ID,
      }),
    ).rejects.toMatchObject<Partial<AtomicJsonStoreError>>({ code: "CORRUPT_DOCUMENT" })

    expect(await store.readDocument(userId, PRESET_ID)).toEqual(before)
    expect(storage.files.has(path)).toBe(false)
  })

  it("rejects cross-preset candidates through writeDocument and commitDocument", async () => {
    const storage = new MemoryStorage()
    const store = new AtomicJsonStore(storage, { nonceGenerator: nonceFactory("x", "a") })
    await store.initialize(HOST_A)
    const userId = "candidate-scope-user"
    const path = buildBindingDocumentKey(userId, PRESET_ID)
    const candidate = reduceBindingIntent(
      createEmptyBindingConsentDocument(),
      {
        ...bindingIntent(),
        presetId: OTHER_PRESET_ID,
      },
      OTHER_PRESET_ID,
    )

    await expect(
      store.writeDocument(userId, PRESET_ID, expected(store, 0), candidate),
    ).rejects.toMatchObject<Partial<AtomicJsonStoreError>>({ code: "CORRUPT_DOCUMENT" })
    await expect(
      store.commitDocument(userId, PRESET_ID, expected(store, 0), candidate),
    ).rejects.toMatchObject<Partial<AtomicJsonStoreError>>({ code: "CORRUPT_DOCUMENT" })

    expect(storage.files.has(path)).toBe(false)
    await expect(store.readDocument(userId, PRESET_ID)).resolves.toEqual(
      createEmptyBindingConsentDocument(),
    )
  })

  it("rejects mismatched persisted binding and consent records without exposing them", async () => {
    const storage = new MemoryStorage()
    const store = new AtomicJsonStore(storage, { nonceGenerator: nonceFactory("x", "a") })
    await store.initialize(HOST_A)

    const bindingUserId = "persisted-binding-scope-user"
    const bindingPath = buildBindingDocumentKey(bindingUserId, PRESET_ID)
    const bindingBytes = JSON.stringify(persistedBindingDocument(OTHER_PRESET_ID, 1, 6))
    storage.files.set(bindingPath, bindingBytes)

    const consentUserId = "persisted-consent-scope-user"
    const consentPath = buildBindingDocumentKey(consentUserId, PRESET_ID)
    const consent = {
      installId: HOST_A,
      nonce: INSTALL_NONCE_A,
      presetId: OTHER_PRESET_ID,
      threadId: "main",
      workspaceSource: "main-context" as const,
      connectionSourceKey: "main" as const,
      connectionId: null,
      dispatchRevision: "revision-a",
      disclosureVersion: 1,
    }
    const consentDocument = {
      ...persistedBindingDocument(PRESET_ID, 0, 7),
      consents: { [buildConsentKey(consent)]: consent },
    }
    const consentBytes = JSON.stringify(consentDocument)
    storage.files.set(consentPath, consentBytes)

    await expect(store.readDocument(bindingUserId, PRESET_ID)).rejects.toMatchObject<
      Partial<AtomicJsonStoreError>
    >({ code: "CORRUPT_DOCUMENT" })
    await expect(store.readDocument(consentUserId, PRESET_ID)).rejects.toMatchObject<
      Partial<AtomicJsonStoreError>
    >({ code: "CORRUPT_DOCUMENT" })
    expect(storage.files.get(bindingPath)).toBe(bindingBytes)
    expect(storage.files.get(consentPath)).toBe(consentBytes)
  })

  it("fails closed on persisted over-cap bindings before read, rebind, unbind, or write", async () => {
    const storage = new MemoryStorage()
    const store = new AtomicJsonStore(storage, { nonceGenerator: nonceFactory("x", "a") })
    await store.initialize(HOST_A)
    const userId = "persisted-over-cap-user"
    const path = buildBindingDocumentKey(userId, PRESET_ID)
    const bytes = JSON.stringify(
      persistedBindingDocument(PRESET_ID, MAX_CONNECTION_SLOTS + 1, 9),
    )
    storage.files.set(path, bytes)

    await expect(store.readDocument(userId, PRESET_ID)).rejects.toMatchObject<
      Partial<AtomicJsonStoreError>
    >({ code: "CORRUPT_DOCUMENT" })
    await expect(store.readLatest(userId, PRESET_ID)).rejects.toMatchObject<
      Partial<AtomicJsonStoreError>
    >({ code: "CORRUPT_DOCUMENT" })
    await expect(
      store.applyBindingIntent(userId, PRESET_ID, bindingIntent()),
    ).rejects.toMatchObject<Partial<AtomicJsonStoreError>>({ code: "CORRUPT_DOCUMENT" })
    await expect(
      store.applyBindingIntent(userId, PRESET_ID, {
        type: "unbind",
        presetId: PRESET_ID,
        slotId: SLOT_ID,
      }),
    ).rejects.toMatchObject<Partial<AtomicJsonStoreError>>({ code: "CORRUPT_DOCUMENT" })
    await expect(
      store.writeDocument(userId, PRESET_ID, expected(store, 9), createEmptyBindingConsentDocument()),
    ).rejects.toMatchObject<Partial<AtomicJsonStoreError>>({ code: "CORRUPT_DOCUMENT" })
    await expect(
      store.commitDocument(userId, PRESET_ID, expected(store, 9), createEmptyBindingConsentDocument()),
    ).rejects.toMatchObject<Partial<AtomicJsonStoreError>>({ code: "CORRUPT_DOCUMENT" })

    expect(storage.files.get(path)).toBe(bytes)
    const persisted = JSON.parse(storage.files.get(path)!)
    expect(persisted).toMatchObject({ documentRevision: 9 })
  })
  it("bounds persisted consent cardinality and serialized document bytes", async () => {
    const maxConsents = MAX_CONSENT_VIEWS
    const atLimit = persistedConsentDocument(PRESET_ID, maxConsents, 3)
    expect(Object.keys(decodeBindingConsentDocument(atLimit, PRESET_ID).consents)).toHaveLength(maxConsents)

    const overCardinality = persistedConsentDocument(PRESET_ID, maxConsents + 1, 4)
    expect(() => decodeBindingConsentDocument(overCardinality, PRESET_ID)).toThrow(DocumentValidationError)

    const storage = new MemoryStorage()
    const store = new AtomicJsonStore(storage, { nonceGenerator: nonceFactory("x", "a") })
    await store.initialize(HOST_A)
    const userId = "persisted-oversized-consent-document-user"
    const path = buildBindingDocumentKey(userId, PRESET_ID)
    const oversized = {
      ...persistedConsentDocument(PRESET_ID, 0, 5),
      documentRevision: "x".repeat(MAX_CONFIG_BYTES),
    }
    const bytes = JSON.stringify(oversized)
    storage.files.set(path, bytes)

    await expect(store.readDocument(userId, PRESET_ID)).rejects.toMatchObject<
      Partial<AtomicJsonStoreError>
    >({ code: "CORRUPT_DOCUMENT" })
    expect(storage.files.get(path)).toBe(bytes)
    const padded = `${" ".repeat(MAX_CONFIG_BYTES)}${JSON.stringify(createEmptyBindingConsentDocument())}`
    storage.files.set(path, padded)
    await expect(store.readDocument(userId, PRESET_ID)).rejects.toMatchObject<
      Partial<AtomicJsonStoreError>
    >({ code: "CORRUPT_DOCUMENT" })
    expect(storage.files.get(path)).toBe(padded)
  })


  it("accepts exactly MAX_CONNECTION_SLOTS persisted bindings", async () => {
    const storage = new MemoryStorage()
    const store = new AtomicJsonStore(storage, { nonceGenerator: nonceFactory("x", "a") })
    await store.initialize(HOST_A)
    const userId = "persisted-at-cap-user"
    const path = buildBindingDocumentKey(userId, PRESET_ID)
    storage.files.set(
      path,
      JSON.stringify(persistedBindingDocument(PRESET_ID, MAX_CONNECTION_SLOTS, 4)),
    )

    const read = await store.readDocument(userId, PRESET_ID)
    expect(Object.keys(read.bindings)).toHaveLength(MAX_CONNECTION_SLOTS)
    const rebound = await store.applyBindingIntent(
      userId,
      PRESET_ID,
      bindingIntent(OTHER_CONNECTION_ID),
      expected(store, 4),
    )
    expect(rebound.documentRevision).toBe(5)
    expect(Object.keys(rebound.bindings)).toHaveLength(MAX_CONNECTION_SLOTS)
    const unbound = await store.applyBindingIntent(
      userId,
      PRESET_ID,
      {
        type: "unbind",
        presetId: PRESET_ID,
        slotId: SLOT_ID,
      },
      expected(store, 5),
    )
    expect(unbound.documentRevision).toBe(6)
    expect(Object.keys(unbound.bindings)).toHaveLength(MAX_CONNECTION_SLOTS - 1)
  })

  it("keeps canonical state after failed temp write or move and permits retry", async () => {
    const storage = new MemoryStorage()
    const store = new AtomicJsonStore(storage, { nonceGenerator: nonceFactory("x", "a") })
    await store.initialize(HOST_A)
    const first = await store.applyBindingIntent("user-one", PRESET_ID, bindingIntent())
    const unchanged = expected(store, first.documentRevision)

    storage.failWrite = true
    await expect(
      store.applyBindingIntent("user-one", PRESET_ID, bindingIntent(OTHER_CONNECTION_ID), unchanged),
    ).rejects.toMatchObject<Partial<AtomicJsonStoreError>>({ code: "STORAGE_FAILURE" })
    expect((await store.readDocument("user-one", PRESET_ID)).documentRevision).toBe(1)
    expect(queueMap(store).size).toBe(0)
    expect((await store.readDocument("user-one", PRESET_ID)).bindings[buildBindingKey(PRESET_ID, SLOT_ID)]?.connectionId)
      .toBe(CONNECTION_ID)
    expect((await storage.list(""))).not.toContain(expect.stringContaining(".tmp."))

    storage.failMove = true
    await expect(
      store.applyBindingIntent("user-one", PRESET_ID, bindingIntent(OTHER_CONNECTION_ID), unchanged),
    ).rejects.toMatchObject<Partial<AtomicJsonStoreError>>({ code: "STORAGE_FAILURE" })
    expect((await store.readDocument("user-one", PRESET_ID)).documentRevision).toBe(1)

    expect(queueMap(store).size).toBe(0)
    const retried = await store.applyBindingIntent(
      "user-one",
      PRESET_ID,
      bindingIntent(OTHER_CONNECTION_ID),
      unchanged,
    )
    expect(retried.documentRevision).toBe(2)
    expect(retried.bindings[buildBindingKey(PRESET_ID, SLOT_ID)]?.connectionId).toBe(OTHER_CONNECTION_ID)
  })

  it("removes settled queue tails across high-cardinality paths", async () => {
    const storage = new MemoryStorage()
    const store = new AtomicJsonStore(storage, { nonceGenerator: nonceFactory("x", "a") })
    await store.initialize(HOST_A)

    await Promise.all(
      Array.from({ length: 1_024 }, (_, index) =>
        store.applyBindingIntent(`stress-user-${index}`, PRESET_ID, bindingIntent()),
      ),
    )

    expect(queueMap(store).size).toBe(0)
  })

  it("retries lazy cleanup after a failed enumeration without poisoning queued work", async () => {
    const storage = new MemoryStorage()
    const store = new AtomicJsonStore(storage, { nonceGenerator: nonceFactory("x", "a") })
    await store.initialize(HOST_A)
    storage.listFailures = 1

    const first = store.applyBindingIntent("retry-user", PRESET_ID, bindingIntent(CONNECTION_ID))
    const second = store.applyBindingIntent("retry-user", PRESET_ID, bindingIntent(OTHER_CONNECTION_ID))
    await expect(first).rejects.toMatchObject<Partial<AtomicJsonStoreError>>({
      code: "STORAGE_FAILURE",
    })

    await expect(second).resolves.toMatchObject({ documentRevision: 1 })
    const third = await store.applyBindingIntent(
      "retry-user",
      PRESET_ID,
      bindingIntent(CONNECTION_ID),
    )
    expect(third.documentRevision).toBe(2)
    expect(queueMap(store).size).toBe(0)
  })

  it("cleans user-scoped crash orphans lazily without disturbing canonical siblings", async () => {
    const storage = new HostFaithfulMemoryStorage()
    const store = new AtomicJsonStore(storage, { nonceGenerator: nonceFactory("x", "a") })
    await store.initialize(HOST_A)

    const canonical = buildBindingDocumentKey("orphan-user", PRESET_ID)
    const directory = canonical.slice(0, canonical.lastIndexOf("/"))
    const orphanTemp = `${canonical}${TEMP_MARKER}crashed`
    const quarantine = `${canonical}.quarantine.crashed`
    const canonicalContent = JSON.stringify(createEmptyBindingConsentDocument())
    storage.files.set(canonical, canonicalContent)
    storage.files.set(orphanTemp, "crashed")
    storage.files.set(quarantine, "preserve")

    await expect(storage.list(canonical)).rejects.toThrow("ENOTDIR")
    expect(await storage.list("")).not.toContain(orphanTemp)
    const [first, second] = await Promise.all([
      store.readDocument("orphan-user", PRESET_ID),
      store.readLatest("orphan-user", PRESET_ID),
    ])

    expect(first).toEqual(createEmptyBindingConsentDocument())
    expect(second).toEqual(first)
    expect(storage.files.get(canonical)).toBe(canonicalContent)
    expect(storage.files.get(quarantine)).toBe("preserve")
    expect(storage.files.has(orphanTemp)).toBe(false)
    expect(storage.lists.filter((path) => path === directory)).toHaveLength(1)
  })

  it("does not detach slow path cleanup owned by a concurrent read", async () => {
    const storage = new MemoryStorage()
    const store = new AtomicJsonStore(storage, { nonceGenerator: nonceFactory("x", "a") })
    await store.initialize(HOST_A)

    const listStarted = deferred()
    const releaseList = deferred()
    storage.listGates.push(async () => {
      listStarted.resolve()
      await releaseList.promise
    })
    const read = store.readDocument("slow-user", PRESET_ID)
    await listStarted.promise

    const invalid = store.writeDocument(
      "slow-user",
      PRESET_ID,
      -1,
      createEmptyBindingConsentDocument(),
    )
    await expect(invalid).rejects.toMatchObject<Partial<AtomicJsonStoreError>>({
      code: "REVISION_MISMATCH",
    })

    await Promise.resolve()
    expect(queueMap(store).size).toBe(0)
    storage.failRepeatedList = true
    const valid = store.writeDocument(
      "slow-user",
      PRESET_ID,
      expected(store, 0),
      createEmptyBindingConsentDocument(),
    )
    await Promise.resolve()
    const slowDirectory = buildBindingDocumentKey("slow-user", PRESET_ID).replace(/\/[^/]+$/, "")
    expect(storage.lists.filter((path) => path === slowDirectory)).toHaveLength(1)
    releaseList.resolve()
    const validResult = await valid
    expect(validResult).toMatchObject({ documentRevision: 1 })
    await expect(read).resolves.toMatchObject({ documentRevision: 0 })
    expect(storage.failRepeatedList).toBe(true)
  })

  it("does not delete an active atomic temp during a concurrent read", async () => {
    const storage = new MemoryStorage()
    const store = new AtomicJsonStore(storage, { nonceGenerator: nonceFactory("x", "a") })
    await store.initialize(HOST_A)

    const moveStarted = deferred()
    const releaseMove = deferred()
    storage.moveGates.push(async () => {
      moveStarted.resolve()
      await releaseMove.promise
    })
    const canonical = buildBindingDocumentKey("active-temp-user", PRESET_ID)
    const write = store.writeDocument(
      "active-temp-user",
      PRESET_ID,
      expected(store, 0),
      createEmptyBindingConsentDocument(),
    )
    await moveStarted.promise
    const canonicalProbe = deferred()
    storage.existsObserver = (path) => {
      if (path === canonical) canonicalProbe.resolve()
    }

    const read = store.readDocument("active-temp-user", PRESET_ID)
    await canonicalProbe.promise
    releaseMove.resolve()

    await expect(write).resolves.toMatchObject({ documentRevision: 1 })
    await expect(read).resolves.toMatchObject({ documentRevision: 0 })
    expect((await store.readDocument("active-temp-user", PRESET_ID)).documentRevision).toBe(1)
  })

  it("keeps a queued same-path tail attached while the prior operation settles", async () => {
    const storage = new MemoryStorage()
    const store = new AtomicJsonStore(storage, { nonceGenerator: nonceFactory("x", "a") })
    await store.initialize(HOST_A)

    const firstMoveStarted = deferred()
    const releaseFirstMove = deferred()
    storage.moveGates.push(async () => {
      firstMoveStarted.resolve()
      await releaseFirstMove.promise
    })

    const first = store.applyBindingIntent("queued-user", PRESET_ID, bindingIntent(CONNECTION_ID))
    await firstMoveStarted.promise

    const secondMoveStarted = deferred()
    const releaseSecondMove = deferred()
    storage.moveGates.push(async () => {
      secondMoveStarted.resolve()
      await releaseSecondMove.promise
    })

    const second = store.applyBindingIntent("queued-user", PRESET_ID, bindingIntent(OTHER_CONNECTION_ID))
    releaseFirstMove.resolve()
    await secondMoveStarted.promise

    const third = store.applyBindingIntent(
      "queued-user",
      PRESET_ID,
      bindingIntent(CONNECTION_ID),
      expected(store, 2),
    )
    releaseSecondMove.resolve()

    await expect(first).resolves.toMatchObject({ documentRevision: 1 })
    await expect(second).resolves.toMatchObject({ documentRevision: 2 })
    await expect(third).resolves.toMatchObject({ documentRevision: 3 })
    expect(queueMap(store).size).toBe(0)
    expect((await store.readDocument("queued-user", PRESET_ID)).documentRevision).toBe(3)
  })

  it("isolates users that submit identical preset and slot IDs", async () => {
    const storage = new MemoryStorage()
    const store = new AtomicJsonStore(storage, { nonceGenerator: nonceFactory("x", "a") })
    await store.initialize(HOST_A)
    const one = await store.applyBindingIntent("user-one", PRESET_ID, bindingIntent(CONNECTION_ID))
    const two = await store.applyBindingIntent("user-two", PRESET_ID, bindingIntent(OTHER_CONNECTION_ID))

    expect(one.bindings[buildBindingKey(PRESET_ID, SLOT_ID)]?.connectionId).toBe(CONNECTION_ID)
    expect(two.bindings[buildBindingKey(PRESET_ID, SLOT_ID)]?.connectionId).toBe(OTHER_CONNECTION_ID)
    expect(buildBindingDocumentKey("user-one", PRESET_ID)).not.toBe(
      buildBindingDocumentKey("user-two", PRESET_ID),
    )
  })
})
