// @ts-ignore Bun provides the test module at runtime; the extension bundle excludes this file.
import { describe, expect, test } from "bun:test"
import {
  createExecutionCancellation,
  type CancellationClock,
  type CancellationResourceSnapshot,
  type RunCancellation,
} from "./cancellation"

class TestClock implements CancellationClock {
  nowValue = 0
  #nextHandle = 1
  #timers = new Map<number, { readonly dueAt: number; readonly callback: () => void }>()
  #queuedNowValues: number[] = []

  now = (): number => {
    const queued = this.#queuedNowValues.shift()
    if (queued !== undefined) this.nowValue = queued
    return this.nowValue
  }

  setTimeout = (callback: () => void, delayMs: number): unknown => {
    const handle = this.#nextHandle++
    this.#timers.set(handle, { dueAt: this.nowValue + delayMs, callback })
    return handle
  }

  clearTimeout = (handle: unknown): void => {
    if (typeof handle === "number") this.#timers.delete(handle)
  }

  advance = (elapsedMs: number): void => {
    this.nowValue += elapsedMs
    while (true) {
      let nextHandle: number | undefined
      let nextDueAt = Number.POSITIVE_INFINITY
      for (const [handle, timer] of this.#timers) {
        if (timer.dueAt <= this.nowValue && timer.dueAt < nextDueAt) {
          nextHandle = handle
          nextDueAt = timer.dueAt
        }
      }
      if (nextHandle === undefined) return
      const timer = this.#timers.get(nextHandle)
      this.#timers.delete(nextHandle)
      timer?.callback()
    }
  }
  elapseWithoutTimers = (elapsedMs: number): void => {
    this.nowValue += elapsedMs
  }
  queueNowValues = (...values: number[]): void => {
    this.#queuedNowValues.push(...values)
  }

  pendingTimers = (): number => this.#timers.size
}

function graph(clock: TestClock, hostSignal = new AbortController().signal) {
  return createExecutionCancellation({
    hostSignal,
    deadlineAt: 300_000,
    clock,
  })
}

function expectEmpty(resources: CancellationResourceSnapshot): void {
  expect(resources).toEqual({ controllers: 0, listeners: 0, timers: 0, children: 0 })
}

