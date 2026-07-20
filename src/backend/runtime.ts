import type {
  InterceptorContextDTO,
  InterceptorResultDTO,
  LlmMessageDTO,
  PermissionChangedDetail,
  SpindleAPI,
} from "lumiverse-spindle-types"
import { validateSpindleHostDescriptor } from "../compat"
import { decodeApcPresetConfig, type ApcMode, type ApcPresetConfigV1 } from "../config/schema"
import { MAX_THREAD_OUTPUT_BYTES, utf8Bytes } from "../config/limits"
import { AtomicJsonStore, type StorageAdapter } from "../state/atomic-json-store"
import { buildInstallRecordKey } from "../state/documents"
import { AdmissionRegistry } from "../runtime/admission"
import {
  acquireTrace,
  appendTrace,
  releaseTrace,
  createTraceStore,
  getTrace,
  finalizeTrace,
  type TraceMetadata,
  type TraceStore,
} from "../runtime/trace-store"
import { OutcomeLatch, type GraphFallbackCauseCategory } from "../runtime/outcome"
import { createExecutionCancellation, type CancellationReason, type ExecutionCancellation } from "./cancellation"
import {
  createConnectionBindings,
  cloneDispatchDescriptor,
  type HostDispatchDescriptor,
} from "./connection-bindings"
import { createConsentService } from "./consent"
import {
  createBackendEndpointRouter,
  type BackendEndpointRouter,
  type BackendEndpointDependencies,
} from "./endpoints"
import {
  createInterceptorRegistrationRegistry,
  type InterceptorRegistrationRegistry,
} from "./interceptor-registration"
import { executeAuxiliaryRun, type AuxiliaryRunResult } from "./execution"
import {
  executeGraphPlan,
  planGraphExecution,
  resolveRunInputs,
  type GraphExecutionPlan,
  type PlannedRun,
  type SettledOutputs,
} from "./graph-scheduler"
import { createRunWorkspace, materializeWorkspace } from "./workspaces"
import { type SettledThreadOutput } from "./guidance"
import { isThreadFinalRoutingResult, routeFinalResponse } from "./final-routing"
import {
  MAX_ACTIVITY_BUDGET_MS,
  MAX_ACTIVITY_USAGE_TOKENS,
  type ActivityCancellationSource,
  type ActivityErrorCategory,
  type ActivityOutcome,
  type ActivityPhase,
  type BackendActivityInput,
  type BackendActivityResponse,
  type BackendActivityUsage,
} from "../protocol/messages"
type RuntimeActivity = Omit<BackendActivityInput, "correlationId" | "sequence">
type ActivityUpdate = Readonly<{
  kind: string
  phase: ActivityPhase
  terminal: boolean
  traceId?: string
  provider?: string
  model?: string
  runStatus?: BackendActivityInput["runStatus"]
  stageIndex?: number
  stageCount?: number
  runIndex?: number
  runCount?: number
  completedRuns?: number
  totalRuns?: number
  remainingBudgetMs?: number
  outcome?: ActivityOutcome
  errorCategory?: ActivityErrorCategory
  cancellationSource?: ActivityCancellationSource
}>

const ACTIVITY_LABEL_PATTERN = /^[^\u0000-\u001f\u007f\r\n]+$/u

function safeActivityLabel(value: unknown, maxBytes: number): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    ACTIVITY_LABEL_PATTERN.test(value) &&
    utf8Bytes(value) <= maxBytes
    ? value
    : undefined
}

function remainingBudget(deadlineAt: number, timestamp: number): number | undefined {
  if (!Number.isFinite(deadlineAt) || !Number.isFinite(timestamp)) return undefined
  const remaining = Math.min(MAX_ACTIVITY_BUDGET_MS, Math.max(0, Math.floor(deadlineAt - timestamp)))
  return Number.isSafeInteger(remaining) ? remaining : undefined
}

function activityErrorCategory(
  result: AuxiliaryRunResult | undefined,
  fallback: ActivityErrorCategory = "unknown",
): ActivityErrorCategory {
  if (result === undefined) return fallback
  if (result.kind === "timed-out") return "timeout"
  if (result.kind === "cancelled") return "timeout"
  if (result.kind === "success") return fallback
  switch (result.phase) {
    case "assembly":
      return "assembly"
    case "dispatch":
    case "revision":
      return "dispatch"
    case "provider":
      return "provider"
    case "input":
      return "config"
    default:
      return fallback
  }
}

function cancellationSourceFor(
  reason: CancellationReason | "user" | "stop" | "replacement" | undefined,
): ActivityCancellationSource | undefined {
  switch (reason) {
    case "user":
      return "user"
    case "stop":
      return "stop"
    case "replacement":
      return "replacement"
    case "permission-revoked":
      return "permission-revoked"
    case "disable":
      return "disable"
    case "update":
      return "update"
    case "disposed":
      return "disposed"
    case "deadline":
    case "child-timeout":
    case "required-failure":
      return "timeout"
    case "host-abort":
      return "stop"
    default:
      return undefined
  }
}


const REQUIRED_PERMISSIONS = Object.freeze(["interceptor", "generation"] as const)
const APC_FALLBACK_CONTENT = "Continue with the native provider request if this override is not eligible."
const ACTIVE_RUNTIME_KEY = Symbol.for("lumiverse.apc.backend.runtime")
const RUNTIME_FAILURE_CAUSE = Object.freeze({
  code: "RUNTIME_FAILURE",
  category: "assembly-setup-storage-worker-transport-receipt" as const,
})
const TRACE_ADMISSION_CAUSE = Object.freeze({
  code: "TRACE_ADMISSION_REJECTED",
  category: "capacity-config-graph-prefill" as const,
  activityKind: "trace-admission-fallback" as const,
})

type RuntimeGlobals = { [ACTIVE_RUNTIME_KEY]?: BackendRuntime }
const FALLBACK_CORRELATION_ID = "00000000-0000-4000-8000-000000000000"
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const MAX_CONTEXT_TEXT_BYTES = 2_048

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
type ActivityUsageField = "input" | "output" | "total"
const ACTIVITY_USAGE_FIELDS = Object.freeze([
  ["prompt_tokens", "input"],
  ["completion_tokens", "output"],
  ["total_tokens", "total"],
] as const)

function normalizedReceiptUsage(result: AuxiliaryRunResult | undefined): BackendActivityUsage | undefined {
  const usage = result?.receipt?.usage
  if (!isRecord(usage)) return undefined
  const normalized: Partial<Record<ActivityUsageField, number>> = {}
  let present = false
  for (const [source, target] of ACTIVITY_USAGE_FIELDS) {
    const value = usage[source]
    if (value === undefined) continue
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_ACTIVITY_USAGE_TOKENS) return undefined
    normalized[target] = value
    present = true
  }
  return present ? Object.freeze(normalized) as BackendActivityUsage : undefined
}

function addActivityUsage(
  previous: BackendActivityUsage | undefined,
  addition: BackendActivityUsage | undefined,
): BackendActivityUsage | undefined {
  if (addition === undefined) return undefined
  const next: Partial<Record<ActivityUsageField, number>> = {}
  let present = false
  for (const field of ["input", "output", "total"] as const) {
    const increment = addition[field]
    const current = previous?.[field]
    if (increment !== undefined) {
      const sum = (current ?? 0) + increment
      if (!Number.isSafeInteger(sum) || sum < 0 || sum > MAX_ACTIVITY_USAGE_TOKENS) return undefined
      next[field] = sum
      present = true
    } else if (current !== undefined) {
      next[field] = current
      present = true
    }
  }
  return present ? Object.freeze(next) as BackendActivityUsage : undefined
}


function cloneAndFreeze<T>(value: T): T {
  const copy = structuredClone(value)
  const freeze = (current: unknown, seen: WeakSet<object>): void => {
    if (current === null || typeof current !== "object") return
    const object = current as object
    if (seen.has(object)) return
    seen.add(object)
    for (const child of Object.values(current as Record<string, unknown>)) freeze(child, seen)
    Object.freeze(object)
  }
  freeze(copy, new WeakSet<object>())
  return copy
}

function boundedText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && utf8Bytes(value) <= MAX_CONTEXT_TEXT_BYTES
}

