import {
  GRAPH_DEADLINE_MS,
  MAX_CONFIG_BYTES,
  MAX_TRACE_BYTES,
  MAX_CONNECTION_SLOTS,
  MAX_PARALLEL_WIDTH,
  MAX_RUNS_PER_PIPELINE,
  MAX_STAGES_PER_PIPELINE,
  MAX_THREADS,
  TRACE_PREVIEW_BYTES,
} from "../config/limits"

export const PROTOCOL_VERSION = 1 as const
export type ProtocolVersion = typeof PROTOCOL_VERSION

export const MAX_PROTOCOL_MESSAGE_BYTES = MAX_CONFIG_BYTES
export const MAX_CONNECTIONS = 512 as const
export const MAX_BINDING_VIEWS = MAX_CONNECTION_SLOTS
export const MAX_CONSENT_VIEWS = MAX_THREADS * 2 * (MAX_CONNECTION_SLOTS + 1)
export const MAX_TRACE_EVENTS = 512 as const
export const MAX_TRACE_LIST_ITEMS = 100 as const
export const MAX_ERROR_DETAILS = 32 as const
export const MAX_CURSOR_BYTES = 512 as const
export const MAX_ACTIVITY_PREVIEW_BYTES = TRACE_PREVIEW_BYTES
export const MAX_SAFE_LABEL_BYTES = 320 as const
export const MAX_ACTIVITY_STAGE_COUNT = MAX_STAGES_PER_PIPELINE
export const MAX_ACTIVITY_RUN_COUNT = MAX_RUNS_PER_PIPELINE
export const MAX_ACTIVITY_PARALLEL_WIDTH = MAX_PARALLEL_WIDTH
export const MAX_ACTIVITY_BUDGET_MS = GRAPH_DEADLINE_MS
/** Per-component and cumulative activity usage bound; larger values are omitted. */
export const MAX_ACTIVITY_USAGE_TOKENS = 1_000_000_000 as const

export type ActivityRunStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "timed-out" | "skipped"
export type BackendActivityUsage = Readonly<{
  input?: number
  output?: number
  total?: number
}>

const ACTIVITY_RUN_STATUSES = ["pending", "running", "completed", "failed", "cancelled", "timed-out", "skipped"] as const

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SAFE_LABEL_PATTERN = /^[^\u0000-\u001f\u007f\r\n]+$/u
const SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_:-]{0,63}$/
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"])
const IDENTITY_KEYS = new Set([
  "userId",
  "user_id",
  "authoritativeCallbackUserId",
  "callbackUserId",
])
const CREDENTIAL_KEYS = new Set([
  "password",
  "secret",
  "secrets",
  "token",
  "tokens",
  "apiKey",
  "accessToken",
  "refreshToken",
  "credential",
  "credentials",
])

export type JsonPrimitive = null | boolean | number | string
export interface JsonObject {
  readonly [key: string]: JsonValue
}
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject

export type ApcMode = "single" | "sequential" | "parallel"
export type WorkspaceSource = "native-blocks" | "main-context"
export type ConnectionSourceKey = "main" | `slot:${string}`
export type MissingPolicy = "fail-graph" | "skip-run" | "omit-binding"
export type TraceStatus = "running" | "completed" | "failed" | "cancelled" | "timed-out"
export type ConsentStatus = "approved" | "revoked" | "required"

export type ActivityPhase = "started" | "progress" | "completed" | "failed" | "cancelled"
export type ActivityOutcome =
  | "integrity-fatal"
  | "parent-cancel"
  | "selected-final-failure"
  | "graph-fallback"
  | "optional-local"
  | "success"
export type ActivityErrorCategory =
  | "integrity"
  | "dispatch"
  | "consent"
  | "capacity"
  | "config"
  | "assembly"
  | "provider"
  | "tool"
  | "timeout"
  | "unknown"
export type ActivityCancellationSource =
  | "user"
  | "stop"
  | "replacement"
  | "permission-revoked"
  | "disable"
  | "update"
  | "disposed"
  | "timeout"

export type ConsentDisclosureCategory =
  | "thread"
  | "workspace"
  | "source"
  | "destination"
  | "provider"
  | "model"
  | "input-bindings"
  | "prior-stage-outputs"
  | "main-context"

export type SafeDestination = Readonly<{
  label: string
  provider: string
  model: string
}>

export type SafeConsentDisclosure = Readonly<{
  version: number
  summary: string
  categories: readonly ConsentDisclosureCategory[]
}>

export type SafeBindingView = Readonly<{
  slotId: string
  bound: boolean
  status?: "bound" | "stale" | "missing"
  descriptor?: SafeDestination
}>

export type SafeConsentView = Readonly<{
  threadId: string
  workspaceSource: WorkspaceSource
  connectionSourceKey: ConnectionSourceKey
  status: ConsentStatus
  destination?: SafeDestination
  disclosure?: SafeConsentDisclosure
}>

export type ConsentSelector = Readonly<{
  presetId: string
  threadId: string
  workspaceSource: WorkspaceSource
  connectionSourceKey: ConnectionSourceKey
}>

export type FrontendListConnectionsIntent = Readonly<{
  version: ProtocolVersion
  type: "list_connections"
  correlationId: string
  payload: Readonly<{}>
}>

export type FrontendHydratePresetIntent = Readonly<{
  version: ProtocolVersion
  type: "hydrate_preset"
  correlationId: string
  payload: Readonly<{ presetId: string }>
}>

export type FrontendBindSlotIntent = Readonly<{
  version: ProtocolVersion
  type: "bind_slot"
  correlationId: string
  payload: Readonly<{
    presetId: string
    slotId: string
    patch: Readonly<{ connectionId: string }>
  }>
}>

export type FrontendUnbindSlotIntent = Readonly<{
  version: ProtocolVersion
  type: "unbind_slot"
  correlationId: string
  payload: Readonly<{ presetId: string; slotId: string }>
}>

export type FrontendApproveConsentIntent = Readonly<{
  version: ProtocolVersion
  type: "approve_consent"
  correlationId: string
  payload: ConsentSelector
}>

export type FrontendRevokeConsentIntent = Readonly<{
  version: ProtocolVersion
  type: "revoke_consent"
  correlationId: string
  payload: ConsentSelector
}>

export type FrontendResolveConsentIntent = Readonly<{
  version: ProtocolVersion
  type: "resolve_consent"
  correlationId: string
  payload: ConsentSelector
}>

export type FrontendListTracesIntent = Readonly<{
  version: ProtocolVersion
  type: "list_traces"
  correlationId: string
  payload: Readonly<{
    presetId: string
    executionId?: string
    limit?: number
    cursor?: string
  }>
}>

export type FrontendGetTraceIntent = Readonly<{
  version: ProtocolVersion
  type: "get_trace"
  correlationId: string
  payload: Readonly<{
    presetId: string
    executionId: string
    traceId: string
  }>
}>


export type FrontendCancelExecutionIntent = Readonly<{
  version: ProtocolVersion
  type: "cancel_execution"
  correlationId: string
  payload: Readonly<{
    presetId: string
    executionId: string
    reason?: "user" | "stop" | "replacement"
  }>
}>

export type FrontendIntent =
  | FrontendListConnectionsIntent
  | FrontendHydratePresetIntent
  | FrontendBindSlotIntent
  | FrontendUnbindSlotIntent
  | FrontendApproveConsentIntent
  | FrontendRevokeConsentIntent
  | FrontendResolveConsentIntent
  | FrontendListTracesIntent
  | FrontendGetTraceIntent
  | FrontendCancelExecutionIntent

export type BackendErrorResponse = Readonly<{
  version: ProtocolVersion
  type: "error"
  correlationId: string
  sequence?: number
  payload: Readonly<{
    code: string
    messageKey: string
    retryable: boolean
    details?: readonly Readonly<{ path: string; reason: string }>[]
  }>
}>

export type ConnectionSummary = Readonly<{
  id: string
  name: string
  provider: string
  model: string
}>

