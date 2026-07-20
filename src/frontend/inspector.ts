import type { ApcCatalogKey, ApcTranslate } from "../i18n/catalogs"
import { truncateUtf8, utf8Bytes } from "../config/limits"
import type { WorkspaceSource } from "../protocol/messages"
import type { OutcomeClass } from "../runtime/outcome"
import { createLiveRegion, focusElement, type LiveRegion } from "./accessibility"
import { listen, setAttributes, setText, type Cleanup } from "./dom"

/** Execution states exposed by the safe frontend activity projection. */
export type InspectorExecutionStatus =
  | "idle"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed-out"

export type InspectorStageStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed-out"
  | "skipped"

export type InspectorRunStatus = InspectorStageStatus
export type InspectorView = "idle" | "selected-thread" | "selected-run" | "execution"
export type InspectorErrorCategory =
  | "connection"
  | "consent"
  | "timeout"
  | "permission"
  | "graph"
  | "provider"
  | "integrity"
  | "cancelled"
  | "unknown"

/**
 * Error projection accepted by the view. Arbitrary backend messages, codes, and
 * detail payloads are intentionally not part of this surface.
 */
export interface InspectorSafeError {
  readonly category?: InspectorErrorCategory
  readonly messageKey?: ApcCatalogKey
}

export interface InspectorDeadlineSnapshot {
  readonly remainingMs?: number
  readonly elapsedMs?: number
  readonly timeoutMs?: number
  readonly phase?: "working" | "draining" | "expired"
}

export interface InspectorCancellationSnapshot {
  readonly requested?: boolean
  readonly reason?: "user" | "stop" | "replacement" | "timeout"
  readonly acknowledged?: boolean
}

export interface InspectorDispatchDescriptor {
  /** Human-readable, UI-local destination label. */
  readonly label?: string
  readonly provider?: string
  readonly model?: string
}

/** Safe, human-readable dispatch projection. */
export interface InspectorDispatchProvenance {
  readonly source: "main" | "slot"
  readonly descriptor?: InspectorDispatchDescriptor
  readonly status?: "pending" | "dispatched" | "completed" | "failed" | "cancelled"
}

export interface InspectorInputSourceSummary {
  readonly kind: "earlier-output" | "literal" | "main-context"
  readonly label?: string
  readonly roleLabel?: string
  readonly required?: boolean
  readonly missingPolicy?: "fail-graph" | "skip-run" | "omit-binding"
}

export interface InspectorOutputSummary {
  readonly label?: string
  readonly available?: boolean
}

export interface InspectorRunSnapshot {
  readonly label?: string
  readonly threadLabel?: string
  readonly stageLabel?: string
  readonly roleLabel?: string
  readonly index?: number
  readonly status: InspectorRunStatus
  readonly optional?: boolean
  readonly selected?: boolean
  readonly error?: InspectorSafeError
  readonly deadline?: InspectorDeadlineSnapshot
  readonly dispatch?: InspectorDispatchProvenance
  readonly inputSources?: readonly InspectorInputSourceSummary[]
  readonly output?: InspectorOutputSummary
  readonly startedAt?: number
  readonly finishedAt?: number
}

export interface InspectorStageSnapshot {
  readonly label?: string
  readonly index?: number
  readonly status: InspectorStageStatus
  readonly runs?: readonly InspectorRunSnapshot[]
  readonly error?: InspectorSafeError
}

export interface InspectorSelectionSnapshot {
  readonly kind: "thread" | "run"
  readonly threadLabel?: string
  readonly workspaceSource?: WorkspaceSource
  readonly stageLabel?: string
  readonly stageIndex?: number
  readonly run?: InspectorRunSnapshot
}

export interface InspectorProgressSnapshot {
  /** One-based stage position. */
  readonly stageIndex?: number
  readonly stageCount?: number
  readonly completedRuns?: number
  readonly totalRuns?: number
  /** Percentage in the inclusive range 0–100. */
  readonly percent?: number
}

export interface InspectorUsageSnapshot {
  readonly input?: number
  readonly output?: number
  readonly total?: number
}

export interface InspectorActivityItem {
  readonly status: InspectorRunStatus
  readonly threadLabel?: string
  readonly stageLabel?: string
  readonly runLabel?: string
  readonly elapsedMs?: number
  readonly error?: InspectorSafeError
}

export type InspectorTraceStatus = Exclude<InspectorRunStatus, "pending" | "skipped">

/** Safe trace event projection; protocol identities never cross this boundary. */
export interface InspectorTraceEvent {
  readonly sequence?: number
  readonly timestamp?: number
  readonly kind?: string
  readonly status?: InspectorTraceStatus
  readonly preview?: string
}

/** Trace summary keyed only by the frontend's opaque, non-protocol key. */
export interface InspectorTraceSummary {
  readonly key: string
  readonly status: InspectorTraceStatus
  readonly startedAt?: number
  readonly finishedAt?: number
  readonly eventCount: number
  readonly preview?: string
  readonly truncated?: boolean
}

export interface InspectorTraceDetail extends InspectorTraceSummary {
  readonly events: readonly InspectorTraceEvent[]
}


export interface InspectorFinalRouteSnapshot {
  readonly target: "main" | "thread"
  readonly targetLabel?: string
  readonly delivered?: boolean
  readonly retainedCompletedRuns?: number
  readonly dispatch?: InspectorDispatchProvenance
}

export interface InspectorFallbackSnapshot {
  readonly category?: InspectorErrorCategory
  readonly mainResponded: boolean
}

export interface InspectorOutcomeInput {
  readonly class: OutcomeClass
  readonly category?: InspectorErrorCategory
}

export interface InspectorOutcomeSnapshot {
  readonly class: OutcomeClass
  readonly category: InspectorErrorCategory
}

/** Safe right-pane view model. Every identity is an explicit human label. */
export interface ExecutionInspectorSnapshot {
  readonly view?: InspectorView
  readonly status: InspectorExecutionStatus
  readonly terminal?: boolean
  readonly selection?: InspectorSelectionSnapshot
  readonly outcome?: InspectorOutcomeInput
  readonly outcomes?: readonly InspectorOutcomeInput[]
  readonly stages?: readonly InspectorStageSnapshot[]
  readonly progress?: InspectorProgressSnapshot
  readonly deadline?: InspectorDeadlineSnapshot
  readonly cancellation?: InspectorCancellationSnapshot
  readonly stoppable?: boolean
  readonly currentDispatch?: InspectorDispatchProvenance
  readonly usage?: InspectorUsageSnapshot
  readonly activity?: readonly InspectorActivityItem[]
  readonly traces?: readonly InspectorTraceSummary[]
  readonly traceDetails?: Readonly<Record<string, InspectorTraceDetail>>
  readonly finalRoute?: InspectorFinalRouteSnapshot
  readonly fallback?: InspectorFallbackSnapshot
  readonly canUseMainFallback?: boolean
  readonly error?: InspectorSafeError
  readonly errors?: readonly InspectorSafeError[]
}

export interface ExecutionInspectorOptions {
  readonly t: ApcTranslate
  readonly locale?: string | (() => string)
  readonly document?: Document
  readonly snapshot?: ExecutionInspectorSnapshot
  readonly initialSnapshot?: ExecutionInspectorSnapshot
  readonly maxItems?: number
  readonly announce?: (message: string) => void
  readonly focus?: (element: HTMLElement) => void
  readonly onStop?: () => void | Promise<void>
  /** Explicitly changes configuration; it does not retry an execution. */
  readonly onUseMainFallback?: () => void | Promise<void>
  readonly onLoadTraces?: () => void | Promise<void>
  readonly onLoadTrace?: (key: string) => void | Promise<void>
}

export interface ExecutionInspectorController {
  readonly element: HTMLElement
  render(snapshot: ExecutionInspectorSnapshot): void
  destroy(): void
}

