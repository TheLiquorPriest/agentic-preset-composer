// @ts-ignore Bun provides the test module at runtime; the extension bundle excludes this file.
import { describe, expect, test } from "bun:test"
import {
  MAX_ACTIVE_GLOBAL,
  MAX_ACTIVE_PER_USER_PRESET,
  MAX_RETAINED_TRACES_GLOBAL,
  MAX_RETAINED_TRACES_PER_USER_PRESET,
  MAX_TRACE_BYTES,
  MAX_TRACE_TOTAL_BYTES,
  TRACE_PREVIEW_BYTES,
  utf8Bytes,
} from "../config/limits"
import {
  AdmissionRegistry,
  acquireAdmission,
  cancelAdmission,
  getAdmission,
  listActiveAdmissions,
  releaseAdmission,
} from "./admission"
import {
  TraceStore,
  type TraceMetadata,
  acquireTrace,
  appendTrace,
  cancelTrace,
  finalizeTrace,
  getTrace,
  listTraces,
} from "./trace-store"

const USER_A = "user-a"
const USER_B = "user-b"
const PRESET = "preset-shared"
const EXECUTION = "execution-shared"

function complete(store: TraceStore, userId: string, executionId: string, metadata: Record<string, string> = {}) {
  const acquired = acquireTrace(store, userId, PRESET, executionId, metadata)
  expect(acquired.accepted).toBe(true)
  const finalized = finalizeTrace(store, userId, PRESET, executionId)
  expect(finalized.accepted).toBe(true)
}

describe("user-scoped APC admission", () => {
  test("keeps identical user, preset, and execution IDs isolated", () => {
    const registry = new AdmissionRegistry()
    const a = acquireAdmission(registry, USER_A, PRESET, EXECUTION)
    const b = acquireAdmission(registry, USER_B, PRESET, EXECUTION)

    expect(a.accepted).toBe(true)
    expect(b.accepted).toBe(true)
    expect(getAdmission(registry, USER_A, PRESET, EXECUTION)).toBeDefined()
    expect(getAdmission(registry, USER_B, PRESET, EXECUTION)).toBeDefined()
    expect(listActiveAdmissions(registry, USER_A, PRESET)).toHaveLength(1)
    expect(listActiveAdmissions(registry, USER_B, PRESET)).toHaveLength(1)
    expect(cancelAdmission(registry, USER_A, PRESET, EXECUTION)).toBe(true)
    expect(getAdmission(registry, USER_B, PRESET, EXECUTION)).toBeDefined()
    expect(releaseAdmission(registry, USER_B, PRESET, EXECUTION)).toBe(true)
  })

  test("enforces per-user capacity without consuming another user's slots", () => {
    const registry = new AdmissionRegistry()
    for (let index = 0; index < MAX_ACTIVE_PER_USER_PRESET; index += 1) {
      expect(acquireAdmission(registry, USER_A, PRESET, `a-${index}`).accepted).toBe(true)
    }
    const rejected = acquireAdmission(registry, USER_A, PRESET, "a-overflow")
    expect(rejected).toEqual({ accepted: false, reason: "user-preset-capacity" })
    expect(acquireAdmission(registry, USER_B, PRESET, "b-first").accepted).toBe(true)
    expect(listActiveAdmissions(registry, USER_B, PRESET)).toHaveLength(1)
  })

  test("enforces the global capacity without disclosing counts", () => {
    const registry = new AdmissionRegistry()
    for (let index = 0; index < MAX_ACTIVE_GLOBAL; index += 1) {
      const userId = `user-${index}`
      expect(acquireAdmission(registry, userId, PRESET, `execution-${index}`).accepted).toBe(true)
    }
    const rejected = acquireAdmission(registry, "new-user", PRESET, "new-execution")
    expect(rejected).toEqual({ accepted: false, reason: "global-capacity" })
    expect("activeCount" in rejected).toBe(false)
    expect("globalCount" in rejected).toBe(false)
  })
})