export type BackendConnectionListResponse = Readonly<{
  version: ProtocolVersion
  type: "connections"
  correlationId: string
  sequence: number
  payload: Readonly<{
    connections: readonly ConnectionSummary[]
  }>
}>

export type BackendBindingResponse = Readonly<{
  version: ProtocolVersion
  type: "binding"
  correlationId: string
  sequence: number
  payload: Readonly<
    SafeBindingView & {
      presetId: string
    }
  >
}>

export type BackendConsentResponse = Readonly<{
  version: ProtocolVersion
  type: "consent"
  correlationId: string
  sequence: number
  payload: Readonly<
    SafeConsentView & {
      presetId: string
    }
  >
}>

export type BackendHydrationResponse = Readonly<{
  version: ProtocolVersion
  type: "hydration"
  correlationId: string
  sequence: number
  payload: Readonly<{
    presetId: string
    bindings: readonly SafeBindingView[]
    consents: readonly SafeConsentView[]
    execution?: BackendActivityPayload
  }>
}>
export type TraceEvent = Readonly<{
  kind: string
  sequence: number
  timestamp: number
  status?: string
  runId?: string
  stageId?: string
  preview?: string
}>

export type TraceSummary = Readonly<{
  traceId: string
  executionId: string
  presetId: string
  status: TraceStatus
  startedAt: number
  finishedAt?: number
  eventCount: number
  preview?: string
  truncated?: boolean
}>

export type TraceDetail = Readonly<
  TraceSummary & {
    events: readonly TraceEvent[]
  }
>

export type BackendTraceListResponse = Readonly<{
  version: ProtocolVersion
  type: "trace"
  correlationId: string
  sequence: number
  payload: Readonly<{
    traces: readonly TraceSummary[]
    nextCursor?: string
  }>
}>

export type BackendTraceDetailResponse = Readonly<{
  version: ProtocolVersion
  type: "trace"
  correlationId: string
  sequence: number
  payload: Readonly<{ trace: TraceDetail }>
}>

export type BackendTraceResponse = BackendTraceListResponse | BackendTraceDetailResponse

export type CancellationStatus = "accepted" | "already-terminal"

export type BackendCancellationResponse = Readonly<{
  version: ProtocolVersion
  type: "cancellation"
  correlationId: string
  sequence: number
  payload: Readonly<{
    executionId: string
    presetId: string
    accepted: boolean
    status: CancellationStatus
    cancellationSource: "user" | "stop" | "replacement"
  }>
}>

export type BackendActivityInput = Readonly<{
  correlationId: string
  sequence: number
  executionId: string
  presetId: string
  kind: string
  phase: ActivityPhase
  terminal: boolean
  traceId?: string
  provider?: string
  model?: string
  runStatus?: ActivityRunStatus
  usage?: BackendActivityUsage
  stageIndex?: number
  stageCount?: number
  runIndex?: number
  runCount?: number
  completedRuns?: number
  totalRuns?: number
  remainingBudgetMs?: number
  outcome?: ActivityOutcome
  errorCategory?: ActivityErrorCategory
  errorMessageKey?: string
  cancellationSource?: ActivityCancellationSource
}>

export type BackendActivityPayload = Readonly<Omit<BackendActivityInput, "correlationId" | "sequence"> & {
  terminal: boolean
}>

export type BackendActivityResponse = Readonly<{
  version: ProtocolVersion
  type: "activity"
  correlationId: string
  sequence: number
  payload: BackendActivityPayload
}>

export type BackendResponse =
  | BackendErrorResponse
  | BackendConnectionListResponse
  | BackendBindingResponse
  | BackendConsentResponse
  | BackendHydrationResponse
  | BackendCancellationResponse
  | BackendTraceResponse
  | BackendActivityResponse

export type BackendMessage = BackendResponse
export type FrontendMessage = FrontendIntent

function activityId(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new RangeError(`${field} must be a canonical UUID`)
  return value
}

function activityLabel(value: unknown, field: string, maxBytes: number = MAX_SAFE_LABEL_BYTES): string {
  if (typeof value !== "string" || value.length === 0 || !SAFE_LABEL_PATTERN.test(value)) {
    throw new RangeError(`${field} must be a safe label`)
  }
  if (new TextEncoder().encode(value).byteLength > maxBytes) throw new RangeError(`${field} exceeds its byte cap`)
  return value
}

function activityCount(value: unknown, field: string, maximum: number): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new RangeError(`${field} is outside its bound`)
  }
  return value as number
}

function activityUsage(value: unknown): BackendActivityUsage | undefined {
  if (value === undefined) return undefined
  if (!isObjectLike(value) || Array.isArray(value)) throw new RangeError("usage must be an object")
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (key !== "input" && key !== "output" && key !== "total") {
      throw new RangeError(`usage.${key} is not accepted`)
    }
  }
  const input = activityCount(record.input, "usage.input", MAX_ACTIVITY_USAGE_TOKENS)
  const output = activityCount(record.output, "usage.output", MAX_ACTIVITY_USAGE_TOKENS)
  const total = activityCount(record.total, "usage.total", MAX_ACTIVITY_USAGE_TOKENS)
  return Object.freeze({
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(total === undefined ? {} : { total }),
  })
}

function activityBudget(value: unknown): number | undefined {
  return activityCount(value, "remainingBudgetMs", MAX_ACTIVITY_BUDGET_MS)
}

function activityEnum<T extends string>(value: unknown, field: string, values: readonly T[]): T | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || !values.includes(value as T)) throw new RangeError(`${field} is invalid`)
  return value as T
}

