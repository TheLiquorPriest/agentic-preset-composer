/**
 * The observable result of one APC execution.  The numeric values are ordered
 * from least to most severe so a latch can promote without knowing anything
 * about the work that produced a cause.
 */
export type OutcomeClass =
  | "success"
  | "optional-local"
  | "graph-fallback"
  | "selected-final-failure"
  | "parent-cancel"
  | "integrity-fatal"

export const OUTCOME_CLASS_RANK: Readonly<Record<OutcomeClass, number>> = Object.freeze({
  success: 0,
  "optional-local": 1,
  "graph-fallback": 2,
  "selected-final-failure": 3,
  "parent-cancel": 4,
  "integrity-fatal": 5,
})

/**
 * Graph fallback causes are intentionally ranked separately from outcome
 * classes.  A host-owned gate must win over a run-local failure even when the
 * latter is observed first.
 */
export const GRAPH_FALLBACK_CAUSE_RANK = Object.freeze({
  "host-gate": 7,
  "retrieval-dispatch-consent": 6,
  "capacity-config-graph-prefill": 5,
  "assembly-setup-storage-worker-transport-receipt": 4,
  "timeout-deadline": 3,
  "required-typed-run": 2,
  "guidance-workspace-fallback-validation": 1,
} as const)

export type GraphFallbackCauseCategory = keyof typeof GRAPH_FALLBACK_CAUSE_RANK

/** A location in the configured graph used for deterministic tie breaking. */
export interface OutcomeCauseLocation {
  readonly pipelineId?: string
  readonly stageId?: string
  readonly runId?: string
  readonly pipelineIndex?: number
  readonly stageIndex?: number
  readonly runIndex?: number
  /** Short aliases make locally-created causes less verbose. */
  readonly pipeline?: string | number
  readonly stage?: string | number
  readonly run?: string | number
}

export interface OutcomeCauseBase extends OutcomeCauseLocation {
  readonly code: string
  readonly detail?: string
  readonly message?: string
}

export interface SuccessCause extends OutcomeCauseBase {
  readonly class: "success"
}

export interface OptionalLocalCause extends OutcomeCauseBase {
  readonly class: "optional-local"
}

export interface GraphFallbackCause extends OutcomeCauseBase {
  readonly class: "graph-fallback"
  readonly category?: GraphFallbackCauseCategory
  /** Alias accepted for callers that name the field by its role. */
  readonly causeCategory?: GraphFallbackCauseCategory
}

export interface SelectedFinalFailureCause extends OutcomeCauseBase {
  readonly class: "selected-final-failure"
}

export interface ParentCancelCause extends OutcomeCauseBase {
  readonly class: "parent-cancel"
}

export interface IntegrityFatalCause extends OutcomeCauseBase {
  readonly class: "integrity-fatal"
}

/** Every observable cause is class-discriminated and carries a stable code. */
export type OutcomeCause =
  | SuccessCause
  | OptionalLocalCause
  | GraphFallbackCause
  | SelectedFinalFailureCause
  | ParentCancelCause
  | IntegrityFatalCause

export interface OutcomeSnapshot {
  readonly class: OutcomeClass
  readonly cause: OutcomeCause
}
const DANGEROUS_KEYS: Readonly<Record<string, number>> = Object.freeze({
  ["__proto__"]: 1,
  prototype: 1,
  constructor: 1,
})
const CAUSE_KEYS: Readonly<Record<string, true>> = Object.freeze({
  class: true,
  code: true,
  detail: true,
  message: true,
  category: true,
  causeCategory: true,
  pipelineId: true,
  stageId: true,
  runId: true,
  pipelineIndex: true,
  stageIndex: true,
  runIndex: true,
  pipeline: true,
  stage: true,
  run: true,
})

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function ownValue(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  if (descriptor === undefined || !("value" in descriptor)) {
    throw new TypeError(`Outcome cause property ${key} must be a data property`)
  }
  return descriptor.value
}

function isOutcomeClass(value: unknown): value is OutcomeClass {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(OUTCOME_CLASS_RANK, value)
}

function validateCauseRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError("Outcome cause must be a plain record")
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || DANGEROUS_KEYS[key] === 1 || CAUSE_KEYS[key] !== true) {
      throw new TypeError(`Outcome cause contains unsupported key ${String(key)}`)
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(`Outcome cause property ${key} must be a data property`)
    }
  }
  return value
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined
  const value = ownValue(record, key)
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`Outcome cause ${key} must be a non-empty string`)
  }
  return value
}