function validSignal(value: unknown): value is AbortSignal {
  return isRecord(value) &&
    typeof value.addEventListener === "function" &&
    typeof value.removeEventListener === "function" &&
    typeof value.aborted === "boolean"
}

function snapshotParentMessages(messages: unknown): LlmMessageDTO[] | undefined {
  if (!Array.isArray(messages)) return undefined
  try {
    return cloneAndFreeze(messages) as LlmMessageDTO[]
  } catch {
    return undefined
  }
}

function snapshotInterceptorContext(context: InterceptorContextDTO): InterceptorContextDTO | undefined {
  try {
    if (
      !isRecord(context) ||
      !boundedText(context.userId) ||
      !boundedText(context.chatId) ||
      !boundedText(context.generationId) ||
      !boundedText(context.presetId) ||
      (context.generationType !== "normal" && context.generationType !== "continue") ||
      context.isDryRun !== false ||
      !validSignal(context.signal) ||
      !Number.isFinite(context.interceptorDeadlineAt) ||
      !Number.isFinite(context.boundWorkDeadlineAt) ||
      context.boundWorkDeadlineAt > context.interceptorDeadlineAt
    ) return undefined

    const rawDispatch = context.mainDispatch
    if (
      !isRecord(rawDispatch) ||
      rawDispatch.source !== "main" ||
      (rawDispatch.dispatchKind !== null &&
        rawDispatch.dispatchKind !== "concrete" &&
        rawDispatch.dispatchKind !== "roulette") ||
      (rawDispatch.connectionDispatchRevision !== null &&
        !boundedText(rawDispatch.connectionDispatchRevision))
    ) return undefined

    let descriptor: HostDispatchDescriptor | null = null
    if (rawDispatch.descriptor !== null) {
      if (rawDispatch.dispatchKind !== "concrete" || rawDispatch.connectionDispatchRevision === null) return undefined
      descriptor = cloneDispatchDescriptor(rawDispatch.descriptor)
      if (descriptor.connectionDispatchRevision !== rawDispatch.connectionDispatchRevision) return undefined
    } else if (rawDispatch.dispatchKind === "concrete" || rawDispatch.connectionDispatchRevision !== null) {
      return undefined
    }

    const rawCarrier = context.prefillCarrier
    if (
      !isRecord(rawCarrier) ||
      typeof rawCarrier.id !== "string" ||
      (rawCarrier.state !== "absent" && rawCarrier.state !== "available" && rawCarrier.state !== "invalid")
    ) return undefined

    const presetMetadata = cloneAndFreeze(context.presetMetadata)
    const personaAddonStates = cloneAndFreeze(context.personaAddonStates)
    const prefillCarrier = cloneAndFreeze({
      id: rawCarrier.id,
      state: rawCarrier.state,
    })
    const mainDispatch = Object.freeze({
      source: "main" as const,
      descriptor,
      connectionDispatchRevision: rawDispatch.connectionDispatchRevision,
      dispatchKind: rawDispatch.dispatchKind,
    })
    return Object.freeze({
      ...context,
      presetMetadata,
      personaAddonStates,
      prefillCarrier,
      mainDispatch,
    })
  } catch {
    return undefined
  }
}

function correlationIdFor(payload: unknown): string {
  if (!isRecord(payload)) return FALLBACK_CORRELATION_ID
  const correlationId = payload.correlationId
  return typeof correlationId === "string" && UUID_PATTERN.test(correlationId)
    ? correlationId
    : FALLBACK_CORRELATION_ID
}



type ActiveExecution = Readonly<{
  userId: string
  presetId: string
  executionId: string
  cancellation: ExecutionCancellation
  epoch: number
  registrationOrder: number
  requiresFinalResponsePermission: boolean
  latestActivity: { value?: BackendActivityResponse["payload"] }
}>
type RuntimeSettledThreadOutput = SettledThreadOutput & Readonly<{
  readonly errorCategory?: ActivityErrorCategory
  /** Per-run normalized receipt usage before settlement accumulation. */
  readonly usage?: BackendActivityUsage
}>

type ResolvedDescriptor = Readonly<{
  descriptor: HostDispatchDescriptor
  revision: string
  source: "main" | "slot"
  consentConnectionId: string | null
  sourceKey: "main" | `slot:${string}`
}>

export interface BackendRuntimeOptions {
  readonly spindle: SpindleAPI
  readonly now?: () => number
}

export interface BackendRuntime {
  readonly spindle: SpindleAPI
  readonly admission: AdmissionRegistry
  readonly traces: TraceStore
  readonly store: AtomicJsonStore
  readonly ready: Promise<void>
  readonly start: () => Promise<void>
  readonly dispose: () => Promise<void>
}


function runtimeGlobals(): RuntimeGlobals {
  return globalThis as unknown as RuntimeGlobals
}

function keyFor(userId: string, presetId: string): string {
  return JSON.stringify([userId, presetId])
}

function executionKey(userId: string, presetId: string, executionId: string): string {
  return JSON.stringify([userId, presetId, executionId])
}

function userStorageAdapter(spindle: SpindleAPI): StorageAdapter {
  const installRecordPath = buildInstallRecordKey()
  const route = (path: string): { userId?: string; relativePath: string } => {
    if (path === installRecordPath) return { relativePath: path }
    const marker = "/agentic-preset-composer/"
    const markerIndex = path.indexOf(marker)
    if (markerIndex <= 0) return { relativePath: path }
    try {
      return {
        userId: decodeURIComponent(path.slice(0, markerIndex)),
        relativePath: path.slice(markerIndex + 1),
      }
    } catch {
      return { relativePath: path }
    }
  }
  return {
    read: async (path) => {
      const target = route(path)
      return target.userId === undefined
        ? spindle.storage.read(target.relativePath)
        : spindle.userStorage.read(target.relativePath, target.userId)
    },
    write: async (path, content) => {
      const target = route(path)
      if (target.userId === undefined) await spindle.storage.write(target.relativePath, content)
      else await spindle.userStorage.write(target.relativePath, content, target.userId)
    },
    move: async (from, to) => {
      const source = route(from)
      const destination = route(to)
      if (source.userId !== destination.userId) throw new Error("APC state cannot move across user scopes")
      if (source.userId === undefined) await spindle.storage.move(source.relativePath, destination.relativePath)
      else await spindle.userStorage.move(source.relativePath, destination.relativePath, source.userId)
    },
    delete: async (path) => {
      const target = route(path)
      if (target.userId === undefined) await spindle.storage.delete(target.relativePath)
      else await spindle.userStorage.delete(target.relativePath, target.userId)
    },
    exists: async (path) => {
      const target = route(path)
      return target.userId === undefined
        ? spindle.storage.exists(target.relativePath)
        : spindle.userStorage.exists(target.relativePath, target.userId)
    },
    list: async (prefix) => {
      const target = route(prefix)
      return target.userId === undefined
        ? spindle.storage.list(target.relativePath)
        : spindle.userStorage.list(target.relativePath, target.userId)
    },
  }
}

function modeOf(config: ApcPresetConfigV1): ApcMode {
  return config.activeMode
}

function settledStatus(result: AuxiliaryRunResult): NonNullable<SettledThreadOutput["status"]> {
  if (result.kind === "success") return "success"
  if (result.kind === "cancelled") return "cancelled"
  if (result.kind === "timed-out") return "failed"
  return "failed"
}
function settledActivityStatus(
  settlementStatus: "fulfilled" | "rejected",
  result: RuntimeSettledThreadOutput,
  timeoutTerminal: boolean,
): NonNullable<BackendActivityInput["runStatus"]> {
  if (settlementStatus === "rejected") return "failed"
  switch (result.status) {
    case "success":
    case "fulfilled":
      return "completed"
    case "failed":
    case "optional-failure":
      return result.errorCategory === "timeout" ? "timed-out" : "failed"
    case "skipped":
      return "skipped"
    case "cancelled":
    case "stopped":
    case "omitted":
      return timeoutTerminal ? "timed-out" : "cancelled"
    default:
      return "failed"
  }
}