export function createBackendActivityResponse(input: BackendActivityInput): BackendActivityResponse {
  const correlationId = activityId(input.correlationId, "correlationId")
  const sequence = activityCount(input.sequence, "sequence", Number.MAX_SAFE_INTEGER)
  if (sequence === undefined || sequence < 1) throw new RangeError("sequence must be a positive safe integer")
  const executionId = activityId(input.executionId, "executionId")
  const presetId = activityId(input.presetId, "presetId")
  const kind = activityLabel(input.kind, "kind", 128)
  const phase = activityEnum(input.phase, "phase", ["started", "progress", "completed", "failed", "cancelled"] as const)
  if (phase === undefined) throw new RangeError("phase is required")
  const terminalPhase = phase === "completed" || phase === "failed" || phase === "cancelled"
  if (input.terminal !== terminalPhase) throw new RangeError("activity terminal flag must match phase")
  const outcome = activityEnum(input.outcome, "outcome", [
    "integrity-fatal",
    "parent-cancel",
    "selected-final-failure",
    "graph-fallback",
    "optional-local",
    "success",
  ] as const)
  const errorCategory = activityEnum(input.errorCategory, "errorCategory", [
    "integrity",
    "dispatch",
    "consent",
    "capacity",
    "config",
    "assembly",
    "provider",
    "tool",
    "timeout",
    "unknown",
  ] as const)
  const cancellationSource = activityEnum(input.cancellationSource, "cancellationSource", [
    "user",
    "stop",
    "replacement",
    "permission-revoked",
    "disable",
    "update",
    "disposed",
    "timeout",
  ] as const)
  if (!input.terminal && outcome !== undefined) throw new RangeError("non-terminal activity cannot have an outcome")
  if (phase === "completed" && (outcome === undefined || !["optional-local", "graph-fallback", "success"].includes(outcome))) {
    throw new RangeError("completed activity outcome is invalid")
  }
  if (phase === "failed" && (outcome === undefined || !["integrity-fatal", "selected-final-failure"].includes(outcome))) {
    throw new RangeError("failed activity outcome is invalid")
  }
  if (phase === "cancelled" && outcome !== "parent-cancel") throw new RangeError("cancelled activity outcome is invalid")
  if (phase === "started" || phase === "progress") {
    if (errorCategory !== undefined || cancellationSource !== undefined) {
      throw new RangeError("non-terminal activity cannot carry error or cancellation state")
    }
  }
  if (phase === "failed" && errorCategory === undefined) throw new RangeError("failed activity requires an error category")
  if (phase !== "failed" && errorCategory !== undefined) throw new RangeError("error category is only valid for failed activity")
  if (phase === "cancelled" && cancellationSource === undefined) {
    throw new RangeError("cancelled activity requires a cancellation source")
  }
  if (phase !== "cancelled" && cancellationSource !== undefined) {
    throw new RangeError("cancellation source is only valid for cancelled activity")
  }
  const errorMessageKey = input.errorMessageKey === undefined
    ? undefined
    : activityLabel(input.errorMessageKey, "errorMessageKey", 128)
  if (errorMessageKey !== undefined && !SAFE_CODE_PATTERN.test(errorMessageKey)) {
    throw new RangeError("activity error message key is invalid")
  }
  if (phase !== "failed" && errorMessageKey !== undefined) {
    throw new RangeError("error message key is only valid for failed activity")
  }
  const traceId = input.traceId === undefined ? undefined : activityId(input.traceId, "traceId")
  const provider = input.provider === undefined ? undefined : activityLabel(input.provider, "provider")
  const model = input.model === undefined ? undefined : activityLabel(input.model, "model")
  const runStatus = activityEnum(input.runStatus, "runStatus", ACTIVITY_RUN_STATUSES)
  const usage = activityUsage(input.usage)
  const stageIndex = activityCount(input.stageIndex, "stageIndex", MAX_ACTIVITY_STAGE_COUNT - 1)
  const stageCount = activityCount(input.stageCount, "stageCount", MAX_ACTIVITY_STAGE_COUNT)
  const runIndex = activityCount(input.runIndex, "runIndex", MAX_ACTIVITY_RUN_COUNT - 1)
  const runCount = activityCount(input.runCount, "runCount", MAX_ACTIVITY_RUN_COUNT)
  const completedRuns = activityCount(input.completedRuns, "completedRuns", MAX_ACTIVITY_RUN_COUNT)
  const totalRuns = activityCount(input.totalRuns, "totalRuns", MAX_ACTIVITY_RUN_COUNT)
  const remainingBudgetMs = activityBudget(input.remainingBudgetMs)
  if (stageCount !== undefined && stageIndex !== undefined && stageIndex >= stageCount) {
    throw new RangeError("stageIndex must be less than stageCount")
  }
  if (runCount !== undefined && runIndex !== undefined && runIndex >= runCount) {
    throw new RangeError("runIndex must be less than runCount")
  }
  if (totalRuns !== undefined && completedRuns !== undefined && completedRuns > totalRuns) {
    throw new RangeError("completedRuns must not exceed totalRuns")
  }
  const payload: BackendActivityResponse["payload"] = Object.freeze({
    executionId,
    presetId,
    kind,
    phase,
    terminal: input.terminal,
    ...(traceId === undefined ? {} : { traceId }),
    ...(runStatus === undefined ? {} : { runStatus }),
    ...(usage === undefined ? {} : { usage }),
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(stageIndex === undefined ? {} : { stageIndex }),
    ...(stageCount === undefined ? {} : { stageCount }),
    ...(runIndex === undefined ? {} : { runIndex }),
    ...(runCount === undefined ? {} : { runCount }),
    ...(completedRuns === undefined ? {} : { completedRuns }),
    ...(totalRuns === undefined ? {} : { totalRuns }),
    ...(remainingBudgetMs === undefined ? {} : { remainingBudgetMs }),
    ...(outcome === undefined ? {} : { outcome }),
    ...(errorCategory === undefined ? {} : { errorCategory }),
    ...(errorMessageKey === undefined ? {} : { errorMessageKey }),
    ...(cancellationSource === undefined ? {} : { cancellationSource }),
  })
  return Object.freeze({
    version: PROTOCOL_VERSION,
    type: "activity",
    correlationId,
    sequence,
    payload,
  })
}
export const PROTOCOL_ERROR_CODE = "APC_PROTOCOL_DECODE_ERROR" as const

export class ProtocolDecodeError extends Error {
  readonly code = PROTOCOL_ERROR_CODE
  readonly path: string

  constructor(message: string, path = "$" ) {
    super(`${message} at ${path}`)
    this.name = "ProtocolDecodeError"
    this.path = path
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

function fail(message: string, path: string): never {
  throw new ProtocolDecodeError(message, path)
}

function isObjectLike(value: unknown): value is object {
  return typeof value === "object" && value !== null
}

function isArrayIndex(key: string): boolean {
  if (!/^\d+$/.test(key)) return false
  const number = Number(key)
  return Number.isSafeInteger(number) && number >= 0 && number < 4294967295 && String(number) === key
}

function cloneJson(value: unknown, path: string, active: WeakSet<object>): JsonValue {
  if (value === null) return null
  if (typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return fail("number must be finite", path)
    return value
  }
  if (!isObjectLike(value)) return fail("value is not JSON", path)

  if (active.has(value)) return fail("cyclic value is not JSON", path)
  active.add(value)

  try {
    const array = Array.isArray(value)
    let prototype: object | null
    try {
      prototype = Object.getPrototypeOf(value)
    } catch {
      return fail("prototype cannot be inspected", path)
    }
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      return fail("custom prototype is not JSON", path)
    }

    let keys: readonly (string | symbol)[]
    try {
      keys = Reflect.ownKeys(value)
    } catch {
      return fail("keys cannot be inspected", path)
    }

    if (array) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length")
      if (
        lengthDescriptor === undefined ||
        "get" in lengthDescriptor ||
        "set" in lengthDescriptor ||
        typeof lengthDescriptor.value !== "number" ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value > 4096
      ) {
        return fail("invalid array length", path)
      }
      const length = lengthDescriptor.value
      if (keys.length !== length + 1) return fail("array contains holes or extra properties", path)
      const output: JsonValue[] = []
      for (const key of keys) {
        if (typeof key !== "string") return fail("symbol keys are not JSON", path)
        if (key === "length") continue
        if (!isArrayIndex(key) || Number(key) >= length) return fail("invalid array key", `${path}.${key}`)
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (descriptor === undefined || "get" in descriptor || "set" in descriptor) {
          return fail("accessor is not JSON", `${path}.${key}`)
        }
        if (!descriptor.enumerable) return fail("non-enumerable property is not JSON", `${path}.${key}`)
        output[Number(key)] = cloneJson(descriptor.value, `${path}[${key}]`, active)
      }
      active.delete(value)
      return Object.freeze(output)
    }

    if (keys.length > 512) return fail("too many object keys", path)
    const output: Record<string, JsonValue> = {}
    for (const key of keys) {
      if (typeof key !== "string") return fail("symbol keys are not JSON", path)
      if (DANGEROUS_KEYS.has(key)) return fail(`dangerous key ${key}`, `${path}.${key}`)
      if (IDENTITY_KEYS.has(key)) return fail("identity fields are not allowed", `${path}.${key}`)
      if (CREDENTIAL_KEYS.has(key)) return fail("credential fields are not allowed", `${path}.${key}`)
      if (key === "toJSON") return fail("custom toJSON is not JSON", `${path}.${key}`)
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || "get" in descriptor || "set" in descriptor) {
        return fail("accessor is not JSON", `${path}.${key}`)
      }
      if (!descriptor.enumerable) return fail("non-enumerable property is not JSON", `${path}.${key}`)
      Object.defineProperty(output, key, {
        value: cloneJson(descriptor.value, `${path}.${key}`, active),
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
    active.delete(value)
    return Object.freeze(output)
  } catch (error) {
    active.delete(value)
    if (error instanceof ProtocolDecodeError) throw error
    return fail("value cannot be decoded as JSON", path)
  }
}

function decodeRoot(value: unknown): JsonObject {
  const decoded = cloneJson(value, "$", new WeakSet<object>())
  if (Array.isArray(decoded) || decoded === null || typeof decoded !== "object") {
    return fail("message must be an object", "$")
  }
  let bytes: number
  try {
    bytes = new TextEncoder().encode(JSON.stringify(decoded)).byteLength
  } catch {
    return fail("message cannot be serialized as JSON", "$")
  }
  if (bytes > MAX_PROTOCOL_MESSAGE_BYTES) return fail("message exceeds byte cap", "$")
  return decoded as JsonObject
}

function has(record: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

function exactKeys(record: JsonObject, expected: readonly string[], path: string): void {
  const allowed = new Set(expected)
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) return fail(`unknown field ${key}`, `${path}.${key}`)
  }
  for (const key of expected) {
    if (!has(record, key)) return fail(`missing field ${key}`, `${path}.${key}`)
  }
}

function optionalKeys(record: JsonObject, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed)
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) return fail(`unknown field ${key}`, `${path}.${key}`)
  }
}

