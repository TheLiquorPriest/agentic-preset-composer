// @ts-ignore Bun provides the test module at runtime; the extension bundle excludes this file.
import { describe, expect, test } from "bun:test"
import {
  createBackendEndpointRouter,
  MAX_ENDPOINT_SEQUENCE_LEDGERS,
  type BackendEndpointDependencies,
  type BackendEndpointRouter,
  type BackendBindingService,
  type BackendConsentService,
  type BackendExecutionService,
  type BackendViewResponseRequest,
  type BackendViewResponseService,
} from "./endpoints"
import type {
  BackendActivityResponse,
  BackendResponse,
} from "../protocol/messages"
import {
  decodeBackendResponse,
  MAX_CONNECTIONS,
  MAX_BINDING_VIEWS,
  MAX_CONSENT_VIEWS,
} from "../protocol/messages"
import type { BindingSnapshot, HostDispatchDescriptor, ResolvedDispatchBinding } from "./connection-bindings"
import type { ConsentDisclosure, ConsentSelector as ServiceConsentSelector, ConsentSnapshot } from "./consent"
import { AdmissionRegistry } from "../runtime/admission"
import { TraceStore } from "../runtime/trace-store"
import { MAX_TRACE_BYTES, TRACE_PREVIEW_BYTES, utf8Bytes } from "../config/limits"
import { serializedUtf8Bytes } from "../config/plain-json"

const INSTALL_ID = "550e8400-e29b-41d4-a716-446655440000"
const INSTALL_NONCE = "0123456789abcdef0123456789abcdef"
const PRESET_ID = "7ba7b810-9dad-41d1-80b4-00c04fd430c8"
const SLOT_ID = "8ba7b810-9dad-41d1-80b4-00c04fd430c8"
const CONNECTION_ID = "9ba7b810-9dad-41d1-80b4-00c04fd430c8"
const THREAD_ID = "aba7b810-9dad-41d1-80b4-00c04fd430c8"
const EXECUTION_ID = "bba7b810-9dad-41d1-80b4-00c04fd430c8"
const TRACE_ID = "cba7b810-9dad-41d1-80b4-00c04fd430c8"
const CORRELATION_ID = "dba7b810-9dad-41d1-80b4-00c04fd430c8"

function intent(type: string, payload: Record<string, unknown>, correlationId = CORRELATION_ID): unknown {
  return { version: 1, type, correlationId, payload }
}

function bindingDescriptor(connectionId = CONNECTION_ID): HostDispatchDescriptor {
  return {
    connectionId,
    connectionName: "Main connection",
    provider: "openai",
    model: "model-a",
    endpointOrigin: "https://api.example.test",
    dispatchKind: "concrete",
    connectionDispatchRevision: "dispatch-revision-a",
  }
}

function bindingSnapshot(
  userId: string,
  presetId: string,
  slotId: string,
  bound: boolean,
  connectionId = CONNECTION_ID,
  descriptor: HostDispatchDescriptor | undefined = bound ? bindingDescriptor(connectionId) : undefined,
): BindingSnapshot {
  return {
    userId,
    presetId,
    installId: INSTALL_ID,
    installNonce: INSTALL_NONCE,
    documentRevision: 1,
    bindings: bound
      ? [{
          presetId,
          slotId,
          connectionSourceKey: `slot:${slotId}`,
          connectionId,
          dispatchRevision: "dispatch-revision-a",
        }]
      : [],
    ...(descriptor === undefined ? {} : { descriptor }),
  }
}

function resolvedBinding(overrides: Partial<ResolvedDispatchBinding> = {}): ResolvedDispatchBinding {
  return {
    userId: "user-a",
    presetId: PRESET_ID,
    slotId: SLOT_ID,
    installId: INSTALL_ID,
    installNonce: INSTALL_NONCE,
    connectionSourceKey: `slot:${SLOT_ID}`,
    connectionId: CONNECTION_ID,
    dispatchRevision: "dispatch-revision-a",
    descriptor: {
      connectionId: CONNECTION_ID,
      connectionName: "Main connection",
      provider: "openai",
      model: "model-a",
      endpointOrigin: "https://api.example.test",
      dispatchKind: "concrete",
      connectionDispatchRevision: "dispatch-revision-a",
    },
    ...overrides,
  }
}

type TestConnectionProfile = {
  id: string
  name: string
  provider: string
  api_url: string
  model: string
  preset_id: null
  is_default: boolean
  has_api_key: boolean
  metadata: { ownerUserId: string; apiKey: string }
  reasoning_bindings: null
  created_at: number
  updated_at: number
}
function connectionProfile(userId: string): TestConnectionProfile {
  return {
    id: CONNECTION_ID,
    name: "Main connection",
    provider: "openai",
    api_url: "https://api.example.test/v1",
    model: "model-a",
    preset_id: null,
    is_default: false,
    has_api_key: true,
    metadata: { ownerUserId: userId, apiKey: "do-not-expose" },
    reasoning_bindings: null,
    created_at: 1,
    updated_at: 1,
  }
}
function consentSnapshot(
  userId: string,
  presetId: string,
  selector: {
    threadId: string
    workspaceSource?: "native-blocks" | "main-context"
    connectionSourceKey?: "main" | `slot:${string}`
  },
  approved: boolean,
  dispatchRevision = "dispatch-revision-a",
): ConsentSnapshot {
  return {
    userId,
    presetId,
    installId: INSTALL_ID,
    installNonce: INSTALL_NONCE,
    documentRevision: approved ? 1 : 2,
    consents: approved
      ? [{
          installId: INSTALL_ID,
          nonce: INSTALL_NONCE,
          presetId,
          threadId: selector.threadId,
          workspaceSource: selector.workspaceSource ?? "main-context",
          connectionSourceKey: selector.connectionSourceKey ?? "main",
          connectionId: selector.connectionSourceKey?.startsWith("slot:") ? CONNECTION_ID : null,
          dispatchRevision,
          disclosureVersion: 1,
        }]
      : [],
  }
}