describe("execution cancellation tree", () => {
  test("parent abort propagates to every child and releases execution resources", () => {
    const clock = new TestClock()
    const host = new AbortController()
    const execution = graph(clock, host.signal)
    const first = execution.createRun({ id: "first", timeoutMs: 1_000 })
    const second = execution.createRun({ id: "second", timeoutMs: 2_000 })

    expect(execution.isActive()).toBe(true)
    expect(first.isActive()).toBe(true)
    expect(second.isActive()).toBe(true)
    expect(execution.resourceSnapshot()).toEqual({ controllers: 3, listeners: 3, timers: 3, children: 2 })

    host.abort(new Error("host stopped"))

    expect(execution.signal.aborted).toBe(true)
    expect(execution.reason).toBe("host-abort")
    expect(first.signal.aborted).toBe(true)
    expect(second.signal.aborted).toBe(true)
    expect(first.reason).toBe("host-abort")
    expect(second.reason).toBe("host-abort")
    expectEmpty(execution.resourceSnapshot())
    expectEmpty(first.resourceSnapshot())
    expectEmpty(second.resourceSnapshot())
    expect(clock.pendingTimers()).toBe(0)
  })

  test("a child timeout is isolated from sibling runs and the graph parent", () => {
    const clock = new TestClock()
    const execution = graph(clock)
    const timedOut = execution.createRun({ id: "short", timeoutMs: 1_000 })
    const sibling = execution.createRun({ id: "long", timeoutMs: 2_000 })

    clock.advance(999)
    expect(timedOut.isActive()).toBe(true)
    expect(sibling.isActive()).toBe(true)

    clock.advance(1)
    expect(timedOut.signal.aborted).toBe(true)
    expect(timedOut.reason).toBe("child-timeout")
    expect(sibling.isActive()).toBe(true)
    expect(execution.isActive()).toBe(true)
    expect(execution.resourceSnapshot()).toEqual({ controllers: 2, listeners: 2, timers: 2, children: 1 })
    expect(clock.pendingTimers()).toBe(2)

    sibling.dispose()
    execution.dispose()
    expectEmpty(execution.resourceSnapshot())
    expect(clock.pendingTimers()).toBe(0)
  })

  test("Stop aborts the graph once and prevents later child creation from doing work", () => {
    const clock = new TestClock()
    const execution = graph(clock)
    const run = execution.createRun({ timeoutMs: 1_000 })

    expect(execution.stop("stop")).toBe(true)
    expect(execution.stop("stop")).toBe(false)
    expect(execution.reason).toBe("stop")
    expect(run.reason).toBe("stop")
    expect(execution.isActive()).toBe(false)

    const lateRun = execution.createRun({ timeoutMs: 1_000 })
    expect(lateRun.signal.aborted).toBe(true)
    expect(lateRun.reason).toBe("stop")
    expectEmpty(execution.resourceSnapshot())
    expectEmpty(lateRun.resourceSnapshot())
    expect(clock.pendingTimers()).toBe(0)
  })

  test("permission loss is a parent cancellation and cannot be revived", () => {
    const clock = new TestClock()
    const execution = graph(clock)
    const run = execution.createRun({ timeoutMs: 1_000 })

    expect(execution.permissionLost()).toBe(true)
    expect(execution.permissionLost()).toBe(false)
    expect(execution.reason).toBe("permission-revoked")
    expect(run.signal.aborted).toBe(true)
    expect(run.reason).toBe("permission-revoked")
    expect(execution.createRun().isActive()).toBe(false)
    expectEmpty(execution.resourceSnapshot())
    expect(clock.pendingTimers()).toBe(0)
  })

  test("concurrent disposal is idempotent for parent and children", () => {
    const clock = new TestClock()
    const execution = graph(clock)
    const first = execution.createRun({ timeoutMs: 1_000 })
    const second = execution.createRun({ timeoutMs: 2_000 })

    for (let index = 0; index < 5; index += 1) {
      first.dispose()
      second.dispose()
      execution.dispose()
    }

    expect(execution.signal.aborted).toBe(true)
    expect(execution.reason).toBe("disposed")
    expectEmpty(execution.resourceSnapshot())
    expectEmpty(first.resourceSnapshot())
    expectEmpty(second.resourceSnapshot())
    expect(clock.pendingTimers()).toBe(0)
  })

  test("late completion is rejected and cannot publish through the commit gate", async () => {
    const clock = new TestClock()
    const execution = graph(clock)
    const run: RunCancellation = execution.createRun({ timeoutMs: 1_000 })
    let resolveLate: ((value: string) => void) | undefined
    const pending = new Promise<string>((resolve) => {
      resolveLate = resolve
    })
    const completion = run.completion(pending)
    run.dispose()
    resolveLate?.("late provider response")

    const result = await completion
    expect(result).toEqual({ accepted: false, reason: "disposed" })
    expect(run.tryCommit(() => "workspace mutation")).toEqual({ accepted: false, reason: "disposed" })
    expectEmpty(run.resourceSnapshot())
    execution.dispose()
    expectEmpty(execution.resourceSnapshot())
    expect(clock.pendingTimers()).toBe(0)
  })

  test("rejects overdue settlements before a delayed timer callback runs", async () => {
    const clock = new TestClock()
    const execution = graph(clock)
    const fulfilledRun = execution.createRun({ timeoutMs: 1_000 })
    const rejectedRun = execution.createRun({ timeoutMs: 1_000 })
    let resolveLate: ((value: string) => void) | undefined
    let rejectLate: ((error: Error) => void) | undefined
    const fulfilled = fulfilledRun.completion(new Promise<string>((resolve) => {
      resolveLate = resolve
    }))
    const rejected = rejectedRun.completion(new Promise<string>((_resolve, reject) => {
      rejectLate = reject
    }))

    clock.elapseWithoutTimers(1_000)
    resolveLate?.("overdue provider response")
    rejectLate?.(new Error("overdue provider failure"))

    expect(await fulfilled).toEqual({ accepted: false, reason: "child-timeout" })
    expect(await rejected).toEqual({ accepted: false, reason: "child-timeout" })
    expect(fulfilledRun.tryCommit(() => "fulfilled mutation")).toEqual({ accepted: false, reason: "child-timeout" })
    expect(rejectedRun.tryCommit(() => "rejected mutation")).toEqual({ accepted: false, reason: "child-timeout" })
    expectEmpty(fulfilledRun.resourceSnapshot())
    expectEmpty(rejectedRun.resourceSnapshot())
    expect(execution.isActive()).toBe(true)
    execution.dispose()
    expectEmpty(execution.resourceSnapshot())
    expect(clock.pendingTimers()).toBe(0)
  })
  test("enforces the root deadline before a delayed timer callback runs", () => {
    const clock = new TestClock()
    const host = new AbortController()
    const execution = createExecutionCancellation({
      hostSignal: host.signal,
      deadlineAt: 1_000,
      clock,
    })
    let run: RunCancellation | undefined
    execution.signal.addEventListener("abort", () => run?.dispose(), { once: true })
    run = execution.createRun({ timeoutMs: 5_000 })
    if (run === undefined) throw new Error("root deadline run was not created")

    expect(execution.isActive()).toBe(true)
    expect(run.isActive()).toBe(true)
    clock.elapseWithoutTimers(1_000)

    expect(execution.isActive()).toBe(false)
    expect(execution.reason).toBe("deadline")
    expect(execution.signal.aborted).toBe(true)
    expect(execution.signal.reason).toBe("deadline")
    expect(run.isActive()).toBe(false)
    expect(run.reason).toBe("deadline")
    expect(run.signal.aborted).toBe(true)
    expect(run.tryCommit(() => "late mutation")).toEqual({ accepted: false, reason: "deadline" })
    expectEmpty(run.resourceSnapshot())
    expectEmpty(execution.resourceSnapshot())
    expect(clock.pendingTimers()).toBe(0)

    host.abort("late host abort")
    expect(execution.stop("stop")).toBe(false)
    execution.dispose()
    expect(execution.reason).toBe("deadline")
    const lateRun = execution.createRun({ timeoutMs: 1_000 })
    expect(lateRun.isActive()).toBe(false)
    expect(lateRun.reason).toBe("deadline")
    expectEmpty(lateRun.resourceSnapshot())
    expectEmpty(execution.resourceSnapshot())
  })
  test("lets the expired root deadline arbitrate every terminal entry point", () => {
    for (const terminal of ["stop", "host-abort", "dispose"] as const) {
      const clock = new TestClock()
      const host = new AbortController()
      const execution = createExecutionCancellation({
        hostSignal: host.signal,
        deadlineAt: 1_000,
        clock,
      })
      const run = execution.createRun({ timeoutMs: 5_000 })
      clock.elapseWithoutTimers(1_000)

      if (terminal === "stop") execution.stop("stop")
      else if (terminal === "host-abort") host.abort("late host abort")
      else execution.dispose()

      expect(execution.isActive()).toBe(false)
      expect(execution.reason).toBe("deadline")
      expect(execution.signal.reason).toBe("deadline")
      expect(run.isActive()).toBe(false)
      expect(run.reason).toBe("deadline")
      expect(run.signal.reason).toBe("deadline")
      expectEmpty(run.resourceSnapshot())
      expectEmpty(execution.resourceSnapshot())
      expect(clock.pendingTimers()).toBe(0)
      execution.dispose()
      expect(execution.reason).toBe("deadline")
    }
  })

  test("classifies a child created on the root boundary under root authority", () => {
    const clock = new TestClock()
    const execution = createExecutionCancellation({
      hostSignal: new AbortController().signal,
      deadlineAt: 1_000,
      clock,
    })
    clock.elapseWithoutTimers(999)
    clock.queueNowValues(999, 999, 1_000)

    const run = execution.createRun({ timeoutMs: 5_000 })

    expect(execution.isActive()).toBe(false)
    expect(execution.reason).toBe("deadline")
    expect(run.isActive()).toBe(false)
    expect(run.reason).toBe("deadline")
    expect(run.signal.reason).toBe("deadline")
    expectEmpty(run.resourceSnapshot())
    expectEmpty(execution.resourceSnapshot())
    expect(clock.pendingTimers()).toBe(0)
  })



  test("normal terminal cleanup leaves no retained cancellation resources", async () => {
    const clock = new TestClock()
    const execution = graph(clock)
    const run = execution.createRun({ timeoutMs: 1_000 })

    const result = await run.completion(Promise.resolve("provider response"))
    expect(result).toEqual({ accepted: true, value: "provider response" })
    expect(run.tryCommit(() => "published")).toEqual({ accepted: true, value: "published" })

    run.dispose()
    execution.dispose()
    expectEmpty(run.resourceSnapshot())
    expectEmpty(execution.resourceSnapshot())
    expect(clock.pendingTimers()).toBe(0)
  })

  test("derived deadlines use the host reserve and never extend the callback wall", () => {
    const clock = new TestClock()
    const host = new AbortController()
    const execution = createExecutionCancellation({
      hostSignal: host.signal,
      entryAt: 10_000,
      interceptorDeadlineAt: 301_000,
      clock,
    })

    expect(execution.deadlineAt).toBe(286_000)
    const run = execution.createRun({ deadlineAt: 500_000 })
    expect(run.deadlineAt).toBe(286_000)
    execution.dispose()
  })
})