function asRecord(value: JsonValue, path: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("expected an object", path)
  }
  return value as JsonObject
}

function stringValue(
  value: JsonValue,
  path: string,
  options: Readonly<{ maxBytes?: number; nonEmpty?: boolean; pattern?: RegExp; label?: boolean }> = {},
): string {
  if (typeof value !== "string") return fail("expected a string", path)
  if (options.nonEmpty !== false && value.length === 0) return fail("string must not be empty", path)
  if (options.pattern !== undefined && !options.pattern.test(value)) return fail("invalid string", path)
  if (options.label && !SAFE_LABEL_PATTERN.test(value)) return fail("label contains control characters", path)
  const bytes = new TextEncoder().encode(value).byteLength
  if (options.maxBytes !== undefined && bytes > options.maxBytes) return fail("string exceeds byte cap", path)
  return value
}

function jsonArray(value: JsonValue, path: string): readonly JsonValue[] {
  if (!Array.isArray(value)) return fail("expected an array", path)
  return value
}

function idValue(value: JsonValue, path: string, allowReserved = false): string {
  const text = stringValue(value, path, { maxBytes: 128 })
  if (allowReserved && (text === "main" || text === "final")) return text
  if (!UUID_PATTERN.test(text)) return fail("expected a canonical lowercase UUID", path)
  return text
}

function sequenceValue(value: JsonValue, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    return fail("sequence must be a positive safe integer", path)
  }
  return value
}
function nonNegativeSequenceValue(value: JsonValue, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return fail("sequence must be a non-negative safe integer", path)
  }
  return value
}

function timestampValue(value: JsonValue, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return fail("timestamp must be a non-negative finite number", path)
  }
  return value
}

function booleanValue(value: JsonValue, path: string): boolean {
  if (typeof value !== "boolean") return fail("expected a boolean", path)
  return value
}

function enumValue<T extends string>(value: JsonValue, path: string, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) return fail("invalid enum value", path)
  return value as T
}

function parseCorrelation(root: JsonObject): string {
  return idValue(root.correlationId, "$.correlationId")
}

function parseConsentSelector(payload: JsonObject, path: string): ConsentSelector {
  exactKeys(payload, ["presetId", "threadId", "workspaceSource", "connectionSourceKey"], path)
  const presetId = idValue(payload.presetId, `${path}.presetId`)
  const rawThreadId = stringValue(payload.threadId, `${path}.threadId`, { maxBytes: 128 })
  const threadId = rawThreadId === "main"
    ? rawThreadId
    : idValue(rawThreadId, `${path}.threadId`)
  const workspaceSource = enumValue<WorkspaceSource>(payload.workspaceSource, `${path}.workspaceSource`, [
    "native-blocks",
    "main-context",
  ])
  const source = stringValue(payload.connectionSourceKey, `${path}.connectionSourceKey`, {
    maxBytes: 128,
  })
  if (source !== "main" && !source.startsWith("slot:")) {
    return fail("invalid connection source", `${path}.connectionSourceKey`)
  }
  if (source.startsWith("slot:")) idValue(source.slice(5), `${path}.connectionSourceKey`)
  return Object.freeze({
    presetId,
    threadId,
    workspaceSource,
    connectionSourceKey: source as ConnectionSourceKey,
  })
}

export function decodeFrontendIntent(value: unknown): FrontendIntent {
  const root = decodeRoot(value)
  exactKeys(root, ["version", "type", "correlationId", "payload"], "$")
  if (root.version !== PROTOCOL_VERSION) return fail("unsupported protocol version", "$.version")
  const correlationId = parseCorrelation(root)
  const payload = asRecord(root.payload, "$.payload")
  const type = stringValue(root.type, "$.type", { maxBytes: 64 })

  switch (type) {
    case "list_connections": {
      exactKeys(payload, [], "$.payload")
      return Object.freeze({
        version: PROTOCOL_VERSION,
        type: "list_connections",
        correlationId,
        payload: Object.freeze({}),
      })
    }
    case "hydrate_preset": {
      exactKeys(payload, ["presetId"], "$.payload")
      return Object.freeze({
        version: PROTOCOL_VERSION,
        type: "hydrate_preset",
        correlationId,
        payload: Object.freeze({
          presetId: idValue(payload.presetId, "$.payload.presetId"),
        }),
      })
    }
    case "bind_slot": {
      exactKeys(payload, ["presetId", "slotId", "patch"], "$.payload")
      const patch = asRecord(payload.patch, "$.payload.patch")
      exactKeys(patch, ["connectionId"], "$.payload.patch")
      return Object.freeze({
        version: PROTOCOL_VERSION,
        type: "bind_slot",
        correlationId,
        payload: Object.freeze({
          presetId: idValue(payload.presetId, "$.payload.presetId"),
          slotId: idValue(payload.slotId, "$.payload.slotId"),
          patch: Object.freeze({ connectionId: idValue(patch.connectionId, "$.payload.patch.connectionId") }),
        }),
      })
    }
    case "unbind_slot": {
      exactKeys(payload, ["presetId", "slotId"], "$.payload")
      return Object.freeze({
        version: PROTOCOL_VERSION,
        type: "unbind_slot",
        correlationId,
        payload: Object.freeze({
          presetId: idValue(payload.presetId, "$.payload.presetId"),
          slotId: idValue(payload.slotId, "$.payload.slotId"),
        }),
      })
    }
    case "approve_consent":
    case "revoke_consent":
    case "resolve_consent": {
      const selector = parseConsentSelector(payload, "$.payload")
      return Object.freeze({
        version: PROTOCOL_VERSION,
        type,
        correlationId,
        payload: selector,
      }) as FrontendApproveConsentIntent | FrontendRevokeConsentIntent | FrontendResolveConsentIntent
    }
    case "list_traces": {
      optionalKeys(payload, ["presetId", "executionId", "limit", "cursor"], "$.payload")
      if (!has(payload, "presetId")) return fail("missing field presetId", "$.payload.presetId")
      const output: {
        presetId: string
        executionId?: string
        limit?: number
        cursor?: string
      } = {
        presetId: idValue(payload.presetId, "$.payload.presetId"),
      }
      if (has(payload, "executionId")) {
        output.executionId = idValue(payload.executionId, "$.payload.executionId")
      }
      if (has(payload, "limit")) {
        if (
          typeof payload.limit !== "number" ||
          !Number.isSafeInteger(payload.limit) ||
          payload.limit < 1 ||
          payload.limit > MAX_TRACE_LIST_ITEMS
        ) {
          return fail("invalid trace limit", "$.payload.limit")
        }
        output.limit = payload.limit
      }
      if (has(payload, "cursor")) {
        output.cursor = stringValue(payload.cursor, "$.payload.cursor", { maxBytes: MAX_CURSOR_BYTES })
      }
      return Object.freeze({ version: PROTOCOL_VERSION, type: "list_traces", correlationId, payload: Object.freeze(output) })
    }
    case "get_trace": {
      exactKeys(payload, ["presetId", "executionId", "traceId"], "$.payload")
      return Object.freeze({
        version: PROTOCOL_VERSION,
        type: "get_trace",
        correlationId,
        payload: Object.freeze({
          presetId: idValue(payload.presetId, "$.payload.presetId"),
          executionId: idValue(payload.executionId, "$.payload.executionId"),
          traceId: idValue(payload.traceId, "$.payload.traceId"),
        }),
      })
    }
    case "cancel_execution": {
      optionalKeys(payload, ["presetId", "executionId", "reason"], "$.payload")
      if (!has(payload, "presetId")) return fail("missing field presetId", "$.payload.presetId")
      if (!has(payload, "executionId")) return fail("missing field executionId", "$.payload.executionId")
      const output: { presetId: string; executionId: string; reason?: "user" | "stop" | "replacement" } = {
        presetId: idValue(payload.presetId, "$.payload.presetId"),
        executionId: idValue(payload.executionId, "$.payload.executionId"),
      }
      if (has(payload, "reason")) {
        output.reason = enumValue<"user" | "stop" | "replacement">(
          payload.reason,
          "$.payload.reason",
          ["user", "stop", "replacement"],
        )
      }
      return Object.freeze({
        version: PROTOCOL_VERSION,
        type: "cancel_execution",
        correlationId,
        payload: Object.freeze(output),
      })
    }
    default:
      return fail(`unknown frontend message type ${type}`, "$.type")
  }
}

