import { deriveGraphDeadline, validateRunTimeout } from "../runtime/deadline"

/**
 * A cancellation cause is deliberately closed.  The string is safe to expose
 * in traces and does not retain an arbitrary host error or worker value.
 */
export type CancellationReason =
  | "host-abort"
  | "deadline"
  | "stop"
  | "permission-revoked"
  | "replacement"
  | "disable"
  | "update"
  | "required-failure"
  | "integrity-fatal"
  | "disposed"
  | "child-timeout"

export interface CancellationClock {
  readonly now: () => number
  readonly setTimeout: (callback: () => void, delayMs: number) => unknown
  readonly clearTimeout: (handle: unknown) => void
}

export interface CancellationResourceSnapshot {
  readonly controllers: number
  readonly listeners: number
  readonly timers: number
  readonly children: number
}

export interface CancellationCompletion<T> {
  readonly accepted: true
  readonly value: T
}

export interface CancellationCompletionRejected {
  readonly accepted: false
  readonly reason: CancellationReason
}

export type CancellationCompletionResult<T> = CancellationCompletion<T> | CancellationCompletionRejected

export interface RunCancellation {
  readonly id: string
  readonly signal: AbortSignal
  readonly deadlineAt: number
  readonly reason: CancellationReason | undefined
  readonly isActive: () => boolean
  /**
   * Resolve a provider/assembly promise without allowing a cancelled or
   * disposed run to publish its late value.  Rejections from an active run are
   * deliberately rethrown so execution can classify the real provider error.
   */
  readonly completion: <T>(promise: PromiseLike<T>) => Promise<CancellationCompletionResult<T>>
  /**
   * Execute a synchronous publication only while the run is still live.  The
   * JavaScript turn is synchronous, so cancellation cannot interleave with the
   * guarded callback.
   */
  readonly tryCommit: <T>(commit: () => T) => CancellationCompletionResult<T>
  readonly resourceSnapshot: () => CancellationResourceSnapshot
  /** Abort this run and remove its listener/timer resources. */
  readonly dispose: () => void
}

export interface ExecutionCancellationOptions {
  /** Host-created callback signal. It is never replaced by an extension signal. */
  readonly hostSignal: AbortSignal
  /** Entry timestamp used when deriving a graph deadline from the host wall. */
  readonly entryAt?: number
  /** Host interceptor absolute deadline used by deriveGraphDeadline. */
  readonly interceptorDeadlineAt?: number
  /** Already-derived absolute graph deadline. It may already be expired. */
  readonly deadlineAt?: number
  readonly clock?: CancellationClock
}

export interface CreateRunCancellationOptions {
  readonly id?: string
  /** Configured run timeout, bounded by the shared deadline helper. */
  readonly timeoutMs?: number
  /** Absolute run deadline; it can only shorten the execution deadline. */
  readonly deadlineAt?: number
}

export interface ExecutionCancellation {
  readonly signal: AbortSignal
  readonly deadlineAt: number
  readonly reason: CancellationReason | undefined
  readonly isActive: () => boolean
  readonly createRun: (options?: CreateRunCancellationOptions) => RunCancellation
  /** Idempotently stop this graph and every live child run. */
  readonly stop: (reason?: CancellationReason) => boolean
  /** Permission revocation is a graph stop, not a local run failure. */
  readonly permissionLost: () => boolean
  /** Idempotently abort and release every execution-owned resource. */
  readonly dispose: () => void
  readonly resourceSnapshot: () => CancellationResourceSnapshot
}

const SYSTEM_CLOCK: CancellationClock = Object.freeze({
  now: (): number => Date.now(),
  setTimeout: (callback: () => void, delayMs: number): unknown => setTimeout(callback, delayMs),
  clearTimeout: (handle: unknown): void => clearTimeout(handle as number),
})

const CANCELLATION_REASONS: ReadonlySet<CancellationReason> = new Set([
  "host-abort",
  "deadline",
  "stop",
  "permission-revoked",
  "replacement",
  "disable",
  "update",
  "required-failure",
  "integrity-fatal",
  "disposed",
  "child-timeout",
])

function assertSignal(value: AbortSignal, label: string): void {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.addEventListener !== "function" ||
    typeof value.removeEventListener !== "function"
  ) {
    throw new TypeError(`${label} must be an AbortSignal`)
  }
}

function assertFiniteTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${label} must be a finite safe integer`)
}

function reasonOrDefault(value: unknown, fallback: CancellationReason): CancellationReason {
  return typeof value === "string" && CANCELLATION_REASONS.has(value as CancellationReason)
    ? (value as CancellationReason)
    : fallback
}

function freezeSnapshot(
  controllers: number,
  listeners: number,
  timers: number,
  children: number,
): CancellationResourceSnapshot {
  return Object.freeze({ controllers, listeners, timers, children })
}

function freezeCompletionRejected(reason: CancellationReason): CancellationCompletionRejected {
  return Object.freeze({ accepted: false as const, reason })
}

function freezeCompletion<T>(value: T): CancellationCompletion<T> {
  return Object.freeze({ accepted: true as const, value })
}

function resolveExecutionDeadline(options: ExecutionCancellationOptions, clock: CancellationClock): number {
  const explicitDeadline = options.deadlineAt
  if (explicitDeadline !== undefined) {
    assertFiniteTimestamp(explicitDeadline, "deadlineAt")
    return explicitDeadline
  }

  const entryAt = options.entryAt ?? clock.now()
  const interceptorDeadlineAt = options.interceptorDeadlineAt
  if (interceptorDeadlineAt === undefined) {
    throw new RangeError("An absolute deadlineAt or interceptorDeadlineAt is required")
  }
  assertFiniteTimestamp(entryAt, "entryAt")
  assertFiniteTimestamp(interceptorDeadlineAt, "interceptorDeadlineAt")
  return deriveGraphDeadline(entryAt, interceptorDeadlineAt)
}

function resolveChildDeadline(
  rootDeadlineAt: number,
  options: CreateRunCancellationOptions,
  now: number,
): { readonly deadlineAt: number; readonly timed: boolean } {
  let deadlineAt = rootDeadlineAt
  let timed = false

  if (options.deadlineAt !== undefined) {
    assertFiniteTimestamp(options.deadlineAt, "run deadlineAt")
    deadlineAt = Math.min(deadlineAt, options.deadlineAt)
    timed = deadlineAt < rootDeadlineAt
  }

  if (options.timeoutMs !== undefined) {
    const timeoutMs = validateRunTimeout(options.timeoutMs)
    const timeoutDeadlineAt = now + timeoutMs
    if (!Number.isSafeInteger(timeoutDeadlineAt)) {
      throw new RangeError("Run timeout produces an unsafe deadline")
    }
    if (timeoutDeadlineAt < deadlineAt) {
      deadlineAt = timeoutDeadlineAt
      timed = true
    }
  }

  return Object.freeze({ deadlineAt, timed })
}

interface ResourceState {
  controllers: number
  listeners: number
  timers: number
  children: number
}

interface TimerRecord {
  handle: unknown
  active: boolean
}

function snapshotOf(resources: ResourceState): CancellationResourceSnapshot {
  return freezeSnapshot(resources.controllers, resources.listeners, resources.timers, resources.children)
}

/**
 * Construct one callback-bound cancellation tree.  The host callback signal is
 * the sole parent authority; every child run has its own AbortController and
 * timer, and no child can extend the graph deadline.
 */
export function createExecutionCancellation(options: ExecutionCancellationOptions): ExecutionCancellation {
  if (!options || typeof options !== "object") throw new TypeError("Cancellation options are required")
  assertSignal(options.hostSignal, "hostSignal")
  const clock = options.clock ?? SYSTEM_CLOCK
  if (
    !clock ||
    typeof clock.now !== "function" ||
    typeof clock.setTimeout !== "function" ||
    typeof clock.clearTimeout !== "function"
  ) {
    throw new TypeError("clock must provide now, setTimeout, and clearTimeout")
  }

  const deadlineAt = resolveExecutionDeadline(options, clock)
  const initialRootController = new AbortController()
  let rootController: AbortController | undefined = initialRootController
  const rootSignal = initialRootController.signal
  const resources: ResourceState = { controllers: 1, listeners: 0, timers: 0, children: 0 }
  const children = new Set<RunState>()
  let rootAborted = false
  let rootDisposed = false
  let rootReason: CancellationReason | undefined
  let rootHostListener: (() => void) | undefined
  let rootTimer: TimerRecord | undefined
  let nextRunId = 1

  const removeRootListener = (): void => {
    if (rootHostListener === undefined) return
    options.hostSignal.removeEventListener("abort", rootHostListener)
    rootHostListener = undefined
    if (resources.listeners > 0) resources.listeners -= 1
  }

  const clearRootTimer = (): void => {
    const timer = rootTimer
    if (timer === undefined || !timer.active) return
    timer.active = false
    clock.clearTimeout(timer.handle)
    rootTimer = undefined
    if (resources.timers > 0) resources.timers -= 1
  }

  const detachRootResources = (): void => {
    removeRootListener()
    clearRootTimer()
    resources.children = 0
    resources.controllers = 0
    resources.listeners = 0
    resources.timers = 0
    children.clear()
  }

  const rootIsActive = (): boolean => !rootAborted && !rootDisposed

  const rootReasonOrDisposed = (): CancellationReason => rootReason ?? "disposed"

  const abortRoot = (reason: CancellationReason): boolean => {
    if (rootAborted || rootDisposed) return false
    rootAborted = true
    rootReason = reason
    const controller = rootController
    if (controller !== undefined) controller.abort(reason)
    rootController = undefined
    // Child parent listeners run synchronously from rootController.abort().
    // The explicit pass handles fake/non-DOM signals and keeps teardown
    // deterministic if a child listener was concurrently removed.
    for (const child of [...children]) child.abortFromParent(reason)
    detachRootResources()
    return true
  }

  const onRootHostAbort = (): void => {
    abortRoot(reasonOrDefault(options.hostSignal.reason, "host-abort"))
  }

  if (options.hostSignal.aborted) {
    rootAborted = true
    rootReason = reasonOrDefault(options.hostSignal.reason, "host-abort")
    const controller = rootController
    if (controller !== undefined) controller.abort(rootReason)
    rootController = undefined
    detachRootResources()
  } else if (deadlineAt <= clock.now()) {
    abortRoot("deadline")
  } else {
    rootHostListener = onRootHostAbort
    options.hostSignal.addEventListener("abort", rootHostListener, { once: true })
    resources.listeners += 1

    const delayMs = Math.max(0, deadlineAt - clock.now())
    const record: TimerRecord = { handle: undefined, active: true }
    rootTimer = record
    resources.timers += 1
    const handle = clock.setTimeout(() => {
      if (rootTimer !== record || !record.active) return
      record.active = false
      rootTimer = undefined
      if (resources.timers > 0) resources.timers -= 1
      abortRoot("deadline")
    }, delayMs)
    record.handle = handle
    if (!record.active) clock.clearTimeout(handle)
  }

  class RunState implements RunCancellation {
    readonly id: string
    readonly deadlineAt: number
    readonly signal: AbortSignal
    #controller: AbortController | undefined
    #parentListener: (() => void) | undefined
    #timer: TimerRecord | undefined
    #completionSettlers = new Set<() => void>()
    #aborted = false
    #disposed = false
    #reason: CancellationReason | undefined
    #registered = false

    constructor(id: string, runDeadlineAt: number, timed: boolean) {
      this.id = id
      this.deadlineAt = runDeadlineAt
      this.#controller = new AbortController()
      this.signal = this.#controller.signal

      if (!rootIsActive()) {
        this.#aborted = true
        this.#reason = rootReasonOrDisposed()
        this.#controller.abort(this.#reason)
        this.#controller = undefined
        return
      }

      this.#registered = true
      children.add(this)
      resources.children += 1
      resources.controllers += 1
      this.#parentListener = (): void => this.abortFromParent(rootReasonOrDisposed())
      rootSignal.addEventListener("abort", this.#parentListener, { once: true })
      resources.listeners += 1

      if (rootSignal.aborted) {
        this.abortFromParent(rootReasonOrDisposed())
      } else if (runDeadlineAt <= clock.now()) {
        this.abortFromParent("child-timeout")
      } else if (timed) {
        const delayMs = Math.max(0, runDeadlineAt - clock.now())
        const record: TimerRecord = { handle: undefined, active: true }
        this.#timer = record
        resources.timers += 1
        const handle = clock.setTimeout(() => {
          if (this.#timer !== record || !record.active) return
          record.active = false
          this.#timer = undefined
          if (resources.timers > 0) resources.timers -= 1
          this.abortFromParent("child-timeout")
        }, delayMs)
        record.handle = handle
        if (!record.active) clock.clearTimeout(handle)
      }
    }

    get reason(): CancellationReason | undefined {
      return this.#reason
    }

    isActive = (): boolean => !this.#aborted && !this.#disposed && rootIsActive()

    resourceSnapshot = (): CancellationResourceSnapshot =>
      freezeSnapshot(
        this.#controller === undefined ? 0 : 1,
        (this.#parentListener === undefined ? 0 : 1) + this.#completionSettlers.size,
        this.#timer?.active ? 1 : 0,
        0,
      )

    #settleCompletions(): void {
      for (const settle of [...this.#completionSettlers]) settle()
    }

    #removeParentListener(): void {
      if (this.#parentListener === undefined) return
      rootSignal.removeEventListener("abort", this.#parentListener)
      this.#parentListener = undefined
      if (resources.listeners > 0) resources.listeners -= 1
    }

    #clearTimer(): void {
      const timer = this.#timer
      if (timer === undefined || !timer.active) return
      timer.active = false
      clock.clearTimeout(timer.handle)
      this.#timer = undefined
      if (resources.timers > 0) resources.timers -= 1
    }

    #detach(): void {
      this.#settleCompletions()
      this.#removeParentListener()
      this.#clearTimer()
      if (this.#registered) {
        this.#registered = false
        children.delete(this)
        if (resources.children > 0) resources.children -= 1
        if (resources.controllers > 0) resources.controllers -= 1
      }
      this.#controller = undefined
    }

    abortFromParent(reason: CancellationReason): void {
      this.#abortInternal(reason)
    }

    #abortInternal(reason: CancellationReason): boolean {
      if (this.#aborted || this.#disposed) return false
      this.#aborted = true
      this.#reason = reason
      const controller = this.#controller
      if (controller !== undefined) controller.abort(reason)
      this.#settleCompletions()
      this.#detach()
      return true
    }

    tryCommit = <T>(commit: () => T): CancellationCompletionResult<T> => {
      if (!this.isActive()) return freezeCompletionRejected(this.#reason ?? rootReasonOrDisposed())
      return freezeCompletion(commit())
    }

    completion = <T>(promise: PromiseLike<T>): Promise<CancellationCompletionResult<T>> => {
      const wrapped = Promise.resolve(promise)
      if (!this.isActive()) {
        void wrapped.catch(() => undefined)
        return Promise.resolve(freezeCompletionRejected(this.#reason ?? rootReasonOrDisposed()))
      }

      let settled = false
      let listener: (() => void) | undefined
      let settleCancelled: (() => void) | undefined
      let resolveResult: ((result: CancellationCompletionResult<T>) => void) | undefined
      let rejectResult: ((error: unknown) => void) | undefined
      const cleanup = (): void => {
        if (listener !== undefined) {
          this.signal.removeEventListener("abort", listener)
          listener = undefined
          if (resources.listeners > 0) resources.listeners -= 1
        }
        if (settleCancelled !== undefined) this.#completionSettlers.delete(settleCancelled)
      }
      const result = new Promise<CancellationCompletionResult<T>>((resolve, reject) => {
        resolveResult = resolve
        rejectResult = reject
      })
      settleCancelled = (): void => {
        if (settled) return
        settled = true
        cleanup()
        resolveResult?.(freezeCompletionRejected(this.#reason ?? rootReasonOrDisposed()))
      }
      this.#completionSettlers.add(settleCancelled)
      listener = (): void => settleCancelled?.()
      resources.listeners += 1
      this.signal.addEventListener("abort", listener, { once: true })
      if (!this.isActive()) settleCancelled()

      void wrapped.then(
        (value) => {
          if (settled) return
          settled = true
          cleanup()
          if (!this.isActive()) {
            resolveResult?.(freezeCompletionRejected(this.#reason ?? rootReasonOrDisposed()))
          } else {
            resolveResult?.(freezeCompletion(value))
          }
        },
        (error: unknown) => {
          if (settled) return
          settled = true
          cleanup()
          if (!this.isActive()) {
            resolveResult?.(freezeCompletionRejected(this.#reason ?? rootReasonOrDisposed()))
          } else {
            rejectResult?.(error)
          }
        },
      )
      return result
    }

    dispose = (): void => {
      if (this.#disposed) return
      this.#disposed = true
      if (!this.#aborted) {
        this.#aborted = true
        this.#reason = "disposed"
        const controller = this.#controller
        if (controller !== undefined) controller.abort("disposed")
      }
      this.#settleCompletions()
      this.#detach()
    }
  }

  const createRun = (runOptions: CreateRunCancellationOptions = {}): RunCancellation => {
    if (!runOptions || typeof runOptions !== "object") throw new TypeError("run options must be an object")
    const id = runOptions.id ?? `run-${nextRunId++}`
    if (typeof id !== "string" || id.length === 0) throw new TypeError("run id must be a non-empty string")
    const resolved = resolveChildDeadline(deadlineAt, runOptions, clock.now())
    return new RunState(id, resolved.deadlineAt, resolved.timed)
  }

  const stop = (reason: CancellationReason = "stop"): boolean => {
    if (!CANCELLATION_REASONS.has(reason)) throw new TypeError("Unknown cancellation reason")
    return abortRoot(reason)
  }

  const dispose = (): void => {
    if (rootDisposed) return
    rootDisposed = true
    if (!rootAborted) {
      rootAborted = true
      rootReason = "disposed"
      const controller = rootController
      if (controller !== undefined) controller.abort("disposed")
      rootController = undefined
      for (const child of [...children]) child.abortFromParent("disposed")
    }
    detachRootResources()
  }

  return Object.freeze({
    signal: rootSignal,
    deadlineAt,
    get reason(): CancellationReason | undefined {
      return rootReason
    },
    isActive: rootIsActive,
    createRun,
    stop,
    permissionLost: (): boolean => stop("permission-revoked"),
    dispose,
    resourceSnapshot: (): CancellationResourceSnapshot => snapshotOf(resources),
  })
}

export const createRunCancellation = (
  parent: ExecutionCancellation,
  options?: CreateRunCancellationOptions,
): RunCancellation => parent.createRun(options)
