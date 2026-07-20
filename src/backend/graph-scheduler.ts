import type {
  ApcFinalMainInputV1,
  ApcFinalResponseV1,
  ApcInputBindingV1,
  ApcMode,
  ApcPipelineV1,
  ApcPresetConfigV1,
  ApcRunV1,
  ApcStageV1,
  ApcThreadV1,
  ApcRole,
  ApcMissingPolicy,
  ApcIssue,
} from "../config/schema"
import { MAX_PARALLEL_WIDTH } from "../config/limits"
import { validateConfigForMode } from "../config/validate"

export type PlannedStageConcurrency = "serial" | "parallel"

export interface PlannedRun {
  readonly id: string
  readonly stageIndex: number
  readonly index: number
  readonly run: Readonly<ApcRunV1>
  readonly thread: Readonly<ApcThreadV1>
}

export interface PlannedStage {
  readonly id: string
  readonly name: string
  readonly index: number
  readonly concurrency: PlannedStageConcurrency
  readonly runs: readonly PlannedRun[]
}

export interface GraphExecutionPlan {
  readonly mode: ApcMode
  readonly pipeline: Readonly<ApcPipelineV1> | null
  readonly stages: readonly PlannedStage[]
  readonly finalResponse: Readonly<ApcFinalResponseV1> | null
  readonly requiredRunIds: readonly string[]
  readonly runById: Readonly<Record<string, PlannedRun>>
}

export class GraphPlanError extends Error {
  readonly mode: ApcMode
  readonly issues: readonly ApcIssue[]

  constructor(mode: ApcMode, issues: readonly ApcIssue[]) {
    const first = issues[0]
    super(
      first
        ? `Cannot plan ${mode} APC graph: ${first.code}: ${first.message}`
        : `Cannot plan ${mode} APC graph.`,
    )
    this.name = "GraphPlanError"
    const copiedIssues = issues.map((entry) => Object.freeze({
      ...entry,
      path: Object.freeze([...entry.path]),
    })) as unknown as ApcIssue[]
    this.mode = mode
    this.issues = Object.freeze(copiedIssues)
    Object.freeze(this)
  }
}


function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => cloneValue(entry)) as T
  if (typeof value !== "object" || value === null) return value
  const source = value as Record<string, unknown>
  const copy: Record<string, unknown> = {}
  for (const key of Object.keys(source)) copy[key] = cloneValue(source[key])
  return copy as T
}

function freezeValue<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value
  for (const entry of Object.values(value as Record<string, unknown>)) freezeValue(entry)
  return Object.freeze(value)
}

function cloneAndFreeze<T>(value: T): T {
  return freezeValue(cloneValue(value))
}

function issue(
  path: readonly (string | number)[],
  code: string,
  message: string,
  mode: ApcMode,
): ApcIssue {
  return { path: [...path] as (string | number)[], code, message, mode }
}

function pipelineForMode(config: ApcPresetConfigV1, mode: ApcMode): ApcPipelineV1 | undefined {
  if (mode === "sequential") return config.pipelines.sequential
  if (mode === "parallel") return config.pipelines.parallel
  return undefined
}

function collectRequiredRunIds(pipeline: ApcPipelineV1): readonly string[] {
  const runs = pipeline.stages.flatMap((stage) => stage.runs)
  const byId = new Map(runs.map((run) => [run.id, run]))
  const required = new Set<string>()

  for (const run of runs) {
    if (run.required) required.add(run.id)
    for (const input of run.inputs) {
      if (input.source === "output" && input.onMissing === "fail-graph") required.add(input.runId)
    }
  }
  if (pipeline.finalResponse.source === "thread") {
    required.add(pipeline.finalResponse.runId)
  } else {
    for (const input of pipeline.finalResponse.inputs) {
      if (input.onMissing === "fail-graph") required.add(input.runId)
    }
  }

  let changed = true
  while (changed) {
    changed = false
    for (const runId of [...required]) {
      const run = byId.get(runId)
      if (!run) continue
      for (const input of run.inputs) {
        if (input.source !== "output" || input.onMissing !== "fail-graph") continue
        if (!required.has(input.runId)) {
          required.add(input.runId)
          changed = true
        }
      }
    }
  }

  return runs.filter((run) => required.has(run.id)).map((run) => run.id)
}

/**
 * Validates and freezes one APC execution graph. Stage and run arrays retain
 * configuration order: sequential stages are serial groups, while parallel
 * stages are concurrency-ready groups whose result order remains this order.
 */
