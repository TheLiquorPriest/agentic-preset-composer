import type {
  BoundAssembleRequestDTO,
  BoundAssemblyOutcomeDTO,
  BoundPrefillAttachmentDTO,
  ConnectionDispatchDescriptorDTO,
  GenerationDispatchSourceDTO,
  GenerationResponseDTO,
  InterceptorContextDTO,
  LlmMessageDTO,
  PromptBlockDTO,
  PromptVariableValuesDTO,
  QuietDispatchReceiptDTO,
  QuietTrackedRequestDTO,
  QuietTrackedResultDTO,
} from "lumiverse-spindle-types"
import type { ApcWorkspaceSource } from "../config/schema"
import {
  MAX_BINDINGS_PER_RUN,
  MAX_BLOCK_CONTENT_BYTES,
  MAX_BLOCKS_PER_THREAD,
  MAX_PROVIDER_RAW_BYTES,
  MAX_THREAD_OUTPUT_BYTES,
  MAX_TOOL_SIGNATURE_BYTES,
  MAX_WORKSPACE_BYTES,
  utf8Bytes,
} from "../config/limits"
import { validateRunTimeout } from "../runtime/deadline"
import {
  createExecutionCancellation,
  createRunCancellation,
  type CancellationClock,
  type CancellationReason,
  type ExecutionCancellation,
  type RunCancellation,
} from "./cancellation"

/**
 * The only run data APC may supply to an auxiliary dispatch. Provider routing,
 * credentials, endpoints, and provider parameters are deliberately absent.
 */
export interface AuxiliaryRunBinding {
  readonly id: string
  readonly timeoutMs: number
}

/** Copy-on-write native-block workspace input for one auxiliary run. */
export interface AuxiliaryWorkspaceBinding {
  readonly source: ApcWorkspaceSource
  readonly blocks?: readonly PromptBlockDTO[]
  readonly promptVariableValues?: PromptVariableValuesDTO
}

/** A descriptor resolved by the host's authenticated connection binding. */
export type AuxiliaryHostDescriptor = Readonly<ConnectionDispatchDescriptorDTO>

/**
 * Immutable interceptor input and host snapshots needed for one auxiliary run.
 * `resolvedHostDescriptor` is host-authored; APC never accepts a descriptor or
 * route override nested in the portable graph payload.
 */
export interface AuxiliaryExecutionInput {
  readonly context: InterceptorContextDTO
  readonly resolvedHostDescriptor: AuxiliaryHostDescriptor
  readonly run: AuxiliaryRunBinding
  readonly workspace: AuxiliaryWorkspaceBinding
  /** Immutable assembled Main messages for a `main-context` workspace. */
  readonly mainMessages?: readonly LlmMessageDTO[]
  readonly inputBindings: readonly LlmMessageDTO[]
  readonly parentSignal: AbortSignal
  readonly deadlineAt: number
  readonly expectedDispatchRevision: string
  readonly dispatchSource: "main" | "slot"
}

export type AuxiliaryTimerHandle = unknown
/** Narrow host-call surface; tests inject only these authenticated calls. */
export interface AuxiliaryExecutionDeps {
  /** Exact Gate G `spindle.generate.assemble` call. */
  readonly assemble: (input: BoundAssembleRequestDTO) => Promise<BoundAssemblyOutcomeDTO>
  /** Exact Gate G `spindle.generate.quietTracked` call. */
  readonly quietTracked: (input: QuietTrackedRequestDTO) => Promise<QuietTrackedResultDTO>
  /** APC-local mutation epoch/permission/revocation predicate. */
  readonly isExecutionCurrent: () => boolean
  /** Injectable clock for deterministic deadline tests. */
  readonly now?: () => number
  readonly setTimeout?: (handler: () => void, timeoutMs: number) => AuxiliaryTimerHandle
  readonly clearTimeout?: (timer: AuxiliaryTimerHandle) => void
}

export interface AuxiliaryRunProvenance {
  readonly userId: string
  readonly chatId: string
  readonly generationId: string
  readonly presetId: string | null
  readonly runId: string
  readonly source: "main" | "slot"
  readonly connectionId: string
  readonly connectionDispatchRevision: string
}


export interface AuxiliaryRunSuccess {
  readonly kind: "success"
  readonly messages: readonly LlmMessageDTO[]
  readonly content: string
  readonly reasoning?: string
  readonly response: GenerationResponseDTO
  readonly receipt: QuietDispatchReceiptDTO
  readonly provenance: AuxiliaryRunProvenance
}

export interface AuxiliaryRunFailed {
  readonly kind: "failed"
  readonly code: string
  readonly phase: "input" | "assembly" | "dispatch" | "revision" | "provider"
  readonly message: string
  readonly receipt?: QuietDispatchReceiptDTO
  readonly provenance?: AuxiliaryRunProvenance
}

export interface AuxiliaryRunCancelled {
  readonly kind: "cancelled"
  readonly code: "CANCELLED"
  readonly message: string
  readonly receipt?: QuietDispatchReceiptDTO
  readonly provenance?: AuxiliaryRunProvenance
}

export interface AuxiliaryRunTimedOut {
  readonly kind: "timed-out"
  readonly code: "DEADLINE_EXCEEDED"
  readonly message: string
  readonly deadlineAt: number
  readonly receipt?: QuietDispatchReceiptDTO
  readonly provenance?: AuxiliaryRunProvenance
}

export type AuxiliaryRunResult =
  | AuxiliaryRunSuccess
  | AuxiliaryRunFailed
  | AuxiliaryRunCancelled
  | AuxiliaryRunTimedOut
const FORBIDDEN_PAYLOAD_KEYS: Readonly<Record<string, true>> = Object.freeze({
  apiKey: true,
  api_key: true,
  secret: true,
  secretKey: true,
  secret_key: true,
  privateKey: true,
  private_key: true,
  ["private-key"]: true,
  token: true,
  accessToken: true,
  access_token: true,
  authorization: true,
  endpoint: true,
  endpointOrigin: true,
  provider: true,
  model: true,
  connectionId: true,
  connection_id: true,
  credentials: true,
  headers: true,
})

const FORBIDDEN_OUTPUT_KEYS: Readonly<Record<string, true>> = Object.freeze({
  apiKey: true,
  api_key: true,
  secret: true,
  secretKey: true,
  privateKey: true,
  private_key: true,
  ["private-key"]: true,
  secret_key: true,
  token: true,
  accessToken: true,
  access_token: true,
  authorization: true,
  endpoint: true,
  endpointOrigin: true,
  credentials: true,
  headers: true,
})

const INPUT_KEYS: Readonly<Record<string, true>> = Object.freeze({
  context: true,
  resolvedHostDescriptor: true,
  run: true,
  workspace: true,
  mainMessages: true,
  inputBindings: true,
  parentSignal: true,
  deadlineAt: true,
  expectedDispatchRevision: true,
  dispatchSource: true,
})