function optionalFiniteInteger(record: Record<string, unknown>, key: string): number | undefined {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined
  const value = ownValue(record, key)
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Outcome cause ${key} must be a non-negative safe integer`)
  }
  return value
}

function optionalSegment(record: Record<string, unknown>, key: string): string | number | undefined {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined
  const value = ownValue(record, key)
  if (typeof value === "string") {
    if (value.length === 0) throw new TypeError(`Outcome cause ${key} must not be empty`)
    return value
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value
  throw new TypeError(`Outcome cause ${key} must be a string or non-negative safe integer`)
}

function normalizeCategory(code: string): GraphFallbackCauseCategory | undefined {
  const normalized = code.toLowerCase().replace(/[\s_/]+/g, "-")
  if (
    normalized === "host-gate" ||
    normalized.includes("permission") ||
    normalized.includes("revision") ||
    normalized.includes("disable") ||
    normalized.includes("update") ||
    normalized.includes("host-gate")
  ) {
    return "host-gate"
  }
  if (
    normalized.includes("retrieval") ||
    normalized.includes("dispatch") ||
    normalized.includes("consent")
  ) {
    return "retrieval-dispatch-consent"
  }
  if (
    normalized.includes("capacity") ||
    normalized.includes("config") ||
    normalized.includes("graph") ||
    normalized.includes("prefill")
  ) {
    return "capacity-config-graph-prefill"
  }
  if (
    normalized.includes("assembly") ||
    normalized.includes("setup") ||
    normalized.includes("storage") ||
    normalized.includes("database") ||
    normalized.includes("load") ||
    normalized.includes("worker") ||
    normalized.includes("transport") ||
    normalized.includes("receipt") ||
    normalized.includes("internal") ||
    normalized.includes("security")
  ) {
    return "assembly-setup-storage-worker-transport-receipt"
  }
  if (normalized.includes("timeout") || normalized.includes("deadline")) {
    return "timeout-deadline"
  }
  if (
    normalized.includes("required") &&
    (normalized.includes("hook") ||
      normalized.includes("macro") ||
      normalized.includes("provider") ||
      normalized.includes("tool") ||
      normalized.includes("blank") ||
      normalized.includes("oversize") ||
      normalized.includes("typed-run"))
  ) {
    return "required-typed-run"
  }
  if (
    normalized.includes("guidance") ||
    normalized.includes("workspace") ||
    normalized.includes("fallback") ||
    normalized.includes("validation")
  ) {
    return "guidance-workspace-fallback-validation"
  }
  return undefined
}

function cloneCause(value: OutcomeCause): OutcomeCause {
  const record = validateCauseRecord(value)
  const classValue = ownValue(record, "class")
  const codeValue = ownValue(record, "code")
  if (!isOutcomeClass(classValue)) {
    throw new TypeError("Outcome cause class is invalid")
  }
  if (typeof codeValue !== "string" || codeValue.length === 0) {
    throw new TypeError("Outcome cause code must be a non-empty string")
  }

  const detail = optionalString(record, "detail")
  const message = optionalString(record, "message")
  const pipelineId = optionalString(record, "pipelineId")
  const stageId = optionalString(record, "stageId")
  const runId = optionalString(record, "runId")
  const pipelineIndex = optionalFiniteInteger(record, "pipelineIndex")
  const stageIndex = optionalFiniteInteger(record, "stageIndex")
  const runIndex = optionalFiniteInteger(record, "runIndex")
  const pipeline = optionalSegment(record, "pipeline")
  const stage = optionalSegment(record, "stage")
  const run = optionalSegment(record, "run")

  const hasCategory = Object.prototype.hasOwnProperty.call(record, "category")
  const hasCauseCategory = Object.prototype.hasOwnProperty.call(record, "causeCategory")
  let category: GraphFallbackCauseCategory | undefined
  let causeCategory: GraphFallbackCauseCategory | undefined
  if (classValue === "graph-fallback") {
    const suppliedCategory = hasCategory ? ownValue(record, "category") : undefined
    const suppliedCauseCategory = hasCauseCategory ? ownValue(record, "causeCategory") : undefined
    if (suppliedCategory !== undefined && typeof suppliedCategory !== "string") {
      throw new TypeError("Outcome cause category must be a string")
    }
    if (suppliedCauseCategory !== undefined && typeof suppliedCauseCategory !== "string") {
      throw new TypeError("Outcome causeCategory must be a string")
    }
    if (suppliedCategory !== undefined && !Object.prototype.hasOwnProperty.call(GRAPH_FALLBACK_CAUSE_RANK, suppliedCategory)) {
      throw new TypeError("Outcome cause category is invalid")
    }
    if (suppliedCauseCategory !== undefined && !Object.prototype.hasOwnProperty.call(GRAPH_FALLBACK_CAUSE_RANK, suppliedCauseCategory)) {
      throw new TypeError("Outcome causeCategory is invalid")
    }
    if (suppliedCategory !== undefined && suppliedCauseCategory !== undefined && suppliedCategory !== suppliedCauseCategory) {
      throw new TypeError("Outcome cause category aliases must agree")
    }
    category = (suppliedCategory as GraphFallbackCauseCategory | undefined) ?? normalizeCategory(codeValue)
    causeCategory = (suppliedCauseCategory as GraphFallbackCauseCategory | undefined) ?? category
  } else if (hasCategory || hasCauseCategory) {
    throw new TypeError("Outcome cause categories are only valid for graph fallback")
  }

  const copy: Record<string, unknown> = { class: classValue, code: codeValue }
  if (detail !== undefined) copy.detail = detail
  if (message !== undefined) copy.message = message
  if (pipelineId !== undefined) copy.pipelineId = pipelineId
  if (stageId !== undefined) copy.stageId = stageId
  if (runId !== undefined) copy.runId = runId
  if (pipelineIndex !== undefined) copy.pipelineIndex = pipelineIndex
  if (stageIndex !== undefined) copy.stageIndex = stageIndex
  if (runIndex !== undefined) copy.runIndex = runIndex
  if (pipeline !== undefined) copy.pipeline = pipeline
  if (stage !== undefined) copy.stage = stage
  if (run !== undefined) copy.run = run
  if (classValue === "graph-fallback") {
    if (category !== undefined) copy.category = category
    if (causeCategory !== undefined) copy.causeCategory = causeCategory
  }
  return Object.freeze(copy) as unknown as OutcomeCause
}


function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function compareSegments(left: string | number | undefined, right: string | number | undefined): number {
  if (left === undefined && right === undefined) return 0
  if (left === undefined) return 1
  if (right === undefined) return -1
  if (typeof left === "number" && typeof right === "number") return left - right
  if (typeof left === "string" && typeof right === "string") return compareStrings(left, right)
  return typeof left === "number" ? -1 : 1
}

function segment(cause: OutcomeCause, kind: "pipeline" | "stage" | "run"): string | number | undefined {
  if (kind === "pipeline") return cause.pipelineId ?? cause.pipeline ?? cause.pipelineIndex
  if (kind === "stage") return cause.stageId ?? cause.stage ?? cause.stageIndex
  return cause.runId ?? cause.run ?? cause.runIndex
}

function graphRank(cause: OutcomeCause): number {
  if (cause.class !== "graph-fallback") return 0
  const category = cause.category ?? cause.causeCategory ?? normalizeCategory(cause.code)
  return category === undefined ? 0 : GRAPH_FALLBACK_CAUSE_RANK[category]
}

/** Returns a positive value when `left` is the canonical winner. */
function compareCauses(left: OutcomeCause, right: OutcomeCause): number {
  const classRank = OUTCOME_CLASS_RANK[left.class] - OUTCOME_CLASS_RANK[right.class]
  if (classRank !== 0) return classRank

  const fallbackRank = graphRank(left) - graphRank(right)
  if (fallbackRank !== 0) return fallbackRank

  for (const kind of ["pipeline", "stage", "run"] as const) {
    const locationRank = compareSegments(segment(left, kind), segment(right, kind))
    if (locationRank !== 0) return -locationRank
  }
  return compareStrings(left.code, right.code) * -1
}

function makeSnapshot(cause: OutcomeCause): OutcomeSnapshot {
  const frozenCause = cloneCause(cause)
  return Object.freeze({ class: frozenCause.class, cause: frozenCause })
}

const INITIAL_CAUSE: OutcomeCause = Object.freeze({ class: "success", code: "SUCCESS" })
const INITIAL_SNAPSHOT: OutcomeSnapshot = Object.freeze({
  class: INITIAL_CAUSE.class,
  cause: INITIAL_CAUSE,
})

/**
 * Monotonic outcome selection.  Before commit, causes may promote the
 * canonical winner regardless of observation order.  Commit freezes that
 * winner exactly once; all later observations are no-ops.
 */
export class OutcomeLatch {
  private winner: OutcomeSnapshot | undefined
  private committedState = false

  public constructor(initialCause?: OutcomeCause) {
    this.winner = initialCause === undefined ? undefined : makeSnapshot(initialCause)
  }

  public get committed(): boolean {
    return this.committedState
  }

  public isCommitted(): boolean {
    return this.committedState
  }

  /**
   * Consider a cause and return whether it became the observable winner.
   * Inputs are copied and frozen, so later caller mutation cannot alter a
   * settled snapshot.  A committed latch intentionally ignores later input.
   */
  public consider(cause: OutcomeCause | null | undefined): boolean {
    if (this.committedState || cause === null || cause === undefined) return false
    const candidate = makeSnapshot(cause)
    if (this.winner === undefined || compareCauses(candidate.cause, this.winner.cause) > 0) {
      this.winner = candidate
      return true
    }
    return false
  }

  /**
   * Commit the canonical winner once.  Omitting a cause commits the
   * no-op/default success snapshot.  Repeated calls return the same immutable
   * snapshot and cannot reopen or replace the latch.
   */
  public commit(cause?: OutcomeCause | null): OutcomeSnapshot {
    if (this.committedState) return this.winner ?? INITIAL_SNAPSHOT
    if (cause !== null && cause !== undefined) this.consider(cause)
    this.winner ??= INITIAL_SNAPSHOT
    this.committedState = true
    return this.winner
  }

  public snapshot(): OutcomeSnapshot {
    return this.winner ?? INITIAL_SNAPSHOT
  }
}