export function planGraphExecution(
  config: ApcPresetConfigV1,
  mode: ApcMode = config.activeMode,
): GraphExecutionPlan {
  const validation = validateConfigForMode(config, mode)
  if (!validation.valid) throw new GraphPlanError(mode, validation.issues)

  if (mode === "single") {
    return cloneAndFreeze({
      mode,
      pipeline: null,
      stages: [],
      finalResponse: null,
      requiredRunIds: [],
      runById: {},
    })
  }

  const pipeline = pipelineForMode(config, mode)
  if (!pipeline) {
    throw new GraphPlanError(mode, [issue(["pipelines", mode], "PIPELINE_MISSING", "Supported mode must provide its pipeline.", mode)])
  }

  const threads = new Map(config.threads.map((thread) => [thread.id, thread]))
  const runById: Record<string, PlannedRun> = {}
  const stages: PlannedStage[] = []

  for (let stageIndex = 0; stageIndex < pipeline.stages.length; stageIndex += 1) {
    const stage: ApcStageV1 = pipeline.stages[stageIndex]
    const plannedRuns: PlannedRun[] = []
    for (let runIndex = 0; runIndex < stage.runs.length; runIndex += 1) {
      const run = stage.runs[runIndex]
      const thread = threads.get(run.threadId)
      if (!thread) {
        throw new GraphPlanError(mode, [issue(
          ["pipelines", mode, "stages", stageIndex, "runs", runIndex, "threadId"],
          "THREAD_REFERENCE",
          "Thread does not exist.",
          mode,
        )])
      }
      const plannedRun = {
        id: run.id,
        stageIndex,
        index: runIndex,
        run: cloneAndFreeze(run),
        thread: cloneAndFreeze(thread),
      }
      plannedRuns.push(plannedRun)
      runById[run.id] = plannedRun
    }
    stages.push({
      id: stage.id,
      name: stage.name,
      index: stageIndex,
      concurrency: mode === "parallel" ? "parallel" : "serial",
      runs: plannedRuns,
    })
  }

  return cloneAndFreeze({
    mode,
    pipeline,
    stages,
    finalResponse: pipeline.finalResponse,
    requiredRunIds: collectRequiredRunIds(pipeline),
    runById,
  })
}

export type SettledOutputValue = string | Readonly<{ content: string }> | null | undefined
export type SettledOutputs =
  | Readonly<Record<string, SettledOutputValue>>
  | ReadonlyMap<string, SettledOutputValue>

export interface MissingInput {
  readonly bindingIndex: number
  readonly runId: string
  readonly role: ApcRole
  readonly onMissing: ApcMissingPolicy
}

export interface ResolvedInput {
  readonly bindingIndex: number
  readonly source: "literal" | "output"
  readonly role: ApcRole
  readonly content: string
  readonly runId?: string
}

export type InputResolutionStatus = "ready" | "skip-run" | "fail-graph"

export interface InputResolution {
  readonly status: InputResolutionStatus
  readonly bindings: readonly ResolvedInput[]
  readonly missing: readonly MissingInput[]
}

function outputContent(value: SettledOutputValue): string | undefined {
  if (typeof value === "string") return value
  if (value !== null && typeof value === "object" && typeof value.content === "string") return value.content
  return undefined
}

function settledOutput(outputs: SettledOutputs, runId: string): string | undefined {
  if (outputs instanceof Map) return outputContent(outputs.get(runId))
  const record = outputs as Readonly<Record<string, SettledOutputValue>>
  if (!Object.prototype.hasOwnProperty.call(record, runId)) return undefined
  return outputContent(record[runId])
}

/** Resolves literals and earlier-run outputs without mutating the output store. */
export function resolveInputBindings(
  bindings: readonly ApcInputBindingV1[],
  settledOutputs: SettledOutputs,
): InputResolution {
  const resolved: ResolvedInput[] = []
  const missing: MissingInput[] = []

  for (let bindingIndex = 0; bindingIndex < bindings.length; bindingIndex += 1) {
    const binding = bindings[bindingIndex]
    if (binding.source === "literal") {
      resolved.push({
        bindingIndex,
        source: "literal",
        role: binding.role,
        content: binding.content,
      })
      continue
    }
    const content = settledOutput(settledOutputs, binding.runId)
    if (content === undefined) {
      missing.push({
        bindingIndex,
        runId: binding.runId,
        role: binding.role,
        onMissing: binding.onMissing,
      })
      continue
    }
    resolved.push({
      bindingIndex,
      source: "output",
      role: binding.role,
      content,
      runId: binding.runId,
    })
  }

  const status: InputResolutionStatus = missing.some((entry) => entry.onMissing === "fail-graph")
    ? "fail-graph"
    : missing.some((entry) => entry.onMissing === "skip-run")
      ? "skip-run"
      : "ready"
  return Object.freeze({
    status,
    bindings: Object.freeze(resolved),
    missing: Object.freeze(missing),
  })
}

/** Resolves one planned/configured run's input bindings. */
export function resolveRunInputs(
  run: PlannedRun | ApcRunV1,
  settledOutputs: SettledOutputs,
): InputResolution {
  const configuredRun = "run" in run ? run.run : run
  return resolveInputBindings(configuredRun.inputs, settledOutputs)
}

export interface ResolvedFinalInput {
  readonly inputIndex: number
  readonly runId: string
  readonly content: string
}

export interface FinalInputResolution {
  readonly status: "ready" | "fail-graph"
  readonly inputs: readonly ResolvedFinalInput[]
  readonly missingRunIds: readonly string[]
}

