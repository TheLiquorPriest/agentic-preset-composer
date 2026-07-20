// @ts-ignore Bun provides the test module at runtime; the extension bundle excludes this file.
import { describe, expect, test } from "bun:test"
import type { ApcFinalResponseV1, ApcPresetConfigV1 } from "../config/schema"
import {
  routeFinalResponse,
  type FinalRoutingInput,
} from "./final-routing"
import type { SettledThreadOutput } from "./guidance"

function config(finalResponse: ApcFinalResponseV1, mode: "sequential" | "single" = "sequential"): ApcPresetConfigV1 {
  return {
    schemaVersion: 1,
    supportedModes: mode === "single" ? ["single"] : ["single", "sequential"],
    activeMode: mode,
    mainThread: {
      id: "main",
      name: "Main Thread",
      output: { id: "final", name: "Final Response" },
    },
    connectionSlots: [],
    threads: [
      {
        id: "thread-a",
        name: "Answer Thread",
        description: "Answer",
        workspaceSource: "main-context",
        blocks: [],
        promptVariableValues: {},
        output: { id: "final", name: "Final Response" },
      },
    ],
    pipelines: mode === "sequential"
      ? {
          sequential: {
            id: "pipeline",
            stages: [{
              id: "stage",
              name: "Stage",
              runs: [{ id: "run-a", threadId: "thread-a", required: true, timeoutMs: 1_000, inputs: [] }],
            }],
            finalResponse,
          },
        }
      : {},
  }
}

function run(status: SettledThreadOutput["status"] = "success"): SettledThreadOutput {
  return {
    runId: "run-a",
    threadId: "thread-a",
    status,
    content: "thread answer",
    reasoning: "thread reasoning",
  }
}

function input(
  finalResponse: ApcFinalResponseV1,
  overrides: Partial<FinalRoutingInput> = {},
): FinalRoutingInput {
  return {
    mode: "sequential",
    config: config(finalResponse),
    finalResponse,
    settledRuns: [run()],
    fallbackMessageIndex: 3,
    fallbackState: "available",
    terminalOutcome: "success",
    hasFinalResponsePermission: true,
    ...overrides,
  }
}

describe("routeFinalResponse", () => {
  test("Main final keeps the native response and composes only Main guidance", () => {
    const finalResponse: ApcFinalResponseV1 = {
      source: "main",
      inputs: [{ source: "output", runId: "run-a", onMissing: "omit-binding" }],
    }
    const result = routeFinalResponse(input(finalResponse))

    expect(result.kind).toBe("main")
    expect(result.route).toBe("main")
    expect(result.selected).toBeUndefined()
    expect(result.guidance.entries).toHaveLength(1)
    expect(result.provenance.source).toBe("main")
  })

  test("selects a thread candidate only with permission and a live fallback", () => {
    const finalResponse = { source: "thread", runId: "run-a" } as const
    let normalized = 0
    const result = routeFinalResponse(input(finalResponse, {
      normalizeFinalResponse: (candidate) => {
        normalized += 1
        return { ...candidate, reasoning: "host-normalized" }
      },
    }))

    expect(result.selected).toEqual({
      content: "thread answer",
      reasoning: "host-normalized",
      fallbackMessageIndex: 3,
    })
    expect(normalized).toBe(1)
    expect(Object.isFrozen(result)).toBe(true)
  })

  test("unpermissioned thread routing preserves Main provider handling", () => {
    const finalResponse = { source: "thread", runId: "run-a" } as const
    const result = routeFinalResponse(input(finalResponse, { hasFinalResponsePermission: false }))

    expect(result.kind).toBe("fallback")
    expect(result.route).toBe("main")
    expect(result.selected).toBeUndefined()
    expect(result.fallbackReason).toBe("final-response-permission-missing")
    expect(result.guidance.deferredGuidance).toEqual([])
  })

  test("failed or ineligible thread routing preserves ordinary messages and guidance", () => {
    const finalResponse = { source: "thread", runId: "run-a" } as const
    const failed = routeFinalResponse(input(finalResponse, { settledRuns: [run("failed")] }))
    const ineligible = routeFinalResponse(input(finalResponse, {
      finalResponse: { source: "thread", runId: "cba7b810-9dad-41d1-80b4-00c04fd430c8" },
    }))

    for (const result of [failed, ineligible]) {
      expect(result.kind).toBe("fallback")
      expect(result.route).toBe("main")
      expect(result.selected).toBeUndefined()
      expect(result.guidance.deferredGuidance).toEqual([])
    }
    expect(failed.fallbackReason).toBe("run-failed")
    expect(ineligible.fallbackReason).toBe("final-route-mismatch")
  })

  test("host normalization failure remains fail-closed", () => {
    const finalResponse = { source: "thread", runId: "run-a" } as const
    const result = routeFinalResponse(input(finalResponse, {
      normalizeFinalResponse: () => ({ content: "not validated", fallbackMessageIndex: 2 }),
    }))

    expect(result.kind).toBe("fallback")
    expect(result.selected).toBeUndefined()
    expect(result.fallbackReason).toBe("host-normalization-failed")
  })
  test("Single, failed, and Stop paths do not select a candidate", () => {
    const finalResponse = { source: "thread", runId: "run-a" } as const
    const single = routeFinalResponse({
      ...input({ source: "main", inputs: [] }),
      mode: "single",
      config: config({ source: "main", inputs: [] }, "single"),
      finalResponse: { source: "main", inputs: [] },
    })
    const failed = routeFinalResponse(input(finalResponse, { terminalOutcome: "graph-fallback" }))
    const stopped = routeFinalResponse(input(finalResponse, { stopped: true }))

    expect(single.selected).toBeUndefined()
    expect(single.fallbackReason).toBe("single-mode")
    expect(failed.selected).toBeUndefined()
    expect(failed.fallbackReason).toBe("terminal-outcome-ineligible")
    expect(stopped.selected).toBeUndefined()
    expect(stopped.fallbackReason).toBe("stopped")
  })

  test("failed thread output falls back without a response replacement", () => {
    const finalResponse = { source: "thread", runId: "run-a" } as const
    const result = routeFinalResponse(input(finalResponse, { settledRuns: [run("failed")] }))

    expect(result.kind).toBe("fallback")
    expect(result.selected).toBeUndefined()
    expect(result.fallbackReason).toBe("run-failed")
  })
})
