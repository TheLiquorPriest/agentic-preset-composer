// @ts-ignore Bun provides the test module at runtime; the extension bundle excludes this file.
import { describe, expect, test } from "bun:test"
import {
  GRAPH_FALLBACK_CAUSE_RANK,
  OUTCOME_CLASS_RANK,
  OutcomeLatch,
  type OutcomeCause,
  type OutcomeClass,
} from "./outcome"
import {
  composeAbortSignals,
  deriveGraphDeadline,
  validateCriticalPath,
  validateRunTimeout,
} from "./deadline"

function cause(outcomeClass: OutcomeClass, code: string, extra: Partial<OutcomeCause> = {}): OutcomeCause {
  return { class: outcomeClass, code, ...extra } as OutcomeCause
}

describe("OutcomeLatch class precedence", () => {
  const classes: readonly OutcomeClass[] = [
    "success",
    "optional-local",
    "graph-fallback",
    "selected-final-failure",
    "parent-cancel",
    "integrity-fatal",
  ]

  const graphCause: OutcomeCause = {
    class: "graph-fallback",
    code: "HOST_GATE_UNAVAILABLE",
    category: "host-gate",
  }

  for (let higherIndex = 0; higherIndex < classes.length; higherIndex += 1) {
    for (let lowerIndex = 0; lowerIndex < higherIndex; lowerIndex += 1) {
      const higher = classes[higherIndex]
      const lower = classes[lowerIndex]
      test(`${higher} wins over ${lower} in either observation order`, () => {
        const higherCause = higher === "graph-fallback" ? graphCause : cause(higher, `${higher}-cause`)
        const lowerCause = lower === "graph-fallback" ? graphCause : cause(lower, `${lower}-cause`)

        const higherFirst = new OutcomeLatch()
        higherFirst.consider(higherCause)
        higherFirst.consider(lowerCause)
        expect(higherFirst.snapshot().class).toBe(higher)

        const lowerFirst = new OutcomeLatch()
        lowerFirst.consider(lowerCause)
        lowerFirst.consider(higherCause)
        expect(lowerFirst.snapshot().class).toBe(higher)
      })
    }
  }

  test("class ranks are strictly canonical", () => {
    expect(OUTCOME_CLASS_RANK.success).toBeLessThan(OUTCOME_CLASS_RANK["optional-local"])
    expect(OUTCOME_CLASS_RANK["optional-local"]).toBeLessThan(OUTCOME_CLASS_RANK["graph-fallback"])
    expect(OUTCOME_CLASS_RANK["graph-fallback"]).toBeLessThan(OUTCOME_CLASS_RANK["selected-final-failure"])
    expect(OUTCOME_CLASS_RANK["selected-final-failure"]).toBeLessThan(OUTCOME_CLASS_RANK["parent-cancel"])
    expect(OUTCOME_CLASS_RANK["parent-cancel"]).toBeLessThan(OUTCOME_CLASS_RANK["integrity-fatal"])
  })
})

describe("OutcomeLatch graph-fallback and tie precedence", () => {
  const categories = Object.keys(GRAPH_FALLBACK_CAUSE_RANK) as Array<keyof typeof GRAPH_FALLBACK_CAUSE_RANK>

  for (let winningIndex = 0; winningIndex < categories.length; winningIndex += 1) {
    for (let losingIndex = winningIndex + 1; losingIndex < categories.length; losingIndex += 1) {
      const winning = categories[winningIndex]
      const losing = categories[losingIndex]
      test(`${winning} wins over ${losing} in either order`, () => {
        const winningCause: OutcomeCause = { class: "graph-fallback", code: winning, category: winning }
        const losingCause: OutcomeCause = { class: "graph-fallback", code: losing, category: losing }

        const first = new OutcomeLatch()
        first.consider(winningCause)
        first.consider(losingCause)
        expect(first.snapshot().cause.code).toBe(winning)

        const second = new OutcomeLatch()
        second.consider(losingCause)
        second.consider(winningCause)
        expect(second.snapshot().cause.code).toBe(winning)
      })
    }
  }

  test("earliest canonical pipeline, stage, and run win regardless of order", () => {
    const late: OutcomeCause = {
      class: "graph-fallback",
      code: "ASSEMBLY_LATE",
      category: "assembly-setup-storage-worker-transport-receipt",
      pipelineId: "00000000-0000-4000-8000-000000000002",
      stageIndex: 2,
      runIndex: 2,
    }
    const early: OutcomeCause = {
      class: "graph-fallback",
      code: "ASSEMBLY_EARLY",
      category: "assembly-setup-storage-worker-transport-receipt",
      pipelineId: "00000000-0000-4000-8000-000000000001",
      stageIndex: 1,
      runIndex: 1,
    }

    const latch = new OutcomeLatch()
    latch.consider(late)
    latch.consider(early)
    expect(latch.snapshot().cause.code).toBe("ASSEMBLY_EARLY")

    const reverse = new OutcomeLatch()
    reverse.consider(early)
    reverse.consider(late)
    expect(reverse.snapshot().cause.code).toBe("ASSEMBLY_EARLY")
  })

  test("same location resolves by stable cause code", () => {
    const first = cause("graph-fallback", "CAUSE_A", {
      category: "timeout-deadline",
      pipelineId: "00000000-0000-4000-8000-000000000001",
      stageIndex: 0,
      runIndex: 0,
    })
    const second = cause("graph-fallback", "CAUSE_B", {
      category: "timeout-deadline",
      pipelineId: "00000000-0000-4000-8000-000000000001",
      stageIndex: 0,
      runIndex: 0,
    })
    const latch = new OutcomeLatch()
    latch.consider(second)
    latch.consider(first)
    expect(latch.snapshot().cause.code).toBe("CAUSE_A")
  })

  test("snapshots and causes are immutable copies", () => {
    const input = { class: "optional-local" as const, code: "HOOK_FAILED" }
    const latch = new OutcomeLatch()
    latch.consider(input)
    input.code = "MUTATED"
    const snapshot = latch.snapshot()
    expect(snapshot.cause.code).toBe("HOOK_FAILED")
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.cause)).toBe(true)
  })
})