function createFixture(options: {
  readonly bindError?: string
  readonly bindSnapshot?: unknown
  readonly unbindSnapshot?: unknown
  readonly listConnectionsFailure?: Error
  readonly listConnectionsGate?: Promise<void>
  readonly cancelAccepted?: boolean
  readonly consumeDisclosureAfterApproval?: boolean
  readonly initialConsent?: boolean
  readonly consentDispatchRevision?: string
  readonly consentSnapshotOverride?: ConsentSnapshot
  readonly disclosureOverride?: Partial<ConsentDisclosure>
  readonly startWithoutDisclosure?: boolean
  readonly bindingSnapshot?: BindingSnapshot
  readonly resolveSlot?: BackendBindingService["resolveSlot"]
  readonly currentExecution?: BackendExecutionService["currentExecution"]
  readonly onAuthorizedMutation?: BackendEndpointDependencies["onAuthorizedMutation"]
  readonly viewResponse?: BackendViewResponseService["viewDeliveredResponse"]
  readonly connectionProfiles?: readonly TestConnectionProfile[]
} = {}): {
  readonly router: BackendEndpointRouter
  readonly traces: TraceStore
  readonly admission: AdmissionRegistry
  readonly calls: { users: string[]; binds: number; unbinds: number }
  readonly sent: Array<{ response: BackendResponse; userId: string }>
} {
  const admission = new AdmissionRegistry()
  const traces = new TraceStore(admission)
  const calls = { users: [] as string[], binds: 0, unbinds: 0 }
  const sent: Array<{ response: BackendResponse; userId: string }> = []
  let disclosureAvailable = !options.startWithoutDisclosure
  const state = {
    getInstallPair: () => ({ extensionInstallationId: INSTALL_ID, installNonce: INSTALL_NONCE }),
  }
  const bindings: BackendBindingService = {
    bindSlot: async input => {
      calls.users.push(input.userId)
      calls.binds += 1
      if (input.userId !== "user-a") throw { code: "CONNECTION_NOT_FOUND" }
      if (options.bindError !== undefined) throw { code: options.bindError }
      return (options.bindSnapshot ?? bindingSnapshot(input.userId, input.presetId, input.slotId, true, input.connectionId)) as BindingSnapshot
    },
    unbindSlot: async input => {
      calls.users.push(input.userId)
      calls.unbinds += 1
      return (options.unbindSnapshot ?? bindingSnapshot(input.userId, input.presetId, input.slotId, false)) as BindingSnapshot
    },
    listBindings: async (userId, presetId) => {
      calls.users.push(userId)
      return options.bindingSnapshot ?? bindingSnapshot(userId, presetId, SLOT_ID, true)
    },
    listConnections: async userId => {
      calls.users.push(userId)
      if (options.listConnectionsFailure !== undefined) throw options.listConnectionsFailure
      if (options.listConnectionsGate !== undefined) await options.listConnectionsGate
      return options.connectionProfiles ?? (userId === "user-a" ? [connectionProfile(userId)] : [])
    },
    ...(options.resolveSlot === undefined ? {} : { resolveSlot: options.resolveSlot }),
  }
  const consent: BackendConsentService = {
    approveBySelector: async (userId: string, selector: ServiceConsentSelector) => {
      const result = consentSnapshot(userId, selector.presetId, selector, true)
      if (options.consumeDisclosureAfterApproval) disclosureAvailable = false
      return result
    },
    revoke: async (input: { userId: string; selector: ServiceConsentSelector }) =>
      consentSnapshot(input.userId, input.selector.presetId, input.selector, false),
    listConsents: async (userId, presetId) => {
      if (options.consentSnapshotOverride !== undefined) return options.consentSnapshotOverride
      return consentSnapshot(
        userId,
        presetId,
        { threadId: THREAD_ID },
        options.initialConsent ?? true,
        options.consentDispatchRevision,
      )
    },
    resolveDisclosure: (userId, selector) => {
      if (!disclosureAvailable) return undefined
      return {
        userId,
        presetId: selector.presetId,
        threadId: selector.threadId,
        workspaceSource: selector.workspaceSource ?? "main-context",
        connectionSourceKey: selector.connectionSourceKey ?? "main",
        connectionId: selector.connectionSourceKey?.startsWith("slot:") ? CONNECTION_ID : null,
        descriptor: {
          connectionId: CONNECTION_ID,
          connectionName: "Main connection",
          provider: "openai",
          model: "model-a",
          endpointOrigin: "https://api.example.test",
          dispatchKind: "concrete",
          connectionDispatchRevision: "dispatch-revision-a",
        },
        disclosureVersion: 1,
        ...(options.disclosureOverride ?? {}),
      } as ConsentDisclosure
    },
    rememberDisclosure: (disclosure: ConsentDisclosure) => {
      disclosureAvailable = true
      return {
        ...disclosure,
        disclosureVersion: disclosure.disclosureVersion ?? 1,
      }
    },
  }
  const deps: BackendEndpointDependencies = {
    state,
    bindings,
    consent,
    traces,
    admission,
    execution: {
      cancel: async request => ({
        accepted: options.cancelAccepted ?? true,
        presetId: request.presetId,
        executionId: request.executionId,
        traceId: TRACE_ID,
        kind: "execution",
      }),
      currentExecution: (userId, presetId) => options.currentExecution?.(userId, presetId),
    },
    viewResponse: {
      viewDeliveredResponse: async request => {
        if (options.viewResponse !== undefined) await options.viewResponse(request)
      },
    },
    sendToFrontend: (response, userId) => {
      sent.push({ response, userId })
    },
    onAuthorizedMutation: options.onAuthorizedMutation,
  }
  return { router: createBackendEndpointRouter(deps), traces, admission, calls, sent }
}

