// @ts-ignore Bun provides the test module at runtime; the extension bundle excludes this file.
import { describe, expect, test } from "bun:test"
import {
  MAX_ACTIVITY_USAGE_TOKENS,
  MAX_CONNECTIONS,
  MAX_BINDING_VIEWS,
  MAX_CONSENT_VIEWS,
  MAX_ERROR_DETAILS,
  MAX_PROTOCOL_MESSAGE_BYTES,
  MAX_TRACE_EVENTS,
  MAX_TRACE_LIST_ITEMS,
  MAX_CURSOR_BYTES,
  MonotonicSequenceLedger,
  ProtocolDecodeError,
  assertMonotonicSequence,
  createBackendActivityResponse,
  decodeBackendResponse,
  decodeFrontendIntent,
} from "./messages"
import { MAX_TRACE_BYTES, TRACE_PREVIEW_BYTES } from "../config/limits"

const CORRELATION_ID = "6ba7b810-9dad-41d1-80b4-00c04fd430c8"
const PRESET_ID = "7ba7b810-9dad-41d1-80b4-00c04fd430c8"
const EXECUTION_ID = "8ba7b810-9dad-41d1-80b4-00c04fd430c8"
const SLOT_ID = "9ba7b810-9dad-41d1-80b4-00c04fd430c8"
const CONNECTION_ID = "aba7b810-9dad-41d1-80b4-00c04fd430c8"
const TRACE_ID = "bba7b810-9dad-41d1-80b4-00c04fd430c8"

function frontendEnvelope(type: string, payload: Record<string, unknown>, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: 1, type, correlationId: CORRELATION_ID, payload, ...overrides }
}

function backendEnvelope(
  type: string,
  payload: Record<string, unknown>,
  sequence: number | undefined = 1,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 1,
    type,
    correlationId: CORRELATION_ID,
    ...(sequence === undefined ? {} : { sequence }),
    payload,
    ...overrides,
  }
}

function expectProtocolFailure(call: () => unknown): void {
  expect(call).toThrow(ProtocolDecodeError)
}

function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return
  expect(Object.isFrozen(value)).toBe(true)
  if (Array.isArray(value)) {
    for (const item of value) expectDeepFrozen(item)
    return
  }
  for (const item of Object.values(value)) expectDeepFrozen(item)
}

function traceSummary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    traceId: TRACE_ID,
    executionId: EXECUTION_ID,
    presetId: PRESET_ID,
    status: "completed",
    startedAt: 1_000,
    finishedAt: 2_000,
    eventCount: 1,
    preview: "completed preview",
    truncated: false,
    ...overrides,
  }
}

function traceEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "stage",
    sequence: 1,
    timestamp: 1_500,
    status: "completed",
    runId: "main",
    stageId: "final",
    preview: "stage preview",
    ...overrides,
  }
}

const consentView = {
  threadId: EXECUTION_ID,
  workspaceSource: "native-blocks",
  connectionSourceKey: `slot:${SLOT_ID}`,
  status: "approved",
  destination: { label: "Primary", provider: "provider", model: "model-v1" },
  disclosure: {
    version: 1,
    summary: "This thread's workspace content is sent to the selected destination.",
    categories: [
      "thread",
      "workspace",
      "source",
      "destination",
      "provider",
      "model",
      "input-bindings",
      "prior-stage-outputs",
      "prompt-variable-values",
    ],
  },
}

const hydrationExecution = {
  executionId: EXECUTION_ID,
  presetId: PRESET_ID,
  kind: "stage",
  phase: "progress",
  terminal: false,
  traceId: TRACE_ID,
  runStatus: "running",
  usage: { input: 11, output: 7, total: 18 },
  provider: "provider",
  model: "model-v1",
  stageIndex: 1,
  stageCount: 2,
  runIndex: 1,
  runCount: 2,
  completedRuns: 1,
  totalRuns: 4,
  remainingBudgetMs: 10_000,
}
const settledDeliveryProjection = {
  executionId: EXECUTION_ID,
  presetId: PRESET_ID,
  traceId: TRACE_ID,
  completedRuns: 2,
  totalRuns: 4,
  outcome: "graph-fallback",
  fallbackCauseCategory: "required-typed-run",
  fallbackCauseCode: "REQUIRED-FAILURE",
  finalDelivery: "delivered",
  mainResponded: true,
  topology: [{
    executionId: EXECUTION_ID,
    presetId: PRESET_ID,
    kind: "run-settled",
    phase: "progress",
    terminal: false,
    stageIndex: 1,
    stageCount: 2,
    runIndex: 1,
    runCount: 2,
    runStatus: "failed",
  }],
}