describe("user-scoped immutable trace retention", () => {
  test("rejects cross-user list, get, and cancel before lookup", () => {
    const store = new TraceStore()
    expect(acquireTrace(store, USER_A, PRESET, EXECUTION).accepted).toBe(true)
    expect(acquireTrace(store, USER_B, PRESET, EXECUTION).accepted).toBe(true)

    expect(getTrace(store, USER_B, PRESET, "not-the-user-a-trace")).toBeUndefined()
    expect(listTraces(store, USER_B, "other-preset")).toHaveLength(0)
    const crossUserCancel = cancelTrace(store, USER_B, PRESET, "missing-execution")
    expect(crossUserCancel).toEqual({ accepted: false, reason: "not-found" })
    expect(getTrace(store, USER_A, PRESET, EXECUTION)?.active).toBe(true)
    expect(getTrace(store, USER_B, PRESET, EXECUTION)?.active).toBe(true)
  })

  test("accepts only strictly increasing per-execution sequences", () => {
    const store = new TraceStore()
    expect(acquireTrace(store, USER_A, PRESET, EXECUTION).accepted).toBe(true)
    expect(appendTrace(store, USER_A, PRESET, EXECUTION, { sequence: 2, kind: "run" }).accepted).toBe(true)
    expect(appendTrace(store, USER_A, PRESET, EXECUTION, { sequence: 1, kind: "late" })).toEqual({
      accepted: false,
      reason: "late-sequence",
    })
    expect(appendTrace(store, USER_A, PRESET, EXECUTION, { sequence: 2, kind: "duplicate" })).toEqual({
      accepted: false,
      reason: "late-sequence",
    })
    expect(finalizeTrace(store, USER_A, PRESET, EXECUTION, { sequence: 3, kind: "done" }).accepted).toBe(true)
    expect(appendTrace(store, USER_A, PRESET, EXECUTION, { sequence: 4, kind: "late-after-final" })).toEqual({
      accepted: false,
      reason: "not-active",
    })
  })

  test("rejects an active duplicate execution ownership", () => {
    const store = new TraceStore()
    expect(acquireTrace(store, USER_A, PRESET, EXECUTION).accepted).toBe(true)
    expect(acquireTrace(store, USER_A, PRESET, EXECUTION)).toEqual({
      accepted: false,
      reason: "duplicate-execution",
    })
  })

  test("replaces completed consent traces without count or byte leaks", () => {
    const store = new TraceStore()
    complete(store, USER_A, EXECUTION, { reason: "consent-required" })

    for (let index = 0; index < MAX_RETAINED_TRACES_GLOBAL + 2; index += 1) {
      const acquired = acquireTrace(store, USER_A, PRESET, EXECUTION, {
        reason: `consent-retry-${index}`,
      })
      expect(acquired.accepted).toBe(true)
      expect(getTrace(store, USER_A, PRESET, EXECUTION)?.active).toBe(true)
      expect(finalizeTrace(store, USER_A, PRESET, EXECUTION).accepted).toBe(true)
      const retained = getTrace(store, USER_A, PRESET, EXECUTION)
      if (retained === undefined) throw new Error("replacement trace was not retained")
      const traces = listTraces(store, USER_A, PRESET)
      expect(traces).toHaveLength(1)
      expect(traces.reduce((total, trace) => total + trace.bytes, 0)).toBe(retained.bytes)
    }
  })

  test("preserves a completed consent trace when replacement capacity fails", () => {
    const store = new TraceStore()
    complete(store, USER_A, EXECUTION, { reason: "consent-required" })
    const original = getTrace(store, USER_A, PRESET, EXECUTION)
    if (original === undefined) throw new Error("original consent trace was not retained")

    const fillerUsers: string[] = []
    const totalBytes = (): number => fillerUsers
      .concat(USER_A)
      .flatMap(userId => listTraces(store, userId, PRESET))
      .reduce((total, trace) => total + trace.bytes, 0)
    let index = 0
    while (totalBytes() < MAX_TRACE_TOTAL_BYTES - 1_024 && index < MAX_RETAINED_TRACES_GLOBAL + 32) {
      const userId = `capacity-user-${index}`
      const remaining = MAX_TRACE_TOTAL_BYTES - totalBytes()
      const note = "x".repeat(Math.min(100_000, Math.max(1, remaining - 512)))
      const acquired = acquireTrace(store, userId, PRESET, `capacity-execution-${index}`, { note })
      if (!acquired.accepted) break
      expect(finalizeTrace(store, userId, PRESET, `capacity-execution-${index}`).accepted).toBe(true)
      fillerUsers.push(userId)
      index += 1
    }

    const replacement = acquireTrace(store, USER_A, PRESET, EXECUTION, { note: "replacement".repeat(1_024) })
    expect(replacement.accepted).toBe(false)
    expect(getTrace(store, USER_A, PRESET, EXECUTION)).toEqual(original)
  })

  test("pins active traces while retaining only the user's completed traces", () => {
    const store = new TraceStore()
    expect(acquireTrace(store, USER_A, PRESET, "active").accepted).toBe(true)
    for (let index = 0; index < MAX_RETAINED_TRACES_PER_USER_PRESET + 1; index += 1) {
      complete(store, USER_A, `completed-${index}`)
    }

    const traces = listTraces(store, USER_A, PRESET)
    expect(traces.some(trace => trace.executionId === "active" && trace.active)).toBe(true)
    expect(traces.filter(trace => !trace.active)).toHaveLength(MAX_RETAINED_TRACES_PER_USER_PRESET)
    expect(getTrace(store, USER_A, PRESET, "completed-0")).toBeUndefined()
  })

  test("evicts only the requesting user's completed trace under global pressure", () => {
    const store = new TraceStore()
    const users = [USER_A, USER_B, "user-c", "user-d", "user-e"]
    for (const userId of users) {
      for (let index = 0; index < MAX_RETAINED_TRACES_PER_USER_PRESET; index += 1) {
        complete(store, userId, `${userId}-${index}`)
      }
    }

    const beforeOther = getTrace(store, USER_B, PRESET, `${USER_B}-0`)
    expect(beforeOther).toBeDefined()
    expect(listTraces(store, USER_A, PRESET)).toHaveLength(MAX_RETAINED_TRACES_PER_USER_PRESET)
    expect(listTraces(store, USER_B, PRESET)).toHaveLength(MAX_RETAINED_TRACES_PER_USER_PRESET)

    expect(acquireTrace(store, USER_A, PRESET, "requesting-execution").accepted).toBe(true)
    expect(finalizeTrace(store, USER_A, PRESET, "requesting-execution").accepted).toBe(true)
    expect(getTrace(store, USER_A, PRESET, `${USER_A}-0`)).toBeUndefined()
    expect(getTrace(store, USER_B, PRESET, `${USER_B}-0`)).toEqual(beforeOther)
    expect(listTraces(store, USER_A, PRESET).filter(trace => !trace.active)).toHaveLength(
      MAX_RETAINED_TRACES_PER_USER_PRESET,
    )
    expect(listTraces(store, USER_B, PRESET).filter(trace => !trace.active)).toHaveLength(
      MAX_RETAINED_TRACES_PER_USER_PRESET,
    )

    const allTraces = users.flatMap(userId => listTraces(store, userId, PRESET))
    expect(allTraces).toHaveLength(MAX_RETAINED_TRACES_GLOBAL)
  })

  test("truncates previews at a UTF-8 boundary and marks truncation", () => {
    const store = new TraceStore()
    expect(acquireTrace(store, USER_A, PRESET, EXECUTION).accepted).toBe(true)
    const source = "😀".repeat(TRACE_PREVIEW_BYTES)
    const appended = appendTrace(store, USER_A, PRESET, EXECUTION, {
      sequence: 1,
      kind: "preview",
      preview: source,
    })
    expect(appended.accepted).toBe(true)
    if (appended.accepted) {
      const entry = appended.trace.entries[0]
      expect(entry.previewTruncated).toBe(true)
      expect(utf8Bytes(entry.preview)).toBeLessThanOrEqual(TRACE_PREVIEW_BYTES)
      expect(entry.preview.endsWith("\uD83D")).toBe(false)
    }
  })

  test("keeps count and serialized byte ceilings while pressure evicts only own completed traces", () => {
    const store = new TraceStore()
    const largeMetadata = { note: "x".repeat(100_000) }
    const users = ["bytes-a", "bytes-b", "bytes-c", "bytes-d", "bytes-e"]
    for (const userId of users) {
      for (let index = 0; index < MAX_RETAINED_TRACES_PER_USER_PRESET; index += 1) {
        complete(store, userId, `${userId}-${index}`, largeMetadata)
      }
    }

    const traces = users.flatMap(userId => listTraces(store, userId, PRESET))
    const bytes = traces.reduce((total, trace) => total + trace.bytes, 0)
    expect(traces.length).toBeLessThanOrEqual(MAX_RETAINED_TRACES_GLOBAL)
    expect(bytes).toBeLessThanOrEqual(MAX_TRACE_TOTAL_BYTES)
    expect(getTrace(store, "bytes-b", PRESET, "bytes-b-0")).toBeDefined()
  })
})

