// @ts-ignore Bun provides the test module at runtime; the extension bundle excludes this file.
import { describe, expect, it } from "bun:test"
import type { ConnectionDispatchDescriptorDTO } from "lumiverse-spindle-types"
import {
  ConsentError,
  ConsentService,
  type ConsentDisclosure,
} from "./consent"
import { AtomicJsonStore, type StorageAdapter } from "../state/atomic-json-store"
import type { BindingConsentDocument, DocumentWriteExpectation } from "../state/documents"

const HOST_ID = "11111111-1111-4111-8111-111111111111"
const USER_ID = "22222222-2222-4222-8222-222222222222"
const OTHER_USER_ID = "33333333-3333-4333-8333-333333333333"
const PRESET_ID = "44444444-4444-4444-8444-444444444444"
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

function descriptor(revision: string): ConnectionDispatchDescriptorDTO {
  return Object.freeze({
    connectionId: CONNECTION_ID,
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
    remember(service)

    await expect(service.grant({
      userId: USER_ID,
      disclosure: disclosure(),
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
