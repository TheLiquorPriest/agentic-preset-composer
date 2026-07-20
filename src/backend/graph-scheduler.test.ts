// @ts-ignore Bun provides the test module at runtime; the extension bundle excludes this file.
import { describe, expect, test } from "bun:test"
import type {
  ApcPipelineV1,
  ApcPresetConfigV1,
  ApcRunV1,
  ApcStageV1,
  ApcThreadV1,
} from "../config/schema"
import { createDefaultApcConfig } from "../config/schema"
import {
  GraphPlanError,
  planGraphExecution,
  resolveFinalMainInputs,
  resolveRunInputs,
} from "./graph-scheduler"

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

function run(
  index: number,
  threadIndex: number,
  required = true,
  inputs: ApcRunV1["inputs"] = [],
): ApcRunV1 {
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

function pipeline(
  stages: ApcStageV1[],
  finalResponse: ApcPipelineV1["finalResponse"],
): ApcPipelineV1 {
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

describe("APC graph planning", () => {
  test("Single produces an immutable bypass plan", () => {
    const config = createDefaultApcConfig()
    const plan = planGraphExecution(config)

    expect(plan.mode).toBe("single")
    expect(plan.pipeline).toBeNull()
    expect(plan.stages).toEqual([])
    expect(plan.requiredRunIds).toEqual([])
    expect(Object.isFrozen(plan)).toBe(true)
  })

  test("Sequential retains stage and run configuration order", () => {
    const first = run(1, 1)
    const second = run(2, 2, true, [
      { source: "output", runId: first.id, role: "user", onMissing: "fail-graph" },
    ])
    const config = configFor(
      "sequential",
      pipeline(
        [stage(1, [first]), stage(2, [second])],
        { source: "main", inputs: [{ source: "output", runId: second.id, onMissing: "fail-graph" }] },
      ),
      [thread(1), thread(2)],
    )

    const plan = planGraphExecution(config)
    expect(plan.stages.map((entry) => entry.id)).toEqual([uuid(201), uuid(202)])
    expect(plan.stages.every((entry) => entry.concurrency === "serial")).toBe(true)
    expect(plan.stages.flatMap((entry) => entry.runs.map((planned) => planned.id))).toEqual([
      first.id,
      second.id,
    ])
    expect(plan.requiredRunIds).toEqual([first.id, second.id])
  })

  test("Parallel exposes concurrency-ready groups in configured order", () => {
    const left = run(1, 1)
    const right = run(2, 2)
    const final = run(3, 3, true, [
      { source: "output", runId: left.id, role: "assistant", onMissing: "fail-graph" },
      { source: "output", runId: right.id, role: "assistant", onMissing: "fail-graph" },
    ])
    const config = configFor(
      "parallel",
      pipeline(
        [stage(1, [left, right]), stage(2, [final])],
        { source: "thread", runId: final.id },
      ),
      [thread(1), thread(2), thread(3)],
    )

    const plan = planGraphExecution(config)
    expect(plan.stages[0]?.concurrency).toBe("parallel")
    expect(plan.stages[0]?.runs.map((entry) => entry.id)).toEqual([left.id, right.id])
    expect(plan.stages[0]?.runs.map((entry) => entry.index)).toEqual([0, 1])
    expect(plan.requiredRunIds).toEqual([left.id, right.id, final.id])
  })

  test("Empty stages are rejected by validated planning", () => {
    const only = run(1, 1)
    const config = configFor(
      "sequential",
      pipeline([stage(1, [])], { source: "thread", runId: only.id }),
      [thread(1)],
    )

    expect(() => planGraphExecution(config)).toThrow(GraphPlanError)
    try {
      planGraphExecution(config)
    } catch (error) {
      expect(error).toBeInstanceOf(GraphPlanError)
      expect((error as GraphPlanError).issues.some((entry) => entry.code === "RUNS_EMPTY")).toBe(true)
    }
  })
  test("rejects a fail-graph edge that breaks required closure", () => {
    const optional = run(1, 1, false)
    const required = run(2, 2, true, [
      { source: "output", runId: optional.id, role: "user", onMissing: "fail-graph" },
    ])
    const config = configFor(
      "sequential",
      pipeline([stage(1, [optional]), stage(2, [required])], { source: "thread", runId: required.id }),
      [thread(1), thread(2)],
    )

    expect(() => planGraphExecution(config)).toThrow(GraphPlanError)
    try {
      planGraphExecution(config)
    } catch (error) {
      expect((error as GraphPlanError).issues.some((entry) => entry.code === "REQUIRED_CLOSURE")).toBe(true)
    }
  })
})

describe("APC input resolution", () => {
  const outputRun = uuid(901)

  test("keeps literals and surviving output bindings in config order", () => {
    const runValue: ApcRunV1 = {
      id: uuid(902),
      threadId: uuid(1),
      required: false,
      timeoutMs: 60_000,
      inputs: [
        { source: "literal", role: "system", content: "literal" },
        { source: "output", runId: outputRun, role: "assistant", onMissing: "omit-binding" },
        { source: "literal", role: "user", content: "tail" },
      ],
    }
    const resolution = resolveRunInputs(runValue, { [outputRun]: "earlier" })

    expect(resolution.status).toBe("ready")
    expect(resolution.bindings.map((entry) => entry.content)).toEqual(["literal", "earlier", "tail"])
    expect(resolution.bindings.map((entry) => entry.bindingIndex)).toEqual([0, 1, 2])
    expect(resolution.missing).toEqual([])
  })

  test("applies fail-graph before skip-run before omit-binding", () => {
    const runValue: ApcRunV1 = {
      id: uuid(903),
      threadId: uuid(1),
      required: false,
      timeoutMs: 60_000,
      inputs: [
        { source: "output", runId: uuid(910), role: "user", onMissing: "omit-binding" },
        { source: "output", runId: uuid(911), role: "user", onMissing: "skip-run" },
        { source: "output", runId: uuid(912), role: "user", onMissing: "fail-graph" },
      ],
    }

    expect(resolveRunInputs(runValue, {}).status).toBe("fail-graph")
    expect(resolveRunInputs({ ...runValue, inputs: [runValue.inputs[0], runValue.inputs[1]] }, {}).status).toBe("skip-run")
    expect(resolveRunInputs({ ...runValue, inputs: [runValue.inputs[0]] }, {}).status).toBe("ready")
  })

  test("settles output bindings by configured order even when output keys arrive reversed", () => {
    const first = uuid(920)
    const second = uuid(921)
    const runValue: ApcRunV1 = {
      id: uuid(922),
      threadId: uuid(1),
      required: true,
      timeoutMs: 60_000,
      inputs: [
        { source: "output", runId: first, role: "assistant", onMissing: "fail-graph" },
        { source: "output", runId: second, role: "assistant", onMissing: "fail-graph" },
      ],
    }
    const resolution = resolveRunInputs(runValue, {
      [second]: "second-completed-first",
      [first]: "first-completed-second",
    })

    expect(resolution.bindings.map((entry) => entry.content)).toEqual([
      "first-completed-second",
      "second-completed-first",
    ])
  })

  test("resolves final Main inputs with fail or omit policy", () => {
    const omitted = uuid(930)
    const kept = uuid(931)
    const resolution = resolveFinalMainInputs(
      [
        { source: "output", runId: omitted, onMissing: "omit-binding" },
        { source: "output", runId: kept, onMissing: "fail-graph" },
      ],
      { [kept]: "guidance" },
    )

    expect(resolution.status).toBe("ready")
    expect(resolution.inputs).toEqual([{ inputIndex: 1, runId: kept, content: "guidance" }])
    expect(resolution.missingRunIds).toEqual([omitted])
  })
})