describe("bounded trace metadata and terminal settlement", () => {
  test("rejects metadata bombs before admission and preserves accounting", () => {
    const admission = new AdmissionRegistry()
    const store = new TraceStore(admission)
    const keyBomb: Record<string, string> = {}
    for (let index = 0; index < 65; index += 1) {
      keyBomb[`key-${index}`] = "value"
    }
    const oversizedKey = { ["k".repeat(257)]: "value" }
    const oversizedValue = { value: "x".repeat(MAX_TRACE_BYTES) }
    const apiKey = { apiKey: "do-not-store" }
    const privateKey = { privateKey: "do-not-store" }
    const candidates: readonly TraceMetadata[] = [
      keyBomb,
      oversizedKey,
      oversizedValue,
      apiKey,
      privateKey,
    ] as readonly TraceMetadata[]

    for (const [index, metadata] of candidates.entries()) {
      expect(acquireTrace(store, USER_A, PRESET, `invalid-${index}`, metadata)).toEqual({
        accepted: false,
        reason: "invalid-metadata",
      })
    }

    expect(listTraces(store, USER_A, PRESET)).toHaveLength(0)
    expect(listActiveAdmissions(admission, USER_A, PRESET)).toHaveLength(0)

    const stable = acquireTrace(store, USER_A, PRESET, "stable", { reason: "consent-required" })
    expect(stable.accepted).toBe(true)
    const before = getTrace(store, USER_A, PRESET, "stable")
    if (before === undefined) throw new Error("stable trace was not retained")
    for (const [index, metadata] of candidates.entries()) {
      expect(acquireTrace(store, USER_A, PRESET, `invalid-after-${index}`, metadata)).toEqual({
        accepted: false,
        reason: "invalid-metadata",
      })
    }
    expect(getTrace(store, USER_A, PRESET, "stable")).toEqual(before)
    expect(listTraces(store, USER_A, PRESET)).toHaveLength(1)
    expect(listTraces(store, USER_A, PRESET).reduce((total, trace) => total + trace.bytes, 0)).toBe(before.bytes)
    expect(listActiveAdmissions(admission, USER_A, PRESET)).toHaveLength(1)
  })

  test("rejects accessors, symbols, and nested metadata without copying", () => {
    const store = new TraceStore()
    const accessor: Record<string, unknown> = {}
    Object.defineProperty(accessor, "value", {
      enumerable: true,
      get: () => "secret",
    })
    const symbol = Symbol("metadata")
    const candidates: readonly unknown[] = [
      accessor,
      { [symbol]: "secret" },
      { nested: { value: "secret" } },
      { unsupported: undefined },
    ]

    for (const [index, metadata] of candidates.entries()) {
      expect(acquireTrace(store, USER_A, PRESET, `unsupported-${index}`, metadata as TraceMetadata)).toEqual({
        accepted: false,
        reason: "invalid-metadata",
      })
    }
    expect(listTraces(store, USER_A, PRESET)).toHaveLength(0)
  })

  test("settles a near-cap active trace when terminal bytes cannot fit", () => {
    const admission = new AdmissionRegistry()
    const store = new TraceStore(admission)
    const executionId = "near-cap-execution"
    expect(acquireTrace(store, USER_A, PRESET, executionId).accepted).toBe(true)

    let sequence = 0
    let trace = getTrace(store, USER_A, PRESET, executionId)
    while (trace !== undefined && trace.bytes < MAX_TRACE_BYTES) {
      const appended = appendTrace(store, USER_A, PRESET, executionId, {
        sequence: sequence + 1,
        kind: "near-cap",
        preview: "x".repeat(TRACE_PREVIEW_BYTES),
      })
      if (!appended.accepted) break
      sequence += 1
      trace = getTrace(store, USER_A, PRESET, executionId)
    }

    if (trace === undefined) throw new Error("near-cap trace was not retained")
    expect(trace.active).toBe(true)
    expect(trace.bytes).toBeGreaterThanOrEqual(MAX_TRACE_BYTES - 1)
    expect(finalizeTrace(store, USER_A, PRESET, executionId)).toEqual({
      accepted: false,
      reason: "trace-capacity",
    })
    expect(getTrace(store, USER_A, PRESET, executionId)).toBeUndefined()
    expect(listActiveAdmissions(admission, USER_A, PRESET)).toHaveLength(0)
    expect(listTraces(store, USER_A, PRESET)).toHaveLength(0)
    expect(listTraces(store, USER_A, PRESET).reduce((total, item) => total + item.bytes, 0)).toBe(0)
    const reacquired = acquireTrace(store, USER_A, PRESET, executionId)
    expect(reacquired.accepted).toBe(true)
    if (reacquired.accepted) {
      expect(listTraces(store, USER_A, PRESET)).toHaveLength(1)
      expect(listTraces(store, USER_A, PRESET).reduce((total, item) => total + item.bytes, 0)).toBe(
        reacquired.trace.bytes,
      )
    }
  })
})

