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
})