function fallbackMessages(
  messages: readonly LlmMessageDTO[],
  prefillState: InterceptorContextDTO["prefillCarrier"]["state"],
): { messages: LlmMessageDTO[]; index: number } {
  let index = messages.length
  if (prefillState === "available") {
    for (let candidate = messages.length - 1; candidate >= 0; candidate -= 1) {
      const message = messages[candidate]
      if (message.role === "assistant" && typeof message.content === "string" && message.content.length > 0) {
        index = candidate
        break
      }
    }
  }
  const next = [...messages]
  next.splice(index, 0, { role: "system", content: APC_FALLBACK_CONTENT })
  return { messages: next, index }
}


export function setup(options: BackendRuntimeOptions | SpindleAPI): BackendRuntime {
  const spindle = "spindle" in (options as object) ? (options as BackendRuntimeOptions).spindle : options as SpindleAPI
  validateSpindleHostDescriptor(spindle.host)
  const existing = runtimeGlobals()[ACTIVE_RUNTIME_KEY]
  if (existing !== undefined) return existing

  const now = ("spindle" in (options as object) ? (options as BackendRuntimeOptions).now : undefined) ?? (() => Date.now())
  const admission = new AdmissionRegistry()
  const traces = createTraceStore(admission)
  const store = new AtomicJsonStore(userStorageAdapter(spindle))
  const bindings = createConnectionBindings({ store, connections: spindle.connections })
  const consent = createConsentService({ store })
  const activeExecutions = new Map<string, ActiveExecution>()
  let executionRegistrationOrder = 0
  const activeInterceptorCalls = new Set<Promise<LlmMessageDTO[] | InterceptorResultDTO>>()
  const epochs = new Map<string, number>()
  const fallbackTombstones = new Map<string, Readonly<{ userId: string; presetId: string }>>()
  const MAX_FALLBACK_TOMBSTONES_PER_SCOPE = 64
  const MAX_FALLBACK_TOMBSTONES = 256
  const claimFallbackTombstone = (userId: string, presetId: string, executionId: string): boolean => {
    const key = executionKey(userId, presetId, executionId)
    if (fallbackTombstones.has(key)) return false
    fallbackTombstones.set(key, Object.freeze({ userId, presetId }))
    let scopeCount = 0
    for (const tombstone of fallbackTombstones.values()) {
      if (tombstone.userId === userId && tombstone.presetId === presetId) scopeCount += 1
    }
    while (scopeCount > MAX_FALLBACK_TOMBSTONES_PER_SCOPE) {
      let removed = false
      for (const [candidateKey, tombstone] of fallbackTombstones) {
        if (tombstone.userId !== userId || tombstone.presetId !== presetId || candidateKey === key) continue
        fallbackTombstones.delete(candidateKey)
        scopeCount -= 1
        removed = true
        break
      }
      if (!removed) break
    }
    while (fallbackTombstones.size > MAX_FALLBACK_TOMBSTONES) {
      const oldest = fallbackTombstones.keys().next().value
      if (typeof oldest !== "string") break
      fallbackTombstones.delete(oldest)
    }
    return true
  }
  let disposed = false
  let started = false
  let readyStartupCancelled = false
  let startPromise: Promise<void> | undefined
  let disposePromise: Promise<void> | undefined
  let removeFrontendMessage: (() => void) | undefined
  let removePermissionWatcher: (() => void) | undefined
  const removeLifecycleWatchers: Array<() => void> = []
  let router: BackendEndpointRouter | undefined
  let registry: InterceptorRegistrationRegistry
  const terminalExecutions = new WeakSet<ActiveExecution>()
  const cancellationSources = new Map<string, ActivityCancellationSource>()
  const emitExecutionActivity = (
    execution: ActiveExecution | Readonly<{ userId: string }>,
    activity: RuntimeActivity,
  ): void => {
    if (disposed) return
    if ("presetId" in execution && "executionId" in execution) {
      if (activeExecutions.get(executionKey(execution.userId, execution.presetId, execution.executionId)) !== execution) return
      if (activity.terminal) {
        if (terminalExecutions.has(execution)) return
        terminalExecutions.add(execution)
      }
    }
    const activeRouter = router
    if (activeRouter === undefined) return
    try {
      const emitted = activeRouter.emitActivity(execution.userId, {
        ...activity,
        correlationId: correlationIdFor({ correlationId: activity.executionId }),
      })
      if (
        emitted !== undefined &&
        "presetId" in execution &&
        emitted.executionId === execution.executionId &&
        emitted.presetId === execution.presetId
      ) {
        execution.latestActivity.value = emitted
      }
    } catch {
      // A disconnected frontend or malformed host label cannot affect execution.
    }
  }
  const recordFinalResponseUnavailable = (
    context: InterceptorContextDTO,
    presetId: string,
    mode: ApcMode,
  ): void => {
    const key = executionKey(context.userId, presetId, context.generationId)
    const outcome = new OutcomeLatch()
    outcome.consider({
      class: "graph-fallback",
      code: "FINAL_RESPONSE_PERMISSION_MISSING",
      category: "host-gate",
    })
    const terminalOutcome = outcome.commit()
    let terminalActivityEmitted = false
    const emitTerminal = (): void => {
      if (terminalActivityEmitted) return
      terminalActivityEmitted = true
      emitExecutionActivity(
        { userId: context.userId },
        {
          executionId: context.generationId,
          presetId,
          kind: "final-response-permission-missing",
          phase: "completed",
          terminal: true,
          outcome: terminalOutcome.class,
        },
      )
    }
    let traceOwned = false
    let tombstoneClaimed = false
    try {
      if (fallbackTombstones.has(key)) return
      if (!claimFallbackTombstone(context.userId, presetId, context.generationId)) return
      tombstoneClaimed = true
      const existing = getTrace(traces, context.userId, presetId, context.generationId)
      if (existing?.status !== "active" && existing?.entries.some(entry => entry.kind === "final-response-permission-missing")) return
      const acquired = acquireTrace(
        traces,
        context.userId,
        presetId,
        context.generationId,
        Object.freeze({
          startedAt: now(),
          mode,
          generationType: context.generationType,
        }),
      )
      if (!acquired.accepted) {
        if (acquired.reason === "duplicate-execution") fallbackTombstones.delete(key)
        else emitTerminal()
        return
      }
      traceOwned = true
      const sequence = acquired.trace.lastSequence + 1
      const event = appendTrace(traces, context.userId, presetId, context.generationId, {
        sequence,
        kind: "final-response-permission-missing",
        type: "final-response-permission-missing",
        metadata: Object.freeze({
          reason: "final-response-permission-missing",
          outcome: terminalOutcome.class,
          outcomeCode: terminalOutcome.cause.code,
        }),
        preview: "Final response permission unavailable; native Main response preserved.",
      })
      if (!event.accepted) {
        releaseTrace(traces, context.userId, presetId, context.generationId)
        emitTerminal()
        return
      }
      const finalized = finalizeTrace(traces, context.userId, presetId, context.generationId, { status: "completed" })
      if (!finalized.accepted) {
        releaseTrace(traces, context.userId, presetId, context.generationId)
        emitTerminal()
        return
      }
      emitTerminal()
    } catch {
      if (traceOwned) {
        try {
          releaseTrace(traces, context.userId, presetId, context.generationId)
        } catch {
          // A trace failure cannot affect the native Main response.
        }
      }
      if (tombstoneClaimed) emitTerminal()
    }
  }
  const recordGraphFallback = (
    context: unknown,
    cause: Readonly<{
      code: string
      category: GraphFallbackCauseCategory
      activityKind?: string
    }> = RUNTIME_FAILURE_CAUSE,
  ): void => {
    let capturedContext: InterceptorContextDTO | undefined
    try {
      capturedContext = snapshotInterceptorContext(context as InterceptorContextDTO)
    } catch {
      return
    }
    if (capturedContext === undefined || capturedContext.presetId === null) return
    const presetId = capturedContext.presetId
    const executionId = capturedContext.generationId
    const key = executionKey(capturedContext.userId, presetId, executionId)
    const outcome = new OutcomeLatch()
    outcome.consider({
      class: "graph-fallback",
      code: cause.code,
      category: cause.category,
    })
    const terminalOutcome = outcome.commit()
    let terminalActivityEmitted = false
    const emitTerminal = (): void => {
      if (terminalActivityEmitted) return
      terminalActivityEmitted = true
      emitExecutionActivity(
        { userId: capturedContext.userId },
        {
          executionId,
          presetId,
          kind: cause.activityKind ?? "execution-terminal",
          phase: "completed",
          terminal: true,
          outcome: terminalOutcome.class,
        },
      )
    }
    let traceOwned = false
    let tombstoneClaimed = false
    try {
      if (fallbackTombstones.has(key)) return
      if (!claimFallbackTombstone(capturedContext.userId, presetId, executionId)) return
      tombstoneClaimed = true
      const existing = getTrace(traces, capturedContext.userId, presetId, executionId)
      if (existing?.status !== "active" && existing?.entries.some(entry => entry.kind === "runtime-fallback")) return
      let startedAt = 0
      try {
        const timestamp = now()
        if (Number.isFinite(timestamp)) startedAt = timestamp
      } catch {
        // The runtime clock is untrusted on this diagnostic-only path.
      }
      const acquired = acquireTrace(
        traces,
        capturedContext.userId,
        presetId,
        executionId,
        Object.freeze({ startedAt }),
      )
      if (!acquired.accepted) {
        if (acquired.reason === "duplicate-execution") fallbackTombstones.delete(key)
        else emitTerminal()
        return
      }
      traceOwned = true
      const event = appendTrace(traces, capturedContext.userId, presetId, executionId, {
        sequence: acquired.trace.lastSequence + 1,
        kind: "runtime-fallback",
        type: "runtime-fallback",
        metadata: Object.freeze({
          outcome: terminalOutcome.class,
          outcomeCode: terminalOutcome.cause.code,
        }),
        preview: "APC runtime failure; native messages returned.",
      })
      if (!event.accepted) {
        releaseTrace(traces, capturedContext.userId, presetId, executionId)
        emitTerminal()
        return
      }
      const finalized = finalizeTrace(traces, capturedContext.userId, presetId, executionId, { status: "completed" })
      if (!finalized.accepted) {
        releaseTrace(traces, capturedContext.userId, presetId, executionId)
        emitTerminal()
        return
      }
      emitTerminal()
    } catch {
      if (traceOwned) {
        try {
          releaseTrace(traces, capturedContext.userId, presetId, executionId)
        } catch {
          // A trace failure cannot affect the native Main response.
        }
      }
      if (tombstoneClaimed) emitTerminal()
    }
  }

  const safePermissionHas = (permission: string): boolean => {
    try {
      return spindle.permissions.has(permission) === true
    } catch {
      return false
    }
  }
  const hasRequiredPermissions = (): boolean => REQUIRED_PERMISSIONS.every((permission) => safePermissionHas(permission))
  const epochFor = (userId: string, presetId: string): number => epochs.get(keyFor(userId, presetId)) ?? 0
  const currentExecution = (userId: string, presetId: string): BackendActivityResponse["payload"] | undefined => {
    if (disposed) return undefined
    const currentEpoch = epochFor(userId, presetId)
    let selected: ActiveExecution | undefined
    for (const execution of activeExecutions.values()) {
      if (execution.userId !== userId || execution.presetId !== presetId || execution.epoch !== currentEpoch) continue
      if (selected === undefined || execution.registrationOrder > selected.registrationOrder) selected = execution
    }
    const activity = selected?.latestActivity.value
    return activity === undefined || activity.terminal ? undefined : activity
  }
  const abortExecution = (execution: ActiveExecution, reason: CancellationReason): void => {
    const source = cancellationSourceFor(reason)
    const key = executionKey(execution.userId, execution.presetId, execution.executionId)
    if (source !== undefined && !cancellationSources.has(key)) cancellationSources.set(key, source)
    execution.cancellation.stop(reason)
  }
  const revokeAndAbort = (reason: CancellationReason): void => {
    registry.revoke()
    for (const execution of activeExecutions.values()) abortExecution(execution, reason)
  }
  const MAX_EPOCH_SCOPES = 256
  const bumpEpoch = (userId: string, presetId: string): number => {
    const key = keyFor(userId, presetId)
    const next = (epochs.get(key) ?? 0) + 1
    epochs.delete(key)
    epochs.set(key, next)
    if (epochs.size > MAX_EPOCH_SCOPES) {
      for (const candidateKey of epochs.keys()) {
        if (candidateKey === key) continue
        let active = false
        for (const activeExecution of activeExecutions.values()) {
          if (keyFor(activeExecution.userId, activeExecution.presetId) === candidateKey) {
            active = true
            break
          }
        }
        if (active) continue
        epochs.delete(candidateKey)
        if (epochs.size <= MAX_EPOCH_SCOPES) break
      }
    }
    for (const activeExecution of activeExecutions.values()) {
      if (activeExecution.userId === userId && activeExecution.presetId === presetId && activeExecution.epoch !== next) {
        abortExecution(activeExecution, "replacement")
      }
    }
    return next
  }
  const cleanupUnexpectedExecution = (expectedExecution: ActiveExecution | undefined): void => {
    if (expectedExecution === undefined) return
    const key = executionKey(expectedExecution.userId, expectedExecution.presetId, expectedExecution.executionId)
    const execution = activeExecutions.get(key)
    if (execution === undefined || execution !== expectedExecution) return
    activeExecutions.delete(key)
    cancellationSources.delete(key)
    try {
      execution.cancellation.stop("stop")
    } catch {
      // Cleanup remains fail-closed when the cancellation tree is already broken.
    }
    try {
      execution.cancellation.dispose()
    } catch {
      // Cleanup remains fail-closed when the cancellation tree is already broken.
    }
    try {
      releaseTrace(traces, expectedExecution.userId, expectedExecution.presetId, expectedExecution.executionId)
    } catch {
      // Trace retention is diagnostic only.
    }
  }

  const permissionView = Object.freeze({ has: (permission: string): boolean => safePermissionHas(permission) })
  const onPermissionChanged = (_detail: PermissionChangedDetail): void => {
    if (disposed) return
    if (!hasRequiredPermissions()) {
      revokeAndAbort("permission-revoked")
      return
    }
    if (!safePermissionHas("final_response")) {
      for (const execution of activeExecutions.values()) {
        if (execution.requiresFinalResponsePermission) abortExecution(execution, "permission-revoked")
      }
    }
    registry.ensureRegistered({ permissions: permissionView, handler: trackedInterceptorHandler })
  }



  const traceMetadata = (context: InterceptorContextDTO, mode: ApcMode): TraceMetadata => Object.freeze({
    traceId: context.generationId,
    startedAt: now(),
    chatId: context.chatId,
    mode,
    generationType: context.generationType,
  })

  const appendRunTrace = (context: InterceptorContextDTO, presetId: string, sequence: number, kind: string, status: string, runId: string): void => {
    const timestamp = now()
    appendTrace(traces, context.userId, presetId, context.generationId, {
      sequence,
      kind,
      type: kind,
      metadata: Object.freeze({
        runId,
        status,
        timestamp,
      }),
    })
  }

  const resolveDescriptor = async (
    context: InterceptorContextDTO,
    presetId: string,
    mode: ApcMode,
    planned: PlannedRun,
  ): Promise<ResolvedDescriptor | undefined> => {
    if (mode === "parallel" && planned.thread.connectionSlotId !== undefined) {
      const binding = await bindings.resolveSlot({
        userId: context.userId,
        presetId,
        slotId: planned.thread.connectionSlotId,
      })
      return {
        descriptor: binding.descriptor,
        revision: binding.dispatchRevision,
        source: "slot",
        consentConnectionId: binding.connectionId,
        sourceKey: binding.connectionSourceKey,
      }
    }
    if (
      context.mainDispatch.descriptor === null ||
      context.mainDispatch.dispatchKind !== "concrete" ||
      context.mainDispatch.connectionDispatchRevision === null ||
      context.mainDispatch.descriptor.connectionDispatchRevision !== context.mainDispatch.connectionDispatchRevision
    ) return undefined
    return {
      descriptor: cloneDispatchDescriptor(context.mainDispatch.descriptor),
      revision: context.mainDispatch.connectionDispatchRevision,
      source: "main",
      consentConnectionId: null,
      sourceKey: "main",
    }
  }

  const runOne = async (
    context: InterceptorContextDTO,
    presetId: string,
    mode: ApcMode,
    planned: PlannedRun,
    previousOutputs: ReadonlyMap<string, SettledThreadOutput>,
    rootCancellation: ExecutionCancellation,
    capturedEpoch: number,
    activeExecution: ActiveExecution,
    sequence: { value: number },
    parentMessages: readonly LlmMessageDTO[],
    emitProgress: (update: ActivityUpdate) => void,
    reportError: (category: ActivityErrorCategory, runId?: string) => void,
    markChildTimeout: (accepted: boolean) => void,
  ): Promise<RuntimeSettledThreadOutput> => {
    const current = (): boolean =>
      !disposed &&
      started &&
      hasRequiredPermissions() &&
      (!activeExecution.requiresFinalResponsePermission || safePermissionHas("final_response")) &&
      registry.has() &&
      rootCancellation.isActive() &&
      activeExecutions.get(executionKey(context.userId, presetId, context.generationId)) === activeExecution &&
      epochFor(context.userId, presetId) === capturedEpoch
    const cancellationRun = (): RuntimeSettledThreadOutput => Object.freeze({
      runId: planned.id,
      threadId: planned.thread.id,
      status: "cancelled" as const,
      ...(rootCancellation.reason === "deadline" || rootCancellation.reason === "child-timeout"
        ? { errorCategory: "timeout" as const }
        : {}),
    })
    const failedRun = (
      status: NonNullable<SettledThreadOutput["status"]>,
      traceKind: string,
    ): RuntimeSettledThreadOutput => {
      if (!current()) return cancellationRun()
      sequence.value += 1
      appendRunTrace(context, presetId, sequence.value, traceKind, status, planned.id)
      let errorCategory: ActivityErrorCategory | undefined
      if (traceKind === "missing_input" || traceKind === "run_skipped") errorCategory = "config"
      else if (traceKind === "dispatch_resolution_failed" || traceKind === "dispatch_unavailable") errorCategory = "dispatch"
      else if (traceKind === "consent_required") errorCategory = "consent"
      else if (status === "failed") errorCategory = "unknown"
      if (status === "failed" || traceKind === "run_skipped") {
        reportError(errorCategory ?? "unknown", planned.id)
      }
      if (planned.run.required || status === "failed" && traceKind === "missing_input") {
        rootCancellation.stop("required-failure")
      }
      return Object.freeze({
        runId: planned.id,
        threadId: planned.thread.id,
        status,
        ...(errorCategory === undefined ? {} : { errorCategory }),
      })
    }

    if (!current()) return cancellationRun()
    emitProgress({ kind: "run-start", phase: "progress", terminal: false })

    const resolvedInput = resolveRunInputs(planned, previousOutputs as unknown as SettledOutputs)
    if (resolvedInput.status !== "ready") {
      return failedRun(
        resolvedInput.status === "skip-run" ? "skipped" : "failed",
        resolvedInput.status === "skip-run" ? "run_skipped" : "missing_input",
      )
    }
    let resolved: ResolvedDescriptor | undefined
    try {
      resolved = await resolveDescriptor(context, presetId, mode, planned)
    } catch {
      return failedRun("failed", "dispatch_resolution_failed")
    }
    if (resolved === undefined) return failedRun("failed", "dispatch_unavailable")
    if (!current()) return cancellationRun()
    const provider = safeActivityLabel(resolved.descriptor.provider, 256)
    const model = safeActivityLabel(resolved.descriptor.model, 320)
    emitProgress({
      kind: "run-dispatch",
      phase: "progress",
      terminal: false,
      ...(provider === undefined ? {} : { provider }),
      ...(model === undefined ? {} : { model }),
    })

    try {
      const disclosure = consent.rememberDisclosure({
        userId: context.userId,
        presetId,
        threadId: planned.thread.id,
        workspaceSource: planned.thread.workspaceSource,
        connectionSourceKey: resolved.sourceKey,
        connectionId: resolved.consentConnectionId,
        descriptor: resolved.descriptor,
      })
      await consent.authorizeExecution({
        userId: context.userId,
        presetId,
        threadId: planned.thread.id,
        workspaceSource: planned.thread.workspaceSource,
        connectionSourceKey: resolved.sourceKey,
        connectionId: resolved.consentConnectionId,
        descriptor: resolved.descriptor,
        dispatchRevision: resolved.revision,
        disclosureVersion: disclosure.disclosureVersion,
      })
    } catch {
      if (!current()) return cancellationRun()
      sequence.value += 1
      reportError("consent", planned.id)
      if (planned.run.required) rootCancellation.stop("required-failure")
      appendRunTrace(context, presetId, sequence.value, "consent_required", "failed", planned.id)
      return Object.freeze({
        runId: planned.id,
        threadId: planned.thread.id,
        status: "failed" as const,
        errorCategory: "consent" as const,
      })
    }
    if (!current()) return cancellationRun()

    const runWorkspace = createRunWorkspace(
      planned.thread,
      planned.id,
      planned.thread.workspaceSource === "main-context"
        ? { mainMessages: parentMessages }
        : undefined,
    )
    const detachedWorkspace = materializeWorkspace(runWorkspace)
    const bindingsInput = resolvedInput.bindings.map((binding) => ({
      role: binding.role,
      content: binding.content,
    }))
      const result = await executeAuxiliaryRun({
        context,
        resolvedHostDescriptor: resolved.descriptor,
        run: { id: planned.id, timeoutMs: planned.run.timeoutMs },
        workspace: detachedWorkspace.source === "native-blocks"
          ? {
              source: "native-blocks",
              blocks: detachedWorkspace.blocks,
              promptVariableValues: detachedWorkspace.promptVariableValues,
            }
          : { source: "main-context" },
        mainMessages: detachedWorkspace.source === "main-context"
          ? detachedWorkspace.mainMessages
          : undefined,
        inputBindings: bindingsInput,
        parentSignal: rootCancellation.signal,
        deadlineAt: rootCancellation.deadlineAt,
        expectedDispatchRevision: resolved.revision,
        dispatchSource: resolved.source,
      }, {
        assemble: (request) => spindle.generate.assemble(request),
        quietTracked: (request) => spindle.generate.quietTracked(request),
        isExecutionCurrent: current,
        now,
      })
      if (result.kind === "timed-out") {
        const accepted = rootCancellation.stop("child-timeout")
        markChildTimeout(accepted)
      }
      const usage = normalizedReceiptUsage(result)
      if (!current()) {
        const cancelled = cancellationRun()
        return Object.freeze({
          ...cancelled,
          ...(usage === undefined ? {} : { usage }),
        })
      }
      sequence.value += 1
      if (
        result.kind === "success" &&
        result.content.trim().length > 0 &&
        utf8Bytes(result.content) <= MAX_THREAD_OUTPUT_BYTES &&
        !(result.response.tool_calls?.length)
      ) {
        const item = Object.freeze({
          runId: planned.id,
          threadId: planned.thread.id,
          status: "success" as const,
          content: result.content,
          reasoning: result.reasoning,
          ...(usage === undefined ? {} : { usage }),
        })
        appendRunTrace(context, presetId, sequence.value, "run_completed", "success", planned.id)
        return item
      }
      let errorCategory: ActivityErrorCategory | undefined
      if (result.kind === "success") {
        errorCategory = result.response.tool_calls?.length ? "tool" : "unknown"
      } else if (result.kind !== "cancelled") {
        errorCategory = activityErrorCategory(result)
      }
      if (errorCategory !== undefined) reportError(errorCategory, planned.id)
      const status = settledStatus(result)
      const item = Object.freeze({
        runId: planned.id,
        threadId: planned.thread.id,
        status,
        ...(errorCategory === undefined ? {} : { errorCategory }),
        ...(usage === undefined ? {} : { usage }),
      })
      appendRunTrace(context, presetId, sequence.value, "run_failed", status, planned.id)
      if (planned.run.required && result.kind !== "timed-out") rootCancellation.stop("required-failure")
      return item
  }

  async function handleInterceptor(
    messages: LlmMessageDTO[],
    context: InterceptorContextDTO,
    invocation: { activeExecution?: ActiveExecution; context?: InterceptorContextDTO },
  ): Promise<LlmMessageDTO[] | InterceptorResultDTO> {
    if (disposed || !started || !hasRequiredPermissions() || !registry.has()) return messages
    const capturedContext = snapshotInterceptorContext(context)
    if (capturedContext === undefined || capturedContext.signal.aborted) return messages
    invocation.context = capturedContext
    const presetId = capturedContext.presetId
    if (presetId === null) return messages
    if (fallbackTombstones.has(executionKey(capturedContext.userId, presetId, capturedContext.generationId))) return messages
    const parentMessages = snapshotParentMessages(messages)
    if (parentMessages === undefined) return messages
    const decoded = decodeApcPresetConfig(capturedContext.presetMetadata)
    if (decoded.config === null || decoded.status === "future" || decoded.config.activeMode === "single") return messages
    if (now() >= capturedContext.boundWorkDeadlineAt) return messages
    const mode = modeOf(decoded.config)
    let plan: GraphExecutionPlan
    try {
      plan = planGraphExecution(decoded.config, mode)
    } catch {
      return messages
    }
    if (plan.finalResponse?.source === "thread" && !safePermissionHas("final_response")) {
      try {
        const existing = getTrace(traces, capturedContext.userId, presetId, capturedContext.generationId)
        if (
          existing?.status !== "active" &&
          existing?.entries.some(entry => entry.kind === "final-response-permission-missing")
        ) return messages
        recordFinalResponseUnavailable(capturedContext, presetId, mode)
      } catch {
        // Trace persistence is diagnostic only; preserve the native Main response.
      }
      return messages
    }
    const acquired = acquireTrace(
      traces,
      capturedContext.userId,
      presetId,
      capturedContext.generationId,
      traceMetadata(capturedContext, mode),
    )
    if (!acquired.accepted) {
      if (acquired.reason !== "duplicate-execution") recordGraphFallback(capturedContext, TRACE_ADMISSION_CAUSE)
      return messages
    }
    const clock = {
      now,
      setTimeout: (handler: () => void, delayMs: number) => globalThis.setTimeout(handler, delayMs),
      clearTimeout: (handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
    }
    let rootCancellation: ExecutionCancellation
    try {
      rootCancellation = createExecutionCancellation({
        hostSignal: capturedContext.signal,
        deadlineAt: capturedContext.boundWorkDeadlineAt,
        clock,
      })
    } catch {
      releaseTrace(traces, capturedContext.userId, presetId, capturedContext.generationId)
      recordGraphFallback(capturedContext)
      return messages
    }
    const capturedEpoch = epochFor(capturedContext.userId, presetId)
    const registrationOrder = ++executionRegistrationOrder
    const activeExecution: ActiveExecution = Object.freeze({
      userId: capturedContext.userId,
      presetId,
      executionId: capturedContext.generationId,
      cancellation: rootCancellation,
      requiresFinalResponsePermission: plan.finalResponse?.source === "thread",
      epoch: capturedEpoch,
      registrationOrder,
      latestActivity: {},
    })
    const activeKey = executionKey(capturedContext.userId, presetId, capturedContext.generationId)
    cancellationSources.delete(activeKey)
    activeExecutions.set(activeKey, activeExecution)
    invocation.activeExecution = activeExecution
    const outcome = new OutcomeLatch()
    const sequence = { value: acquired.trace.lastSequence }
    const totalRuns = plan.stages.reduce((total, stage) => total + stage.runs.length, 0)
    let completedRuns = 0
    const settled: RuntimeSettledThreadOutput[] = []
    let cumulativeUsage: BackendActivityUsage | undefined
    let childTimeoutWon = false
    let graphCallbackFailure = false
    let terminalErrorCategory: ActivityErrorCategory | undefined
    let selectedFinalErrorCategory: ActivityErrorCategory | undefined
    const runErrorCategories = new Map<string, ActivityErrorCategory>()
    const reportError = (category: ActivityErrorCategory, runId?: string): void => {
      if (runId !== undefined) runErrorCategories.set(runId, category)
      terminalErrorCategory ??= category
    }
    sequence.value += 1
    appendTrace(traces, capturedContext.userId, presetId, capturedContext.generationId, {
      sequence: sequence.value,
      kind: "execution-start",
      type: "execution",
      metadata: Object.freeze({
        status: "started",
        timestamp: now(),
      }),
      preview: "started",
    })
    emitExecutionActivity(activeExecution, {
      executionId: capturedContext.generationId,
      presetId,
      kind: "execution",
      phase: "started",
      terminal: false,
      traceId: capturedContext.generationId,
      stageCount: plan.stages.length,
      completedRuns,
      totalRuns,
      remainingBudgetMs: remainingBudget(rootCancellation.deadlineAt, now()),
    })
    try {
      const graphResult = await executeGraphPlan<RuntimeSettledThreadOutput>(plan, async (planned, taskContext) => {
        const stage = plan.stages[planned.stageIndex]
        const emitProgress = (update: ActivityUpdate): void => {
          if (!rootCancellation.isActive()) return
          emitExecutionActivity(activeExecution, {
            executionId: capturedContext.generationId,
            presetId,
            traceId: capturedContext.generationId,
            stageIndex: planned.stageIndex,
            stageCount: plan.stages.length,
            runIndex: planned.index,
            runCount: stage?.runs.length ?? 0,
            completedRuns,
            totalRuns,
            remainingBudgetMs: remainingBudget(rootCancellation.deadlineAt, now()),
            ...update,
            ...(cumulativeUsage === undefined ? {} : { usage: cumulativeUsage }),
          })
        }
        return runOne(
          capturedContext,
          presetId,
          plan.mode,
          planned,
          taskContext.outputs,
          rootCancellation,
          capturedEpoch,
          activeExecution,
          sequence,
          parentMessages,
          emitProgress,
          reportError,
          (accepted) => { if (accepted) childTimeoutWon = true },
        )
      })
      if (activeExecutions.get(activeKey) !== activeExecution) return messages
      for (const settlement of graphResult.runs) {
        const planned = plan.runById[settlement.runId]
        if (settlement.status === "rejected" && !graphCallbackFailure) {
          graphCallbackFailure = true
          let tombstoneClaimed = false
          try {
            tombstoneClaimed = claimFallbackTombstone(capturedContext.userId, presetId, capturedContext.generationId)
          } catch {
            // A fallback tombstone is diagnostic protection only.
          }
          if (tombstoneClaimed) {
            sequence.value += 1
            try {
              appendTrace(traces, capturedContext.userId, presetId, capturedContext.generationId, {
                sequence: sequence.value,
                kind: "runtime-fallback",
                type: "runtime-fallback",
                metadata: Object.freeze({
                  outcome: "graph-fallback",
                  outcomeCode: RUNTIME_FAILURE_CAUSE.code,
                }),
                preview: "APC runtime failure; native messages returned.",
              })
            } catch {
              // Diagnostic trace retention cannot replace the native response.
            }
          }
          outcome.consider({
            class: "graph-fallback",
            code: RUNTIME_FAILURE_CAUSE.code,
            category: RUNTIME_FAILURE_CAUSE.category,
          })
        }
        const result: RuntimeSettledThreadOutput = settlement.status === "fulfilled"
          ? settlement.value
          : Object.freeze({
              runId: settlement.runId,
              threadId: settlement.threadId,
              status: "failed" as const,
              errorCategory: "unknown" as const,
            })
        const runUsage = result.usage
        const activityUsage = runUsage === undefined ? undefined : addActivityUsage(cumulativeUsage, runUsage)
        if (activityUsage !== undefined) cumulativeUsage = activityUsage
        const { usage: ignoredUsage, ...resultWithoutUsage } = result
        void ignoredUsage
        const settledResult: RuntimeSettledThreadOutput = Object.freeze({
          ...resultWithoutUsage,
          ...(activityUsage === undefined ? {} : { usage: activityUsage }),
        })
        settled.push(settledResult)
        completedRuns += 1
        const stageIndex = planned?.stageIndex ?? settlement.stageIndex
        const runIndex = planned?.index ?? settlement.index
        const stage = plan.stages[stageIndex]
        emitExecutionActivity(activeExecution, {
          executionId: capturedContext.generationId,
          presetId,
          kind: "run-settled",
          phase: "progress",
          terminal: false,
          traceId: capturedContext.generationId,
          stageIndex,
          stageCount: plan.stages.length,
          runIndex,
          runCount: stage?.runs.length ?? 0,
          completedRuns,
          totalRuns,
          remainingBudgetMs: remainingBudget(rootCancellation.deadlineAt, now()),
          runStatus: settledActivityStatus(
            settlement.status,
            settledResult,
            childTimeoutWon || rootCancellation.reason === "deadline" || rootCancellation.reason === "child-timeout",
          ),
          ...(activityUsage === undefined ? {} : { usage: activityUsage }),
        })
        if (settlement.status === "rejected") {
          // Rejected executor callbacks are runtime failures, not typed run failures.
        } else if (result.status === "success") {
          outcome.consider({
            class: "success",
            code: "RUN_SUCCESS",
            pipelineIndex: result.threadId === undefined ? undefined : planned?.stageIndex,
            stageIndex: planned?.stageIndex,
            runId: result.runId,
            runIndex: planned?.index,
          })
        } else if (planned?.run.required) {
          outcome.consider({
            class: "graph-fallback",
            code: "REQUIRED_RUN_FAILED",
            category: "guidance-workspace-fallback-validation",
            pipelineIndex: planned.stageIndex,
            stageIndex: planned.stageIndex,
            runId: planned.id,
            runIndex: planned.index,
          })
        } else if (result.status === "failed") {
          outcome.consider({
            class: "optional-local",
            code: "OPTIONAL_RUN_FAILED",
            stageIndex: planned?.stageIndex,
            runId: result.runId,
            runIndex: planned?.index,
          })
        }
      }
      switch (rootCancellation.reason) {
        case "host-abort":
        case "stop":
        case "permission-revoked":
        case "replacement":
        case "disable":
        case "update":
        case "disposed":
          if (!childTimeoutWon) outcome.consider({ class: "parent-cancel", code: rootCancellation.reason })
          break
        case "deadline":
        case "child-timeout":
          outcome.consider({
            class: "graph-fallback",
            code: rootCancellation.reason,
            category: "timeout-deadline",
          })
          break
        case "required-failure":
          outcome.consider({ class: "graph-fallback", code: rootCancellation.reason, category: "required-typed-run" })
          break
        case "integrity-fatal":
          outcome.consider({ class: "integrity-fatal", code: rootCancellation.reason })
          break
        default:
          break
      }
      if (childTimeoutWon || rootCancellation.reason === "deadline" || rootCancellation.reason === "child-timeout") {
        outcome.consider({
          class: "graph-fallback",
          code: rootCancellation.reason === "deadline" || rootCancellation.reason === "child-timeout"
            ? rootCancellation.reason
            : "CHILD_TIMEOUT",
          category: "timeout-deadline",
        })
      }
      if (
        graphCallbackFailure ||
        childTimeoutWon ||
        rootCancellation.reason === "deadline" ||
        rootCancellation.reason === "child-timeout"
      ) return messages
      const routingOutcome = outcome.snapshot()
      if (
        rootCancellation.reason === "host-abort" ||
        rootCancellation.reason === "stop" ||
        rootCancellation.reason === "permission-revoked" ||
        rootCancellation.reason === "replacement" ||
        rootCancellation.reason === "disable" ||
        rootCancellation.reason === "update" ||
        rootCancellation.reason === "disposed"
      ) return messages

      const finalResponse = plan.finalResponse
      if (finalResponse === null) return messages
      let routingMessages: LlmMessageDTO[] = parentMessages
      let fallbackMessageIndex = parentMessages.length
      if (finalResponse.source === "thread") {
        const fallback = fallbackMessages(parentMessages, capturedContext.prefillCarrier.state)
        routingMessages = fallback.messages
        fallbackMessageIndex = fallback.index
      }
      const routed = routeFinalResponse({
        mode,
        config: decoded.config,
        finalResponse,
        settledRuns: settled,
        fallbackMessageIndex,
        fallbackState: { status: "available", available: true, valid: true },
        terminalOutcome: routingOutcome,
        hasFinalResponsePermission: safePermissionHas("final_response"),
        stopped: !rootCancellation.isActive(),
      })
      const selectedFinalFailure =
        routed.fallbackReason === "run-failed" ||
        routed.fallbackReason === "run-unavailable" ||
        routed.fallbackReason === "candidate-invalid" ||
        routed.fallbackReason === "candidate-too-large" ||
        routed.fallbackReason === "candidate-tool-calls" ||
        routed.fallbackReason === "host-normalization-failed"
      if (routed.kind === "fallback") {
        const isSelectedFinalFailure = finalResponse.source === "thread" && selectedFinalFailure
        if (isSelectedFinalFailure) selectedFinalErrorCategory = runErrorCategories.get(finalResponse.runId)
        outcome.consider(
          isSelectedFinalFailure
            ? { class: "selected-final-failure", code: "FINAL_ROUTE_FALLBACK" }
            : {
                class: "graph-fallback",
                code: "FINAL_ROUTE_FALLBACK",
                category: "guidance-workspace-fallback-validation",
              },
        )
      }
      if (isThreadFinalRoutingResult(routed)) {
        return {
          messages: routingMessages,
          breakdown: [{ messageIndex: fallbackMessageIndex, name: "Native provider fallback" }],
          finalResponse: routed.selected,
          deferredGuidance: [...routed.guidance.deferredGuidance],
        }
      }
      if (routed.guidance.deferredGuidance.length > 0) {
        return { messages: parentMessages, deferredGuidance: [...routed.guidance.deferredGuidance] }
      }
      return messages
    } catch {
      let tombstoneClaimed = false
      try {
        tombstoneClaimed = claimFallbackTombstone(capturedContext.userId, presetId, capturedContext.generationId)
      } catch {
        // A fallback tombstone is diagnostic protection only.
      }
      if (tombstoneClaimed) {
        sequence.value += 1
        try {
          appendTrace(traces, capturedContext.userId, presetId, capturedContext.generationId, {
            sequence: sequence.value,
            kind: "runtime-fallback",
            type: "runtime-fallback",
            metadata: Object.freeze({
              outcome: "graph-fallback",
              outcomeCode: RUNTIME_FAILURE_CAUSE.code,
            }),
            preview: "APC runtime failure; native messages returned.",
          })
        } catch {
          // Diagnostic trace retention cannot replace the native response.
        }
      }
      outcome.consider({
        class: "graph-fallback",
        code: RUNTIME_FAILURE_CAUSE.code,
        category: RUNTIME_FAILURE_CAUSE.category,
      })
      return messages
    } finally {
      let cancellationReason = rootCancellation.reason
      if (capturedContext.signal.aborted) {
        const accepted = rootCancellation.stop("host-abort")
        if (accepted && !childTimeoutWon) {
          if (!cancellationSources.has(activeKey)) cancellationSources.set(activeKey, "stop")
          outcome.consider({ class: "parent-cancel", code: "host-abort" })
        }
      }
      if (!hasRequiredPermissions()) {
        const accepted = rootCancellation.stop("permission-revoked")
        if (accepted && !childTimeoutWon) {
          if (!cancellationSources.has(activeKey)) cancellationSources.set(activeKey, "permission-revoked")
          outcome.consider({ class: "parent-cancel", code: "permission-revoked" })
        }
      }
      if (plan.finalResponse?.source === "thread" && !safePermissionHas("final_response")) {
        const accepted = rootCancellation.stop("permission-revoked")
        if (accepted && !childTimeoutWon) {
          if (!cancellationSources.has(activeKey)) cancellationSources.set(activeKey, "permission-revoked")
          outcome.consider({ class: "parent-cancel", code: "permission-revoked" })
        }
      }
      cancellationReason = rootCancellation.reason
      const terminalOutcome = outcome.committed ? outcome.snapshot() : outcome.commit()
      const cancellationTerminal =
        !childTimeoutWon && (
          terminalOutcome.class === "parent-cancel" ||
          cancellationReason === "host-abort" ||
          cancellationReason === "stop" ||
          cancellationReason === "permission-revoked" ||
          cancellationReason === "replacement" ||
          cancellationReason === "disable" ||
          cancellationReason === "update" ||
          cancellationReason === "disposed"
        )
      const terminalPhase: ActivityPhase =
        terminalOutcome.class === "integrity-fatal" || terminalOutcome.class === "selected-final-failure"
          ? "failed"
          : cancellationTerminal
            ? "cancelled"
            : "completed"
      const status = terminalPhase === "cancelled" ? "cancelled" as const : "completed" as const
      const cancellationSource = terminalPhase === "cancelled"
        ? cancellationSources.get(activeKey) ?? cancellationSourceFor(cancellationReason) ?? "stop"
        : undefined
      const errorCategory = terminalPhase === "failed"
        ? terminalOutcome.class === "integrity-fatal"
          ? "integrity" as const
          : selectedFinalErrorCategory ?? "unknown"
        : undefined
      emitExecutionActivity(activeExecution, {
        executionId: capturedContext.generationId,
        presetId,
        kind: "execution-terminal",
        phase: terminalPhase,
        terminal: true,
        traceId: capturedContext.generationId,
        completedRuns,
        totalRuns,
        remainingBudgetMs: remainingBudget(rootCancellation.deadlineAt, now()),
        ...(terminalPhase === "cancelled"
          ? { outcome: "parent-cancel" as const }
          : { outcome: terminalOutcome.class }),
        ...(cumulativeUsage === undefined ? {} : { usage: cumulativeUsage }),
        ...(errorCategory === undefined ? {} : { errorCategory }),
        ...(cancellationSource === undefined ? {} : { cancellationSource }),
      })
      if (activeExecutions.get(activeKey) === activeExecution) {
        try {
          finalizeTrace(traces, capturedContext.userId, presetId, capturedContext.generationId, {
            sequence: sequence.value + 1,
            status,
            kind: "terminal",
            type: "terminal",
            metadata: Object.freeze({
              outcome: terminalOutcome.class,
              outcomeCode: terminalOutcome.cause.code,
              finishedAt: now(),
            }),
            preview: terminalOutcome.class,
          })
        } catch {
          // Bounded trace retention may evict a completed trace before finalization.
        }
      }
      if (activeExecutions.get(activeKey) === activeExecution) {
        activeExecutions.delete(activeKey)
        cancellationSources.delete(activeKey)
      }
      try {
        rootCancellation.dispose()
      } catch {
        // Cancellation cleanup cannot replace the settled execution result.
      }
    }
  }

  const trackedInterceptorHandler = async (
    messages: LlmMessageDTO[],
    context: InterceptorContextDTO,
  ): Promise<LlmMessageDTO[] | InterceptorResultDTO> => {
    const invocation: { activeExecution?: ActiveExecution; context?: InterceptorContextDTO } = {}
    const pending = handleInterceptor(messages, context, invocation)
    activeInterceptorCalls.add(pending)
    try {
      return await pending
    } catch {
      cleanupUnexpectedExecution(invocation.activeExecution)
      recordGraphFallback(invocation.context ?? context)
      return messages
    } finally {
      activeInterceptorCalls.delete(pending)
    }
  }

  const cancel = async (
    userId: string,
    presetId: string,
    executionId: string,
    reason: "user" | "stop" | "replacement",
  ): Promise<{ accepted: boolean; presetId: string; executionId: string; traceId: string; kind: string }> => {
    const key = executionKey(userId, presetId, executionId)
    const activeExecution = activeExecutions.get(key)
    if (activeExecution === undefined) return { accepted: false, presetId, executionId, traceId: executionId, kind: "cancelled" }
    const stopReason = reason === "replacement" ? "replacement" : "stop"
    const accepted = activeExecution.cancellation.stop(stopReason)
    if (accepted) {
      const source = cancellationSourceFor(reason)
      if (source !== undefined) cancellationSources.set(key, source)
    }
    return { accepted, presetId, executionId, traceId: executionId, kind: "cancelled" }
  }

  registry = createInterceptorRegistrationRegistry(spindle)
  const disposeWithReason = (reason: CancellationReason): Promise<void> => {
    if (disposePromise !== undefined) return disposePromise
    if (startPromise === undefined && !started) readyStartupCancelled = true
    disposePromise = (async () => {
      if (disposed) return
      for (const execution of activeExecutions.values()) {
        abortExecution(execution, reason)
        emitExecutionActivity(execution, {
          executionId: execution.executionId,
          presetId: execution.presetId,
          kind: "execution-terminal",
          phase: "cancelled",
          terminal: true,
          traceId: execution.executionId,
          outcome: "parent-cancel",
          cancellationSource: cancellationSourceFor(reason) ?? "disposed",
        })
        const trace = getTrace(traces, execution.userId, execution.presetId, execution.executionId)
        try {
          finalizeTrace(traces, execution.userId, execution.presetId, execution.executionId, {
            sequence: (trace?.lastSequence ?? 0) + 1,
            kind: "terminal",
            type: "terminal",
            metadata: Object.freeze({
              outcome: "parent-cancel",
              outcomeCode: reason,
              finishedAt: now(),
            }),
            preview: "parent-cancel",
          })
        } catch {
          // Bounded trace retention may evict a completed trace before finalization.
        }
      }
      disposed = true
      removeFrontendMessage?.()
      removeFrontendMessage = undefined
      removePermissionWatcher?.()
      removePermissionWatcher = undefined
      for (const remove of removeLifecycleWatchers.splice(0)) {
        try {
          remove()
        } catch {
          // Listener removal is best effort; the closed runtime remains inert.
        }
      }
      registry.teardown()
      router?.dispose()
      router = undefined
      activeExecutions.clear()
      epochs.clear()
      fallbackTombstones.clear()
      started = false
      await Promise.allSettled([...activeInterceptorCalls])
      if (runtimeGlobals()[ACTIVE_RUNTIME_KEY] === runtime) delete runtimeGlobals()[ACTIVE_RUNTIME_KEY]
    })()
    return disposePromise
  }

  const watchLifecycle = (event: string, reason: CancellationReason): void => {
    try {
      const remove = spindle.on(event, () => {
        void disposeWithReason(reason).catch(() => undefined)
      })
      if (typeof remove === "function") removeLifecycleWatchers.push(remove)
    } catch {
      // Hosts without lifecycle event delivery still invoke the exported teardown.
    }
  }

  const start = async (): Promise<void> => {
    if (disposed) throw new Error("APC backend runtime is disposed")
    if (started) return
    if (startPromise !== undefined) return startPromise
    startPromise = (async () => {
      await store.initialize(spindle.host.extensionInstallationId)
      if (disposed) throw new Error("APC backend runtime was disposed during startup")
      router = createBackendEndpointRouter({
        state: { getInstallPair: () => store.getInstallPair() },
        bindings: bindings as unknown as BackendEndpointDependencies["bindings"],
        consent: consent as unknown as BackendEndpointDependencies["consent"],
        traces,
        admission,
        execution: {
          cancel: async (request: Parameters<BackendEndpointDependencies["execution"]["cancel"]>[0]) =>
            cancel(request.userId, request.presetId, request.executionId, request.reason),
          currentExecution: (userId, presetId) => currentExecution(userId, presetId),
        },
        sendToFrontend: (response, userId) => spindle.sendToFrontend(response, userId),
        onAuthorizedMutation: (userId, presetId) => { bumpEpoch(userId, presetId) },
      } as BackendEndpointDependencies)
      removePermissionWatcher = spindle.permissions.onChanged(onPermissionChanged)
      watchLifecycle("EXTENSION_DISABLED", "disable")
      watchLifecycle("EXTENSION_UPDATED", "update")
      watchLifecycle("EXTENSION_UPDATE", "update")
      watchLifecycle("EXTENSION_UNLOADED", "disposed")
      removeFrontendMessage = spindle.onFrontendMessage(async (payload, userId) => {
        if (disposed || !started || router === undefined) return
        const activeRouter = router
        if (activeRouter === undefined) return
        try {
          await activeRouter.dispatchAndSend({ userId }, payload)
        } catch {
          // The router owns normalized error responses and the shared sequence ledger.
        }
      })
      started = true
      if (hasRequiredPermissions()) {
        registry.ensureRegistered({ permissions: permissionView, handler: trackedInterceptorHandler })
      }
    })().catch(async (error) => {
      await disposeWithReason("disposed")
      throw error
    })
    return startPromise
  }

  const dispose = (): Promise<void> => disposeWithReason("disposed")

  const ready = Promise.resolve().then(start).catch((error) => {
    if (readyStartupCancelled && disposed) return
    throw error
  })
  const runtime: BackendRuntime = Object.freeze({ spindle, admission, traces, store, ready, start, dispose })
  runtimeGlobals()[ACTIVE_RUNTIME_KEY] = runtime
  return runtime
}