function parseSequenceRoot(root: JsonObject, type: string): { correlationId: string; sequence: number; payload: JsonObject } {
  exactKeys(root, ["version", "type", "correlationId", "sequence", "payload"], "$")
  if (root.version !== PROTOCOL_VERSION) return fail("unsupported protocol version", "$.version")
  if (root.type !== type) return fail("message type mismatch", "$.type")
  return {
    correlationId: parseCorrelation(root),
    sequence: sequenceValue(root.sequence, "$.sequence"),
    payload: asRecord(root.payload, "$.payload"),
  }
}

function optionalSequence(root: JsonObject): number | undefined {
  optionalKeys(root, ["version", "type", "correlationId", "sequence", "payload"], "$")
  if (!has(root, "sequence")) return undefined
  return sequenceValue(root.sequence, "$.sequence")
}

function traceEvent(value: JsonValue, path: string): TraceEvent {
  const record = asRecord(value, path)
  optionalKeys(record, ["kind", "sequence", "timestamp", "status", "runId", "stageId", "preview"], path)
  if (!has(record, "kind") || !has(record, "sequence") || !has(record, "timestamp")) {
    return fail("trace event requires kind, sequence, and timestamp", path)
  }
  const output: {
    kind: string
    sequence: number
    timestamp: number
    status?: string
    runId?: string
    stageId?: string
    preview?: string
  } = {
    kind: stringValue(record.kind, `${path}.kind`, { maxBytes: 128 }),
    sequence: nonNegativeSequenceValue(record.sequence, `${path}.sequence`),
    timestamp: timestampValue(record.timestamp, `${path}.timestamp`),
  }
  if (has(record, "status")) output.status = stringValue(record.status, `${path}.status`, { maxBytes: 128 })
  if (has(record, "runId")) output.runId = idValue(record.runId, `${path}.runId`, true)
  if (has(record, "stageId")) output.stageId = idValue(record.stageId, `${path}.stageId`, true)
  if (has(record, "preview")) {
    output.preview = stringValue(record.preview, `${path}.preview`, { maxBytes: TRACE_PREVIEW_BYTES })
  }
  return Object.freeze(output)
}

function traceSummary(value: JsonValue, path: string, allowEvents = false): TraceSummary {
  const record = asRecord(value, path)
  const allowed = allowEvents
    ? ["traceId", "executionId", "presetId", "status", "startedAt", "finishedAt", "eventCount", "preview", "truncated", "events"]
    : ["traceId", "executionId", "presetId", "status", "startedAt", "finishedAt", "eventCount", "preview", "truncated"]
  optionalKeys(record, allowed, path)
  for (const key of ["traceId", "executionId", "presetId", "status", "startedAt", "eventCount"] as const) {
    if (!has(record, key)) return fail(`missing field ${key}`, `${path}.${key}`)
  }
  if (
    typeof record.eventCount !== "number" ||
    !Number.isSafeInteger(record.eventCount) ||
    record.eventCount < 0 ||
    record.eventCount > MAX_TRACE_EVENTS
  ) {
    return fail("invalid trace event count", `${path}.eventCount`)
  }
  const output: {
    traceId: string
    executionId: string
    presetId: string
    status: TraceStatus
    startedAt: number
    finishedAt?: number
    eventCount: number
    preview?: string
    truncated?: boolean
  } = {
    traceId: idValue(record.traceId, `${path}.traceId`),
    executionId: idValue(record.executionId, `${path}.executionId`),
    presetId: idValue(record.presetId, `${path}.presetId`),
    status: enumValue(record.status, `${path}.status`, ["running", "completed", "failed", "cancelled", "timed-out"]),
    startedAt: timestampValue(record.startedAt, `${path}.startedAt`),
    eventCount: record.eventCount,
  }
  if (has(record, "finishedAt")) output.finishedAt = timestampValue(record.finishedAt, `${path}.finishedAt`)
  if (has(record, "preview")) output.preview = stringValue(record.preview, `${path}.preview`, { maxBytes: TRACE_PREVIEW_BYTES })
  if (has(record, "truncated")) output.truncated = booleanValue(record.truncated, `${path}.truncated`)
  if (output.status === "running" && output.finishedAt !== undefined) return fail("running trace cannot have finishedAt", `${path}.finishedAt`)
  if (output.status !== "running" && output.finishedAt === undefined) return fail("terminal trace requires finishedAt", `${path}.finishedAt`)
  return Object.freeze(output)
}

function traceDetail(value: JsonValue, path: string): TraceDetail {
  const record = asRecord(value, path)
  const summary = traceSummary(record, path, true)
  const events = jsonArray(record.events, `${path}.events`)
  if (events.length > MAX_TRACE_EVENTS) return fail("too many trace events", `${path}.events`)
  if (events.length > summary.eventCount) return fail("trace event count is smaller than events", `${path}.eventCount`)
  if (events.length !== summary.eventCount && summary.truncated !== true) {
    return fail("trace event list is truncated without a marker", `${path}.truncated`)
  }
  return Object.freeze({
    ...summary,
    events: Object.freeze(events.map((event, index) => traceEvent(event, `${path}.events[${index}]`))),
  })
}

function validateTracePayloadSize(payload: JsonObject): void {
  let bytes: number
  try {
    bytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength
  } catch {
    return fail("trace payload cannot be serialized", "$.payload")
  }
  if (bytes > MAX_TRACE_BYTES) return fail("trace payload exceeds byte cap", "$.payload")
}

function safeDestination(value: JsonValue, path: string): SafeDestination {
  const record = asRecord(value, path)
  exactKeys(record, ["label", "provider", "model"], path)
  return Object.freeze({
    label: stringValue(record.label, `${path}.label`, { maxBytes: 320, label: true }),
    provider: stringValue(record.provider, `${path}.provider`, { maxBytes: 320, label: true }),
    model: stringValue(record.model, `${path}.model`, { maxBytes: 320, label: true }),
  })
}

function safeDisclosure(value: JsonValue, path: string, workspaceSource: WorkspaceSource): SafeConsentDisclosure {
  const record = asRecord(value, path)
  exactKeys(record, ["version", "summary", "categories"], path)
  if (
    typeof record.version !== "number" ||
    !Number.isSafeInteger(record.version) ||
    record.version < 1 ||
    record.version > 1_000_000
  ) {
    return fail("invalid disclosure version", `${path}.version`)
  }
  const categories = jsonArray(record.categories, `${path}.categories`)
  if (categories.length < 6 || categories.length > 9) return fail("invalid disclosure categories", `${path}.categories`)
  const seen = new Set<ConsentDisclosureCategory>()
  const parsedCategories: ConsentDisclosureCategory[] = []
  for (const [index, category] of categories.entries()) {
    const parsed = enumValue<ConsentDisclosureCategory>(
      category,
      `${path}.categories[${index}]`,
      ["thread", "workspace", "source", "destination", "provider", "model", "input-bindings", "prior-stage-outputs", "main-context"],
    )
    if (seen.has(parsed)) return fail("duplicate disclosure category", `${path}.categories[${index}]`)
    seen.add(parsed)
    parsedCategories.push(parsed)
  }
  const base: readonly ConsentDisclosureCategory[] = ["thread", "workspace", "source", "destination", "provider", "model"]
  const extras: readonly ConsentDisclosureCategory[] = workspaceSource === "native-blocks"
    ? ["input-bindings", "prior-stage-outputs"]
    : ["main-context", "input-bindings", "prior-stage-outputs"]
  const expected = [...base, ...extras]
  if (seen.size !== expected.length || expected.some(category => !seen.has(category))) {
    return fail("disclosure categories do not match workspace source", `${path}.categories`)
  }
  return Object.freeze({
    version: record.version,
    summary: stringValue(record.summary, `${path}.summary`, { maxBytes: 1_024, label: true }),
    categories: Object.freeze(parsedCategories),
  })
}

