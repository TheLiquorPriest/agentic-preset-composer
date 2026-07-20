import {
  DEFAULT_RUN_TIMEOUT_MS,
  FINALIZATION_RESERVE_MS,
  GRAPH_DEADLINE_MS,
  HOST_INTERCEPTOR_WALL_MS,
  MAX_RUN_TIMEOUT_MS,
  MIN_RUN_TIMEOUT_MS,
} from "../config/limits"

export {
  DEFAULT_RUN_TIMEOUT_MS,
  FINALIZATION_RESERVE_MS,
  GRAPH_DEADLINE_MS,
  HOST_INTERCEPTOR_WALL_MS,
  MAX_RUN_TIMEOUT_MS,
  MIN_RUN_TIMEOUT_MS,
}

export interface HostDeadlineBinding {
  readonly interceptorDeadlineAt: number
  readonly boundWorkDeadlineAt?: number
}

type ParentDeadline = number | HostDeadlineBinding

function assertTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${label} must be a finite safe integer`)
}

function parentDeadline(parent: ParentDeadline): number {
  if (typeof parent === "number") return parent
  assertTimestamp(parent.interceptorDeadlineAt, "interceptorDeadlineAt")
  if (parent.boundWorkDeadlineAt !== undefined) {
    assertTimestamp(parent.boundWorkDeadlineAt, "boundWorkDeadlineAt")
    return Math.min(parent.interceptorDeadlineAt, parent.boundWorkDeadlineAt)
  }
  return parent.interceptorDeadlineAt
}

/**
 * Derive APC's one absolute graph deadline from the callback-owned host wall.
 * The callback's already-bound work deadline can only shorten this result.
 */
export function deriveGraphDeadline(entryAt: number, parent: ParentDeadline): number {
  assertTimestamp(entryAt, "entryAt")
  const interceptorDeadlineAt = parentDeadline(parent)
  const graphDeadlineAt = Math.min(
    entryAt + GRAPH_DEADLINE_MS,
    interceptorDeadlineAt - FINALIZATION_RESERVE_MS,
    typeof parent === "object" && parent.boundWorkDeadlineAt !== undefined
      ? parent.boundWorkDeadlineAt
      : Number.POSITIVE_INFINITY,
  )
  if (!Number.isSafeInteger(graphDeadlineAt) || graphDeadlineAt <= entryAt) {
    throw new RangeError("Deadline leaves no positive graph work window")
  }
  return graphDeadlineAt
}

/** Explicit callback-context spelling for callers holding host DTO fields. */
export function deriveCallbackGraphDeadline(
  entryAt: number,
  callback: HostDeadlineBinding,
): number {
  return deriveGraphDeadline(entryAt, callback)
}

/** Validate and return a run timeout in milliseconds. */
export function validateRunTimeout(timeoutMs: number): number {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < MIN_RUN_TIMEOUT_MS || timeoutMs > MAX_RUN_TIMEOUT_MS) {
    throw new RangeError(`Run timeout must be an integer from ${MIN_RUN_TIMEOUT_MS} to ${MAX_RUN_TIMEOUT_MS} ms`)
  }
  return timeoutMs
}

/**
 * Validate the serial critical path. Each inner array contains the runs in a
 * stage; a stage contributes its maximum run timeout, not the sum of parallel
 * runs. The deadline budget is absolute and measured from entryAt.
 */
export function validateCriticalPath(
  stageTimeouts: readonly (readonly number[])[],
  entryAt: number,
  deadlineAt: number,
): true {
  assertTimestamp(entryAt, "entryAt")
  assertTimestamp(deadlineAt, "deadlineAt")
  const budgetMs = deadlineAt - entryAt
  if (budgetMs <= 0) throw new RangeError("Critical-path deadline must leave a positive budget")

  let criticalPathMs = 0
  for (const stage of stageTimeouts) {
    if (stage.length === 0) throw new RangeError("Every critical-path stage must have a run")
    let stageMaximumMs = 0
    for (const timeoutMs of stage) {
      const validatedTimeoutMs = validateRunTimeout(timeoutMs)
      if (validatedTimeoutMs > stageMaximumMs) stageMaximumMs = validatedTimeoutMs
    }
    criticalPathMs += stageMaximumMs
    if (!Number.isSafeInteger(criticalPathMs) || criticalPathMs > budgetMs) {
      throw new RangeError("Stage critical path exceeds the graph deadline")
    }
  }
  return true
}

type AbortSignalLike = Pick<AbortSignal, "aborted" | "addEventListener" | "removeEventListener"> &
  Partial<Pick<AbortSignal, "reason">>

export interface ComposedAbortSignals {
  readonly signal: AbortSignal
  readonly dispose: () => void
}

/** Compose caller, graph, and run signals with idempotent listener cleanup. */
export function composeAbortSignals(signals: readonly AbortSignal[]): ComposedAbortSignals {
  const controller = new AbortController()
  const listeners: Array<{ readonly signal: AbortSignalLike; readonly listener: () => void }> = []
  let disposed = false
  let settled = false

  const removeListeners = (): void => {
    for (const entry of listeners) entry.signal.removeEventListener("abort", entry.listener)
    listeners.length = 0
  }

  const abortFrom = (source: AbortSignalLike): void => {
    if (disposed || settled) return
    settled = true
    removeListeners()
    controller.abort(source.reason)
  }

  const uniqueSignals: AbortSignalLike[] = []
  for (const signal of signals) {
    if (uniqueSignals.includes(signal)) continue
    uniqueSignals.push(signal)
  }

  for (const signal of uniqueSignals) {
    if (signal.aborted) {
      abortFrom(signal)
      break
    }
    const listener = (): void => abortFrom(signal)
    listeners.push({ signal, listener })
    signal.addEventListener("abort", listener, { once: true })
    if (signal.aborted) {
      abortFrom(signal)
      break
    }
  }

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    removeListeners()
  }

  return Object.freeze({ signal: controller.signal, dispose })
}
