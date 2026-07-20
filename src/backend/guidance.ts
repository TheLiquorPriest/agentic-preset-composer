import type { DeferredGuidanceDTO } from "lumiverse-spindle-types"
import type {
  ApcFinalResponseV1,
  ApcMissingPolicy,
  ApcMode,
  ApcPresetConfigV1,
} from "../config/schema"
import { MAX_GUIDANCE_BYTES, MAX_THREAD_OUTPUT_BYTES } from "../config/limits"
import { serializedUtf8Bytes } from "../config/plain-json"
import {
  resolveFinalMainInputs,
  type SettledOutputs,
} from "./graph-scheduler"

export type SettledRunStatus =
  | "success"
  | "fulfilled"
  | "failed"
  | "skipped"
  | "cancelled"
  | "stopped"
  | "omitted"
  | "optional-failure"

/** The bounded output hand-off from one completed APC thread run. */
export interface SettledThreadOutput {
  readonly runId: string
  readonly threadId?: string
  readonly status?: SettledRunStatus
  readonly content?: string
  readonly reasoning?: string
  readonly response?: Readonly<{
    readonly content?: string
    readonly reasoning?: string
    readonly toolCalls?: readonly unknown[]
    readonly tool_calls?: readonly unknown[]
  }>
  readonly output?: Readonly<{
    readonly content?: string
    readonly reasoning?: string
    readonly toolCalls?: readonly unknown[]
    readonly tool_calls?: readonly unknown[]
  }>
  readonly toolCalls?: readonly unknown[]
  readonly tool_calls?: readonly unknown[]
}

export type GuidanceFailureCode =
  | "PIPELINE_MISSING"
  | "FINAL_ROUTE_NOT_MAIN"
  | "MISSING_OUTPUT"
  | "DUPLICATE_RUN"
  | "OUTPUT_INVALID"
  | "GUIDANCE_LIMIT"

export interface GuidanceFailure {
  readonly code: GuidanceFailureCode
  readonly runId?: string
  readonly policy?: ApcMissingPolicy
  readonly detail: string
}

export interface GuidanceBindingResolution {
  readonly runId: string
  readonly policy: ApcMissingPolicy
  readonly status: "included" | "omitted"
  readonly guidanceId?: string
}

export interface MainGuidanceComposition {
  readonly mode: ApcMode
  readonly applied: boolean
  readonly entries: readonly DeferredGuidanceDTO[]
  /** Alias used by the interceptor result builder. */
  readonly deferredGuidance: readonly DeferredGuidanceDTO[]
  readonly bindings: readonly GuidanceBindingResolution[]
  readonly failure?: GuidanceFailure
}

const EMPTY_ENTRIES: readonly DeferredGuidanceDTO[] = Object.freeze([])
const EMPTY_BINDINGS: readonly GuidanceBindingResolution[] = Object.freeze([])
const TEXT_ENCODER = new TextEncoder()

function freeze<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value)
}

function utf8Bytes(value: string): number {
  return TEXT_ENCODER.encode(value).byteLength
}
function hasToolCalls(run: SettledThreadOutput): boolean {
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

function newGuidanceId(): string {
  const randomUUID = globalThis.crypto?.randomUUID
  if (typeof randomUUID !== "function") {
    throw new Error("APC guidance requires host crypto.randomUUID")
  }
  return randomUUID.call(globalThis.crypto)
}

function escapeWrapperLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("]", "\\]")
}

function pipelineForMode(
  config: ApcPresetConfigV1,
  mode: Exclude<ApcMode, "single">,
) {
  return mode === "sequential" ? config.pipelines.sequential : config.pipelines.parallel
}

function outputContent(run: SettledThreadOutput): string | undefined {
  if (run.status !== undefined && run.status !== "success" && run.status !== "fulfilled") {
    return undefined
  }
  if (hasToolCalls(run)) return undefined
  const content = run.content ?? run.response?.content ?? run.output?.content
  if (typeof content !== "string" || content.trim().length === 0) return undefined
  if (utf8Bytes(content) > MAX_THREAD_OUTPUT_BYTES) return undefined
  return content
}