const TERMINAL_STATUSES: Readonly<Record<InspectorExecutionStatus, boolean>> = Object.freeze({
  idle: false,
  running: false,
  completed: true,
  failed: true,
  cancelled: true,
  "timed-out": true,
})
const DEFAULT_MAX_ITEMS = 8
const ABSOLUTE_MAX_ITEMS = 32
const MAX_STAGE_ITEMS = 32
const MAX_RUN_ITEMS = 64
const MAX_TRACE_EVENTS = 64
const MAX_TRACE_PREVIEW_BYTES = 2_048
const MAX_SAFE_TEXT_BYTES = 4_096
const MAX_LABEL_BYTES = 256
const MAX_TRACE_KEY_BYTES = 128
const TRACE_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu
const AUTHORIZATION_VALUE = /\bauthorization\s*[:=]\s*(?:bearer|basic)\s+[^\s,;]+/giu
const SECRET_VALUE =
  /\b(?:password|passphrase|secret|token|api[\s_-]*key|access[\s_-]*token|refresh[\s_-]*token|credential|authorization|bearer|cookie)s?\b\s*[:=]?\s*[^\s,;]+/giu
const ENDPOINT_FIELD = /\b(?:endpoint|base(?:[_-]?url)?|server(?:[_-]?url)?|url)\s*[:=]\s*[^\s,;]+/giu
const ENDPOINT_VALUE = /\b(?:https?|wss?|ftp):\/\/[^\s<>"'`]+/giu
const RAW_PAYLOAD = /^\s*(?:\{[\s\S]*\}|\[[\s\S]*\])\s*$/u
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu
const OPAQUE_IDENTIFIER = /^(?:[0-9a-f]{24,}|[A-Za-z0-9_-]{32,})$/u
const SAFE_ERROR_MESSAGE_KEYS: Readonly<Partial<Record<ApcCatalogKey, true>>> = Object.freeze({
  "error.graph": true,
  "error.connection": true,
  "error.timeout": true,
  "error.persistConfigFallback": true,
  "error.configNotHydrated": true,
  "error.staleConfigReload": true,
  "error.presetNotHydrated": true,
  "error.frontendDisposed": true,
  "error.persistenceDisposed": true,
  "error.inactivePreset": true,
  "error.traceDetailForList": true,
  "error.traceListForDetail": true,
  "error.noDomainTransport": true,
  "error.presetChangedBeforeSave": true,
  "error.revisionChangedBeforeSave": true,
  "error.presetChangedDuringSave": true,
  "permission.required": true,
  "permission.denied": true,
  "permission.revoked": true,
  "outcome.integrityFailure": true,
  "execution.cancelled": true,
  "diagnostic.unknown": true,
})

function isOutcomeClass(value: unknown): value is OutcomeClass {
  return value === "success" ||
    value === "optional-local" ||
    value === "graph-fallback" ||
    value === "selected-final-failure" ||
    value === "parent-cancel" ||
    value === "integrity-fatal"
}

const OUTCOME_RANK: Readonly<Record<OutcomeClass, number>> = Object.freeze({
  success: 0,
  "optional-local": 1,
  "graph-fallback": 2,
  "selected-final-failure": 3,
  "parent-cancel": 4,
  "integrity-fatal": 5,
})

/** Select the canonical safe outcome projection. */
export function selectInspectorOutcome(snapshot: ExecutionInspectorSnapshot): InspectorOutcomeSnapshot {
  let selected = snapshot.outcome !== undefined && isOutcomeClass(snapshot.outcome.class)
    ? snapshot.outcome
    : undefined
  const candidates: readonly InspectorOutcomeInput[] = Array.isArray(snapshot.outcomes)
    ? snapshot.outcomes as readonly InspectorOutcomeInput[]
    : []
  for (const candidate of candidates) {
    if (!isOutcomeClass(candidate?.class)) continue
    if (selected === undefined || OUTCOME_RANK[candidate.class] > OUTCOME_RANK[selected.class]) selected = candidate
  }
  if (selected !== undefined) {
    return Object.freeze({
      class: selected.class,
      category: selected.category ?? "unknown",
    })
  }
  if (snapshot.status === "cancelled") return Object.freeze({ class: "parent-cancel", category: "cancelled" })
  if (snapshot.status === "timed-out") return Object.freeze({ class: "graph-fallback", category: "timeout" })
  if (snapshot.status === "failed") return Object.freeze({ class: "graph-fallback", category: "graph" })
  return Object.freeze({ class: "success", category: "unknown" })
}

export function isInspectorTerminal(snapshot: ExecutionInspectorSnapshot): boolean {
  return snapshot.terminal === true || TERMINAL_STATUSES[snapshot.status] === true
}

function redactSensitiveText(value: string): string {
  const cleaned = value
    .replace(CONTROL_CHARACTERS, "")
    .replace(AUTHORIZATION_VALUE, "[redacted]")
    .replace(SECRET_VALUE, "[redacted]")
    .replace(ENDPOINT_FIELD, "[redacted]")
    .replace(ENDPOINT_VALUE, "[redacted]")
  return RAW_PAYLOAD.test(cleaned) ? "[redacted]" : cleaned
}

function boundedText(value: unknown, maxBytes: number): string {
  const limit = Math.max(0, Math.floor(Number.isFinite(maxBytes) ? maxBytes : 0))
  const cleaned = redactSensitiveText(typeof value === "string" ? value : "")
  if (utf8Bytes(cleaned) <= limit) return cleaned
  if (limit === 0) return ""
  const ellipsis = "…"
  if (limit <= utf8Bytes(ellipsis)) return ellipsis
  return `${truncateUtf8(cleaned, limit - utf8Bytes(ellipsis))}${ellipsis}`
}

/** Bounded, credential-redacted text for non-DOM diagnostic consumers. */
export function truncateInspectorText(value: string, maxBytes = MAX_SAFE_TEXT_BYTES): string {
  return boundedText(value, maxBytes)
}

function displayLabel(value: unknown, t: ApcTranslate): string {
  const text = boundedText(value, MAX_LABEL_BYTES).trim()
  if (!text || text === "[redacted]" || UUID.test(text) || OPAQUE_IDENTIFIER.test(text)) {
    return t("diagnostic.unknown")
  }
  return text
}
function safeTraceKey(value: unknown): string | undefined {
  const key = boundedText(value, MAX_TRACE_KEY_BYTES)
  return key.length > 0 && key === value && TRACE_KEY.test(key) ? key : undefined
}

function optionalLabel(value: unknown, t: ApcTranslate): string | undefined {
  const text = boundedText(value, MAX_LABEL_BYTES).trim()
  if (!text || text === "[redacted]" || UUID.test(text) || OPAQUE_IDENTIFIER.test(text)) return undefined
  return text || t("diagnostic.unknown")
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function boundedItems(value: unknown): number {
  const count = positiveInteger(value)
  return Math.min(count ?? DEFAULT_MAX_ITEMS, ABSOLUTE_MAX_ITEMS)
}

function createElement<K extends keyof HTMLElementTagNameMap>(
  documentRef: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = documentRef.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) setText(node, text)
  return node
}

function createSection(documentRef: Document, key: string, title: string): HTMLElement {
  const node = createElement(documentRef, "section", "apc-inspector-section")
  node.dataset.inspectorSection = key
  node.append(createElement(documentRef, "h3", "apc-inspector-section-title", title))
  return node
}

function appendField(documentRef: Document, parent: HTMLElement, label: string, value: string, key: string): void {
  const row = createElement(documentRef, "p", "apc-inspector-field")
  row.dataset.inspectorField = key
  row.append(
    createElement(documentRef, "span", "apc-inspector-field-label", label),
    createElement(documentRef, "span", "apc-inspector-field-value", value),
  )
  parent.append(row)
}

function badge(documentRef: Document, label: string, kind: string): HTMLElement {
  const node = createElement(documentRef, "span", "apc-inspector-badge", label)
  node.dataset.badgeKind = kind
  return node
}

function statusLabel(status: InspectorExecutionStatus | InspectorStageStatus, t: ApcTranslate): string {
  switch (status) {
    case "running": return t("inspector.statusRunning")
    case "pending": return t("inspector.statusPending")
    case "completed": return t("inspector.statusCompleted")
    case "failed": return t("inspector.statusFailed")
    case "cancelled": return t("inspector.statusCancelled")
    case "timed-out": return t("inspector.statusTimedOut")
    case "skipped": return t("inspector.statusSkipped")
    case "idle": return t("inspector.statusPending")
    default: return t("inspector.statusUnknown")
  }
}

function outcomeLabel(outcome: OutcomeClass, t: ApcTranslate): string {
  switch (outcome) {
    case "integrity-fatal": return t("outcome.integrityFailure")
    case "parent-cancel": return t("outcome.parentCancelled")
    case "selected-final-failure": return t("outcome.selectedFinalFailed")
    case "graph-fallback": return t("fallback.title")
    case "optional-local": return t("outcome.optionalLocalFailure")
    case "success": return t("outcome.success")
  }
}

function workspaceLabel(source: WorkspaceSource | undefined, t: ApcTranslate): string {
  if (source === "native-blocks") return t("workspace.nativeBlocks")
  if (source === "main-context") return t("workspace.mainContext")
  return t("diagnostic.unknown")
}

function sourceKindLabel(kind: InspectorInputSourceSummary["kind"], t: ApcTranslate): string {
  if (kind === "earlier-output") return t("binding.output")
  if (kind === "literal") return t("binding.literal")
  return t("workspace.mainContext")
}

function missingPolicyLabel(policy: InspectorInputSourceSummary["missingPolicy"], t: ApcTranslate): string | undefined {
  if (policy === "fail-graph") return t("binding.missingFailGraph")
  if (policy === "skip-run") return t("binding.missingSkipRun")
  if (policy === "omit-binding") return t("binding.missingOmit")
  return undefined
}

function errorCategory(error: InspectorSafeError | undefined): InspectorErrorCategory {
  const category = error?.category
  if (
    category === "connection" || category === "consent" || category === "timeout" ||
    category === "permission" || category === "graph" || category === "provider" ||
    category === "integrity" || category === "cancelled"
  ) return category
  return "unknown"
}

function safeErrorKey(error: InspectorSafeError | undefined): ApcCatalogKey {
  const key = error?.messageKey
  return key !== undefined && SAFE_ERROR_MESSAGE_KEYS[key] === true ? key : "diagnostic.unknown"
}

function errorMessage(error: InspectorSafeError | undefined, t: ApcTranslate): string {
  const key = safeErrorKey(error)
  if (key !== "diagnostic.unknown") return t(key)
  switch (errorCategory(error)) {
    case "connection": return t("error.connection")
    case "consent": return t("consent.required")
    case "timeout": return t("error.timeout")
    case "permission": return t("permission.denied")
    case "graph": return t("error.graph")
    case "provider": return t("provider.failed")
    case "integrity": return t("outcome.integrityFailure")
    case "cancelled": return t("execution.cancelled")
    case "unknown": return t("diagnostic.unknown")
  }
}

function viewFor(snapshot: ExecutionInspectorSnapshot): InspectorView {
  if (snapshot.status !== "idle" || isInspectorTerminal(snapshot)) return "execution"
  if (snapshot.view) return snapshot.view
  if (snapshot.selection?.kind === "run") return "selected-run"
  if (snapshot.selection?.kind === "thread") return "selected-thread"
  return "idle"
}

function selectedRun(snapshot: ExecutionInspectorSnapshot): InspectorRunSnapshot | undefined {
  if (snapshot.selection?.kind === "run" && snapshot.selection.run) return snapshot.selection.run
  for (const stage of (snapshot.stages ?? []).slice(0, MAX_STAGE_ITEMS)) {
    const selected = stage.runs?.slice(0, MAX_RUN_ITEMS).find(run => run.selected === true)
    if (selected) return selected
  }
  return undefined
}

interface CurrentRunContext {
  readonly stage: InspectorStageSnapshot
  readonly run: InspectorRunSnapshot
}

function currentRun(snapshot: ExecutionInspectorSnapshot): CurrentRunContext | undefined {
  for (const stage of (snapshot.stages ?? []).slice(0, MAX_STAGE_ITEMS)) {
    const run = stage.runs?.slice(0, MAX_RUN_ITEMS).find(item => item.status === "running")
    if (run) return { stage, run }
  }
  return undefined
}

function runTitle(run: InspectorRunSnapshot, t: ApcTranslate): string {
  const label = optionalLabel(run.label, t)
  if (label) return label
  const index = positiveInteger(run.index)
  return index === undefined ? t("diagnostic.unknown") : t("inspector.runTitle", { index })
}

function stageTitle(
  stageLabel: string | undefined,
  stageIndex: number | undefined,
  t: ApcTranslate,
): string {
  const label = optionalLabel(stageLabel, t)
  if (label) return label
  const index = positiveInteger(stageIndex)
  return index === undefined ? t("diagnostic.unknown") : t("inspector.stageTitle", { index })
}

function activeLocale(value: string | (() => string) | undefined): string | undefined {
  try {
    const locale = typeof value === "function" ? value() : value
    const normalized = typeof locale === "string" ? locale.trim() : ""
    return normalized.length > 0 ? normalized : undefined
  } catch {
    return undefined
  }
}

function durationValue(ms: unknown, locale: string | undefined): string | undefined {
  const value = finiteNonNegative(ms)
  if (value === undefined) return undefined
  const seconds = Math.round(value / 1_000)
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: "second",
    unitDisplay: "short",
    maximumFractionDigits: 0,
  }).format(seconds)
}