const frontendMessages: readonly Record<string, unknown>[] = [
  frontendEnvelope("list_connections", {}),
  frontendEnvelope("hydrate_preset", { presetId: PRESET_ID }),
  frontendEnvelope("bind_slot", {
    presetId: PRESET_ID,
    slotId: SLOT_ID,
    patch: { connectionId: CONNECTION_ID },
  }),
  frontendEnvelope("unbind_slot", { presetId: PRESET_ID, slotId: SLOT_ID }),
  frontendEnvelope("approve_consent", {
    presetId: PRESET_ID,
    threadId: EXECUTION_ID,
    workspaceSource: "native-blocks",
    connectionSourceKey: `slot:${SLOT_ID}`,
  }),
  frontendEnvelope("revoke_consent", {
    presetId: PRESET_ID,
    threadId: "main",
    workspaceSource: "main-context",
    connectionSourceKey: "main",
  }),
  frontendEnvelope("resolve_consent", {
    presetId: PRESET_ID,
    threadId: EXECUTION_ID,
    workspaceSource: "native-blocks",
    connectionSourceKey: `slot:${SLOT_ID}`,
  }),
  frontendEnvelope("list_traces", {
    presetId: PRESET_ID,
    executionId: EXECUTION_ID,
    limit: MAX_TRACE_LIST_ITEMS,
    cursor: "1",
  }),
  frontendEnvelope("get_trace", { presetId: PRESET_ID, executionId: EXECUTION_ID, traceId: TRACE_ID }),
  frontendEnvelope("cancel_execution", { presetId: PRESET_ID, executionId: EXECUTION_ID, reason: "replacement" }),
  frontendEnvelope("view_response", { presetId: PRESET_ID, executionId: EXECUTION_ID }),
]

const backendMessages: readonly Record<string, unknown>[] = [
  backendEnvelope("error", {
    code: "APC_PROTOCOL_DECODE_ERROR",
    messageKey: "APC_PROTOCOL_DECODE_ERROR",
    retryable: false,
    details: [{ path: "$.payload", reason: "unknown field" }],
  }),
  backendEnvelope("connections", {
    connections: [{
      id: CONNECTION_ID,
      name: "Primary",
      provider: "provider",
      model: "model-v1",
    }],
  }),
  backendEnvelope("binding", {
    presetId: PRESET_ID,
    slotId: SLOT_ID,
    bound: true,
    status: "bound",
    descriptor: { label: "Primary", provider: "provider", model: "model-v1" },
  }),
  backendEnvelope("binding", {
    presetId: PRESET_ID,
    slotId: SLOT_ID,
    bound: false,
    status: "missing",
  }),
  backendEnvelope("consent", {
    presetId: PRESET_ID,
    ...consentView,
  }),
  backendEnvelope("hydration", {
    presetId: PRESET_ID,
    bindings: [{
      slotId: SLOT_ID,
      bound: true,
      status: "bound",
      descriptor: { label: "Primary", provider: "provider", model: "model-v1" },
    }],
    consents: [consentView],
    execution: hydrationExecution,
    settledDelivery: settledDeliveryProjection,
  }),
  backendEnvelope("cancellation", {
    executionId: EXECUTION_ID,
    presetId: PRESET_ID,
    accepted: true,
    status: "accepted",
    cancellationSource: "stop",
  }),
  backendEnvelope("view_response", { presetId: PRESET_ID, executionId: EXECUTION_ID }),
  backendEnvelope("trace", {
    traces: [traceSummary()],
    nextCursor: "2",
  }),
  backendEnvelope("trace", {
    trace: {
      ...traceSummary({ eventCount: 1 }),
      events: [traceEvent()],
    },
  }),
  backendEnvelope("activity", {
    executionId: EXECUTION_ID,
    presetId: PRESET_ID,
    kind: "stage",
    phase: "progress",
    terminal: false,
    traceId: TRACE_ID,
    provider: "provider",
    model: "model-v1",
    stageIndex: 1,
    runStatus: "completed",
    usage: { input: 42, output: 13, total: 55 },
    stageCount: 2,
    runIndex: 1,
    runCount: 2,
    completedRuns: 1,
    totalRuns: 4,
    remainingBudgetMs: 10_000,
  }),
  backendEnvelope("activity", {
    executionId: EXECUTION_ID,
    presetId: PRESET_ID,
    kind: "execution",
    phase: "cancelled",
    terminal: true,
    traceId: TRACE_ID,
    outcome: "parent-cancel",
    cancellationSource: "stop",
  }),
]

