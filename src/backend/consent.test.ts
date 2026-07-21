// @ts-ignore Bun provides the test module at runtime; the extension bundle excludes this file.
import { describe, expect, it } from "bun:test"
import type { ConnectionDispatchDescriptorDTO } from "lumiverse-spindle-types"
import {
  ConsentError,
  ConsentService,
  type ConsentDisclosure,
} from "./consent"
import { AtomicJsonStore, type StorageAdapter } from "../state/atomic-json-store"
import { MAX_CONNECTION_SLOTS } from "../config/limits"
import { MAX_CONSENT_VIEWS } from "../protocol/messages"
import {
  buildBindingDocumentKey,
  buildBindingKey,
  buildConsentKey,
  type BindingConsentDocument,
  type DocumentWriteExpectation,
} from "../state/documents"

const HOST_ID = "11111111-1111-4111-8111-111111111111"
const USER_ID = "22222222-2222-4222-8222-222222222222"
const OTHER_USER_ID = "33333333-3333-4333-8333-333333333333"
const PRESET_ID = "44444444-4444-4444-8444-444444444444"
const OTHER_PRESET_ID = "88888888-8888-4888-8888-888888888888"
const ROTATED_HOST_ID = "99999999-9999-4999-8999-999999999999"
const THREAD_ID = "55555555-5555-4555-8555-555555555555"
const THREAD_B = "55555555-5555-4555-8555-555555555556"
const THREAD_C = "55555555-5555-4555-8555-555555555557"
const SLOT_ID = "66666666-6666-4666-8666-666666666666"
const CONNECTION_ID = "77777777-7777-4777-8777-777777777777"
const OTHER_SLOT_ID = "66666666-6666-4666-8666-666666666667"
const OTHER_CONNECTION_ID = "77777777-7777-4777-8777-777777777778"

class MemoryStorage implements StorageAdapter {
  readonly files = new Map<string, string>()

  async read(path: string): Promise<unknown> {
    return this.files.get(path) ?? null
  }

  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content)
  }

  async move(sourcePath: string, destinationPath: string): Promise<void> {
    const content = this.files.get(sourcePath)
    if (content === undefined) throw new Error("missing temporary file")
    this.files.delete(sourcePath)
    this.files.set(destinationPath, content)
  }

  async delete(path: string): Promise<void> {
    this.files.delete(path)
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path)
  }
}

class FailingReadStorage extends MemoryStorage {
  failReads = false

  override async read(path: string): Promise<unknown> {
    if (this.failReads) throw new Error("read failed")
    return super.read(path)
  }
  override async exists(path: string): Promise<boolean> {
    if (this.failReads) throw new Error("exists failed")
    return super.exists(path)
  }
}

type DeferredGate = Readonly<{
  started: Promise<void>
  markStarted: () => void
  release: () => void
  wait: Promise<void>
}>

function deferredGate(): DeferredGate {
  let resolveStarted: (() => void) | undefined
  let resolveWait: (() => void) | undefined
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve
  })
  const wait = new Promise<void>((resolve) => {
    resolveWait = resolve
  })
  return {
    started,
    markStarted: () => resolveStarted?.(),
    release: () => resolveWait?.(),
    wait,
  }
}

class DeferredConsentStore extends AtomicJsonStore {
  private readGate: DeferredGate | undefined
  private mutationGate: DeferredGate | undefined

  deferNextRead(): DeferredGate {
    const gate = deferredGate()
    this.readGate = gate
    return gate
  }

  deferNextConsentMutation(): DeferredGate {
    const gate = deferredGate()
    this.mutationGate = gate
    return gate
  }

  override async readLatest(userId: string, presetId: string) {
    const gate = this.readGate
    if (gate !== undefined) {
      this.readGate = undefined
      gate.markStarted()
      await gate.wait
    }
    return super.readLatest(userId, presetId)
  }

  override async writeDocument(
    userId: string,
    presetId: string,
    expected: DocumentWriteExpectation | number,
    nextDocument: BindingConsentDocument,
    expectedInstallId?: string,
    expectedNonce?: string,
  ) {
    const gate = this.mutationGate
    if (gate !== undefined) {
      this.mutationGate = undefined
      gate.markStarted()
      await gate.wait
    }
    return super.writeDocument(
      userId,
      presetId,
      expected,
      nextDocument,
      expectedInstallId,
      expectedNonce,
    )
  }
}

function descriptor(revision: string, connectionId = CONNECTION_ID): ConnectionDispatchDescriptorDTO {
  return Object.freeze({
    connectionId,
    connectionName: "Consent connection",
    provider: "openai",
    model: "model-a",
    endpointOrigin: "https://api.example.test",
    dispatchKind: "concrete",
    connectionDispatchRevision: revision,
  })
}