class InspectorController implements ExecutionInspectorController {
  readonly element: HTMLElement
  readonly #document: Document
  readonly #options: ExecutionInspectorOptions
  readonly #live: LiveRegion
  readonly #cleanups: Cleanup[]
  readonly #maxItems: number
  #snapshot: ExecutionInspectorSnapshot | undefined
  #localError: InspectorSafeError | undefined
  #stopRequested = false
  #fallbackPending = false
  #tracePending = new Set<string>()
  #destroyed = false
  #generation = 0
  #wasTerminal = false
  #previousOutcome: OutcomeClass | undefined
  #previousStatusSignature = ""

  constructor(documentRef: Document, options: ExecutionInspectorOptions) {
    this.#document = documentRef
    this.#options = options
    this.#maxItems = boundedItems(options.maxItems)
    this.element = createElement(documentRef, "section", "apc-inspector")
    setAttributes(this.element, {
      "data-apc-panel": "inspector",
      "data-apc-inspector": "true",
      role: "region",
      tabindex: "-1",
    })
    this.#live = createLiveRegion(this.element, {
      document: documentRef,
      priority: "polite",
      label: options.t("execution.title"),
      className: "apc-inspector-live-region",
    })
    this.#cleanups = [
      listen(this.element, "click", this.#onClick),
    ]
    const initial = options.snapshot ?? options.initialSnapshot
    if (initial) this.render(initial)
    else this.render({ status: "idle", view: "idle" })
  }

  render(snapshot: ExecutionInspectorSnapshot): void {
    if (this.#destroyed) return
    const previous = this.#snapshot
    const activeElement = this.#document.activeElement
    const hadInspectorFocus = activeElement instanceof this.#document.defaultView!.HTMLElement &&
      this.element.contains(activeElement)
    const activeAction = hadInspectorFocus ? activeElement.dataset.inspectorAction : undefined
    const activeTraceKey = hadInspectorFocus ? activeElement.dataset.inspectorTraceKey : undefined
    const previousTitle = this.element.getAttribute("aria-label")
    const title = this.#options.t("inspector.title")
    if (previousTitle !== null && previousTitle !== title) this.#live.clear()
    this.element.setAttribute("aria-label", title)
    this.#live.element.setAttribute("aria-label", this.#options.t("execution.title"))

    const startsExecution = snapshot.status === "running" && previous?.status !== "running"
    const returnsIdle = snapshot.status === "idle" && previous?.status !== "idle"
    if (startsExecution || returnsIdle) {
      this.#generation += 1
      this.#stopRequested = false
      this.#fallbackPending = false
      this.#tracePending.clear()
      this.#localError = undefined
      this.#wasTerminal = false
      this.#previousOutcome = undefined
      this.#previousStatusSignature = ""
    }
    if (previous?.status !== snapshot.status && snapshot.status !== "running") this.#localError = undefined
    this.#snapshot = snapshot

    const terminal = isInspectorTerminal(snapshot)
    const outcome = selectInspectorOutcome(snapshot)
    const terminalTransition = !this.#wasTerminal && terminal
    const outcomeChanged = this.#previousOutcome !== undefined && this.#previousOutcome !== outcome.class
    this.#wasTerminal = terminal
    this.#previousOutcome = outcome.class

    const view = viewFor(snapshot)
    this.element.dataset.inspectorView = view
    this.element.dataset.status = snapshot.status
    this.element.dataset.terminal = terminal ? "true" : "false"
    this.element.setAttribute("aria-busy", snapshot.status === "running" ? "true" : "false")

    const content = createElement(this.#document, "div", "apc-inspector-content")
    content.append(this.#renderHeader(snapshot))
    content.dataset.inspectorContent = "true"
    if (view === "idle") content.append(this.#renderIdle())
    else if (view === "selected-thread") content.append(this.#renderSelectedThread(snapshot))
    else if (view === "selected-run") content.append(this.#renderSelectedRun(snapshot))
    else content.append(this.#renderExecution(snapshot, outcome, terminal))
    content.append(this.#renderTraces(snapshot))
    if (this.#localError) content.append(this.#renderError(this.#localError, "action"))
    this.element.replaceChildren(content, this.#live.element)
    if (hadInspectorFocus && !terminalTransition) {
      const replacement = activeAction === undefined
        ? null
        : [...this.element.querySelectorAll<HTMLElement>("[data-inspector-action]")].find((candidate) => {
            return candidate.dataset.inspectorAction === activeAction &&
              (activeTraceKey === undefined || candidate.dataset.inspectorTraceKey === activeTraceKey)
          }) ?? null
      focusElement(replacement ?? this.element)
    }

    const signature = this.#statusSignature(snapshot)
    if (signature !== this.#previousStatusSignature) {
      this.#previousStatusSignature = signature
      if (terminalTransition || outcomeChanged) {
        this.#announce(this.#options.t("a11y.outcomeAnnouncement", {
          outcome: outcomeLabel(outcome.class, this.#options.t),
          code: this.#outcomeCategoryLabel(outcome),
        }))
      } else if (snapshot.status === "running") {
        const announcement = previous?.status === "running"
          ? this.#progressAnnouncement(snapshot)
          : this.#options.t("execution.running")
        if (announcement) this.#announce(announcement)
      }
    }
    if (terminalTransition) this.#focusOutcome()
  }

  destroy(): void {
    if (this.#destroyed) return
    this.#destroyed = true
    this.#generation += 1
    this.#tracePending.clear()
    for (const cleanup of this.#cleanups.splice(0)) cleanup()
    this.#live.clear()
    this.#live.cleanup()
    this.#snapshot = undefined
    this.#localError = undefined
    this.element.replaceChildren()
    this.element.remove()
  }

  #renderHeader(snapshot: ExecutionInspectorSnapshot): HTMLElement {
    const header = createElement(this.#document, "header", "apc-inspector-header")
    const heading = createElement(this.#document, "h2", "apc-inspector-title", this.#options.t("inspector.title"))
    header.append(heading)
    if (snapshot.status !== "idle") {
      const status = badge(this.#document, statusLabel(snapshot.status, this.#options.t), snapshot.status)
      status.dataset.inspectorStatus = snapshot.status
      header.append(status)
    }
    return header
  }

  #renderIdle(): HTMLElement {
    const node = createSection(this.#document, "idle", this.#options.t("inspector.execution"))
    node.append(createElement(this.#document, "p", "apc-inspector-empty", this.#options.t("trace.empty")))
    return node
  }

  #renderSelectedThread(snapshot: ExecutionInspectorSnapshot): HTMLElement {
    const selection = snapshot.selection
    const node = createSection(this.#document, "thread", this.#options.t("agentGraph.thread"))
    appendField(
      this.#document,
      node,
      this.#options.t("inspector.fieldLabel"),
      displayLabel(selection?.threadLabel, this.#options.t),
      "thread-label",
    )
    appendField(
      this.#document,
      node,
      this.#options.t("workspace.source"),
      workspaceLabel(selection?.workspaceSource, this.#options.t),
      "workspace-source",
    )
    return node
  }

  #renderSelectedRun(snapshot: ExecutionInspectorSnapshot): HTMLElement {
    const run = selectedRun(snapshot)
    const node = createSection(this.#document, "selected-run", this.#options.t("agentGraph.run"))
    if (!run) {
      node.append(createElement(this.#document, "p", "apc-inspector-empty", this.#options.t("diagnostic.unknown")))
      return node
    }
    const identity = createElement(this.#document, "div", "apc-inspector-run-identity")
    identity.dataset.runStatus = run.status
    identity.append(createElement(this.#document, "h4", "apc-inspector-run-title", runTitle(run, this.#options.t)))
    identity.append(badge(
      this.#document,
      run.optional === true ? this.#options.t("binding.optional") : this.#options.t("binding.required"),
      run.optional === true ? "optional" : "required",
    ))
    node.append(identity)
    appendField(
      this.#document,
      node,
      this.#options.t("agentGraph.thread"),
      displayLabel(run.threadLabel ?? snapshot.selection?.threadLabel, this.#options.t),
      "thread-label",
    )
    appendField(
      this.#document,
      node,
      this.#options.t("agentGraph.stage"),
      stageTitle(run.stageLabel ?? snapshot.selection?.stageLabel, snapshot.selection?.stageIndex, this.#options.t),
      "stage-label",
    )
    const stageIndex = positiveInteger(snapshot.selection?.stageIndex)
    if (stageIndex !== undefined) {
      appendField(
        this.#document,
        node,
        this.#options.t("agentGraph.stage"),
        this.#options.t("inspector.stageTitle", { index: stageIndex }),
        "stage-position",
      )
    }
    const runIndex = positiveInteger(run.index)
    if (runIndex !== undefined) {
      appendField(
        this.#document,
        node,
        this.#options.t("agentGraph.run"),
        this.#options.t("inspector.runTitle", { index: runIndex }),
        "run-position",
      )
    }
    appendField(
      this.#document,
      node,
      this.#options.t("inspector.fieldStatus"),
      statusLabel(run.status, this.#options.t),
      "run-status",
    )
    if (run.roleLabel) {
      appendField(this.#document, node, this.#options.t("binding.role"), displayLabel(run.roleLabel, this.#options.t), "run-role")
    }
    if (run.dispatch) node.append(this.#renderDispatch(run.dispatch))
    if (run.deadline) node.append(this.#renderBudget(run.deadline))
    node.append(this.#renderInputs(run.inputSources ?? []), this.#renderOutput(run.output))
    if (run.error) node.append(this.#renderError(run.error, "run"))
    if (snapshot.canUseMainFallback === true && this.#options.onUseMainFallback) {
      node.append(this.#mainFallbackButton())
    }
    return node
  }

  #renderExecution(
    snapshot: ExecutionInspectorSnapshot,
    outcome: InspectorOutcomeSnapshot,
    terminal: boolean,
  ): HTMLElement {
    const fragment = createElement(this.#document, "div", "apc-inspector-execution")
    fragment.dataset.inspectorExecution = "true"
    if (terminal) fragment.append(this.#renderOutcome(snapshot, outcome))
    fragment.append(this.#renderProgress(snapshot))
    if (Array.isArray(snapshot.stages)) fragment.append(this.#renderStages(snapshot))
    const current = currentRun(snapshot)
    if (current) fragment.append(this.#renderCurrentRun(current))
    const dispatch = current?.run.dispatch ?? snapshot.currentDispatch ?? snapshot.finalRoute?.dispatch
    if (dispatch) fragment.append(this.#renderDispatch(dispatch))
    if (snapshot.deadline) fragment.append(this.#renderBudget(snapshot.deadline))
    if (snapshot.usage) fragment.append(this.#renderUsage(snapshot.usage))
    if (snapshot.cancellation?.requested === true) fragment.append(this.#renderCancellation(snapshot.cancellation))
    fragment.append(this.#renderActivity(snapshot))
    let errorCount = 0
    if (snapshot.error) {
      fragment.append(this.#renderError(snapshot.error, "execution"))
      errorCount += 1
    }
    for (const error of (snapshot.errors ?? []).slice(0, this.#maxItems - errorCount)) {
      fragment.append(this.#renderError(error, "execution"))
    }
    if (!terminal && this.#canStop(snapshot)) fragment.append(this.#stopButton())
    return fragment
  }

  #renderCancellation(cancellation: InspectorCancellationSnapshot): HTMLElement {
    const node = createSection(this.#document, "cancellation", this.#options.t("inspector.cancellation"))
    node.append(createElement(this.#document, "p", "apc-inspector-stop-requested", this.#options.t("inspector.stopRequested")))
    if (cancellation.reason) {
      const reason = cancellation.reason === "user"
        ? this.#options.t("execution.cancelReasonUser")
        : cancellation.reason === "stop"
          ? this.#options.t("execution.cancelReasonStop")
          : cancellation.reason === "replacement"
            ? this.#options.t("execution.cancelReasonReplacement")
            : this.#options.t("execution.cancelReasonTimeout")
      appendField(this.#document, node, this.#options.t("inspector.fieldReason"), reason, "cancellation-reason")
    }
    if (cancellation.acknowledged !== undefined) {
      appendField(
        this.#document,
        node,
        this.#options.t("inspector.fieldAcknowledged"),
        cancellation.acknowledged ? this.#options.t("common.yes") : this.#options.t("common.no"),
        "cancellation-acknowledged",
      )
    }
    return node
  }

  #renderProgress(snapshot: ExecutionInspectorSnapshot): HTMLElement {
    const node = createSection(this.#document, "progress", this.#options.t("inspector.stages"))
    const progress = snapshot.progress
    const stageIndex = positiveInteger(progress?.stageIndex)
    const stageCount = positiveInteger(progress?.stageCount)
    const completedRuns = finiteNonNegative(progress?.completedRuns)
    const totalRuns = positiveInteger(progress?.totalRuns)
    if (stageIndex !== undefined) {
      appendField(
        this.#document,
        node,
        this.#options.t("agentGraph.stage"),
        stageCount === undefined ? String(stageIndex) : `${stageIndex} / ${stageCount}`,
        "stage-progress",
      )
    }
    if (completedRuns !== undefined && totalRuns !== undefined) {
      appendField(
        this.#document,
        node,
        this.#options.t("agentGraph.run"),
        `${Math.min(completedRuns, totalRuns)} / ${totalRuns}`,
        "run-progress",
      )
    }
    const percent = finiteNonNegative(progress?.percent)
    if (percent !== undefined) {
      const meter = createElement(this.#document, "progress", "apc-inspector-progress")
      meter.max = 100
      meter.value = Math.min(percent, 100)
      meter.setAttribute("aria-label", this.#options.t("inspector.stages"))
      node.append(meter)
    }
    if (node.childElementCount === 1) {
      node.append(createElement(this.#document, "p", "apc-inspector-empty", this.#options.t("inspector.noStages")))
    }
    return node
  }

  #renderCurrentRun(context: CurrentRunContext): HTMLElement {
    const { run, stage } = context
    const node = createSection(this.#document, "current-run", this.#options.t("agentGraph.run"))
    node.dataset.currentRunStatus = run.status
    appendField(this.#document, node, this.#options.t("inspector.fieldLabel"), runTitle(run, this.#options.t), "current-run-label")
    if (run.threadLabel) {
      appendField(this.#document, node, this.#options.t("agentGraph.thread"), displayLabel(run.threadLabel, this.#options.t), "thread-label")
    }
    if (stage.label || run.stageLabel) {
      appendField(
        this.#document,
        node,
        this.#options.t("agentGraph.stage"),
        stageTitle(stage.label ?? run.stageLabel, undefined, this.#options.t),
        "stage-label",
      )
    }
    const stageIndex = positiveInteger(stage.index)
    if (stageIndex !== undefined) {
      appendField(
        this.#document,
        node,
        this.#options.t("agentGraph.stage"),
        this.#options.t("inspector.stageTitle", { index: stageIndex }),
        "stage-position",
      )
    }
    const runIndex = positiveInteger(run.index)
    if (runIndex !== undefined) {
      appendField(
        this.#document,
        node,
        this.#options.t("agentGraph.run"),
        this.#options.t("inspector.runTitle", { index: runIndex }),
        "run-position",
      )
    }
    appendField(this.#document, node, this.#options.t("inspector.fieldStatus"), statusLabel(run.status, this.#options.t), "run-status")
    node.append(badge(
      this.#document,
      run.optional === true ? this.#options.t("binding.optional") : this.#options.t("binding.required"),
      run.optional === true ? "optional" : "required",
    ))
    if (run.error) node.append(this.#renderError(run.error, "run"))
    return node
  }

  #renderDispatch(dispatch: InspectorDispatchProvenance): HTMLElement {
    const node = createSection(this.#document, "dispatch", this.#options.t("inspector.dispatch"))
    const source = dispatch.source === "main" || dispatch.source === "slot" ? dispatch.source : undefined
    node.dataset.dispatchSource = source ?? "unknown"
    appendField(
      this.#document,
      node,
      this.#options.t("inspector.fieldSource"),
      source === "main"
        ? this.#options.t("dispatch.sourceMain")
        : source === "slot"
          ? this.#options.t("dispatch.sourceSlot", { slot: this.#options.t("agentGraph.slot") })
          : this.#options.t("diagnostic.unknown"),
      "dispatch-source",
    )
    const destination = optionalLabel(dispatch.descriptor?.label, this.#options.t)
    if (destination) appendField(this.#document, node, this.#options.t("inspector.fieldLabel"), destination, "dispatch-label")
    const provider = optionalLabel(dispatch.descriptor?.provider, this.#options.t)
    if (provider) appendField(this.#document, node, this.#options.t("inspector.fieldProvider"), provider, "provider")
    const model = optionalLabel(dispatch.descriptor?.model, this.#options.t)
    if (model) appendField(this.#document, node, this.#options.t("inspector.fieldModel"), model, "model")
    if (dispatch.status) {
      appendField(this.#document, node, this.#options.t("inspector.fieldStatus"), statusLabel(dispatch.status === "dispatched" ? "running" : dispatch.status, this.#options.t), "dispatch-status")
    }
    return node
  }

  #renderBudget(deadline: InspectorDeadlineSnapshot): HTMLElement {
    const node = createSection(this.#document, "budget", this.#options.t("inspector.deadline"))
    const elapsed = durationValue(deadline.elapsedMs, activeLocale(this.#options.locale))
    if (elapsed !== undefined) {
      appendField(this.#document, node, this.#options.t("execution.title"), elapsed, "elapsed-seconds")
    }
    const remainingMs = finiteNonNegative(deadline.remainingMs)
    if (remainingMs !== undefined) {
      appendField(
        this.#document,
        node,
        this.#options.t("inspector.deadline"),
        this.#options.t("execution.remainingSeconds", { count: Math.ceil(remainingMs / 1_000) }),
        "remaining-budget",
      )
    }
    const timeout = durationValue(deadline.timeoutMs, activeLocale(this.#options.locale))
    if (timeout !== undefined) {
      appendField(
        this.#document,
        node,
        this.#options.t("validation.timeout"),
        timeout,
        "timeout-seconds",
      )
    }
    if (deadline.phase) {
      const phase = deadline.phase === "working"
        ? this.#options.t("execution.phaseWorking")
        : deadline.phase === "draining"
          ? this.#options.t("execution.phaseDraining")
          : this.#options.t("execution.phaseExpired")
      appendField(this.#document, node, this.#options.t("inspector.fieldPhase"), phase, "budget-phase")
    }
    return node
  }

  #renderUsage(usage: InspectorUsageSnapshot): HTMLElement {
    const node = createSection(this.#document, "usage", this.#options.t("usage.title"))
    const input = finiteNonNegative(usage.input) ?? 0
    const output = finiteNonNegative(usage.output) ?? 0
    const total = finiteNonNegative(usage.total) ?? input + output
    node.append(createElement(
      this.#document,
      "p",
      "apc-inspector-usage",
      this.#options.t("usage.summary", { input, output, total }),
    ))
    return node
  }

  #renderInputs(sources: readonly InspectorInputSourceSummary[]): HTMLElement {
    const node = createSection(this.#document, "inputs", this.#options.t("graph.inputs"))
    if (sources.length === 0) {
      node.append(createElement(this.#document, "p", "apc-inspector-empty", this.#options.t("diagnostic.unknown")))
      return node
    }
    const list = createElement(this.#document, "ul", "apc-inspector-source-list")
    for (const source of sources.slice(0, this.#maxItems)) {
      const item = createElement(this.#document, "li", "apc-inspector-source")
      item.dataset.sourceKind = source.kind
      item.append(
        createElement(this.#document, "span", "apc-inspector-source-kind", sourceKindLabel(source.kind, this.#options.t)),
        createElement(this.#document, "span", "apc-inspector-source-label", displayLabel(source.label, this.#options.t)),
        badge(
          this.#document,
          source.required === false ? this.#options.t("binding.optional") : this.#options.t("binding.required"),
          source.required === false ? "optional" : "required",
        ),
      )
      if (source.roleLabel) item.append(createElement(this.#document, "span", "apc-inspector-source-role", displayLabel(source.roleLabel, this.#options.t)))
      const missing = missingPolicyLabel(source.missingPolicy, this.#options.t)
      if (missing) item.append(createElement(this.#document, "span", "apc-inspector-source-policy", missing))
      list.append(item)
    }
    node.append(list)
    return node
  }

  #renderOutput(output: InspectorOutputSummary | undefined): HTMLElement {
    const node = createSection(this.#document, "output", this.#options.t("agentGraph.final"))
    appendField(
      this.#document,
      node,
      this.#options.t("inspector.fieldLabel"),
      displayLabel(output?.label, this.#options.t),
      "output-label",
    )
    if (output?.available !== undefined) {
      appendField(
        this.#document,
        node,
        this.#options.t("inspector.fieldStatus"),
        output.available ? this.#options.t("terminal.ready") : this.#options.t("terminal.unavailable"),
        "output-availability",
      )
    }
    return node
  }
  #renderStages(snapshot: ExecutionInspectorSnapshot): HTMLElement {
    const node = createSection(this.#document, "stages", this.#options.t("inspector.stages"))
    const stages = Array.isArray(snapshot.stages) ? snapshot.stages.slice(0, MAX_STAGE_ITEMS) : []
    if (stages.length === 0) {
      node.append(createElement(this.#document, "p", "apc-inspector-empty", this.#options.t("inspector.noStages")))
      return node
    }
    const list = createElement(this.#document, "ol", "apc-inspector-stage-list")
    for (const stage of stages) {
      if (stage === null || typeof stage !== "object") continue
      const item = createElement(this.#document, "li", "apc-inspector-stage")
      item.dataset.stageStatus = statusLabel(stage.status, this.#options.t)
      item.append(
        createElement(this.#document, "h4", "apc-inspector-stage-title", stageTitle(stage.label, stage.index, this.#options.t)),
        createElement(this.#document, "span", "apc-inspector-stage-status", statusLabel(stage.status, this.#options.t)),
      )
      if (stage.error) item.append(this.#renderError(stage.error, "stage"))
      const runs = Array.isArray(stage.runs) ? stage.runs.slice(0, MAX_RUN_ITEMS) : []
      if (runs.length > 0) {
        const runList = createElement(this.#document, "ol", "apc-inspector-run-list")
        for (const run of runs) {
          if (run === null || typeof run !== "object") continue
          const runItem = createElement(this.#document, "li", "apc-inspector-run")
          runItem.dataset.runStatus = statusLabel(run.status, this.#options.t)
          runItem.append(
            createElement(this.#document, "span", "apc-inspector-run-title", runTitle(run, this.#options.t)),
            createElement(this.#document, "span", "apc-inspector-run-status", statusLabel(run.status, this.#options.t)),
          )
          if (run.error) runItem.append(this.#renderError(run.error, "run"))
          runList.append(runItem)
        }
        item.append(runList)
      }
      list.append(item)
    }
    node.append(list)
    return node
  }

  #activity(snapshot: ExecutionInspectorSnapshot): readonly InspectorActivityItem[] {
    if (Array.isArray(snapshot.activity)) return snapshot.activity.slice(0, this.#maxItems)
    const runs: InspectorActivityItem[] = []
    for (const stage of (snapshot.stages ?? []).slice(0, MAX_STAGE_ITEMS)) {
      for (const run of (stage.runs ?? []).slice(0, MAX_RUN_ITEMS)) {
        if (runs.length >= this.#maxItems) return runs
        runs.push({
          status: run.status,
          stageLabel: stage.label,
          runLabel: run.label,
          threadLabel: run.threadLabel,
          error: run.error,
          ...(run.startedAt !== undefined && run.finishedAt !== undefined
            ? { elapsedMs: Math.max(0, run.finishedAt - run.startedAt) }
            : {}),
        })
      }
    }
    return runs
  }

  #renderActivity(snapshot: ExecutionInspectorSnapshot): HTMLElement {
    const node = createSection(this.#document, "activity", this.#options.t("trace.title"))
    const activity = this.#activity(snapshot)
    if (activity.length === 0) {
      node.append(createElement(this.#document, "p", "apc-inspector-empty", this.#options.t("trace.empty")))
      return node
    }
    const list = createElement(this.#document, "ol", "apc-inspector-activity")
    for (const activityItem of activity) {
      const item = createElement(this.#document, "li", "apc-inspector-activity-item")
      item.dataset.activityStatus = activityItem.status
      const label = optionalLabel(activityItem.runLabel ?? activityItem.threadLabel, this.#options.t)
      if (label) item.append(createElement(this.#document, "span", "apc-inspector-activity-label", label))
      item.append(createElement(this.#document, "span", "apc-inspector-activity-status", statusLabel(activityItem.status, this.#options.t)))
      const elapsed = durationValue(activityItem.elapsedMs, activeLocale(this.#options.locale))
      if (elapsed !== undefined) item.append(createElement(this.#document, "span", "apc-inspector-activity-duration", elapsed))
      if (activityItem.error) item.append(createElement(this.#document, "span", "apc-inspector-activity-error", errorMessage(activityItem.error, this.#options.t)))
      list.append(item)
    }
    node.append(list)
    return node
  }
  #renderTraces(snapshot: ExecutionInspectorSnapshot): HTMLElement {
    const node = createSection(this.#document, "traces", this.#options.t("inspector.traces"))
    const refresh = createElement(this.#document, "button", "apc-inspector-trace-refresh", this.#options.t("action.refreshConnections"))
    refresh.type = "button"
    refresh.dataset.inspectorAction = "load-traces"
    refresh.disabled = this.#options.onLoadTraces === undefined || this.#tracePending.has("list")
    refresh.setAttribute("aria-disabled", refresh.disabled ? "true" : "false")
    node.append(refresh)

    const summaries = Array.isArray(snapshot.traces) ? snapshot.traces.slice(0, this.#maxItems) : []
    const list = createElement(this.#document, "ol", "apc-inspector-traces")
    let rendered = 0
    for (const summary of summaries) {
      if (summary === null || typeof summary !== "object") continue
      const key = safeTraceKey(summary.key)
      if (key === undefined) continue
      const item = createElement(this.#document, "li", "apc-inspector-trace")
      item.dataset.inspectorTraceKey = key
      item.append(createElement(
        this.#document,
        "h4",
        "apc-inspector-trace-title",
        this.#options.t("inspector.fieldTrace"),
      ))
      appendField(this.#document, item, this.#options.t("inspector.fieldStatus"), statusLabel(summary.status, this.#options.t), "trace-status")

      const count = finiteNonNegative(summary.eventCount)
      appendField(
        this.#document,
        item,
        this.#options.t("inspector.fieldEvents"),
        String(count === undefined ? 0 : Math.min(Math.floor(count), MAX_TRACE_EVENTS)),
        "trace-events",
      )
      const started = finiteNonNegative(summary.startedAt)
      const finished = finiteNonNegative(summary.finishedAt)
      if (started !== undefined && finished !== undefined && finished >= started) {
        const elapsed = durationValue(finished - started, activeLocale(this.#options.locale))
        if (elapsed !== undefined) appendField(this.#document, item, this.#options.t("inspector.fieldDetail"), elapsed, "trace-duration")
      }
      const preview = boundedText(summary.preview, MAX_TRACE_PREVIEW_BYTES)
      if (preview.length > 0) {
        item.append(createElement(this.#document, "p", "apc-inspector-trace-preview", preview))
        if (summary.truncated === true || preview.endsWith("…")) {
          item.append(createElement(this.#document, "span", "apc-inspector-trace-truncated", this.#options.t("inspector.previewTruncated")))
        }
      }

      const detail = snapshot.traceDetails?.[key]
      if (detail !== undefined && Array.isArray(detail.events)) {
        const details = createElement(this.#document, "details", "apc-inspector-trace-details")
        details.append(createElement(this.#document, "summary", undefined, this.#options.t("inspector.traceDetails")))
        const events = createElement(this.#document, "ol", "apc-inspector-trace-events")
        for (const event of detail.events.slice(0, MAX_TRACE_EVENTS)) {
          if (event === null || typeof event !== "object") continue
          events.append(this.#renderTraceEvent(event))
        }
        details.append(events)
        if (detail.events.length > MAX_TRACE_EVENTS) {
          details.append(createElement(this.#document, "p", "apc-inspector-trace-omitted", this.#options.t("inspector.additionalEventsOmitted")))
        }
        item.append(details)
      }

      const load = createElement(this.#document, "button", "apc-inspector-trace-load", this.#options.t("action.refreshConnections"))
      load.type = "button"
      load.dataset.inspectorAction = "load-trace"
      load.dataset.inspectorTraceKey = key
      load.disabled = this.#options.onLoadTrace === undefined || this.#tracePending.has(`trace:${key}`)
      load.setAttribute("aria-disabled", load.disabled ? "true" : "false")
      item.append(load)
      list.append(item)
      rendered += 1
    }
    if (rendered === 0) {
      node.append(createElement(this.#document, "p", "apc-inspector-empty", this.#options.t("inspector.noTraces")))
    } else {
      node.append(list)
    }
    return node
  }

  #renderTraceEvent(event: InspectorTraceEvent): HTMLElement {
    const item = createElement(this.#document, "li", "apc-inspector-trace-event")
    if (event.kind) appendField(this.#document, item, this.#options.t("inspector.fieldKind"), displayLabel(event.kind, this.#options.t), "trace-event-kind")
    if (event.status) appendField(this.#document, item, this.#options.t("inspector.fieldStatus"), statusLabel(event.status, this.#options.t), "trace-event-status")
    const timestamp = finiteNonNegative(event.timestamp)
    if (timestamp !== undefined) appendField(this.#document, item, this.#options.t("inspector.fieldDetail"), String(Math.floor(timestamp)), "trace-event-time")
    const preview = boundedText(event.preview, MAX_TRACE_PREVIEW_BYTES)
    if (preview.length > 0) item.append(createElement(this.#document, "p", "apc-inspector-trace-event-preview", preview))
    return item
  }

  #renderOutcome(snapshot: ExecutionInspectorSnapshot, outcome: InspectorOutcomeSnapshot): HTMLElement {
    const node = createSection(this.#document, "outcome", this.#options.t("inspector.outcome"))
    node.tabIndex = -1
    node.dataset.inspectorOutcome = "true"
    node.dataset.outcomeClass = outcome.class
    node.dataset.outcomeCategory = outcome.category
    appendField(this.#document, node, this.#options.t("inspector.fieldResult"), outcomeLabel(outcome.class, this.#options.t), "outcome-result")

    if (outcome.class === "graph-fallback") {
      node.append(createElement(this.#document, "p", "apc-inspector-fallback-main", this.#options.t("fallback.main")))
      appendField(
        this.#document,
        node,
        this.#options.t("inspector.fieldReason"),
        errorMessage({ category: outcome.category }, this.#options.t),
        "fallback-cause",
      )
    }
    const route = snapshot.finalRoute
    if (route) {
      const routeLabel = optionalLabel(route.targetLabel, this.#options.t) ??
        (route.target === "main" ? this.#options.t("agentGraph.finalMain") : this.#options.t("agentGraph.finalThread"))
      appendField(this.#document, node, this.#options.t("inspector.finalRoute"), routeLabel, "final-route")
      if (route.delivered !== undefined) {
        appendField(
          this.#document,
          node,
          this.#options.t("inspector.fieldResult"),
          route.delivered ? this.#options.t("terminal.ready") : this.#options.t("terminal.unavailable"),
          "final-delivery",
        )
      }
      const retained = finiteNonNegative(route.retainedCompletedRuns)
      if (retained !== undefined) {
        appendField(this.#document, node, this.#options.t("inspector.statusCompleted"), String(retained), "retained-runs")
      }
    }
    if (outcome.class === "graph-fallback") {
      const mainResponded = snapshot.fallback?.mainResponded
      appendField(
        this.#document,
        node,
        this.#options.t("inspector.fieldResult"),
        mainResponded === true
          ? this.#options.t("terminal.ready")
          : mainResponded === false
            ? this.#options.t("terminal.unavailable")
            : this.#options.t("diagnostic.unknown"),
        "main-fallback-result",
      )
    }
    if (snapshot.canUseMainFallback === true && this.#options.onUseMainFallback) node.append(this.#mainFallbackButton())
    return node
  }

  #renderError(error: InspectorSafeError, scope: string): HTMLElement {
    const category = errorCategory(error)
    const node = createSection(this.#document, `error-${scope}`, this.#options.t("inspector.errors"))
    node.classList.add("apc-inspector-error")
    node.dataset.errorCategory = category
    node.setAttribute("role", "status")
    node.append(createElement(this.#document, "p", "apc-inspector-error-message", errorMessage(error, this.#options.t)))
    return node
  }

  #stopButton(): HTMLButtonElement {
    const button = createElement(this.#document, "button", "apc-inspector-stop", this.#options.t("action.stop"))
    button.type = "button"
    button.dataset.inspectorAction = "stop"
    button.setAttribute("aria-label", this.#options.t("action.stop"))
    return button
  }

  #mainFallbackButton(): HTMLButtonElement {
    const button = createElement(this.#document, "button", "apc-inspector-main-fallback", this.#options.t("fallback.main"))
    button.type = "button"
    button.dataset.inspectorAction = "use-main-fallback"
    button.disabled = this.#fallbackPending
    button.setAttribute("aria-label", this.#options.t("fallback.main"))
    return button
  }

  #canStop(snapshot: ExecutionInspectorSnapshot): boolean {
    return snapshot.status === "running" &&
      !isInspectorTerminal(snapshot) &&
      snapshot.stoppable === true &&
      snapshot.cancellation?.requested !== true &&
      !this.#stopRequested &&
      typeof this.#options.onStop === "function"
  }

  #onClick = (event: Event): void => {
    if (this.#destroyed) return
    const target = event.target
    if (!(target instanceof this.#document.defaultView!.Element)) return
    const button = target.closest<HTMLButtonElement>("button[data-inspector-action]")
    if (!button || !this.element.contains(button) || button.disabled) return
    const action = button.dataset.inspectorAction
    if (action === "stop") this.#requestStop()
    else if (action === "use-main-fallback") this.#requestMainFallback()
    else if (action === "load-traces") this.#requestLoadTraces()
    else if (action === "load-trace") {
      const key = safeTraceKey(button.dataset.inspectorTraceKey)
      if (key !== undefined) this.#requestLoadTrace(key)
    }
  }

  #requestStop(): void {
    const snapshot = this.#snapshot
    if (!snapshot || !this.#canStop(snapshot) || !this.#options.onStop) return
    const generation = this.#generation
    this.#stopRequested = true
    this.#announce(this.#options.t("inspector.stopRequested"))
    this.render(snapshot)
    let result: void | Promise<void>
    try {
      result = this.#options.onStop()
    } catch {
      this.#settleActionFailure(generation)
      return
    }
    void Promise.resolve(result).catch(() => this.#settleActionFailure(generation))
  }

  #requestMainFallback(): void {
    const snapshot = this.#snapshot
    if (!snapshot || this.#fallbackPending || snapshot.canUseMainFallback !== true || !this.#options.onUseMainFallback) return
    const generation = this.#generation
    this.#fallbackPending = true
    this.render(snapshot)
    let result: void | Promise<void>
    try {
      result = this.#options.onUseMainFallback()
    } catch {
      this.#settleFallbackFailure(generation)
      return
    }
    void Promise.resolve(result).catch(() => this.#settleFallbackFailure(generation))
  }

  #requestLoadTraces(): void {
    const snapshot = this.#snapshot
    const callback = this.#options.onLoadTraces
    if (!snapshot || !callback || this.#tracePending.has("list")) return
    const generation = this.#generation
    this.#tracePending.add("list")
    this.render(snapshot)
    let result: void | Promise<void>
    try {
      result = callback()
    } catch {
      this.#settleTraceFailure("list", generation)
      return
    }
    void Promise.resolve(result).then(
      () => this.#settleTraceSuccess("list", generation),
      () => this.#settleTraceFailure("list", generation),
    )
  }

  #requestLoadTrace(key: string): void {
    const callback = this.#options.onLoadTrace
    const token = `trace:${key}`
    if (!this.#snapshot || !callback || this.#tracePending.has(token)) return
    const generation = this.#generation
    this.#tracePending.add(token)
    this.render(this.#snapshot)
    let result: void | Promise<void>
    try {
      result = callback(key)
    } catch {
      this.#settleTraceFailure(token, generation)
      return
    }
    void Promise.resolve(result).then(
      () => this.#settleTraceSuccess(token, generation),
      () => this.#settleTraceFailure(token, generation),
    )
  }

  #settleTraceSuccess(token: string, generation: number): void {
    if (this.#destroyed || generation !== this.#generation || !this.#snapshot) return
    this.#tracePending.delete(token)
    this.render(this.#snapshot)
  }

  #settleTraceFailure(token: string, generation: number): void {
    if (this.#destroyed || generation !== this.#generation || !this.#snapshot) return
    this.#tracePending.delete(token)
    this.#localError = { category: "unknown", messageKey: "diagnostic.unknown" }
    this.render(this.#snapshot)
  }

  #settleActionFailure(generation: number): void {
    if (this.#destroyed || generation !== this.#generation || !this.#snapshot) return
    this.#localError = { category: "unknown", messageKey: "diagnostic.unknown" }
    this.render(this.#snapshot)
  }

  #settleFallbackFailure(generation: number): void {
    if (this.#destroyed || generation !== this.#generation || !this.#snapshot) return
    this.#fallbackPending = false
    this.#localError = { category: "unknown", messageKey: "diagnostic.unknown" }
    this.render(this.#snapshot)
  }

  #statusSignature(snapshot: ExecutionInspectorSnapshot): string {
    const progress = snapshot.progress
    const run = currentRun(snapshot)
    return [
      snapshot.status,
      progress?.stageIndex ?? "",
      progress?.stageCount ?? "",
      progress?.completedRuns ?? "",
      progress?.totalRuns ?? "",
      progress?.percent ?? "",
      snapshot.deadline?.remainingMs ?? "",
      run?.run.status ?? "",
      optionalLabel(run?.run.label, this.#options.t) ?? "",
    ].join("|")
  }
  #progressAnnouncement(snapshot: ExecutionInspectorSnapshot): string {
    const parts: string[] = []
    const progress = snapshot.progress
    const stageIndex = positiveInteger(progress?.stageIndex)
    const stageCount = positiveInteger(progress?.stageCount)
    if (stageIndex !== undefined) {
      parts.push(this.#options.t("inspector.fieldValue", {
        label: this.#options.t("inspector.stages"),
        value: stageCount === undefined ? String(stageIndex) : `${stageIndex} / ${stageCount}`,
      }))
    }
    const completedRuns = finiteNonNegative(progress?.completedRuns)
    const totalRuns = positiveInteger(progress?.totalRuns)
    if (completedRuns !== undefined && totalRuns !== undefined) {
      parts.push(this.#options.t("inspector.fieldValue", {
        label: this.#options.t("agentGraph.run"),
        value: `${Math.min(completedRuns, totalRuns)} / ${totalRuns}`,
      }))
    }
    const percent = finiteNonNegative(progress?.percent)
    if (percent !== undefined) {
      const locale = activeLocale(this.#options.locale)
      parts.push(new Intl.NumberFormat(locale, {
        style: "percent",
        maximumFractionDigits: 0,
      }).format(Math.min(percent, 100) / 100))
    }
    const current = currentRun(snapshot)
    if (current) {
      parts.push(this.#options.t("inspector.fieldValue", {
        label: runTitle(current.run, this.#options.t),
        value: statusLabel(current.run.status, this.#options.t),
      }))
    }
    const remainingMs = finiteNonNegative(snapshot.deadline?.remainingMs)
    if (remainingMs !== undefined) {
      parts.push(this.#options.t("execution.remainingSeconds", {
        count: Math.ceil(remainingMs / 1_000),
      }))
    }
    return parts.join(" · ")
  }


  #outcomeCategoryLabel(outcome: InspectorOutcomeSnapshot): string {
    if (outcome.class === "graph-fallback") return errorMessage({ category: outcome.category }, this.#options.t)
    if (outcome.class === "parent-cancel") return this.#options.t("execution.cancelled")
    if (outcome.class === "integrity-fatal") return this.#options.t("outcome.integrityFailure")
    return outcomeLabel(outcome.class, this.#options.t)
  }

  #announce(message: string): void {
    if (this.#destroyed) return
    this.#live.announce(message)
    this.#options.announce?.(message)
  }

  #focusOutcome(): void {
    const outcome = this.element.querySelector<HTMLElement>("[data-inspector-outcome]")
    if (!outcome) return
    if (this.#options.focus) this.#options.focus(outcome)
    else focusElement(outcome)
  }
}

export function createExecutionInspector(options: ExecutionInspectorOptions): ExecutionInspectorController {
  const documentRef = options.document ?? (typeof document !== "undefined" ? document : undefined)
  if (!documentRef) throw new Error("Execution inspector requires a document")
  return new InspectorController(documentRef, options)
}