function safeBindingView(value: JsonValue, path: string): SafeBindingView {
  const record = asRecord(value, path)
  optionalKeys(record, ["slotId", "bound", "status", "descriptor"], path)
  if (!has(record, "slotId") || !has(record, "bound")) return fail("binding view requires slotId and bound", path)
  const bound = booleanValue(record.bound, `${path}.bound`)
  const status = has(record, "status")
    ? enumValue<"bound" | "stale" | "missing">(record.status, `${path}.status`, ["bound", "stale", "missing"])
    : undefined
  const output: { slotId: string; bound: boolean; status?: "bound" | "stale" | "missing"; descriptor?: SafeDestination } = {
    slotId: idValue(record.slotId, `${path}.slotId`),
    bound,
    ...(status === undefined ? {} : { status }),
  }
  if (has(record, "descriptor")) output.descriptor = safeDestination(record.descriptor, `${path}.descriptor`)
  if (status === "stale") {
    if (!bound || output.descriptor !== undefined) return fail("stale binding must be bound without a descriptor", path)
    return Object.freeze(output)
  }
  if (status === "missing") {
    if (bound || output.descriptor !== undefined) return fail("missing binding must be unbound without a descriptor", path)
    return Object.freeze(output)
  }
  if (!bound) {
    if (output.descriptor !== undefined) return fail("unbound binding cannot expose a descriptor", path)
    if (status !== undefined) return fail("unbound binding status is invalid", path)
    return Object.freeze(output)
  }
  if (output.descriptor === undefined) return fail("bound binding requires a descriptor", path)
  return Object.freeze(output)
}

function safeConsentView(value: JsonValue, path: string): SafeConsentView {
  const record = asRecord(value, path)
  optionalKeys(record, ["threadId", "workspaceSource", "connectionSourceKey", "status", "destination", "disclosure"], path)
  for (const key of ["threadId", "workspaceSource", "connectionSourceKey", "status"] as const) {
    if (!has(record, key)) return fail(`missing field ${key}`, `${path}.${key}`)
  }
  const rawThreadId = stringValue(record.threadId, `${path}.threadId`, { maxBytes: 128 })
  const sourceValue = stringValue(record.connectionSourceKey, `${path}.connectionSourceKey`, { maxBytes: 128 })
  if (sourceValue !== "main" && !sourceValue.startsWith("slot:")) {
    return fail("invalid connection source", `${path}.connectionSourceKey`)
  }
  if (sourceValue.startsWith("slot:")) idValue(sourceValue.slice(5), `${path}.connectionSourceKey`)
  const workspaceSource = enumValue<WorkspaceSource>(record.workspaceSource, `${path}.workspaceSource`, ["native-blocks", "main-context"])
  const status = enumValue<ConsentStatus>(record.status, `${path}.status`, ["approved", "revoked", "required"])
  const output: {
    threadId: string
    workspaceSource: WorkspaceSource
    connectionSourceKey: ConnectionSourceKey
    status: ConsentStatus
    destination?: SafeDestination
    disclosure?: SafeConsentDisclosure
  } = {
    threadId: rawThreadId === "main" ? rawThreadId : idValue(record.threadId, `${path}.threadId`),
    workspaceSource,
    connectionSourceKey: sourceValue as ConnectionSourceKey,
    status,
  }
  if (has(record, "destination")) output.destination = safeDestination(record.destination, `${path}.destination`)
  if (has(record, "disclosure")) output.disclosure = safeDisclosure(record.disclosure, `${path}.disclosure`, workspaceSource)
  const hasDestination = output.destination !== undefined
  const hasDisclosure = output.disclosure !== undefined
  if (hasDestination !== hasDisclosure) return fail("consent destination and disclosure must be provided together", path)
  if (status === "approved" && (!hasDestination || !hasDisclosure)) {
    return fail("approved consent requires destination and disclosure", path)
  }

  return Object.freeze(output)
}

function nonNegativeCount(value: JsonValue, path: string, maximum = MAX_ACTIVITY_RUN_COUNT): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    return fail("invalid activity count", path)
  }
  return value
}
function parseActivityUsage(value: JsonValue, path: string): BackendActivityUsage {
  const record = asRecord(value, path)
  optionalKeys(record, ["input", "output", "total"], path)
  const input = has(record, "input") ? nonNegativeCount(record.input, `${path}.input`, MAX_ACTIVITY_USAGE_TOKENS) : undefined
  const output = has(record, "output") ? nonNegativeCount(record.output, `${path}.output`, MAX_ACTIVITY_USAGE_TOKENS) : undefined
  const total = has(record, "total") ? nonNegativeCount(record.total, `${path}.total`, MAX_ACTIVITY_USAGE_TOKENS) : undefined
  return Object.freeze({
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(total === undefined ? {} : { total }),
  })
}

function optionalActivityCount(record: JsonObject, key: string, path: string): number | undefined {
  if (!has(record, key)) return undefined
  const maximum = key === "stageIndex"
    ? MAX_ACTIVITY_STAGE_COUNT - 1
    : key === "stageCount"
      ? MAX_ACTIVITY_STAGE_COUNT
      : key === "runIndex"
        ? MAX_ACTIVITY_RUN_COUNT - 1
        : MAX_ACTIVITY_RUN_COUNT
  return nonNegativeCount(record[key], `${path}.${key}`, maximum)
}

