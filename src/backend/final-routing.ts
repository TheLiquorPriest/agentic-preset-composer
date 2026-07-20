import type { FinalResponseDTO } from "lumiverse-spindle-types"
import type {
  ApcFinalResponseV1,
  ApcMode,
  ApcPresetConfigV1,
} from "../config/schema"
import { MAX_THREAD_OUTPUT_BYTES, utf8Bytes } from "../config/limits"
import {
  composeMainGuidance,
  emptyMainGuidance,
  finalRouteForMode,
  type MainGuidanceComposition,
  type SettledThreadOutput,
} from "./guidance"
import type { OutcomeClass, OutcomeSnapshot } from "../runtime/outcome"

export type FinalRoutingFallbackReason =
  | "single-mode"
  | "mode-ineligible"
  | "final-route-main"
  | "final-route-mismatch"
  | "terminal-outcome-ineligible"
  | "stopped"
  | "final-response-permission-missing"
  | "fallback-unavailable"
  | "run-unavailable"
  | "run-failed"
  | "candidate-invalid"
  | "candidate-too-large"
  | "candidate-tool-calls"
  | "guidance-failed"
  | "host-normalization-failed"

export type MainFallbackState =
  | "available"
  | "unavailable"
  | "valid"
  | Readonly<{
      readonly status?: string
      readonly available?: boolean
      readonly valid?: boolean
      readonly reason?: string
    }>

export interface FinalRouteProvenance {
  readonly source: "main" | "thread"
  readonly runId?: string
  readonly threadId?: string
  readonly terminalOutcome: string
  readonly permissionGranted: boolean
  readonly fallbackMessageIndex: number | null
}

export interface FinalResponseNormalizationContext {
  readonly fallbackMessageIndex: number
  readonly fallbackState: MainFallbackState
  readonly provenance: FinalRouteProvenance
}

export interface FinalRoutingInput {
  readonly mode: ApcMode
  readonly config: ApcPresetConfigV1
  readonly finalResponse: ApcFinalResponseV1
  readonly settledRuns: readonly SettledThreadOutput[]
  /** Host-provided index for its already-authenticated Main fallback carrier. */
  readonly fallbackMessageIndex: number
  /** Opaque host state proving that the fallback carrier is still usable. */
  readonly fallbackState: MainFallbackState
  readonly terminalOutcome: OutcomeClass | OutcomeSnapshot | string
  readonly hasFinalResponsePermission: boolean
  readonly stopped?: boolean
  /**
   * Optional host adapter. PR #249 does not expose one publicly; when absent
   * this module returns the raw DTO and the host performs normalization.
   */
  readonly normalizeFinalResponse?: (
    candidate: FinalResponseDTO,
    context: FinalResponseNormalizationContext,
  ) => FinalResponseDTO | undefined
}

export interface FinalRoutingBaseResult {
  readonly selected: FinalResponseDTO | undefined
  readonly provenance: FinalRouteProvenance
  readonly fallbackReason: FinalRoutingFallbackReason | undefined
  readonly guidance: MainGuidanceComposition
}

export interface MainFinalRoutingResult extends FinalRoutingBaseResult {
  readonly kind: "main"
  readonly route: "main"
  readonly selected: undefined
}

export interface ThreadFinalRoutingResult extends FinalRoutingBaseResult {
  readonly kind: "thread"
  readonly route: "thread"
  readonly selected: FinalResponseDTO
}

export interface FallbackFinalRoutingResult extends FinalRoutingBaseResult {
  readonly kind: "fallback"
  readonly route: "main"
  readonly selected: undefined
}

export type FinalRoutingResult =
  | MainFinalRoutingResult
  | ThreadFinalRoutingResult
  | FallbackFinalRoutingResult

function freeze<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value)
}

function outcomeClass(value: OutcomeClass | OutcomeSnapshot | string): string {
  if (typeof value === "string") return value
  return value.class
}

function terminalRouteAllowed(value: OutcomeClass | OutcomeSnapshot | string): boolean {
  if (typeof value === "string") {
    return value === "success" || value === "optional-local"
  }
  if (value === null || typeof value !== "object") return false
  return (
    (value.class === "success" || value.class === "optional-local") &&
    value.cause?.class === value.class
  )
}

function fallbackAvailable(state: MainFallbackState): boolean {
  if (state === "available" || state === "valid") return true
  if (state === "unavailable") return false
  if (state.available === true || state.valid === true) return true
  return state.status === "available" || state.status === "valid"
}

function validFallbackIndex(index: number): boolean {
  return Number.isSafeInteger(index) && index >= 0
}

function successfulStatus(run: SettledThreadOutput): boolean {
  return run.status === "success" || run.status === "fulfilled"
}

function toolCallsPresent(run: SettledThreadOutput): boolean {
  const candidates = [
    run.toolCalls,
    run.tool_calls,
    run.response?.toolCalls,
    run.response?.tool_calls,
    run.output?.toolCalls,
    run.output?.tool_calls,
  ]
  for (const value of candidates) {
    if (value === undefined) continue
    if (!Array.isArray(value) || value.length > 0) return true
  }
  return false
}