function outputName(config: ApcPresetConfigV1, threadId: string): string {
  const thread = config.threads.find((candidate) => candidate.id === threadId)
  return thread?.output.name ?? "Final Response"
}

function threadName(config: ApcPresetConfigV1, threadId: string): string {
  return config.threads.find((candidate) => candidate.id === threadId)?.name ?? threadId
}

function noGuidance(
  mode: ApcMode,
  failure?: GuidanceFailure,
): MainGuidanceComposition {
  const frozenFailure = failure === undefined ? undefined : freeze({ ...failure })
  return freeze({
    mode,
    applied: false,
    entries: EMPTY_ENTRIES,
    deferredGuidance: EMPTY_ENTRIES,
    bindings: EMPTY_BINDINGS,
    ...(frozenFailure === undefined ? {} : { failure: frozenFailure }),
  })
}

export function emptyMainGuidance(mode: ApcMode): MainGuidanceComposition {
  return noGuidance(mode)
}

function runMap(
  settledRuns: readonly SettledThreadOutput[],
): { readonly runs: ReadonlyMap<string, SettledThreadOutput>; readonly duplicate?: string } {
  const runs = new Map<string, SettledThreadOutput>()
  let duplicate: string | undefined
  for (const run of settledRuns) {
    if (typeof run.runId !== "string" || run.runId.length === 0) {
      duplicate = "<invalid>"
      continue
    }
    if (runs.has(run.runId)) {
      if (duplicate === undefined || (duplicate !== "<invalid>" && run.runId < duplicate)) duplicate = run.runId
      continue
    }
    runs.set(run.runId, run)
  }
  return duplicate === undefined ? { runs } : { runs, duplicate }
}

/**
 * Compose only the configured output bindings for a Main final route.
 *
 * The returned entries are deferred guidance DTOs. They are intentionally not
 * inserted into the callback's message array: the host owns terminal placement
 * immediately before its authenticated prefill carrier.
 */
