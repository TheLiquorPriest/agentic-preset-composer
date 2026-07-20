// @ts-ignore Bun provides the test module at runtime; the extension bundle excludes this file.
import { describe, expect, test } from "bun:test"
import type {
  ApcFinalResponseV1,
  ApcMode,
  ApcPresetConfigV1,
} from "../config/schema"
import {
  composeMainGuidance,
  type SettledThreadOutput,
} from "./guidance"
import { MAX_GUIDANCE_BYTES } from "../config/limits"
import { serializedUtf8Bytes } from "../config/plain-json"

const mainThread = {
  id: "main",
  name: "Main Thread",
  output: { id: "final", name: "Final Response" },
} as const

function config(mode: ApcMode, finalResponse: ApcFinalResponseV1): ApcPresetConfigV1 {
  return {
    schemaVersion: 1,
    supportedModes: mode === "single" ? ["single"] : ["single", mode],
    activeMode: mode,
    mainThread,
    connectionSlots: [],
    threads: [
      {
        id: "thread-a",
        name: "Analyst",
        description: "Analyst thread",
        workspaceSource: "main-context",
        blocks: [],
        promptVariableValues: {},
        output: { id: "final", name: "Final Response" },
      },
      {
        id: "thread-b",
        name: "Editor",
        description: "Editor thread",
        workspaceSource: "main-context",
        blocks: [],
        promptVariableValues: {},
        output: { id: "final", name: "Final Response" },
      },
    ],
    pipelines: mode === "sequential"
      ? {
          sequential: {
            id: "pipeline-sequential",
            stages: [
              {
                id: "stage-a",
                name: "Stage A",
                runs: [
                  { id: "run-a", threadId: "thread-a", required: true, timeoutMs: 1_000, inputs: [] },
                  { id: "run-b", threadId: "thread-b", required: false, timeoutMs: 1_000, inputs: [] },
                ],
              },
            ],
            finalResponse,
          },
        }
      : mode === "parallel"
        ? {
            parallel: {
              id: "pipeline-parallel",
              stages: [
                {
                  id: "stage-a",
                  name: "Stage A",
                  runs: [
                    { id: "run-a", threadId: "thread-a", required: true, timeoutMs: 1_000, inputs: [] },
                    { id: "run-b", threadId: "thread-b", required: true, timeoutMs: 1_000, inputs: [] },
                  ],
                },
              ],
              finalResponse,
            },
          }
        : {},
  }
}

function output(runId: string, threadId: string, content: string, status: SettledThreadOutput["status"] = "success") {
  return { runId, threadId, content, status } satisfies SettledThreadOutput
}

const AGGREGATE_ENTRY_COUNT = 32

function aggregateConfig(count: number): ApcPresetConfigV1 {
  const base = config("parallel", { source: "main", inputs: [] })
  const pipeline = base.pipelines.parallel
  if (pipeline === undefined) throw new Error("parallel test pipeline is unavailable")

  const threads = Array.from({ length: count }, (_, index) => {
    const suffix = String(index).padStart(2, "0")
    return {
      ...base.threads[0]!,
      id: `thread-${suffix}`,
      name: `Thread ${suffix}`,
    }
  })
  const runs = threads.map((thread, index) => {
    const suffix = String(index).padStart(2, "0")
    return {
      id: `run-${suffix}`,
      threadId: thread.id,
      required: true,
      timeoutMs: 1_000,
      inputs: [],
    }
  })
  const finalResponse: ApcFinalResponseV1 = {
    source: "main",
    inputs: runs.map((run) => ({
      source: "output" as const,
      runId: run.id,
      onMissing: "omit-binding" as const,
    })),
  }

  return {
    ...base,
    threads,
    pipelines: {
      parallel: {
        ...pipeline,
        stages: [{ ...pipeline.stages[0]!, runs }],
        finalResponse,
      },
    },
  }
}

function aggregateOutputs(contentLengths: readonly number[]): SettledThreadOutput[] {
  return contentLengths.map((contentLength, index) => {
    const suffix = String(index).padStart(2, "0")
    return output(`run-${suffix}`, `thread-${suffix}`, "x".repeat(contentLength))
  })
}

function outputsForAggregateTarget(
  testConfig: ApcPresetConfigV1,
  targetBytes: number,
): SettledThreadOutput[] {
  const baselineOutputs = aggregateOutputs(Array.from({ length: AGGREGATE_ENTRY_COUNT }, () => 1))
  const baseline = composeMainGuidance(testConfig, baselineOutputs)
  const baselineSize = serializedUtf8Bytes(baseline.deferredGuidance)
  if (!baselineSize.ok) throw new Error("baseline guidance did not serialize")

  const extraBytes = targetBytes - baselineSize.bytes
  if (extraBytes < 0) {
    throw new Error("aggregate target is below the baseline")
  }
  const extraPerEntry = Math.floor(extraBytes / AGGREGATE_ENTRY_COUNT)
  const remainder = extraBytes % AGGREGATE_ENTRY_COUNT
  return aggregateOutputs(Array.from(
    { length: AGGREGATE_ENTRY_COUNT },
    (_, index) => 1 + extraPerEntry + (index < remainder ? 1 : 0),
  ))
}