function runContent(run: SettledThreadOutput): string | undefined {
  const content = run.content ?? run.response?.content ?? run.output?.content
  return typeof content === "string" && content.trim().length > 0 ? content : undefined
}

function runReasoning(run: SettledThreadOutput): unknown {
  return run.reasoning ?? run.response?.reasoning ?? run.output?.reasoning
}

function runMap(
  runs: readonly SettledThreadOutput[],
): { readonly runs: ReadonlyMap<string, SettledThreadOutput>; readonly duplicate?: string } {
  const indexed = new Map<string, SettledThreadOutput>()
  for (const run of runs) {
    if (
      run === null ||
      typeof run !== "object" ||
      typeof run.runId !== "string" ||
      run.runId.length === 0
    ) return { runs: indexed, duplicate: "<invalid>" }
    if (indexed.has(run.runId)) return { runs: indexed, duplicate: run.runId }
    indexed.set(run.runId, run)
  }
  return { runs: indexed }
}

function configuredThreadRun(
  config: ApcPresetConfigV1,
  mode: ApcMode,
  route: ApcFinalResponseV1,
): Readonly<{ threadId: string; required: boolean }> | undefined {
  if (route.source !== "thread") return undefined
  const configured = finalRouteForMode(config, mode)
  if (configured?.source !== "thread" || configured.runId !== route.runId) return undefined
  const pipeline = mode === "sequential" ? config.pipelines.sequential : config.pipelines.parallel
  const configuredRun = pipeline?.stages
    .flatMap((stage) => stage.runs)
    .find((run) => run.id === route.runId)
  if (configuredRun === undefined) return undefined
  return { threadId: configuredRun.threadId, required: configuredRun.required }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function normalizedCandidate(
  value: unknown,
  fallbackMessageIndex: number,
): FinalResponseDTO | undefined {
  if (!isPlainRecord(value)) return undefined
  for (const key of Reflect.ownKeys(value)) {
    if (
      typeof key !== "string" ||
      (key !== "content" && key !== "reasoning" && key !== "fallbackMessageIndex")
    ) return undefined
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !("value" in descriptor)) return undefined
  }
  const content = value.content
  if (
    typeof content !== "string" ||
    content.trim().length === 0 ||
    utf8Bytes(content) > MAX_THREAD_OUTPUT_BYTES
  ) return undefined
  const reasoning = value.reasoning
  if (reasoning !== undefined && typeof reasoning !== "string") return undefined
  if (reasoning !== undefined && utf8Bytes(reasoning) > MAX_THREAD_OUTPUT_BYTES) return undefined
  if (value.fallbackMessageIndex !== fallbackMessageIndex) return undefined
  return freeze({
    content,
    ...(reasoning === undefined ? {} : { reasoning }),
    fallbackMessageIndex,
  })
}

function configuredRouteMatches(
  config: ApcPresetConfigV1,
  mode: ApcMode,
  route: ApcFinalResponseV1,
): boolean {
  const configured = finalRouteForMode(config, mode)
  if (configured === undefined) return false
  if (route.source === "thread") {
    if (configured.source !== "thread") return false
    return configured.runId === route.runId
  }
  if (configured.source !== "main") return false
  if (configured.inputs.length !== route.inputs.length) return false
  return !route.inputs.some((input, index) => {
    const configuredInput = configured.inputs[index]
    return (
      input.source !== "output" ||
      configuredInput?.source !== input.source ||
      configuredInput?.runId !== input.runId ||
      configuredInput?.onMissing !== input.onMissing
    )
  })
}

function immutableProvenance(input: FinalRoutingInput, source: "main" | "thread", run?: SettledThreadOutput): FinalRouteProvenance {
  return freeze({
    source,
    ...(run?.runId === undefined ? {} : { runId: run.runId }),
    ...(run?.threadId === undefined ? {} : { threadId: run.threadId }),
    terminalOutcome: outcomeClass(input.terminalOutcome),
    permissionGranted: input.hasFinalResponsePermission,
    fallbackMessageIndex: validFallbackIndex(input.fallbackMessageIndex)
      ? input.fallbackMessageIndex
      : null,
  })
}

function fallbackResult(
  input: FinalRoutingInput,
  reason: FinalRoutingFallbackReason,
  guidance: MainGuidanceComposition,
  source: "main" | "thread" = "main",
  run?: SettledThreadOutput,
): FallbackFinalRoutingResult {
  return freeze({
    kind: "fallback",
    route: "main",
    selected: undefined,
    provenance: immutableProvenance(input, source, run),
    fallbackReason: reason,
    guidance,
  })
}

function mainResult(
  input: FinalRoutingInput,
  guidance: MainGuidanceComposition,
): MainFinalRoutingResult {
  return freeze({
    kind: "main",
    route: "main",
    selected: undefined,
    provenance: immutableProvenance(input, "main"),
    fallbackReason: undefined,
    guidance,
  })
}

