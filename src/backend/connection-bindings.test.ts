// @ts-ignore Bun provides the test module at runtime; the extension bundle excludes this file.
import { describe, expect, it } from "bun:test"
import {
  ConnectionBindingError,
  ConnectionBindings,
  cloneDispatchDescriptor,
} from "./connection-bindings"
import type { ConnectionDispatchDescriptorDTO, ConnectionProfileDTO } from "lumiverse-spindle-types"
import { MAX_CONNECTION_SLOTS } from "../config/limits"
import { AtomicJsonStore, type StorageAdapter } from "../state/atomic-json-store"
import { buildBindingDocumentKey, buildBindingKey } from "../state/documents"

const HOST_ID = "11111111-1111-4111-8111-111111111111"
const USER_ID = "22222222-2222-4222-8222-222222222222"
const OTHER_USER_ID = "33333333-3333-4333-8333-333333333333"
const PRESET_ID = "44444444-4444-4444-8444-444444444444"
const SECOND_PRESET_ID = "99999999-9999-4999-8999-999999999999"
const SLOT_ID = "55555555-5555-4555-8555-555555555555"
const SECOND_SLOT_ID = "66666666-6666-4666-8666-666666666666"
const CONNECTION_ID = "77777777-7777-4777-8777-777777777777"
const SECOND_CONNECTION_ID = "88888888-8888-4888-8888-888888888888"

function generatedUuid(index: number): string {
  const token = index.toString(16).padStart(8, "0")
  return `${token}-0000-4000-8000-${token.padStart(12, "0")}`
}

const TEST_SLOT_IDS = Array.from(
  { length: MAX_CONNECTION_SLOTS + 2 },
  (_, index) => generatedUuid(0x100 + index),
)
const TEST_CONNECTION_IDS = Array.from(
  { length: MAX_CONNECTION_SLOTS + 2 },
  (_, index) => generatedUuid(0x200 + index),
)

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

type TestConnectionProfile = ConnectionProfileDTO & {
  ownerUserId?: string
  apiKey?: string
}

function profile(connectionId: string, owner = USER_ID): TestConnectionProfile {
  return {
    id: connectionId,
    name: "Bound connection",
    provider: "openai",
    api_url: "https://api.example.test/v1",
    model: "model-a",
    preset_id: null,
    is_default: false,
    has_api_key: true,
    metadata: { ownerUserId: owner },
    reasoning_bindings: null,
    created_at: 1,
    updated_at: 1,
    ownerUserId: owner,
  }
}

function descriptor(connectionId: string, revision: string): ConnectionDispatchDescriptorDTO {
  return Object.freeze({
    connectionId,
    connectionName: "Bound connection",
    provider: "openai",
    model: "model-a",
    endpointOrigin: "https://api.example.test",
    dispatchKind: "concrete",
    connectionDispatchRevision: revision,
  })
}

async function setup(
  requestUserId = USER_ID,
  connectionOwner = USER_ID,
  storage = new MemoryStorage(),
  listProfiles: TestConnectionProfile[] = [profile(CONNECTION_ID, connectionOwner)],
) {
  const store = new AtomicJsonStore(storage, { nonceGenerator: () => "a".repeat(32) })
  await store.initialize(HOST_ID)
  const descriptors = new Map<string, ConnectionDispatchDescriptorDTO>([
    [CONNECTION_ID, descriptor(CONNECTION_ID, "revision-a")],
    [SECOND_CONNECTION_ID, descriptor(SECOND_CONNECTION_ID, "revision-b")],
  ])
  for (const [index, connectionId] of TEST_CONNECTION_IDS.entries()) {
    descriptors.set(connectionId, descriptor(connectionId, `revision-test-${index}`))
  }
  const descriptorResolver = async (connectionId: string): Promise<ConnectionDispatchDescriptorDTO | null> => {
    if (requestUserId !== connectionOwner) return null
    return descriptors.get(connectionId) ?? null
  }
  const listUserIds: Array<string | undefined> = []
  const getUserIds: Array<string | undefined> = []

  const service = new ConnectionBindings({
    store,
    connections: {
      async get(connectionId: string, userId?: string) {
        getUserIds.push(userId)
        if (userId === undefined) throw new Error("operator-scoped get requires an authenticated user ID")
        if (requestUserId !== connectionOwner || userId !== requestUserId) return null
        if (descriptors.has(connectionId)) return profile(connectionId, connectionOwner)
        return null
      },

      async list(userId?: string) {
        listUserIds.push(userId)
        if (userId === undefined) throw new Error("operator-scoped list requires an authenticated user ID")
        if (requestUserId !== connectionOwner || userId !== requestUserId) return []
        return listProfiles
      },

      async resolveDispatch(connectionId) {
        return descriptorResolver(connectionId)
      },
    },
    descriptorResolver,
  })
  return {
    store,
    listUserIds,
    getUserIds,
    service,
    setDescriptor: (value: ConnectionDispatchDescriptorDTO | null) => {
      if (value === null) {
        descriptors.delete(CONNECTION_ID)
        return
      }
      descriptors.set(value.connectionId, value)
    },
  }
}