describe("APC protocol messages", () => {
  test("decodes every frontend intent shape and freezes the normalized envelope", () => {
    const decodedTypes = new Set<string>()
    for (const message of frontendMessages) {
      const decoded = decodeFrontendIntent(message)
      decodedTypes.add(decoded.type)
      expect(decoded).toEqual(message)
      expectDeepFrozen(decoded)
    }
    expect(decodedTypes).toEqual(new Set([
      "list_connections",
      "hydrate_preset",
      "bind_slot",
      "unbind_slot",
      "approve_consent",
      "revoke_consent",
      "resolve_consent",
      "list_traces",
      "get_trace",
      "cancel_execution",
      "view_response",
    ]))
  })

  test("decodes safe hydration, consent, cancellation, trace, and activity responses", () => {
    const decodedTypes = new Set<string>()
    for (const message of backendMessages) {
      const decoded = decodeBackendResponse(message)
      decodedTypes.add(decoded.type)
      expect(decoded).toEqual(message)
      expectDeepFrozen(decoded)
    }
    expect(decodedTypes).toEqual(new Set([
      "error",
      "connections",
      "binding",
      "consent",
      "hydration",
      "cancellation",
      "trace",
      "activity",
      "view_response",
    ]))
  })

  test("decodes and bounds content-free settled delivery projections", () => {
    const decoded = decodeBackendResponse(backendEnvelope("hydration", {
      presetId: PRESET_ID,
      bindings: [],
      consents: [],
      settledDelivery: settledDeliveryProjection,
    }))
    expect(decoded.type).toBe("hydration")
    if (decoded.type === "hydration") {
      expect(decoded.payload.settledDelivery).toEqual(settledDeliveryProjection)
      expectDeepFrozen(decoded.payload.settledDelivery)
    }
    const pending = decodeBackendResponse(backendEnvelope("hydration", {
      presetId: PRESET_ID,
      bindings: [],
      consents: [],
      settledDelivery: { ...settledDeliveryProjection, finalDelivery: "pending" },
    }))
    expect(pending.type).toBe("hydration")
    if (pending.type === "hydration") expect(pending.payload.settledDelivery?.finalDelivery).toBe("pending")
    expectProtocolFailure(() => decodeBackendResponse(backendEnvelope("hydration", {
      presetId: PRESET_ID,
      bindings: [],
      consents: [],
      settledDelivery: { ...settledDeliveryProjection, presetId: TRACE_ID },
    })))
    expectProtocolFailure(() => decodeBackendResponse(backendEnvelope("hydration", {
      presetId: PRESET_ID,
      bindings: [],
      consents: [],
      settledDelivery: { ...settledDeliveryProjection, content: "private response" },
    })))
    expectProtocolFailure(() => decodeBackendResponse(backendEnvelope("hydration", {
      presetId: PRESET_ID,
      bindings: [],
      consents: [],
      settledDelivery: {
        ...settledDeliveryProjection,
        topology: [{ ...settledDeliveryProjection.topology[0], errorCategory: "provider" }],
      },
    })))
    expectProtocolFailure(() => decodeBackendResponse(backendEnvelope("hydration", {
      presetId: PRESET_ID,
      bindings: [],
      consents: [],
      settledDelivery: {
        ...settledDeliveryProjection,
        topology: [{ ...settledDeliveryProjection.topology[0], kind: "delivery-settled", phase: "completed", terminal: true }],
      },
    })))
  })

  test("rejects malformed or private hydration execution snapshots", () => {
    const base = {
      presetId: PRESET_ID,
      bindings: [],
      consents: [],
      execution: hydrationExecution,
    }
    expectProtocolFailure(() => decodeBackendResponse(backendEnvelope("hydration", {
      ...base,
      execution: { ...hydrationExecution, userId: "private-user" },
    })))
    expectProtocolFailure(() => decodeBackendResponse(backendEnvelope("hydration", {
      ...base,
      execution: { ...hydrationExecution, terminal: true },
    })))
    expectProtocolFailure(() => decodeBackendResponse(backendEnvelope("hydration", {
      ...base,
      execution: { ...hydrationExecution, presetId: TRACE_ID },
    })))
  })
  test("preserves stale binding status while rejecting unsafe status/descriptor combinations", () => {
    const stale = decodeBackendResponse(backendEnvelope("binding", {
      presetId: PRESET_ID,
      slotId: SLOT_ID,
      bound: true,
      status: "stale",
    }))
    expect(stale.type).toBe("binding")
    if (stale.type === "binding") expect(stale.payload.status).toBe("stale")
    expectProtocolFailure(() => decodeBackendResponse(backendEnvelope("binding", {
      presetId: PRESET_ID,
      slotId: SLOT_ID,
      bound: false,
      status: "bound",
      descriptor: { label: "Primary", provider: "provider", model: "model-v1" },
    })))
    expectProtocolFailure(() => decodeBackendResponse(backendEnvelope("binding", {
      presetId: PRESET_ID,
      slotId: SLOT_ID,
      bound: true,
      status: "unknown",
      descriptor: { label: "Primary", provider: "provider", model: "model-v1" },
    })))
  })
  test("enforces consent projection parity and workspace-specific disclosure categories", () => {
    const required = decodeBackendResponse(backendEnvelope("consent", {
      presetId: PRESET_ID,
      ...consentView,
      status: "required",
    }))
    expect(required.type).toBe("consent")
    const { disclosure: _requiredDisclosure, ...requiredDestinationOnly } = consentView
    expectProtocolFailure(() => decodeBackendResponse(backendEnvelope("consent", {
      presetId: PRESET_ID,
      ...requiredDestinationOnly,
      status: "required",
    })))
    const { destination: _revokedDestination, ...revokedDisclosureOnly } = consentView
    expectProtocolFailure(() => decodeBackendResponse(backendEnvelope("consent", {
      presetId: PRESET_ID,
      ...revokedDisclosureOnly,
      status: "revoked",
    })))
    expectProtocolFailure(() => decodeBackendResponse(backendEnvelope("consent", {
      presetId: PRESET_ID,
      ...consentView,
      disclosure: {
        ...consentView.disclosure,
        categories: ["thread", "workspace", "source", "destination", "provider", "model", "main-context"],
      },
    })))
    expectProtocolFailure(() => decodeBackendResponse(backendEnvelope("consent", {
      presetId: PRESET_ID,
      ...consentView,
      disclosure: {
        ...consentView.disclosure,
        categories: ["thread", "workspace", "source", "destination", "provider", "model", "input-bindings", "prior-stage-outputs"],
      },
    })))
    const mainContext = {
      ...consentView,
      workspaceSource: "main-context",
      disclosure: {
        ...consentView.disclosure,
        categories: ["thread", "workspace", "source", "destination", "provider", "model", "main-context", "input-bindings", "prior-stage-outputs"],
      },
    }
    const mainDecoded = decodeBackendResponse(backendEnvelope("consent", {
      presetId: PRESET_ID,
      ...mainContext,
    }))
    expect(mainDecoded.type).toBe("consent")
    expectProtocolFailure(() => decodeBackendResponse(backendEnvelope("consent", {
      presetId: PRESET_ID,
      ...mainContext,
      disclosure: {
        ...mainContext.disclosure,
        categories: ["thread", "workspace", "source", "destination", "provider", "model", "main-context"],
      },
    })))
  })

  test("rejects unknown fields and revision/private fields at every boundary", () => {
    for (const message of frontendMessages) {
      expectProtocolFailure(() => decodeFrontendIntent({ ...message, unexpected: true }))
      expectProtocolFailure(() => decodeFrontendIntent({
        ...message,
        payload: { ...(message.payload as Record<string, unknown>), unexpected: true },
      }))
    }
    for (const message of backendMessages) {
      expectProtocolFailure(() => decodeBackendResponse({ ...message, unexpected: true }))
      expectProtocolFailure(() => decodeBackendResponse({
        ...message,
        payload: { ...(message.payload as Record<string, unknown>), unexpected: true },
      }))
    }
    expectProtocolFailure(() => decodeBackendResponse(backendEnvelope("binding", {
      presetId: PRESET_ID,
      slotId: SLOT_ID,
      bound: true,
      dispatchRevision: "revision-must-not-cross-wire",
    })))
    expectProtocolFailure(() => decodeBackendResponse(backendEnvelope("consent", {
      presetId: PRESET_ID,
      ...consentView,
      dispatchRevision: "revision-must-not-cross-wire",
    })))
    expectProtocolFailure(() => decodeFrontendIntent(frontendEnvelope("resolve_consent", {
      presetId: PRESET_ID,
      threadId: EXECUTION_ID,
      workspaceSource: "native-blocks",
      connectionSourceKey: `slot:${SLOT_ID}`,
      dispatchRevision: "revision-must-not-cross-wire",
    })))
  })

  test("rejects unsupported versions, unknown types, dangerous values, and credentials", () => {
    const frontend = frontendMessages[0]
    expectProtocolFailure(() => decodeFrontendIntent({ ...frontend, version: 2 }))
    expectProtocolFailure(() => decodeFrontendIntent({ ...frontend, type: "future_intent" }))
    const backend = backendMessages.find(message => message.type === "connections")
    expect(backend).toBeDefined()
    expectProtocolFailure(() => decodeBackendResponse({ ...backend, version: 2 }))
    expectProtocolFailure(() => decodeBackendResponse({ ...backend, type: "future_response" }))
    const dangerous = frontendEnvelope("list_connections", {})
    Object.defineProperty(dangerous.payload, "__proto__", { enumerable: true, value: "polluted" })
    expectProtocolFailure(() => decodeFrontendIntent(dangerous))
    const cyclic: Record<string, unknown> = frontendEnvelope("list_connections", {})
    cyclic.loop = cyclic
    expectProtocolFailure(() => decodeFrontendIntent(cyclic))
    for (const key of ["userId", "authoritativeCallbackUserId", "apiKey", "token", "credentials"]) {
      expectProtocolFailure(() => decodeFrontendIntent(frontendEnvelope("list_connections", { [key]: "sensitive" })))
      expectProtocolFailure(() => decodeBackendResponse(backendEnvelope("activity", {
        executionId: EXECUTION_ID,
        presetId: PRESET_ID,
        kind: "stage",
        phase: "progress",
        terminal: false,
        [key]: "sensitive",
      })))
    }
  })

  test("enforces canonical correlation IDs and positive safe sequence bounds", () => {
    const frontend = frontendMessages[0]
    for (const correlationId of ["", "not-a-uuid", "6BA7B810-9DAD-41D1-80B4-00C04FD430C8"]) {
      expectProtocolFailure(() => decodeFrontendIntent({ ...frontend, correlationId }))
    }
    const backend = backendMessages.find(message => message.type === "connections")
    expect(backend).toBeDefined()
    for (const correlationId of ["", "not-a-uuid", "6BA7B810-9DAD-41D1-80B4-00C04FD430C8"]) {
      expectProtocolFailure(() => decodeBackendResponse({ ...backend, correlationId }))
    }
    for (const sequence of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expectProtocolFailure(() => decodeBackendResponse({ ...backend, sequence }))
    }
    const maximum = decodeBackendResponse({ ...backend, sequence: Number.MAX_SAFE_INTEGER })
    expect(maximum.type).toBe("connections")
  })

  test("keeps host profile and consent-view caps independent from slot capacity", () => {
    const ids = Array.from({ length: 17 }, (_, index) => `${index.toString(16).padStart(8, "0")}-e29b-41d4-a716-446655440000`)
    const connections = ids.map((id, index) => ({
      id,
      name: `Primary ${index}`,
      provider: "provider",
      model: "model-v1",
    }))
    const decodedConnections = decodeBackendResponse(backendEnvelope("connections", { connections }))
    expect(decodedConnections.type).toBe("connections")
    if (decodedConnections.type === "connections") expect(decodedConnections.payload.connections).toHaveLength(17)

    const consents = ids.map(threadId => ({ ...consentView, threadId }))
    const decodedHydration = decodeBackendResponse(backendEnvelope("hydration", {
      presetId: PRESET_ID,
      bindings: [],
      consents,
    }))
    expect(decodedHydration.type).toBe("hydration")
    if (decodedHydration.type === "hydration") expect(decodedHydration.payload.consents).toHaveLength(17)
  })

  test("enforces bounded collections, labels, disclosure, activity, and trace payloads", () => {
    const oversizedMessage = frontendEnvelope("list_connections", {})
    oversizedMessage.padding = "x".repeat(MAX_PROTOCOL_MESSAGE_BYTES)
    expectProtocolFailure(() => decodeFrontendIntent(oversizedMessage))
    const oversizedTracePayload = Array.from({ length: 40 }, () => traceSummary({ preview: "x".repeat(TRACE_PREVIEW_BYTES) }))
    expect(new TextEncoder().encode(JSON.stringify({ traces: oversizedTracePayload })).byteLength).toBeGreaterThan(MAX_TRACE_BYTES)
    expectProtocolFailure(() => decodeBackendResponse(backendEnvelope("trace", { traces: oversizedTracePayload })))
    expectProtocolFailure(() => decodeBackendResponse(backendEnvelope("connections", {
      connections: Array.from({ length: MAX_CONNECTIONS + 1 }, () => ({
        id: CONNECTION_ID,
        name: "Primary",
        provider: "provider",
        model: "model-v1",
      })),
    })))
    expectProtocolFailure(() => decodeBackendResponse(backendEnvelope("hydration", {
      presetId: PRESET_ID,
      bindings: Array.from({ length: MAX_BINDING_VIEWS + 1 }, () => ({ slotId: SLOT_ID, bound: false })),
      consents: [],
    })))
    expectProtocolFailure(() => decodeBackendResponse(backendEnvelope("hydration", {
      presetId: PRESET_ID,
      bindings: [],
      consents: Array.from({ length: MAX_CONSENT_VIEWS + 1 }, () => consentView),
    })))
    expectProtocolFailure(() => decodeBackendResponse(backendEnvelope("consent", {
      presetId: PRESET_ID,
      ...consentView,
      disclosure: {
        ...consentView.disclosure,
        categories: Array.from({ length: 11 }, () => "thread"),
      },
    })))
    expectProtocolFailure(() => decodeBackendResponse(backendEnvelope("activity", {
      executionId: EXECUTION_ID,
      presetId: PRESET_ID,
      kind: "stage",
      phase: "progress",
      terminal: false,
      completedRuns: 1_000_001,
    })))
    expectProtocolFailure(() => decodeFrontendIntent(frontendEnvelope("list_traces", {
      cursor: "x".repeat(MAX_CURSOR_BYTES + 1),
    })))
    expectProtocolFailure(() => decodeBackendResponse(backendEnvelope("error", {
      code: "APC_INVALID",
      messageKey: "APC_INVALID",
      retryable: false,
      details: Array.from({ length: MAX_ERROR_DETAILS + 1 }, () => ({ path: "$.payload", reason: "invalid" })),
    })))
    expectProtocolFailure(() => decodeBackendResponse(backendEnvelope("trace", {
      trace: traceSummary({
        eventCount: MAX_TRACE_EVENTS,
        events: Array.from({ length: MAX_TRACE_EVENTS + 1 }, (_, index) => traceEvent({ sequence: index + 1 })),
      }),
    })))
  })

  test("requires exactly one terminal activity representation", () => {
    const base = {
      correlationId: CORRELATION_ID,
      sequence: 1,
      executionId: EXECUTION_ID,
      presetId: PRESET_ID,
      kind: "execution",
    } as const
    const terminal = createBackendActivityResponse({
      ...base,
      phase: "completed",
      terminal: true,
      outcome: "success",
    })
    expect(terminal.payload.terminal).toBe(true)
    expectDeepFrozen(terminal)
    expect(() => createBackendActivityResponse({ ...base, phase: "progress", terminal: true })).toThrow(RangeError)
    expect(() => createBackendActivityResponse({ ...base, phase: "completed", terminal: true })).toThrow(RangeError)
    expectProtocolFailure(() => decodeBackendResponse(backendEnvelope("activity", {
      ...base,
      phase: "completed",
      terminal: false,
      outcome: "success",
    })))
    expectProtocolFailure(() => decodeBackendResponse(backendEnvelope("activity", {
      ...base,
      phase: "failed",
      terminal: true,
      outcome: "selected-final-failure",
    })))
    expectProtocolFailure(() => decodeBackendResponse(backendEnvelope("activity", {
      ...base,
      phase: "cancelled",
      terminal: true,
      outcome: "parent-cancel",
    })))
  })

  test("accepts bounded run status and usage while rejecting unsafe payloads", () => {
    const base = {
      correlationId: CORRELATION_ID,
      sequence: 1,
      executionId: EXECUTION_ID,
      presetId: PRESET_ID,
      kind: "run-settled",
      phase: "progress" as const,
      terminal: false,
    }
    const response = createBackendActivityResponse({
      ...base,
      runStatus: "failed",
      usage: { input: 10, output: 20, total: 30 },
    })
    expect(response.payload.runStatus).toBe("failed")
    expect(response.payload.usage).toEqual({ input: 10, output: 20, total: 30 })
    expectDeepFrozen(response)
    expect(decodeBackendResponse(response)).toEqual(response)
    for (const usage of [
      { input: -1 },
      { input: 1.5 },
      { input: Number.POSITIVE_INFINITY },
      { input: MAX_ACTIVITY_USAGE_TOKENS + 1 },
      { private: 1 },
    ]) {
      expect(() => createBackendActivityResponse({ ...base, usage })).toThrow(RangeError)
      expectProtocolFailure(() => decodeBackendResponse(backendEnvelope("activity", { ...base, usage })))
    }
    expect(() => createBackendActivityResponse({ ...base, runStatus: "provider" as never })).toThrow(RangeError)
    expectProtocolFailure(() => decodeBackendResponse(backendEnvelope("activity", { ...base, runStatus: "provider" })))
  })
  test("round trips bounded run failures, fallback causes, and Main delivery state", () => {
    const runBase = {
      correlationId: CORRELATION_ID,
      sequence: 1,
      executionId: EXECUTION_ID,
      presetId: PRESET_ID,
      kind: "run-settled",
      phase: "progress" as const,
      terminal: false,
      runStatus: "failed" as const,
      runErrorCategory: "provider" as const,
    }
    const run = createBackendActivityResponse(runBase)
    expect(run.payload.runErrorCategory).toBe("provider")
    expect(decodeBackendResponse(run)).toEqual(run)

    const deliveryBase = {
      correlationId: CORRELATION_ID,
      sequence: 2,
      executionId: EXECUTION_ID,
      presetId: PRESET_ID,
      kind: "execution-terminal",
      phase: "completed" as const,
      terminal: true,
      outcome: "graph-fallback" as const,
      fallbackCauseCategory: "required-typed-run" as const,
      fallbackCauseCode: "REQUIRED-FAILURE",
    }
    const pending = createBackendActivityResponse({ ...deliveryBase, finalDelivery: "pending" })
    expect(pending.payload.mainResponded).toBeUndefined()
    expect(decodeBackendResponse(pending)).toEqual(pending)
    const delivered = createBackendActivityResponse({
      ...deliveryBase,
      finalDelivery: "delivered",
      mainResponded: true,
    })
    expect(decodeBackendResponse(delivered)).toEqual(delivered)
    const notDelivered = createBackendActivityResponse({
      ...deliveryBase,
      finalDelivery: "not-delivered",
      mainResponded: false,
    })
    expect(decodeBackendResponse(notDelivered)).toEqual(notDelivered)

    expect(() => createBackendActivityResponse({
      ...runBase,
      runStatus: "completed",
    })).toThrow(RangeError)
    expectProtocolFailure(() => decodeBackendResponse(backendEnvelope("activity", {
      ...runBase,
      runStatus: "completed",
    })))
    expect(() => createBackendActivityResponse({
      ...runBase,
      kind: "execution",
    })).toThrow(RangeError)
    expectProtocolFailure(() => decodeBackendResponse(backendEnvelope("activity", {
      ...runBase,
      kind: "execution",
    })))
    expect(() => createBackendActivityResponse({
      ...deliveryBase,
      fallbackCauseCode: undefined,
    })).toThrow(RangeError)
    expectProtocolFailure(() => decodeBackendResponse(backendEnvelope("activity", {
      ...deliveryBase,
      fallbackCauseCode: undefined,
    })))
    expect(() => createBackendActivityResponse({
      ...deliveryBase,
      outcome: "success",
    })).toThrow(RangeError)
    expectProtocolFailure(() => decodeBackendResponse(backendEnvelope("activity", {
      ...deliveryBase,
      outcome: "success",
    })))
    expect(() => createBackendActivityResponse({
      ...deliveryBase,
      finalDelivery: "pending",
      mainResponded: false,
    })).toThrow(RangeError)
    expectProtocolFailure(() => decodeBackendResponse(backendEnvelope("activity", {
      ...deliveryBase,
      finalDelivery: "pending",
      mainResponded: false,
    })))
    expect(() => createBackendActivityResponse({
      ...deliveryBase,
      finalDelivery: "delivered",
      mainResponded: false,
    })).toThrow(RangeError)
    expectProtocolFailure(() => decodeBackendResponse(backendEnvelope("activity", {
      ...deliveryBase,
      finalDelivery: "delivered",
      mainResponded: false,
    })))
    expect(() => createBackendActivityResponse({
      ...deliveryBase,
      fallbackCauseCode: "raw error" as never,
    })).toThrow(RangeError)
    expectProtocolFailure(() => decodeBackendResponse(backendEnvelope("activity", {
      ...deliveryBase,
      fallbackCauseCode: "raw error",
    })))
  })

  test("accepts only increasing backend sequence values", () => {
    const ledger = new MonotonicSequenceLedger()
    expect(ledger.accept(1)).toBe(true)
    expect(ledger.accept(1)).toBe(false)
    expect(ledger.accept(0)).toBe(false)
    expect(ledger.accept(Number.MAX_SAFE_INTEGER)).toBe(true)
    expect(ledger.accept(Number.MAX_SAFE_INTEGER)).toBe(false)
    expect(ledger.lastSequence).toBe(Number.MAX_SAFE_INTEGER)
    ledger.reset()
    expect(ledger.lastSequence).toBe(0)
    expect(assertMonotonicSequence(0, 1)).toBe(1)
    expect(assertMonotonicSequence(1, Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER)
    expect(() => assertMonotonicSequence(-1, 1)).toThrow(RangeError)
    expect(() => assertMonotonicSequence(1, 1)).toThrow(RangeError)
    expect(() => assertMonotonicSequence(1, 1.5)).toThrow(RangeError)
    expect(() => assertMonotonicSequence(1, Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError)
  })
})