describe("runtime deadlines", () => {
  test("derives the exact nominal boundary", () => {
    expect(deriveGraphDeadline(1_000, 301_000)).toBe(286_000)
    expect(deriveGraphDeadline(1_000, 286_001)).toBe(271_001)
  })

  test("shortened parent wall controls the effective deadline", () => {
    const entryAt = 10_000
    const shortened = deriveGraphDeadline(entryAt, entryAt + 250_000)
    expect(shortened).toBe(entryAt + 235_000)
    expect(() => validateCriticalPath([[120_000], [120_000]], entryAt, shortened)).toThrow(RangeError)
  })

  test("rejects a nonpositive effective window at the boundary", () => {
    expect(() => deriveGraphDeadline(1_000, 16_000)).toThrow(RangeError)
    expect(deriveGraphDeadline(1_000, 16_001)).toBe(1_001)
  })

  test("validates inclusive run timeout boundaries", () => {
    expect(validateRunTimeout(1_000)).toBe(1_000)
    expect(validateRunTimeout(240_000)).toBe(240_000)
    expect(() => validateRunTimeout(999)).toThrow(RangeError)
    expect(() => validateRunTimeout(240_001)).toThrow(RangeError)
    expect(() => validateRunTimeout(Number.NaN)).toThrow(RangeError)
  })

  test("critical path uses each stage maximum and accepts exact budget", () => {
    expect(validateCriticalPath([[1_000, 2_000], [3_000, 1_000]], 100, 5_100)).toBe(true)
    expect(() => validateCriticalPath([[1_000, 2_000], [3_000, 1_000]], 100, 5_099)).toThrow(RangeError)
  })
})

describe("abort composition", () => {
  test("aborts from the first source and preserves its reason", () => {
    const caller = new AbortController()
    const graph = new AbortController()
    const run = new AbortController()
    const reason = new Error("caller stopped")
    const composed = composeAbortSignals([caller.signal, graph.signal, run.signal])

    caller.abort(reason)
    expect(composed.signal.aborted).toBe(true)
    expect(composed.signal.reason).toBe(reason)

    graph.abort(new Error("graph timeout"))
    run.abort(new Error("run timeout"))
    expect(composed.signal.reason).toBe(reason)
    composed.dispose()
    composed.dispose()
  })

  test("dispose removes listeners without aborting the composed signal", () => {
    const caller = new AbortController()
    const graph = new AbortController()
    const composed = composeAbortSignals([caller.signal, graph.signal])

    composed.dispose()
    caller.abort(new Error("late caller"))
    graph.abort(new Error("late graph"))
    expect(composed.signal.aborted).toBe(false)
  })

  test("already-aborted and empty inputs do not leave listeners or timers", () => {
    const caller = new AbortController()
    caller.abort("already stopped")
    const already = composeAbortSignals([caller.signal, caller.signal])
    expect(already.signal.aborted).toBe(true)
    expect(already.signal.reason).toBe("already stopped")
    already.dispose()

    const empty = composeAbortSignals([])
    expect(empty.signal.aborted).toBe(false)
    empty.dispose()
  })
})