describe("replacement capacity probes", () => {
  const totalBytes = (store: TraceStore, users: readonly string[]): number =>
    users
      .flatMap(userId => listTraces(store, userId, PRESET))
      .reduce((total, trace) => total + trace.bytes, 0)

  test("replaces a retained trace near global count and byte caps", () => {
    const store = new TraceStore()
    const replacementUser = "replacement-a"
    const users = [replacementUser, "replacement-b", "replacement-c", "replacement-d", "replacement-e"]
    const oldExecution = "replacement-old"
    const fillerMetadata = { note: "x".repeat(84_000) }
    complete(store, replacementUser, oldExecution, { note: "old" })
    for (const userId of users) {
      for (let index = 0; index < MAX_RETAINED_TRACES_PER_USER_PRESET; index += 1) {
        if (userId === replacementUser && index === 0) continue
        complete(store, userId, `${userId}-${index}`, fillerMetadata)
      }
    }

    const before = users.flatMap(userId => listTraces(store, userId, PRESET))
    expect(before).toHaveLength(MAX_RETAINED_TRACES_GLOBAL)
    const oldTrace = getTrace(store, replacementUser, PRESET, oldExecution)
    const evictedTrace = getTrace(store, replacementUser, PRESET, `${replacementUser}-1`)
    if (oldTrace === undefined || evictedTrace === undefined) {
      throw new Error("replacement capacity probes were not retained")
    }
    const beforeBytes = before.reduce((total, trace) => total + trace.bytes, 0)
    const replacementMetadata = { note: "x".repeat(100_000) }
    const replacement = acquireTrace(store, replacementUser, PRESET, oldExecution, replacementMetadata)
    expect(replacement.accepted).toBe(true)
    if (!replacement.accepted) throw new Error("replacement was rejected")
    expect(replacement.trace.bytes).toBeLessThanOrEqual(MAX_TRACE_BYTES)
    expect(getTrace(store, replacementUser, PRESET, oldExecution)?.active).toBe(true)
    expect(getTrace(store, replacementUser, PRESET, `${replacementUser}-1`)).toBeUndefined()

    const afterAcquire = users.flatMap(userId => listTraces(store, userId, PRESET))
    expect(afterAcquire).toHaveLength(MAX_RETAINED_TRACES_GLOBAL - 1)
    expect(totalBytes(store, users)).toBe(
      beforeBytes - oldTrace.bytes - evictedTrace.bytes + replacement.trace.bytes,
    )

    const finalized = finalizeTrace(store, replacementUser, PRESET, oldExecution)
    expect(finalized.accepted).toBe(true)
    if (!finalized.accepted || !finalized.retained) throw new Error("replacement was not retained")
    expect(finalized.trace.metadata.note).toBe(replacementMetadata.note)
    expect(finalized.trace.bytes).toBeLessThanOrEqual(MAX_TRACE_BYTES)
    expect(totalBytes(store, users)).toBe(
      beforeBytes - oldTrace.bytes - evictedTrace.bytes + finalized.trace.bytes,
    )
    expect(users.flatMap(userId => listTraces(store, userId, PRESET))).toHaveLength(
      MAX_RETAINED_TRACES_GLOBAL - 1,
    )
  })

  test("reports global capacity and releases admission after terminal rejection", () => {
    const store = new TraceStore()
    const fillerUsers: string[] = []
    const totalFillerBytes = (): number => totalBytes(store, fillerUsers)
    let index = 0
    while (
      totalFillerBytes() < MAX_TRACE_TOTAL_BYTES - 1_024 &&
      index < MAX_RETAINED_TRACES_GLOBAL - 1
    ) {
      const userId = `global-probe-${index}`
      const remaining = MAX_TRACE_TOTAL_BYTES - totalFillerBytes()
      const note = "x".repeat(Math.min(100_000, Math.max(1, remaining - 512)))
      const acquired = acquireTrace(store, userId, PRESET, `filler-${index}`, { note })
      if (!acquired.accepted) break
      const finalized = finalizeTrace(store, userId, PRESET, `filler-${index}`)
      if (!finalized.accepted) break
      fillerUsers.push(userId)
      index += 1
    }
    expect(totalFillerBytes()).toBeGreaterThan(MAX_TRACE_TOTAL_BYTES - 2_048)

    const activeUser = "global-probe-active"
    const active = acquireTrace(store, activeUser, PRESET, "active-terminal")
    expect(active.accepted).toBe(true)
    if (!active.accepted) throw new Error("global capacity probe could not acquire")
    const beforeFailure = totalFillerBytes() + active.trace.bytes
    expect(finalizeTrace(store, activeUser, PRESET, "active-terminal", {
      sequence: 0,
      kind: "terminal",
      preview: "x".repeat(TRACE_PREVIEW_BYTES),
    })).toEqual({
      accepted: false,
      reason: "global-capacity",
    })
    expect(getTrace(store, activeUser, PRESET, "active-terminal")).toBeUndefined()
    expect(listActiveAdmissions(store.admission, activeUser, PRESET)).toHaveLength(0)
    expect(totalFillerBytes()).toBe(beforeFailure - active.trace.bytes)
    expect(acquireTrace(store, activeUser, PRESET, "active-terminal").accepted).toBe(true)
  })

  test("replaces retained cancelled traces for the same execution", () => {
    const store = new TraceStore()
    const executionId = "cancelled-replacement"
    expect(acquireTrace(store, USER_A, PRESET, executionId, { reason: "initial" }).accepted).toBe(true)
    const cancelled = cancelTrace(store, USER_A, PRESET, executionId)
    expect(cancelled.accepted).toBe(true)
    if (!cancelled.accepted) throw new Error("cancelled trace was not retained")
    expect(cancelled.trace.status).toBe("cancelled")
    expect(listActiveAdmissions(store.admission, USER_A, PRESET)).toHaveLength(0)

    const replacement = acquireTrace(store, USER_A, PRESET, executionId, { reason: "retry" })
    expect(replacement.accepted).toBe(true)
    if (!replacement.accepted) throw new Error("cancelled trace replacement was rejected")
    expect(replacement.trace.active).toBe(true)
    expect(replacement.trace.metadata.reason).toBe("retry")
    expect(listTraces(store, USER_A, PRESET)).toHaveLength(1)

    const finalized = finalizeTrace(store, USER_A, PRESET, executionId)
    expect(finalized.accepted).toBe(true)
    if (!finalized.accepted || !finalized.retained) throw new Error("cancelled replacement was not retained")
    expect(finalized.trace.status).toBe("completed")
    expect(finalized.trace.metadata.reason).toBe("retry")
    expect(listActiveAdmissions(store.admission, USER_A, PRESET)).toHaveLength(0)
    expect(listTraces(store, USER_A, PRESET)).toHaveLength(1)
  })
})