function candidateForRun(
  run: SettledThreadOutput,
  expectedThreadId: string,
  fallbackMessageIndex: number,
): { candidate?: FinalResponseDTO; reason?: FinalRoutingFallbackReason } {
  if (!successfulStatus(run)) return { reason: "run-failed" }
  if (run.threadId !== expectedThreadId) return { reason: "candidate-invalid" }
  if (toolCallsPresent(run)) return { reason: "candidate-tool-calls" }
  const content = runContent(run)
  if (content === undefined) return { reason: "candidate-invalid" }
  if (utf8Bytes(content) > MAX_THREAD_OUTPUT_BYTES) return { reason: "candidate-too-large" }
  const reasoning = runReasoning(run)
  if (reasoning !== undefined && typeof reasoning !== "string") return { reason: "candidate-invalid" }
  if (typeof reasoning === "string" && utf8Bytes(reasoning) > MAX_THREAD_OUTPUT_BYTES) {
    return { reason: "candidate-too-large" }
  }
  const candidate = normalizedCandidate({
    content,
    ...(reasoning === undefined ? {} : { reasoning }),
    fallbackMessageIndex,
  }, fallbackMessageIndex)
  return candidate === undefined
    ? { reason: "candidate-invalid" }
    : { candidate }
}

/**
 * Selects a thread candidate without taking over host finalization. The host
 * still authenticates the fallback carrier, applies post-processing, checks
 * permissions again, and decides whether the DTO replaces the Main response.
 */
export function routeFinalResponse(input: FinalRoutingInput): FinalRoutingResult {
  const mode = input.mode
  const route = input.finalResponse
  const noGuidance = emptyMainGuidance(mode)

  if (mode === "single") return fallbackResult(input, "single-mode", noGuidance)
  if (mode !== input.config.activeMode || !input.config.supportedModes.includes(mode)) {
    return fallbackResult(input, "mode-ineligible", noGuidance)
  }
  if (!configuredRouteMatches(input.config, mode, route)) {
    return fallbackResult(input, "final-route-mismatch", noGuidance)
  }

  if (route.source === "main") {
    if (input.stopped === true) return fallbackResult(input, "stopped", noGuidance)
    if (!terminalRouteAllowed(input.terminalOutcome)) {
      return fallbackResult(input, "terminal-outcome-ineligible", noGuidance)
    }
    const guidance = composeMainGuidance(input.config, input.settledRuns)
    if (guidance.failure !== undefined) return fallbackResult(input, "guidance-failed", guidance)
    return mainResult(input, guidance)
  }

  if (input.stopped === true) return fallbackResult(input, "stopped", noGuidance)
  if (!terminalRouteAllowed(input.terminalOutcome)) {
    return fallbackResult(input, "terminal-outcome-ineligible", noGuidance)
  }
  if (input.hasFinalResponsePermission !== true) {
    return fallbackResult(input, "final-response-permission-missing", noGuidance)
  }
  if (!validFallbackIndex(input.fallbackMessageIndex) || !fallbackAvailable(input.fallbackState)) {
    return fallbackResult(input, "fallback-unavailable", noGuidance)
  }

  const configuredRun = configuredThreadRun(input.config, mode, route)
  if (configuredRun === undefined || configuredRun.required !== true) {
    return fallbackResult(input, "final-route-mismatch", noGuidance)
  }
  const indexed = runMap(input.settledRuns)
  if (indexed.duplicate !== undefined) return fallbackResult(input, "run-unavailable", noGuidance)
  const run = indexed.runs.get(route.runId)
  if (run === undefined) return fallbackResult(input, "run-unavailable", noGuidance)

  const candidateResult = candidateForRun(run, configuredRun.threadId, input.fallbackMessageIndex)
  if (!candidateResult.candidate) {
    return fallbackResult(input, candidateResult.reason ?? "candidate-invalid", noGuidance, "thread", run)
  }
  const provenance = immutableProvenance(input, "thread", run)
  let candidate = candidateResult.candidate
  if (input.normalizeFinalResponse) {
    try {
      const normalized = input.normalizeFinalResponse(candidate, {
        fallbackMessageIndex: input.fallbackMessageIndex,
        fallbackState: input.fallbackState,
        provenance,
      })
      const validated = normalizedCandidate(normalized, input.fallbackMessageIndex)
      if (validated === undefined) {
        return fallbackResult(input, "host-normalization-failed", noGuidance, "thread", run)
      }
      candidate = validated
    } catch {
      return fallbackResult(input, "host-normalization-failed", noGuidance, "thread", run)
    }
  }

  return freeze({
    kind: "thread",
    route: "thread",
    selected: candidate,
    provenance,
    fallbackReason: undefined,
    guidance: noGuidance,
  })
}

export function isThreadFinalRoutingResult(
  result: FinalRoutingResult,
): result is ThreadFinalRoutingResult {
  return result.kind === "thread" && result.selected !== undefined
}

export function isMainFinalRoutingResult(
  result: FinalRoutingResult,
): result is MainFinalRoutingResult {
  return result.kind === "main"
}