export function composeMainGuidance(
  config: ApcPresetConfigV1,
  settledRuns: readonly SettledThreadOutput[],
): MainGuidanceComposition {
  const mode = config.activeMode
  if (mode === "single") return noGuidance(mode)

  const pipeline = pipelineForMode(config, mode)
  if (!pipeline) {
    return noGuidance(mode, {
      code: "PIPELINE_MISSING",
      detail: `No ${mode} pipeline is available for the active mode.`,
    })
  }
  if (pipeline.finalResponse.source !== "main") {
    return noGuidance(mode)
  }

  const indexed = runMap(settledRuns)
  if (indexed.duplicate !== undefined) {
    return noGuidance(mode, {
      code: "DUPLICATE_RUN",
      runId: indexed.duplicate,
      detail: "Settled outputs contain a duplicate run identifier.",
    })
  }

  const settledOutputs: SettledOutputs = new Map(
    settledRuns.map((run) => [run.runId, outputContent(run)] as const),
  )
  const resolution = resolveFinalMainInputs(pipeline.finalResponse.inputs, settledOutputs)
  const bindings: GuidanceBindingResolution[] = []
  const entries: DeferredGuidanceDTO[] = []
  const resolvedByIndex = new Map(resolution.inputs.map((input) => [input.inputIndex, input] as const))

  if (resolution.status === "fail-graph") {
    const missingInput = pipeline.finalResponse.inputs.find(
      (input) => input.onMissing === "fail-graph" && resolution.missingRunIds.includes(input.runId),
    )
    const missingRunId = missingInput?.runId ?? resolution.missingRunIds[0] ?? "<unknown>"
    return freeze({
      mode,
      applied: false,
      entries: EMPTY_ENTRIES,
      deferredGuidance: EMPTY_ENTRIES,
      bindings: Object.freeze(pipeline.finalResponse.inputs.map((input) => freeze({
        runId: input.runId,
        policy: input.onMissing,
        status: "omitted" as const,
      }))),
      failure: freeze({
        code: "MISSING_OUTPUT" as const,
        runId: missingRunId,
        ...(missingInput === undefined ? {} : { policy: missingInput.onMissing }),
        detail: `Final Main guidance output ${missingRunId} is unavailable.`,
      }),
    })
  }

  let failure: GuidanceFailure | undefined
  for (let inputIndex = 0; inputIndex < pipeline.finalResponse.inputs.length; inputIndex += 1) {
    const input = pipeline.finalResponse.inputs[inputIndex]
    const resolved = resolvedByIndex.get(inputIndex)
    if (resolved === undefined) {
      bindings.push(freeze({ runId: input.runId, policy: input.onMissing, status: "omitted" }))
      continue
    }

    const run = indexed.runs.get(resolved.runId)
    const threadId = run?.threadId ?? pipeline.stages
      .flatMap((stage) => stage.runs)
      .find((candidate) => candidate.id === resolved.runId)?.threadId
    if (!run || !threadId) {
      if (failure === undefined) {
        failure = {
          code: "OUTPUT_INVALID",
          runId: resolved.runId,
          policy: input.onMissing,
          detail: `Final Main guidance output ${resolved.runId} has no thread provenance.`,
        }
      }
      bindings.push(freeze({ runId: input.runId, policy: input.onMissing, status: "omitted" }))
      continue
    }

    const threadLabel = escapeWrapperLabel(threadName(config, threadId))
    const outputLabel = escapeWrapperLabel(outputName(config, threadId))
    const runLabel = escapeWrapperLabel(resolved.runId)
    const guidanceContent = `[APC Output: ${threadLabel} / ${outputLabel} / Run ${runLabel}]\n${resolved.content}`
    if (utf8Bytes(guidanceContent) > MAX_GUIDANCE_BYTES) {
      if (failure === undefined) {
        failure = {
          code: "GUIDANCE_LIMIT",
          runId: resolved.runId,
          policy: input.onMissing,
          detail: `Final Main guidance output ${resolved.runId} exceeds the guidance limit.`,
        }
      }
      bindings.push(freeze({ runId: input.runId, policy: input.onMissing, status: "omitted" }))
      continue
    }

    let id: string
    try {
      id = newGuidanceId()
    } catch (error) {
      if (failure === undefined) {
        failure = {
          code: "OUTPUT_INVALID",
          runId: resolved.runId,
          policy: input.onMissing,
          detail: error instanceof Error ? error.message : String(error),
        }
      }
      bindings.push(freeze({ runId: input.runId, policy: input.onMissing, status: "omitted" }))
      continue
    }
    entries.push(freeze({ id, content: guidanceContent, role: "system" }))
    bindings.push(freeze({ runId: input.runId, policy: input.onMissing, status: "included", guidanceId: id }))
  }

  if (failure !== undefined) {
    return freeze({
      mode,
      applied: false,
      entries: EMPTY_ENTRIES,
      deferredGuidance: EMPTY_ENTRIES,
      bindings: Object.freeze(bindings),
      failure: freeze(failure),
    })
  }

  const frozenEntries = Object.freeze(entries)
  const aggregateSize = serializedUtf8Bytes(frozenEntries)
  if (!aggregateSize.ok || aggregateSize.bytes > MAX_GUIDANCE_BYTES) {
    const aggregateFailure: GuidanceFailure = aggregateSize.ok
      ? {
          code: "GUIDANCE_LIMIT",
          detail: "Final Main deferred guidance aggregate exceeds the guidance limit.",
        }
      : {
          code: "OUTPUT_INVALID",
          detail: "Final Main deferred guidance aggregate could not be serialized.",
        }
    return freeze({
      mode,
      applied: false,
      entries: EMPTY_ENTRIES,
      deferredGuidance: EMPTY_ENTRIES,
      bindings: Object.freeze(bindings),
      failure: freeze(aggregateFailure),
    })
  }
  return freeze({
    mode,
    applied: frozenEntries.length > 0,
    entries: frozenEntries,
    deferredGuidance: frozenEntries,
    bindings: Object.freeze(bindings),
  })
}

export function isGuidanceFailure(
  composition: MainGuidanceComposition,
): composition is MainGuidanceComposition & { readonly failure: GuidanceFailure } {
  return composition.failure !== undefined
}

export function finalRouteForMode(
  config: ApcPresetConfigV1,
  mode: ApcMode,
): ApcFinalResponseV1 | undefined {
  if (mode === "single") return undefined
  return pipelineForMode(config, mode)?.finalResponse
}