function parseActivityPayload(payload: JsonObject, path: string): BackendActivityResponse["payload"] {
  optionalKeys(payload, [
    "executionId",
    "presetId",
    "kind",
    "phase",
    "terminal",
    "traceId",
    "provider",
    "model",
    "runStatus",
    "usage",
    "stageIndex",
    "stageCount",
    "runIndex",
    "runCount",
    "completedRuns",
    "totalRuns",
    "remainingBudgetMs",
    "outcome",
    "errorCategory",
    "errorMessageKey",
    "cancellationSource",
  ], path)
  for (const key of ["executionId", "presetId", "kind", "phase", "terminal"] as const) {
    if (!has(payload, key)) return fail(`missing field ${key}`, `${path}.${key}`)
  }
  const phase = enumValue<ActivityPhase>(payload.phase, `${path}.phase`, ["started", "progress", "completed", "failed", "cancelled"])
  const terminal = booleanValue(payload.terminal, `${path}.terminal`)
  const terminalPhase = phase === "completed" || phase === "failed" || phase === "cancelled"
  if (terminal !== terminalPhase) return fail("activity terminal flag must match phase", `${path}.terminal`)
  const output: {
    executionId: string
    presetId: string
    kind: string
    phase: ActivityPhase
    terminal: boolean
    traceId?: string
    runStatus?: ActivityRunStatus
    usage?: BackendActivityUsage
    provider?: string
    model?: string
    stageIndex?: number
    totalRuns?: number
    stageCount?: number
    runIndex?: number
    runCount?: number
    completedRuns?: number
    remainingBudgetMs?: number
    outcome?: ActivityOutcome
    errorCategory?: ActivityErrorCategory
    errorMessageKey?: string
    cancellationSource?: ActivityCancellationSource
  } = {
    executionId: idValue(payload.executionId, `${path}.executionId`),
    presetId: idValue(payload.presetId, `${path}.presetId`),
    kind: stringValue(payload.kind, `${path}.kind`, { maxBytes: 128, label: true }),
    phase,
    terminal,
  }
  if (has(payload, "runStatus")) output.runStatus = enumValue<ActivityRunStatus>(payload.runStatus, `${path}.runStatus`, ACTIVITY_RUN_STATUSES)
  if (has(payload, "usage")) output.usage = parseActivityUsage(payload.usage, `${path}.usage`)
  if (has(payload, "traceId")) output.traceId = idValue(payload.traceId, `${path}.traceId`)
  if (has(payload, "provider")) output.provider = stringValue(payload.provider, `${path}.provider`, { maxBytes: 320, label: true })
  if (has(payload, "model")) output.model = stringValue(payload.model, `${path}.model`, { maxBytes: 320, label: true })
  for (const key of ["stageIndex", "stageCount", "runIndex", "runCount", "completedRuns", "totalRuns"] as const) {
    const value = optionalActivityCount(payload, key, path)
    if (value !== undefined) output[key] = value
  }
  if (has(payload, "remainingBudgetMs")) output.remainingBudgetMs = nonNegativeCount(payload.remainingBudgetMs, `${path}.remainingBudgetMs`, MAX_ACTIVITY_BUDGET_MS)
  if (has(payload, "outcome")) {
    output.outcome = enumValue<ActivityOutcome>(
      payload.outcome,
      `${path}.outcome`,
      ["integrity-fatal", "parent-cancel", "selected-final-failure", "graph-fallback", "optional-local", "success"],
    )
  }
  if (terminal && output.outcome === undefined) return fail("terminal activity requires an outcome", `${path}.outcome`)
  if (!terminal && output.outcome !== undefined) return fail("non-terminal activity cannot have an outcome", `${path}.outcome`)
  if (has(payload, "errorCategory")) {
    output.errorCategory = enumValue<ActivityErrorCategory>(
      payload.errorCategory,
      `${path}.errorCategory`,
      ["integrity", "dispatch", "consent", "capacity", "config", "assembly", "provider", "tool", "timeout", "unknown"],
    )
  }
  if (has(payload, "errorMessageKey")) {
    output.errorMessageKey = stringValue(payload.errorMessageKey, `${path}.errorMessageKey`, {
      maxBytes: 128,
      pattern: SAFE_CODE_PATTERN,
    })
  }
  if (phase === "failed" && output.errorCategory === undefined) return fail("failed activity requires an error category", `${path}.errorCategory`)
  if (phase !== "failed" && output.errorCategory !== undefined) return fail("error category is only valid for failed activity", `${path}.errorCategory`)
  if (phase !== "failed" && output.errorMessageKey !== undefined) return fail("error message key is only valid for failed activity", `${path}.errorMessageKey`)
  if (has(payload, "cancellationSource")) {
    output.cancellationSource = enumValue<ActivityCancellationSource>(
      payload.cancellationSource,
      `${path}.cancellationSource`,
      ["user", "stop", "replacement", "permission-revoked", "disable", "update", "disposed", "timeout"],
    )
  }
  if (phase === "cancelled" && output.cancellationSource === undefined) {
    return fail("cancelled activity requires a cancellation source", `${path}.cancellationSource`)
  }
  if (phase !== "cancelled" && output.cancellationSource !== undefined) {
    return fail("cancellation source is only valid for cancelled activity", `${path}.cancellationSource`)
  }
  if (phase === "completed" && (output.outcome === undefined || !["optional-local", "graph-fallback", "success"].includes(output.outcome))) {
    return fail("completed activity outcome is invalid", `${path}.outcome`)
  }
  if (phase === "failed" && (output.outcome === undefined || !["integrity-fatal", "selected-final-failure"].includes(output.outcome))) {
    return fail("failed activity outcome is invalid", `${path}.outcome`)
  }
  if (phase === "cancelled" && output.outcome !== "parent-cancel") return fail("cancelled activity outcome is invalid", `${path}.outcome`)
  if ((phase === "started" || phase === "progress") && (output.errorCategory !== undefined || output.cancellationSource !== undefined)) {
    return fail("non-terminal activity cannot carry error or cancellation state", path)
  }
  if (output.stageCount !== undefined && output.stageIndex !== undefined && output.stageIndex >= output.stageCount) {
    return fail("stageIndex must be less than stageCount", `${path}.stageIndex`)
  }
  if (output.runCount !== undefined && output.runIndex !== undefined && output.runIndex >= output.runCount) {
    return fail("runIndex must be less than runCount", `${path}.runIndex`)
  }
  if (output.totalRuns !== undefined && output.completedRuns !== undefined && output.completedRuns > output.totalRuns) {
    return fail("completedRuns must not exceed totalRuns", `${path}.completedRuns`)
  }
  return Object.freeze(output)
}