describe("same-user cross-preset eviction", () => {
  test("evicts the user's oldest retained trace before another user's trace", () => {
    const store = new TraceStore()
    const spreadPresets = ["spread-a", "spread-b", "spread-c", "spread-d", "spread-e"]
    const traceCounts = [20, 20, 20, 20, 19]
    const completeAt = (presetId: string, executionId: string): void => {
      const acquired = acquireTrace(store, USER_A, presetId, executionId)
      expect(acquired.accepted).toBe(true)
      expect(finalizeTrace(store, USER_A, presetId, executionId).accepted).toBe(true)
    }

    for (const [presetIndex, presetId] of spreadPresets.entries()) {
      const count = traceCounts[presetIndex]
      if (count === undefined) throw new Error("cross-preset trace count is missing")
      for (let index = 0; index < count; index += 1) {
        completeAt(presetId, `${presetId}-${index}`)
      }
    }
    complete(store, USER_B, "other-user")
    const beforeOther = getTrace(store, USER_B, PRESET, "other-user")
    if (beforeOther === undefined) throw new Error("other user's trace was not retained")

    const before = spreadPresets.flatMap(presetId => listTraces(store, USER_A, presetId))
    expect(before).toHaveLength(MAX_RETAINED_TRACES_GLOBAL - 1)
    const acquired = acquireTrace(store, USER_A, "spread-new", "new-execution")
    expect(acquired.accepted).toBe(true)
    if (!acquired.accepted) throw new Error("same-user cross-preset admission was rejected")

    expect(getTrace(store, USER_A, "spread-a", "spread-a-0")).toBeUndefined()
    expect(getTrace(store, USER_B, PRESET, "other-user")).toEqual(beforeOther)
    const allUserTraces = spreadPresets
      .concat("spread-new")
      .flatMap(presetId => listTraces(store, USER_A, presetId))
    expect(allUserTraces).toHaveLength(MAX_RETAINED_TRACES_GLOBAL - 1)
    expect(acquired.trace.active).toBe(true)
    expect(listActiveAdmissions(store.admission, USER_A, "spread-new")).toHaveLength(1)
    expect(
      allUserTraces.concat(listTraces(store, USER_B, PRESET)),
    ).toHaveLength(MAX_RETAINED_TRACES_GLOBAL)
  })
})