function errorCode(response: BackendResponse): string {
  if (response.type !== "error") throw new Error("expected backend error")
  return response.payload.code
}

describe("backend endpoint router", () => {
  test("binds a slot and returns only human-reviewable destination fields", async () => {
    const { router, calls } = createFixture()
    const response = await router.handle(
      { userId: "user-a" },
      intent("bind_slot", { presetId: PRESET_ID, slotId: SLOT_ID, patch: { connectionId: CONNECTION_ID } }),
    )
    expect(response.type).toBe("binding")
    if (response.type !== "binding") return
    expect(response.payload).toEqual({
      presetId: PRESET_ID,
      slotId: SLOT_ID,
      bound: true,
      status: "bound",
      descriptor: { label: "Main connection", provider: "openai", model: "model-a" },
    })
    expect(response.payload).not.toHaveProperty("dispatchRevision")
    expect(response.payload).not.toHaveProperty("connectionId")
    expect(calls.users).toEqual(["user-a"])
  })

  test("returns the normalized activity payload only after successful delivery", () => {
    const { router, sent } = createFixture()
    const input = {
      correlationId: CORRELATION_ID,
      executionId: EXECUTION_ID,
      presetId: PRESET_ID,
      kind: "execution",
      phase: "progress" as const,
      terminal: false,
      traceId: TRACE_ID,
      remainingBudgetMs: 10_000,
    }
    const payload = router.emitActivity("user-a", input)
    expect(payload).toEqual({
      executionId: EXECUTION_ID,
      presetId: PRESET_ID,
      kind: "execution",
      phase: "progress",
      terminal: false,
      traceId: TRACE_ID,
      remainingBudgetMs: 10_000,
    })
    expect(sent[0]?.response).toMatchObject({ type: "activity", payload })
    router.dispose()
    expect(router.emitActivity("user-a", input)).toBeUndefined()
  })
  test("routes the opaque delivered-response intent through the authenticated user scope", async () => {
    const seen: BackendViewResponseRequest[] = []
    const { router } = createFixture({
      viewResponse: async request => {
        seen.push(request)
        if (request.userId !== "user-a") throw { code: "APC_VIEW_RESPONSE_UNAVAILABLE" }
      },
    })
    const response = await router.handle(
      { userId: "user-a" },
      intent("view_response", { presetId: PRESET_ID, executionId: EXECUTION_ID }),
    )
    expect(response).toMatchObject({
      type: "view_response",
      payload: { presetId: PRESET_ID, executionId: EXECUTION_ID },
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      userId: "user-a",
      presetId: PRESET_ID,
      executionId: EXECUTION_ID,
      install: { extensionInstallationId: INSTALL_ID, installNonce: INSTALL_NONCE },
    })
    const forged = await router.handle(
      { userId: "user-b" },
      intent("view_response", { presetId: PRESET_ID, executionId: EXECUTION_ID }),
    )
    expect(errorCode(forged)).toBe("APC_VIEW_RESPONSE_UNAVAILABLE")
  })
  test("returns missing status after unbinding a slot", async () => {
    const { router } = createFixture()
    const response = await router.handle(
      { userId: "user-a" },
      intent("unbind_slot", { presetId: PRESET_ID, slotId: SLOT_ID }),
    )
    expect(response.type).toBe("binding")
    if (response.type !== "binding") return
    expect(response.payload).toMatchObject({
      presetId: PRESET_ID,
      slotId: SLOT_ID,
      bound: false,
      status: "missing",
    })
  })

  test("projects a committed bind from its host descriptor without retrying a failed connection list", async () => {
    const { router, calls } = createFixture({ listConnectionsFailure: new Error("connection was deleted") })
    const response = await router.handle(
      { userId: "user-a" },
      intent("bind_slot", { presetId: PRESET_ID, slotId: SLOT_ID, patch: { connectionId: CONNECTION_ID } }),
    )
    expect(response.type).toBe("binding")
    if (response.type !== "binding") return
    expect(response.payload).toMatchObject({
      presetId: PRESET_ID,
      slotId: SLOT_ID,
      bound: true,
      status: "bound",
      descriptor: { label: "Main connection", provider: "openai", model: "model-a" },
    })
    expect(calls.binds).toBe(1)
    expect(calls.users).toEqual(["user-a"])
  })

  test("projects an unbind as missing without consulting the host connection list", async () => {
    const { router, calls } = createFixture({ listConnectionsFailure: new Error("connection list unavailable") })
    const response = await router.handle(
      { userId: "user-a" },
      intent("unbind_slot", { presetId: PRESET_ID, slotId: SLOT_ID }),
    )
    expect(response.type).toBe("binding")
    if (response.type !== "binding") return
    expect(response.payload).toMatchObject({ presetId: PRESET_ID, slotId: SLOT_ID, bound: false, status: "missing" })
    expect(calls.unbinds).toBe(1)
    expect(calls.users).toEqual(["user-a"])
  })

  test("fails closed for an over-cap committed bind snapshot", async () => {
    const base = bindingSnapshot("user-a", PRESET_ID, SLOT_ID, true)
    const snapshot = {
      ...base,
      bindings: Array.from({ length: MAX_BINDING_VIEWS + 1 }, () => base.bindings[0]),
    }
    const { router, calls } = createFixture({ bindSnapshot: snapshot })
    const response = await router.handle(
      { userId: "user-a" },
      intent("bind_slot", { presetId: PRESET_ID, slotId: SLOT_ID, patch: { connectionId: CONNECTION_ID } }),
    )
    expect(errorCode(response)).toBe("APC_BINDING_INVALID")
    expect(calls.binds).toBe(1)
  })

  test("fails closed for duplicate identities in a committed bind snapshot", async () => {
    const base = bindingSnapshot("user-a", PRESET_ID, SLOT_ID, true)
    const snapshot = { ...base, bindings: [base.bindings[0], base.bindings[0]] }
    const { router, calls } = createFixture({ bindSnapshot: snapshot })
    const response = await router.handle(
      { userId: "user-a" },
      intent("bind_slot", { presetId: PRESET_ID, slotId: SLOT_ID, patch: { connectionId: CONNECTION_ID } }),
    )
    expect(errorCode(response)).toBe("APC_BINDING_INVALID")
    expect(calls.binds).toBe(1)
  })

  test("fails closed when a committed bind snapshot targets a different connection", async () => {
    const { router, calls } = createFixture({ bindSnapshot: bindingSnapshot("user-a", PRESET_ID, SLOT_ID, true) })
    const response = await router.handle(
      { userId: "user-a" },
      intent("bind_slot", { presetId: PRESET_ID, slotId: SLOT_ID, patch: { connectionId: "aba7b810-9dad-41d1-80b4-00c04fd430c8" } }),
    )
    expect(errorCode(response)).toBe("APC_BINDING_INVALID")
    expect(calls.binds).toBe(1)
  })

  test("fails closed when a committed bind descriptor is malformed", async () => {
    const base = bindingSnapshot("user-a", PRESET_ID, SLOT_ID, true)
    const snapshot = {
      ...base,
      descriptor: { ...base.descriptor!, endpointOrigin: "" },
    }
    const { router, calls } = createFixture({ bindSnapshot: snapshot })
    const response = await router.handle(
      { userId: "user-a" },
      intent("bind_slot", { presetId: PRESET_ID, slotId: SLOT_ID, patch: { connectionId: CONNECTION_ID } }),
    )
    expect(errorCode(response)).toBe("APC_BINDING_INVALID")
    expect(calls.binds).toBe(1)
  })

  test("keeps the consumed disclosure for an approved consent response", async () => {
    const { router } = createFixture({ consumeDisclosureAfterApproval: true })
    const response = await router.handle(
      { userId: "user-a" },
      intent("approve_consent", {
        presetId: PRESET_ID,
        threadId: THREAD_ID,
        workspaceSource: "main-context",
        connectionSourceKey: "main",
      }),
    )
    expect(response.type).toBe("consent")
    if (response.type !== "consent") return
    expect(response.payload.status).toBe("approved")
    expect(response.payload.destination).toEqual({ label: "Main connection", provider: "openai", model: "model-a" })
    expect(response.payload.disclosure).toBeDefined()
  })

  test("resolves a first-use slot disclosure before approval", async () => {
    const { router } = createFixture({
      startWithoutDisclosure: true,
      initialConsent: false,
      resolveSlot: async () => resolvedBinding(),
    })
    const selector = {
      presetId: PRESET_ID,
      threadId: THREAD_ID,
      workspaceSource: "native-blocks",
      connectionSourceKey: `slot:${SLOT_ID}`,
    }
    const required = await router.handle({ userId: "user-a" }, intent("resolve_consent", selector))
    expect(required.type).toBe("consent")
    if (required.type !== "consent") return
    expect(required.payload.status).toBe("required")
    expect(required.payload.destination).toEqual({ label: "Main connection", provider: "openai", model: "model-a" })
    expect(required.payload.disclosure?.categories).toEqual([
      "thread",
      "workspace",
      "source",
      "destination",
      "provider",
      "model",
      "input-bindings",
      "prior-stage-outputs",
      "prompt-variable-values",
    ])
    expect(required.payload.disclosure).toBeDefined()
    expect(() => decodeBackendResponse(required)).not.toThrow()
    expect(JSON.stringify(required)).not.toContain(CONNECTION_ID)
    expect(JSON.stringify(required)).not.toContain("promptVariableValues")
    const approved = await router.handle({ userId: "user-a" }, intent("approve_consent", selector))
    expect(approved.type).toBe("consent")
    if (approved.type === "consent") expect(approved.payload.status).toBe("approved")
  })

  test("keeps required hydration disclosures safe when stored consent is stale", async () => {
    const { router } = createFixture({ consentDispatchRevision: "stale-dispatch" })
    const response = await router.handle(
      { userId: "user-a" },
      intent("hydrate_preset", { presetId: PRESET_ID }),
    )
    expect(response.type).toBe("hydration")
    if (response.type !== "hydration") return
    expect(response.payload.consents[0]).toMatchObject({
      status: "required",
      destination: { label: "Main connection", provider: "openai", model: "model-a" },
      disclosure: { version: 1 },
    })
  })

  test("preserves the binding service receiver while resolving persisted slots", async () => {
    let receiverChecks = 0
    const fixture = createFixture({
      startWithoutDisclosure: true,
      initialConsent: false,
      resolveSlot: async function (this: BackendBindingService) {
        if (typeof this.listBindings !== "function") throw new Error("binding service receiver was lost")
        receiverChecks += 1
        return resolvedBinding()
      },
    })
    const hydration = await fixture.router.handle(
      { userId: "user-a" },
      intent("hydrate_preset", { presetId: PRESET_ID }),
    )
    expect(hydration.type).toBe("hydration")
    if (hydration.type !== "hydration") return
    expect(hydration.payload.bindings[0]).toMatchObject({
      slotId: SLOT_ID,
      bound: true,
      status: "bound",
    })
    const consent = await fixture.router.handle(
      { userId: "user-a" },
      intent("resolve_consent", {
        presetId: PRESET_ID,
        threadId: THREAD_ID,
        workspaceSource: "native-blocks",
        connectionSourceKey: `slot:${SLOT_ID}`,
      }),
    )
    expect(consent.type).toBe("consent")
    if (consent.type !== "consent") return
    expect(consent.payload.destination).toEqual({
      label: "Main connection",
      provider: "openai",
      model: "model-a",
    })
    expect(receiverChecks).toBe(2)
  })

  test("hydrates only the current execution for the exact authenticated user and preset", async () => {
    const activity: BackendActivityResponse["payload"] = {
      executionId: EXECUTION_ID,
      presetId: PRESET_ID,
      kind: "stage",
      phase: "progress",
      terminal: false,
      traceId: TRACE_ID,
      stageIndex: 1,
      stageCount: 2,
      runIndex: 1,
      runCount: 2,
      completedRuns: 1,
      totalRuns: 2,
      remainingBudgetMs: 10_000,
    }
    const queries: Array<readonly [string, string]> = []
    const fixture = createFixture({
      currentExecution: (userId, presetId) => {
        queries.push([userId, presetId])
        return userId === "user-a" && presetId === PRESET_ID ? activity : undefined
      },
    })
    const active = await fixture.router.handle({ userId: "user-a" }, intent("hydrate_preset", { presetId: PRESET_ID }))
    expect(active.type).toBe("hydration")
    if (active.type !== "hydration") return
    expect(active.payload.execution).toEqual(activity)

    const otherUser = await fixture.router.handle({ userId: "user-b" }, intent("hydrate_preset", { presetId: PRESET_ID }))
    expect(otherUser.type).toBe("hydration")
    if (otherUser.type !== "hydration") return
    expect(otherUser.payload.execution).toBeUndefined()

    const otherPreset = await fixture.router.handle({ userId: "user-a" }, intent("hydrate_preset", { presetId: TRACE_ID }))
    expect(otherPreset.type).toBe("hydration")
    if (otherPreset.type !== "hydration") return
    expect(otherPreset.payload.execution).toBeUndefined()
    expect(queries).toEqual([
      ["user-a", PRESET_ID],
      ["user-b", PRESET_ID],
      ["user-a", TRACE_ID],
    ])
  })

  test("keeps host profiles and consent views above slot capacity while rejecting each independent cap", async () => {
    const profileIds = Array.from({ length: MAX_CONNECTIONS + 1 }, (_, index) => `${index.toString(16).padStart(8, "0")}-e29b-41d4-a716-446655440000`)
    const profiles = profileIds.slice(0, 17).map((id, index) => ({
      ...connectionProfile("user-a"),
      id,
      name: `Connection ${index}`,
    }))
    const base = consentSnapshot("user-a", PRESET_ID, { threadId: THREAD_ID }, true)
    const record = base.consents[0]
    if (record === undefined) return
    const consentIds = Array.from({ length: MAX_CONSENT_VIEWS + 1 }, (_, index) => `${index.toString(16).padStart(8, "0")}-d29b-41d4-a716-446655440000`)
    const valid = createFixture({
      connectionProfiles: profiles,
      consentSnapshotOverride: {
        ...base,
        consents: consentIds.slice(0, 17).map(threadId => ({ ...record, threadId })),
      },
    })
    const connections = await valid.router.handle({ userId: "user-a" }, intent("list_connections", {}))
    expect(connections.type).toBe("connections")
    if (connections.type !== "connections") return
    expect(connections.payload.connections).toHaveLength(17)
    const hydration = await valid.router.handle({ userId: "user-a" }, intent("hydrate_preset", { presetId: PRESET_ID }))
    expect(hydration.type).toBe("hydration")
    if (hydration.type !== "hydration") return
    expect(hydration.payload.consents).toHaveLength(17)

    const tooManyProfiles = createFixture({
      connectionProfiles: profileIds.map((id, index) => ({ ...connectionProfile("user-a"), id, name: `Connection ${index}` })),
    })
    const profileError = await tooManyProfiles.router.handle({ userId: "user-a" }, intent("list_connections", {}))
    expect(errorCode(profileError)).toBe("APC_CONNECTIONS_INVALID")

    const tooManyConsents = createFixture({
      consentSnapshotOverride: {
        ...base,
        consents: consentIds.map(threadId => ({ ...record, threadId })),
      },
    })
    const consentError = await tooManyConsents.router.handle({ userId: "user-a" }, intent("hydrate_preset", { presetId: PRESET_ID }))
    expect(errorCode(consentError)).toBe("APC_CONSENT_INVALID")
  })

  test("rejects cross-scope and malformed consent snapshots without leaking host fields", async () => {
    const base = consentSnapshot("user-a", PRESET_ID, { threadId: THREAD_ID }, true)
    const wrongUser = createFixture({
      consentSnapshotOverride: { ...base, userId: "user-b" },
    })
    const wrongUserResponse = await wrongUser.router.dispatchAndSend(
      { userId: "user-a" },
      intent("hydrate_preset", { presetId: PRESET_ID }),
    )
    expect(errorCode(wrongUserResponse)).toBe("APC_SCOPE_MISMATCH")
    expect(JSON.stringify(wrongUserResponse)).not.toContain("user-b")

    const wrongNonce = createFixture({
      consentSnapshotOverride: {
        ...base,
        consents: base.consents.map(record => ({ ...record, nonce: "bad-consent-nonce" })),
      },
    })
    const wrongNonceResponse = await wrongNonce.router.dispatchAndSend(
      { userId: "user-a" },
      intent("hydrate_preset", { presetId: PRESET_ID }),
    )
    expect(errorCode(wrongNonceResponse)).toBe("APC_SCOPE_MISMATCH")
    expect(JSON.stringify(wrongNonceResponse)).not.toContain("bad-consent-nonce")

    const wrongThread = createFixture({
      consentSnapshotOverride: {
        ...base,
        consents: base.consents.map(record => ({ ...record, threadId: "thread-label" })),
      },
    })
    const wrongThreadResponse = await wrongThread.router.dispatchAndSend(
      { userId: "user-a" },
      intent("hydrate_preset", { presetId: PRESET_ID }),
    )
    expect(errorCode(wrongThreadResponse)).toBe("APC_CONSENT_INVALID")
    expect(JSON.stringify(wrongThreadResponse)).not.toContain("thread-label")
  })

  test("rejects cross-scope and mismatched consent disclosures without leaking host fields", async () => {
    const selector = {
      presetId: PRESET_ID,
      threadId: THREAD_ID,
      workspaceSource: "main-context",
      connectionSourceKey: "main",
    }
    const wrongUser = createFixture({ disclosureOverride: { userId: "user-b" } })
    const wrongUserResponse = await wrongUser.router.dispatchAndSend(
      { userId: "user-a" },
      intent("resolve_consent", selector),
    )
    expect(errorCode(wrongUserResponse)).toBe("APC_SCOPE_MISMATCH")
    expect(JSON.stringify(wrongUserResponse)).not.toContain("user-b")

    const wrongConnection = createFixture({ disclosureOverride: { connectionId: CONNECTION_ID } })
    const wrongConnectionResponse = await wrongConnection.router.dispatchAndSend(
      { userId: "user-a" },
      intent("resolve_consent", selector),
    )
    expect(errorCode(wrongConnectionResponse)).toBe("APC_CONSENT_INVALID")
    expect(JSON.stringify(wrongConnectionResponse)).not.toContain(CONNECTION_ID)

    const wrongVersion = createFixture({ disclosureOverride: { disclosureVersion: 1_000_001 } })
    const wrongVersionResponse = await wrongVersion.router.dispatchAndSend(
      { userId: "user-a" },
      intent("resolve_consent", selector),
    )
    expect(errorCode(wrongVersionResponse)).toBe("APC_CONSENT_INVALID")
    expect(JSON.stringify(wrongVersionResponse)).not.toContain("1000001")
  })

  test("does not authorize a slot when its resolver is unavailable", async () => {
    const { router } = createFixture({
      startWithoutDisclosure: true,
      initialConsent: false,
      resolveSlot: async () => null as never,
    })
    const selector = {
      presetId: PRESET_ID,
      threadId: THREAD_ID,
      workspaceSource: "main-context",
      connectionSourceKey: `slot:${SLOT_ID}`,
    }
    const required = await router.handle({ userId: "user-a" }, intent("resolve_consent", selector))
    expect(required.type).toBe("consent")
    if (required.type === "consent") {
      expect(required.payload.status).toBe("required")
      expect(required.payload.destination).toBeUndefined()
      expect(required.payload.disclosure).toBeUndefined()
    }
    const approval = await router.handle({ userId: "user-a" }, intent("approve_consent", selector))
    expect(errorCode(approval)).toBe("APC_CONSENT_REQUIRED")
  })

  test("sanitizes resolver and snapshot scope failures", async () => {
    const resolverFailure = createFixture({
      resolveSlot: async () => { throw { code: "WRONG_USER" } },
    })
    const resolverResponse = await resolverFailure.router.handle(
      { userId: "user-a" },
      intent("hydrate_preset", { presetId: PRESET_ID }),
    )
    expect(errorCode(resolverResponse)).toBe("APC_SCOPE_MISMATCH")

    const resolvedIdentityFailure = createFixture({
      resolveSlot: async () => resolvedBinding({ userId: "user-b" }),
    })
    const resolvedIdentityResponse = await resolvedIdentityFailure.router.handle(
      { userId: "user-a" },
      intent("hydrate_preset", { presetId: PRESET_ID }),
    )
    expect(errorCode(resolvedIdentityResponse)).toBe("APC_SCOPE_MISMATCH")

    const snapshotFailure = createFixture({
      bindingSnapshot: bindingSnapshot("user-b", PRESET_ID, SLOT_ID, true),
    })
    const snapshotResponse = await snapshotFailure.router.handle(
      { userId: "user-a" },
      intent("hydrate_preset", { presetId: PRESET_ID }),
    )
    expect(errorCode(snapshotResponse)).toBe("APC_SCOPE_MISMATCH")
  })

  test("returns and sends sanitized errors without dispatching invalid scopes", async () => {
    const { router, calls, sent } = createFixture()
    const invalidScope = await router.dispatchAndSend(
      { userId: "" },
      intent("list_connections", {}),
    )
    expect(errorCode(invalidScope)).toBe("APC_SCOPE_INVALID")
    expect(calls.users).toHaveLength(0)
    expect(sent).toHaveLength(0)

    const malformed = await router.dispatchAndSend(
      { userId: "user-a" },
      intent("list_connections", { secret: "do-not-return" }),
    )
    expect(errorCode(malformed)).toBe("APC_PROTOCOL_DECODE_ERROR")
    expect(sent).toHaveLength(1)
    expect(sent[0]?.userId).toBe("user-a")
    expect(JSON.stringify(sent[0]?.response)).not.toContain("do-not-return")
  })


  test("rejects malformed payloads before a service call", async () => {
    const { router, calls } = createFixture()
    const response = await router.handle(
      { userId: "user-a" },
      intent("bind_slot", { presetId: PRESET_ID, slotId: SLOT_ID, patch: { connectionId: "not-a-uuid" } }),
    )
    expect(errorCode(response)).toBe("APC_PROTOCOL_DECODE_ERROR")
    expect(calls.users).toHaveLength(0)
  })

  test("lists safe connection summaries in the authenticated user scope", async () => {
    const { router, calls } = createFixture()
    const response = await router.handle(
      { userId: "user-a" },
      intent("list_connections", {}),
    )
    expect(response.type).toBe("connections")
    if (response.type !== "connections") return
    expect(response.payload.connections).toEqual([{
      id: CONNECTION_ID,
      name: "Main connection",
      provider: "openai",
      model: "model-a",
    }])
    expect(response.payload.connections[0]).not.toHaveProperty("api_url")
    expect(response.payload.connections[0]).not.toHaveProperty("metadata")
    expect(calls.users).toEqual(["user-a"])

    const privateResponse = await router.handle(
      { userId: "user-b" },
      intent("list_connections", {}),
    )
    expect(privateResponse.type).toBe("connections")
    if (privateResponse.type === "connections") expect(privateResponse.payload.connections).toHaveLength(0)
    expect(calls.users).toEqual(["user-a", "user-b"])
  })

  test("hydrates existing bindings and consents as safe human-reviewable projections", async () => {
    const { router } = createFixture()
    const response = await router.handle(
      { userId: "user-a" },
      intent("hydrate_preset", { presetId: PRESET_ID }),
    )
    expect(response.type).toBe("hydration")
    if (response.type !== "hydration") return
    expect(response.payload.bindings).toEqual([{
      slotId: SLOT_ID,
      bound: true,
      status: "bound",
      descriptor: { label: "Main connection", provider: "openai", model: "model-a" },
    }])
    expect(response.payload.consents[0]).toMatchObject({
      threadId: THREAD_ID,
      workspaceSource: "main-context",
      connectionSourceKey: "main",
      status: "approved",
      destination: { label: "Main connection", provider: "openai", model: "model-a" },
      disclosure: { version: 1 },
    })
    expect(response.payload.consents[0]).not.toHaveProperty("presetId")
    expect(() => decodeBackendResponse(response)).not.toThrow()
    expect(response.payload.consents[0]?.disclosure?.categories).toEqual([
      "thread",
      "workspace",
      "source",
      "destination",
      "provider",
      "model",
      "main-context",
      "input-bindings",
      "prior-stage-outputs",
    ])
    expect(JSON.stringify(response)).not.toContain("dispatchRevision")
    expect(JSON.stringify(response)).not.toContain("installNonce")
    expect(JSON.stringify(response)).not.toContain("userId")
  })

  test("preserves user isolation for bindings and traces", async () => {
    const { router, traces } = createFixture()
    const acquired = traces.acquire("user-a", PRESET_ID, EXECUTION_ID, { traceId: TRACE_ID, startedAt: 1 })
    expect(acquired.accepted).toBe(true)
    const response = await router.handle(
      { userId: "user-b" },
      intent("list_traces", { presetId: PRESET_ID }),
    )
    if (response.type !== "trace") return
    if (!("traces" in response.payload)) return
    expect(response.payload.traces).toHaveLength(0)

    const binding = await router.handle(
      { userId: "user-b" },
      intent("bind_slot", { presetId: PRESET_ID, slotId: SLOT_ID, patch: { connectionId: CONNECTION_ID } }),
    )
    expect(errorCode(binding)).toBe("APC_CONNECTION_NOT_FOUND")
  })

  test("maps a stale binding revision to a bounded retryable error", async () => {
    const { router } = createFixture({ bindError: "STALE_DOCUMENT" })
    const response = await router.handle(
      { userId: "user-a" },
      intent("bind_slot", { presetId: PRESET_ID, slotId: SLOT_ID, patch: { connectionId: CONNECTION_ID } }),
    )
    expect(errorCode(response)).toBe("APC_STALE_REVISION")
    if (response.type === "error") expect(response.payload.retryable).toBe(true)
  })

  test("maps binding slot capacity to a stable non-retryable admission error", async () => {
    const { router } = createFixture({ bindError: "SLOT_LIMIT" })
    const response = await router.handle(
      { userId: "user-a" },
      intent("bind_slot", { presetId: PRESET_ID, slotId: SLOT_ID, patch: { connectionId: CONNECTION_ID } }),
    )
    expect(errorCode(response)).toBe("APC_ADMISSION_CONFLICT")
    if (response.type === "error") {
      expect(response.payload.retryable).toBe(false)
      expect(response.payload).not.toHaveProperty("details")
    }
  })

  test("runs the authority mutation callback again after a failed binding mutation", async () => {
    const bumps: Array<readonly [string, string]> = []
    const { router } = createFixture({
      bindError: "STALE_DOCUMENT",
      onAuthorizedMutation: (userId, presetId) => bumps.push([userId, presetId]),
    })
    const response = await router.handle(
      { userId: "user-a" },
      intent("bind_slot", { presetId: PRESET_ID, slotId: SLOT_ID, patch: { connectionId: CONNECTION_ID } }),
    )
    expect(errorCode(response)).toBe("APC_STALE_REVISION")
    expect(bumps).toEqual([
      ["user-a", PRESET_ID],
      ["user-a", PRESET_ID],
    ])
  })

  test("approves, resolves, and revokes consent through the authenticated scope", async () => {
    const { router } = createFixture()
    const selector = { presetId: PRESET_ID, threadId: THREAD_ID, workspaceSource: "main-context", connectionSourceKey: "main" }
    const approved = await router.handle({ userId: "user-a" }, intent("approve_consent", selector))
    expect(approved.type).toBe("consent")
    if (approved.type === "consent") {
      expect(approved.payload.status).toBe("approved")
      expect(approved.payload.destination).toEqual({ label: "Main connection", provider: "openai", model: "model-a" })
      expect(approved.payload.disclosure?.categories).toContain("destination")
      expect(approved.payload).not.toHaveProperty("dispatchRevision")
    }
    const resolved = await router.handle({ userId: "user-a" }, intent("resolve_consent", selector))
    expect(resolved.type).toBe("consent")
    if (resolved.type === "consent") expect(resolved.payload.status).toBe("approved")
    const revoked = await router.handle({ userId: "user-a" }, intent("revoke_consent", selector))
    expect(revoked.type).toBe("consent")
    if (revoked.type === "consent") expect(revoked.payload.status).toBe("revoked")
  })

  test("returns an already-terminal cancellation acknowledgement without emitting activity", async () => {
    const { router, traces } = createFixture({ cancelAccepted: false })
    const acquired = traces.acquire("user-a", PRESET_ID, EXECUTION_ID, { traceId: TRACE_ID, startedAt: 1 })
    expect(acquired.accepted).toBe(true)
    const response = await router.handle(
      { userId: "user-a" },
      intent("cancel_execution", { presetId: PRESET_ID, executionId: EXECUTION_ID, reason: "stop" }),
    )
    expect(response.type).toBe("cancellation")
    if (response.type === "cancellation") {
      expect(response.payload.accepted).toBe(false)
      expect(response.payload.status).toBe("already-terminal")
      expect(response.payload.cancellationSource).toBe("stop")
    }
  })

  test("returns a bounded cancellation acknowledgement while runtime owns terminal activity", async () => {
    const { router, traces } = createFixture()
    const acquired = traces.acquire("user-a", PRESET_ID, EXECUTION_ID, { traceId: TRACE_ID, startedAt: 1 })
    expect(acquired.accepted).toBe(true)
    const response = await router.handle(
      { userId: "user-a" },
      intent("cancel_execution", { presetId: PRESET_ID, executionId: EXECUTION_ID, reason: "user" }),
    )
    expect(response.type).toBe("cancellation")
    if (response.type === "cancellation") {
      expect(response.payload.accepted).toBe(true)
      expect(response.payload.status).toBe("accepted")
      expect(response.payload).not.toHaveProperty("traceId")
      expect(response.payload).not.toHaveProperty("kind")
    }
  })

  test("truncates private trace detail and never returns another user's trace", async () => {
    const { router, traces } = createFixture()
    const acquired = traces.acquire("user-a", PRESET_ID, EXECUTION_ID, { traceId: TRACE_ID, startedAt: 1 })
    expect(acquired.accepted).toBe(true)
    traces.append("user-a", PRESET_ID, EXECUTION_ID, {
      sequence: 0,
      kind: "provider",
      preview: "x".repeat(TRACE_PREVIEW_BYTES * 8),
    })
    const response = await router.handle(
      { userId: "user-a" },
      intent("get_trace", { presetId: PRESET_ID, executionId: EXECUTION_ID, traceId: TRACE_ID }),
    )
    expect(response.type).toBe("trace")
    if (response.type !== "trace" || !("trace" in response.payload)) return
    const detail = response.payload.trace
    expect(detail.events[0]?.preview?.length).toBeLessThanOrEqual(TRACE_PREVIEW_BYTES)
    const size = serializedUtf8Bytes(response.payload)
    expect(size.ok).toBe(true)
    if (size.ok) expect(size.bytes).toBeLessThanOrEqual(MAX_TRACE_BYTES)
    expect(utf8Bytes(detail.events[0]?.preview ?? "")).toBeLessThanOrEqual(TRACE_PREVIEW_BYTES)

    const privateResponse = await router.handle(
      { userId: "user-b" },
      intent("get_trace", { presetId: PRESET_ID, executionId: EXECUTION_ID, traceId: TRACE_ID }),
    )
    expect(errorCode(privateResponse)).toBe("APC_TRACE_NOT_FOUND")
  })
  test("evicts only the deterministic oldest idle sequence ledger at exact capacity", async () => {
    const { router } = createFixture()
    for (let index = 0; index < MAX_ENDPOINT_SEQUENCE_LEDGERS; index += 1) {
      const response = await router.handle(
        { userId: `sequence-user-${index}` },
        intent("list_connections", {}),
      )
      expect(response.type).toBe("connections")
      if (response.type === "connections") expect(response.sequence).toBe(1)
    }

    const retained = await router.handle({ userId: "sequence-user-0" }, intent("list_connections", {}))
    expect(retained.type).toBe("connections")
    if (retained.type === "connections") expect(retained.sequence).toBe(2)

    const overflow = await router.handle({ userId: "sequence-overflow" }, intent("list_connections", {}))
    expect(overflow.type).toBe("connections")
    if (overflow.type === "connections") expect(overflow.sequence).toBe(3)

    const retainedAgain = await router.handle({ userId: "sequence-user-0" }, intent("list_connections", {}))
    expect(retainedAgain.type).toBe("connections")
    if (retainedAgain.type === "connections") expect(retainedAgain.sequence).toBe(3)

    const evicted = await router.handle({ userId: "sequence-user-1" }, intent("list_connections", {}))
    expect(evicted.type).toBe("connections")
    if (evicted.type === "connections") expect(evicted.sequence).toBe(4)
  })

  test("fails closed when all sequence ledgers are retained by active requests", async () => {
    const gate = Promise.withResolvers<void>()
    const fixture = createFixture({ listConnectionsGate: gate.promise })
    const pending = Array.from({ length: MAX_ENDPOINT_SEQUENCE_LEDGERS }, (_, index) =>
      fixture.router.handle({ userId: `active-sequence-user-${index}` }, intent("list_connections", {})),
    )
    await Promise.resolve()
    expect(fixture.calls.users).toHaveLength(MAX_ENDPOINT_SEQUENCE_LEDGERS)

    const overflow = await fixture.router.handle({ userId: "active-sequence-overflow" }, intent("list_connections", {}))
    expect(errorCode(overflow)).toBe("APC_SEQUENCE_CAPACITY")
    if (overflow.type === "error") expect(overflow.sequence).toBeUndefined()

    gate.resolve()
    const activeResponses = await Promise.all(pending)
    for (const response of activeResponses) {
      expect(response.type).toBe("connections")
      if (response.type === "connections") expect(response.sequence).toBe(1)
    }
    const retained = await fixture.router.handle({ userId: "active-sequence-user-0" }, intent("list_connections", {}))
    expect(retained.type).toBe("connections")
    if (retained.type === "connections") expect(retained.sequence).toBe(2)
  })

  test("retains an admitted in-flight response sequence through router disposal", async () => {
    const gate = Promise.withResolvers<void>()
    const fixture = createFixture({ listConnectionsGate: gate.promise })
    const pending = fixture.router.handle({ userId: "dispose-active-user" }, intent("list_connections", {}))
    await Promise.resolve()
    fixture.router.dispose()
    gate.resolve()
    const response = await pending
    expect(response.type).toBe("connections")
    if (response.type === "connections") expect(response.sequence).toBe(1)
  })

})