describe("ConnectionBindings", () => {
  it("binds, rebinds, lists, and unbinds with immutable snapshots", async () => {
    const { service } = await setup()
    const bound = await service.bindSlot({
      userId: USER_ID,
      presetId: PRESET_ID,
      slotId: SLOT_ID,
      connectionId: CONNECTION_ID,
      descriptor: descriptor(CONNECTION_ID, "revision-a"),
    })
    expect(bound.bindings).toHaveLength(1)
    expect(bound.bindings[0]?.connectionSourceKey).toBe(`slot:${SLOT_ID}`)
    expect(bound.descriptor).toMatchObject({
      connectionId: CONNECTION_ID,
      connectionName: "Bound connection",
      provider: "openai",
      model: "model-a",
      dispatchKind: "concrete",
      connectionDispatchRevision: "revision-a",
    })
    expect(Object.isFrozen(bound.descriptor)).toBe(true)
    expect(bound.descriptor).not.toHaveProperty("apiKey")
    expect(Object.isFrozen(bound)).toBe(true)
    expect(Object.isFrozen(bound.bindings)).toBe(true)

    const rebound = await service.rebindSlot({
      userId: USER_ID,
      presetId: PRESET_ID,
      slotId: SLOT_ID,
      connectionId: SECOND_CONNECTION_ID,
      descriptor: descriptor(SECOND_CONNECTION_ID, "revision-b"),
    })
    expect(rebound.bindings[0]?.connectionId).toBe(SECOND_CONNECTION_ID)

    const listed = await service.listBindings(USER_ID, PRESET_ID)
    expect(listed.bindings[0]?.connectionId).toBe(SECOND_CONNECTION_ID)
    const unbound = await service.unbindSlot({ userId: USER_ID, presetId: PRESET_ID, slotId: SLOT_ID })
    expect(unbound.bindings).toHaveLength(0)
  })

  it("forwards the authenticated user ID to the operator-scoped host list without mutating bindings", async () => {
    const { service, listUserIds } = await setup()
    const before = await service.listBindings(USER_ID, PRESET_ID)

    const listed = await service.listConnections(USER_ID)

    expect(listed).toHaveLength(1)
    expect(listUserIds).toEqual([USER_ID])
    expect(await service.listBindings(USER_ID, PRESET_ID)).toEqual(before)
  })

  it("forwards the authenticated user ID to owned lookups during binding and resolution", async () => {
    const { service, getUserIds } = await setup()

    await service.bindSlot({
      userId: USER_ID,
      presetId: PRESET_ID,
      slotId: SLOT_ID,
      connectionId: CONNECTION_ID,
      descriptor: descriptor(CONNECTION_ID, "revision-a"),
    })
    const resolved = await service.resolveSlot({
      userId: USER_ID,
      presetId: PRESET_ID,
      slotId: SLOT_ID,
    })

    expect(resolved.connectionId).toBe(CONNECTION_ID)
    expect(getUserIds).toEqual([USER_ID, USER_ID])
  })

  it("rejects invalid and callback-mismatched identities before granting connection ownership", async () => {
    const invalid = await setup()
    await expect(invalid.service.bindSlot({
      userId: "",
      presetId: PRESET_ID,
      slotId: SLOT_ID,
      connectionId: CONNECTION_ID,
    })).rejects.toMatchObject<Partial<ConnectionBindingError>>({ code: "INVALID_IDENTITY" })
    expect(invalid.getUserIds).toEqual([])

    const mismatched = await setup()
    await expect(mismatched.service.bindSlot({
      userId: OTHER_USER_ID,
      presetId: PRESET_ID,
      slotId: SLOT_ID,
      connectionId: CONNECTION_ID,
    })).rejects.toMatchObject<Partial<ConnectionBindingError>>({ code: "CONNECTION_NOT_FOUND" })
    expect(mismatched.getUserIds).toEqual([OTHER_USER_ID])
  })

  it("validates the authenticated user ID before invoking the host list", async () => {
    const { service, listUserIds } = await setup()

    await expect(service.listConnections("")).rejects.toMatchObject<Partial<ConnectionBindingError>>({
      code: "INVALID_IDENTITY",
    })
    expect(listUserIds).toEqual([])
  })

  it("filters mismatched owner hints fail-closed while projecting safe DTOs", async () => {
    const accepted = {
      ...profile(CONNECTION_ID, USER_ID),
      metadata: { ownerUserId: USER_ID, secret: "do-not-expose" },
      apiKey: "do-not-expose",
    }
    const mismatchedTopLevel = {
      ...profile(SECOND_CONNECTION_ID, OTHER_USER_ID),
      metadata: { ownerUserId: USER_ID },
    }
    const mismatchedMetadata = {
      ...profile(TEST_CONNECTION_IDS[0], USER_ID),
      metadata: { ownerUserId: OTHER_USER_ID },
    }
    const { service } = await setup(
      USER_ID,
      USER_ID,
      new MemoryStorage(),
      [accepted, mismatchedTopLevel, mismatchedMetadata],
    )

    const listed = await service.listConnections(USER_ID)
    const safe = listed[0]

    expect(listed.map((connection) => connection.id)).toEqual([CONNECTION_ID])
    expect(safe).toMatchObject({ id: CONNECTION_ID, metadata: {} })
    expect(safe).not.toHaveProperty("apiKey")
    expect(safe).not.toHaveProperty("ownerUserId")
    expect(Object.isFrozen(safe)).toBe(true)
    expect(Object.isFrozen(listed)).toBe(true)
  })

  it("rejects stale document revisions and duplicate destinations", async () => {
    const { service } = await setup()
    const first = await service.bindSlot({
      userId: USER_ID,
      presetId: PRESET_ID,
      slotId: SLOT_ID,
      connectionId: CONNECTION_ID,
      descriptor: descriptor(CONNECTION_ID, "revision-a"),
    })
    await expect(service.bindSlot({
      userId: USER_ID,
      presetId: PRESET_ID,
      slotId: SLOT_ID,
      connectionId: CONNECTION_ID,
      expectedDocumentRevision: first.documentRevision,
      descriptor: descriptor(CONNECTION_ID, "revision-a"),
    })).rejects.toMatchObject<Partial<ConnectionBindingError>>({ code: "DUPLICATE_BINDING" })

    await expect(service.bindSlot({
      userId: USER_ID,
      presetId: PRESET_ID,
      slotId: SECOND_SLOT_ID,
      connectionId: CONNECTION_ID,
      expectedDocumentRevision: 0,
      descriptor: descriptor(CONNECTION_ID, "revision-a"),
    })).rejects.toMatchObject<Partial<ConnectionBindingError>>({ code: "STALE_DOCUMENT" })
  })

  it("rejects a connection owned by another user", async () => {
    const { service } = await setup(OTHER_USER_ID)
    await expect(service.bindSlot({
      userId: OTHER_USER_ID,
      presetId: PRESET_ID,
      slotId: SLOT_ID,
      connectionId: CONNECTION_ID,
      descriptor: descriptor(CONNECTION_ID, "revision-a"),
    })).rejects.toMatchObject<Partial<ConnectionBindingError>>({ code: "CONNECTION_NOT_FOUND" })
  })

  it("rejects a binding when the host cannot resolve its concrete connection", async () => {
    const { service, setDescriptor } = await setup()
    setDescriptor(null)
    await expect(service.bindSlot({
      userId: USER_ID,
      presetId: PRESET_ID,
      slotId: SLOT_ID,
      connectionId: CONNECTION_ID,
      descriptor: descriptor(CONNECTION_ID, "revision-a"),
    })).rejects.toMatchObject<Partial<ConnectionBindingError>>({ code: "CONNECTION_NOT_FOUND" })
  })

  it("clones safe descriptor fields and rejects secrets, roulette, and stale revisions", async () => {
    const raw = { ...descriptor(CONNECTION_ID, "revision-a"), apiKey: "never-retain" }
    expect(() => cloneDispatchDescriptor(raw)).toThrow()
    const clone = cloneDispatchDescriptor(descriptor(CONNECTION_ID, "revision-a"))
    expect(Object.isFrozen(clone)).toBe(true)
    expect(clone).not.toHaveProperty("apiKey")
    expect(() => cloneDispatchDescriptor({ ...descriptor(CONNECTION_ID, "revision-a"), dispatchKind: "roulette" })).toThrow()

    const { service, setDescriptor } = await setup()
    await service.bindSlot({
      userId: USER_ID,
      presetId: PRESET_ID,
      slotId: SLOT_ID,
      connectionId: CONNECTION_ID,
      descriptor: descriptor(CONNECTION_ID, "revision-a"),
    })
    setDescriptor(descriptor(CONNECTION_ID, "revision-b"))
    await expect(service.resolveSlot({ userId: USER_ID, presetId: PRESET_ID, slotId: SLOT_ID })).rejects.toMatchObject<Partial<ConnectionBindingError>>({ code: "STALE_BINDING" })
  })

  it("rejects unsafe descriptor labels before committing", async () => {
    const { service, store, setDescriptor } = await setup()
    const before = await store.readLatest(USER_ID, PRESET_ID)
    setDescriptor({ ...descriptor(CONNECTION_ID, "revision-a"), connectionName: "" })
    await expect(service.bindSlot({
      userId: USER_ID,
      presetId: PRESET_ID,
      slotId: SLOT_ID,
      connectionId: CONNECTION_ID,
    })).rejects.toMatchObject<Partial<ConnectionBindingError>>({ code: "DESCRIPTOR_INVALID" })
    const after = await store.readLatest(USER_ID, PRESET_ID)
    expect(after).toEqual(before)
  })
  it("purges slot consents when unbinding while preserving unrelated consents", async () => {
    const { service, store } = await setup()
    await service.bindSlot({
      userId: USER_ID,
      presetId: PRESET_ID,
      slotId: SLOT_ID,
      connectionId: CONNECTION_ID,
    })
    const pair = store.getInstallPair()
    await store.applyConsentIntent(USER_ID, PRESET_ID, {
      type: "grant",
      consent: Object.freeze({
        installId: pair.extensionInstallationId,
        nonce: pair.installNonce,
        presetId: PRESET_ID,
        threadId: "main",
        workspaceSource: "main-context",
        connectionSourceKey: `slot:${SLOT_ID}`,
        connectionId: CONNECTION_ID,
        dispatchRevision: "revision-a",
        disclosureVersion: 1,
      } as const),
    })
    await store.applyConsentIntent(USER_ID, PRESET_ID, {
      type: "grant",
      consent: Object.freeze({
        installId: pair.extensionInstallationId,
        nonce: pair.installNonce,
        presetId: PRESET_ID,
        threadId: generatedUuid(0x300),
        workspaceSource: "main-context",
        connectionSourceKey: `slot:${SECOND_SLOT_ID}`,
        connectionId: SECOND_CONNECTION_ID,
        dispatchRevision: "revision-b",
        disclosureVersion: 1,
      } as const),
    })
    await store.applyConsentIntent(USER_ID, PRESET_ID, {
      type: "grant",
      consent: Object.freeze({
        installId: pair.extensionInstallationId,
        nonce: pair.installNonce,
        presetId: PRESET_ID,
        threadId: generatedUuid(0x301),
        workspaceSource: "main-context",
        connectionSourceKey: "main",
        connectionId: null,
        dispatchRevision: "revision-main",
        disclosureVersion: 1,
      } as const),
    })

    await service.unbindSlot({ userId: USER_ID, presetId: PRESET_ID, slotId: SLOT_ID })
    const document = await store.readLatest(USER_ID, PRESET_ID)
    expect(Object.values(document.consents)).toHaveLength(2)
    expect(Object.values(document.consents).some((consent) => consent.connectionSourceKey === `slot:${SLOT_ID}`)).toBe(false)
    expect(Object.values(document.consents).some((consent) => consent.connectionSourceKey === `slot:${SECOND_SLOT_ID}`)).toBe(true)
    expect(Object.values(document.consents).some((consent) => consent.connectionSourceKey === "main")).toBe(true)
  })

  it("rejects a seventeenth distinct binding without changing the document", async () => {
    const { service } = await setup()
    for (let index = 0; index < MAX_CONNECTION_SLOTS; index += 1) {
      await service.bindSlot({
        userId: USER_ID,
        presetId: PRESET_ID,
        slotId: TEST_SLOT_IDS[index]!,
        connectionId: TEST_CONNECTION_IDS[index]!,
      })
    }
    const before = await service.listBindings(USER_ID, PRESET_ID)
    await expect(service.bindSlot({
      userId: USER_ID,
      presetId: PRESET_ID,
      slotId: TEST_SLOT_IDS[MAX_CONNECTION_SLOTS]!,
      connectionId: TEST_CONNECTION_IDS[MAX_CONNECTION_SLOTS]!,
    })).rejects.toMatchObject<Partial<ConnectionBindingError>>({
      code: "SLOT_LIMIT",
      message: "Connection slot capacity is full",
    })
    const after = await service.listBindings(USER_ID, PRESET_ID)
    expect(after).toEqual(before)
    expect(after.bindings).toHaveLength(MAX_CONNECTION_SLOTS)
  })

  it("rejects a legacy over-cap document as corrupt without attempting repair", async () => {
    const storage = new MemoryStorage()
    const { service } = await setup(USER_ID, USER_ID, storage)
    const bindings = Object.fromEntries(
      Array.from({ length: MAX_CONNECTION_SLOTS + 1 }, (_, index) => {
        const slotId = TEST_SLOT_IDS[index]!
        const connectionId = TEST_CONNECTION_IDS[index]!
        return [
          buildBindingKey(PRESET_ID, slotId),
          {
            presetId: PRESET_ID,
            slotId,
            connectionSourceKey: `slot:${slotId}`,
            connectionId,
            dispatchRevision: `revision-test-${index}`,
          },
        ]
      }),
    )
    const path = buildBindingDocumentKey(USER_ID, PRESET_ID)
    const raw = JSON.stringify({
      schemaVersion: 1,
      documentRevision: MAX_CONNECTION_SLOTS + 1,
      bindings,
      consents: {},
    })
    storage.files.set(path, raw)

    await expect(service.listBindings(USER_ID, PRESET_ID)).rejects.toMatchObject({ code: "CORRUPT_DOCUMENT" })
    await expect(service.rebindSlot({
      userId: USER_ID,
      presetId: PRESET_ID,
      slotId: TEST_SLOT_IDS[0]!,
      connectionId: SECOND_CONNECTION_ID,
    })).rejects.toMatchObject({ code: "CORRUPT_DOCUMENT" })
    await expect(service.unbindSlot({
      userId: USER_ID,
      presetId: PRESET_ID,
      slotId: TEST_SLOT_IDS[0]!,
    })).rejects.toMatchObject({ code: "CORRUPT_DOCUMENT" })
    expect(storage.files.get(path)).toBe(raw)
  })

  it("allows rebinding an existing slot at capacity", async () => {
    const { service } = await setup()
    for (let index = 0; index < MAX_CONNECTION_SLOTS; index += 1) {
      await service.bindSlot({
        userId: USER_ID,
        presetId: PRESET_ID,
        slotId: TEST_SLOT_IDS[index]!,
        connectionId: TEST_CONNECTION_IDS[index]!,
      })
    }
    const rebound = await service.rebindSlot({
      userId: USER_ID,
      presetId: PRESET_ID,
      slotId: TEST_SLOT_IDS[0]!,
      connectionId: SECOND_CONNECTION_ID,
    })
    expect(rebound.bindings).toHaveLength(MAX_CONNECTION_SLOTS)
    expect(rebound.bindings.find((binding) => binding.slotId === TEST_SLOT_IDS[0])?.connectionId).toBe(SECOND_CONNECTION_ID)
  })

  it("frees capacity after unbinding before a new bind", async () => {
    const { service } = await setup()
    for (let index = 0; index < MAX_CONNECTION_SLOTS; index += 1) {
      await service.bindSlot({
        userId: USER_ID,
        presetId: PRESET_ID,
        slotId: TEST_SLOT_IDS[index]!,
        connectionId: TEST_CONNECTION_IDS[index]!,
      })
    }
    await service.unbindSlot({ userId: USER_ID, presetId: PRESET_ID, slotId: TEST_SLOT_IDS[0]! })
    const rebound = await service.bindSlot({
      userId: USER_ID,
      presetId: PRESET_ID,
      slotId: TEST_SLOT_IDS[MAX_CONNECTION_SLOTS]!,
      connectionId: TEST_CONNECTION_IDS[MAX_CONNECTION_SLOTS]!,
    })
    expect(rebound.bindings).toHaveLength(MAX_CONNECTION_SLOTS)
    expect(rebound.bindings.some((binding) => binding.slotId === TEST_SLOT_IDS[0])).toBe(false)
    expect(rebound.bindings.some((binding) => binding.slotId === TEST_SLOT_IDS[MAX_CONNECTION_SLOTS])).toBe(true)
  })

  it("serializes concurrent new binds so capacity admits exactly one", async () => {
    const { service } = await setup()
    for (let index = 0; index < MAX_CONNECTION_SLOTS - 1; index += 1) {
      await service.bindSlot({
        userId: USER_ID,
        presetId: PRESET_ID,
        slotId: TEST_SLOT_IDS[index]!,
        connectionId: TEST_CONNECTION_IDS[index]!,
      })
    }
    const results = await Promise.allSettled([
      service.bindSlot({
        userId: USER_ID,
        presetId: PRESET_ID,
        slotId: TEST_SLOT_IDS[MAX_CONNECTION_SLOTS - 1]!,
        connectionId: TEST_CONNECTION_IDS[MAX_CONNECTION_SLOTS - 1]!,
      }),
      service.bindSlot({
        userId: USER_ID,
        presetId: PRESET_ID,
        slotId: TEST_SLOT_IDS[MAX_CONNECTION_SLOTS]!,
        connectionId: TEST_CONNECTION_IDS[MAX_CONNECTION_SLOTS]!,
      }),
    ])
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    const rejected = results.find((result) => result.status === "rejected")
    expect(rejected?.status).toBe("rejected")
    if (rejected?.status === "rejected") {
      expect(rejected.reason).toMatchObject<Partial<ConnectionBindingError>>({ code: "SLOT_LIMIT" })
    }
    expect((await service.listBindings(USER_ID, PRESET_ID)).bindings).toHaveLength(MAX_CONNECTION_SLOTS)
  })

  it("keeps slot capacity independent for each user and preset", async () => {
    const storage = new MemoryStorage()
    const { service: userService } = await setup(USER_ID, USER_ID, storage)
    const { service: otherUserService } = await setup(OTHER_USER_ID, OTHER_USER_ID, storage)
    for (let index = 0; index < MAX_CONNECTION_SLOTS; index += 1) {
      await userService.bindSlot({
        userId: USER_ID,
        presetId: PRESET_ID,
        slotId: TEST_SLOT_IDS[index]!,
        connectionId: TEST_CONNECTION_IDS[index]!,
      })
    }
    await expect(userService.bindSlot({
      userId: USER_ID,
      presetId: PRESET_ID,
      slotId: TEST_SLOT_IDS[MAX_CONNECTION_SLOTS]!,
      connectionId: TEST_CONNECTION_IDS[MAX_CONNECTION_SLOTS]!,
    })).rejects.toMatchObject<Partial<ConnectionBindingError>>({ code: "SLOT_LIMIT" })
    await expect(userService.bindSlot({
      userId: USER_ID,
      presetId: SECOND_PRESET_ID,
      slotId: SLOT_ID,
      connectionId: CONNECTION_ID,
    })).resolves.toMatchObject({ bindings: expect.any(Array) })

    for (let index = 0; index < MAX_CONNECTION_SLOTS; index += 1) {
      await otherUserService.bindSlot({
        userId: OTHER_USER_ID,
        presetId: PRESET_ID,
        slotId: TEST_SLOT_IDS[index]!,
        connectionId: TEST_CONNECTION_IDS[index]!,
      })
    }
    await expect(otherUserService.bindSlot({
      userId: OTHER_USER_ID,
      presetId: PRESET_ID,
      slotId: TEST_SLOT_IDS[MAX_CONNECTION_SLOTS]!,
      connectionId: TEST_CONNECTION_IDS[MAX_CONNECTION_SLOTS]!,
    })).rejects.toMatchObject<Partial<ConnectionBindingError>>({ code: "SLOT_LIMIT" })
    expect((await userService.listBindings(USER_ID, SECOND_PRESET_ID)).bindings).toHaveLength(1)
    expect((await otherUserService.listBindings(OTHER_USER_ID, PRESET_ID)).bindings).toHaveLength(MAX_CONNECTION_SLOTS)
  })
})