const RUN_KEYS: Readonly<Record<string, true>> = Object.freeze({ id: true, timeoutMs: true })
const WORKSPACE_KEYS: Readonly<Record<string, true>> = Object.freeze({
  source: true,
  blocks: true,
  promptVariableValues: true,
})
const DESCRIPTOR_KEYS: Readonly<Record<string, true>> = Object.freeze({
  connectionId: true,
  connectionName: true,
  provider: true,
  model: true,
  endpointOrigin: true,
  dispatchKind: true,
  connectionDispatchRevision: true,
})
const CONTEXT_KEYS: Readonly<Record<string, true>> = Object.freeze({
  userId: true,
  chatId: true,
  generationId: true,
  generationType: true,
  isDryRun: true,
  presetId: true,
  presetMetadata: true,
  personaId: true,
  characterId: true,
  personaAddonStates: true,
  excludeMessageId: true,
  rejectedSwipe: true,
  regenFeedback: true,
  regenFeedbackPosition: true,
  mainDispatch: true,
  prefillCarrier: true,
  interceptorDeadlineAt: true,
  boundWorkDeadlineAt: true,
  signal: true,
})
const MAIN_DISPATCH_KEYS: Readonly<Record<string, true>> = Object.freeze({
  source: true,
  descriptor: true,
  connectionDispatchRevision: true,
  dispatchKind: true,
})
const PREFILL_KEYS: Readonly<Record<string, true>> = Object.freeze({ id: true, state: true })
const MESSAGE_KEYS: Readonly<Record<string, true>> = Object.freeze({
  role: true,
  content: true,
  name: true,
  cache_control: true,
  reasoning_content: true,
  thinking_blocks: true,
  reasoning_details: true,
  __isChatHistory: true,
  sourceMessageId: true,
  sourceIndexInChat: true,
})
const RECEIPT_KEYS: Readonly<Record<string, true>> = Object.freeze({
  providerInvoked: true,
  terminalResponse: true,
  source: true,
  connectionId: true,
  connectionDispatchRevision: true,
  usage: true,
})
const USAGE_KEYS: Readonly<Record<string, true>> = Object.freeze({
  prompt_tokens: true,
  completion_tokens: true,
  total_tokens: true,
  provider_raw: true,
})
const RESPONSE_KEYS: Readonly<Record<string, true>> = Object.freeze({
  content: true,
  reasoning: true,
  finish_reason: true,
  tool_calls: true,
  thinking_blocks: true,
  reasoning_details: true,
  usage: true,
})

const MAX_HOST_RESULT_MESSAGES = MAX_BLOCKS_PER_THREAD * 4
const MAX_HOST_RESULT_BREAKDOWN = MAX_BLOCKS_PER_THREAD
const MAX_HOST_RESULT_TOOL_CALLS = MAX_BINDINGS_PER_RUN
const MAX_HOST_RESULT_ARRAY_ITEMS = MAX_HOST_RESULT_MESSAGES
const MAX_SNAPSHOT_ARRAY_ITEMS = MAX_HOST_RESULT_MESSAGES + MAX_BINDINGS_PER_RUN
const MAX_HOST_RESULT_OBJECT_KEYS = MAX_BLOCKS_PER_THREAD * 2
const MAX_HOST_RESULT_DEPTH = 32
const MAX_HOST_RESULT_NODES = MAX_HOST_RESULT_MESSAGES * MAX_BINDINGS_PER_RUN
const DANGEROUS_KEYS: Readonly<Record<string, true>> = Object.freeze({
  ["__proto__"]: true as const,
  ["constructor"]: true as const,
  ["prototype"]: true as const,
  ["toJSON"]: true as const,
})
const NO_FORBIDDEN_KEYS: Readonly<Record<string, true>> = Object.freeze({})

interface ScanBudget {
  readonly maxBytes: number
  readonly maxStringBytes: number
  readonly maxArrayItems: number
  readonly maxObjectKeys: number
  readonly maxDepth: number
  readonly maxNodes: number
  bytes: number
  nodes: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function newScanBudget(
  maxBytes = MAX_WORKSPACE_BYTES,
  maxStringBytes = MAX_THREAD_OUTPUT_BYTES,
  maxArrayItems = MAX_HOST_RESULT_ARRAY_ITEMS,
): ScanBudget {
  return {
    maxBytes,
    maxStringBytes,
    maxArrayItems,
    maxObjectKeys: MAX_HOST_RESULT_OBJECT_KEYS,
    maxDepth: MAX_HOST_RESULT_DEPTH,
    maxNodes: MAX_HOST_RESULT_NODES,
    bytes: 0,
    nodes: 0,
  }
}

function addScanBytes(budget: ScanBudget, bytes: number): boolean {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return false
  budget.bytes += bytes
  return Number.isSafeInteger(budget.bytes) && budget.bytes <= budget.maxBytes
}
function boundedKeyBytes(key: string, maxBytes: number): number | undefined {
  if (key.length > maxBytes) return undefined
  const bytes = utf8Bytes(key)
  return bytes <= maxBytes ? bytes : undefined
}
function isForbiddenKey(key: string, forbidden: Readonly<Record<string, true>>): boolean {
  if (forbidden[key] === true) return true
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "")
  for (const candidate of Object.keys(forbidden)) {
    if (candidate.toLowerCase().replace(/[^a-z0-9]/g, "") === normalized) return true
  }
  return false

}
function scanPlainValue(
  value: unknown,
  path: string,
  budget: ScanBudget,
  active: WeakSet<object>,
  forbidden: Readonly<Record<string, true>>,
  depth = 0,
): string | undefined {
  if (typeof value === "string") {
    if (value.length > budget.maxStringBytes) return `${path} exceeds APC string or byte limits`
    const bytes = utf8Bytes(value)
    if (bytes > budget.maxStringBytes || !addScanBytes(budget, bytes)) {
      return `${path} exceeds APC string or byte limits`
    }
    return undefined
  }
  if (value === null || typeof value === "boolean" || typeof value === "undefined") return undefined
  if (typeof value === "number") {
    return Number.isFinite(value) ? undefined : `${path} contains a non-finite number`
  }
  if (typeof value !== "object") return `${path} contains an unsupported value`
  if (depth > budget.maxDepth) return `${path} exceeds APC nesting depth`
  const object = value as object
  if (active.has(object)) return `${path} contains a cyclic value`
  if (budget.nodes >= budget.maxNodes) return `${path} exceeds APC object limits`
  active.add(object)
  try {
    if (Object.getOwnPropertySymbols(object).length > 0) return `${path} contains symbol properties`
    if (Array.isArray(value)) {
      if (value.length > budget.maxArrayItems) return `${path} exceeds APC array limits`
      const names = Object.getOwnPropertyNames(value)
      const keys = Object.keys(value)
      if (
        names.length !== value.length + 1 ||
        !names.includes("length") ||
        keys.length !== value.length ||
        keys.some((key, index) => key !== String(index))
      ) return `${path} is not a dense JSON array`
      budget.nodes += 1
      if (!addScanBytes(budget, 2 + value.length)) return `${path} exceeds APC byte limits`
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (descriptor === undefined || !("value" in descriptor)) return `${path}[${index}] is an accessor`
        const nested = scanPlainValue(descriptor.value, `${path}[${index}]`, budget, active, forbidden, depth + 1)
        if (nested) return nested
      }
      return undefined
    }
    const prototype = Object.getPrototypeOf(object)
    if (prototype !== Object.prototype && prototype !== null) return `${path} has an unsupported prototype`
    const names = Object.getOwnPropertyNames(object)
    const keys = Object.keys(object)
    if (names.length !== keys.length || keys.length > budget.maxObjectKeys) {
      return `${path} exceeds APC object limits`
    }
    budget.nodes += 1
    if (!addScanBytes(budget, 2 + keys.length)) return `${path} exceeds APC byte limits`
    for (const key of keys) {
      const keyBytes = boundedKeyBytes(key, budget.maxStringBytes)
      if (keyBytes === undefined) return `${path} contains an oversized property key`
      if (DANGEROUS_KEYS[key] === true) return `${path}.${key} is not accepted`
      if (isForbiddenKey(key, forbidden)) return `${path}.${key}`
      const descriptor = Object.getOwnPropertyDescriptor(object, key)
      if (descriptor === undefined || !("value" in descriptor)) return `${path}.${key} is an accessor`
      if (!addScanBytes(budget, keyBytes)) return `${path} exceeds APC byte limits`
      const nested = scanPlainValue(descriptor.value, `${path}.${key}`, budget, active, forbidden, depth + 1)
      if (nested) return nested
    }
    return undefined
  } catch {
    return `${path} is not a safe JSON value`
  } finally {
    active.delete(object)
  }
}

