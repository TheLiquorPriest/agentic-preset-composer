// @ts-ignore Bun provides the test module at runtime; the extension bundle excludes this file.
import { describe, expect, test } from "bun:test"
import type {
  ApcPipelineV1,
  ApcPresetConfigV1,
  ApcRunV1,
  ApcStageV1,
  ApcThreadV1,
} from "./schema"
import { createDefaultApcConfig } from "./schema"
import {
  MAX_BINDINGS_PER_RUN,
  MAX_BLOCKS_PER_THREAD,
  MAX_BLOCK_CONTENT_BYTES,
  MAX_CONFIG_BYTES,
  MAX_CONNECTION_SLOTS,
  MAX_DESCRIPTION_BYTES,
  MAX_FINAL_INPUTS,
  MAX_LITERAL_BYTES,
  MAX_NAME_CHARS,
  MAX_PARALLEL_WIDTH,
  MAX_RUNS_PER_PIPELINE,
  MAX_STAGES_PER_PIPELINE,
  MAX_THREADS,
  MAX_RUN_TIMEOUT_MS,
  MIN_RUN_TIMEOUT_MS,
} from "./limits"
import { deriveModeAvailability, validateConfigForMode } from "./validate"

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`
}

function thread(index: number): ApcThreadV1 {
  return {
    id: uuid(index),
    name: `Thread ${index}`,
    description: "",
    workspaceSource: "native-blocks",
    blocks: [],
    promptVariableValues: {},
    output: { id: "final", name: "Final Response" },
  }
}

function run(index: number, threadIndex: number, required = true, inputs: ApcRunV1["inputs"] = []): ApcRunV1 {
  return {
    id: uuid(100 + index),
    threadId: uuid(threadIndex),
    required,
    timeoutMs: 60_000,
    inputs,
  }
}

function stage(index: number, runs: ApcRunV1[]): ApcStageV1 {
  return { id: uuid(200 + index), name: `Stage ${index}`, runs }
}

function pipeline(stages: ApcStageV1[], finalResponse: ApcPipelineV1["finalResponse"]): ApcPipelineV1 {
  return { id: uuid(300), stages, finalResponse }
}

function configFor(
  mode: "sequential" | "parallel",
  selectedPipeline: ApcPipelineV1,
  threads: ApcThreadV1[],
): ApcPresetConfigV1 {
  const config = createDefaultApcConfig()
  config.supportedModes = ["single", mode]
  config.activeMode = mode
  config.threads = threads
  config.pipelines = mode === "sequential" ? { sequential: selectedPipeline } : { parallel: selectedPipeline }
  return config
}

function issueCodes(config: ApcPresetConfigV1, mode: "single" | "sequential" | "parallel"): string[] {
  return validateConfigForMode(config, mode).issues.map((issue) => issue.code)
}

function hasCode(config: ApcPresetConfigV1, mode: "single" | "sequential" | "parallel", code: string): boolean {
  return issueCodes(config, mode).includes(code)
}

function sequentialValidConfig(): ApcPresetConfigV1 {
  const first = run(1, 1)
  const second = run(2, 2, true, [{ source: "output", runId: first.id, role: "user", onMissing: "fail-graph" }])
  return configFor(
    "sequential",
    pipeline(
      [stage(1, [first]), stage(2, [second])],
      { source: "main", inputs: [{ source: "output", runId: second.id, onMissing: "fail-graph" }] },
    ),
    [thread(1), thread(2)],
  )
}

function parallelValidConfig(): ApcPresetConfigV1 {
  const left = run(1, 1)
  const right = run(2, 2)
  const final = run(3, 3, true, [
    { source: "output", runId: left.id, role: "assistant", onMissing: "fail-graph" },
    { source: "output", runId: right.id, role: "assistant", onMissing: "fail-graph" },
  ])
  return configFor(
    "parallel",
    pipeline(
      [stage(1, [left, right]), stage(2, [final])],
      { source: "thread", runId: final.id },
    ),
    [thread(1), thread(2), thread(3)],
  )
}

describe("APC graph validation", () => {
  test("accepts Single without a pipeline", () => {
    const config = createDefaultApcConfig()
    const result = validateConfigForMode(config, "single")
    expect(result.valid).toBe(true)
    expect(result.reachableRunIds.size).toBe(0)
  })

  test("accepts valid Sequential and Parallel graphs", () => {
    const sequential = validateConfigForMode(sequentialValidConfig(), "sequential")
    expect(sequential.valid).toBe(true)
    expect([...sequential.reachableRunIds]).toEqual([uuid(102), uuid(101)])

    const parallel = validateConfigForMode(parallelValidConfig(), "parallel")
    expect(parallel.valid).toBe(true)
    expect(parallel.reachableRunIds).toEqual(new Set([uuid(103), uuid(101), uuid(102)]))
  })

  test("keeps malformed inactive pipelines from disabling Single", () => {
    const config = createDefaultApcConfig()
    config.supportedModes = ["single", "sequential"]
    config.pipelines = { sequential: { id: "bad", stages: [], finalResponse: { source: "main", inputs: [] } } }
    expect(validateConfigForMode(config, "single").valid).toBe(true)
    const availability = deriveModeAvailability(config)
    expect(availability.single).toMatchObject({ supported: true, valid: true })
    expect(availability.sequential.supported).toBe(true)
    expect(availability.sequential.valid).toBe(false)
  })

  test("requires Single and closes the active mode", () => {
    const config = createDefaultApcConfig()
    config.supportedModes = ["parallel"]
    config.activeMode = "sequential"
    const result = validateConfigForMode(config, "single")
    expect(result.valid).toBe(false)
    expect(issueCodes(config, "single")).toContain("ACTIVE_MODE_UNSUPPORTED")
    expect(issueCodes(config, "single")).toContain("SINGLE_REQUIRED")
  })

  test("enforces Sequential cardinality, Parallel width, and stage thread uniqueness", () => {
    const sequential = sequentialValidConfig()
    const firstStage = sequential.pipelines.sequential?.stages[0]
    if (!firstStage) throw new Error("fixture stage missing")
    firstStage.runs.push(run(4, 4))
    expect(hasCode(sequential, "sequential", "SEQUENTIAL_RUN_COUNT")).toBe(true)

    const parallel = parallelValidConfig()
    const parallelStage = parallel.pipelines.parallel?.stages[0]
    if (!parallelStage) throw new Error("fixture stage missing")
    parallelStage.runs.push(run(4, 1), run(5, 1), run(6, 1))
    expect(hasCode(parallel, "parallel", "PARALLEL_WIDTH")).toBe(true)
    expect(hasCode(parallel, "parallel", "THREAD_DUPLICATE_STAGE")).toBe(true)
  })

  test("requires nonempty bounded stages and run collections", () => {
    const config = sequentialValidConfig()
    const pipelineValue = config.pipelines.sequential
    if (!pipelineValue) throw new Error("fixture pipeline missing")
    pipelineValue.stages = []
    expect(hasCode(config, "sequential", "STAGES_EMPTY")).toBe(true)

    pipelineValue.stages = [stage(1, [])]
    expect(hasCode(config, "sequential", "RUNS_EMPTY")).toBe(true)
  })

  test("rejects unknown, same-stage, and later-stage output references", () => {
    const config = sequentialValidConfig()
    const stages = config.pipelines.sequential?.stages
    if (!stages) throw new Error("fixture stages missing")
    const first = stages[0].runs[0]
    const second = stages[1].runs[0]
    second.inputs = [{ source: "output", runId: uuid(999), role: "user", onMissing: "omit-binding" }]
    expect(hasCode(config, "sequential", "RUN_REFERENCE")).toBe(true)

    second.inputs = [{ source: "output", runId: second.id, role: "user", onMissing: "omit-binding" }]
    expect(hasCode(config, "sequential", "RUN_REFERENCE_ORDER")).toBe(true)

    first.inputs = [{ source: "output", runId: first.id, role: "user", onMissing: "omit-binding" }]
    expect(hasCode(config, "sequential", "RUN_REFERENCE_ORDER")).toBe(true)
  })

  test("rejects dead runs and reports the reachable set", () => {
    const config = sequentialValidConfig()
    const stages = config.pipelines.sequential?.stages
    if (!stages) throw new Error("fixture stages missing")
    const dead = run(9, 1, false)
    stages[0].runs.push(dead)
    const result = validateConfigForMode(config, "sequential")
    expect(result.valid).toBe(false)
    expect(result.reachableRunIds.has(dead.id)).toBe(false)
    expect(hasCode(config, "sequential", "RUN_UNREACHABLE")).toBe(true)
  })

  test("enforces missing-policy precedence and required closure", () => {
    const config = sequentialValidConfig()
    const stages = config.pipelines.sequential?.stages
    if (!stages) throw new Error("fixture stages missing")
    const first = stages[0].runs[0]
    const second = stages[1].runs[0]
    first.required = false
    second.inputs = [{ source: "output", runId: first.id, role: "user", onMissing: "fail-graph" }]
    expect(hasCode(config, "sequential", "REQUIRED_CLOSURE")).toBe(true)

    first.required = true
    second.inputs = [{ source: "output", runId: first.id, role: "user", onMissing: "skip-run" }]
    expect(hasCode(config, "sequential", "SKIP_REQUIRED")).toBe(true)

    second.inputs = [{ source: "output", runId: first.id, role: "user", onMissing: "omit-binding" }]
    expect(validateConfigForMode(config, "sequential").valid).toBe(true)
  })

  test("requires a required thread-final run and validates slots and threads", () => {
    const config = parallelValidConfig()
    const pipelineValue = config.pipelines.parallel
    if (!pipelineValue || pipelineValue.finalResponse.source !== "thread") throw new Error("fixture final missing")
    pipelineValue.finalResponse.runId = uuid(999)
    expect(hasCode(config, "parallel", "RUN_REFERENCE")).toBe(true)

    pipelineValue.finalResponse.runId = pipelineValue.stages[1].runs[0].id
    pipelineValue.stages[1].runs[0].required = false
    expect(hasCode(config, "parallel", "FINAL_RUN_REQUIRED")).toBe(true)

    pipelineValue.stages[1].runs[0].required = true
    pipelineValue.stages[1].runs[0].threadId = uuid(999)
    expect(hasCode(config, "parallel", "THREAD_REFERENCE")).toBe(true)
  })

  test("enforces canonical unique IDs and connection-slot references", () => {
    const config = parallelValidConfig()
    config.threads[1].id = config.threads[0].id
    expect(hasCode(config, "parallel", "ID_DUPLICATE")).toBe(true)

    const slotConfig = parallelValidConfig()
    slotConfig.threads[0].connectionSlotId = uuid(999)
    expect(hasCode(slotConfig, "parallel", "SLOT_REFERENCE")).toBe(true)

    const malformed = parallelValidConfig()
    const malformedThreadId = "00000000-0000-4000-8000-00000000000A"
    malformed.threads[0].id = malformedThreadId
    const malformedRun = malformed.pipelines.parallel?.stages[0].runs[0]
    if (!malformedRun) throw new Error("fixture run missing")
    malformedRun.threadId = malformedThreadId
    expect(hasCode(malformed, "parallel", "ID_CANONICAL")).toBe(true)
  })

  test("accepts exact timeout boundaries and rejects cap-plus-one", () => {
    const config = sequentialValidConfig()
    const runValue = config.pipelines.sequential?.stages[0].runs[0]
    if (!runValue) throw new Error("fixture run missing")
    runValue.timeoutMs = MIN_RUN_TIMEOUT_MS
    expect(hasCode(config, "sequential", "TIMEOUT_LIMIT")).toBe(false)
    runValue.timeoutMs = MAX_RUN_TIMEOUT_MS
    expect(hasCode(config, "sequential", "TIMEOUT_LIMIT")).toBe(false)
    runValue.timeoutMs = MAX_RUN_TIMEOUT_MS + 1
    expect(hasCode(config, "sequential", "TIMEOUT_LIMIT")).toBe(true)
  })

  test("enforces exact collection and text/content caps", () => {
    const slots = createDefaultApcConfig()
    slots.connectionSlots = Array.from({ length: MAX_CONNECTION_SLOTS }, (_, index) => ({ id: uuid(index + 1), label: `Slot ${index}` }))
    expect(hasCode(slots, "single", "SLOTS_LIMIT")).toBe(false)
    slots.connectionSlots.push({ id: uuid(99), label: "Overflow" })
    expect(hasCode(slots, "single", "SLOTS_LIMIT")).toBe(true)

    const threads = createDefaultApcConfig()
    threads.threads = Array.from({ length: MAX_THREADS + 1 }, (_, index) => thread(index + 1))
    expect(hasCode(threads, "single", "THREADS_LIMIT")).toBe(true)
    const oversized = { ...createDefaultApcConfig(), extra: "x".repeat(MAX_CONFIG_BYTES) }
    expect(hasCode(oversized, "single", "CONFIG_LIMIT")).toBe(true)

    const text = createDefaultApcConfig()
    text.connectionSlots = [{ id: uuid(1), label: "x".repeat(MAX_NAME_CHARS) }]
    text.threads = [thread(2)]
    expect(hasCode(text, "single", "NAME_LIMIT")).toBe(false)
    text.connectionSlots[0].label = "x".repeat(MAX_NAME_CHARS + 1)
    expect(hasCode(text, "single", "NAME_LIMIT")).toBe(true)
    text.threads[0].description = "x".repeat(MAX_DESCRIPTION_BYTES)
    expect(hasCode(text, "single", "DESCRIPTION_LIMIT")).toBe(false)
    text.threads[0].description = "x".repeat(MAX_DESCRIPTION_BYTES + 1)
    expect(hasCode(text, "single", "DESCRIPTION_LIMIT")).toBe(true)
  })

  test("enforces block, binding, final-input, stage, run, and parallel caps", () => {
    const blockThread = thread(1)
    blockThread.blocks = Array.from({ length: MAX_BLOCKS_PER_THREAD + 1 }, (_, index) => ({
      id: `block-${index}`,
      name: `Block ${index}`,
      content: "",
      role: "system" as const,
      enabled: true,
      position: "pre_history" as const,
      depth: 0,
      marker: null,
      isLocked: false,
      color: null,
      injectionTrigger: [],
      group: null,
    }))
    const blockConfig = createDefaultApcConfig()
    blockConfig.threads = [blockThread]
    blockThread.blocks[0].content = "x".repeat(MAX_BLOCK_CONTENT_BYTES)
    expect(hasCode(blockConfig, "single", "BLOCK_CONTENT_LIMIT")).toBe(false)
    blockThread.blocks[0].content = "x".repeat(MAX_BLOCK_CONTENT_BYTES + 1)
    expect(hasCode(blockConfig, "single", "BLOCK_CONTENT_LIMIT")).toBe(true)

    const bindingConfig = sequentialValidConfig()
    const bindingRun = bindingConfig.pipelines.sequential?.stages[0].runs[0]
    if (!bindingRun) throw new Error("fixture run missing")
    bindingRun.inputs = Array.from({ length: MAX_BINDINGS_PER_RUN }, () => ({ source: "literal" as const, role: "user" as const, content: "x" }))
    expect(hasCode(bindingConfig, "sequential", "BINDINGS_LIMIT")).toBe(false)
    bindingRun.inputs.push({ source: "literal", role: "user", content: "x" })
    expect(hasCode(bindingConfig, "sequential", "BINDINGS_LIMIT")).toBe(true)

    const finalConfig = sequentialValidConfig()
    const finalRoute = finalConfig.pipelines.sequential?.finalResponse
    if (!finalRoute || finalRoute.source !== "main") throw new Error("fixture final missing")
    finalRoute.inputs = Array.from({ length: MAX_FINAL_INPUTS }, () => ({ source: "output", runId: uuid(102), onMissing: "omit-binding" as const }))
    expect(hasCode(finalConfig, "sequential", "FINAL_INPUTS_LIMIT")).toBe(false)
    finalRoute.inputs.push({ source: "output", runId: uuid(102), onMissing: "omit-binding" })
    expect(hasCode(finalConfig, "sequential", "FINAL_INPUTS_LIMIT")).toBe(true)

    const stageConfig = sequentialValidConfig()
    const stagePipeline = stageConfig.pipelines.sequential
    if (!stagePipeline) throw new Error("fixture pipeline missing")
    stagePipeline.stages = Array.from({ length: MAX_STAGES_PER_PIPELINE + 1 }, (_, index) => stage(index, [run(index + 1, 1)]))
    stagePipeline.finalResponse = { source: "thread", runId: stagePipeline.stages[0].runs[0].id }
    expect(hasCode(stageConfig, "sequential", "STAGES_LIMIT")).toBe(true)

    const widthConfig = parallelValidConfig()
    const widthStage = widthConfig.pipelines.parallel?.stages[0]
    if (!widthStage) throw new Error("fixture stage missing")
    widthStage.runs = Array.from({ length: MAX_PARALLEL_WIDTH + 1 }, (_, index) => run(index + 20, index + 1))
    expect(hasCode(widthConfig, "parallel", "PARALLEL_WIDTH")).toBe(true)

    const runsConfig = parallelValidConfig()
    const runsPipeline = runsConfig.pipelines.parallel
    if (!runsPipeline) throw new Error("fixture pipeline missing")
    runsPipeline.stages = Array.from({ length: MAX_STAGES_PER_PIPELINE }, (_, stageIndex) =>
      stage(
        stageIndex,
        stageIndex === 0
          ? [run(1, 1), run(2, 2), run(3, 3)]
          : [run(stageIndex * 2 + 2, 1), run(stageIndex * 2 + 3, 2)],
      ),
    )
    runsPipeline.finalResponse = { source: "thread", runId: runsPipeline.stages[0].runs[0].id }
    expect(hasCode(runsConfig, "parallel", "RUNS_LIMIT")).toBe(true)
    expect(MAX_RUNS_PER_PIPELINE).toBe(64)
  })

  test("sorts issues deterministically by encoded path and code", () => {
    const config = sequentialValidConfig()
    const stageValue = config.pipelines.sequential?.stages[0]
    if (!stageValue) throw new Error("fixture stage missing")
    stageValue.name = ""
    stageValue.runs[0].timeoutMs = MAX_RUN_TIMEOUT_MS + 1
    stageValue.runs[0].threadId = uuid(999)
    const issues = validateConfigForMode(config, "sequential").issues
    const keys = issues.map((issue) => {
      const encodedPath = issue.path
        .map((part) => (typeof part === "number" ? `[${part}]` : `.${part.replaceAll(".", "..")}`))
        .join("")
      return `${encodedPath}:${issue.code}`
    })
    expect(keys).toEqual([...keys].sort())
  })
})