export function decodeBackendResponse(value: unknown): BackendResponse {
  const root = decodeRoot(value)
  if (root.version !== PROTOCOL_VERSION) return fail("unsupported protocol version", "$.version")
  const type = stringValue(root.type, "$.type", { maxBytes: 64 })
  if (type === "error") {
    optionalKeys(root, ["version", "type", "correlationId", "sequence", "payload"], "$")
    const sequence = optionalSequence(root)
    const payload = asRecord(root.payload, "$.payload")
    optionalKeys(payload, ["code", "messageKey", "retryable", "details"], "$.payload")
    if (!has(payload, "code") || !has(payload, "messageKey") || !has(payload, "retryable")) {
      return fail("error requires code, messageKey, and retryable", "$.payload")
    }
    const code = stringValue(payload.code, "$.payload.code", { maxBytes: 128, pattern: SAFE_CODE_PATTERN })
    const messageKey = stringValue(payload.messageKey, "$.payload.messageKey", { maxBytes: 128, pattern: SAFE_CODE_PATTERN })
    const output: {
      code: string
      messageKey: string
      retryable: boolean
      details?: readonly Readonly<{ path: string; reason: string }>[]
    } = { code, messageKey, retryable: booleanValue(payload.retryable, "$.payload.retryable") }
    if (has(payload, "details")) {
      const details = jsonArray(payload.details, "$.payload.details")
      if (details.length > MAX_ERROR_DETAILS) return fail("invalid error details", "$.payload.details")
      output.details = Object.freeze(
        details.map((detail, index) => {
          const item = asRecord(detail, `$.payload.details[${index}]`)
          exactKeys(item, ["path", "reason"], `$.payload.details[${index}]`)
          return Object.freeze({
            path: stringValue(item.path, `$.payload.details[${index}].path`, { maxBytes: 512 }),
            reason: stringValue(item.reason, `$.payload.details[${index}].reason`, { maxBytes: 1024 }),
          })
        }),
      )
    }
    return Object.freeze({
      version: PROTOCOL_VERSION,
      type: "error",
      correlationId: parseCorrelation(root),
      ...(sequence === undefined ? {} : { sequence }),
      payload: Object.freeze(output),
    })
  }
  if (type === "connections") {
    const parsed = parseSequenceRoot(root, type)
    exactKeys(parsed.payload, ["connections"], "$.payload")
    const connections = jsonArray(parsed.payload.connections, "$.payload.connections")
    if (connections.length > MAX_CONNECTIONS) return fail("too many connections", "$.payload.connections")
    return Object.freeze({
      version: PROTOCOL_VERSION,
      type: "connections",
      correlationId: parsed.correlationId,
      sequence: parsed.sequence,
      payload: Object.freeze({
        connections: Object.freeze(
          connections.map((connection, index) => {
            const item = asRecord(connection, `$.payload.connections[${index}]`)
            exactKeys(item, ["id", "name", "provider", "model"], `$.payload.connections[${index}]`)
            return Object.freeze({
              id: idValue(item.id, `$.payload.connections[${index}].id`),
              name: stringValue(item.name, `$.payload.connections[${index}].name`, { maxBytes: 320, label: true }),
              provider: stringValue(item.provider, `$.payload.connections[${index}].provider`, { maxBytes: 320, label: true }),
              model: stringValue(item.model, `$.payload.connections[${index}].model`, { maxBytes: 320, label: true }),
            })
          }),
        ),
      }),
    })
  }
  if (type === "binding") {
    const parsed = parseSequenceRoot(root, type)
    const payload = parsed.payload
    optionalKeys(payload, ["presetId", "slotId", "bound", "status", "descriptor"], "$.payload")
    if (!has(payload, "presetId") || !has(payload, "slotId") || !has(payload, "bound")) {
      return fail("binding requires presetId, slotId, and bound", "$.payload")
    }
    const view = safeBindingView({
      slotId: payload.slotId,
      bound: payload.bound,
      ...(has(payload, "status") ? { status: payload.status } : {}),
      ...(has(payload, "descriptor") ? { descriptor: payload.descriptor } : {}),
    }, "$.payload")
    return Object.freeze({
      version: PROTOCOL_VERSION,
      type: "binding",
      correlationId: parsed.correlationId,
      sequence: parsed.sequence,
      payload: Object.freeze({
        presetId: idValue(payload.presetId, "$.payload.presetId"),
        ...view,
      }),
    })
  }
  if (type === "consent") {
    const parsed = parseSequenceRoot(root, type)
    const payload = parsed.payload
    optionalKeys(payload, [
      "presetId",
      "threadId",
      "workspaceSource",
      "connectionSourceKey",
      "status",
      "destination",
      "disclosure",
    ], "$.payload")
    if (!has(payload, "presetId")) return fail("consent requires presetId", "$.payload.presetId")
    const view = safeConsentView({
      threadId: payload.threadId,
      workspaceSource: payload.workspaceSource,
      connectionSourceKey: payload.connectionSourceKey,
      status: payload.status,
      ...(has(payload, "destination") ? { destination: payload.destination } : {}),
      ...(has(payload, "disclosure") ? { disclosure: payload.disclosure } : {}),
    }, "$.payload")
    return Object.freeze({
      version: PROTOCOL_VERSION,
      type: "consent",
      correlationId: parsed.correlationId,
      sequence: parsed.sequence,
      payload: Object.freeze({
        presetId: idValue(payload.presetId, "$.payload.presetId"),
        ...view,
      }),
    })
  }
  if (type === "hydration") {
    const parsed = parseSequenceRoot(root, type)
    const payload = parsed.payload
    optionalKeys(payload, ["presetId", "bindings", "consents", "execution"], "$.payload")
    for (const key of ["presetId", "bindings", "consents"] as const) {
      if (!has(payload, key)) return fail(`missing field ${key}`, `$.payload.${key}`)
    }
    const presetId = idValue(payload.presetId, "$.payload.presetId")
    const bindings = jsonArray(payload.bindings, "$.payload.bindings")
    const consents = jsonArray(payload.consents, "$.payload.consents")
    if (bindings.length > MAX_BINDING_VIEWS) return fail("too many binding views", "$.payload.bindings")
    if (consents.length > MAX_CONSENT_VIEWS) return fail("too many consent views", "$.payload.consents")
    const execution = has(payload, "execution")
      ? parseActivityPayload(asRecord(payload.execution, "$.payload.execution"), "$.payload.execution")
      : undefined
    if (execution !== undefined && execution.presetId !== presetId) {
      return fail("hydrated execution preset does not match hydration preset", "$.payload.execution.presetId")
    }
    if (execution !== undefined && execution.terminal) {
      return fail("hydrated execution must be non-terminal", "$.payload.execution.terminal")
    }
    return Object.freeze({
      version: PROTOCOL_VERSION,
      type: "hydration",
      correlationId: parsed.correlationId,
      sequence: parsed.sequence,
      payload: Object.freeze({
        presetId,
        bindings: Object.freeze(bindings.map((binding, index) => safeBindingView(binding, `$.payload.bindings[${index}]`))),
        consents: Object.freeze(consents.map((consent, index) => safeConsentView(consent, `$.payload.consents[${index}]`))),
        ...(execution === undefined ? {} : { execution }),
      }),
    })
  }
  if (type === "cancellation") {
    const parsed = parseSequenceRoot(root, type)
    const payload = parsed.payload
    exactKeys(payload, ["executionId", "presetId", "accepted", "status", "cancellationSource"], "$.payload")
    const accepted = booleanValue(payload.accepted, "$.payload.accepted")
    const status = enumValue<CancellationStatus>(payload.status, "$.payload.status", ["accepted", "already-terminal"])
    if (accepted !== (status === "accepted")) return fail("cancellation accepted/status mismatch", "$.payload")
    return Object.freeze({
      version: PROTOCOL_VERSION,
      type: "cancellation",
      correlationId: parsed.correlationId,
      sequence: parsed.sequence,
      payload: Object.freeze({
        executionId: idValue(payload.executionId, "$.payload.executionId"),
        presetId: idValue(payload.presetId, "$.payload.presetId"),
        accepted: booleanValue(payload.accepted, "$.payload.accepted"),
        status: enumValue<CancellationStatus>(payload.status, "$.payload.status", ["accepted", "already-terminal"]),
        cancellationSource: enumValue<"user" | "stop" | "replacement">(
          payload.cancellationSource,
          "$.payload.cancellationSource",
          ["user", "stop", "replacement"],
        ),
      }),
    })
  }
  if (type === "trace") {
    const parsed = parseSequenceRoot(root, type)
    const payload = parsed.payload
    const hasTraces = has(payload, "traces")
    const hasTrace = has(payload, "trace")
    if (hasTraces === hasTrace) return fail("trace response must contain traces or trace", "$.payload")
    if (hasTraces) {
      optionalKeys(payload, ["traces", "nextCursor"], "$.payload")
      const traces = jsonArray(payload.traces, "$.payload.traces")
      if (traces.length > MAX_TRACE_LIST_ITEMS) return fail("invalid trace list", "$.payload.traces")
      const output: { traces: readonly TraceSummary[]; nextCursor?: string } = {
        traces: Object.freeze(traces.map((trace, index) => traceSummary(trace, `$.payload.traces[${index}]`))),
      }
      if (has(payload, "nextCursor")) output.nextCursor = stringValue(payload.nextCursor, "$.payload.nextCursor", { maxBytes: MAX_CURSOR_BYTES })
      validateTracePayloadSize(payload)
      return Object.freeze({ version: PROTOCOL_VERSION, type: "trace", correlationId: parsed.correlationId, sequence: parsed.sequence, payload: Object.freeze(output) })
    }
    exactKeys(payload, ["trace"], "$.payload")
    const trace = traceDetail(payload.trace, "$.payload.trace")
    validateTracePayloadSize(payload)
    return Object.freeze({ version: PROTOCOL_VERSION, type: "trace", correlationId: parsed.correlationId, sequence: parsed.sequence, payload: Object.freeze({ trace }) })
  }
  if (type === "activity") {
    const parsed = parseSequenceRoot(root, type)
    const payload = parseActivityPayload(parsed.payload, "$.payload")
    return Object.freeze({
      version: PROTOCOL_VERSION,
      type: "activity",
      correlationId: parsed.correlationId,
      sequence: parsed.sequence,
      payload,
    })
  }
  return fail(`unknown backend message type ${type}`, "$.type")
}

export const decodeFrontendMessage = decodeFrontendIntent
export const decodeBackendMessage = decodeBackendResponse

export function assertMonotonicSequence(previous: number, next: number): number {
  if (!Number.isSafeInteger(previous) || previous < 0) throw new RangeError("previous sequence must be a non-negative safe integer")
  if (!Number.isSafeInteger(next) || next <= previous) throw new RangeError("sequence must increase monotonically")
  return next
}

export class MonotonicSequenceLedger {
  private current = 0

  get lastSequence(): number {
    return this.current
  }

  accept(sequence: number): boolean {
    if (!Number.isSafeInteger(sequence) || sequence <= this.current) return false
    this.current = sequence
    return true
  }

  reset(): void {
    this.current = 0
  }
}

export const SequenceLedger = MonotonicSequenceLedger
