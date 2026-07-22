// @ts-ignore Bun provides the test module at runtime; the extension bundle excludes this file.
import { describe, expect, test } from "bun:test"
import { createDefaultApcConfig, type ApcPresetConfigV1 } from "../config/schema"
import type {
  BackendConnectionListResponse,
  BackendActivityResponse,
  BackendHydrationResponse,
  ConnectionSummary,
  BackendViewResponseResponse,
} from "../protocol/messages"
import type {
  ApcDomainIntent,
  ApcDomainResponse,
  ApcDomainTransport,
  ApcPresetEditorDraftAdapter,
  ApcPresetEditorDraftState,
} from "./persistence"
import { createApcPersistence } from "./persistence"
import { createBackendActivityResponse, PROTOCOL_VERSION } from "../protocol/messages"
import type { ApcFrontendStore } from "./state"
import { createApcFrontendState } from "./state"
 
const PRESET_A = "550e8400-e29b-41d4-a716-446655440000"
const PRESET_B = "550e8400-e29b-41d4-a716-446655440001"
const THREAD_ID = "550e8400-e29b-41d4-a716-446655440002"
const SEQUENTIAL_PIPELINE_ID = "550e8400-e29b-41d4-a716-446655440003"
const PARALLEL_PIPELINE_ID = "550e8400-e29b-41d4-a716-446655440004"
const SEQUENTIAL_STAGE_ID = "550e8400-e29b-41d4-a716-446655440005"
const PARALLEL_STAGE_ID = "550e8400-e29b-41d4-a716-446655440006"
const SEQUENTIAL_RUN_ID = "550e8400-e29b-41d4-a716-446655440007"
const PARALLEL_RUN_ID = "550e8400-e29b-41d4-a716-446655440008"
 
const CONNECTION_A: ConnectionSummary = {
  id: "550e8400-e29b-41d4-a716-446655440009",
  name: "Primary",
  provider: "openai",
  model: "gpt-5",
}
const CONNECTION_B: ConnectionSummary = {
  id: "550e8400-e29b-41d4-a716-446655440010",
  name: "Secondary",
  provider: "anthropic",
  model: "claude",
}
 
function graphConfig(activeMode: "single" | "sequential" | "parallel" = "single"): ApcPresetConfigV1 {
  const base = createDefaultApcConfig()
  base.supportedModes = ["single", "sequential", "parallel"]
  base.activeMode = activeMode
  base.threads = [{
    id: THREAD_ID,
    name: "Writer",
    description: "Writes a response.",
    workspaceSource: "main-context",
    blocks: [],
    promptVariableValues: {},
    output: { id: "final", name: "Final Response" },
  }]
  const pipeline = (id: string, stageId: string, runId: string) => ({
    id,
    stages: [{ id: stageId, name: "Draft", runs: [{ id: runId, threadId: THREAD_ID, required: true, timeoutMs: 60_000, inputs: [] }] }],
    finalResponse: { source: "thread" as const, runId },
  })
  base.pipelines = {
    sequential: pipeline(SEQUENTIAL_PIPELINE_ID, SEQUENTIAL_STAGE_ID, SEQUENTIAL_RUN_ID),
    parallel: pipeline(PARALLEL_PIPELINE_ID, PARALLEL_STAGE_ID, PARALLEL_RUN_ID),
  }
  return base
}
 
class FakeEditor implements ApcPresetEditorDraftAdapter {
  state: ApcPresetEditorDraftState = { presetId: PRESET_A, metadata: graphConfig() }
  failFlush = false
  failFlushCount = 0
  flushCount = 0
  blockFlushAt: number | null = null
  metadataUpdates: unknown[] = []
  #flushRelease: (() => void) | null = null
  #listeners = new Set<(state: ApcPresetEditorDraftState) => void>()
 