function scanHostValue(
  value: unknown,
  path: string,
  maxBytes = MAX_WORKSPACE_BYTES,
  maxStringBytes = MAX_THREAD_OUTPUT_BYTES,
  maxArrayItems = MAX_HOST_RESULT_ARRAY_ITEMS,
  forbidden = FORBIDDEN_OUTPUT_KEYS,
): string | undefined {
  return scanPlainValue(
    value,
    path,
    newScanBudget(maxBytes, maxStringBytes, maxArrayItems),
    new WeakSet<object>(),
    forbidden,
  )
}

function serializedWithinBytes(value: unknown, maxBytes: number): boolean {
  try {
    const encoded = JSON.stringify(value)
    return typeof encoded === "string" && utf8Bytes(encoded) <= maxBytes
  } catch {
    return false
  }
}

function boundedJsonValue(
  value: unknown,
  maxBytes: number,
  maxArrayItems = MAX_HOST_RESULT_ARRAY_ITEMS,
): boolean {
  if (scanHostValue(value, "payload", maxBytes, maxBytes, maxArrayItems) !== undefined) return false
  return serializedWithinBytes(value, maxBytes)
}

function rejectUnknownKeys(value: unknown, allowed: Readonly<Record<string, true>>, path: string): string | undefined {
  if (!isRecord(value)) return `${path} must be an object`
  let keys: string[]
  try {
    keys = Object.keys(value)
  } catch {
    return `${path} is not a safe object`
  }
  if (keys.length > MAX_HOST_RESULT_OBJECT_KEYS) return `${path} exceeds APC object limits`
  for (const key of keys) {
    if (boundedKeyBytes(key, MAX_THREAD_OUTPUT_BYTES) === undefined) return `${path} contains an oversized property key`
    if (allowed[key] !== true) return `Unexpected APC field ${path}.${key}`
  }
  return undefined
}

function findForbiddenKey(
  value: unknown,
  path: string,
  _seen: WeakSet<object>,
  forbidden = FORBIDDEN_PAYLOAD_KEYS,
): string | undefined {
  return scanHostValue(value, path, MAX_WORKSPACE_BYTES, MAX_THREAD_OUTPUT_BYTES, MAX_HOST_RESULT_ARRAY_ITEMS, forbidden)
}

function cloneSnapshot(
  value: unknown,
  depth: number,
  state: { nodes: number },
  seen: WeakMap<object, unknown>,
): unknown {
  if (value === null || typeof value !== "object") return value
  if (depth > MAX_HOST_RESULT_DEPTH || state.nodes >= MAX_HOST_RESULT_NODES) {
    throw new TypeError("APC snapshot exceeds structural limits")
  }
  const object = value as object
  const existing = seen.get(object)
  if (existing !== undefined) return existing
  const copy: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {}
  seen.set(object, copy)
  state.nodes += 1
  for (const key of Object.keys(value as Record<string, unknown>)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key)
    if (descriptor === undefined || !("value" in descriptor)) throw new TypeError("APC snapshot contains an accessor")
    const child = cloneSnapshot(descriptor.value, depth + 1, state, seen)
    if (Array.isArray(copy)) copy.push(child)
    else copy[key] = child
  }
  Object.freeze(copy)
  return copy
}

function cloneAndFreeze<T>(value: T): T {
  const issue = scanHostValue(value, "snapshot", MAX_WORKSPACE_BYTES, MAX_THREAD_OUTPUT_BYTES, MAX_SNAPSHOT_ARRAY_ITEMS, NO_FORBIDDEN_KEYS)
  if (issue) throw new TypeError(issue)
  return cloneSnapshot(value, 0, { nodes: 0 }, new WeakMap<object, unknown>()) as T
}

function messageSnapshot(messages: readonly LlmMessageDTO[]): readonly LlmMessageDTO[] {
  if (!Array.isArray(messages)) throw new TypeError("Message snapshot must be an array")
  return cloneAndFreeze(messages)
}

function boundedText(value: unknown, maxBytes = MAX_THREAD_OUTPUT_BYTES): value is string {
  return typeof value === "string" && value.length <= maxBytes && utf8Bytes(value) <= maxBytes
}

function nonEmptyText(value: unknown): value is string {
  return boundedText(value) && value.length > 0
}

function validThinkingBlocks(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > MAX_HOST_RESULT_ARRAY_ITEMS) return false
  for (const block of value) {
    if (!isRecord(block) || rejectUnknownKeys(block, { type: true, thinking: true, signature: true, data: true }, "thinking") !== undefined) return false
    if (block.type !== "thinking" && block.type !== "redacted_thinking") return false
    if (block.thinking !== undefined && !boundedText(block.thinking)) return false
    if (block.signature !== undefined && !boundedText(block.signature, MAX_TOOL_SIGNATURE_BYTES)) return false
    if (block.data !== undefined && !boundedText(block.data, MAX_TOOL_SIGNATURE_BYTES)) return false
  }
  return true
}

function validMessagePart(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== "string") return false
  switch (value.type) {
    case "text":
      return rejectUnknownKeys(value, { type: true, text: true, cache_control: true }, "message.content") === undefined
        && boundedText(value.text)
        && (value.cache_control === undefined || isRecord(value.cache_control) && boundedJsonValue(value.cache_control, MAX_PROVIDER_RAW_BYTES))
    case "image":
    case "audio":
      return rejectUnknownKeys(value, { type: true, data: true, mime_type: true, cache_control: true }, "message.content") === undefined
        && boundedText(value.data)
        && boundedText(value.mime_type)
        && (value.cache_control === undefined || isRecord(value.cache_control) && boundedJsonValue(value.cache_control, MAX_PROVIDER_RAW_BYTES))
    case "tool_use":
      return rejectUnknownKeys(value, { type: true, id: true, name: true, input: true, cache_control: true, thought_signature: true }, "message.content") === undefined
        && boundedText(value.id)
        && boundedText(value.name)
        && isRecord(value.input)
        && boundedJsonValue(value.input, MAX_PROVIDER_RAW_BYTES)
        && (value.cache_control === undefined || isRecord(value.cache_control) && boundedJsonValue(value.cache_control, MAX_PROVIDER_RAW_BYTES))
        && (value.thought_signature === undefined || boundedText(value.thought_signature, MAX_TOOL_SIGNATURE_BYTES))
    case "tool_result":
      return rejectUnknownKeys(value, { type: true, tool_use_id: true, content: true, is_error: true, cache_control: true }, "message.content") === undefined
        && boundedText(value.tool_use_id)
        && boundedText(value.content)
        && (value.is_error === undefined || typeof value.is_error === "boolean")
        && (value.cache_control === undefined || isRecord(value.cache_control) && boundedJsonValue(value.cache_control, MAX_PROVIDER_RAW_BYTES))
    default:
      return false
  }
}