describe("composeMainGuidance", () => {
  test("Single yields no guidance", () => {
    const result = composeMainGuidance(
      config("single", { source: "main", inputs: [] }),
      [output("run-a", "thread-a", "should not be consumed")],
    )

    expect(result.applied).toBe(false)
    expect(result.entries).toEqual([])
    expect(result.failure).toBeUndefined()
  })

  test("uses only configured outputs in configured order", () => {
    const result = composeMainGuidance(
      config("sequential", {
        source: "main",
        inputs: [
          { source: "output", runId: "run-b", onMissing: "omit-binding" },
          { source: "output", runId: "run-a", onMissing: "fail-graph" },
        ],
      }),
      [
        output("run-a", "thread-a", "A"),
        output("unconfigured", "thread-a", "ignore me"),
        output("run-b", "thread-b", "B"),
      ],
    )

    expect(result.entries).toHaveLength(2)
    expect(result.entries[0]?.content).toContain("Editor")
    expect(result.entries[0]?.content).toContain("\nB")
    expect(result.entries[1]?.content).toContain("Analyst")
    expect(result.entries[1]?.content).toContain("\nA")
    expect(result.bindings.map((binding) => binding.status)).toEqual(["included", "included"])
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.entries)).toBe(true)
  })

  test("omit-binding keeps surviving outputs", () => {
    const result = composeMainGuidance(
      config("parallel", {
        source: "main",
        inputs: [
          { source: "output", runId: "missing", onMissing: "omit-binding" },
          { source: "output", runId: "run-a", onMissing: "omit-binding" },
        ],
      }),
      [output("run-a", "thread-a", "survivor")],
    )

    expect(result.failure).toBeUndefined()
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]?.content).toContain("survivor")
    expect(result.bindings.map((binding) => binding.status)).toEqual(["omitted", "included"])
  })

  test("fail-graph wins and suppresses all guidance", () => {
    const result = composeMainGuidance(
      config("sequential", {
        source: "main",
        inputs: [
          { source: "output", runId: "missing-omit", onMissing: "omit-binding" },
          { source: "output", runId: "missing-fail", onMissing: "fail-graph" },
        ],
      }),
      [],
    )

    expect(result.entries).toEqual([])
    expect(result.failure?.code).toBe("MISSING_OUTPUT")
    expect(result.failure?.runId).toBe("missing-fail")
  })

  test("failed or skipped runs are treated as missing outputs", () => {
    const result = composeMainGuidance(
      config("sequential", {
        source: "main",
        inputs: [{ source: "output", runId: "run-a", onMissing: "omit-binding" }],
      }),
      [output("run-a", "thread-a", "discarded", "failed")],
    )

    expect(result.entries).toEqual([])
    expect(result.bindings[0]?.status).toBe("omitted")
  })

  test("keeps a 32-entry aggregate below the serialized guidance limit", () => {
    const testConfig = aggregateConfig(AGGREGATE_ENTRY_COUNT)
    const result = composeMainGuidance(
      testConfig,
      outputsForAggregateTarget(testConfig, MAX_GUIDANCE_BYTES - 1),
    )

    expect(result.failure).toBeUndefined()
    expect(result.entries).toHaveLength(AGGREGATE_ENTRY_COUNT)
    const serialized = serializedUtf8Bytes(result.deferredGuidance)
    expect(serialized.ok).toBe(true)
    if (serialized.ok) expect(serialized.bytes).toBe(MAX_GUIDANCE_BYTES - 1)
  })

  test("accepts a 32-entry aggregate exactly at the serialized guidance limit", () => {
    const testConfig = aggregateConfig(AGGREGATE_ENTRY_COUNT)
    const result = composeMainGuidance(
      testConfig,
      outputsForAggregateTarget(testConfig, MAX_GUIDANCE_BYTES),
    )

    expect(result.failure).toBeUndefined()
    expect(result.entries).toHaveLength(AGGREGATE_ENTRY_COUNT)
    const serialized = serializedUtf8Bytes(result.deferredGuidance)
    expect(serialized.ok).toBe(true)
    if (serialized.ok) expect(serialized.bytes).toBe(MAX_GUIDANCE_BYTES)
  })

  test("fails closed when a 32-entry aggregate exceeds the serialized guidance limit", () => {
    const testConfig = aggregateConfig(AGGREGATE_ENTRY_COUNT)
    const result = composeMainGuidance(
      testConfig,
      outputsForAggregateTarget(testConfig, MAX_GUIDANCE_BYTES + 1),
    )

    expect(result.applied).toBe(false)
    expect(result.entries).toEqual([])
    expect(result.deferredGuidance).toEqual([])
    expect(result.failure?.code).toBe("GUIDANCE_LIMIT")
  })
})