  getState(): ApcPresetEditorDraftState { return this.state }
  onChange(listener: (state: ApcPresetEditorDraftState) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }
  updateMetadata(mutator: (metadata: unknown) => unknown): void {
    this.state = { ...this.state, metadata: mutator(this.state.metadata) }
    this.metadataUpdates.push(this.state.metadata)
    for (const listener of this.#listeners) listener(this.state)
  }
  releaseFlush(): void {
    const release = this.#flushRelease
    this.#flushRelease = null
    release?.()
  }
  async flush(): Promise<void> {
    this.flushCount += 1
    if (this.failFlushCount > 0) {
      this.failFlushCount -= 1
      throw new Error("editor flush failed")
    }
    if (this.failFlush) throw new Error("editor flush failed")
    if (this.blockFlushAt === this.flushCount) {
      await new Promise<void>((resolve) => {
        this.#flushRelease = resolve
      })
    }
  }
  switchPreset(presetId: string | null, metadata: unknown): void {
    this.state = { presetId, metadata }
    for (const listener of this.#listeners) listener(this.state)
  }
}
 
class FakeTransport implements ApcDomainTransport {
  sent: ApcDomainIntent[] = []
  #listeners = new Set<(message: ApcDomainResponse) => void>()
  #sequence = 0
  #connections: readonly ConnectionSummary[]
  #autoRespondConnections: boolean
  #autoRespondHydration: boolean

  constructor(options: Readonly<{
    connections?: readonly ConnectionSummary[]
    autoRespondConnections?: boolean
    autoRespondHydration?: boolean
  }> = {}) {
    this.#connections = options.connections ?? [CONNECTION_A, CONNECTION_B]
    this.#autoRespondConnections = options.autoRespondConnections ?? true
    this.#autoRespondHydration = options.autoRespondHydration ?? true
  }
  send(message: ApcDomainIntent): void {
    this.sent.push(message)
    if (message.type === "hydrate_preset") {
      if (this.#autoRespondHydration) queueMicrotask(() => this.respondHydration(message.correlationId, message.payload.presetId))
      return
    }
    if (message.type !== "list_connections" || !this.#autoRespondConnections) return
    queueMicrotask(() => this.respondConnections(message.correlationId))
  }

  onMessage(listener: (message: ApcDomainResponse) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  setConnections(connections: readonly ConnectionSummary[]): void {
    this.#connections = connections
  }

  respondConnections(correlationId: string, connections = this.#connections): void {
    const response: BackendConnectionListResponse = {
      version: PROTOCOL_VERSION,
      type: "connections",
      correlationId,
      sequence: ++this.#sequence,
      payload: { connections },
    }
    this.respond(response)
  }
  respondHydration(
    correlationId: string,
    presetId: string,
    bindings: BackendHydrationResponse["payload"]["bindings"] = [],
    consents: BackendHydrationResponse["payload"]["consents"] = [],
    execution?: BackendHydrationResponse["payload"]["execution"],
    settledDelivery?: BackendHydrationResponse["payload"]["settledDelivery"],
  ): void {
    const response: BackendHydrationResponse = {
      version: PROTOCOL_VERSION,
      type: "hydration",
      correlationId,
      sequence: ++this.#sequence,
      payload: {
        presetId,
        bindings,
        consents,
        ...(execution === undefined ? {} : { execution }),
        ...(settledDelivery === undefined ? {} : { settledDelivery }),
      },
    }
    this.respond(response)
  }
  nextSequence(): number {
    return ++this.#sequence
  }


  respond(message: ApcDomainResponse): void {
    for (const listener of this.#listeners) listener(message)
  }
}
 
class ErrorTransport implements ApcDomainTransport {
  #listener: ((message: ApcDomainResponse) => void) | null = null
  #correlationId: string | null = null
  #sequence = 0

  send(message: ApcDomainIntent): void {
    this.#correlationId = message.correlationId
    if (message.type === "hydrate_preset") {
      queueMicrotask(() => this.#listener?.({
        version: PROTOCOL_VERSION,
        type: "hydration",
        correlationId: message.correlationId,
        sequence: ++this.#sequence,
        payload: { presetId: message.payload.presetId, bindings: [], consents: [] },
      }))
    }
    if (message.type === "list_connections") {
      queueMicrotask(() => this.#listener?.({
        version: PROTOCOL_VERSION,
        type: "connections",
        correlationId: message.correlationId,
        sequence: ++this.#sequence,
        payload: { connections: [{ id: "opaque-connection", name: "Primary", provider: "openai", model: "gpt-5" }] },
      }))
    }
  }

  onMessage(listener: (message: ApcDomainResponse) => void): () => void {
    this.#listener = listener
    return () => { this.#listener = null }
  }

  respondWithHostileMessage(): void {
    if (this.#correlationId === null) return
    this.#listener?.({
      version: PROTOCOL_VERSION,
      type: "error",
      correlationId: this.#correlationId,
      payload: { code: "BACKEND_ERROR", messageKey: "error.backend", retryable: false },
    })
  }
}
 
function storeFor(editor: FakeEditor, transport: ApcDomainTransport = new FakeTransport()): ApcFrontendStore {
  const persistence = createApcPersistence({ editor, transport })
  return createApcFrontendState({ persistence })
}
 
async function settleMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}
describe("APC frontend application state", () => {
  test("hydrates typed config and exposes mode issues and availability", async () => {
    const editor = new FakeEditor()
    const store = storeFor(editor)

    const snapshot = await store.hydrate(PRESET_A)

    expect(snapshot.presetId).toBe(PRESET_A)
    expect(snapshot.config?.activeMode).toBe("single")
    expect(snapshot.decoded?.status).toBe("valid")
    expect(snapshot.modeIssues.sequential).toEqual([])
    expect(snapshot.modeAvailability.parallel.valid).toBe(true)
    expect(snapshot.traces).toEqual({ summaries: [], details: {} })
    store.dispose()
  })
  test("hydrates an active execution into an opaque safe activity snapshot", async () => {
    const editor = new FakeEditor()
    const transport = new FakeTransport({ autoRespondHydration: false })
    const store = storeFor(editor, transport)
    const pending = store.hydrate(PRESET_A)
    await settleMicrotasks()
    const request = transport.sent.find((message) => message.type === "hydrate_preset")
    expect(request?.type).toBe("hydrate_preset")
    transport.respondHydration(request?.correlationId ?? "missing", PRESET_A, [], [], {
      executionId: "execution-hydrated",
      presetId: PRESET_A,
      kind: "graph",
      phase: "progress",
      terminal: false,
      runStatus: "running",
      usage: { input: 4, output: 2, total: 6 },
      stageIndex: 0,
      stageCount: 1,
      runIndex: 0,
      runCount: 1,
    })
    const snapshot = await pending
    expect(snapshot.execution.executionKey).toMatch(/^execution-/)
    expect(snapshot.execution.executionKey).not.toBe("execution-hydrated")
    expect(snapshot.execution.activity).toHaveLength(1)
    expect(snapshot.execution.usage).toEqual({ input: 4, output: 2, total: 6 })
    expect(snapshot.execution.activity[0]?.status).toBe("running")
    expect(snapshot.execution.activity[0]?.phase).toBe("progress")
    expect(snapshot.execution.topologyActivity).toHaveLength(1)
    expect(snapshot.execution.topologyActivity[0]?.status).toBe("running")
    expect(snapshot.execution.topologyApplicable).toBe(true)
    expect(snapshot.busyReason).toBe("execution")
    expect(JSON.stringify(snapshot)).not.toContain("execution-hydrated")
    store.dispose()
  })
  test("hydrates a settled delivery projection as authoritative delivered and unlocked state", async () => {
    const editor = new FakeEditor()
    const transport = new FakeTransport({ autoRespondHydration: false })
    const store = storeFor(editor, transport)
    const pending = store.hydrate(PRESET_A)
    await settleMicrotasks()
    const request = transport.sent.find((message) => message.type === "hydrate_preset")
    expect(request?.type).toBe("hydrate_preset")
    transport.respondHydration(request?.correlationId ?? "missing", PRESET_A, [], [], undefined, {
      executionId: "execution-settled",
      presetId: PRESET_A,
      traceId: "trace-settled",
      completedRuns: 1,
      totalRuns: 1,
      outcome: "graph-fallback",
      fallbackCauseCategory: "required-typed-run",
      fallbackCauseCode: "REQUIRED-FAILURE",
      finalDelivery: "delivered",
      mainResponded: true,
      topology: [{
        executionId: "execution-settled",
        presetId: PRESET_A,
        kind: "run-settled",
        phase: "progress",
        terminal: false,
        stageIndex: 0,
        stageCount: 1,
        runIndex: 0,
        runCount: 1,
        runStatus: "failed",
      }],
    })
    const snapshot = await pending
    expect(snapshot.execution.executionKey).toMatch(/^execution-/)
    expect(snapshot.execution.terminal).toBe(true)
    expect(snapshot.execution.status).toBe("completed")
    expect(snapshot.execution.outcome).toBe("graph-fallback")
    expect(snapshot.execution.finalDelivery).toBe("delivered")
    expect(snapshot.execution.mainResponded).toBe(true)
    expect(snapshot.execution.topologyActivity).toHaveLength(1)
    expect(snapshot.execution.completedRuns).toBe(1)
    expect(snapshot.execution.totalRuns).toBe(1)
    expect(snapshot.execution.topologyActivity[0]?.status).toBe("failed")
    expect(snapshot.executionMutationLocked).toBe(false)
    expect(snapshot.busyReason).toBeNull()
    expect(JSON.stringify(snapshot)).not.toContain("native response")
    store.dispose()
  })
  test("aborts hydration continuation when a synchronous listener disposes the store", async () => {
    const editor = new FakeEditor()
    const store = storeFor(editor)
    store.subscribe(snapshot => {
      if (snapshot.presetId === PRESET_A && snapshot.hydrating && !snapshot.hydrated) store.dispose()
    })
    await expect(store.hydrate(PRESET_A)).rejects.toMatchObject({ code: "DISPOSED" })
  })
  test("aborts hydration when a consent notification listener disposes the store", async () => {
    const editor = new FakeEditor()
    const transport = new FakeTransport({ autoRespondHydration: false })
    const store = storeFor(editor, transport)
    store.subscribe(snapshot => {
      if (Object.keys(snapshot.consent).length > 0) store.dispose()
    })
    const pending = store.hydrate(PRESET_A)
    await settleMicrotasks()
    const request = transport.sent.find((message) => message.type === "hydrate_preset")
    expect(request?.type).toBe("hydrate_preset")
    transport.respondHydration(request?.correlationId ?? "missing", PRESET_A, [], [{
      threadId: "thread-consent-dispose",
      workspaceSource: "native-blocks",
      connectionSourceKey: "main",
      status: "approved",
    }])
    await expect(pending).rejects.toMatchObject({ code: "DISPOSED" })
    expect(store.getSnapshot().presetId).toBeNull()
    expect(store.getSnapshot().consent).toEqual({})
  })
  test("supersedes an older pending execution when a newer started activity arrives", async () => {
    const editor = new FakeEditor()
    const transport = new FakeTransport()
    const store = storeFor(editor, transport)
    await store.hydrate(PRESET_A)
    const send = (executionId: string, phase: "started" | "progress" | "completed", sequence: number, provider: string, extra: Record<string, unknown> = {}): void => {
      transport.respond({
        version: PROTOCOL_VERSION,
        type: "activity",
        correlationId: `activity-${sequence}`,
        sequence,
        payload: {
          executionId,
          presetId: PRESET_A,
          kind: "execution",
          phase,
          terminal: phase === "completed",
          provider,
          ...(phase === "completed" ? { outcome: "graph-fallback", fallbackCauseCategory: "required-typed-run", fallbackCauseCode: "REQUIRED-FAILURE" } : {}),
          ...extra,
        },
      } as BackendActivityResponse)
    }
    send("execution-overlap-a", "started", transport.nextSequence(), "old")
    send("execution-overlap-a", "completed", transport.nextSequence(), "old", { finalDelivery: "pending" })
    send("execution-overlap-b", "started", transport.nextSequence(), "new")
    expect(store.getSnapshot().execution.provider).toBe("new")
    expect(store.getSnapshot().execution.finalDelivery).toBeUndefined()
    expect(store.getSnapshot().executionMutationLocked).toBe(true)
    send("execution-overlap-a", "started", transport.nextSequence(), "stale")
    expect(store.getSnapshot().execution.provider).toBe("new")
    store.dispose()
  })
  test("rejects malformed hydrated execution identities before creating a mutation lock", async () => {
    const editor = new FakeEditor()
    const transport = new FakeTransport({ autoRespondHydration: false })
    const store = storeFor(editor, transport)
    const pending = store.hydrate(PRESET_A)
    await settleMicrotasks()
    const request = transport.sent.find((message) => message.type === "hydrate_preset")
    expect(request?.type).toBe("hydrate_preset")
    transport.respondHydration(request?.correlationId ?? "missing", PRESET_A, [], [], {
      executionId: "x".repeat(129),
      presetId: PRESET_A,
      kind: "graph",
      phase: "progress",
      terminal: false,
    })
    await expect(pending).rejects.toMatchObject({ code: "INVALID_HYDRATION" })
    expect(store.getSnapshot().executionMutationLocked).toBe(false)
    store.dispose()
  })
  test("retains bounded cumulative usage across missing updates and resets for a new execution", async () => {
    const editor = new FakeEditor()
    const transport = new FakeTransport()
    const store = storeFor(editor, transport)
    await store.hydrate(PRESET_A)
    transport.respond({
      version: PROTOCOL_VERSION,
      type: "activity",
      correlationId: "activity-usage-start",
      sequence: transport.nextSequence(),
      payload: {
        executionId: "execution-usage-a",
        presetId: PRESET_A,
        kind: "execution",
        phase: "started",
        terminal: false,
        runStatus: "running",
        usage: { input: 100, output: 40, total: 140 },
      },
    })
    transport.respond({
      version: PROTOCOL_VERSION,
      type: "activity",
      correlationId: "activity-usage-run",
      sequence: transport.nextSequence(),
      payload: {
        executionId: "execution-usage-a",
        presetId: PRESET_A,
        kind: "run-settled",
        phase: "progress",
        terminal: false,
        runStatus: "completed",
        usage: { input: 130, output: 50, total: 180 },
      },
    })
    transport.respond({
      version: PROTOCOL_VERSION,
      type: "activity",
      correlationId: "activity-usage-failed",
      sequence: transport.nextSequence(),
      payload: {
        executionId: "execution-usage-a",
        presetId: PRESET_A,
        kind: "run-settled",
        phase: "progress",
        terminal: false,
        runStatus: "failed",
      },
    })
    transport.respond({
      version: PROTOCOL_VERSION,
      type: "activity",
      correlationId: "activity-usage-terminal",
      sequence: transport.nextSequence(),
      payload: {
        executionId: "execution-usage-a",
        presetId: PRESET_A,
        kind: "execution-terminal",
        phase: "completed",
        terminal: true,
        outcome: "success",
      },
    })
    const completed = store.getSnapshot()
    expect(completed.execution.status).toBe("completed")
    expect(completed.execution.usage).toEqual({ input: 130, output: 50, total: 180 })
    expect(completed.execution.activity.map((entry) => entry.status)).toEqual(["running", "completed", "failed", "completed"])
    transport.respond({
      version: PROTOCOL_VERSION,
      type: "activity",
      correlationId: "activity-usage-new",
      sequence: transport.nextSequence(),
      payload: {
        executionId: "execution-usage-b",
        presetId: PRESET_A,
        kind: "execution",
        phase: "started",
        terminal: false,
        runStatus: "running",
      },
    })
    const next = store.getSnapshot()
    expect(next.execution.executionKey).not.toBe(completed.execution.executionKey)
    expect(next.execution.usage).toBeUndefined()
    expect(next.execution.activity).toHaveLength(1)
    store.dispose()
  })
  test("retains monotonic per-run topology statuses beyond the bounded inspector history", async () => {
    const editor = new FakeEditor()
    const transport = new FakeTransport()
    const store = storeFor(editor, transport)
    await store.hydrate(PRESET_A)

    const respondActivity = (
      correlationId: string,
      phase: "started" | "progress",
      runIndex: number,
      runStatus: "pending" | "running" | "completed" | "failed" | "cancelled" | "timed-out" | "skipped",
    ): void => {
      transport.respond({
        version: PROTOCOL_VERSION,
        type: "activity",
        correlationId,
        sequence: transport.nextSequence(),
        payload: {
          executionId: "execution-topology",
          presetId: PRESET_A,
          kind: "run",
          phase,
          terminal: false,
          stageIndex: 0,
          stageCount: 1,
          runIndex,
          runCount: 64,
          runStatus,
        },
      })
    }

    respondActivity("topology-start", "started", 0, "running")
    respondActivity("topology-completed", "progress", 0, "completed")
    respondActivity("topology-failed", "progress", 1, "failed")
    for (let runIndex = 2; runIndex < 42; runIndex += 1) {
      respondActivity(`topology-later-${runIndex}`, "progress", runIndex, "running")
    }

    const bounded = store.getSnapshot().execution
    expect(bounded.activity).toHaveLength(32)
    expect(bounded.topologyActivity).toHaveLength(42)
    expect(bounded.topologyActivity.find((entry) => entry.runIndex === 0)?.status).toBe("completed")
    expect(bounded.topologyActivity.find((entry) => entry.runIndex === 1)?.status).toBe("failed")

    respondActivity("topology-downgrade", "progress", 2, "pending")
    respondActivity("topology-conflicting-terminal", "progress", 0, "failed")
    respondActivity("topology-conflicting-terminal-2", "progress", 1, "completed")
    const guarded = store.getSnapshot().execution
    expect(guarded.topologyActivity.find((entry) => entry.runIndex === 0)?.status).toBe("completed")
    expect(guarded.topologyActivity.find((entry) => entry.runIndex === 1)?.status).toBe("failed")
    expect(guarded.topologyActivity.find((entry) => entry.runIndex === 2)?.status).toBe("running")
    expect(guarded.activity.at(-1)?.status).toBe("completed")
    store.dispose()
  })
  test("preserves current run context when a terminal activity omits indexed fields", async () => {
    const editor = new FakeEditor()
    const transport = new FakeTransport()
    const store = storeFor(editor, transport)
    await store.hydrate(PRESET_A)

    transport.respond({
      version: PROTOCOL_VERSION,
      type: "activity",
      correlationId: "terminal-context-start",
      sequence: transport.nextSequence(),
      payload: {
        executionId: "execution-terminal-context",
        presetId: PRESET_A,
        kind: "run",
        phase: "started",
        terminal: false,
        provider: "safe-provider",
        model: "safe-model",
        stageIndex: 1,
        stageCount: 2,
        runIndex: 3,
        runCount: 4,
        completedRuns: 2,
        totalRuns: 4,
        remainingBudgetMs: 9_000,
        runStatus: "running",
        usage: { input: 10, output: 3, total: 13 },
      },
    })
    transport.respond({
      version: PROTOCOL_VERSION,
      type: "activity",
      correlationId: "terminal-context-progress",
      sequence: transport.nextSequence(),
      payload: {
        executionId: "execution-terminal-context",
        presetId: PRESET_A,
        kind: "run",
        phase: "progress",
        terminal: false,
        stageIndex: 1,
        stageCount: 2,
        runIndex: 3,
        runCount: 4,
        completedRuns: 3,
        totalRuns: 4,
        remainingBudgetMs: 7_000,
        runStatus: "running",
        usage: { input: 20, output: 6, total: 26 },
      },
    })
    transport.respond({
      version: PROTOCOL_VERSION,
      type: "activity",
      correlationId: "terminal-context-failed",
      sequence: transport.nextSequence(),
      payload: {
        executionId: "execution-terminal-context",
        presetId: PRESET_A,
        kind: "execution-terminal",
        phase: "failed",
        terminal: true,
        outcome: "selected-final-failure",
        errorCategory: "provider",
        errorMessageKey: "PROVIDER_FAILURE",
      },
    })

    const snapshot = store.getSnapshot()
    expect(snapshot.execution.status).toBe("failed")
    expect(snapshot.execution.terminal).toBe(true)
    expect(snapshot.busy).toBe(false)
    expect(snapshot.busyReason).toBe(null)
    expect(snapshot.executionMutationLocked).toBe(false)
    expect(snapshot.execution.stageIndex).toBe(1)
    expect(snapshot.execution.stageCount).toBe(2)
    expect(snapshot.execution.runIndex).toBe(3)
    expect(snapshot.execution.runCount).toBe(4)
    expect(snapshot.execution.provider).toBe("safe-provider")
    expect(snapshot.execution.model).toBe("safe-model")
    expect(snapshot.execution.completedRuns).toBe(3)
    expect(snapshot.execution.totalRuns).toBe(4)
    expect(snapshot.execution.remainingBudgetMs).toBe(7_000)
    expect(snapshot.execution.usage).toEqual({ input: 20, output: 6, total: 26 })
    expect(snapshot.execution.outcome).toBe("selected-final-failure")
    expect(snapshot.execution.errorCategory).toBe("provider")
    expect(snapshot.execution.errorMessageKey).toBe("PROVIDER_FAILURE")
    expect(snapshot.execution.activity.at(-1)).toMatchObject({
      phase: "failed",
      status: "failed",
      errorCategory: "provider",
      errorMessageKey: "PROVIDER_FAILURE",
      stageIndex: 1,
      runIndex: 3,
      provider: "safe-provider",
      model: "safe-model",
    })
    store.dispose()
  })
  test("retains bounded settlement fields across pending and authoritative delivery updates", async () => {
    const editor = new FakeEditor()
    const transport = new FakeTransport()
    const store = storeFor(editor, transport)
    await store.hydrate(PRESET_A)

    const send = (
      executionId: string,
      payload: Omit<BackendActivityResponse["payload"], "executionId" | "presetId">,
    ): void => {
      const sequence = transport.nextSequence()
      transport.respond(createBackendActivityResponse({
        correlationId: "550e8400-e29b-41d4-a716-446655440099",
        sequence,
        executionId,
        presetId: PRESET_A,
        ...payload,
      }))
    }
    const pendingFallback = {
      outcome: "graph-fallback" as const,
      fallbackCauseCategory: "required-typed-run" as const,
      fallbackCauseCode: "REQUIRED-FAILURE",
      finalDelivery: "pending" as const,
    }
    const deliveredExecutionId = "550e8400-e29b-41d4-a716-446655440011"
    const notDeliveredExecutionId = "550e8400-e29b-41d4-a716-446655440012"

    send(deliveredExecutionId, {
      kind: "graph",
      phase: "started",
      terminal: false,
      provider: "safe-provider",
      model: "safe-model",
      stageIndex: 1,
      stageCount: 2,
      runIndex: 0,
      runCount: 1,
      completedRuns: 0,
      totalRuns: 1,
      runStatus: "running",
    })
    send(deliveredExecutionId, {
      kind: "run-settled",
      phase: "progress",
      terminal: false,
      stageIndex: 1,
      stageCount: 2,
      runIndex: 0,
      runCount: 1,
      runStatus: "failed",
      runErrorCategory: "provider",
    })
    send(deliveredExecutionId, {
      kind: "execution-terminal",
      phase: "completed",
      terminal: true,
      ...pendingFallback,
    })
    const pending = store.getSnapshot()
    const failedRun = pending.execution.activity.find((activity) => activity.kind === "run-settled")
    expect(failedRun).toMatchObject({
      status: "failed",
      runErrorCategory: "provider",
      errorCategory: "provider",
      stageIndex: 1,
      runIndex: 0,
    })
    expect(pending.execution).toMatchObject({
      kind: "execution-terminal",
      stageIndex: 1,
      stageCount: 2,
      runIndex: 0,
      runCount: 1,
      outcome: "graph-fallback",
      fallbackCauseCategory: "required-typed-run",
      fallbackCauseCode: "REQUIRED-FAILURE",
      finalDelivery: "pending",
    })
    expect(pending.execution.mainResponded).toBeUndefined()
    const pendingExecutionKey = pending.execution.executionKey
    if (pendingExecutionKey === null) throw new Error("pending execution key missing")
    await expect(store.viewResponse(pendingExecutionKey)).rejects.toThrow()
    expect(pending.execution.topologyActivity.find((activity) => activity.runIndex === 0)?.status).toBe("failed")

    send(deliveredExecutionId, {
      kind: "delivery-settled",
      phase: "completed",
      terminal: true,
      ...pendingFallback,
      finalDelivery: "delivered",
      mainResponded: true,
    })
    const delivered = store.getSnapshot()
    const deliveredActivityLength = delivered.execution.activity.length
    expect(delivered.execution).toMatchObject({
      kind: "delivery-settled",
      stageIndex: 1,
      runIndex: 0,
      outcome: "graph-fallback",
      fallbackCauseCategory: "required-typed-run",
      fallbackCauseCode: "REQUIRED-FAILURE",
      finalDelivery: "delivered",
      mainResponded: true,
    })
    expect(delivered.execution.topologyActivity.find((activity) => activity.runIndex === 0)?.status).toBe("failed")
    const deliveredExecutionKey = delivered.execution.executionKey
    if (deliveredExecutionKey === null) throw new Error("delivered execution key missing")
    const viewRequest = store.viewResponse(deliveredExecutionKey)
    const sentView = transport.sent.at(-1)
    expect(sentView).toMatchObject({
      type: "view_response",
      payload: { presetId: PRESET_A, executionId: deliveredExecutionId },
    })
    const viewResponse: BackendViewResponseResponse = {
      version: PROTOCOL_VERSION,
      type: "view_response",
      correlationId: sentView?.correlationId ?? "view-response",
      sequence: transport.nextSequence(),
      payload: { presetId: PRESET_A, executionId: deliveredExecutionId },
    }
    transport.respond(viewResponse)
    await expect(viewRequest).resolves.toBeUndefined()
    send(deliveredExecutionId, {
      kind: "delivery-settled",
      phase: "completed",
      terminal: true,
      outcome: "graph-fallback",
      fallbackCauseCategory: "required-typed-run",
      fallbackCauseCode: "REQUIRED-FAILURE",
      finalDelivery: "delivered",
      mainResponded: true,
    })
    expect(store.getSnapshot().execution.activity).toHaveLength(deliveredActivityLength)
    send(deliveredExecutionId, {
      kind: "delivery-settled",
      phase: "completed",
      terminal: true,
      outcome: "graph-fallback",
      fallbackCauseCategory: "required-typed-run",
      fallbackCauseCode: "REQUIRED-FAILURE",
      finalDelivery: "pending",
    })
    send(deliveredExecutionId, {
      kind: "delivery-settled",
      phase: "completed",
      terminal: true,
      outcome: "graph-fallback",
      fallbackCauseCategory: "required-typed-run",
      fallbackCauseCode: "REQUIRED-FAILURE",
      finalDelivery: "not-delivered",
      mainResponded: false,
    })
    expect(store.getSnapshot().execution.activity).toHaveLength(deliveredActivityLength)
    expect(store.getSnapshot().execution.finalDelivery).toBe("delivered")

    send(notDeliveredExecutionId, {
      kind: "graph",
      phase: "started",
      terminal: false,
      stageIndex: 0,
      stageCount: 1,
      runIndex: 0,
      runCount: 1,
      runStatus: "running",
    })
    send(notDeliveredExecutionId, {
      kind: "run-settled",
      phase: "progress",
      terminal: false,
      stageIndex: 0,
      stageCount: 1,
      runIndex: 0,
      runCount: 1,
      runStatus: "failed",
      runErrorCategory: "timeout",
    })
    send(notDeliveredExecutionId, {
      kind: "execution-terminal",
      phase: "completed",
      terminal: true,
      ...pendingFallback,
    })
    send(notDeliveredExecutionId, {
      kind: "delivery-settled",
      phase: "completed",
      terminal: true,
      outcome: "graph-fallback",
      fallbackCauseCategory: "required-typed-run",
      fallbackCauseCode: "REQUIRED-FAILURE",
      finalDelivery: "not-delivered",
      mainResponded: false,
    })
    const notDelivered = store.getSnapshot()
    expect(notDelivered.execution.finalDelivery).toBe("not-delivered")
    expect(notDelivered.execution.mainResponded).toBe(false)
    expect(notDelivered.execution.topologyActivity.find((activity) => activity.runIndex === 0)?.status).toBe("failed")
    store.dispose()
  })
  test("invalidates topology after local terminal edits and clean external active-run changes", async () => {
    const editor = new FakeEditor()
    const transport = new FakeTransport()
    const store = storeFor(editor, transport)
    await store.hydrate(PRESET_A)

    const respond = (executionId: string, phase: "started" | "progress" | "completed", terminal: boolean, runIndex: number, runStatus: "running" | "completed"): void => {
      transport.respond({
        version: PROTOCOL_VERSION,
        type: "activity",
        correlationId: `${executionId}-${phase}-${runIndex}`,
        sequence: transport.nextSequence(),
        payload: {
          executionId,
          presetId: PRESET_A,
          kind: "run",
          phase,
          terminal,
          stageIndex: 0,
          stageCount: 1,
          runIndex,
          runCount: 1,
          runStatus,
          ...(phase === "completed" ? { outcome: "success" as const } : {}),
        },
      })
    }

    respond("execution-terminal-topology", "started", false, 0, "running")
    respond("execution-terminal-topology", "progress", false, 0, "completed")
    transport.respond({
      version: PROTOCOL_VERSION,
      type: "activity",
      correlationId: "execution-terminal-topology-terminal",
      sequence: transport.nextSequence(),
      payload: {
        executionId: "execution-terminal-topology",
        presetId: PRESET_A,
        kind: "execution",
        phase: "completed",
        terminal: true,
        outcome: "success",
      },
    })
    const terminal = store.getSnapshot()
    expect(terminal.execution.topologyApplicable).toBe(true)
    expect(terminal.execution.topologyActivity[0]?.status).toBe("completed")

    store.updateConfig((config) => ({ ...config, activeMode: "parallel" }))
    const edited = store.getSnapshot()
    expect(edited.execution.topologyApplicable).toBe(false)
    expect(edited.execution.topologyActivity).toEqual([])
    expect(edited.execution.activity.at(-1)?.status).toBe("completed")
    await store.flush()
    expect(store.getSnapshot().dirty).toBe(false)

    respond("execution-after-edit", "started", false, 0, "running")
    const fresh = store.getSnapshot()
    expect(fresh.execution.topologyApplicable).toBe(true)
    expect(fresh.execution.topologyActivity).toHaveLength(1)
    expect(fresh.execution.topologyActivity[0]?.status).toBe("running")

    editor.switchPreset(PRESET_A, graphConfig("sequential"))
    const externallyChanged = store.getSnapshot()
    expect(externallyChanged.config?.activeMode).toBe("sequential")
    expect(externallyChanged.execution.topologyApplicable).toBe(false)
    expect(externallyChanged.execution.topologyActivity).toEqual([])

    respond("execution-after-edit", "progress", false, 0, "running")
    const laterProgress = store.getSnapshot()
    expect(laterProgress.execution.activity.at(-1)?.phase).toBe("progress")
    expect(laterProgress.execution.topologyApplicable).toBe(false)
    expect(laterProgress.execution.topologyActivity).toEqual([])
    store.dispose()
  })
  test("hydrates safe binding and consent views without raw metadata or revisions", async () => {
    const editor = new FakeEditor()
    const transport = new FakeTransport({ autoRespondHydration: false })
    const store = storeFor(editor, transport)
    const pending = store.hydrate(PRESET_A)
    await settleMicrotasks()
    const request = transport.sent.find((message) => message.type === "hydrate_preset")
    expect(request?.type).toBe("hydrate_preset")
    transport.respondHydration(request?.correlationId ?? "missing", PRESET_A, [{
      slotId: "slot",
      bound: true,
      status: "bound",
      descriptor: { label: "Primary", provider: "openai", model: "gpt-5" },
    }, {
      slotId: "stale-slot",
      bound: true,
      status: "stale",
    }], [{
      threadId: THREAD_ID,
      workspaceSource: "main-context",
      connectionSourceKey: "main",
      status: "approved",
      destination: { label: "Primary", provider: "openai", model: "gpt-5" },
      disclosure: { version: 1, summary: "Thread input", categories: ["thread", "workspace", "source", "destination", "provider", "model", "main-context", "input-bindings", "prior-stage-outputs"] },
    }])
    const snapshot = await pending
    expect(snapshot.connectionBindings.slot).toEqual({ slotId: "slot", bound: true, status: "bound", descriptor: { label: "Primary", provider: "openai", model: "gpt-5" } })
    expect(snapshot.connectionBindings["stale-slot"]).toEqual({ slotId: "stale-slot", bound: true, status: "stale" })
    expect(Object.values(snapshot.consent)[0]).toMatchObject({ threadId: THREAD_ID, status: "approved", destination: { label: "Primary" } })
    expect(Object.prototype.hasOwnProperty.call(snapshot, "raw")).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(snapshot.decoded ?? {}, "raw")).toBe(false)
    expect(JSON.stringify(snapshot)).not.toContain("dispatchRevision")
    store.dispose()
  })
  test("restarts same-preset hydration after an external draft update", async () => {
    const editor = new FakeEditor()
    const transport = new FakeTransport({ autoRespondConnections: false, autoRespondHydration: false })
    const store = storeFor(editor, transport)
    const firstHydration = store.hydrate(PRESET_A)
    void firstHydration.catch(() => {})
    await settleMicrotasks()
    const firstRequest = transport.sent.find((message) => message.type === "hydrate_preset")
    expect(firstRequest?.type).toBe("hydrate_preset")
    editor.switchPreset(PRESET_A, graphConfig("parallel"))
    await settleMicrotasks()
    const hydrationRequests = transport.sent.filter((message) => message.type === "hydrate_preset")
    const secondRequest = hydrationRequests.at(-1)
    expect(hydrationRequests.length).toBe(2)
    expect(secondRequest?.type).toBe("hydrate_preset")
    transport.respondHydration(firstRequest?.correlationId ?? "missing", PRESET_A)
    await expect(firstHydration).rejects.toMatchObject({ code: "STALE_OPERATION" })
    transport.respondHydration(secondRequest?.correlationId ?? "missing", PRESET_A)
    await settleMicrotasks()
    expect(store.getSnapshot().config?.activeMode).toBe("parallel")
    expect(store.getSnapshot().hydrated).toBe(true)
    store.dispose()
  })
  test("notifies subscribers when the active preset is cleared", async () => {
    const editor = new FakeEditor()
    const transport = new FakeTransport()
    const store = storeFor(editor, transport)
    await store.hydrate(PRESET_A)
    transport.respond({
      version: PROTOCOL_VERSION,
      type: "activity",
      correlationId: "activity-clear-start",
      sequence: transport.nextSequence(),
      payload: { executionId: "execution-clear", presetId: PRESET_A, kind: "graph", phase: "started", terminal: false },
    })
    expect(store.getSnapshot().busyReason).toBe("execution")
    let notifications = 0
    const unsubscribe = store.subscribe(() => { notifications += 1 })
    editor.switchPreset(null, null)
    expect(notifications).toBe(1)
    expect(store.getSnapshot().presetId).toBe(null)
    expect(store.getSnapshot().config).toBe(null)
    expect(store.getSnapshot().busy).toBe(false)
    expect(store.getSnapshot().busyReason).toBe(null)
    unsubscribe()
    store.dispose()
  })
  test("restarts hydration when a subscriber changes the same draft during hydration notification", async () => {
    const editor = new FakeEditor()
    const transport = new FakeTransport({ autoRespondConnections: false, autoRespondHydration: false })
    const store = storeFor(editor, transport)
    let changed = false
    store.subscribe((snapshot) => {
      if (!changed && snapshot.hydrating) {
        changed = true
        editor.switchPreset(PRESET_A, graphConfig("parallel"))
      }
    })
    const firstHydration = store.hydrate(PRESET_A)
    void firstHydration.catch(() => {})
    await settleMicrotasks()
    const hydrationRequests = transport.sent.filter((message) => message.type === "hydrate_preset")
    expect(hydrationRequests.length).toBe(1)
    const replacementRequest = hydrationRequests[0]
    expect(replacementRequest?.type).toBe("hydrate_preset")
    await expect(firstHydration).rejects.toMatchObject({ code: "STALE_OPERATION" })
    transport.respondHydration(replacementRequest?.correlationId ?? "missing", PRESET_A)
    await settleMicrotasks()
    expect(store.getSnapshot().config?.activeMode).toBe("parallel")
    store.dispose()
  })
  test("rejects delayed hydration from an old preset without replacing current safe state", async () => {
    const editor = new FakeEditor()
    const transport = new FakeTransport({ autoRespondConnections: false, autoRespondHydration: false })
    const store = storeFor(editor, transport)
    const oldHydration = store.hydrate(PRESET_A)
    await settleMicrotasks()
    const oldRequest = transport.sent.find((message) => message.type === "hydrate_preset")
    expect(oldRequest?.type).toBe("hydrate_preset")

    editor.state = { presetId: PRESET_B, metadata: graphConfig("parallel") }
    const currentHydration = store.hydrate(PRESET_B)
    await settleMicrotasks()
    const hydrationRequests = transport.sent.filter((message) => message.type === "hydrate_preset")
    const currentRequest = hydrationRequests.at(-1)
    expect(currentRequest?.type).toBe("hydrate_preset")
    transport.respondHydration(currentRequest?.correlationId ?? "missing", PRESET_B)
    await currentHydration
    transport.respondHydration(oldRequest?.correlationId ?? "missing", PRESET_A, [{
      slotId: "old-slot",
      bound: true,
      descriptor: { label: "Old", provider: "old-provider", model: "old-model" },
    }])
    await expect(oldHydration).rejects.toMatchObject({ code: "STALE_OPERATION" })
    expect(store.getSnapshot().presetId).toBe(PRESET_B)
    expect(store.getSnapshot().connectionBindings).toEqual({})
    store.dispose()
  })
  test("rejects stale binding, consent, trace, cancellation, and activity continuations", async () => {
    const editor = new FakeEditor()
    const transport = new FakeTransport()
    const store = storeFor(editor, transport)
    await store.hydrate(PRESET_A)

    await store.refreshConnections()
    const bindingSelector = "slot"
    const firstBind = store.bindConnection(bindingSelector, "connection-1")
    const firstBindRequest = transport.sent.filter((message) => message.type === "bind_slot").at(-1)
    const secondBind = store.bindConnection(bindingSelector, "connection-2")
    const secondBindRequest = transport.sent.filter((message) => message.type === "bind_slot").at(-1)
    expect(firstBindRequest?.type).toBe("bind_slot")
    expect(secondBindRequest?.type).toBe("bind_slot")
    transport.respond({
      version: PROTOCOL_VERSION,
      type: "binding",
      correlationId: secondBindRequest?.correlationId ?? "missing",
      sequence: transport.nextSequence(),
      payload: { presetId: PRESET_A, slotId: bindingSelector, bound: true, status: "stale" },
    })
    await secondBind
    transport.respond({
      version: PROTOCOL_VERSION,
      type: "binding",
      correlationId: firstBindRequest?.correlationId ?? "missing",
      sequence: transport.nextSequence(),
      payload: { presetId: PRESET_A, slotId: bindingSelector, bound: true, status: "bound", descriptor: { label: "Old", provider: "old-provider", model: "old-model" } },
    })
    await expect(firstBind).rejects.toMatchObject({ code: "STALE_OPERATION" })
    expect(store.getSnapshot().connectionBindings.slot).toEqual({ slotId: bindingSelector, bound: true, status: "stale" })
    const firstUnbind = store.unbindConnection(bindingSelector)
    const firstUnbindRequest = transport.sent.filter((message) => message.type === "unbind_slot").at(-1)
    const secondUnbind = store.unbindConnection(bindingSelector)
    const secondUnbindRequest = transport.sent.filter((message) => message.type === "unbind_slot").at(-1)
    transport.respond({
      version: PROTOCOL_VERSION,
      type: "binding",
      correlationId: secondUnbindRequest?.correlationId ?? "missing",
      sequence: transport.nextSequence(),
      payload: { presetId: PRESET_A, slotId: bindingSelector, bound: false, status: "missing" },
    })
    await secondUnbind
    transport.respond({
      version: PROTOCOL_VERSION,
      type: "binding",
      correlationId: firstUnbindRequest?.correlationId ?? "missing",
      sequence: transport.nextSequence(),
      payload: { presetId: PRESET_A, slotId: bindingSelector, bound: true, status: "stale" },
    })
    await expect(firstUnbind).rejects.toMatchObject({ code: "STALE_OPERATION" })
    expect(store.getSnapshot().connectionBindings.slot).toEqual({ slotId: bindingSelector, bound: false, status: "missing" })

    const selector = { presetId: PRESET_A, threadId: THREAD_ID, workspaceSource: "main-context" as const, connectionSourceKey: "main" as const }
    const approve = store.approveConsent(selector)
    const revoke = store.revokeConsent(selector)
    const consentRequests = transport.sent.filter((message) => message.type === "approve_consent" || message.type === "revoke_consent")
    const approveRequest = consentRequests.find((message) => message.type === "approve_consent")
    const revokeRequest = consentRequests.find((message) => message.type === "revoke_consent")
    transport.respond({
      version: PROTOCOL_VERSION,
      type: "consent",
      correlationId: revokeRequest?.correlationId ?? "missing",
      sequence: transport.nextSequence(),
      payload: { ...selector, status: "revoked", destination: { label: "New", provider: "new-provider", model: "new-model" }, disclosure: { version: 1, summary: "Thread input", categories: ["thread", "workspace", "source", "destination", "provider", "model", "main-context", "input-bindings", "prior-stage-outputs"] } },
    })
    await revoke
    transport.respond({
      version: PROTOCOL_VERSION,
      type: "consent",
      correlationId: approveRequest?.correlationId ?? "missing",
      sequence: transport.nextSequence(),
      payload: { ...selector, status: "approved", destination: { label: "Old", provider: "old-provider", model: "old-model" }, disclosure: { version: 1, summary: "Thread input", categories: ["thread", "workspace", "source", "destination", "provider", "model", "input-bindings", "prior-stage-outputs", "main-context"] } },
    })
    await expect(approve).rejects.toMatchObject({ code: "STALE_OPERATION" })
    expect(Object.values(store.getSnapshot().consent)[0]?.status).toBe("revoked")

    const executionA = "execution-a"
    const executionB = "execution-b"
    transport.respond({
      version: PROTOCOL_VERSION,
      type: "activity",
      correlationId: "activity-a-start",
      sequence: transport.nextSequence(),
      payload: { executionId: executionA, presetId: PRESET_A, kind: "graph", phase: "started", terminal: false },
    })
    const traces = store.loadTraces({ executionKey: "execution-1" })
    void traces.catch(() => {})
    const traceRequest = transport.sent.filter((message) => message.type === "list_traces").at(-1)
    if (traceRequest?.type !== "list_traces") throw new Error("list_traces request was not sent")
    const tracePayload = traceRequest.payload
    expect(tracePayload.presetId).toBe(PRESET_A)
    expect(tracePayload.executionId).toBe(executionA)
    const traceExecutionId = tracePayload.executionId
    if (traceExecutionId === undefined) throw new Error("list_traces request omitted executionId")
    const detail = store.loadTrace("trace-a")
    void detail.catch(() => {})
    const cancellation = store.cancelExecution("execution-1", "user")
    void cancellation.catch(() => {})
    const cancellationRequest = transport.sent.filter((message) => message.type === "cancel_execution").at(-1)
    if (cancellationRequest?.type !== "cancel_execution") throw new Error("cancel_execution request was not sent")
    const cancellationPayload = cancellationRequest.payload
    expect(cancellationPayload.presetId).toBe(PRESET_A)
    expect(cancellationPayload.executionId).toBe(executionA)
    transport.respond({
      version: PROTOCOL_VERSION,
      type: "activity",
      correlationId: "activity-a-terminal",
      sequence: transport.nextSequence(),
      payload: { executionId: executionA, presetId: PRESET_A, kind: "graph", phase: "completed", terminal: true, outcome: "success" },
    })
    transport.respond({
      version: PROTOCOL_VERSION,
      type: "activity",
      correlationId: "activity-b-start",
      sequence: transport.nextSequence(),
      payload: { executionId: executionB, presetId: PRESET_A, kind: "graph", phase: "started", terminal: false },
    })
    transport.respond({
      version: PROTOCOL_VERSION,
      type: "activity",
      correlationId: "activity-a-late",
      sequence: transport.nextSequence(),
      payload: { executionId: executionA, presetId: PRESET_A, kind: "graph", phase: "progress", terminal: false },
    })
    transport.respond({
      version: PROTOCOL_VERSION,
      type: "trace",
      correlationId: traceRequest.correlationId,
      sequence: transport.nextSequence(),
      payload: { traces: [{ traceId: "trace-a", executionId: traceExecutionId, presetId: tracePayload.presetId, status: "completed", startedAt: 1, eventCount: 0 }] },
    })
    transport.respond({
      version: PROTOCOL_VERSION,
      type: "cancellation",
      correlationId: cancellationRequest.correlationId,
      sequence: transport.nextSequence(),
      payload: { executionId: cancellationPayload.executionId, presetId: cancellationPayload.presetId, accepted: true, status: "accepted", cancellationSource: "user" },
    })
    await expect(traces).rejects.toMatchObject({ code: "STALE_OPERATION" })
    await expect(detail).rejects.toMatchObject({ code: "STALE_OPERATION" })
    await expect(cancellation).rejects.toMatchObject({ code: "STALE_OPERATION" })
    expect(store.getSnapshot().execution.executionKey).toBe("execution-2")
    expect(store.getSnapshot().execution.terminal).toBe(false)
    transport.respond({
      version: PROTOCOL_VERSION,
      type: "activity",
      correlationId: "activity-b-terminal",
      sequence: transport.nextSequence(),
      payload: { executionId: executionB, presetId: PRESET_A, kind: "graph", phase: "completed", terminal: true, outcome: "success" },
    })
    transport.respond({
      version: PROTOCOL_VERSION,
      type: "activity",
      correlationId: "activity-a-retired-start",
      sequence: transport.nextSequence(),
      payload: { executionId: executionA, presetId: PRESET_A, kind: "graph", phase: "started", terminal: false },
    })
    expect(store.getSnapshot().execution.executionKey).toBe("execution-2")
    expect(store.getSnapshot().execution.terminal).toBe(true)
    store.dispose()
  })
  test("preserves a descriptor when unbind returns a bound status", async () => {
    const editor = new FakeEditor()
    const transport = new FakeTransport()
    const store = storeFor(editor, transport)
    await store.hydrate(PRESET_A)
    const pending = store.unbindConnection("slot")
    const request = transport.sent.filter((message) => message.type === "unbind_slot").at(-1)
    expect(request?.type).toBe("unbind_slot")
    transport.respond({
      version: PROTOCOL_VERSION,
      type: "binding",
      correlationId: request?.correlationId ?? "missing",
      sequence: transport.nextSequence(),
      payload: { presetId: PRESET_A, slotId: "slot", bound: true, status: "bound", descriptor: { label: "Retained", provider: "openai", model: "gpt-5" } },
    })
    await expect(pending).resolves.toEqual({ slotId: "slot", bound: true, status: "bound", descriptor: { label: "Retained", provider: "openai", model: "gpt-5" } })
    expect(store.getSnapshot().connectionBindings.slot).toEqual({ slotId: "slot", bound: true, status: "bound", descriptor: { label: "Retained", provider: "openai", model: "gpt-5" } })
    store.dispose()
  })
  test("retains execution busy state when selection changes", async () => {
    const editor = new FakeEditor()
    const transport = new FakeTransport()
    const store = storeFor(editor, transport)
    await store.hydrate(PRESET_A)
    transport.respond({
      version: PROTOCOL_VERSION,
      type: "activity",
      correlationId: "activity-selection-start",
      sequence: transport.nextSequence(),
      payload: { executionId: "execution-selection", presetId: PRESET_A, kind: "graph", phase: "started", terminal: false },
    })
    expect(store.getSnapshot().busyReason).toBe("execution")
    const refresh = store.refreshConnections()
    await refresh
    expect(store.getSnapshot().busyReason).toBe("execution")
    store.setSelection({ kind: "main" })
    expect(store.getSnapshot().busyReason).toBe("execution")
    expect(store.getSnapshot().busy).toBe(true)
    store.dispose()
  })
  test("locks config and mode mutation during nonterminal execution without staging and unlocks at settlement", async () => {
    const editor = new FakeEditor()
    const transport = new FakeTransport()
    const store = storeFor(editor, transport)
    await store.hydrate(PRESET_A)

    transport.respond({
      version: PROTOCOL_VERSION,
      type: "activity",
      correlationId: "activity-lock-start",
      sequence: transport.nextSequence(),
      payload: { executionId: "execution-lock", presetId: PRESET_A, kind: "graph", phase: "started", terminal: false },
    })
    const running = store.getSnapshot()
    expect(running.executionMutationLocked).toBe(true)
    expect(running.execution.phase).toBe("started")
    const beforeConfig = running.config
    const beforeRevision = running.revision
    const beforeMetadataUpdates = editor.metadataUpdates.length

    let updateError: unknown
    try {
      store.updateConfig((config) => ({ ...config, activeMode: "parallel" }))
    } catch (error) {
      updateError = error
    }
    expect(updateError).toMatchObject({ code: "EXECUTION_LOCKED" })
    await expect(store.setActiveMode("parallel")).rejects.toMatchObject({ code: "EXECUTION_LOCKED" })
    expect(editor.metadataUpdates).toHaveLength(beforeMetadataUpdates)
    expect(store.getSnapshot().config).toEqual(beforeConfig)
    expect(store.getSnapshot().revision).toBe(beforeRevision)

    store.setSelection({ kind: "thread", threadId: THREAD_ID })
    await store.refreshConnections()
    const traces = store.loadTraces()
    const traceRequest = transport.sent.filter((message) => message.type === "list_traces").at(-1)
    expect(traceRequest?.type).toBe("list_traces")
    transport.respond({
      version: PROTOCOL_VERSION,
      type: "trace",
      correlationId: traceRequest?.correlationId ?? "missing",
      sequence: transport.nextSequence(),
      payload: { traces: [] },
    })
    await traces
    expect(store.getSnapshot().selection).toEqual({ kind: "thread", threadId: THREAD_ID })

    transport.respond({
      version: PROTOCOL_VERSION,
      type: "activity",
      correlationId: "activity-lock-progress",
      sequence: transport.nextSequence(),
      payload: { executionId: "execution-lock", presetId: PRESET_A, kind: "execution-draining", phase: "progress", terminal: false },
    })
    expect(store.getSnapshot().executionMutationLocked).toBe(true)
    const drainingMetadataUpdates = editor.metadataUpdates.length
    expect(() => store.updateConfig((config) => ({ ...config, activeMode: "sequential" }))).toThrow()
    await expect(store.setActiveMode("sequential")).rejects.toMatchObject({ code: "EXECUTION_LOCKED" })
    expect(editor.metadataUpdates).toHaveLength(drainingMetadataUpdates)
    transport.respond({
      version: PROTOCOL_VERSION,
      type: "activity",
      correlationId: "activity-lock-terminal",
      sequence: transport.nextSequence(),
      payload: { executionId: "execution-lock", presetId: PRESET_A, kind: "execution-terminal", phase: "completed", terminal: true, outcome: "success" },
    })
    expect(store.getSnapshot().executionMutationLocked).toBe(false)

    store.updateConfig((config) => ({ ...config, activeMode: "parallel" }))
    expect(editor.metadataUpdates.length).toBeGreaterThan(beforeMetadataUpdates)
    await store.flush()
    expect(store.getSnapshot().dirty).toBe(false)
    editor.switchPreset(null, null)
    expect(store.getSnapshot().executionMutationLocked).toBe(false)
    store.dispose()
  })

  test("ignores malformed activity and stale execution identities without changing the phase lock", async () => {
    const editor = new FakeEditor()
    const transport = new FakeTransport()
    const store = storeFor(editor, transport)
    await store.hydrate(PRESET_A)

    transport.respond({
      version: PROTOCOL_VERSION,
      type: "activity",
      correlationId: "activity-malformed-terminal",
      sequence: transport.nextSequence(),
      payload: { executionId: "execution-malformed", presetId: PRESET_A, kind: "graph", phase: "completed", terminal: false } as never,
    })
    expect(store.getSnapshot().executionMutationLocked).toBe(false)
    for (const [correlationId, executionId] of [
      ["activity-missing-key-start", undefined],
      ["activity-empty-key-start", ""],
      ["activity-oversized-key-start", "x".repeat(129)],
      ["activity-control-key-start", "execution-\u0000-lock"],
    ] as const) {
      transport.respond({
        version: PROTOCOL_VERSION,
        type: "activity",
        correlationId,
        sequence: transport.nextSequence(),
        payload: {
          ...(executionId === undefined ? {} : { executionId }),
          presetId: PRESET_A,
          kind: "graph",
          phase: "started",
          terminal: false,
        } as never,
      })
    }
    expect(store.getSnapshot().executionMutationLocked).toBe(false)

    transport.respond({
      version: PROTOCOL_VERSION,
      type: "activity",
      correlationId: "activity-malformed-start",
      sequence: transport.nextSequence(),
      payload: { executionId: "execution-lock", presetId: PRESET_A, kind: "graph", phase: "started", terminal: false },
    })
    expect(store.getSnapshot().executionMutationLocked).toBe(true)
    const lockedRevision = store.getSnapshot().revision

    transport.respond({
      version: PROTOCOL_VERSION,
      type: "activity",
      correlationId: "activity-malformed-progress",
      sequence: transport.nextSequence(),
      payload: { executionId: "execution-lock", presetId: PRESET_A, kind: "graph", phase: "progress", terminal: true } as never,
    })
    for (const [correlationId, executionId] of [
      ["activity-missing-key-terminal", undefined],
      ["activity-empty-key-terminal", ""],
      ["activity-oversized-key-terminal", "x".repeat(129)],
      ["activity-control-key-terminal", "execution-\u0000-lock"],
    ] as const) {
      transport.respond({
        version: PROTOCOL_VERSION,
        type: "activity",
        correlationId,
        sequence: transport.nextSequence(),
        payload: {
          ...(executionId === undefined ? {} : { executionId }),
          presetId: PRESET_A,
          kind: "graph",
          phase: "completed",
          terminal: true,
          outcome: "success",
        } as never,
      })
    }
    transport.respond({
      version: PROTOCOL_VERSION,
      type: "activity",
      correlationId: "activity-stale-terminal",
      sequence: transport.nextSequence(),
      payload: { executionId: "execution-other", presetId: PRESET_A, kind: "graph", phase: "completed", terminal: true, outcome: "success" },
    })
    expect(store.getSnapshot().executionMutationLocked).toBe(true)
    expect(store.getSnapshot().revision).toBe(lockedRevision)

    transport.respond({
      version: PROTOCOL_VERSION,
      type: "activity",
      correlationId: "activity-valid-terminal",
      sequence: transport.nextSequence(),
      payload: { executionId: "execution-lock", presetId: PRESET_A, kind: "graph", phase: "completed", terminal: true, outcome: "success" },
    })
    expect(store.getSnapshot().executionMutationLocked).toBe(false)
    store.dispose()
  })
 
  test("retains the last connection list when an explicit refresh fails", async () => {
    const editor = new FakeEditor()
    const transport = new FakeTransport({ autoRespondConnections: false })
    const store = storeFor(editor, transport)
    await store.hydrate(PRESET_A)

    const discovery = transport.sent.find((message) => message.type === "list_connections")
    expect(discovery?.type).toBe("list_connections")
    transport.respondConnections(discovery?.correlationId ?? "missing", [CONNECTION_A])
    await settleMicrotasks()
    expect(store.getSnapshot().availableConnections).toEqual([{ key: "connection-1", name: CONNECTION_A.name, provider: CONNECTION_A.provider, model: CONNECTION_A.model }])

    const refresh = store.refreshConnections()
    const refreshRequest = transport.sent.filter((message) => message.type === "list_connections").at(-1)
    expect(refreshRequest?.type).toBe("list_connections")
    transport.respond({
      version: PROTOCOL_VERSION,
      type: "error",
      correlationId: refreshRequest?.correlationId ?? "missing",
      payload: { code: "CONNECTIONS_UNAVAILABLE", messageKey: "error.connectionUnavailable", retryable: true },
    })

    await expect(refresh).rejects.toMatchObject({ code: "BACKEND_ERROR" })
    expect(store.getSnapshot().availableConnections).toEqual([{ key: "connection-1", name: CONNECTION_A.name, provider: CONNECTION_A.provider, model: CONNECTION_A.model }])
    store.dispose()
  })

  test("isolates stale background connection responses after navigation", async () => {
    const editor = new FakeEditor()
    const transport = new FakeTransport({ autoRespondConnections: false })
    const store = storeFor(editor, transport)
    await store.hydrate(PRESET_A)
    const firstRequest = transport.sent.filter((message) => message.type === "list_connections")[0]
    expect(firstRequest?.type).toBe("list_connections")

    editor.state = { presetId: PRESET_B, metadata: graphConfig("single") }
    await store.hydrate(PRESET_B)
    const connectionRequests = transport.sent.filter((message) => message.type === "list_connections")
    const secondRequest = connectionRequests.at(-1)
    expect(secondRequest?.type).toBe("list_connections")

    transport.respondConnections(secondRequest?.correlationId ?? "missing", [CONNECTION_B])
    await settleMicrotasks()
    expect(store.getSnapshot().availableConnections).toEqual([{ key: "connection-1", name: CONNECTION_B.name, provider: CONNECTION_B.provider, model: CONNECTION_B.model }])

    transport.respondConnections(firstRequest?.correlationId ?? "missing", [CONNECTION_A])
    await settleMicrotasks()
    expect(store.getSnapshot().presetId).toBe(PRESET_B)
    expect(store.getSnapshot().availableConnections).toEqual([{ key: "connection-1", name: CONNECTION_B.name, provider: CONNECTION_B.provider, model: CONNECTION_B.model }])
    store.dispose()
  })

  test("switches Single, Sequential, and Parallel through persisted draft state", async () => {
    const editor = new FakeEditor()
    const store = storeFor(editor)
    await store.hydrate(PRESET_A)

    expect(await store.setActiveMode("sequential")).toBe(true)
    expect(store.getSnapshot().activeMode).toBe("sequential")
    expect(await store.setActiveMode("parallel")).toBe(true)
    expect(store.getSnapshot().activeMode).toBe("parallel")
    expect(await store.setActiveMode("single")).toBe(true)
    expect(store.getSnapshot().activeMode).toBe("single")
    store.dispose()
  })

  test("coalesces dirty updates behind one flush and keeps a navigation barrier", async () => {
    const editor = new FakeEditor()
    const store = storeFor(editor)
    await store.hydrate(PRESET_A)
    store.updateConfig((config) => ({ ...config, activeMode: "sequential" }))
    store.updateConfig((config) => ({ ...config, activeMode: "parallel" }))
    expect(store.getSnapshot().dirty).toBe(true)
    await store.flush()
    editor.state = { presetId: PRESET_B, metadata: graphConfig("single") }

    await store.hydrate(PRESET_B)

    expect(store.getSnapshot().presetId).toBe(PRESET_B)
    expect(store.getSnapshot().dirty).toBe(false)
    expect(store.getSnapshot().connectionBindings).toEqual({})
    expect(store.getSnapshot().consent).toEqual({})
    expect(store.getSnapshot().traces.summaries).toEqual([])
    store.dispose()
  })
  test("does not mutate local config when staging rejects an inactive editor preset", async () => {
    const editor = new FakeEditor()
    const store = storeFor(editor)
    await store.hydrate(PRESET_A)
    const before = store.getSnapshot()
    editor.state = { presetId: PRESET_B, metadata: graphConfig("single") }
    expect(() => store.updateConfig((config) => ({ ...config, activeMode: "parallel" }))).toThrow()
    const after = store.getSnapshot()
    expect(after.config).toEqual(before.config)
    expect(after.revision).toBe(before.revision)
    expect(after.dirty).toBe(before.dirty)
    store.dispose()
  })

  test("failed mode flush restores the persisted mode and exposes reload state", async () => {
    const editor = new FakeEditor()
    const store = storeFor(editor)
    await store.hydrate(PRESET_A)
    editor.failFlushCount = 1
    editor.blockFlushAt = 2

    let settled = false
    const transition = store.setActiveMode("parallel").then((result) => {
      settled = true
      return result
    })
    await settleMicrotasks()
    await settleMicrotasks()
    expect(settled).toBe(false)
    expect(editor.flushCount).toBe(2)
    editor.releaseFlush()
    expect(await transition).toBe(false)
    expect(store.getSnapshot().activeMode).toBe("single")
    expect(editor.state.metadata).toEqual(graphConfig("single"))
    expect(editor.metadataUpdates.some((metadata) => JSON.stringify(metadata) === JSON.stringify(graphConfig("single")))).toBe(true)
    expect(editor.flushCount).toBeGreaterThan(1)
    expect(store.getSnapshot().saveError).not.toBeNull()
    expect(store.getSnapshot().dirty).toBe(false)
    store.dispose()
  })

  test("restages the persisted draft when flushing an already-selected mode fails", async () => {
    const editor = new FakeEditor()
    const store = storeFor(editor)
    await store.hydrate(PRESET_A)
    store.updateConfig((config) => ({ ...config, activeMode: "parallel" }))
    editor.failFlushCount = 1

    expect(await store.setActiveMode("parallel")).toBe(false)
    expect(editor.state.metadata).toEqual(graphConfig("single"))
    expect(editor.metadataUpdates.some((metadata) => JSON.stringify(metadata) === JSON.stringify(graphConfig("single")))).toBe(true)
    expect(editor.flushCount).toBeGreaterThan(1)
    expect(store.getSnapshot().activeMode).toBe("single")
    expect(store.getSnapshot().dirty).toBe(false)
    store.dispose()
  })

  test("keeps validation and save surfaces locale-neutral", async () => {
    const editor = new FakeEditor()
    const store = storeFor(editor)
    await store.hydrate(PRESET_A)
    editor.failFlush = true

    expect(await store.setActiveMode("parallel")).toBe(false)
    const failed = store.getSnapshot()
    expect(failed.saveError?.message).toEqual({ key: "error.persistConfigFallback" })
    expect(failed.dirty).toBe(true)
    expect(JSON.stringify(failed.saveError)).not.toContain("editor flush failed")
    expect(Object.isFrozen(failed.saveError?.message)).toBe(true)
    store.dispose()

    const invalidEditor = new FakeEditor()
    invalidEditor.state = { presetId: PRESET_A, metadata: { schemaVersion: 1, supportedModes: ["single"], activeMode: "single" } }
    const invalidStore = storeFor(invalidEditor)
    const invalid = await invalidStore.hydrate(PRESET_A)
    expect(invalid.decoded?.issues.some((issue) => Object.prototype.hasOwnProperty.call(issue, "message"))).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(invalid.modeIssues.single[0] ?? {}, "message")).toBe(false)
    expect(invalid.blockedReasons.every((reason) => typeof reason.key === "string")).toBe(true)
    expect(JSON.stringify(invalid)).not.toContain("Expected a plain")
    invalidStore.dispose()
  })