function validMessage(value: unknown): value is LlmMessageDTO {
  if (!isRecord(value) || rejectUnknownKeys(value, MESSAGE_KEYS, "message")) return false
  if (value.role !== "system" && value.role !== "user" && value.role !== "assistant") return false
  if (typeof value.content !== "string" && !Array.isArray(value.content)) return false
  if (typeof value.content === "string") {
    if (!boundedText(value.content)) return false
  } else if (
    value.content.length > MAX_HOST_RESULT_ARRAY_ITEMS ||
    value.content.some((part) => !validMessagePart(part))
  ) return false
  if (value.name !== undefined && !boundedText(value.name)) return false
  if (value.cache_control !== undefined && (!isRecord(value.cache_control) || !boundedJsonValue(value.cache_control, MAX_PROVIDER_RAW_BYTES))) return false
  if (value.reasoning_content !== undefined && !boundedText(value.reasoning_content)) return false
  if (value.thinking_blocks !== undefined && !validThinkingBlocks(value.thinking_blocks)) return false
  if (value.reasoning_details !== undefined && (!Array.isArray(value.reasoning_details) || !value.reasoning_details.every((entry) => isRecord(entry)) || !boundedJsonValue(value.reasoning_details, MAX_PROVIDER_RAW_BYTES))) return false
  if (value.__isChatHistory !== undefined && typeof value.__isChatHistory !== "boolean") return false
  if (value.sourceMessageId !== undefined && !boundedText(value.sourceMessageId)) return false
  if (value.sourceIndexInChat !== undefined && !Number.isSafeInteger(value.sourceIndexInChat)) return false
  return true
}

function validMessageArray(value: unknown, maxItems = MAX_HOST_RESULT_MESSAGES): value is LlmMessageDTO[] {
  return Array.isArray(value) &&
    value.length <= maxItems &&
    value.every((message) => validMessage(message))
}

function validUsage(value: unknown): boolean {
  if (!isRecord(value) || rejectUnknownKeys(value, USAGE_KEYS, "usage")) return false
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens"]) {
    const entry = value[key]
    if (entry !== undefined && (!Number.isFinite(entry) || (entry as number) < 0)) return false
  }
  if (value.provider_raw !== undefined && (!isRecord(value.provider_raw) || !boundedJsonValue(value.provider_raw, MAX_PROVIDER_RAW_BYTES))) return false
  return boundedJsonValue(value, MAX_PROVIDER_RAW_BYTES)
}

function validResponse(value: unknown): value is GenerationResponseDTO {
  if (!isRecord(value) || rejectUnknownKeys(value, RESPONSE_KEYS, "response")) return false
  if (!boundedText(value.content) || !boundedText(value.finish_reason)) return false
  if (value.reasoning !== undefined && !boundedText(value.reasoning)) return false
  if (value.tool_calls !== undefined) {
    if (
      !Array.isArray(value.tool_calls) ||
      value.tool_calls.length > MAX_HOST_RESULT_TOOL_CALLS ||
      value.tool_calls.some((call) => {
        if (!isRecord(call) || rejectUnknownKeys(call, { name: true, args: true, call_id: true, thought_signature: true }, "response.tool_calls") !== undefined) return true
        return (
          !boundedText(call.name) ||
          !isRecord(call.args) ||
          !boundedJsonValue(call.args, MAX_PROVIDER_RAW_BYTES) ||
          !boundedText(call.call_id) ||
          (call.thought_signature !== undefined && !boundedText(call.thought_signature, MAX_TOOL_SIGNATURE_BYTES))
        )
      })
    ) return false
  }
  if (value.thinking_blocks !== undefined && !validThinkingBlocks(value.thinking_blocks)) return false
  if (value.reasoning_details !== undefined && (!Array.isArray(value.reasoning_details) || !value.reasoning_details.every((entry) => isRecord(entry)) || !boundedJsonValue(value.reasoning_details, MAX_PROVIDER_RAW_BYTES))) return false
  if (value.usage !== undefined && !validUsage(value.usage)) return false
  return true
}

function validReceipt(value: unknown): value is QuietDispatchReceiptDTO {
  if (!isRecord(value) || rejectUnknownKeys(value, RECEIPT_KEYS, "receipt")) return false
  if (typeof value.providerInvoked !== "boolean" || typeof value.terminalResponse !== "boolean") return false
  if (value.source !== "main" && value.source !== "slot") return false
  if (value.connectionId !== null && !boundedText(value.connectionId)) return false
  if (!nonEmptyText(value.connectionDispatchRevision)) return false
  if (value.usage !== undefined && !validUsage(value.usage)) return false
  return true
}

function validAssemblyFailure(value: unknown): boolean {
  if (!isRecord(value) || !boundedText(value.kind) || !boundedText(value.code) || !boundedText(value.message)) return false
  if (value.kind === "hook") {
    return value.code === "ASSEMBLY_HOOK_FAILED" &&
      (value.phase === "context" || value.phase === "world_info" || value.phase === "macro") &&
      (value.reason === "error" || value.reason === "timeout") &&
      Object.keys(value).every((key) => ["kind", "code", "phase", "reason", "message"].includes(key))
  }
  if (value.kind === "macro") {
    return value.code === "ASSEMBLY_MACRO_FAILED" &&
      ["definition", "parse", "recursion", "budget", "evaluation"].includes(value.reason as string) &&
      Object.keys(value).every((key) => ["kind", "code", "reason", "message"].includes(key))
  }
  if (value.kind === "retrieval_snapshot") {
    return value.code === "ASSEMBLY_RETRIEVAL_SNAPSHOT_UNAVAILABLE" &&
      ["missing", "expired", "unavailable", "oversize"].includes(value.reason as string) &&
      Object.keys(value).every((key) => ["kind", "code", "reason", "message"].includes(key))
  }
  if (value.kind === "abort") {
    return value.code === "ASSEMBLY_ABORTED" &&
      value.name === "AbortError" &&
      Object.keys(value).every((key) => ["kind", "code", "name", "message"].includes(key))
  }
  return ["precondition", "security", "internal"].includes(value.kind) &&
    Object.keys(value).every((key) => ["kind", "code", "message"].includes(key))
}

const BREAKDOWN_KEYS: Readonly<Record<string, true>> = Object.freeze({
  type: true,
  name: true,
  role: true,
  content: true,
  blockId: true,
  marker: true,
  messageCount: true,
  firstMessageIndex: true,
  preCountedTokens: true,
  excludeFromTotal: true,
  extensionId: true,
  extensionName: true,
})