async function setup(options: Readonly<{
  store?: AtomicJsonStore
  now?: () => number
  pendingDisclosureCap?: number
  revokedSelectorCap?: number
  seedSlotBinding?: boolean
}> = {}) {
  const store = options.store ?? new AtomicJsonStore(new MemoryStorage(), { nonceGenerator: () => "a".repeat(32) })
  await store.initialize(HOST_ID)
  if (options.seedSlotBinding !== false) {
    const current = await store.readLatest(USER_ID, PRESET_ID)
    if (!Object.values(current.bindings).some((binding) => binding.slotId === SLOT_ID)) {
      await store.applyBindingIntent(USER_ID, PRESET_ID, {
        type: "bind",
        presetId: PRESET_ID,
        slotId: SLOT_ID,
        connectionSourceKey: `slot:${SLOT_ID}`,
        connectionId: CONNECTION_ID,
        dispatchRevision: "revision-a",
      })
    }
  }
  return {
    store,
    service: new ConsentService({
      store,
      now: options.now,
      pendingDisclosureCap: options.pendingDisclosureCap,
      revokedSelectorCap: options.revokedSelectorCap,
    }),
  }
}

function disclosure(revision = "revision-a", userId = USER_ID, threadId = THREAD_ID): ConsentDisclosure {
  return {
    userId,
    presetId: PRESET_ID,
    threadId,
    workspaceSource: "main-context",
    connectionSourceKey: `slot:${SLOT_ID}`,
    connectionId: CONNECTION_ID,
    descriptor: descriptor(revision),
  }
}
function mainDisclosure(threadId = THREAD_B): ConsentDisclosure {
  return {
    userId: USER_ID,
    presetId: PRESET_ID,
    threadId,
    workspaceSource: "main-context",
    connectionSourceKey: "main",
    connectionId: null,
    descriptor: descriptor("main-revision"),
  }
}


function generatedUuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`
}

function maxConsentDocument(): Record<string, unknown> {
  const maxConsents = MAX_CONSENT_VIEWS
  const sourceKeys: Array<"main" | `slot:${string}`> = [
    `slot:${SLOT_ID}`,
    "main",
    `slot:${OTHER_SLOT_ID}`,
    ...Array.from(
      { length: MAX_CONNECTION_SLOTS - 2 },
      (_, index) => `slot:${generatedUuid(0x400 + index)}` as `slot:${string}`,
    ),
  ]
  const consents: Record<string, unknown> = {}
  for (let index = 0; index < maxConsents; index += 1) {
    const sourceKey = sourceKeys[index % sourceKeys.length]!
    const threadIndex = Math.floor(index / sourceKeys.length)
    const threadId = threadIndex === 0 ? THREAD_ID : generatedUuid(0x500 + threadIndex)
    const consent = {
      installId: HOST_ID,
      nonce: "a".repeat(32),
      presetId: PRESET_ID,
      threadId,
      workspaceSource: "main-context" as const,
      connectionSourceKey: sourceKey,
      connectionId: sourceKey === "main" ? null : CONNECTION_ID,
      dispatchRevision: index === 0 ? "revision-a" : `revision-${index}`,
      disclosureVersion: 1,
    }
    consents[buildConsentKey(consent)] = consent
  }
  return {
    schemaVersion: 1,
    documentRevision: 5,
    bindings: {
      [buildBindingKey(PRESET_ID, SLOT_ID)]: {
        presetId: PRESET_ID,
        slotId: SLOT_ID,
        connectionSourceKey: `slot:${SLOT_ID}`,
        connectionId: CONNECTION_ID,
        dispatchRevision: "revision-b",
      },
    },
    consents,
  }
}

function remember(service: ConsentService, value = disclosure()) {

  return service.rememberDisclosure(value)
}
async function bindSlot(
  store: AtomicJsonStore,
  dispatchRevision: string,
  connectionId = CONNECTION_ID,
): Promise<void> {
  await store.applyBindingIntent(USER_ID, PRESET_ID, {
    type: "bind",
    presetId: PRESET_ID,
    slotId: SLOT_ID,
    connectionSourceKey: `slot:${SLOT_ID}`,
    connectionId,
    dispatchRevision,
  })
}

describe("ConsentService", () => {
  it("requires a current host disclosure before granting", async () => {
    const { service } = await setup()
    await expect(service.grant({ userId: USER_ID, disclosure: disclosure() }))
      .rejects.toMatchObject<Partial<ConsentError>>({ code: "MISSING_DISCLOSURE" })
  })
  it("rejects path-overlong user and preset identities as ConsentError", async () => {
    const { service } = await setup()
    for (const length of [257, 512]) {
      const overlong = "x".repeat(length)
      await expect(service.listConsents(overlong, PRESET_ID)).rejects.toMatchObject<
        Partial<ConsentError>
      >({ code: "INVALID_IDENTITY" })
      await expect(service.listConsents(USER_ID, overlong)).rejects.toMatchObject<
        Partial<ConsentError>
      >({ code: "INVALID_IDENTITY" })
      await expect(
        Promise.resolve().then(() => service.rememberDisclosure(disclosure("revision-a", overlong))),
      ).rejects.toMatchObject<Partial<ConsentError>>({ code: "INVALID_IDENTITY" })
    }
  })


  it("maps queued transaction read failures to ConsentError", async () => {
    const storage = new FailingReadStorage()
    const store = new AtomicJsonStore(storage, { nonceGenerator: () => "a".repeat(32) })
    const { service } = await setup({ store })
    storage.failReads = true
    await expect(service.revoke({
      userId: USER_ID,
      selector: {
        presetId: PRESET_ID,
        threadId: THREAD_ID,
        workspaceSource: "main-context",
        connectionSourceKey: `slot:${SLOT_ID}`,
        connectionId: CONNECTION_ID,
      },
    })).rejects.toMatchObject<Partial<ConsentError>>({ code: "STORAGE_FAILURE" })
  })

  it("supersedes an at-cap consent without exceeding the document bound", async () => {
    const storage = new MemoryStorage()
    const store = new AtomicJsonStore(storage, { nonceGenerator: () => "a".repeat(32) })
    await store.initialize(HOST_ID)
    const path = buildBindingDocumentKey(USER_ID, PRESET_ID)
    storage.files.set(
      path,
      JSON.stringify(maxConsentDocument()),
    )
    const service = new ConsentService({ store })
    const pending = remember(service, disclosure("revision-b"))

    const granted = await service.grant({ userId: USER_ID, disclosure: pending })

    expect(granted.consents).toHaveLength(MAX_CONSENT_VIEWS)
    expect(granted.consents.some((consent) => (
      consent.threadId === THREAD_ID &&
      consent.connectionSourceKey === `slot:${SLOT_ID}` &&
      consent.dispatchRevision === "revision-b"
    ))).toBe(true)
  })

  it("grants, lists, authorizes, and revokes an exact disclosure", async () => {
    const { service } = await setup()
    const granted = await service.grant({ userId: USER_ID, disclosure: remember(service) })
    expect(granted.consents).toHaveLength(1)
    expect(Object.isFrozen(granted)).toBe(true)
    expect(Object.isFrozen(granted.consents)).toBe(true)

    const authorized = await service.authorize({
      userId: USER_ID,
      presetId: PRESET_ID,
      threadId: THREAD_ID,
      workspaceSource: "main-context",
      connectionSourceKey: `slot:${SLOT_ID}`,
      connectionId: CONNECTION_ID,
      descriptor: descriptor("revision-a"),
    })
    expect(authorized.consent.dispatchRevision).toBe("revision-a")
    expect(authorized.descriptor?.connectionId).toBe(CONNECTION_ID)

    const revoked = await service.revoke({
      userId: USER_ID,
      selector: { presetId: PRESET_ID, threadId: THREAD_ID, connectionSourceKey: `slot:${SLOT_ID}` },
    })
    expect(revoked.consents).toHaveLength(0)
    await expect(service.authorize({
      userId: USER_ID,
      presetId: PRESET_ID,
      threadId: THREAD_ID,
      workspaceSource: "main-context",
      connectionSourceKey: `slot:${SLOT_ID}`,
      connectionId: CONNECTION_ID,
      descriptor: descriptor("revision-a"),
    })).rejects.toMatchObject<Partial<ConsentError>>({ code: "REVOKED_CONSENT" })
  })

  it("rejects duplicates, stale document revisions, and cross-user disclosures", async () => {
    const { service, store } = await setup()
    const first = await service.grant({ userId: USER_ID, disclosure: remember(service) })
    await expect(service.grant({ userId: USER_ID, disclosure: remember(service) })).rejects.toMatchObject<Partial<ConsentError>>({ code: "DUPLICATE_CONSENT" })
    const stale = remember(service, disclosure("revision-b"))
    await bindSlot(store, "revision-b")
    await expect(service.grant({
      userId: USER_ID,
      disclosure: stale,
      expectedDocumentRevision: 0,
    })).rejects.toMatchObject<Partial<ConsentError>>({ code: "STALE_DOCUMENT" })
    await expect(service.grant({ userId: OTHER_USER_ID, disclosure: disclosure() })).rejects.toMatchObject<Partial<ConsentError>>({ code: "WRONG_USER" })
    expect(first.documentRevision).toBe(2)
  })

  it("treats a changed dispatch revision as stale and never authorizes it", async () => {
    const { service } = await setup()
    await service.grant({ userId: USER_ID, disclosure: remember(service, disclosure("revision-a")) })
    await expect(service.authorize({
      userId: USER_ID,
      presetId: PRESET_ID,
      threadId: THREAD_ID,
      workspaceSource: "main-context",
      connectionSourceKey: `slot:${SLOT_ID}`,
      connectionId: CONNECTION_ID,
      descriptor: descriptor("revision-b"),
    })).rejects.toMatchObject<Partial<ConsentError>>({ code: "REVOKED_CONSENT" })
    expect(await service.status({
      userId: USER_ID,
      presetId: PRESET_ID,
      threadId: THREAD_ID,
      workspaceSource: "main-context",
      connectionSourceKey: `slot:${SLOT_ID}`,
      connectionId: CONNECTION_ID,
      descriptor: descriptor("revision-b"),
    })).toBe("revoked")
  })

  it("supports explicit selector approval from a pending host disclosure", async () => {
    const { service } = await setup()
    remember(service)
    await expect(service.approveBySelector(USER_ID, {
      presetId: PRESET_ID,
      threadId: THREAD_ID,
      workspaceSource: "main-context",
      connectionSourceKey: `slot:${SLOT_ID}`,
      dispatchRevision: "revision-b",
    })).rejects.toMatchObject<Partial<ConsentError>>({ code: "MISSING_DISCLOSURE" })
    const granted = await service.approveBySelector(USER_ID, {
      presetId: PRESET_ID,
      threadId: THREAD_ID,
      workspaceSource: "main-context",
      connectionSourceKey: `slot:${SLOT_ID}`,
    })
    expect(granted.consents[0]?.dispatchRevision).toBe("revision-a")
  })
  it("prunes superseded dispatch revisions and keeps hydration authoritative", async () => {
    const { service, store } = await setup()
    await service.grant({ userId: USER_ID, disclosure: remember(service, disclosure("revision-a")) })
    const revisions = ["revision-b", "revision-c", "revision-d", "revision-e"]
    for (const revision of revisions) {
      await bindSlot(store, revision)
      await service.grant({ userId: USER_ID, disclosure: remember(service, disclosure(revision)) })
      const listed = await service.listConsents(USER_ID, PRESET_ID)
      expect(listed.consents).toHaveLength(1)
      expect(listed.consents[0]?.dispatchRevision).toBe(revision)
    }
    await expect(service.authorize({
      userId: USER_ID,
      presetId: PRESET_ID,
      threadId: THREAD_ID,
      workspaceSource: "main-context",
      connectionSourceKey: `slot:${SLOT_ID}`,
      connectionId: CONNECTION_ID,
      descriptor: descriptor("revision-a"),
    })).rejects.toMatchObject<Partial<ConsentError>>({ code: "REVOKED_CONSENT" })
    const authorized = await service.authorize({
      userId: USER_ID,
      presetId: PRESET_ID,
      threadId: THREAD_ID,
      workspaceSource: "main-context",
      connectionSourceKey: `slot:${SLOT_ID}`,
      connectionId: CONNECTION_ID,
      descriptor: descriptor("revision-e"),
    })
    expect(authorized.consent.dispatchRevision).toBe("revision-e")
  })

  it("shares pending invalidation across services using one store", async () => {
    const store = new AtomicJsonStore(new MemoryStorage(), { nonceGenerator: () => "a".repeat(32) })
    const { service: first } = await setup({ store })
    const { service: second } = await setup({ store })
    await first.grant({ userId: USER_ID, disclosure: remember(first, disclosure("revision-a")) })
    const pending = second.rememberDisclosure(disclosure("revision-b"))
    const revokePromise = first.revoke({
      userId: USER_ID,
      selector: {
        presetId: PRESET_ID,
        threadId: THREAD_ID,
        workspaceSource: "main-context",
        connectionSourceKey: `slot:${SLOT_ID}`,
        connectionId: CONNECTION_ID,
      },
    })
    const grantPromise = second.grant({ userId: USER_ID, disclosure: pending })
    const revoked = await revokePromise
    expect(revoked.consents).toHaveLength(0)
    await expect(grantPromise).rejects.toMatchObject<Partial<ConsentError>>({ code: "MISSING_DISCLOSURE" })
    expect((await first.listConsents(USER_ID, PRESET_ID)).consents).toHaveLength(0)
  })

  it("linearizes an empty-document grant before a concurrent revoke", async () => {
    const store = new DeferredConsentStore(new MemoryStorage(), { nonceGenerator: () => "a".repeat(32) })
    const { service } = await setup({ store })
    const pending = remember(service)
    const gate = store.deferNextRead()
    const grantPromise = service.grant({ userId: USER_ID, disclosure: pending })
    await gate.started

    const revokePromise = service.revoke({
      userId: USER_ID,
      selector: {
        presetId: PRESET_ID,
        threadId: THREAD_ID,
        workspaceSource: "main-context",
        connectionSourceKey: `slot:${SLOT_ID}`,
        connectionId: CONNECTION_ID,
      },
    })
    gate.release()
    await grantPromise
    const revoked = await revokePromise
    expect(revoked.consents).toHaveLength(0)
    await expect(service.authorize({
      userId: USER_ID,
      presetId: PRESET_ID,
      threadId: THREAD_ID,
      workspaceSource: "main-context",
      connectionSourceKey: `slot:${SLOT_ID}`,
      connectionId: CONNECTION_ID,
      descriptor: descriptor("revision-a"),
    })).rejects.toMatchObject<Partial<ConsentError>>({ code: "REVOKED_CONSENT" })
  })

  it("linearizes an existing-consent update before a concurrent revoke", async () => {
    const store = new DeferredConsentStore(new MemoryStorage(), { nonceGenerator: () => "a".repeat(32) })
    const { service } = await setup({ store })
    await service.grant({ userId: USER_ID, disclosure: remember(service, disclosure("revision-a")) })
    const updated = remember(service, disclosure("revision-b"))
    await bindSlot(store, "revision-b")
    const gate = store.deferNextConsentMutation()
    const updatePromise = service.updateConsent({ userId: USER_ID, disclosure: updated })
    await gate.started

    const revokePromise = service.revoke({
      userId: USER_ID,
      selector: {
        presetId: PRESET_ID,
        threadId: THREAD_ID,
        workspaceSource: "main-context",
        connectionSourceKey: `slot:${SLOT_ID}`,
        connectionId: CONNECTION_ID,
      },
    })
    gate.release()
    await updatePromise
    const revoked = await revokePromise
    expect(revoked.consents).toHaveLength(0)
    await expect(service.authorize({
      userId: USER_ID,
      presetId: PRESET_ID,
      threadId: THREAD_ID,
      workspaceSource: "main-context",
      connectionSourceKey: `slot:${SLOT_ID}`,
      connectionId: CONNECTION_ID,
      descriptor: descriptor("revision-b"),
    })).rejects.toMatchObject<Partial<ConsentError>>({ code: "REVOKED_CONSENT" })
  })
  it("rejects a slot selector grant without a current binding and consumes the disclosure", async () => {
    const { service, store } = await setup({ seedSlotBinding: false })
    remember(service)

    await expect(service.approveBySelector(USER_ID, {
      presetId: PRESET_ID,
      threadId: THREAD_ID,
      workspaceSource: "main-context",
      connectionSourceKey: `slot:${SLOT_ID}`,
    }, 99)).rejects.toMatchObject<Partial<ConsentError>>({ code: "STALE_CONSENT" })

    expect(Object.keys((await store.readLatest(USER_ID, PRESET_ID)).consents)).toHaveLength(0)
    expect(service.resolveDisclosure(USER_ID, {
      presetId: PRESET_ID,
      threadId: THREAD_ID,
      workspaceSource: "main-context",
      connectionSourceKey: `slot:${SLOT_ID}`,
    })).toBeUndefined()
  })

  it("retains a slot disclosure across an unrelated document revision conflict", async () => {
    const { service, store } = await setup()
    const pending = remember(service)

    await expect(service.grant({
      userId: USER_ID,
      disclosure: pending,
      expectedDocumentRevision: 0,
    })).rejects.toMatchObject<Partial<ConsentError>>({ code: "STALE_DOCUMENT" })

    expect(Object.keys((await store.readLatest(USER_ID, PRESET_ID)).consents)).toHaveLength(0)
    expect(service.resolveDisclosure(USER_ID, {
      presetId: PRESET_ID,
      threadId: THREAD_ID,
      connectionSourceKey: `slot:${SLOT_ID}`,
    })).toBeDefined()
  })

  it("does not resurrect slot consent when unbind commits before selector approval", async () => {
    const store = new DeferredConsentStore(new MemoryStorage(), { nonceGenerator: () => "a".repeat(32) })
    const { service } = await setup({ store })
    remember(service)

    const gate = store.deferNextRead()
    const approval = service.approveBySelector(USER_ID, {
      presetId: PRESET_ID,
      threadId: THREAD_ID,
      workspaceSource: "main-context",
      connectionSourceKey: `slot:${SLOT_ID}`,
    })
    await gate.started

    await store.applyBindingIntent(USER_ID, PRESET_ID, {
      type: "unbind",
      presetId: PRESET_ID,
      slotId: SLOT_ID,
    })
    gate.release()

    await expect(approval).rejects.toMatchObject<Partial<ConsentError>>({ code: "STALE_CONSENT" })
    expect(Object.keys((await store.readLatest(USER_ID, PRESET_ID)).consents)).toHaveLength(0)
    expect(service.resolveDisclosure(USER_ID, {
      presetId: PRESET_ID,
      threadId: THREAD_ID,
      connectionSourceKey: `slot:${SLOT_ID}`,
    })).toBeUndefined()
  })

  it("does not persist slot consent when unbind commits after approval starts", async () => {
    const store = new DeferredConsentStore(new MemoryStorage(), { nonceGenerator: () => "a".repeat(32) })
    const { service } = await setup({ store })
    remember(service)

    const gate = store.deferNextConsentMutation()
    const approval = service.approveBySelector(USER_ID, {
      presetId: PRESET_ID,
      threadId: THREAD_ID,
      workspaceSource: "main-context",
      connectionSourceKey: `slot:${SLOT_ID}`,
    })
    await gate.started

    await store.applyBindingIntent(USER_ID, PRESET_ID, {
      type: "unbind",
      presetId: PRESET_ID,
      slotId: SLOT_ID,
    })
    gate.release()

    await expect(approval).rejects.toMatchObject<Partial<ConsentError>>({ code: "STALE_DOCUMENT" })
    expect(Object.keys((await store.readLatest(USER_ID, PRESET_ID)).consents)).toHaveLength(0)
    expect(service.resolveDisclosure(USER_ID, {
      presetId: PRESET_ID,
      threadId: THREAD_ID,
      connectionSourceKey: `slot:${SLOT_ID}`,
    })).toBeUndefined()
  })

  it("rejects stale or rebound slot disclosures without changing Main or unrelated bindings", async () => {
    for (const rebound of [
      { connectionId: OTHER_CONNECTION_ID, dispatchRevision: "revision-b" },
      { connectionId: CONNECTION_ID, dispatchRevision: "revision-b" },
    ]) {
      const { service, store } = await setup()
      await service.grant({ userId: USER_ID, disclosure: remember(service, mainDisclosure()) })
      await store.applyBindingIntent(USER_ID, PRESET_ID, {
        type: "bind",
        presetId: PRESET_ID,
        slotId: OTHER_SLOT_ID,
        connectionSourceKey: `slot:${OTHER_SLOT_ID}`,
        connectionId: OTHER_CONNECTION_ID,
        dispatchRevision: "unrelated-revision",
      })
      remember(service)
      await store.applyBindingIntent(USER_ID, PRESET_ID, {
        type: "bind",
        presetId: PRESET_ID,
        slotId: SLOT_ID,
        connectionSourceKey: `slot:${SLOT_ID}`,
        connectionId: rebound.connectionId,
        dispatchRevision: rebound.dispatchRevision,
      })

      await expect(service.approveBySelector(USER_ID, {
        presetId: PRESET_ID,
        threadId: THREAD_ID,
        workspaceSource: "main-context",
        connectionSourceKey: `slot:${SLOT_ID}`,
      })).rejects.toMatchObject<Partial<ConsentError>>({ code: "STALE_CONSENT" })

      const latest = await store.readLatest(USER_ID, PRESET_ID)
      expect(Object.values(latest.consents)).toHaveLength(1)
      expect(Object.values(latest.consents)[0]?.connectionSourceKey).toBe("main")
      expect(Object.values(latest.bindings).find((binding) => binding.slotId === OTHER_SLOT_ID)).toMatchObject({
        connectionId: OTHER_CONNECTION_ID,
        dispatchRevision: "unrelated-revision",
      })
      expect(service.resolveDisclosure(USER_ID, {
        presetId: PRESET_ID,
        threadId: THREAD_ID,
        connectionSourceKey: `slot:${SLOT_ID}`,
      })).toBeUndefined()
    }
  })


  it("rejects grant, saveConsent, and updateConsent across disclosure presets", async () => {
    const { service } = await setup()
    const pending = remember(service)
    const input = {
      userId: USER_ID,
      presetId: OTHER_PRESET_ID,
      disclosure: pending,
    }

    await expect(service.grant(input)).rejects.toMatchObject<Partial<ConsentError>>({ code: "WRONG_USER" })
    await expect(service.saveConsent(input)).rejects.toMatchObject<Partial<ConsentError>>({ code: "WRONG_USER" })
    await expect(service.updateConsent(input)).rejects.toMatchObject<Partial<ConsentError>>({ code: "WRONG_USER" })

    let presetReads = 0
    const queuedMismatch = {
      userId: USER_ID,
      disclosure: pending,
      get presetId(): string | undefined {
        presetReads += 1
        return presetReads === 1 ? undefined : OTHER_PRESET_ID
      },
    }
    await expect(service.grant(queuedMismatch)).rejects.toMatchObject<Partial<ConsentError>>({ code: "WRONG_USER" })
    expect(presetReads).toBe(2)

    expect(service.resolveDisclosure(USER_ID, {
      presetId: PRESET_ID,
      threadId: THREAD_ID,
      connectionSourceKey: `slot:${SLOT_ID}`,
    })).toBeDefined()
  })

  it("retains the revokeConsent instance alias", async () => {
    const { service } = await setup()
    await service.grant({ userId: USER_ID, disclosure: remember(service) })
    const revoked = await service.revokeConsent({
      userId: USER_ID,
      selector: {
        presetId: PRESET_ID,
        threadId: THREAD_ID,
        workspaceSource: "main-context",
        connectionSourceKey: `slot:${SLOT_ID}`,
        connectionId: CONNECTION_ID,
      },
    })
    expect(revoked.consents).toHaveLength(0)
  })

  it("atomically invalidates slot consent on A-to-B rebind while preserving Main approval", async () => {
    const { service, store } = await setup()
    await service.grant({ userId: USER_ID, disclosure: remember(service) })
    await service.grant({ userId: USER_ID, disclosure: remember(service, mainDisclosure()) })

    await store.applyBindingIntent(USER_ID, PRESET_ID, {
      type: "bind",
      presetId: PRESET_ID,
      slotId: OTHER_SLOT_ID,
      connectionSourceKey: `slot:${OTHER_SLOT_ID}`,
      connectionId: OTHER_CONNECTION_ID,
      dispatchRevision: "unrelated-revision",
    })
    const unrelated = {
      ...disclosure("unrelated-revision", USER_ID, THREAD_C),
      connectionSourceKey: `slot:${OTHER_SLOT_ID}` as `slot:${string}`,
      connectionId: OTHER_CONNECTION_ID,
      descriptor: descriptor("unrelated-revision", OTHER_CONNECTION_ID),
    }
    await service.grant({
      userId: USER_ID,
      disclosure: remember(service, unrelated),
    })

    await bindSlot(store, "revision-b", OTHER_CONNECTION_ID)

    const latest = await store.readLatest(USER_ID, PRESET_ID)
    expect(Object.values(latest.bindings).find((binding) => binding.slotId === SLOT_ID)).toMatchObject({
      connectionId: OTHER_CONNECTION_ID,
      dispatchRevision: "revision-b",
    })
    expect(Object.values(latest.consents)).toHaveLength(2)
    expect(Object.values(latest.consents).some((consent) => (
      consent.connectionSourceKey === `slot:${SLOT_ID}`
    ))).toBe(false)
    expect(Object.values(latest.consents).find((consent) => (
      consent.connectionSourceKey === `slot:${OTHER_SLOT_ID}`
    ))).toMatchObject({
      connectionId: OTHER_CONNECTION_ID,
      dispatchRevision: "unrelated-revision",
    })
    expect(Object.values(latest.consents).find((consent) => (
      consent.connectionSourceKey === "main"
    ))).toBeDefined()
    await expect(service.authorize({
      userId: USER_ID,
      presetId: PRESET_ID,
      threadId: THREAD_B,
      workspaceSource: "main-context",
      connectionSourceKey: "main",
      connectionId: null,
      descriptor: descriptor("main-revision"),
    })).resolves.toMatchObject({ consent: { connectionSourceKey: "main" } })
    await expect(service.authorize({
      userId: USER_ID,
      presetId: PRESET_ID,
      threadId: THREAD_ID,
      workspaceSource: "main-context",
      connectionSourceKey: `slot:${SLOT_ID}`,
      connectionId: CONNECTION_ID,
      descriptor: descriptor("revision-a"),
    })).rejects.toMatchObject<Partial<ConsentError>>({ code: "REVOKED_CONSENT" })
  })

  it("replaces install-scoped disclosure and revocation state after rotation", async () => {
    const store = new AtomicJsonStore(
      new MemoryStorage(),
      { nonceGenerator: () => "a".repeat(32) },
    )
    const { service } = await setup({ store })
    remember(service)
    const resolved = service.resolveDisclosure(USER_ID, {
      presetId: PRESET_ID,
      threadId: THREAD_ID,
      connectionSourceKey: `slot:${SLOT_ID}`,
    })
    if (resolved === undefined) throw new Error("expected a public disclosure")
    await service.revoke({
      userId: USER_ID,
      selector: {
        presetId: PRESET_ID,
        threadId: THREAD_B,
        workspaceSource: "main-context",
        connectionSourceKey: `slot:${SLOT_ID}`,
        connectionId: CONNECTION_ID,
        dispatchRevision: "revision-a",
      },
    })

    await store.initialize(ROTATED_HOST_ID)

    expect(service.resolveDisclosure(USER_ID, {
      presetId: PRESET_ID,
      threadId: THREAD_ID,
      connectionSourceKey: `slot:${SLOT_ID}`,
    })).toBeUndefined()
    remember(service)
    expect(service.resolveDisclosure(USER_ID, {
      presetId: PRESET_ID,
      threadId: THREAD_ID,
      connectionSourceKey: `slot:${SLOT_ID}`,
    })).toBeDefined()
    await expect(service.grant({ userId: USER_ID, disclosure: resolved }))
      .rejects.toMatchObject<Partial<ConsentError>>({ code: "INSTALL_MISMATCH" })
    const serialized = JSON.parse(JSON.stringify(resolved)) as ConsentDisclosure
    await expect(service.grant({ userId: USER_ID, disclosure: serialized }))
      .rejects.toMatchObject<Partial<ConsentError>>({ code: "MISSING_DISCLOSURE" })
    expect(await service.status({
      userId: USER_ID,
      presetId: PRESET_ID,
      threadId: THREAD_B,
      workspaceSource: "main-context",
      connectionSourceKey: `slot:${SLOT_ID}`,
      connectionId: CONNECTION_ID,
      descriptor: descriptor("revision-a"),
    })).toBe("required")
    expect((await service.listConsents(USER_ID, PRESET_ID)).consents).toHaveLength(0)
  })


  it("replaces the mutation queue epoch during install rotation", async () => {
    const store = new DeferredConsentStore(
      new MemoryStorage(),
      { nonceGenerator: () => "a".repeat(32) },
    )
    const { service } = await setup({ store })
    const pending = remember(service)
    const oldRead = store.deferNextRead()
    const staleGrant = service.grant({ userId: USER_ID, disclosure: pending })
    await oldRead.started

    await store.initialize(ROTATED_HOST_ID)

    const newRead = store.deferNextRead()
    const currentRevoke = service.revoke({
      userId: USER_ID,
      selector: {
        presetId: PRESET_ID,
        threadId: THREAD_B,
        workspaceSource: "main-context",
        connectionSourceKey: `slot:${SLOT_ID}`,
        connectionId: CONNECTION_ID,
        dispatchRevision: "revision-a",
      },
    })
    await newRead.started
    newRead.release()
    await expect(currentRevoke).resolves.toMatchObject({ installId: ROTATED_HOST_ID })

    oldRead.release()
    await expect(staleGrant).rejects.toMatchObject<Partial<ConsentError>>({ code: "INSTALL_MISMATCH" })
  })


  it("bounds and expires ephemeral disclosures and revocation markers fail-closed", async () => {
    let now = 0
    const { service } = await setup({
      now: () => now,
      pendingDisclosureCap: 2,
      revokedSelectorCap: 2,
    })
    remember(service, disclosure("revision-a", USER_ID, THREAD_ID))
    remember(service, disclosure("revision-a", USER_ID, THREAD_B))
    const latest = remember(service, disclosure("revision-a", USER_ID, THREAD_C))
    const pendingCandidates = [THREAD_ID, THREAD_B, THREAD_C]
      .map((threadId) => service.resolveDisclosure(USER_ID, { presetId: PRESET_ID, threadId }))
    expect(pendingCandidates.filter((candidate) => candidate !== undefined)).toHaveLength(2)
    expect(pendingCandidates[0]).toBeUndefined()
    expect(pendingCandidates[2]).toBeDefined()

    now = Number.MAX_SAFE_INTEGER
    expect(service.resolveDisclosure(USER_ID, { presetId: PRESET_ID, threadId: THREAD_C })).toBeUndefined()
    await expect(service.grant({ userId: USER_ID, disclosure: latest }))
      .rejects.toMatchObject<Partial<ConsentError>>({ code: "MISSING_DISCLOSURE" })

    now = 0
    for (const threadId of [THREAD_ID, THREAD_B, THREAD_C]) {
      await service.revoke({
        userId: USER_ID,
        selector: {
          presetId: PRESET_ID,
          threadId,
          workspaceSource: "main-context",
          connectionSourceKey: `slot:${SLOT_ID}`,
          connectionId: CONNECTION_ID,
          dispatchRevision: "revision-a",
        },
      })
    }
    const statusInput = (threadId: string) => ({
      userId: USER_ID,
      presetId: PRESET_ID,
      threadId,
      workspaceSource: "main-context" as const,
      connectionSourceKey: `slot:${SLOT_ID}` as const,
      connectionId: CONNECTION_ID,
      descriptor: descriptor("revision-a"),
    })
    const statuses = await Promise.all(
      [THREAD_ID, THREAD_B, THREAD_C].map((threadId) => service.status(statusInput(threadId))),
    )
    expect(statuses.filter((status) => status === "revoked")).toHaveLength(2)
    expect(statuses.filter((status) => status === "required")).toHaveLength(1)
    expect(statuses[0]).toBe("required")
    expect(statuses[2]).toBe("revoked")
  })

})