  test("keeps invalid hydrated config repairable while mode activation stays fail-closed", async () => {
    const editor = new FakeEditor()
    editor.state = { presetId: PRESET_A, metadata: { schemaVersion: 1, supportedModes: ["single"], activeMode: "single" } }
    const store = storeFor(editor)
    const invalid = await store.hydrate(PRESET_A)

    expect(invalid.decoded?.status).toBe("invalid")
    expect(invalid.decoded?.config).toBe(null)
    expect(invalid.config).toEqual(createDefaultApcConfig())
    expect(invalid.blockedReasons).toEqual([])
    expect(invalid.modeAvailability.single.valid).toBe(false)
    expect(await store.setActiveMode("parallel")).toBe(false)

    const repaired = store.updateConfig(() => graphConfig("single"))
    expect(repaired.decoded?.status).toBe("valid")
    expect(repaired.dirty).toBe(true)
    expect(repaired.blockedReasons).toEqual([])
    await store.flush()
    expect(store.getSnapshot().dirty).toBe(false)
    expect(store.getSnapshot().decoded?.status).toBe("valid")
    store.dispose()
  })

  test("switches away from an invalid active mode without locking local run repair", async () => {
    const editor = new FakeEditor()
    const invalidActive = graphConfig("parallel")
    invalidActive.pipelines.parallel!.stages[0]!.runs[0]!.required = false
    editor.state = { presetId: PRESET_A, metadata: invalidActive }
    const store = storeFor(editor)
    const snapshot = await store.hydrate(PRESET_A)

    expect(snapshot.decoded?.status).toBe("valid")
    expect(snapshot.activeMode).toBe("parallel")
    expect(snapshot.modeAvailability.parallel.valid).toBe(false)
    expect(snapshot.modeIssues.parallel.length).toBeGreaterThan(0)
    expect(snapshot.blockedReasons).toEqual([])
    expect(await store.setActiveMode("parallel")).toBe(false)
    expect(await store.setActiveMode("single")).toBe(true)
    expect(store.getSnapshot().activeMode).toBe("single")
    store.dispose()
  })