/** Resolves Main guidance inputs using the final route's fail/omit policies. */
export function resolveFinalMainInputs(
  inputs: readonly ApcFinalMainInputV1[],
  settledOutputs: SettledOutputs,
): FinalInputResolution {
  const resolved: ResolvedFinalInput[] = []
  const missing: string[] = []
  for (let inputIndex = 0; inputIndex < inputs.length; inputIndex += 1) {
    const input = inputs[inputIndex]
    const content = settledOutput(settledOutputs, input.runId)
    if (content === undefined) {
      missing.push(input.runId)
      continue
    }
    resolved.push({ inputIndex, runId: input.runId, content })
  }
  const status: FinalInputResolution["status"] = inputs.some(
    (input) => input.onMissing === "fail-graph" && missing.includes(input.runId),
  )
    ? "fail-graph"
    : "ready"
  return Object.freeze({
    status,
    inputs: Object.freeze(resolved),
    missingRunIds: Object.freeze(missing),
  })
}


/** The settled state of one deterministic graph task. */
export type GraphTaskSettlement<T> =
  | Readonly<{
      readonly runId: string
      readonly threadId: string
      readonly stageIndex: number
      readonly index: number
      readonly status: "fulfilled"
      readonly value: T
    }>
  | Readonly<{
      readonly runId: string
      readonly threadId: string
      readonly stageIndex: number
      readonly index: number
      readonly status: "rejected"
      readonly reason: unknown
    }>

export interface GraphStageSettlement<T> {
  readonly stage: PlannedStage
  readonly runs: readonly GraphTaskSettlement<T>[]
}

export interface GraphExecutionResult<T> {
  readonly mode: ApcMode
  readonly stages: readonly GraphStageSettlement<T>[]
  readonly runs: readonly GraphTaskSettlement<T>[]
  readonly outputs: ReadonlyMap<string, T>
}

export interface GraphTaskContext<T> {
  readonly stage: PlannedStage
  /** Outputs from earlier stages only; parallel siblings never race this map. */
  readonly outputs: ReadonlyMap<string, T>
}

export type GraphTaskExecutor<T> = (
  planned: PlannedRun,
  context: GraphTaskContext<T>,
) => Promise<T> | T

function frozenTaskSettlement<T>(
  planned: PlannedRun,
  settled: PromiseSettledResult<T>,
): GraphTaskSettlement<T> {
  return settled.status === "fulfilled"
    ? Object.freeze({
        runId: planned.id,
        threadId: planned.thread.id,
        stageIndex: planned.stageIndex,
        index: planned.index,
        status: "fulfilled" as const,
        value: settled.value,
      })
    : Object.freeze({
        runId: planned.id,
        threadId: planned.thread.id,
        stageIndex: planned.stageIndex,
        index: planned.index,
        status: "rejected" as const,
        reason: settled.reason,
      })
}

async function settleStage<T>(
  stage: PlannedStage,
  executor: GraphTaskExecutor<T>,
  outputs: ReadonlyMap<string, T>,
): Promise<readonly GraphTaskSettlement<T>[]> {
  const settled = new Array<PromiseSettledResult<T> | undefined>(stage.runs.length)
  let nextIndex = 0
  const workerCount = stage.concurrency === "parallel"
    ? Math.min(MAX_PARALLEL_WIDTH, stage.runs.length)
    : Math.min(1, stage.runs.length)

  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex
      nextIndex += 1
      const planned = stage.runs[index]
      if (planned === undefined) return
      try {
        const value = await executor(planned, Object.freeze({ stage, outputs }))
        settled[index] = { status: "fulfilled", value }
      } catch (reason) {
        settled[index] = { status: "rejected", reason }
      }
    }
  }

  const workers = Array.from({ length: workerCount }, () => worker())
  await Promise.allSettled(workers)
  return Object.freeze(stage.runs.map((planned, index) => {
    const result = settled[index]
    if (result === undefined) {
      return frozenTaskSettlement<T>(planned, {
        status: "rejected",
        reason: new Error("Graph task did not settle"),
      })
    }
    return frozenTaskSettlement<T>(planned, result)
  }))
}

/**
 * Executes a frozen plan without changing it or its input output map.
 * Sequential stages are serialized; parallel stages use at most the shared
 * four-run width and always return settlements in configured order.
 */
export async function executeGraphPlan<T>(
  plan: GraphExecutionPlan,
  executor: GraphTaskExecutor<T>,
): Promise<GraphExecutionResult<T>> {
  if (typeof executor !== "function") throw new TypeError("Graph task executor is required")

  const outputs = new Map<string, T>()
  const stages: GraphStageSettlement<T>[] = []
  for (const stage of plan.stages) {
    const stageOutputs = new Map(outputs)
    const runs = await settleStage(stage, executor, stageOutputs)
    stages.push(Object.freeze({ stage, runs }))
    for (const result of runs) {
      if (result.status === "fulfilled") outputs.set(result.runId, result.value)
    }
  }

  const frozenStages = Object.freeze(stages.slice())
  const runs = Object.freeze(frozenStages.flatMap((stage) => stage.runs))
  return Object.freeze({
    mode: plan.mode,
    stages: frozenStages,
    runs,
    outputs: new Map(outputs),
  })
}