function validBreakdown(value: unknown): boolean {
  if (!isRecord(value) || rejectUnknownKeys(value, BREAKDOWN_KEYS, "assembly.breakdown") !== undefined) return false
  if (!boundedText(value.type) || !boundedText(value.name)) return false
  if (value.content !== undefined && !boundedText(value.content, MAX_BLOCK_CONTENT_BYTES)) return false
  for (const key of ["role", "blockId", "marker", "extensionId", "extensionName"]) {
    if (value[key] !== undefined && !boundedText(value[key])) return false
  }
  for (const key of ["messageCount", "firstMessageIndex", "preCountedTokens"]) {
    if (value[key] !== undefined && !Number.isFinite(value[key])) return false
  }
  return value.excludeFromTotal === undefined || typeof value.excludeFromTotal === "boolean"
}

function validAssemblyOutcome(value: unknown): value is BoundAssemblyOutcomeDTO {
  if (
    scanHostValue(value, "assembly") !== undefined ||
    !serializedWithinBytes(value, MAX_WORKSPACE_BYTES) ||
    !isRecord(value) ||
    typeof value.ok !== "boolean"
  ) return false
  if (value.ok) {
    const result = value.result
    if (!isRecord(result) || rejectUnknownKeys(result, { messages: true, breakdown: true, resolved: true }, "assembly.result")) return false
    if (
      !validMessageArray(result.messages) ||
      !Array.isArray(result.breakdown) ||
      result.breakdown.length > MAX_HOST_RESULT_BREAKDOWN ||
      !result.breakdown.every((entry) => validBreakdown(entry)) ||
      !isRecord(result.resolved)
    ) return false
    if (rejectUnknownKeys(result.resolved, { source: true, connectionId: true, connectionDispatchRevision: true, dispatchKind: true }, "assembly.resolved")) return false
    return (
      (result.resolved.source === "main" || result.resolved.source === "slot") &&
      (result.resolved.connectionId === null || boundedText(result.resolved.connectionId)) &&
      nonEmptyText(result.resolved.connectionDispatchRevision) &&
      result.resolved.dispatchKind === "concrete"
    )
  }
  return validAssemblyFailure(value.error)
}

function validQuietResult(value: unknown): value is QuietTrackedResultDTO {
  if (
    scanHostValue(value, "quiet") !== undefined ||
    !serializedWithinBytes(value, MAX_WORKSPACE_BYTES) ||
    !isRecord(value) ||
    typeof value.ok !== "boolean"
  ) return false
  if (value.ok) {
    return (
      rejectUnknownKeys(value, { ok: true, response: true, receipt: true }, "quiet") === undefined &&
      validResponse(value.response) &&
      validReceipt(value.receipt)
    )
  }
  if (value.phase === "preflight") {
    if (
      rejectUnknownKeys(value, { ok: true, phase: true, providerInvoked: true, receipt: true, error: true }, "quiet") !== undefined ||
      value.providerInvoked !== false ||
      value.receipt !== null
    ) return false
  } else if (value.phase === "resolved") {
    if (
      rejectUnknownKeys(value, { ok: true, phase: true, receipt: true, error: true }, "quiet") !== undefined ||
      !validReceipt(value.receipt)
    ) return false
  } else {
    return false
  }
  if (
    !isRecord(value.error) ||
    !boundedText(value.error.kind) ||
    !boundedText(value.error.code) ||
    !boundedText(value.error.name) ||
    !boundedText(value.error.message)
  ) return false
  const errorKeys = Object.keys(value.error)
  if (!errorKeys.every((key) => ["kind", "code", "name", "message"].includes(key))) return false
  return value.phase === "preflight"
    ? value.error.kind === "precondition" || value.error.kind === "security"
    : ["precondition", "provider", "abort", "security", "internal"].includes(value.error.kind)
}


export interface AuxiliaryContextSnapshot {
  readonly userId: string
  readonly chatId: string
  readonly generationId: string
  readonly presetId: string | null
  readonly prefillCarrier: BoundPrefillAttachmentDTO
  readonly interceptorDeadlineAt: number
  readonly boundWorkDeadlineAt: number
  readonly signal: AbortSignal
  readonly mainDescriptor: AuxiliaryHostDescriptor | null
  readonly mainDispatchRevision: string | null
}

function descriptorSnapshot(value: unknown): AuxiliaryHostDescriptor | undefined {
  if (scanHostValue(value, "descriptor", MAX_WORKSPACE_BYTES, MAX_THREAD_OUTPUT_BYTES, MAX_HOST_RESULT_ARRAY_ITEMS, NO_FORBIDDEN_KEYS) !== undefined) return undefined
  if (rejectUnknownKeys(value, DESCRIPTOR_KEYS, "descriptor")) return undefined
  if (
    !isRecord(value) ||
    !nonEmptyText(value.connectionId) ||
    !boundedText(value.connectionName) ||
    !boundedText(value.provider) ||
    !boundedText(value.model) ||
    !boundedText(value.endpointOrigin) ||
    value.dispatchKind !== "concrete" ||
    !nonEmptyText(value.connectionDispatchRevision)
  ) return undefined
  try {
    return cloneAndFreeze(value) as AuxiliaryHostDescriptor
  } catch {
    return undefined
  }
}

function descriptorsEqual(left: AuxiliaryHostDescriptor, right: AuxiliaryHostDescriptor): boolean {
  return (
    left.connectionId === right.connectionId &&
    left.connectionName === right.connectionName &&
    left.provider === right.provider &&
    left.model === right.model &&
    left.endpointOrigin === right.endpointOrigin &&
    left.dispatchKind === right.dispatchKind &&
    left.connectionDispatchRevision === right.connectionDispatchRevision
  )
}

function signalLike(value: unknown): value is AbortSignal {
  return (
    isRecord(value) &&
    typeof value.addEventListener === "function" &&
    typeof value.removeEventListener === "function" &&
    typeof value.aborted === "boolean"
  )
}

function freezeContext(context: InterceptorContextDTO): AuxiliaryContextSnapshot {
  const rawDescriptor = context.mainDispatch.descriptor
  let descriptor: AuxiliaryHostDescriptor | null = null
  if (rawDescriptor !== undefined && rawDescriptor !== null) {
    const snapshot = descriptorSnapshot(rawDescriptor)
    if (snapshot === undefined) {
      throw new TypeError("Main dispatch descriptor is invalid")
    }
    descriptor = snapshot
  }
  return Object.freeze({
    userId: context.userId,
    chatId: context.chatId,
    generationId: context.generationId,
    presetId: context.presetId,
    prefillCarrier: cloneAndFreeze(context.prefillCarrier),
    interceptorDeadlineAt: context.interceptorDeadlineAt,
    boundWorkDeadlineAt: context.boundWorkDeadlineAt,
    signal: context.signal,
    mainDescriptor: descriptor,
    mainDispatchRevision: context.mainDispatch.connectionDispatchRevision,
  })
}