  test("hard-locks a dirty view after an external same-preset draft change until hydration", async () => {
    const editor = new FakeEditor()
    const store = storeFor(editor)
    await store.hydrate(PRESET_A)
    store.updateConfig((config) => ({ ...config, activeMode: "sequential" }))
    expect(store.getSnapshot().dirty).toBe(true)

    editor.switchPreset(PRESET_A, graphConfig("parallel"))

    expect(store.getSnapshot().stale).toBe(true)
    expect(store.getSnapshot().config?.activeMode).toBe("sequential")
    expect(store.getSnapshot().blockedReasons).toEqual([{ key: "error.staleConfigReload" }])
    expect(() => store.updateConfig((config) => ({ ...config, activeMode: "single" }))).toThrow()
    expect(await store.setActiveMode("single")).toBe(false)
    await expect(store.flush()).rejects.toMatchObject({ code: "STALE_OPERATION" })
    expect((editor.state.metadata as ApcPresetConfigV1).activeMode).toBe("parallel")

    const reloaded = await store.hydrate(PRESET_A)
    expect(reloaded.stale).toBe(false)
    expect(reloaded.activeMode).toBe("parallel")
    store.dispose()
  })

  test("projects current-execution trace summaries and rejects cross-preset stale responses", async () => {
    const editor = new FakeEditor()
    const transport = new FakeTransport()
    const store = storeFor(editor, transport)
    await store.hydrate(PRESET_A)

    const executionId = "550e8400-e29b-41d4-a716-446655440020"
    const traceId = "550e8400-e29b-41d4-a716-446655440021"
    transport.respond(createBackendActivityResponse({
      correlationId: "550e8400-e29b-41d4-a716-446655440022",
      sequence: transport.nextSequence(),
      executionId,
      presetId: PRESET_A,
      kind: "execution",
      phase: "started",
      terminal: false,
      traceId,
      provider: "safe-provider",
      model: "safe-model",
      stageIndex: 0,
      stageCount: 1,
      runIndex: 0,
      runCount: 1,
      runStatus: "running",
    }))
    const executionKey = store.getSnapshot().execution.executionKey
    expect(executionKey).toBe("execution-1")
    if (executionKey === null) throw new Error("Expected an active execution")

    const pending = store.loadTraces({ executionKey })
    const listRequest = transport.sent.filter((message) => message.type === "list_traces").at(-1)
    if (listRequest?.type !== "list_traces") throw new Error("list_traces request was not sent")
    expect(listRequest.payload).toEqual({ presetId: PRESET_A, executionId })
    transport.respond({
      version: PROTOCOL_VERSION,
      type: "trace",
      correlationId: listRequest.correlationId,
      sequence: transport.nextSequence(),
      payload: {
        traces: [{
          traceId,
          executionId,
          presetId: PRESET_A,
          status: "completed",
          startedAt: 1_000,
          finishedAt: 2_000,
          eventCount: 1,
          preview: "Safe trace summary",
        }],
      },
    })
    const traces = await pending
    const summary = traces.summaries[0]
    if (summary === undefined) throw new Error("Expected a trace summary")
    expect(summary.status).toBe("completed")
    expect(summary.eventCount).toBe(1)
    expect(Object.prototype.hasOwnProperty.call(summary, "preview")).toBe(false)
    expect(summary.key).not.toContain(traceId)
    expect(summary.key).not.toContain(executionId)
    expect(JSON.stringify(traces)).not.toContain(traceId)
    expect(JSON.stringify(traces)).not.toContain(executionId)

    const detailPending = store.loadTrace(summary.key, { executionKey })
    const detailRequest = transport.sent.filter((message) => message.type === "get_trace").at(-1)
    if (detailRequest?.type !== "get_trace") throw new Error("get_trace request was not sent")
    expect(detailRequest.payload).toEqual({ presetId: PRESET_A, executionId, traceId })
    transport.respond({
      version: PROTOCOL_VERSION,
      type: "trace",
      correlationId: detailRequest.correlationId,
      sequence: transport.nextSequence(),
      payload: {
        trace: {
          traceId,
          executionId,
          presetId: PRESET_A,
          status: "completed",
          startedAt: 1_000,
          finishedAt: 2_000,
          eventCount: 1,
          preview: "Safe trace summary",
          events: [{
            kind: "dispatch",
            sequence: 1,
            timestamp: 1_500,
            status: "provider-internal",
            preview: "Safe trace event",
          }],
        },
      },
    })
    const detail = await detailPending
    expect(detail.status).toBe("completed")
    expect(detail.eventCount).toBe(1)
    expect(Object.prototype.hasOwnProperty.call(detail, "preview")).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(detail.events[0] ?? {}, "preview")).toBe(false)
    expect(JSON.stringify(detail)).not.toContain(traceId)
    expect(JSON.stringify(detail)).not.toContain(executionId)

    const staleDetailPending = store.loadTrace(summary.key, { executionKey })
    const staleDetailRequest = transport.sent.filter((message) => message.type === "get_trace").at(-1)
    if (staleDetailRequest?.type !== "get_trace") throw new Error("stale get_trace request was not sent")
    transport.respond(createBackendActivityResponse({
      correlationId: "550e8400-e29b-41d4-a716-446655440023",
      sequence: transport.nextSequence(),
      executionId,
      presetId: PRESET_A,
      kind: "execution-terminal",
      phase: "completed",
      terminal: true,
      outcome: "success",
    }))
    const replacementExecutionId = "550e8400-e29b-41d4-a716-446655440024"
    transport.respond(createBackendActivityResponse({
      correlationId: "550e8400-e29b-41d4-a716-446655440025",
      sequence: transport.nextSequence(),
      executionId: replacementExecutionId,
      presetId: PRESET_A,
      kind: "execution",
      phase: "started",
      terminal: false,
    }))
    expect(store.getSnapshot().execution.executionKey).toBe("execution-2")
    transport.respond({
      version: PROTOCOL_VERSION,
      type: "trace",
      correlationId: staleDetailRequest.correlationId,
      sequence: transport.nextSequence(),
      payload: {
        trace: {
          traceId,
          executionId,
          presetId: PRESET_A,
          status: "completed",
          startedAt: 1_000,
          finishedAt: 2_000,
          eventCount: 1,
          preview: "STALE DETAIL SHOULD NOT PROJECT",
          events: [{
            kind: "dispatch",
            sequence: 1,
            timestamp: 1_500,
            status: "failed",
            preview: "STALE DETAIL EVENT SHOULD NOT PROJECT",
          }],
        },
      },
    })
    await expect(staleDetailPending).rejects.toMatchObject({ code: "STALE_OPERATION" })
    expect(JSON.stringify(store.getSnapshot().traces)).not.toContain("STALE DETAIL")

    const stalePending = store.loadTraces({ executionKey })
    const staleRequest = transport.sent.filter((message) => message.type === "list_traces").at(-1)
    if (staleRequest?.type !== "list_traces") throw new Error("stale list_traces request was not sent")
    editor.switchPreset(PRESET_B, graphConfig())
    await settleMicrotasks()
    await settleMicrotasks()
    expect(store.getSnapshot().presetId).toBe(PRESET_B)
    expect(store.getSnapshot().hydrated).toBe(true)
    transport.respond({
      version: PROTOCOL_VERSION,
      type: "trace",
      correlationId: staleRequest.correlationId,
      sequence: transport.nextSequence(),
      payload: {
        traces: [{
          traceId,
          executionId,
          presetId: PRESET_A,
          status: "completed",
          startedAt: 1_000,
          finishedAt: 2_000,
          eventCount: 1,
          preview: "STALE TRACE SHOULD NOT PROJECT",
        }],
      },
    })
    await expect(stalePending).rejects.toMatchObject({ code: "STALE_OPERATION" })
    expect(store.getSnapshot().traces).toEqual({ summaries: [], details: {} })
    store.dispose()
  })

  test("keeps duplicate trace IDs distinct by opaque composite trace key", async () => {
    const editor = new FakeEditor()
    const transport = new FakeTransport()
    const store = storeFor(editor, transport)
    await store.hydrate(PRESET_A)

    const pending = store.loadTraces()
    const listRequest = transport.sent.filter((message) => message.type === "list_traces").at(-1)
    if (listRequest?.type !== "list_traces") throw new Error("list_traces request was not sent")
    expect(Object.prototype.hasOwnProperty.call(listRequest.payload, "executionId")).toBe(false)
    transport.respond({
      version: PROTOCOL_VERSION,
      type: "trace",
      correlationId: listRequest.correlationId,
      sequence: transport.nextSequence(),
      payload: {
        traces: [
          { traceId: "trace-shared", executionId: "execution-a", presetId: PRESET_A, status: "completed", startedAt: 1, eventCount: 0 },
          { traceId: "trace-shared", executionId: "execution-b", presetId: PRESET_A, status: "completed", startedAt: 2, eventCount: 0 },
        ],
      },
    })
    const traces = await pending
    const [first, second] = traces.summaries
    if (first === undefined || second === undefined) throw new Error("trace summaries were not returned")
    expect(first.key).not.toBe(second.key)
    expect(JSON.stringify(traces)).not.toContain("trace-shared")

    for (const [key, executionId, startedAt] of [[first.key, "execution-a", 1], [second.key, "execution-b", 2]] as const) {
      const detail = store.loadTrace(key)
      const request = transport.sent.filter((message) => message.type === "get_trace").at(-1)
      if (request?.type !== "get_trace") throw new Error("get_trace request was not sent")
      expect(request.payload.executionId).toBe(executionId)
      transport.respond({
        version: PROTOCOL_VERSION,
        type: "trace",
        correlationId: request.correlationId,
        sequence: transport.nextSequence(),
        payload: {
          trace: {
            traceId: "trace-shared",
            executionId,
            presetId: PRESET_A,
            status: "completed",
            startedAt,
            eventCount: 0,
            events: [],
          },
        },
      })
      await detail
    }
    expect(Object.keys(store.getSnapshot().traces.details).sort()).toEqual([first.key, second.key].sort())
    expect(JSON.stringify(store.getSnapshot().traces)).not.toContain("trace-shared")
    store.dispose()
  })

  test("retains bounded immutable safe execution activity history per execution", async () => {
    const editor = new FakeEditor()
    const transport = new FakeTransport()
    const store = storeFor(editor, transport)
    await store.hydrate(PRESET_A)

    transport.respond({
      version: PROTOCOL_VERSION,
      type: "activity",
      correlationId: "activity-history-start-a",
      sequence: transport.nextSequence(),
      payload: { executionId: "execution-history-a", presetId: PRESET_A, kind: "graph", phase: "started", terminal: false },
    })
    transport.respond({
      version: PROTOCOL_VERSION,
      type: "activity",
      correlationId: "activity-history-progress-a",
      sequence: transport.nextSequence(),
      payload: { executionId: "execution-history-a", presetId: PRESET_A, kind: "graph", phase: "progress", terminal: false, stageIndex: 0, stageCount: 1, runIndex: 0, runCount: 1 },
    })
    transport.respond({
      version: PROTOCOL_VERSION,
      type: "activity",
      correlationId: "activity-history-terminal-a",
      sequence: transport.nextSequence(),
      payload: { executionId: "execution-history-a", presetId: PRESET_A, kind: "graph", phase: "completed", terminal: true, outcome: "success" },
    })
    expect(store.getSnapshot().execution.activity.map((entry) => entry.phase)).toEqual(["started", "progress", "completed"])
    expect(store.getSnapshot().execution.activity.map((entry) => entry.status)).toEqual(["running", "running", "completed"])

    transport.respond({
      version: PROTOCOL_VERSION,
      type: "activity",
      correlationId: "activity-history-start-b",
      sequence: transport.nextSequence(),
      payload: { executionId: "execution-history-b", presetId: PRESET_A, kind: "graph", phase: "started", terminal: false },
    })
    for (let index = 0; index < 40; index += 1) {
      transport.respond({
        version: PROTOCOL_VERSION,
        type: "activity",
        correlationId: `activity-history-progress-b-${index}`,
        sequence: transport.nextSequence(),
        payload: { executionId: "execution-history-b", presetId: PRESET_A, kind: "graph", phase: "progress", terminal: false, runIndex: 0, runCount: 1 },
      })
    }
    transport.respond({
      version: PROTOCOL_VERSION,
      type: "activity",
      correlationId: "activity-history-terminal-b",
      sequence: transport.nextSequence(),
      payload: { executionId: "execution-history-b", presetId: PRESET_A, kind: "graph", phase: "completed", terminal: true, outcome: "success" },
    })
    const activity = store.getSnapshot().execution.activity
    expect(activity).toHaveLength(32)
    expect(activity[0]?.phase).toBe("progress")
    expect(activity.at(-1)?.phase).toBe("completed")
    expect(activity.some((entry) => entry.phase === "started")).toBe(false)
    expect(Object.isFrozen(activity)).toBe(true)
    expect(Object.isFrozen(activity[0])).toBe(true)
    expect(JSON.stringify(activity)).not.toContain("execution-history-b")
    store.dispose()
  })

  test("does not copy hostile backend diagnostics into the state snapshot", async () => {
    const editor = new FakeEditor()
    const transport = new ErrorTransport()
    const store = storeFor(editor, transport)
    await store.hydrate(PRESET_A)
    await store.refreshConnections()
    const pending = store.bindConnection("slot", "connection-1")
    transport.respondWithHostileMessage()
    await expect(pending).rejects.toMatchObject({ code: "BACKEND_ERROR", message: "APC backend request failed (BACKEND_ERROR)" })
    expect(JSON.stringify(store.getSnapshot())).not.toContain("HOSTILE BACKEND MESSAGE")
    store.dispose()
  })

  test("dispose removes subscriptions and rejects later mutations", async () => {
    const editor = new FakeEditor()
    const store = storeFor(editor)
    await store.hydrate(PRESET_A)
    store.dispose()

    expect(() => store.setSelection({ kind: "main" })).toThrow("disposed")
    await expect(store.flush()).rejects.toThrow("disposed")
  })
})
