// @ts-ignore Bun provides the test module at runtime; the extension bundle excludes this file.
import { describe, expect, test, vi } from "bun:test"
import type {
  InterceptorContextDTO,
  InterceptorHandler,
  InterceptorResultDTO,
  LlmMessageDTO,
  SpindleAPI,
} from "lumiverse-spindle-types"
import { MIN_LUMIVERSE_VERSION, REQUIRED_HOST_CAPABILITIES, SpindleCompatibilityError } from "../compat"
import { MAX_ACTIVE_GLOBAL, MAX_RETAINED_TRACES_PER_USER_PRESET } from "../config/limits"
import type { ApcPresetConfigV1 } from "../config/schema"
import { acquireTrace, getTrace, releaseTrace } from "../runtime/trace-store"
import { setup } from "./runtime"
import {
  MAX_ACTIVITY_BUDGET_MS,
  MAX_ACTIVITY_USAGE_TOKENS,
  type BackendActivityResponse,
  type BackendHydrationResponse,
} from "../protocol/messages"

const INSTALLATION_ID = "550e8400-e29b-41d4-a716-446655440000"

function host(overrides: Record<string, unknown> = {}): SpindleAPI {
  const files = new Map<string, string>()
  const listeners = new Set<(payload: unknown, userId?: string) => void>()
  const permissionListeners = new Set<(payload: unknown) => void>()
  const granted = new Set(["interceptor", "generation"])
  const storage = {
    read: async (path: string) => files.get(path),
    write: async (path: string, data: string) => { files.set(path, data) },
    move: async (from: string, to: string) => { const value = files.get(from); if (value !== undefined) files.set(to, value); files.delete(from) },
    delete: async (path: string) => { files.delete(path) },
    exists: async (path: string) => files.has(path),
    list: async () => [...files.keys()],
  }
  const descriptor = {
    descriptorVersion: 1,
    lumiverseVersion: MIN_LUMIVERSE_VERSION,
    capabilities: REQUIRED_HOST_CAPABILITIES,
    extensionInstallationId: INSTALLATION_ID,
  }
  return {
    host: descriptor,
    storage,
    userStorage: { ...storage, read: storage.read, write: storage.write, move: storage.move, delete: storage.delete, exists: storage.exists, list: storage.list },
    permissions: {
      has: (permission: string) => granted.has(permission),
      onChanged: (listener: (payload: never) => void) => { permissionListeners.add(listener as (payload: unknown) => void); return () => permissionListeners.delete(listener as (payload: unknown) => void) },
      getGranted: async () => [...granted],
      onDenied: () => () => undefined,
    },
    connections: { resolveDispatch: async () => null, get: async () => null, list: async () => [] },
    generate: { assemble: async () => ({ ok: false, error: { kind: "provider", code: "unused", message: "unused" } }), quietTracked: async () => ({ ok: false, error: { kind: "provider", code: "unused", message: "unused" } }) },
    registerInterceptor: () => () => undefined,
    on: (_event: string, listener: (payload: unknown, userId?: string) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    onFrontendMessage: (listener: (payload: unknown, userId: string) => void) => { listeners.add(listener as (payload: unknown, userId?: string) => void); return () => listeners.delete(listener as (payload: unknown, userId?: string) => void) },
    sendToFrontend: () => undefined,
    ...overrides,
  } as unknown as SpindleAPI
}
const PRESET_ID = "7ba7b810-9dad-41d1-80b4-00c04fd430c8"
const THREAD_ID = "aba7b810-9dad-41d1-80b4-00c04fd430c8"
const RUN_ID = "bba7b810-9dad-41d1-80b4-00c04fd430c8"
const PIPELINE_ID = "cba7b810-9dad-41d1-80b4-00c04fd430c8"
const STAGE_ID = "dba7b810-9dad-41d1-80b4-00c04fd430c8"
const GENERATION_ID = "eba7b810-9dad-41d1-80b4-00c04fd430c8"
const REPLACEMENT_GENERATION_ID = "1ba7b810-9dad-41d1-80b4-00c04fd430c8"
const CORRELATION_ID = "fba7b810-9dad-41d1-80b4-00c04fd430c8"
const SECOND_RUN_ID = "2ba7b810-9dad-41d1-80b4-00c04fd430c8"
const THIRD_RUN_ID = "3ba7b810-9dad-41d1-80b4-00c04fd430c8"
const SECOND_STAGE_ID = "4ba7b810-9dad-41d1-80b4-00c04fd430c8"
const THIRD_STAGE_ID = "5ba7b810-9dad-41d1-80b4-00c04fd430c8"
function fixtureGenerationId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`
}

const DESCRIPTOR = Object.freeze({
  descriptorVersion: 1,
  connectionId: "9ba7b810-9dad-41d1-80b4-00c04fd430c8",
  connectionName: "Main",
  provider: "test-provider",
  model: "test-model",
  endpointOrigin: "https://provider.invalid",
  dispatchKind: "concrete",
  connectionDispatchRevision: "dispatch-1",
})

const SLOT_ID = "8ba7b810-9dad-41d1-80b4-00c04fd430c8"
const SLOT_DESCRIPTOR = Object.freeze({
  ...DESCRIPTOR,
  connectionId: "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
  connectionName: "Slot",
  model: "slot-model",
  connectionDispatchRevision: "slot-dispatch-1",
})

function threadFinalConfig(): ApcPresetConfigV1 {
  return {
    schemaVersion: 1,
    supportedModes: ["single", "sequential"],
    activeMode: "sequential",
    mainThread: {
      id: "main",
      name: "Main Thread",
      output: { id: "final", name: "Final Response" },
    },
    connectionSlots: [],
    threads: [{
      id: THREAD_ID,
      name: "Answer Thread",
      description: "Answer",
      workspaceSource: "main-context",
      blocks: [],
      promptVariableValues: {},
      output: { id: "final", name: "Final Response" },
    }],
    pipelines: {
      sequential: {
        id: PIPELINE_ID,
        stages: [{
          id: STAGE_ID,
          name: "Answer stage",
          runs: [{
            id: RUN_ID,
            threadId: THREAD_ID,
            required: true,
            timeoutMs: 1_000,
            inputs: [],
          }],
        }],
        finalResponse: { source: "thread", runId: RUN_ID },
      },
    },
  }
}

function sequentialSlotConfig(): ApcPresetConfigV1 {
  const config = threadFinalConfig()
  config.connectionSlots = [{ id: SLOT_ID, label: "Slot" }]
  config.threads[0].connectionSlotId = SLOT_ID
  return config
}

function parallelSlotConfig(): ApcPresetConfigV1 {
  const config = threadFinalConfig()
  const pipeline = config.pipelines.sequential
  if (pipeline === undefined) throw new Error("Sequential fixture pipeline missing")
  config.supportedModes = ["single", "parallel"]
  config.activeMode = "parallel"
  config.connectionSlots = [{ id: SLOT_ID, label: "Slot" }]
  config.threads[0].connectionSlotId = SLOT_ID
  config.pipelines = { parallel: pipeline }
  return config
}

function twoRunConfig(mode: "parallel" | "sequential"): ApcPresetConfigV1 {
  const config = threadFinalConfig()
  const pipeline = config.pipelines.sequential
  if (pipeline === undefined) throw new Error("Sequential fixture pipeline missing")
  const stage = pipeline.stages[0]
  const firstRun = stage?.runs[0]
  if (stage === undefined || firstRun === undefined) throw new Error("Two-run fixture stage is incomplete")
  const secondRun = {
    ...firstRun,
    id: SECOND_RUN_ID,
    threadId: THREAD_ID,
    required: true,
    inputs: [{ source: "output" as const, runId: RUN_ID, role: "user" as const, onMissing: "omit-binding" as const }],
  }
  const nextPipeline = {
    ...pipeline,
    stages: [
      { ...stage, id: STAGE_ID, runs: [firstRun] },
      { ...stage, id: SECOND_STAGE_ID, runs: [secondRun] },
    ],
    finalResponse: { source: "thread" as const, runId: SECOND_RUN_ID },
  }
  config.supportedModes = mode === "parallel" ? ["single", "parallel"] : ["single", "sequential"]
  config.activeMode = mode
  config.pipelines = mode === "parallel" ? { parallel: nextPipeline } : { sequential: nextPipeline }
  return config
}

function parallelSkippedConfig(): ApcPresetConfigV1 {
  const config = threadFinalConfig()
  const pipeline = config.pipelines.sequential
  const stage = pipeline?.stages[0]
  const firstRun = stage?.runs[0]
  if (pipeline === undefined || stage === undefined || firstRun === undefined) {
    throw new Error("Skipped-run fixture is incomplete")
  }
  const failedRun = { ...firstRun, id: RUN_ID, threadId: THREAD_ID, required: false, inputs: [] }
  const skippedRun = {
    ...firstRun,
    id: SECOND_RUN_ID,
    threadId: THREAD_ID,
    required: false,
    inputs: [{ source: "output" as const, runId: RUN_ID, role: "user" as const, onMissing: "skip-run" as const }],
  }
  const completedRun = {
    ...firstRun,
    id: THIRD_RUN_ID,
    threadId: THREAD_ID,
    required: true,
    inputs: [{ source: "output" as const, runId: SECOND_RUN_ID, role: "user" as const, onMissing: "omit-binding" as const }],
  }
  const nextPipeline = {
    ...pipeline,
    stages: [
      { ...stage, id: STAGE_ID, runs: [failedRun] },
      { ...stage, id: SECOND_STAGE_ID, runs: [skippedRun] },
      { ...stage, id: THIRD_STAGE_ID, runs: [completedRun] },
    ],
    finalResponse: { source: "thread" as const, runId: THIRD_RUN_ID },
  }
  config.supportedModes = ["single", "parallel"]
  config.activeMode = "parallel"
  config.pipelines = { parallel: nextPipeline }
  return config
}

function threeRunConfig(mode: "parallel" | "sequential"): ApcPresetConfigV1 {
  const config = twoRunConfig(mode)
  const pipeline = mode === "parallel" ? config.pipelines.parallel : config.pipelines.sequential
  const stage = pipeline?.stages[0]
  const secondStage = pipeline?.stages[1]
  const secondRun = secondStage?.runs[0]
  if (pipeline === undefined || stage === undefined || secondStage === undefined || secondRun === undefined) {
    throw new Error("Three-run fixture is incomplete")
  }
  pipeline.stages.push({
    ...stage,
    id: THIRD_STAGE_ID,
    runs: [{
      ...secondRun,
      id: THIRD_RUN_ID,
      threadId: THREAD_ID,
      required: true,
      inputs: [{ source: "output" as const, runId: SECOND_RUN_ID, role: "user" as const, onMissing: "omit-binding" as const }],
    }],
  })
  pipeline.finalResponse = { source: "thread", runId: THIRD_RUN_ID }
  return config
}



function capturedRuntimeHost(options: {
  finalResponsePermission?: boolean
  permissionHas?: (permission: string, granted: boolean) => boolean
  runSucceeds?: boolean
  runResponses?: readonly Readonly<{ success?: boolean; usage?: unknown }>[]
  runGate?: Promise<void>
  onRunStarted?: () => void
  onSlotResolve?: (connectionId: string) => void
  onAssemble?: () => void
  onQuietTracked?: (request: unknown) => void
  onConnectionList?: (userId: string | undefined) => void
  requiredConnectionListUserId?: string
  slotDescriptor?: typeof SLOT_DESCRIPTOR
  throwActivityDelivery?: boolean
  throwQuietTracked?: boolean
} = {}): {
  spindle: SpindleAPI
  interceptor: () => InterceptorHandler | undefined
  frontend: () => ((payload: unknown, userId: string) => Promise<void>) | undefined
  outbound: () => readonly unknown[]
  revokeFinalResponse: () => void
} {
  const granted: Record<string, true> = {
    interceptor: true,
    generation: true,
    final_response: true,
  }
  if (options.finalResponsePermission === false) Reflect.deleteProperty(granted, "final_response")
  let registered: InterceptorHandler | undefined
  let frontendHandler: ((payload: unknown, userId: string) => Promise<void>) | undefined
  const permissionListeners = new Set<(payload: unknown) => void>()
  let runResponseIndex = 0
  const outbound: unknown[] = []
  const spindle = host({
    permissions: {
      has: (permission: string) => options.permissionHas?.(permission, granted[permission] === true) ?? granted[permission] === true,
      onChanged: (listener: (payload: unknown) => void) => {
        permissionListeners.add(listener)
        return () => permissionListeners.delete(listener)
      },
      getGranted: async () => Object.keys(granted).filter(permission => granted[permission] === true),
      onDenied: () => () => undefined,
    },
    connections: {
      resolveDispatch: async (connectionId: string) => {
        options.onSlotResolve?.(connectionId)
        return options.slotDescriptor ?? null
      },
      get: async (connectionId: string) => options.slotDescriptor === undefined
        ? null
        : {
            id: connectionId,
            name: options.slotDescriptor.connectionName,
            provider: options.slotDescriptor.provider,
            api_url: "https://provider.invalid/v1",
            model: options.slotDescriptor.model,
            preset_id: null,
            is_default: false,
            has_api_key: true,
            metadata: { ownerUserId: "user-1" },
            reasoning_bindings: null,
            created_at: 1,
            updated_at: 1,
          },
      list: async (userId?: string) => {
        options.onConnectionList?.(userId)
        if (options.requiredConnectionListUserId !== undefined && userId !== options.requiredConnectionListUserId) {
          throw new Error("operator-scoped connection list requires the authenticated user ID")
        }
        return []
      },
    },
    generate: {
      assemble: async () => {
        options.onAssemble?.()
        return {
          ok: false,
          error: { kind: "provider", code: "unused", message: "unused" },
        }
      },
      quietTracked: async (request: unknown) => {
        options.onQuietTracked?.(request)
        let slotDispatch = false
        if (request !== null && typeof request === "object" && "dispatch" in request) {
          const dispatch = request.dispatch
          slotDispatch = dispatch !== null &&
            typeof dispatch === "object" &&
            "source" in dispatch &&
            dispatch.source === "slot"
        }
        const descriptor = slotDispatch ? options.slotDescriptor ?? DESCRIPTOR : DESCRIPTOR
        const source = slotDispatch ? "slot" as const : "main" as const
        const response = options.runResponses?.[runResponseIndex]
        runResponseIndex += 1
        const runSucceeds = response?.success ?? options.runSucceeds !== false
        const usage = response?.usage
        options.onRunStarted?.()
        if (options.runGate !== undefined) await options.runGate
        if (options.throwQuietTracked) throw new Error("tracked generation request failed")
        return !runSucceeds
          ? {
              ok: false,
              phase: "resolved" as const,
              receipt: {
                providerInvoked: true,
                terminalResponse: true,
                source,
                connectionId: descriptor.connectionId,
                connectionDispatchRevision: descriptor.connectionDispatchRevision,
                ...(usage === undefined ? {} : { usage }),
              },
              error: {
                kind: "provider" as const,
                code: "provider-failed",
                name: "ProviderError",
                message: "provider failed",
              },
            }
          : {
              ok: true as const,
              response: { content: "thread response", reasoning: "thread reasoning", finish_reason: "stop" },
              receipt: {
                providerInvoked: true,
                terminalResponse: true,
                source,
                connectionId: descriptor.connectionId,
                connectionDispatchRevision: descriptor.connectionDispatchRevision,
                ...(usage === undefined ? {} : { usage }),
              },
            }
      },
    },
    registerInterceptor: (handler: InterceptorHandler) => {
      registered = handler
      return () => undefined
    },
    onFrontendMessage: (handler: (payload: unknown, userId: string) => void) => {
      frontendHandler = handler as unknown as (payload: unknown, userId: string) => Promise<void>
      return () => undefined
    },
    sendToFrontend: (payload: unknown) => {
      if (
        options.throwActivityDelivery &&
        payload !== null &&
        typeof payload === "object" &&
        "type" in payload &&
        payload.type === "activity"
      ) throw new Error("activity delivery unavailable")
      outbound.push(payload)
    },
  })
  return {
    spindle,
    interceptor: () => registered,
    frontend: () => frontendHandler,
    outbound: () => outbound,
    revokeFinalResponse: () => {
      Reflect.deleteProperty(granted, "final_response")
      for (const listener of permissionListeners) listener({})
    },
  }
}

function activityMessages(outbound: readonly unknown[]): readonly BackendActivityResponse[] {
  return outbound.filter((payload): payload is BackendActivityResponse => {
    if (payload === null || typeof payload !== "object" || !("type" in payload)) return false
    return payload.type === "activity"
  })
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  const { promise, resolve } = Promise.withResolvers<void>()
  return { promise, resolve }
}

function runtimeContext(
  prefillAvailable: boolean,
  options: {
    signal?: AbortSignal
    boundWorkDeadlineAt?: number
    interceptorDeadlineAt?: number
    presetMetadata?: unknown
  } = {},
): InterceptorContextDTO {
  return {
    userId: "user-1",
    chatId: "chat-1",
    generationId: GENERATION_ID,
    generationType: "normal",
    isDryRun: false,
    presetId: PRESET_ID,
    presetMetadata: options.presetMetadata ?? threadFinalConfig(),
    personaId: null,
    characterId: null,
    personaAddonStates: {},
    mainDispatch: {
      source: "main",
      descriptor: DESCRIPTOR,
      connectionDispatchRevision: DESCRIPTOR.connectionDispatchRevision,
      dispatchKind: "concrete",
    },
    prefillCarrier: {
      id: prefillAvailable ? "prefill-1" : "",
      state: prefillAvailable ? "available" : "absent",
    },
    interceptorDeadlineAt: options.interceptorDeadlineAt ?? 10_000,
    boundWorkDeadlineAt: options.boundWorkDeadlineAt ?? 10_000,
    signal: options.signal ?? new AbortController().signal,
  }
}

function runtimeMessages(
  prefillAvailable: boolean,
  prefillContent = "Continue the answer",
): LlmMessageDTO[] {
  const messages: LlmMessageDTO[] = [
    { role: "system", content: "system" },
    { role: "user", content: "question" },
    { role: "assistant", content: "previous answer" },
  ]
  if (prefillAvailable) messages.push({ role: "assistant", content: prefillContent })
  return messages
}
async function approveConsentFor(
  frontend: (payload: unknown, userId: string) => Promise<void>,
  connectionSourceKey: "main" | `slot:${string}`,
  threadId = THREAD_ID,
): Promise<void> {
  await frontend({
    version: 1,
    type: "approve_consent",
    correlationId: CORRELATION_ID,
    payload: {
      presetId: PRESET_ID,
      threadId,
      workspaceSource: "main-context",
      connectionSourceKey,
    },
  }, "user-1")
}

async function approveConsent(
  frontend: (payload: unknown, userId: string) => Promise<void>,
): Promise<void> {
  await approveConsentFor(frontend, "main")
}

async function invokeApprovedThreadRoute(
  prefillAvailable: boolean,
  options: { finalResponsePermission?: boolean; runSucceeds?: boolean } = {},
  prefillContent = "Continue the answer",
): Promise<LlmMessageDTO[] | InterceptorResultDTO> {
  const captured = capturedRuntimeHost(options)
  const runtime = setup({ spindle: captured.spindle, now: () => 0 })
  try {
    await runtime.ready
    const handler = captured.interceptor()
    if (handler === undefined) throw new Error("runtime did not register its interceptor")
    const messages = runtimeMessages(prefillAvailable, prefillContent)
    const context = runtimeContext(prefillAvailable)
    const beforeApproval = await handler(messages, context)
    expect(beforeApproval).toEqual(messages)
    const frontend = captured.frontend()
    if (frontend === undefined) throw new Error("runtime did not register its frontend handler")
    await frontend({
      version: 1,
      type: "approve_consent",
      correlationId: CORRELATION_ID,
      payload: {
        presetId: PRESET_ID,
        threadId: THREAD_ID,
        workspaceSource: "main-context",
        connectionSourceKey: "main",
      },
    }, "user-1")
    return await handler(messages, context)
  } finally {
    await runtime.dispose()
  }
}

describe("APC final-response fallback carrier", () => {
  test("adds exactly one carrier immediately before an authoritative prefill", async () => {
    const inputMessages = runtimeMessages(true)
    const originalMessages = structuredClone(inputMessages)
    const result = await invokeApprovedThreadRoute(true)
    if (Array.isArray(result)) throw new Error("eligible thread route returned ordinary provider messages")
    const fallbackIndex = result.finalResponse?.fallbackMessageIndex

    expect(result.finalResponse?.content).toBe("thread response")
    expect(fallbackIndex).toBeDefined()
    if (fallbackIndex === undefined) throw new Error("runtime did not return a fallback index")
    expect(result.breakdown).toEqual([{ messageIndex: fallbackIndex, name: "Native provider fallback" }])
    expect(result.messages[fallbackIndex]?.role).toBe("system")
    expect(typeof result.messages[fallbackIndex]?.content).toBe("string")
    expect((result.messages[fallbackIndex]?.content as string).trim().length).toBeGreaterThan(0)
    expect(result.messages[fallbackIndex + 1]).toEqual(inputMessages[inputMessages.length - 1])
    expect(result.messages.filter((message) => message.role === "system" && message.content === result.messages[fallbackIndex]?.content)).toHaveLength(1)
    expect(result.messages.filter((_message, index) => index !== fallbackIndex)).toEqual(inputMessages)
    expect(inputMessages).toEqual(originalMessages)
  })

  test("anchors before a whitespace-only but nonempty authoritative prefill", async () => {
    const inputMessages = runtimeMessages(true, " ")
    const result = await invokeApprovedThreadRoute(true, {}, " ")
    if (Array.isArray(result)) throw new Error("eligible thread route returned ordinary provider messages")
    const fallbackIndex = result.finalResponse?.fallbackMessageIndex

    expect(fallbackIndex).toBe(inputMessages.length - 1)
    if (fallbackIndex === undefined) throw new Error("runtime did not return a fallback index")
    expect(result.messages[fallbackIndex + 1]).toEqual(inputMessages[inputMessages.length - 1])
    expect(result.messages.filter((_message, index) => index !== fallbackIndex)).toEqual(inputMessages)
  })

  test("appends exactly one carrier when no authoritative prefill exists", async () => {
    const inputMessages = runtimeMessages(false)
    const originalMessages = structuredClone(inputMessages)
    const result = await invokeApprovedThreadRoute(false)
    if (Array.isArray(result)) throw new Error("eligible thread route returned ordinary provider messages")
    const fallbackIndex = result.finalResponse?.fallbackMessageIndex

    expect(result.finalResponse?.content).toBe("thread response")
    expect(fallbackIndex).toBe(inputMessages.length)
    if (fallbackIndex === undefined) throw new Error("runtime did not return a fallback index")
    expect(result.messages[fallbackIndex]?.role).toBe("system")
    expect(result.messages[fallbackIndex + 1]).toBeUndefined()
    expect(result.messages.filter((_message, index) => index !== fallbackIndex)).toEqual(inputMessages)
    expect(inputMessages).toEqual(originalMessages)
  })
  test("failed and unpermissioned thread routes preserve ordinary provider messages", async () => {
    const inputMessages = runtimeMessages(false)
    const failed = await invokeApprovedThreadRoute(false, { runSucceeds: false })
    const unpermissioned = await invokeApprovedThreadRoute(false, { finalResponsePermission: false })

    expect(failed).toEqual(inputMessages)
    expect(unpermissioned).toEqual(inputMessages)
    expect(Array.isArray(failed)).toBe(true)
    expect(Array.isArray(unpermissioned)).toBe(true)
  })
})

describe("APC runtime activity projection", () => {
  test("emits bounded ordered start/progress and one successful terminal activity", async () => {
    const captured = capturedRuntimeHost()
    const runtime = setup({ spindle: captured.spindle, now: () => 123 })
    try {
      await runtime.ready
      const handler = captured.interceptor()
      const frontend = captured.frontend()
      if (handler === undefined || frontend === undefined) throw new Error("runtime handlers are unavailable")
      const messages = runtimeMessages(false)
      const context = runtimeContext(false)
      expect(await handler(messages, context)).toEqual(messages)
      const activityStart = captured.outbound().length
      await approveConsent(frontend)
      const result = await handler(messages, context)
      expect(Array.isArray(result)).toBe(false)
      const activities = activityMessages(captured.outbound().slice(activityStart))
      const terminals = activities.filter((activity) => activity.payload.terminal)
      expect(activities.some((activity) => activity.payload.phase === "started")).toBe(true)
      expect(activities.some((activity) => activity.payload.phase === "progress")).toBe(true)
      expect(terminals).toHaveLength(1)
      expect(terminals[0]?.payload.phase).toBe("completed")
      expect(terminals[0]?.payload.outcome).toBe("success")
      expect(activities.some((activity) => activity.payload.provider === DESCRIPTOR.provider && activity.payload.model === DESCRIPTOR.model)).toBe(true)
      expect(activities.some((activity) => activity.payload.totalRuns === 1 && activity.payload.completedRuns !== undefined)).toBe(true)
      for (const activity of activities) {
        expect(activity.payload).not.toHaveProperty("connectionId")
        expect(activity.payload).not.toHaveProperty("connectionDispatchRevision")
        expect(activity.payload).not.toHaveProperty("receipt")
        expect(activity.payload).not.toHaveProperty("message")
        expect(activity.payload).not.toHaveProperty("error")
        expect(activity.payload).not.toHaveProperty("userId")
        expect(activity.payload).not.toHaveProperty("installNonce")
      }
      const previews = runtime.traces.list("user-1", PRESET_ID).flatMap(trace => trace.entries.map(entry => entry.preview)).join("\u0000")
      expect(previews).not.toContain(GENERATION_ID)
      expect(previews).not.toContain(RUN_ID)
      const runEntry = runtime.traces.list("user-1", PRESET_ID)
        .flatMap(trace => trace.entries)
        .find(entry => entry.kind === "run_completed")
      expect(runEntry?.metadata.runId).toBe(RUN_ID)
      expect(runEntry?.metadata.status).toBe("success")
      expect(runEntry?.metadata.timestamp).toBe(123)
      for (let index = 1; index < activities.length; index += 1) {
        expect(activities[index]?.sequence).toBeGreaterThan(activities[index - 1]?.sequence ?? 0)
      }

    } finally {
      await runtime.dispose()
    }
  })

  test("clamps overlong finite deadlines in every emitted activity", async () => {
    const captured = capturedRuntimeHost()
    const runtime = setup({ spindle: captured.spindle, now: () => 0 })
    try {
      await runtime.ready
      const handler = captured.interceptor()
      const frontend = captured.frontend()
      if (handler === undefined || frontend === undefined) throw new Error("runtime handlers are unavailable")
      const messages = runtimeMessages(false)
      const overlongDeadline = MAX_ACTIVITY_BUDGET_MS + 1
      const context = runtimeContext(false, {
        boundWorkDeadlineAt: overlongDeadline,
        interceptorDeadlineAt: overlongDeadline,
      })
      expect(await handler(messages, context)).toEqual(messages)
      const activityStart = captured.outbound().length
      await approveConsent(frontend)
      await handler(messages, context)
      const activities = activityMessages(captured.outbound().slice(activityStart))
      expect(activities.length).toBeGreaterThan(0)
      for (const activity of activities) {
        expect(activity.payload.remainingBudgetMs).toBeLessThanOrEqual(MAX_ACTIVITY_BUDGET_MS)
      }
      expect(activities.find((activity) => activity.payload.kind === "execution-terminal")).toBeDefined()
    } finally {
      await runtime.dispose()
    }
  })

  test("emits planned Parallel failed/skipped/completed settlements with safe indices", async () => {
    const captured = capturedRuntimeHost({ runResponses: [{ success: false }, { success: true }] })
    const runtime = setup({ spindle: captured.spindle, now: () => 0 })
    try {
      await runtime.ready
      const handler = captured.interceptor()
      const frontend = captured.frontend()
      if (handler === undefined || frontend === undefined) throw new Error("runtime handlers are unavailable")
      const messages = runtimeMessages(false)
      const context = runtimeContext(false, { presetMetadata: parallelSkippedConfig() })
      expect(await handler(messages, context)).toEqual(messages)
      const activityStart = captured.outbound().length
      await approveConsent(frontend)
      await handler(messages, context)
      const activities = activityMessages(captured.outbound().slice(activityStart))
      const settledRuns = activities.filter((activity) => activity.payload.kind === "run-settled")
      expect(settledRuns.map((activity) => [activity.payload.stageIndex, activity.payload.runIndex, activity.payload.runStatus])).toEqual([
        [0, 0, "failed"],
        [1, 0, "skipped"],
        [2, 0, "completed"],
      ])
      for (const settledRun of settledRuns) {
        expect(settledRun.payload).not.toHaveProperty("errorCategory")
      }
      const terminals = activities.filter((activity) => activity.payload.terminal)
      expect(terminals).toHaveLength(1)
      expect(terminals[0]?.payload.runStatus).toBeUndefined()
    } finally {
      await runtime.dispose()
    }
  })

  test("emits a required failure settlement before the terminal aggregate after root stop", async () => {
    const captured = capturedRuntimeHost({
      runResponses: [{ success: false }, { success: true }],
    })
    const runtime = setup({ spindle: captured.spindle, now: () => 0 })
    try {
      await runtime.ready
      const handler = captured.interceptor()
      const frontend = captured.frontend()
      if (handler === undefined || frontend === undefined) throw new Error("runtime handlers are unavailable")
      const messages = runtimeMessages(false)
      const context = runtimeContext(false, { presetMetadata: twoRunConfig("parallel") })
      expect(await handler(messages, context)).toEqual(messages)
      const activityStart = captured.outbound().length
      await approveConsent(frontend)
      await handler(messages, context)
      const activities = activityMessages(captured.outbound().slice(activityStart))
      const settledRuns = activities.filter((activity) => activity.payload.kind === "run-settled")
      expect(settledRuns[0]?.payload.runIndex).toBe(0)
      expect(settledRuns[0]?.payload.runStatus).toBe("failed")
      expect(settledRuns[0]?.payload).not.toHaveProperty("errorCategory")
      const terminalIndex = activities.findIndex((activity) => activity.payload.terminal)
      expect(terminalIndex).toBeGreaterThanOrEqual(0)
      expect(settledRuns.every((activity) => activities.indexOf(activity) < terminalIndex)).toBe(true)
    } finally {
      await runtime.dispose()
    }
  })

  test("accumulates safe receipt usage and omits missing, invalid, and overflowing additions", async () => {
    const captured = capturedRuntimeHost({
      runResponses: [
        { usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
        { success: true },
        { usage: { prompt_tokens: 1.5, completion_tokens: 1, total_tokens: 2 } },
      ],
    })
    const runtime = setup({ spindle: captured.spindle, now: () => 0 })
    try {
      await runtime.ready
      const handler = captured.interceptor()
      const frontend = captured.frontend()
      if (handler === undefined || frontend === undefined) throw new Error("runtime handlers are unavailable")
      const messages = runtimeMessages(false)
      const context = runtimeContext(false, { presetMetadata: threeRunConfig("sequential") })
      expect(await handler(messages, context)).toEqual(messages)
      const activityStart = captured.outbound().length
      await approveConsent(frontend)
      await handler(messages, context)
      const activities = activityMessages(captured.outbound().slice(activityStart))
      const settledRuns = activities.filter((activity) => activity.payload.kind === "run-settled")
      expect(settledRuns).toHaveLength(3)
      expect(settledRuns[0]?.payload.usage).toEqual({ input: 3, output: 2, total: 5 })
      expect(settledRuns[1]?.payload).not.toHaveProperty("usage")
      expect(settledRuns[2]?.payload).not.toHaveProperty("usage")
      const terminal = activities.find((activity) => activity.payload.terminal)
      expect(terminal?.payload.usage).toEqual({ input: 3, output: 2, total: 5 })
    } finally {
      await runtime.dispose()
    }

    const overflowCaptured = capturedRuntimeHost({
      runResponses: [
        { usage: { prompt_tokens: MAX_ACTIVITY_USAGE_TOKENS } },
        { usage: { prompt_tokens: 1 } },
      ],
    })
    const overflowRuntime = setup({ spindle: overflowCaptured.spindle, now: () => 0 })
    try {
      await overflowRuntime.ready
      const handler = overflowCaptured.interceptor()
      const frontend = overflowCaptured.frontend()
      if (handler === undefined || frontend === undefined) throw new Error("runtime handlers are unavailable")
      const messages = runtimeMessages(false)
      const context = runtimeContext(false, { presetMetadata: twoRunConfig("sequential") })
      expect(await handler(messages, context)).toEqual(messages)
      const activityStart = overflowCaptured.outbound().length
      await approveConsent(frontend)
      await handler(messages, context)
      const activities = activityMessages(overflowCaptured.outbound().slice(activityStart))
      const settledRuns = activities.filter((activity) => activity.payload.kind === "run-settled")
      expect(settledRuns[0]?.payload.usage).toEqual({ input: MAX_ACTIVITY_USAGE_TOKENS })
      expect(settledRuns[1]?.payload).not.toHaveProperty("usage")
      expect(activities.find((activity) => activity.payload.terminal)?.payload.usage).toEqual({
        input: MAX_ACTIVITY_USAGE_TOKENS,
      })
    } finally {
      await overflowRuntime.dispose()
    }
  })

  test("hydrates the latest current-epoch activity when an older execution is still settling", async () => {
    const gate = deferred()
    const firstStarted = deferred()
    const secondStarted = deferred()
    let starts = 0
    const captured = capturedRuntimeHost({
      runGate: gate.promise,
      throwActivityDelivery: true,
      onRunStarted: () => {
        starts += 1
        if (starts === 1) firstStarted.resolve()
        if (starts === 2) secondStarted.resolve()
      },
    })
    const runtime = setup({ spindle: captured.spindle, now: () => 0 })
    let first: Promise<LlmMessageDTO[] | InterceptorResultDTO> | undefined
    let second: Promise<LlmMessageDTO[] | InterceptorResultDTO> | undefined
    try {
      await runtime.ready
      const handler = captured.interceptor()
      const frontend = captured.frontend()
      if (handler === undefined || frontend === undefined) throw new Error("runtime handlers are unavailable")
      const messages = runtimeMessages(false)
      const firstContext = runtimeContext(false)
      expect(await handler(messages, firstContext)).toEqual(messages)
      await approveConsent(frontend)
      first = handler(messages, firstContext)
      await firstStarted.promise

      await frontend({
        version: 1,
        type: "unbind_slot",
        correlationId: CORRELATION_ID,
        payload: { presetId: PRESET_ID, slotId: SLOT_ID },
      }, "user-1")

      const replacementContext = { ...runtimeContext(false), generationId: REPLACEMENT_GENERATION_ID }
      second = handler(messages, replacementContext)
      await secondStarted.promise
      const beforeHydration = captured.outbound().length
      await frontend({
        version: 1,
        type: "hydrate_preset",
        correlationId: CORRELATION_ID,
        payload: { presetId: PRESET_ID },
      }, "user-1")
      const hydration = captured.outbound().slice(beforeHydration).find((payload): payload is BackendHydrationResponse => {
        if (payload === null || typeof payload !== "object" || !("type" in payload)) return false
        return payload.type === "hydration"
      })
      expect(hydration?.payload.execution?.executionId).toBe(REPLACEMENT_GENERATION_ID)
      expect(hydration?.payload.execution?.executionId).not.toBe(GENERATION_ID)
      expect(hydration?.payload.execution?.terminal).toBe(false)
    } finally {
      gate.resolve()
      await Promise.allSettled([first, second].filter((pending): pending is Promise<LlmMessageDTO[] | InterceptorResultDTO> => pending !== undefined))
      await runtime.dispose()
    }
  })
  test("hydrates through an operator-scoped host using the authenticated callback user", async () => {
    const authenticatedUserId = "operator-user"
    const listedUserIds: Array<string | undefined> = []
    const captured = capturedRuntimeHost({
      onConnectionList: userId => { listedUserIds.push(userId) },
      requiredConnectionListUserId: authenticatedUserId,
    })
    const runtime = setup({ spindle: captured.spindle, now: () => 0 })
    try {
      await runtime.ready
      const frontend = captured.frontend()
      if (frontend === undefined) throw new Error("runtime frontend handler is unavailable")
      const beforeHydration = captured.outbound().length
      await frontend({
        version: 1,
        type: "hydrate_preset",
        correlationId: CORRELATION_ID,
        payload: { presetId: PRESET_ID },
      }, authenticatedUserId)
      const responses = captured.outbound().slice(beforeHydration)
      const hydration = responses.find((payload): payload is BackendHydrationResponse => {
        if (payload === null || typeof payload !== "object" || !("type" in payload)) return false
        return payload.type === "hydration"
      })
      expect(responses).toHaveLength(1)
      expect(hydration).toBeDefined()
      expect(hydration?.payload.presetId).toBe(PRESET_ID)
      expect(hydration?.payload.bindings).toEqual([])
      expect(hydration?.payload.consents).toEqual([])
      expect(listedUserIds).toEqual([authenticatedUserId])
    } finally {
      await runtime.dispose()
    }
  })


  test("routes valid Sequential calls through authoritative Main", async () => {
    const quietRequests: unknown[] = []
    const captured = capturedRuntimeHost({ onQuietTracked: (request) => { quietRequests.push(request) } })
    const runtime = setup({ spindle: captured.spindle, now: () => 0 })
    try {
      await runtime.ready
      const handler = captured.interceptor()
      const frontend = captured.frontend()
      if (handler === undefined || frontend === undefined) throw new Error("runtime handlers are unavailable")
      const messages = runtimeMessages(false)
      const context = runtimeContext(false)
      expect(await handler(messages, context)).toEqual(messages)
      await approveConsent(frontend)
      expect(Array.isArray(await handler(messages, context))).toBe(false)
      expect(quietRequests).toHaveLength(1)
      const request = quietRequests[0]
      if (request === null || typeof request !== "object" || !("dispatch" in request)) {
        throw new Error("quietTracked request did not include dispatch")
      }
      expect(request.dispatch).toEqual({
        source: "main",
        expectedConnectionDispatchRevision: DESCRIPTOR.connectionDispatchRevision,
      })
    } finally {
      await runtime.dispose()
    }
  })

  test("routes Sequential calls through Main when slot metadata is retained", async () => {
    let slotResolutions = 0
    const quietRequests: unknown[] = []
    const captured = capturedRuntimeHost({
      slotDescriptor: SLOT_DESCRIPTOR,
      onSlotResolve: () => { slotResolutions += 1 },
      onQuietTracked: (request) => { quietRequests.push(request) },
    })
    const runtime = setup({ spindle: captured.spindle, now: () => 0 })
    try {
      await runtime.ready
      const handler = captured.interceptor()
      const frontend = captured.frontend()
      if (handler === undefined || frontend === undefined) throw new Error("runtime handlers are unavailable")
      const messages = runtimeMessages(false)
      const context = runtimeContext(false, { presetMetadata: sequentialSlotConfig() })
      expect(await handler(messages, context)).toEqual(messages)
      expect(slotResolutions).toBe(0)
      expect(quietRequests).toHaveLength(0)
      await approveConsent(frontend)
      expect(Array.isArray(await handler(messages, context))).toBe(false)
      expect(slotResolutions).toBe(0)
      expect(quietRequests).toHaveLength(1)
      const request = quietRequests[0]
      if (request === null || typeof request !== "object" || !("dispatch" in request)) {
        throw new Error("quietTracked request did not include dispatch")
      }
      expect(request.dispatch).toEqual({
        source: "main",
        expectedConnectionDispatchRevision: DESCRIPTOR.connectionDispatchRevision,
      })
    } finally {
      await runtime.dispose()
    }
  })

  test("resolves Parallel connection slots for execution", async () => {
    let slotResolutions = 0
    const quietRequests: unknown[] = []
    const captured = capturedRuntimeHost({
      slotDescriptor: SLOT_DESCRIPTOR,
      onSlotResolve: () => { slotResolutions += 1 },
      onQuietTracked: (request) => { quietRequests.push(request) },
    })
    const runtime = setup({ spindle: captured.spindle, now: () => 0 })
    try {
      await runtime.ready
      const handler = captured.interceptor()
      const frontend = captured.frontend()
      if (handler === undefined || frontend === undefined) throw new Error("runtime handlers are unavailable")
      await frontend({
        version: 1,
        type: "bind_slot",
        correlationId: CORRELATION_ID,
        payload: {
          presetId: PRESET_ID,
          slotId: SLOT_ID,
          patch: { connectionId: SLOT_DESCRIPTOR.connectionId },
        },
      }, "user-1")
      const messages = runtimeMessages(false)
      const context = runtimeContext(false, { presetMetadata: parallelSlotConfig() })
      const beforeConsent = slotResolutions
      expect(await handler(messages, context)).toEqual(messages)
      expect(slotResolutions).toBeGreaterThan(beforeConsent)
      expect(quietRequests).toHaveLength(0)
      await approveConsentFor(frontend, `slot:${SLOT_ID}`)
      expect(Array.isArray(await handler(messages, context))).toBe(false)
      expect(slotResolutions).toBeGreaterThan(beforeConsent + 1)
      expect(quietRequests).toHaveLength(1)
      const request = quietRequests[0]
      if (request === null || typeof request !== "object" || !("dispatch" in request)) {
        throw new Error("quietTracked request did not include dispatch")
      }
      expect(request.dispatch).toEqual({
        source: "slot",
        connectionId: SLOT_DESCRIPTOR.connectionId,
        expectedConnectionDispatchRevision: SLOT_DESCRIPTOR.connectionDispatchRevision,
      })
    } finally {
      await runtime.dispose()
    }
  })
  test("cancels a thread-final execution when final-response permission is revoked during provider work", async () => {
    const run = deferred()
    const started = deferred()
    const captured = capturedRuntimeHost({ runGate: run.promise, onRunStarted: started.resolve })
    const runtime = setup({ spindle: captured.spindle, now: () => 0 })
    try {
      await runtime.ready
      const handler = captured.interceptor()
      const frontend = captured.frontend()
      if (handler === undefined || frontend === undefined) throw new Error("runtime handlers are unavailable")
      const messages = runtimeMessages(false)
      const context = runtimeContext(false)
      expect(await handler(messages, context)).toEqual(messages)
      const activityStart = captured.outbound().length
      await approveConsent(frontend)
      const pending = handler(messages, context)
      await started.promise
      captured.revokeFinalResponse()
      expect(await handler(messages, context)).toEqual(messages)
      run.resolve()
      expect(await pending).toEqual(messages)
      const terminals = activityMessages(captured.outbound().slice(activityStart)).filter((activity) => activity.payload.terminal)
      expect(terminals).toHaveLength(1)
      expect(terminals[0]?.payload.phase).toBe("cancelled")
      expect(terminals[0]?.payload.outcome).toBe("parent-cancel")
      expect(terminals[0]?.payload.cancellationSource).toBe("permission-revoked")
    } finally {
      run.resolve()
      await runtime.dispose()
    }
  })

  test("projects Graph-fallback and permission/ineligible paths without raw provider errors", async () => {
    const failed = capturedRuntimeHost({ runSucceeds: false })
    const runtime = setup({ spindle: failed.spindle, now: () => 0 })
    try {
      await runtime.ready
      const handler = failed.interceptor()
      const frontend = failed.frontend()
      if (handler === undefined || frontend === undefined) throw new Error("runtime handlers are unavailable")
      const messages = runtimeMessages(false)
      const context = runtimeContext(false)
      expect(await handler(messages, context)).toEqual(messages)
      const activityStart = failed.outbound().length
      await approveConsent(frontend)
      const result = await handler(messages, context)
      expect(result).toEqual(runtimeMessages(false))
      const terminals = activityMessages(failed.outbound().slice(activityStart)).filter((activity) => activity.payload.terminal)
      expect(terminals).toHaveLength(1)
      expect(terminals[0]?.payload.outcome).toBe("graph-fallback")
      expect(JSON.stringify(terminals[0])).not.toContain("provider failed")
    } finally {
      await runtime.dispose()
    }

    let unpermissionedRuns = 0
    let slotResolutions = 0
    let assemblyCalls = 0
    const quietRequests: unknown[] = []
    const unpermissioned = capturedRuntimeHost({
      finalResponsePermission: false,
      slotDescriptor: SLOT_DESCRIPTOR,
      onRunStarted: () => { unpermissionedRuns += 1 },
      onSlotResolve: () => { slotResolutions += 1 },
      onAssemble: () => { assemblyCalls += 1 },
      onQuietTracked: request => { quietRequests.push(request) },
    })
    const unpermissionedRuntime = setup({ spindle: unpermissioned.spindle, now: () => 0 })
    try {
      await unpermissionedRuntime.ready
      const handler = unpermissioned.interceptor()
      if (handler === undefined) throw new Error("runtime handler is unavailable")
      const messages = runtimeMessages(false)
      const context = runtimeContext(false, { presetMetadata: parallelSlotConfig() })
      const [first, second] = await Promise.all([handler(messages, context), handler(messages, context)])
      expect(first).toEqual(messages)
      expect(second).toEqual(messages)
      expect(unpermissionedRuns).toBe(0)
      expect(slotResolutions).toBe(0)
      expect(assemblyCalls).toBe(0)
      expect(quietRequests).toHaveLength(0)
      const terminals = activityMessages(unpermissioned.outbound()).filter((activity) => activity.payload.terminal)
      expect(unpermissioned.outbound()).toHaveLength(1)
      expect(terminals).toHaveLength(1)
      const terminal = terminals[0]
      if (terminal === undefined) throw new Error("terminal activity is unavailable")
      expect(terminal.payload.kind).toBe("final-response-permission-missing")
      expect(terminal.payload.phase).toBe("completed")
      expect(terminal.payload.outcome).toBe("graph-fallback")
      for (const field of [
        "provider",
        "model",
        "stageIndex",
        "stageCount",
        "runIndex",
        "runCount",
        "completedRuns",
        "totalRuns",
        "receipt",
        "error",
        "errorCategory",
        "errorMessageKey",
      ]) {
        expect(terminal.payload).not.toHaveProperty(field)
      }
      const traces = unpermissionedRuntime.traces.list("user-1", PRESET_ID)
      expect(traces).toHaveLength(1)
      const trace = traces[0]
      expect(trace?.status).toBe("completed")
      expect(trace?.entries).toHaveLength(1)
      const entry = trace?.entries[0]
      expect(entry?.kind).toBe("final-response-permission-missing")
      expect(entry?.preview).toBe("Final response permission unavailable; native Main response preserved.")
      expect(JSON.stringify(entry)).not.toContain(GENERATION_ID)
      expect(JSON.stringify(entry)).not.toContain(RUN_ID)
      expect(JSON.stringify(entry)).not.toContain(SLOT_DESCRIPTOR.provider)
      expect(JSON.stringify(entry)).not.toContain(SLOT_DESCRIPTOR.model)
      for (const field of [
        "provider",
        "model",
        "stageIndex",
        "stageCount",
        "runIndex",
        "runCount",
        "completedRuns",
        "totalRuns",
        "receipt",
        "error",
        "errorCategory",
        "errorMessageKey",
      ]) {
        expect(entry).not.toHaveProperty(field)
      }
    } finally {
      await unpermissionedRuntime.dispose()
    }

    const ineligible = capturedRuntimeHost()
    const ineligibleRuntime = setup({ spindle: ineligible.spindle, now: () => 0 })
    try {
      await ineligibleRuntime.ready
      const handler = ineligible.interceptor()
      if (handler === undefined) throw new Error("runtime did not register its interceptor")
      const context = runtimeContext(false, { presetMetadata: { ...threadFinalConfig(), activeMode: "single" } })
      expect(await handler(runtimeMessages(false), context)).toEqual(runtimeMessages(false))
      expect(activityMessages(ineligible.outbound())).toHaveLength(0)
    } finally {
      await ineligibleRuntime.dispose()
    }
  })

  test("settles a thrown generation request and admits the next execution without a sticky run", async () => {
    let runCalls = 0
    const captured = capturedRuntimeHost({
      throwQuietTracked: true,
      onRunStarted: () => { runCalls += 1 },
    })
    const runtime = setup({ spindle: captured.spindle, now: () => 0 })
    try {
      await runtime.ready
      const handler = captured.interceptor()
      const frontend = captured.frontend()
      if (handler === undefined || frontend === undefined) throw new Error("runtime handlers are unavailable")
      const messages = runtimeMessages(false)
      const firstContext = runtimeContext(false)
      expect(await handler(messages, firstContext)).toEqual(messages)
      await approveConsent(frontend)

      const activityStart = captured.outbound().length
      expect(await handler(messages, firstContext)).toEqual(messages)
      const firstTerminals = activityMessages(captured.outbound().slice(activityStart))
        .filter((activity) => activity.payload.terminal)
      expect(firstTerminals).toHaveLength(1)
      expect(firstTerminals[0]?.payload).toMatchObject({
        executionId: GENERATION_ID,
        kind: "execution-terminal",
        phase: "completed",
        terminal: true,
        outcome: "graph-fallback",
      })
      expect(runCalls).toBe(1)

      const secondActivityStart = captured.outbound().length
      const secondContext = { ...firstContext, generationId: REPLACEMENT_GENERATION_ID }
      expect(await handler(messages, secondContext)).toEqual(messages)
      const secondTerminals = activityMessages(captured.outbound().slice(secondActivityStart))
        .filter((activity) => activity.payload.terminal)
      expect(secondTerminals).toHaveLength(1)
      expect(secondTerminals[0]?.payload.executionId).toBe(REPLACEMENT_GENERATION_ID)
      expect(secondTerminals[0]?.payload.outcome).toBe("graph-fallback")
      expect(runCalls).toBe(2)
    } finally {
      await runtime.dispose()
    }
  })

  test("maps user and parent cancellation to one terminal activity", async () => {
    const run = deferred()
    const started = deferred()
    const captured = capturedRuntimeHost({ runGate: run.promise, onRunStarted: started.resolve })
    const runtime = setup({ spindle: captured.spindle, now: () => 0 })
    try {
      await runtime.ready
      const handler = captured.interceptor()
      const frontend = captured.frontend()
      if (handler === undefined || frontend === undefined) throw new Error("runtime handlers are unavailable")
      const messages = runtimeMessages(false)
      const context = runtimeContext(false)
      expect(await handler(messages, context)).toEqual(messages)
      const activityStart = captured.outbound().length
      await approveConsent(frontend)
      const pending = handler(messages, context)
      await started.promise
      await frontend({
        version: 1,
        type: "cancel_execution",
        correlationId: CORRELATION_ID,
        payload: { presetId: PRESET_ID, executionId: GENERATION_ID, reason: "user" },
      }, "user-1")
      run.resolve()
      await pending
      const terminals = activityMessages(captured.outbound().slice(activityStart)).filter((activity) => activity.payload.terminal)
      expect(terminals).toHaveLength(1)
      expect(terminals[0]?.payload.phase).toBe("cancelled")
      expect(terminals[0]?.payload.outcome).toBe("parent-cancel")
      expect(terminals[0]?.payload.cancellationSource).toBe("user")
    } finally {
      run.resolve()
      await runtime.dispose()
    }

    const parentRun = deferred()
    const parentStarted = deferred()
    const parentController = new AbortController()
    const parent = capturedRuntimeHost({ runGate: parentRun.promise, onRunStarted: parentStarted.resolve })
    const parentRuntime = setup({ spindle: parent.spindle, now: () => 0 })
    try {
      await parentRuntime.ready
      const handler = parent.interceptor()
      const frontend = parent.frontend()
      if (handler === undefined || frontend === undefined) throw new Error("runtime handlers are unavailable")
      const messages = runtimeMessages(false)
      const context = runtimeContext(false, { signal: parentController.signal })
      expect(await handler(messages, context)).toEqual(messages)
      const activityStart = parent.outbound().length
      await approveConsent(frontend)
      const pending = handler(messages, context)
      await parentStarted.promise
      parentController.abort()
      parentRun.resolve()
      await pending
      const terminals = activityMessages(parent.outbound().slice(activityStart)).filter((activity) => activity.payload.terminal)
      expect(terminals).toHaveLength(1)
      expect(terminals[0]?.payload.phase).toBe("cancelled")
      expect(terminals[0]?.payload.outcome).toBe("parent-cancel")
      expect(terminals[0]?.payload.cancellationSource).toBe("stop")
    } finally {
      parentRun.resolve()
      await parentRuntime.dispose()
    }
  })


  test("maps deadline timeout to a Graph-fallback terminal and suppresses all post-dispose activity", async () => {
    vi.useFakeTimers()
    try {
    const deadlineRun = deferred()
    const deadlineStarted = deferred()
    const deadline = capturedRuntimeHost({ runGate: deadlineRun.promise, onRunStarted: deadlineStarted.resolve })
    const deadlineRuntime = setup({ spindle: deadline.spindle, now: () => 0 })
    try {
      await deadlineRuntime.ready
      const handler = deadline.interceptor()
      const frontend = deadline.frontend()
      if (handler === undefined || frontend === undefined) throw new Error("runtime handlers are unavailable")
      const messages = runtimeMessages(false)
      const context = runtimeContext(false, { boundWorkDeadlineAt: 1, interceptorDeadlineAt: 10 })
      expect(await handler(messages, context)).toEqual(messages)
      const activityStart = deadline.outbound().length
      await approveConsent(frontend)
      const pending = handler(messages, context)
      await deadlineStarted.promise
      vi.advanceTimersByTime(5)
      await Promise.resolve()
      deadlineRun.resolve()
      await pending
      const activities = activityMessages(deadline.outbound().slice(activityStart))
      const runSettled = activities.filter((activity) => activity.payload.kind === "run-settled")
      const terminals = activities.filter((activity) => activity.payload.terminal)
      expect(runSettled).toHaveLength(1)
      expect(runSettled[0]?.payload.runStatus).toBe("timed-out")
      expect(runSettled[0]?.payload.runIndex).toBe(0)
      expect(terminals).toHaveLength(1)
      expect(terminals[0]?.payload.phase).toBe("completed")
      expect(terminals[0]?.payload.outcome).toBe("graph-fallback")
      expect(terminals[0]?.payload.runStatus).toBeUndefined()
      expect(terminals[0]?.payload.cancellationSource).toBeUndefined()
    } finally {
      deadlineRun.resolve()
      await deadlineRuntime.dispose()
    }

    const disposeRun = deferred()
    const disposeStarted = deferred()
    const disposable = capturedRuntimeHost({ runGate: disposeRun.promise, onRunStarted: disposeStarted.resolve })
    const disposableRuntime = setup({ spindle: disposable.spindle, now: () => 0 })
    try {
      await disposableRuntime.ready
      const handler = disposable.interceptor()
      const frontend = disposable.frontend()
      if (handler === undefined || frontend === undefined) throw new Error("runtime handlers are unavailable")
      const messages = runtimeMessages(false)
      const context = runtimeContext(false)
      expect(await handler(messages, context)).toEqual(messages)
      const activityStart = disposable.outbound().length
      await approveConsent(frontend)
      const pending = handler(messages, context)
      await disposeStarted.promise
      const outboundBeforeDispose = disposable.outbound().length
      const disposePromise = disposableRuntime.dispose()
      const outboundAfterDispose = disposable.outbound().length
      const terminals = activityMessages(disposable.outbound().slice(activityStart)).filter((activity) => activity.payload.terminal)
      expect(outboundAfterDispose).toBeGreaterThan(outboundBeforeDispose)
      expect(terminals).toHaveLength(1)
      expect(terminals[0]?.payload.phase).toBe("cancelled")
      expect(terminals[0]?.payload.outcome).toBe("parent-cancel")
      expect(terminals[0]?.payload.cancellationSource).toBe("disposed")
      disposeRun.resolve()
      await disposePromise
      await pending
      expect(disposable.outbound()).toHaveLength(outboundAfterDispose)
    } finally {
      disposeRun.resolve()
      await disposableRuntime.dispose()
    }
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("APC backend runtime", () => {
  test("fails closed before touching host APIs when compatibility is invalid", () => {
    const incompatible = host({ host: { descriptorVersion: 1, lumiverseVersion: "0.0.0", capabilities: {}, extensionInstallationId: INSTALLATION_ID } })
    expect(() => setup(incompatible)).toThrow(SpindleCompatibilityError)
  })

  test("ready is idempotent and teardown removes the active runtime", async () => {
    const spindle = host()
    const first = setup(spindle)
    await first.ready
    const second = setup(spindle)
    expect(second).toBe(first)
    await first.dispose()
    const third = setup(spindle)
    expect(third).not.toBe(first)
    await third.dispose()
  })
  test("fails closed when the initial required permission probe throws", async () => {
    const captured = capturedRuntimeHost({
      permissionHas: () => {
        throw new Error("permission probe failed")
      },
    })
    const runtime = setup({ spindle: captured.spindle, now: () => 123 })
    try {
      await runtime.ready
      expect(captured.interceptor()).toBeUndefined()
    } finally {
      await runtime.dispose()
    }
  })

  test("fails closed when final_response permission probing throws", async () => {
    let assemblyCalls = 0
    let providerCalls = 0
    const captured = capturedRuntimeHost({
      permissionHas: (permission, granted) => {
        if (permission === "final_response") throw new Error("final response probe failed")
        return granted
      },
      onAssemble: () => { assemblyCalls += 1 },
      onRunStarted: () => { providerCalls += 1 },
    })
    const runtime = setup({ spindle: captured.spindle, now: () => 123 })
    try {
      await runtime.ready
      const handler = captured.interceptor()
      if (handler === undefined) throw new Error("runtime interceptor is unavailable")
      const messages = runtimeMessages(false)
      expect(await handler(messages, runtimeContext(false))).toEqual(messages)
      expect(assemblyCalls).toBe(0)
      expect(providerCalls).toBe(0)
      const terminals = activityMessages(captured.outbound()).filter(activity => activity.payload.terminal)
      expect(terminals).toHaveLength(1)
      expect(terminals[0]?.payload.outcome).toBe("graph-fallback")
      expect(terminals[0]?.payload.kind).toBe("final-response-permission-missing")
    } finally {
      await runtime.dispose()
    }
  })

  test("permission watcher fails closed when final_response probing throws", async () => {
    let throwFinalResponseProbe = false
    const run = deferred()
    const started = deferred()
    const captured = capturedRuntimeHost({
      runGate: run.promise,
      onRunStarted: started.resolve,
      permissionHas: (permission, granted) => {
        if (throwFinalResponseProbe && permission === "final_response") {
          throw new Error("watcher permission probe failed")
        }
        return granted
      },
    })
    const runtime = setup({ spindle: captured.spindle, now: () => 123 })
    try {
      await runtime.ready
      const handler = captured.interceptor()
      const frontend = captured.frontend()
      if (handler === undefined || frontend === undefined) throw new Error("runtime handlers are unavailable")
      const messages = runtimeMessages(false)
      const context = runtimeContext(false)
      expect(await handler(messages, context)).toEqual(messages)
      await approveConsent(frontend)
      const pending = handler(messages, context)
      await started.promise
      throwFinalResponseProbe = true
      expect(() => captured.revokeFinalResponse()).not.toThrow()
      run.resolve()
      expect(await pending).toEqual(messages)
      const terminals = activityMessages(captured.outbound()).filter(activity =>
        activity.payload.terminal &&
        activity.payload.executionId === GENERATION_ID &&
        activity.payload.cancellationSource === "permission-revoked"
      )
      expect(terminals).toHaveLength(1)
      expect(terminals[0]?.payload.phase).toBe("cancelled")
      expect(terminals[0]?.payload.cancellationSource).toBe("permission-revoked")
    } finally {
      run.resolve()
      await runtime.dispose()
    }
  })

  test("turns a pre-try callback exception into one bounded Graph-fallback", async () => {
    const captured = capturedRuntimeHost()
    const runtime = setup({
      spindle: captured.spindle,
      now: () => { throw new Error("runtime clock failed") },
    })
    try {
      await runtime.ready
      const handler = captured.interceptor()
      if (handler === undefined) throw new Error("runtime interceptor is unavailable")
      const messages = runtimeMessages(false)
      expect(await handler(messages, runtimeContext(false))).toEqual(messages)
      const terminals = activityMessages(captured.outbound()).filter(activity => activity.payload.terminal)
      expect(terminals).toHaveLength(1)
      expect(terminals[0]?.payload.outcome).toBe("graph-fallback")
      expect(terminals[0]?.payload.kind).toBe("execution-terminal")
      const traces = runtime.traces.list("user-1", PRESET_ID)
      expect(traces).toHaveLength(1)
      expect(traces[0]?.entries).toHaveLength(1)
      expect(traces[0]?.entries[0]?.kind).toBe("runtime-fallback")
      expect(traces[0]?.entries[0]?.preview).toBe("APC runtime failure; native messages returned.")
    } finally {
      await runtime.dispose()
    }
  })
  test("blocks a successful generation replay after its trace is evicted", async () => {
    let providerCalls = 0
    const captured = capturedRuntimeHost({
      onRunStarted: () => { providerCalls += 1 },
    })
    const runtime = setup({ spindle: captured.spindle, now: () => 123 })
    try {
      await runtime.ready
      const handler = captured.interceptor()
      const frontend = captured.frontend()
      if (handler === undefined || frontend === undefined) throw new Error("runtime handlers are unavailable")
      const messages = runtimeMessages(false)
      const firstContext = runtimeContext(false)
      expect(await handler(messages, firstContext)).toEqual(messages)
      await approveConsent(frontend)
      const activityStart = captured.outbound().length
      expect(Array.isArray(await handler(messages, firstContext))).toBe(false)
      for (let index = 0; index < MAX_RETAINED_TRACES_PER_USER_PRESET; index += 1) {
        expect(Array.isArray(await handler(messages, {
          ...firstContext,
          generationId: fixtureGenerationId(index),
        }))).toBe(false)
      }
      expect(getTrace(runtime.traces, firstContext.userId, PRESET_ID, firstContext.generationId)).toBeUndefined()
      expect(providerCalls).toBe(MAX_RETAINED_TRACES_PER_USER_PRESET + 1)
      expect(await handler(messages, firstContext)).toEqual(messages)
      expect(providerCalls).toBe(MAX_RETAINED_TRACES_PER_USER_PRESET + 1)
      const terminals = activityMessages(captured.outbound().slice(activityStart)).filter(activity =>
        activity.payload.terminal &&
        activity.payload.executionId === firstContext.generationId
      )
      expect(terminals).toHaveLength(1)
    } finally {
      await runtime.dispose()
    }
  })

  test("keeps one permission fallback after its trace is evicted", async () => {
    const captured = capturedRuntimeHost({ finalResponsePermission: false })
    const runtime = setup({ spindle: captured.spindle, now: () => 123 })
    try {
      await runtime.ready
      const handler = captured.interceptor()
      if (handler === undefined) throw new Error("runtime interceptor is unavailable")
      const messages = runtimeMessages(false)
      const originalContext = runtimeContext(false)
      expect(await handler(messages, originalContext)).toEqual(messages)
      for (let index = 0; index < MAX_RETAINED_TRACES_PER_USER_PRESET; index += 1) {
        expect(await handler(messages, { ...originalContext, generationId: fixtureGenerationId(index) })).toEqual(messages)
      }
      expect(getTrace(runtime.traces, originalContext.userId, PRESET_ID, originalContext.generationId)).toBeUndefined()
      const beforeReplay = activityMessages(captured.outbound()).filter(activity => activity.payload.terminal)
      expect(beforeReplay).toHaveLength(MAX_RETAINED_TRACES_PER_USER_PRESET + 1)
      expect(await handler(messages, originalContext)).toEqual(messages)
      const afterReplay = activityMessages(captured.outbound()).filter(activity => activity.payload.terminal)
      expect(afterReplay).toHaveLength(MAX_RETAINED_TRACES_PER_USER_PRESET + 1)
    } finally {
      await runtime.dispose()
    }
  })

  test("emits a permission fallback activity when trace admission is full", async () => {
    const captured = capturedRuntimeHost({ finalResponsePermission: false })
    const runtime = setup({ spindle: captured.spindle, now: () => 123 })
    const held: Array<{ userId: string; presetId: string; executionId: string }> = []
    try {
      await runtime.ready
      for (let index = 0; index < MAX_ACTIVE_GLOBAL; index += 1) {
        const identity = {
          userId: `saturated-user-${index}`,
          presetId: "saturated-preset",
          executionId: `saturated-execution-${index}`,
        }
        const acquired = acquireTrace(runtime.traces, identity.userId, identity.presetId, identity.executionId, { startedAt: 123 })
        expect(acquired.accepted).toBe(true)
        held.push(identity)
      }
      const saturationProbe = acquireTrace(runtime.traces, "saturated-probe-user", "saturated-probe-preset", "saturated-probe-execution", { startedAt: 123 })
      expect(saturationProbe).toEqual({ accepted: false, reason: "admission-capacity" })
      const handler = captured.interceptor()
      if (handler === undefined) throw new Error("runtime interceptor is unavailable")
      const messages = runtimeMessages(false)
      const context = runtimeContext(false)
      expect(await handler(messages, context)).toEqual(messages)
      expect(await handler(messages, context)).toEqual(messages)
      const terminals = activityMessages(captured.outbound()).filter(activity => activity.payload.terminal)
      expect(terminals).toHaveLength(1)
      expect(terminals[0]?.payload.kind).toBe("final-response-permission-missing")
      expect(terminals[0]?.payload.outcome).toBe("graph-fallback")
    } finally {
      for (const identity of held) releaseTrace(runtime.traces, identity.userId, identity.presetId, identity.executionId)
      await runtime.dispose()
    }
  })

  test("turns trace admission rejection into one bounded Graph-fallback", async () => {
    const captured = capturedRuntimeHost()
    const runtime = setup({ spindle: captured.spindle, now: () => 123 })
    const held: Array<{ userId: string; presetId: string; executionId: string }> = []
    try {
      await runtime.ready
      for (let index = 0; index < MAX_ACTIVE_GLOBAL; index += 1) {
        const identity = {
          userId: `saturated-user-${index}`,
          presetId: "saturated-preset",
          executionId: `saturated-execution-${index}`,
        }
        const acquired = acquireTrace(runtime.traces, identity.userId, identity.presetId, identity.executionId, { startedAt: 123 })
        expect(acquired.accepted).toBe(true)
        held.push(identity)
      }
      const handler = captured.interceptor()
      if (handler === undefined) throw new Error("runtime interceptor is unavailable")
      const messages = runtimeMessages(false)
      const context = runtimeContext(false)
      expect(await handler(messages, context)).toEqual(messages)
      expect(await handler(messages, context)).toEqual(messages)
      const terminals = activityMessages(captured.outbound()).filter(activity => activity.payload.terminal)
      expect(terminals).toHaveLength(1)
      expect(terminals[0]?.payload.kind).toBe("trace-admission-fallback")
      expect(terminals[0]?.payload.outcome).toBe("graph-fallback")
      expect(runtime.traces.list(context.userId, PRESET_ID)).toHaveLength(0)
    } finally {
      for (const identity of held) releaseTrace(runtime.traces, identity.userId, identity.presetId, identity.executionId)
      await runtime.dispose()
    }
  })

  test("keeps execution scopes distinct when IDs contain delimiter characters", async () => {
    const captured = capturedRuntimeHost({ finalResponsePermission: false })
    const runtime = setup({ spindle: captured.spindle, now: () => 123 })
    try {
      await runtime.ready
      const handler = captured.interceptor()
      if (handler === undefined) throw new Error("runtime interceptor is unavailable")
      const messages = runtimeMessages(false)
      const first = { ...runtimeContext(false), userId: "user\u0000a", presetId: "preset-b", generationId: "generation-c" }
      const second = { ...runtimeContext(false), userId: "user", presetId: "a\u0000preset-b", generationId: "generation-c" }
      expect(await handler(messages, first)).toEqual(messages)
      expect(await handler(messages, second)).toEqual(messages)
      expect(runtime.traces.list(first.userId, first.presetId)).toHaveLength(1)
      expect(runtime.traces.list(second.userId, second.presetId)).toHaveLength(1)
    } finally {
      await runtime.dispose()
    }
  })

  test("routes user-scoped storage enumeration without enumerating other users", async () => {
    const base = host()
    const globalPrefixes: string[] = []
    const userCalls: Array<{ prefix: string | undefined; userId: string | undefined }> = []
    const spindle = {
      ...base,
      storage: {
        ...base.storage,
        list: async (prefix: string) => {
          globalPrefixes.push(prefix)
          return []
        },
      },
      userStorage: {
        ...base.userStorage,
        list: async (prefix?: string, userId?: string) => {
          userCalls.push({ prefix, userId })
          return []
        },
      },
    } as unknown as SpindleAPI
    const runtime = setup({ spindle, now: () => 123 })
    try {
      await runtime.ready
      globalPrefixes.length = 0
      const adapter = (runtime.store as unknown as {
        storage: { list: (prefix: string) => Promise<readonly string[]> }
      }).storage
      await adapter.list("install-prefix")
      await adapter.list("user-1/agentic-preset-composer/state")
      expect(globalPrefixes).toEqual(["install-prefix"])
      expect(userCalls).toEqual([{ prefix: "agentic-preset-composer/state", userId: "user-1" }])
    } finally {
      await runtime.dispose()
    }
  })
})