function makeDispatch(
  source: "main" | "slot",
  descriptor: AuxiliaryHostDescriptor,
  expectedDispatchRevision: string,
): GenerationDispatchSourceDTO {
  if (source === "main") {
    return { source: "main", expectedConnectionDispatchRevision: expectedDispatchRevision }
  }
  return {
    source: "slot",
    connectionId: descriptor.connectionId,
    expectedConnectionDispatchRevision: expectedDispatchRevision,
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  return "Auxiliary execution failed"
}

function receiptMatches(
  receipt: QuietDispatchReceiptDTO,
  input: AuxiliaryExecutionInput,
  requireTerminalReceipt = false,
): boolean {
  return (
    validReceipt(receipt) &&
    (!requireTerminalReceipt || (receipt.providerInvoked === true && receipt.terminalResponse === true)) &&
    receipt.source === input.dispatchSource &&
    receipt.connectionId === input.resolvedHostDescriptor.connectionId &&
    receipt.connectionDispatchRevision === input.expectedDispatchRevision
  )
}

function provenance(
  context: AuxiliaryContextSnapshot,
  input: AuxiliaryExecutionInput,
): AuxiliaryRunProvenance {
  return Object.freeze({
    userId: context.userId,
    chatId: context.chatId,
    generationId: context.generationId,
    presetId: context.presetId,
    runId: input.run.id,
    source: input.dispatchSource,
    connectionId: input.resolvedHostDescriptor.connectionId,
    connectionDispatchRevision: input.expectedDispatchRevision,
  })
}

function failed(
  code: string,
  phase: AuxiliaryRunFailed["phase"],
  message: string,
  extra: Pick<AuxiliaryRunFailed, "receipt" | "provenance"> = {},
): AuxiliaryRunFailed {
  return Object.freeze({ kind: "failed", code, phase, message, ...extra })
}

function cancellation(
  deadlineAt: number,
  timedOut: boolean,
  extra: Pick<AuxiliaryRunCancelled, "receipt" | "provenance"> = {},
): AuxiliaryRunCancelled | AuxiliaryRunTimedOut {
  if (timedOut) {
    return Object.freeze({
      kind: "timed-out",
      code: "DEADLINE_EXCEEDED",
      message: "Auxiliary run deadline exceeded",
      deadlineAt,
      ...extra,
    })
  }
  return Object.freeze({
    kind: "cancelled",
    code: "CANCELLED",
    message: "Auxiliary run cancelled",
    ...extra,
  })
}

function validateInput(input: AuxiliaryExecutionInput): string | undefined {
  if (!isRecord(input)) return "Input must be an object"
  const unknownInput = rejectUnknownKeys(input, INPUT_KEYS, "input")
  if (unknownInput) return unknownInput
  if (!isRecord(input.context)) return "Interceptor context is required"
  if (!isRecord(input.run)) return "Run binding is required"
  if (!isRecord(input.workspace)) return "Workspace binding is required"
  const unknownContext = rejectUnknownKeys(input.context, CONTEXT_KEYS, "input.context")
  if (unknownContext) return unknownContext
  const unknownMainDispatch = rejectUnknownKeys(input.context.mainDispatch, MAIN_DISPATCH_KEYS, "input.context.mainDispatch")
  if (unknownMainDispatch) return unknownMainDispatch
  const unknownPrefill = rejectUnknownKeys(input.context.prefillCarrier, PREFILL_KEYS, "input.context.prefillCarrier")
  if (unknownPrefill) return unknownPrefill
  const unknownRun = rejectUnknownKeys(input.run, RUN_KEYS, "input.run")
  if (unknownRun) return unknownRun
  const unknownWorkspace = rejectUnknownKeys(input.workspace, WORKSPACE_KEYS, "input.workspace")
  if (unknownWorkspace) return unknownWorkspace

  const forbidden = findForbiddenKey(
    {
      run: input.run,
      workspace: input.workspace,
      mainMessages: input.mainMessages,
      inputBindings: input.inputBindings,
    },
    "input",
    new WeakSet<object>(),
  )
  if (forbidden) return `APC payload field is not accepted: ${forbidden}`

  if (!nonEmptyText(input.run.id)) return "Run id is required"
  try {
    validateRunTimeout(input.run.timeoutMs)
  } catch {
    return "Run timeout is invalid"
  }
  if (!Number.isSafeInteger(input.deadlineAt)) return "Run deadline must be a finite safe integer"
  if (
    !Number.isSafeInteger(input.context.interceptorDeadlineAt) ||
    !Number.isSafeInteger(input.context.boundWorkDeadlineAt)
  ) return "Interceptor deadlines must be finite safe integers"
  if (!signalLike(input.context.signal) || !signalLike(input.parentSignal)) return "Cancellation signals are required"
  if (!nonEmptyText(input.context.userId) || !nonEmptyText(input.context.chatId) || !nonEmptyText(input.context.generationId)) {
    return "Interceptor identity is incomplete"
  }
  if (input.context.presetId !== null && !nonEmptyText(input.context.presetId)) return "Preset identity is invalid"
  if (!isRecord(input.context.mainDispatch)) return "Main dispatch snapshot is required"
  if (input.context.mainDispatch.source !== "main") return "Main dispatch source is invalid"
  if (
    input.context.mainDispatch.connectionDispatchRevision !== null &&
    !nonEmptyText(input.context.mainDispatch.connectionDispatchRevision)
  ) return "Main dispatch revision is invalid"
  if (
    input.context.mainDispatch.dispatchKind !== null &&
    input.context.mainDispatch.dispatchKind !== "concrete" &&
    input.context.mainDispatch.dispatchKind !== "roulette"
  ) return "Main dispatch kind is invalid"
  if (
    !isRecord(input.context.prefillCarrier) ||
    typeof input.context.prefillCarrier.id !== "string" ||
    (input.context.prefillCarrier.state !== "absent" &&
      !nonEmptyText(input.context.prefillCarrier.id)) ||
    (input.context.prefillCarrier.state !== "absent" &&
      input.context.prefillCarrier.state !== "available" &&
      input.context.prefillCarrier.state !== "invalid")
  ) return "Prefill carrier is invalid"
  if (!isRecord(input.context.personaAddonStates)) return "Persona addon state is invalid"
  for (const value of Object.values(input.context.personaAddonStates)) {
    if (typeof value !== "boolean") return "Persona addon state is invalid"
  }
  const descriptor = descriptorSnapshot(input.resolvedHostDescriptor)
  if (descriptor === undefined) return "Resolved host descriptor is invalid"
  if (!nonEmptyText(input.expectedDispatchRevision)) return "Expected dispatch revision is required"
  if (input.resolvedHostDescriptor.connectionDispatchRevision !== input.expectedDispatchRevision) {
    return "Resolved descriptor dispatch revision is stale"
  }
  if (input.dispatchSource !== "main" && input.dispatchSource !== "slot") return "Dispatch source is invalid"
  if (input.dispatchSource === "slot" && !nonEmptyText(input.resolvedHostDescriptor.connectionId)) {
    return "Slot connection identity is required"
  }
  if (!Array.isArray(input.inputBindings) || !validMessageArray(input.inputBindings, MAX_BINDINGS_PER_RUN)) {
    return "Input bindings must be valid messages"
  }
  if (input.workspace.source !== "native-blocks" && input.workspace.source !== "main-context") {
    return "Workspace source is invalid"
  }
  if (input.workspace.source === "native-blocks") {
    if (!Array.isArray(input.workspace.blocks) || input.workspace.blocks.length > MAX_BLOCKS_PER_THREAD) {
      return "Native-block workspace requires bounded prompt blocks"
    }
    if (input.mainMessages !== undefined) return "Native-block workspace cannot carry Main messages"
  } else {
    if (!Array.isArray(input.mainMessages) || !validMessageArray(input.mainMessages)) {
      return "Main-context workspace requires an assembled message snapshot"
    }
    if (input.workspace.blocks !== undefined) return "Main-context workspace cannot carry native blocks"
  }
  if (
    input.workspace.promptVariableValues !== undefined &&
    !isRecord(input.workspace.promptVariableValues)
  ) return "Prompt variable values are invalid"
  return undefined
}

function isAbortLike(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
    || error instanceof Error && error.name === "AbortError"
}
function cancellationReason(value: unknown): CancellationReason {
  switch (value) {
    case "host-abort":
    case "deadline":
    case "stop":
    case "permission-revoked":
    case "replacement":
    case "disable":
    case "update":
    case "required-failure":
    case "integrity-fatal":
    case "disposed":
    case "child-timeout":
      return value
    default:
      return "host-abort"
  }
}

/**
 * Execute one APC auxiliary run against the callback-bound host substrate.
 * No call is made until the descriptor, source revisions, deadline, and
 * cancellation signal have all been checked. Every awaited host boundary is
 * checked again before its result is accepted.
 */
export async function executeAuxiliaryRun(
  input: AuxiliaryExecutionInput,
  deps: AuxiliaryExecutionDeps,
): Promise<AuxiliaryRunResult> {
  let inputError: string | undefined
  try {
    inputError = validateInput(input)
  } catch (error) {
    return failed("UNTRUSTED_PAYLOAD", "input", errorMessage(error))
  }
  if (inputError) return failed("UNTRUSTED_PAYLOAD", "input", inputError)
  if (
    !deps ||
    typeof deps.assemble !== "function" ||
    typeof deps.quietTracked !== "function" ||
    typeof deps.isExecutionCurrent !== "function"
  ) return failed("INVALID_DEPENDENCIES", "input", "Auxiliary execution dependencies are incomplete")

  let context: AuxiliaryContextSnapshot
  let descriptor: AuxiliaryHostDescriptor
  try {
    context = freezeContext(input.context)
    const resolved = descriptorSnapshot(input.resolvedHostDescriptor)
    if (resolved === undefined) return failed("UNTRUSTED_DESCRIPTOR", "input", "Resolved host descriptor is invalid")
    descriptor = resolved
  } catch (error) {
    return failed("UNTRUSTED_DESCRIPTOR", "input", errorMessage(error))
  }

  if (input.dispatchSource === "main") {
    if (
      context.mainDescriptor === null ||
      context.mainDispatchRevision !== input.expectedDispatchRevision ||
      input.context.mainDispatch.dispatchKind !== "concrete" ||
      !descriptorsEqual(context.mainDescriptor, descriptor)
    ) {
      return failed("STALE_DISPATCH_REVISION", "revision", "Main dispatch descriptor is not bound to the expected revision")
    }
  }

  let inputBindingsSnapshot: readonly LlmMessageDTO[]
  let mainMessagesSnapshot: readonly LlmMessageDTO[] | undefined
  try {
    inputBindingsSnapshot = messageSnapshot(input.inputBindings)
    if (input.workspace.source === "main-context") {
      mainMessagesSnapshot = messageSnapshot(input.mainMessages ?? [])
    }
  } catch (error) {
    return failed("UNTRUSTED_PAYLOAD", "input", errorMessage(error))
  }

  const clock: CancellationClock = Object.freeze({
    now: deps.now ?? (() => Date.now()),
    setTimeout: deps.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs)),
    clearTimeout: deps.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)),
  })
  let runStartedAt: number
  try {
    runStartedAt = clock.now()
  } catch (error) {
    return failed("INVALID_DEADLINE", "input", errorMessage(error))
  }
  if (!Number.isSafeInteger(runStartedAt)) {
    return failed("INVALID_DEADLINE", "input", "Execution clock must return a finite safe integer")
  }
  const configuredDeadlineAt = runStartedAt + input.run.timeoutMs
  if (!Number.isSafeInteger(configuredDeadlineAt)) {
    return failed("INVALID_DEADLINE", "input", "Configured run timeout produces an unsafe deadline")
  }
  const callbackDeadlineAt = Math.min(
    input.deadlineAt,
    context.boundWorkDeadlineAt,
    context.interceptorDeadlineAt,
  )
  const runDeadlineAt = Math.min(callbackDeadlineAt, configuredDeadlineAt)
  const boundInput = Object.freeze({
    ...input,
    resolvedHostDescriptor: descriptor,
  }) as AuxiliaryExecutionInput
  const runProvenance = provenance(context, boundInput)
  if (runDeadlineAt <= runStartedAt) return cancellation(runDeadlineAt, true, { provenance: runProvenance })

  let cancellationTree: ExecutionCancellation | undefined
  let runCancellation: RunCancellation | undefined
  try {
    cancellationTree = createExecutionCancellation({
      hostSignal: context.signal,
      deadlineAt: runDeadlineAt,
      clock,
    })
    runCancellation = createRunCancellation(cancellationTree, {
      id: input.run.id,
      deadlineAt: runDeadlineAt,
    })
  } catch (error) {
    cancellationTree?.dispose()
    return failed("CANCELLATION_SETUP_FAILED", "input", errorMessage(error), { provenance: runProvenance })
  }
  if (cancellationTree === undefined || runCancellation === undefined) {
    cancellationTree?.dispose()
    return failed("CANCELLATION_SETUP_FAILED", "input", "Cancellation tree was not created", { provenance: runProvenance })
  }

  let parentSignalAttached = false
  const onParentAbort = (): void => {
    const reason = cancellationReason((input.parentSignal as AbortSignal & { readonly reason?: unknown }).reason)
    cancellationTree?.stop(reason)
  }
  const signal = runCancellation.signal

  try {
    if (input.parentSignal !== context.signal) {
      if (input.parentSignal.aborted) onParentAbort()
      else {
        input.parentSignal.addEventListener("abort", onParentAbort, { once: true })
        parentSignalAttached = true
      }
    }

    const cancelled = (): AuxiliaryRunCancelled | AuxiliaryRunTimedOut | undefined => {
      const now = clock.now()
      if (
        runCancellation.reason === "deadline" ||
        runCancellation.reason === "child-timeout" ||
        now >= runDeadlineAt
      ) return cancellation(runDeadlineAt, true, { provenance: runProvenance })
      if (signal.aborted || !runCancellation.isActive()) {
        return cancellation(runDeadlineAt, false, { provenance: runProvenance })
      }
      return undefined
    }

    const boundaryFailure = (
      boundary: "before-assembly" | "after-assembly" | "before-dispatch" | "after-dispatch",
    ): AuxiliaryRunResult | undefined => {
      const stop = cancelled()
      if (stop) return stop
      try {
        if (deps.isExecutionCurrent() !== true) {
          return failed("STALE_EXECUTION_SCOPE", "revision", `APC execution scope changed at ${boundary}`)
        }
      } catch (error) {
        return failed("EXECUTION_SCOPE_CHECK_FAILED", "revision", errorMessage(error))
      }
      return undefined
    }

    let assembledMessages: readonly LlmMessageDTO[]
    if (input.workspace.source === "native-blocks") {
      const preAssemblyFailure = boundaryFailure("before-assembly")
      if (preAssemblyFailure) return preAssemblyFailure
      const assemblyInput: BoundAssembleRequestDTO = {
        blocks: cloneAndFreeze(input.workspace.blocks ?? []) as PromptBlockDTO[],
        ...(input.workspace.promptVariableValues
          ? { promptVariableValues: cloneAndFreeze(input.workspace.promptVariableValues) }
          : {}),
        dispatch: makeDispatch(input.dispatchSource, descriptor, input.expectedDispatchRevision),
        deadlineAt: runDeadlineAt,
        signal,
      }
      let assemblyResult: BoundAssemblyOutcomeDTO
      try {
        const completed = await runCancellation.completion(
          Promise.resolve().then(() => deps.assemble(assemblyInput)),
        )
        if (!completed.accepted) {
          return cancellation(
            runDeadlineAt,
            completed.reason === "deadline" || completed.reason === "child-timeout",
            { provenance: runProvenance },
          )
        }
        if (!validAssemblyOutcome(completed.value)) {
          const lateFailure = boundaryFailure("after-assembly")
          return lateFailure ?? failed("UNTRUSTED_ASSEMBLY", "assembly", "Bound assembly returned an invalid outcome", { provenance: runProvenance })
        }
        assemblyResult = completed.value
      } catch (error) {
        const stop = cancelled()
        if (stop) return stop
        const postFailure = boundaryFailure("after-assembly")
        if (postFailure) return postFailure
        return failed(isAbortLike(error) ? "ASSEMBLY_ABORTED" : "ASSEMBLY_CALL_FAILED", "assembly", errorMessage(error), {
          provenance: runProvenance,
        })
      }
      const postAssemblyFailure = boundaryFailure("after-assembly")
      if (postAssemblyFailure) return postAssemblyFailure
      if (!assemblyResult.ok) {
        if (assemblyResult.error.kind === "abort") {
          const stop = cancelled()
          if (stop) return stop
        }
        return failed(assemblyResult.error.code, "assembly", assemblyResult.error.message, { provenance: runProvenance })
      }
      if (
        assemblyResult.result.resolved.source !== input.dispatchSource ||
        assemblyResult.result.resolved.connectionId !== descriptor.connectionId ||
        assemblyResult.result.resolved.connectionDispatchRevision !== input.expectedDispatchRevision ||
        assemblyResult.result.resolved.dispatchKind !== "concrete"
      ) {
        return failed("ASSEMBLY_PROVENANCE_MISMATCH", "revision", "Assembly result did not preserve the bound dispatch provenance", {
          provenance: runProvenance,
        })
      }
      try {
        assembledMessages = messageSnapshot(assemblyResult.result.messages)
      } catch (error) {
        return failed("UNTRUSTED_ASSEMBLY", "assembly", errorMessage(error), { provenance: runProvenance })
      }
    } else {
      const preDispatchFailure = boundaryFailure("before-dispatch")
      if (preDispatchFailure) return preDispatchFailure
      assembledMessages = mainMessagesSnapshot ?? []
    }

    let messages: readonly LlmMessageDTO[]
    try {
      messages = messageSnapshot([...assembledMessages, ...inputBindingsSnapshot])
    } catch (error) {
      return failed("UNTRUSTED_PAYLOAD", "input", errorMessage(error), { provenance: runProvenance })
    }
    const beforeDispatchFailure = boundaryFailure("before-dispatch")
    if (beforeDispatchFailure) return beforeDispatchFailure

    const quietInput: QuietTrackedRequestDTO = {
      messages: messages as LlmMessageDTO[],
      dispatch: makeDispatch(input.dispatchSource, descriptor, input.expectedDispatchRevision),
      deadlineAt: runDeadlineAt,
      signal,
      ...(context.prefillCarrier.state === "available"
        ? {
            continuation: {
              parentPrefill: context.prefillCarrier,
              mode: "append-parent-carrier-last" as const,
            },
          }
        : {}),
    }

    let quietResult: QuietTrackedResultDTO
    try {
      const completed = await runCancellation.completion(
        Promise.resolve().then(() => deps.quietTracked(quietInput)),
      )
      if (!completed.accepted) {
        return cancellation(
          runDeadlineAt,
          completed.reason === "deadline" || completed.reason === "child-timeout",
          { provenance: runProvenance },
        )
      }
      quietResult = completed.value
    } catch (error) {
      const stop = cancelled()
      if (stop) return stop
      const postFailure = boundaryFailure("after-dispatch")
      if (postFailure) return postFailure
      return failed(isAbortLike(error) ? "DISPATCH_ABORTED" : "PROVIDER_CALL_FAILED", "provider", errorMessage(error), {
        provenance: runProvenance,
      })
    }

    const postDispatchFailure = boundaryFailure("after-dispatch")
    if (postDispatchFailure) return postDispatchFailure
    if (!validQuietResult(quietResult)) {
      return failed("UNTRUSTED_RESULT", "dispatch", "Tracked dispatch returned an invalid result", { provenance: runProvenance })
    }

    if (!quietResult.ok) {
      const receipt = quietResult.receipt === null
        ? undefined
        : receiptMatches(quietResult.receipt, boundInput)
          ? cloneAndFreeze(quietResult.receipt)
          : undefined
      if (quietResult.receipt !== null && receipt === undefined) {
        return failed("UNTRUSTED_RECEIPT", "dispatch", "Tracked dispatch receipt did not preserve source provenance", {
          provenance: runProvenance,
        })
      }
      if (quietResult.error.kind === "abort") {
        const stop = cancelled()
        if (stop) return stop
        return cancellation(runDeadlineAt, false, {
          ...(receipt ? { receipt } : {}),
          provenance: runProvenance,
        })
      }
      return failed(
        quietResult.error.code,
        quietResult.error.kind === "provider" ? "provider" : "dispatch",
        quietResult.error.message,
        {
          ...(receipt ? { receipt } : {}),
          ...(receipt ? { provenance: runProvenance } : {}),
        },
      )
    }

    if (!receiptMatches(quietResult.receipt, boundInput, true)) {
      return failed("UNTRUSTED_RECEIPT", "dispatch", "Tracked dispatch receipt did not preserve source provenance", {
        provenance: runProvenance,
      })
    }
    let receipt: QuietDispatchReceiptDTO
    let response: GenerationResponseDTO
    try {
      receipt = cloneAndFreeze(quietResult.receipt)
      response = cloneAndFreeze(quietResult.response)
    } catch (error) {
      return failed("UNTRUSTED_RESULT", "dispatch", errorMessage(error), { provenance: runProvenance })
    }
    const result: AuxiliaryRunSuccess = {
      kind: "success",
      messages,
      content: response.content,
      ...(response.reasoning !== undefined ? { reasoning: response.reasoning } : {}),
      response,
      receipt,
      provenance: runProvenance,
    }
    const committed = runCancellation.tryCommit(() => Object.freeze(result))
    if (!committed.accepted) {
      return cancellation(
        runDeadlineAt,
        committed.reason === "deadline" || committed.reason === "child-timeout",
        { provenance: runProvenance },
      )
    }
    return committed.value
  } finally {
    if (parentSignalAttached) input.parentSignal.removeEventListener("abort", onParentAbort)
    runCancellation.dispose()
    cancellationTree.dispose()
  }
}
