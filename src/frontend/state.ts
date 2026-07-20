import type {
  ApcDecodedConfig,
  ApcIssue,
  ApcMode,
  ApcPresetConfigV1,
} from "../config/schema"
import { createDefaultApcConfig, decodeApcPresetConfig } from "../config/schema"
import type { ApcCatalogKey } from "../i18n/catalogs"
import type { ApcModeAvailabilityMap as ConfigModeAvailabilityMap, ApcValidationResult } from "../config/validate"
import { deriveModeAvailability, validateConfigForMode } from "../config/validate"
import {
  MAX_ACTIVITY_BUDGET_MS,
  MAX_ACTIVITY_RUN_COUNT,
  MAX_ACTIVITY_STAGE_COUNT,
  MAX_ACTIVITY_USAGE_TOKENS,
  MAX_SAFE_LABEL_BYTES,
} from "../protocol/messages"
import type {
  ActivityCancellationSource,
  ActivityErrorCategory,
  ActivityOutcome,
  ActivityRunStatus,
  BackendActivityResponse,
  BackendActivityUsage,
  BackendConsentResponse,
  BackendHydrationResponse,
  ConnectionSummary,
  ConsentSelector,
  SafeBindingView,
  TraceDetail,
  TraceEvent,
  TraceStatus,
  TraceSummary,
} from "../protocol/messages"
import type {
  ApcConfigPayload,
  ApcDomainResponse,
  ApcPersistence,
  ApcPersistenceError,
  ApcSaveResult,
} from "./persistence"

export type ApcSelection =
  | Readonly<{ kind: "main" }>
  | Readonly<{ kind: "thread"; threadId: string }>
  | Readonly<{ kind: "stage"; stageId: string }>
  | Readonly<{ kind: "run"; runId: string }>
  | null
export type ApcUiMessage = Readonly<{
  key: ApcCatalogKey
  values?: Readonly<Record<string, unknown>>
}>

export type ApcValidationIssueSurface = Readonly<{
  code: string
  path: readonly (string | number)[]
  mode?: ApcMode
}>

export type ApcDecodedConfigSurface = Readonly<{
  status: ApcDecodedConfig["status"]
  config: ApcPresetConfigV1 | null
  issues: readonly ApcValidationIssueSurface[]
  modeIssues: Readonly<Record<ApcMode, readonly ApcValidationIssueSurface[]>>
  future: boolean
}>

export type ApcModeAvailabilitySurface = Readonly<{
  supported: boolean
  valid: boolean
  disabledReason?: ApcUiMessage
}>
export type ApcBusyReason = "hydrate" | "connections" | "traces" | "cancel" | "save" | "execution"
export type ApcConnectionSummary = Readonly<{
  key: string
  name: string
  provider: string
  model: string
}>
export type ApcConnectionBinding = Readonly<SafeBindingView>
export type ApcConsent = Readonly<BackendConsentResponse["payload"] & { key: string }>

export type ApcRunActivityStatus = ActivityRunStatus
export type ApcExecutionUsage = Readonly<BackendActivityUsage>
export type ApcExecutionActivity = Readonly<{
  kind?: string
  phase: Exclude<BackendActivityResponse["payload"]["phase"], "idle">
  status: ApcRunActivityStatus
  terminal: boolean
  provider?: string
  model?: string
  stageIndex?: number
  stageCount?: number
  runIndex?: number
  runCount?: number
  completedRuns?: number
  totalRuns?: number
  remainingBudgetMs?: number
  usage?: ApcExecutionUsage
  outcome?: ActivityOutcome
  errorCategory?: ActivityErrorCategory
  errorMessageKey?: string
  cancellationSource?: ActivityCancellationSource
}>
export type ApcExecutionState = Readonly<{
  executionKey: string | null
  kind?: string
  phase: BackendActivityResponse["payload"]["phase"] | "idle"
  status: TraceStatus | "idle"
  terminal: boolean
  provider?: string
  model?: string
  stageIndex?: number
  stageCount?: number
  runIndex?: number
  runCount?: number
  completedRuns?: number
  totalRuns?: number
  remainingBudgetMs?: number
  outcome?: ActivityOutcome
  errorCategory?: ActivityErrorCategory
  usage?: ApcExecutionUsage
  errorMessageKey?: string
  cancellationSource?: ActivityCancellationSource
  activity: readonly ApcExecutionActivity[]
  topologyActivity: readonly ApcExecutionActivity[]
  topologyApplicable: boolean
}>

export type ApcTraceEventSurface = Readonly<Pick<TraceEvent, "kind" | "sequence" | "timestamp" | "status" | "preview">>
export type ApcTraceSummarySurface = Readonly<Pick<TraceSummary, "status" | "startedAt" | "finishedAt" | "eventCount" | "preview" | "truncated"> & { key: string }>
export type ApcTraceDetailSurface = Readonly<ApcTraceSummarySurface & { events: readonly ApcTraceEventSurface[] }>

export type ApcTraceState = Readonly<{
  summaries: readonly ApcTraceSummarySurface[]
  details: Readonly<Record<string, ApcTraceDetailSurface>>
  nextCursor?: string
}>
export type ApcSaveErrorSurface = Readonly<{
  code: string
  message: ApcUiMessage
  reloadRequired: boolean
}>

export interface ApcFrontendSnapshot {
  readonly presetId: string | null
  readonly decoded: ApcDecodedConfigSurface | null
  readonly config: ApcPresetConfigV1 | null
  readonly activeMode: ApcMode
  readonly modeIssues: Readonly<Record<ApcMode, readonly ApcValidationIssueSurface[]>>
  readonly modeAvailability: Readonly<Record<ApcMode, ApcModeAvailabilitySurface>>
  readonly selection: ApcSelection
  readonly dirty: boolean
  /** Local monotonic config revision, including edits not yet persisted. */
  readonly revision: number
  readonly saveError: ApcSaveErrorSurface | null
  readonly stale: boolean
  readonly availableConnections: readonly ApcConnectionSummary[]
  readonly connectionBindings: Readonly<Record<string, ApcConnectionBinding>>
  readonly consent: Readonly<Record<string, ApcConsent>>
  readonly execution: ApcExecutionState
  readonly executionMutationLocked: boolean
  readonly traces: ApcTraceState
  readonly busy: boolean
  readonly busyReason: ApcBusyReason | null
  readonly blockedReasons: readonly ApcUiMessage[]
  readonly hydrated: boolean
  readonly hydrating: boolean
}

export type ApcConfigMutator = (config: Readonly<ApcPresetConfigV1>) => ApcPresetConfigV1

export type ApcFrontendStateOptions = Readonly<{ persistence: ApcPersistence }>

export interface ApcFrontendStore {
  getSnapshot(): ApcFrontendSnapshot
  subscribe(listener: (snapshot: ApcFrontendSnapshot) => void): () => void
  hydrate(presetId: string): Promise<ApcFrontendSnapshot>
  updateConfig(mutator: ApcConfigMutator): ApcFrontendSnapshot
  setActiveMode(mode: ApcMode): Promise<boolean>
  setSelection(selection: ApcSelection): void
  refreshConnections(): Promise<readonly ApcConnectionSummary[]>
  bindConnection(slotId: string, connectionKey: string): Promise<ApcConnectionBinding>
  unbindConnection(slotId: string): Promise<ApcConnectionBinding>
  approveConsent(selector: ConsentSelector): Promise<ApcConsent>
  revokeConsent(selector: ConsentSelector): Promise<ApcConsent>
  resolveConsent(selector: ConsentSelector): Promise<ApcConsent>
  loadTraces(options?: Readonly<{
    executionKey?: string
    limit?: number
    cursor?: string
  }>): Promise<ApcTraceState>
  loadTrace(traceKey: string, options?: Readonly<{ executionKey?: string }>): Promise<ApcTraceDetailSurface>
  cancelExecution(executionKey: string, reason?: "user" | "stop" | "replacement"): Promise<void>
  flush(): Promise<void>
  dispose(): void
}

export class ApcFrontendStateError extends Error {
  readonly code: "DISPOSED" | "NO_PRESET" | "NO_CONFIG" | "STALE_OPERATION" | "INVALID_HYDRATION" | "EXECUTION_LOCKED"

  constructor(code: ApcFrontendStateError["code"], message: string) {
    super(message)
    this.name = "ApcFrontendStateError"
    this.code = code
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

const MODES = ["single", "sequential", "parallel"] as const
const MAX_EXECUTION_ACTIVITY = 32
const MAX_TOPOLOGY_ACTIVITY = 64
const SAFE_ACTIVITY_CODE = /^[A-Z][A-Z0-9_:-]{0,63}$/
const ACTIVITY_RUN_STATUSES: readonly ApcRunActivityStatus[] = ["pending", "running", "completed", "failed", "cancelled", "timed-out", "skipped"]
const TERMINAL_ACTIVITY_STATUSES: readonly ApcRunActivityStatus[] = ["completed", "failed", "cancelled", "timed-out", "skipped"]
const ACTIVITY_OUTCOMES = ["integrity-fatal", "parent-cancel", "selected-final-failure", "graph-fallback", "optional-local", "success"] as const
const ACTIVITY_ERROR_CATEGORIES = ["integrity", "dispatch", "consent", "capacity", "config", "assembly", "provider", "tool", "timeout", "unknown"] as const
const ACTIVITY_CANCELLATION_SOURCES = ["user", "stop", "replacement", "permission-revoked", "disable", "update", "disposed", "timeout"] as const

function boundedActivityLabel(value: unknown, maxBytes: number = MAX_SAFE_LABEL_BYTES): string | undefined {
  if (typeof value !== "string" || value.length === 0 || /[\u0000-\u001f\u007f\r\n]/u.test(value)) return undefined
  return new TextEncoder().encode(value).byteLength > maxBytes ? undefined : value
}

function boundedActivityCount(value: unknown, maximum: number): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum
    ? value as number
    : undefined
}

function boundedActivityEnum<T extends string>(value: unknown, values: readonly T[]): T | undefined {
  return typeof value === "string" && values.includes(value as T) ? value as T : undefined
}
function boundedActivityUsage(value: unknown): ApcExecutionUsage | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (key !== "input" && key !== "output" && key !== "total") return undefined
  }
  const input = boundedActivityCount(record.input, MAX_ACTIVITY_USAGE_TOKENS)
  const output = boundedActivityCount(record.output, MAX_ACTIVITY_USAGE_TOKENS)
  const total = boundedActivityCount(record.total, MAX_ACTIVITY_USAGE_TOKENS)
  if (record.input !== undefined && input === undefined) return undefined
  if (record.output !== undefined && output === undefined) return undefined
  if (record.total !== undefined && total === undefined) return undefined
  return deepFreeze({
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(total === undefined ? {} : { total }),
  })
}

function executionStatusFromPhase(phase: BackendActivityResponse["payload"]["phase"]): TraceStatus {
  return phase === "started" || phase === "progress"
    ? "running"
    : phase === "completed"
      ? "completed"
      : phase === "cancelled"
        ? "cancelled"
        : "failed"
}

function executionActivityFromPayload(activity: BackendActivityResponse["payload"]): ApcExecutionActivity {
  const runStatus = boundedActivityEnum(activity.runStatus, ACTIVITY_RUN_STATUSES)
  const status: ApcRunActivityStatus = runStatus ?? executionStatusFromPhase(activity.phase)
  const kind = boundedActivityLabel(activity.kind, 128)
  const provider = boundedActivityLabel(activity.provider)
  const model = boundedActivityLabel(activity.model)
  const stageIndex = boundedActivityCount(activity.stageIndex, MAX_ACTIVITY_STAGE_COUNT - 1)
  const stageCount = boundedActivityCount(activity.stageCount, MAX_ACTIVITY_STAGE_COUNT)
  const runIndex = boundedActivityCount(activity.runIndex, MAX_ACTIVITY_RUN_COUNT - 1)
  const runCount = boundedActivityCount(activity.runCount, MAX_ACTIVITY_RUN_COUNT)
  const completedRuns = boundedActivityCount(activity.completedRuns, MAX_ACTIVITY_RUN_COUNT)
  const totalRuns = boundedActivityCount(activity.totalRuns, MAX_ACTIVITY_RUN_COUNT)
  const remainingBudgetMs = boundedActivityCount(activity.remainingBudgetMs, MAX_ACTIVITY_BUDGET_MS)
  const outcome = boundedActivityEnum(activity.outcome, ACTIVITY_OUTCOMES)
  const errorCategory = boundedActivityEnum(activity.errorCategory, ACTIVITY_ERROR_CATEGORIES)
  const usage = boundedActivityUsage(activity.usage)
  const errorMessageKey = boundedActivityLabel(activity.errorMessageKey, 128)
  const cancellationSource = boundedActivityEnum(activity.cancellationSource, ACTIVITY_CANCELLATION_SOURCES)
  return deepFreeze({
    ...(kind === undefined ? {} : { kind }),
    phase: activity.phase,
    status,
    ...(usage === undefined ? {} : { usage }),
    terminal: activity.terminal === true,
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(stageIndex === undefined ? {} : { stageIndex }),
    ...(stageCount === undefined ? {} : { stageCount }),
    ...(runIndex === undefined ? {} : { runIndex }),
    ...(runCount === undefined ? {} : { runCount }),
    ...(completedRuns === undefined ? {} : { completedRuns }),
    ...(totalRuns === undefined ? {} : { totalRuns }),
    ...(remainingBudgetMs === undefined ? {} : { remainingBudgetMs }),
    ...(outcome === undefined ? {} : { outcome }),
    ...(errorCategory === undefined ? {} : { errorCategory }),
    ...(errorMessageKey === undefined || !SAFE_ACTIVITY_CODE.test(errorMessageKey) ? {} : { errorMessageKey }),
    ...(cancellationSource === undefined ? {} : { cancellationSource }),
  })
}

function editableConfig(
  decoded: ApcDecodedConfig | ApcDecodedConfigSurface | null,
  fallback: ApcPresetConfigV1 | null,
): ApcPresetConfigV1 | null {
  if (decoded === null) return null
  if (decoded.config !== null) return cloneValue(decoded.config)
  if (decoded.status !== "invalid") return null
  return fallback === null ? createDefaultApcConfig() : cloneValue(fallback)
}

function cloneValue<T>(value: T): T {
  return structuredClone(value)
}
function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return value
}

function emptyModeIssues(): Record<ApcMode, ApcValidationIssueSurface[]> {
  return { single: [], sequential: [], parallel: [] }
}

function uiMessage(key: ApcCatalogKey, values?: Readonly<Record<string, unknown>>): ApcUiMessage {
  const descriptor = values === undefined ? { key } : { key, values: cloneValue(values) }
  return deepFreeze(descriptor)
}

function sanitizeIssue(issue: ApcIssue | ApcValidationIssueSurface): ApcValidationIssueSurface {
  return deepFreeze({
    code: issue.code,
    path: [...issue.path],
    ...(issue.mode === undefined ? {} : { mode: issue.mode }),
  })
}

function sanitizeDecoded(decoded: ApcDecodedConfig | ApcDecodedConfigSurface): ApcDecodedConfigSurface {
  const modeIssues = emptyModeIssues()
  for (const mode of MODES) modeIssues[mode].push(...decoded.modeIssues[mode].map(sanitizeIssue))
  return deepFreeze({
    status: decoded.status,
    config: decoded.config === null ? null : cloneValue(decoded.config),
    issues: decoded.issues.map(sanitizeIssue),
    modeIssues,
    future: decoded.future,
  })
}


function emptyModeAvailability(): Record<ApcMode, ApcModeAvailabilitySurface> {
  const unavailable = uiMessage("validation.configNotHydrated")
  return {
    single: { supported: false, valid: false, disabledReason: unavailable },
    sequential: { supported: false, valid: false, disabledReason: unavailable },
    parallel: { supported: false, valid: false, disabledReason: unavailable },
  }
}

function modeAvailabilitySurface(
  config: ApcPresetConfigV1 | null,
  decoded: ApcDecodedConfig | ApcDecodedConfigSurface | null = null,
): Record<ApcMode, ApcModeAvailabilitySurface> {
  if (config === null) return emptyModeAvailability()
  const derived: ConfigModeAvailabilityMap = deriveModeAvailability(config)
  const result = {} as Record<ApcMode, ApcModeAvailabilitySurface>
  for (const mode of MODES) {
    const availability = derived[mode]
    if (!availability.supported) {
      result[mode] = { supported: false, valid: availability.valid, disabledReason: uiMessage("mode.unsupported", { mode }) }
    } else if (!availability.valid || decoded?.status === "invalid" || decoded?.status === "future" || (decoded?.modeIssues[mode].length ?? 0) > 0) {
      result[mode] = { supported: true, valid: false, disabledReason: uiMessage("mode.invalid", { mode }) }
    } else {
      result[mode] = { supported: true, valid: true }
    }
  }
  return result
}

function modeIssueMap(decoded: ApcDecodedConfig | ApcDecodedConfigSurface | null, config: ApcPresetConfigV1 | null): Record<ApcMode, ApcValidationIssueSurface[]> {
  const result = emptyModeIssues()
  if (decoded !== null) {
    for (const mode of MODES) result[mode].push(...decoded.modeIssues[mode].map(sanitizeIssue))
  }
  if (config !== null) {
    for (const mode of MODES) {
      const validation: ApcValidationResult = validateConfigForMode(config, mode)
      for (const issue of validation.issues) {
        const sanitized = sanitizeIssue(issue)
        if (!result[mode].some((existing) => existing.code === sanitized.code && existing.path.join(".") === sanitized.path.join("."))) result[mode].push(sanitized)
      }
    }
  }
  return result
}

function consentKey(selector: ConsentSelector): string {
  return [selector.presetId, selector.threadId, selector.workspaceSource ?? "", selector.connectionSourceKey ?? ""].join("\u001f")
}

function saveErrorSurface(error: unknown): ApcSaveErrorSurface {
  const candidate = error !== null && typeof error === "object" ? error as Partial<ApcPersistenceError> : {}
  const code = typeof candidate.code === "string" ? candidate.code : "SAVE_FAILED"
  const key: ApcCatalogKey = code === "NO_PRESET"
    ? "error.inactivePreset"
    : code === "DISPOSED"
      ? "error.persistenceDisposed"
      : code === "TIMEOUT"
        ? "error.timeout"
        : code === "BACKEND_ERROR"
          ? "error.connection"
          : "error.persistConfigFallback"
  return { code, message: uiMessage(key), reloadRequired: false }
}

function topologyActivityFromEvent(
  event: ApcExecutionActivity,
  previousActivity: readonly ApcExecutionActivity[] = [],
): readonly ApcExecutionActivity[] {
  if (event.stageIndex === undefined || event.runIndex === undefined) return previousActivity
  const existingIndex = previousActivity.findIndex((entry) => entry.stageIndex === event.stageIndex && entry.runIndex === event.runIndex)
  if (existingIndex >= 0) {
    const previous = previousActivity[existingIndex]
    if (previous !== undefined && (
      TERMINAL_ACTIVITY_STATUSES.includes(previous.status) ||
      (previous.status === "running" && event.status === "pending")
    )) return previousActivity
  }
  const next = [...previousActivity]
  if (existingIndex >= 0) next[existingIndex] = event
  else next.push(event)
  return deepFreeze(next.slice(-MAX_TOPOLOGY_ACTIVITY))
}
function terminalActivityWithContext(
  event: ApcExecutionActivity,
  previousActivity: readonly ApcExecutionActivity[],
): ApcExecutionActivity {
  if (!event.terminal) return event
  const latest = <K extends keyof ApcExecutionActivity>(key: K): ApcExecutionActivity[K] | undefined => {
    const current = event[key]
    if (current !== undefined) return current
    for (let index = previousActivity.length - 1; index >= 0; index -= 1) {
      const value = previousActivity[index]?.[key]
      if (value !== undefined) return value
    }
    return undefined
  }
  const kind = latest("kind")
  const provider = latest("provider")
  const model = latest("model")
  const stageIndex = latest("stageIndex")
  const stageCount = latest("stageCount")
  const runIndex = latest("runIndex")
  const runCount = latest("runCount")
  const completedRuns = latest("completedRuns")
  const totalRuns = latest("totalRuns")
  const remainingBudgetMs = latest("remainingBudgetMs")
  const usage = latest("usage")
  return deepFreeze({
    ...event,
    ...(event.kind === undefined && kind !== undefined ? { kind } : {}),
    ...(event.provider === undefined && provider !== undefined ? { provider } : {}),
    ...(event.model === undefined && model !== undefined ? { model } : {}),
    ...(event.stageIndex === undefined && stageIndex !== undefined ? { stageIndex } : {}),
    ...(event.stageCount === undefined && stageCount !== undefined ? { stageCount } : {}),
    ...(event.runIndex === undefined && runIndex !== undefined ? { runIndex } : {}),
    ...(event.runCount === undefined && runCount !== undefined ? { runCount } : {}),
    ...(event.completedRuns === undefined && completedRuns !== undefined ? { completedRuns } : {}),
    ...(event.totalRuns === undefined && totalRuns !== undefined ? { totalRuns } : {}),
    ...(event.remainingBudgetMs === undefined && remainingBudgetMs !== undefined ? { remainingBudgetMs } : {}),
    ...(event.usage === undefined && usage !== undefined ? { usage } : {}),
  })
}
function executionFromActivity(
  activity: BackendActivityResponse["payload"],
  executionKey: string,
  previousActivity: readonly ApcExecutionActivity[] = [],
  previousUsage?: ApcExecutionUsage,
  previousTopologyActivity: readonly ApcExecutionActivity[] = [],
): ApcExecutionState {
  const sanitizedEvent = executionActivityFromPayload(activity)
  const event = terminalActivityWithContext(sanitizedEvent, previousActivity)
  const history = deepFreeze([...previousActivity, event].slice(-MAX_EXECUTION_ACTIVITY))
  const topologyActivity = topologyActivityFromEvent(sanitizedEvent, previousTopologyActivity)
  const usage = event.usage ?? previousUsage ?? previousActivity.at(-1)?.usage
  return deepFreeze({
    executionKey,
    ...event,
    status: executionStatusFromPhase(activity.phase),
    ...(usage === undefined ? {} : { usage }),
    activity: history,
    topologyActivity,
    topologyApplicable: true,
  })
}
type ApcOperationToken = Readonly<{
  operation: string
  presetId: string | null
  presetGeneration: number
  requestGeneration: number
  executionId?: string | null
  traceGeneration?: number
}>


function staleOperationError(operation: string): ApcFrontendStateError {
  return new ApcFrontendStateError("STALE_OPERATION", `APC ${operation} result is no longer current`)
}

class ApcFrontendStoreImpl implements ApcFrontendStore {
  readonly #persistence: ApcPersistence
  readonly #listeners = new Set<(snapshot: ApcFrontendSnapshot) => void>()
  readonly #connectionBindings: Record<string, ApcConnectionBinding> = {}
  readonly #connectionIdsByKey = new Map<string, string>()
  readonly #consent: Record<string, ApcConsent> = {}
  readonly #traceDetails: Record<string, TraceDetail> = {}
  readonly #traceIdsByKey = new Map<string, { executionId: string; traceId: string }>()
  readonly #operationGenerations = new Map<string, number>()
  #availableConnections: ApcConnectionSummary[] = []
  #unsubscribePersistence: (() => void) | null
  #unsubscribeDraft: (() => void) | null
  #snapshot: ApcFrontendSnapshot
  #persistedConfig: ApcPresetConfigV1 | null = null
  #persistedRaw: unknown = null
  #pendingRaw: unknown = undefined
  #flushPromise: Promise<void> | null = null
  #traceGeneration = 0
  #presetGeneration = 0
  #disposed = false
  #executionActivityGeneration = 0
  #busyReason: ApcBusyReason | null = null
  #executionBusy = false
  #traceSummaries: TraceSummary[] = []
  #traceCursor: string | undefined
  #execution: ApcExecutionState = { executionKey: null, phase: "idle", status: "idle", terminal: false, activity: [], topologyActivity: [], topologyApplicable: false }
  #executionId: string | null = null
  #executionPresetId: string | null = null
  #executionTraceId: string | null = null
  #executionTopologyInvalidated = false
  #executionSerial = 0
  readonly #retiredExecutionIds = new Set<string>()
  constructor(options: ApcFrontendStateOptions) {
    this.#persistence = options.persistence
    this.#unsubscribePersistence = options.persistence.subscribe((message) => this.#handleDomainMessage(message))
    this.#unsubscribeDraft = options.persistence.subscribeDraft((event) => this.#handleDraftEvent(event.state, event.owned))
    this.#snapshot = this.#makeSnapshot({
      presetId: null,
      decoded: null,
      config: null,
      activeMode: "single",
      selection: null,
      dirty: false,
      revision: 0,
      saveError: null,
      stale: false,
      hydrated: false,
      hydrating: false,
      availableConnections: [],
    })
  }

  getSnapshot(): ApcFrontendSnapshot {
    return this.#snapshot
  }

  subscribe(listener: (snapshot: ApcFrontendSnapshot) => void): () => void {
    if (this.#disposed) return () => {}
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async hydrate(presetId: string): Promise<ApcFrontendSnapshot> {
    this.#assertUsable()
    const token = this.#beginPresetOperation(presetId)
    if (this.#snapshot.dirty && !this.#snapshot.stale) await this.flush()
    if (this.#disposed || token.presetGeneration !== this.#presetGeneration) throw staleOperationError(token.operation)
    this.#replacePresetState(presetId)
    const hydrationActivityGeneration = this.#executionActivityGeneration
    this.#snapshot = this.#makeSnapshot({ ...this.#snapshot, hydrating: true, hydrated: false })
    this.#setBusy("hydrate")
    try {
      const payload = await this.#persistence.loadConfig(presetId)
      this.#assertCurrent(token)
      const decoded = decodeApcPresetConfig(payload.raw)
      const hydration = await this.#persistence.hydratePreset(presetId)
      this.#assertCurrent(token)
      this.#applyHydratedConfig(payload)
      this.#applyHydratedDomainState(hydration, hydrationActivityGeneration)
      if (decoded.status === "valid" && decoded.config?.supportedModes.some((mode) => mode !== "single") === true) {
        this.#startConnectionDiscovery(this.#nextOperation("connections", presetId), presetId)
      }
    } catch (error) {
      if (this.#isCurrent(token)) {
        const surface = saveErrorSurface(error)
        this.#snapshot = this.#makeSnapshot({ ...this.#snapshot, hydrating: false, hydrated: false, saveError: surface, stale: false })
        this.#notify()
      }
      throw error
    } finally {
      if (this.#isCurrent(token)) this.#setBusy(null)
    }
    return this.#snapshot
  }

  updateConfig(mutator: ApcConfigMutator): ApcFrontendSnapshot {
    this.#assertUsable()
    if (this.#snapshot.stale) throw staleOperationError("update config")
    const current = this.#snapshot.config
    if (current === null || this.#snapshot.presetId === null) throw new ApcFrontendStateError("NO_CONFIG", "APC config is not hydrated")
    if (this.#snapshot.executionMutationLocked) throw new ApcFrontendStateError("EXECUTION_LOCKED", "APC configuration is locked while execution is active")
    const next = mutator(deepFreeze(cloneValue(current)))
    if (JSON.stringify(next) === JSON.stringify(current)) return this.#snapshot
    const staged = cloneValue(next)
    this.#persistence.stageConfig(this.#snapshot.presetId, staged)
    this.#pendingRaw = staged
    this.#setConfig(this.#pendingRaw, true)
    return this.#snapshot
  }

  async setActiveMode(mode: ApcMode): Promise<boolean> {
    this.#assertUsable()
    if (!MODES.includes(mode) || this.#snapshot.stale) return false
    if (this.#snapshot.config === null || this.#snapshot.presetId === null) throw new ApcFrontendStateError("NO_CONFIG", "APC config is not hydrated")
    const availability = this.#snapshot.modeAvailability[mode]
    if (!availability.supported || !availability.valid) return false
    if (this.#snapshot.executionMutationLocked) throw new ApcFrontendStateError("EXECUTION_LOCKED", "APC configuration is locked while execution is active")
    if (this.#snapshot.activeMode === mode) {
      if (!this.#snapshot.dirty) return true
      const presetId = this.#snapshot.presetId
      const token = this.#nextOperation("mode", presetId)
      const operationRevision = this.#snapshot.revision
      const persisted = cloneValue(this.#persistedConfig)
      const persistedRaw = cloneValue(this.#persistedRaw)
      const pendingRaw = cloneValue(this.#pendingRaw ?? this.#snapshot.config)
      try {
        if (pendingRaw !== undefined) this.#persistence.stageConfig(presetId, pendingRaw)
        await this.flush()
        if (!this.#isCurrent(token) || this.#snapshot.revision !== operationRevision) throw staleOperationError(token.operation)
        return !this.#snapshot.dirty
      } catch (error) {
        if (this.#disposed) throw error
        if (!this.#isCurrent(token) || this.#snapshot.revision !== operationRevision) throw staleOperationError(token.operation)
        try {
          this.#persistence.stageConfig(presetId, persistedRaw)
          await this.#persistence.flush()
        } catch (rollbackError) {
          if (this.#disposed) throw rollbackError
          if (!this.#isCurrent(token) || this.#snapshot.revision !== operationRevision) throw staleOperationError(token.operation)
          return false
        }
        this.#assertCurrent(token)
        if (this.#snapshot.revision !== operationRevision) throw staleOperationError(token.operation)
        this.#pendingRaw = pendingRaw
        this.#persistedConfig = persisted
        this.#persistedRaw = persistedRaw
        const decoded = decodeApcPresetConfig(persistedRaw)
        const config = editableConfig(decoded, this.#snapshot.config)
        const surface = saveErrorSurface(error)
        if (decoded.status !== "valid" || decoded.config === null) {
          this.#snapshot = this.#makeSnapshot({ ...this.#snapshot, decoded, config, activeMode: config?.activeMode ?? "single", dirty: true, saveError: surface, stale: false })
          this.#notify()
          return false
        }
        this.#snapshot = this.#makeSnapshot({ ...this.#snapshot, decoded, config, activeMode: config?.activeMode ?? "single", dirty: false, saveError: surface, stale: false })
        this.#notify()
        return false
      }
    }
    const presetId = this.#snapshot.presetId
    const token = this.#nextOperation("mode", presetId)
    this.#assertCurrent(token)
    const persisted = cloneValue(this.#persistedConfig)
    const persistedRaw = cloneValue(this.#persistedRaw)
    let operationRevision = this.#snapshot.revision
    const previousConfig = cloneValue(this.#snapshot.config)
    try {
      this.updateConfig((config) => ({ ...config, activeMode: mode }))
      operationRevision = this.#snapshot.revision
      await this.flush()
      this.#assertCurrent(token)
      if (this.#snapshot.revision !== operationRevision) throw staleOperationError(token.operation)
      return true
    } catch (error) {
      if (this.#disposed) throw error
      if (!this.#isCurrent(token) || this.#snapshot.revision !== operationRevision) throw staleOperationError(token.operation)
      try {
        this.#persistence.stageConfig(presetId, persistedRaw)
        await this.#persistence.flush()
      } catch (rollbackError) {
        if (this.#disposed) throw rollbackError
        if (!this.#isCurrent(token) || this.#snapshot.revision !== operationRevision) throw staleOperationError(token.operation)
        return false
      }
      this.#assertCurrent(token)
      if (this.#snapshot.revision !== operationRevision) throw staleOperationError(token.operation)
      this.#pendingRaw = undefined
      this.#persistedConfig = persisted
      this.#persistedRaw = persistedRaw
      const decoded = decodeApcPresetConfig(persistedRaw)
      const config = editableConfig(decoded, previousConfig)
      const surface = saveErrorSurface(error)
      if (decoded.status !== "valid" || decoded.config === null) {
        this.#snapshot = this.#makeSnapshot({ ...this.#snapshot, decoded, config, activeMode: config?.activeMode ?? "single", dirty: true, saveError: surface, stale: false })
        this.#notify()
        return false
      }
      this.#snapshot = this.#makeSnapshot({ ...this.#snapshot, decoded, config, activeMode: config?.activeMode ?? "single", dirty: false, saveError: surface, stale: false })
      this.#notify()
      return false
    }
  }

  setSelection(selection: ApcSelection): void {
    this.#assertUsable()
    this.#snapshot = this.#makeSnapshot({ ...this.#snapshot, selection: selection === null ? null : cloneValue(selection) })
    this.#notify()
  }
  async refreshConnections(): Promise<readonly ApcConnectionSummary[]> {
    this.#assertUsable()
    const presetId = this.#requirePreset()
    const token = this.#nextOperation("connections", presetId)
    this.#setBusy("connections")
    try {
      const payload = await this.#persistence.listConnections()
      this.#assertCurrent(token)
      this.#availableConnections = payload.connections.map((connection) => this.#projectConnection(connection))
      this.#snapshot = this.#makeSnapshot({ ...this.#snapshot, availableConnections: this.#availableConnections })
      this.#notify()
      return this.#snapshot.availableConnections
    } finally {
      if (this.#isCurrent(token)) this.#setBusy(null)
    }
  }

  async bindConnection(slotId: string, connectionKey: string): Promise<ApcConnectionBinding> {
    this.#assertUsable()
    const presetId = this.#requirePreset()
    const connectionId = this.#connectionIdsByKey.get(connectionKey)
    if (connectionId === undefined) throw staleOperationError("bind connection")
    const token = this.#nextOperation(`binding:${slotId}`, presetId)
    const payload = await this.#persistence.bindSlot(presetId, slotId, connectionId)
    this.#assertCurrent(token)
    const binding: ApcConnectionBinding = {
      slotId,
      bound: payload.bound,
      ...(payload.status === undefined ? {} : { status: payload.status }),
      ...(payload.bound && payload.descriptor !== undefined ? { descriptor: cloneValue(payload.descriptor) } : {}),
    }
    this.#connectionBindings[slotId] = deepFreeze(cloneValue(binding))
    this.#snapshot = this.#makeSnapshot({ ...this.#snapshot, connectionBindings: { ...this.#connectionBindings } })
    this.#notify()
    return cloneValue(binding)
  }

  async unbindConnection(slotId: string): Promise<ApcConnectionBinding> {
    this.#assertUsable()
    const presetId = this.#requirePreset()
    const token = this.#nextOperation(`binding:${slotId}`, presetId)
    const payload = await this.#persistence.unbindSlot(presetId, slotId)
    this.#assertCurrent(token)
    const binding: ApcConnectionBinding = {
      slotId,
      bound: payload.bound,
      ...(payload.status === undefined ? {} : { status: payload.status }),
      ...(payload.bound && payload.descriptor !== undefined ? { descriptor: cloneValue(payload.descriptor) } : {}),
    }
    this.#connectionBindings[slotId] = deepFreeze(cloneValue(binding))
    this.#snapshot = this.#makeSnapshot({ ...this.#snapshot, connectionBindings: { ...this.#connectionBindings } })
    this.#notify()
    return cloneValue(binding)
  }

  async approveConsent(selector: ConsentSelector): Promise<ApcConsent> {
    this.#assertUsable()
    const presetId = this.#requirePreset()
    if (selector.presetId !== presetId) throw staleOperationError("approve consent")
    const token = this.#nextOperation(`consent:${consentKey(selector)}`, presetId)
    const payload = await this.#persistence.approveConsent(selector)
    this.#assertCurrent(token)
    return this.#setConsent(payload)
  }
  async revokeConsent(selector: ConsentSelector): Promise<ApcConsent> {
    this.#assertUsable()
    const presetId = this.#requirePreset()
    if (selector.presetId !== presetId) throw staleOperationError("revoke consent")
    const token = this.#nextOperation(`consent:${consentKey(selector)}`, presetId)
    const payload = await this.#persistence.revokeConsent(selector)
    this.#assertCurrent(token)
    return this.#setConsent(payload)
  }

  async resolveConsent(selector: ConsentSelector): Promise<ApcConsent> {
    this.#assertUsable()
    const presetId = this.#requirePreset()
    if (selector.presetId !== presetId) throw staleOperationError("resolve consent")
    const token = this.#nextOperation(`consent:${consentKey(selector)}`, presetId)
    const payload = await this.#persistence.resolveConsent(selector)
    this.#assertCurrent(token)
    return this.#setConsent(payload)
  }

  async loadTraces(options: Readonly<{ executionKey?: string; limit?: number; cursor?: string }> = {}): Promise<ApcTraceState> {
    this.#assertUsable()
    const presetId = this.#requirePreset()
    const executionId = options.executionKey === undefined
      ? undefined
      : this.#executionIdsByKey(options.executionKey)
    if (options.executionKey !== undefined && executionId === undefined) throw staleOperationError("load traces")
    this.#traceGeneration += 1
    const traceGeneration = this.#traceGeneration
    const token = this.#nextOperation("traces", presetId, executionId, traceGeneration)
    this.#setBusy("traces")
    try {
      const traceOptions = {
        ...(options.limit === undefined ? {} : { limit: options.limit }),
        ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      }
      const payload = await this.#persistence.listTraces(executionId === undefined
        ? { ...traceOptions, presetId }
        : { ...traceOptions, executionId, presetId })
      this.#assertCurrent(token)
      for (const key of Object.keys(this.#traceDetails)) delete this.#traceDetails[key]
      this.#traceIdsByKey.clear()
      this.#traceSummaries = [...payload.traces]
      this.#traceCursor = payload.nextCursor
      for (const trace of payload.traces) {
        const key = this.#traceKey(trace.executionId, trace.traceId)
        this.#traceIdsByKey.set(key, { executionId: trace.executionId, traceId: trace.traceId })
      }
      this.#snapshot = this.#makeSnapshot({ ...this.#snapshot, traces: this.#traceState() })
      this.#notify()
      return this.#snapshot.traces
    } finally {
      if (this.#isCurrent(token)) this.#setBusy(null)
    }
  }

  async loadTrace(
    traceKey: string,
    options: Readonly<{ executionKey?: string }> = {},
  ): Promise<ApcTraceDetailSurface> {
    this.#assertUsable()
    const presetId = this.#requirePreset()
    const identity = this.#traceIdsByKey.get(traceKey)
    if (identity === undefined) throw staleOperationError("load trace")
    const expectedExecutionId = options.executionKey === undefined
      ? undefined
      : this.#executionIdsByKey(options.executionKey)
    if (
      options.executionKey !== undefined &&
      (expectedExecutionId === undefined || identity.executionId !== expectedExecutionId)
    ) throw staleOperationError("load trace")
    const token = this.#nextOperation(
      `trace:${traceKey}`,
      presetId,
      expectedExecutionId,
      this.#traceGeneration,
    )
    const payload = await this.#persistence.getTrace(presetId, identity.executionId, identity.traceId)
    this.#assertCurrent(token)
    const currentIdentity = this.#traceIdsByKey.get(traceKey)
    if (
      currentIdentity === undefined ||
      currentIdentity.executionId !== identity.executionId ||
      currentIdentity.traceId !== identity.traceId
    ) throw staleOperationError("load trace")
    if (payload.trace.presetId !== presetId || payload.trace.executionId !== identity.executionId || payload.trace.traceId !== identity.traceId) throw staleOperationError("load trace")
    this.#traceDetails[traceKey] = cloneValue(payload.trace)
    this.#snapshot = this.#makeSnapshot({ ...this.#snapshot, traces: this.#traceState() })
    this.#notify()
    return this.#traceDetailSurface(payload.trace, traceKey)
  }

  async cancelExecution(executionKey: string, reason?: "user" | "stop" | "replacement"): Promise<void> {
    this.#assertUsable()
    const presetId = this.#requirePreset()
    if (this.#execution.executionKey !== executionKey || this.#executionId === null || this.#executionPresetId !== presetId) throw staleOperationError("cancel execution")
    const executionId = this.#executionId
    const token = this.#nextOperation("cancel", presetId, executionId)
    this.#assertCurrent(token)
    this.#setBusy("cancel")
    try {
      const cancellation = await this.#persistence.cancelExecution(presetId, executionId, reason)
      this.#assertCurrent(token)
      if (cancellation.executionId !== executionId || cancellation.presetId !== presetId) throw staleOperationError("cancel execution")
    } finally {
      if (this.#isCurrent(token)) this.#setBusy(null)
    }
  }

  async flush(): Promise<void> {
    this.#assertUsable()
    if (this.#snapshot.stale) return Promise.reject(staleOperationError("save"))
    if (this.#flushPromise !== null) return this.#flushPromise
    this.#flushPromise = this.#flushInternal().finally(() => { this.#flushPromise = null })
    return this.#flushPromise
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#presetGeneration += 1
    this.#operationGenerations.clear()
    this.#unsubscribePersistence?.()
    this.#unsubscribePersistence = null
    this.#unsubscribeDraft?.()
    this.#unsubscribeDraft = null
    this.#persistence.dispose()
    this.#listeners.clear()
    this.#pendingRaw = undefined
    this.#persistedRaw = null
    this.#persistedConfig = null
    this.#availableConnections = []
    this.#connectionIdsByKey.clear()
    for (const key of Object.keys(this.#connectionBindings)) delete this.#connectionBindings[key]
    for (const key of Object.keys(this.#consent)) delete this.#consent[key]
    for (const key of Object.keys(this.#traceDetails)) delete this.#traceDetails[key]
    this.#traceIdsByKey.clear()
    this.#traceSummaries = []
    this.#traceCursor = undefined
    this.#execution = { executionKey: null, phase: "idle", status: "idle", terminal: false, activity: [], topologyActivity: [], topologyApplicable: false }
    this.#executionTopologyInvalidated = false
    this.#executionId = null
    this.#executionPresetId = null
    this.#executionTraceId = null
    this.#retiredExecutionIds.clear()
    this.#executionBusy = false
    this.#executionActivityGeneration = 0
    this.#busyReason = null
    this.#flushPromise = null
    this.#snapshot = this.#makeSnapshot({
      presetId: null,
      decoded: null,
      config: null,
      activeMode: "single",
      selection: null,
      dirty: false,
      revision: 0,
      saveError: null,
      stale: false,
      hydrated: false,
      hydrating: false,
      availableConnections: [],
      connectionBindings: {},
      consent: {},
      execution: this.#execution,
      traces: { summaries: [], details: {} },
      busy: false,
      busyReason: null,
    })
  }


  #makeSnapshot(values: Readonly<{
    presetId: string | null
    availableConnections?: readonly ApcConnectionSummary[]
    decoded: ApcDecodedConfig | ApcDecodedConfigSurface | null
    config: ApcPresetConfigV1 | null
    activeMode: ApcMode
    selection: ApcSelection
    dirty: boolean
    revision: number
    saveError: ApcSaveErrorSurface | null
    stale: boolean
    hydrated: boolean
    hydrating: boolean
    connectionBindings?: Readonly<Record<string, ApcConnectionBinding>>
    consent?: Readonly<Record<string, ApcConsent>>
    execution?: ApcExecutionState
    traces?: ApcTraceState
    busy?: boolean
    busyReason?: ApcBusyReason | null
    blockedReasons?: readonly ApcUiMessage[]
  }>): ApcFrontendSnapshot {
    const decodedSource = values.decoded
    const decoded = decodedSource === null ? null : sanitizeDecoded(decodedSource)
    const config = values.config === null ? null : cloneValue(values.config)
    const execution = cloneValue(values.execution ?? this.#execution)
    const executionMutationLocked = execution.phase !== "idle" && !execution.terminal
    const modeIssues = modeIssueMap(decodedSource, config)
    const modeAvailability = modeAvailabilitySurface(config, decodedSource)
    const blockedReasons = [...(values.blockedReasons ?? [])]
    if (values.stale) blockedReasons.push(uiMessage("error.staleConfigReload"))
    const uniqueBlockedReasons = [...new Map(blockedReasons.map((reason) => [JSON.stringify(reason), reason])).values()]
    return deepFreeze({
      presetId: values.presetId,
      decoded,
      config,
      activeMode: values.activeMode,
      modeIssues,
      modeAvailability,
      selection: values.selection === null ? null : cloneValue(values.selection),
      dirty: values.dirty,
      revision: values.revision,
      saveError: values.saveError,
      stale: values.stale,
      availableConnections: cloneValue(values.availableConnections ?? this.#availableConnections),
      connectionBindings: cloneValue(values.connectionBindings ?? this.#connectionBindings),
      consent: cloneValue(values.consent ?? this.#consent),
      execution,
      executionMutationLocked,
      traces: cloneValue(values.traces ?? this.#traceState()),
      busy: values.busy ?? this.#currentBusyReason() !== null,
      busyReason: values.busyReason === undefined ? this.#currentBusyReason() : values.busyReason,
      blockedReasons: uniqueBlockedReasons,
      hydrated: values.hydrated,
      hydrating: values.hydrating,
    })
  }
  #replacePresetState(presetId: string | null): void {
    this.#persistedConfig = null
    this.#persistedRaw = null
    this.#pendingRaw = undefined
    this.#availableConnections = []
    this.#connectionIdsByKey.clear()
    this.#traceIdsByKey.clear()
    this.#traceGeneration += 1
    this.#retiredExecutionIds.clear()
    for (const key of Object.keys(this.#connectionBindings)) delete this.#connectionBindings[key]
    for (const key of Object.keys(this.#consent)) delete this.#consent[key]
    for (const key of Object.keys(this.#traceDetails)) delete this.#traceDetails[key]
    this.#traceSummaries = []
    this.#traceCursor = undefined
    this.#execution = { executionKey: null, phase: "idle", status: "idle", terminal: false, activity: [], topologyActivity: [], topologyApplicable: false }
    this.#executionTopologyInvalidated = false
    this.#executionBusy = false
    this.#executionActivityGeneration = 0
    this.#busyReason = null
    this.#executionId = null
    this.#executionPresetId = presetId
    this.#executionTraceId = null
    this.#snapshot = this.#makeSnapshot({ ...this.#snapshot, presetId, decoded: null, config: null, activeMode: "single", selection: null, dirty: false, revision: 0, saveError: null, stale: false, hydrated: false, hydrating: false, availableConnections: this.#availableConnections, connectionBindings: {}, consent: {}, execution: this.#execution, traces: this.#traceState(), busy: false, busyReason: null })
  }
  #executionIdsByKey(executionKey: string): string | undefined {
    if (this.#execution.executionKey !== executionKey) return undefined
    return this.#executionId ?? undefined
  }

  #traceKey(executionId: string, traceId: string): string {
    for (const [key, identity] of this.#traceIdsByKey) {
      if (identity.executionId === executionId && identity.traceId === traceId) return key
    }
    let index = this.#traceIdsByKey.size + 1
    let key = `trace-${index}`
    while (this.#traceIdsByKey.has(key)) key = `trace-${++index}`
    this.#traceIdsByKey.set(key, { executionId, traceId })
    return key
  }

  #traceSummarySurface(trace: TraceSummary, key = this.#traceKey(trace.executionId, trace.traceId)): ApcTraceSummarySurface {
    return {
      key,
      status: trace.status,
      startedAt: trace.startedAt,
      ...(trace.finishedAt === undefined ? {} : { finishedAt: trace.finishedAt }),
      eventCount: trace.eventCount,
      ...(trace.preview === undefined ? {} : { preview: trace.preview }),
      ...(trace.truncated === undefined ? {} : { truncated: trace.truncated }),
    }
  }
  #projectConnection(connection: ConnectionSummary): ApcConnectionSummary {
    let key: string | undefined
    for (const [candidate, id] of this.#connectionIdsByKey) {
      if (id === connection.id) {
        key = candidate
        break
      }
    }
    if (key === undefined) {
      let index = this.#connectionIdsByKey.size + 1
      key = `connection-${index}`
      while (this.#connectionIdsByKey.has(key)) key = `connection-${++index}`
      this.#connectionIdsByKey.set(key, connection.id)
    }
    return { key, name: connection.name, provider: connection.provider, model: connection.model }
  }
  #applyHydratedDomainState(payload: BackendHydrationResponse["payload"], activityGenerationAtHydrationStart: number): void {
    if (payload.presetId !== this.#snapshot.presetId) return
    const seenBindings = new Set<string>()
    for (const binding of payload.bindings) {
      if (seenBindings.has(binding.slotId)) throw new ApcFrontendStateError("INVALID_HYDRATION", "APC hydration contained duplicate binding slots")
      seenBindings.add(binding.slotId)
    }
    const seenConsents = new Set<string>()
    for (const consent of payload.consents) {
      const key = consentKey({ presetId: payload.presetId, threadId: consent.threadId, workspaceSource: consent.workspaceSource, connectionSourceKey: consent.connectionSourceKey })
      if (seenConsents.has(key)) throw new ApcFrontendStateError("INVALID_HYDRATION", "APC hydration contained duplicate consent scopes")
      seenConsents.add(key)
    }
    for (const key of Object.keys(this.#connectionBindings)) delete this.#connectionBindings[key]
    for (const binding of payload.bindings) {
      this.#connectionBindings[binding.slotId] = deepFreeze(cloneValue({
        slotId: binding.slotId,
        bound: binding.bound,
        ...(binding.status === undefined ? {} : { status: binding.status }),
        ...(binding.bound && binding.descriptor !== undefined ? { descriptor: cloneValue(binding.descriptor) } : {}),
      }))
    }
    for (const key of Object.keys(this.#consent)) delete this.#consent[key]
    for (const consent of payload.consents) {
      this.#setConsent({
        presetId: payload.presetId,
        threadId: consent.threadId,
        workspaceSource: consent.workspaceSource,
        connectionSourceKey: consent.connectionSourceKey,
        status: consent.status,
        ...(consent.destination === undefined ? {} : { destination: cloneValue(consent.destination) }),
        ...(consent.disclosure === undefined ? {} : { disclosure: cloneValue(consent.disclosure) }),
      })
    }
    const hydratedExecution = payload.execution
    if (hydratedExecution !== undefined) {
      const terminalPhase = hydratedExecution.phase === "completed" || hydratedExecution.phase === "failed" || hydratedExecution.phase === "cancelled"
      if (
        hydratedExecution.presetId !== payload.presetId ||
        boundedActivityLabel(hydratedExecution.executionId, 128) === undefined ||
        !["started", "progress", "completed", "failed", "cancelled"].includes(hydratedExecution.phase) ||
        hydratedExecution.terminal !== terminalPhase
      ) {
        throw new ApcFrontendStateError("INVALID_HYDRATION", "APC hydration contained invalid execution activity")
      }
      if (this.#executionActivityGeneration === activityGenerationAtHydrationStart) {
        this.#executionSerial += 1
        this.#executionId = hydratedExecution.executionId
        this.#executionPresetId = hydratedExecution.presetId
        this.#executionTraceId = hydratedExecution.traceId ?? null
        this.#execution = executionFromActivity(hydratedExecution, `execution-${this.#executionSerial}`)
        this.#executionTopologyInvalidated = false
        this.#executionBusy = !this.#execution.terminal
      }
    }
    this.#snapshot = this.#makeSnapshot({
      ...this.#snapshot,
      execution: this.#execution,
      connectionBindings: { ...this.#connectionBindings },
      consent: { ...this.#consent },
      hydrated: true,
      hydrating: false,
    })
    this.#notify()
  }

  #traceDetailSurface(trace: TraceDetail, key = this.#traceKey(trace.executionId, trace.traceId)): ApcTraceDetailSurface {
    return {
      ...this.#traceSummarySurface(trace, key),
      events: trace.events.map((event) => ({
        kind: event.kind,
        sequence: event.sequence,
        timestamp: event.timestamp,
        ...(event.status === undefined ? {} : { status: event.status }),
        ...(event.preview === undefined ? {} : { preview: event.preview }),
      })),
    }
  }
  #applyHydratedConfig(payload: ApcConfigPayload): void {
    const decoded = decodeApcPresetConfig(payload.raw)
    const config = editableConfig(decoded, null)
    this.#persistedConfig = decoded.config === null ? null : cloneValue(decoded.config)
    this.#persistedRaw = cloneValue(payload.raw)
    this.#pendingRaw = undefined
    if (!(decoded.status === "valid" && decoded.config?.supportedModes.some((mode) => mode !== "single") === true)) {
      this.#availableConnections = []
    }
    this.#snapshot = this.#makeSnapshot({
      ...this.#snapshot,
      presetId: payload.presetId,
      decoded,
      config,
      activeMode: config?.activeMode ?? "single",
      dirty: false,
      revision: 0,
      saveError: null,
      stale: false,
      hydrated: false,
      hydrating: true,
      availableConnections: this.#availableConnections,
    })
    this.#notify()
  }
  #startConnectionDiscovery(token: ApcOperationToken, presetId: string): void {
    void this.#persistence.listConnections().then((payload) => {
      if (!this.#isCurrent(token) || this.#snapshot.presetId !== presetId || !this.#snapshot.hydrated) return
      const config = this.#snapshot.config
      if (this.#snapshot.decoded?.status !== "valid" || config === null || !config.supportedModes.some((mode) => mode !== "single")) return
      this.#availableConnections = payload.connections.map((connection) => this.#projectConnection(connection))
      this.#snapshot = this.#makeSnapshot({ ...this.#snapshot, availableConnections: this.#availableConnections })
      this.#notify()
    }).catch(() => {})
  }

  #invalidateExecutionTopology(): void {
    if (!this.#execution.topologyApplicable && this.#execution.topologyActivity.length === 0) return
    this.#execution = deepFreeze({
      ...this.#execution,
      topologyActivity: [],
      topologyApplicable: false,
    })
  }
  #clearTerminalTopology(): void {
    if (!this.#execution.terminal) return
    this.#invalidateExecutionTopology()
  }
  #setConfig(raw: unknown, dirty: boolean): void {
    this.#clearTerminalTopology()
    const decoded = decodeApcPresetConfig(raw)
    const config = editableConfig(decoded, this.#snapshot.config)
    if (!(decoded.status === "valid" && decoded.config?.supportedModes.some((mode) => mode !== "single") === true)) {
      this.#availableConnections = []
    }
    this.#snapshot = this.#makeSnapshot({ ...this.#snapshot, execution: this.#execution, decoded, config, activeMode: config?.activeMode ?? "single", dirty, revision: this.#snapshot.revision + 1, saveError: null, stale: false, availableConnections: this.#availableConnections })
    this.#notify()
  }

  async #flushInternal(): Promise<void> {
    while (true) {
      if (this.#snapshot.stale) throw staleOperationError("save")
      const presetId = this.#snapshot.presetId
      const token = this.#nextOperation("save", presetId)
      if (this.#pendingRaw === undefined || presetId === null || !this.#snapshot.dirty) {
        await this.#persistence.flush()
        this.#assertCurrent(token)
        return
      }
      const raw = cloneValue(this.#pendingRaw)
      const batchRevision = this.#snapshot.revision
      this.#pendingRaw = undefined
      this.#setBusy("save")
      try {
        const result = await this.#persistence.saveConfig(presetId, raw)
        this.#assertCurrent(token)
        this.#acceptSave(result, batchRevision)
      } catch (error) {
        if (!this.#isCurrent(token)) throw error
        if (this.#pendingRaw === undefined && this.#snapshot.revision === batchRevision) this.#pendingRaw = raw
        const surface = saveErrorSurface(error)
        this.#snapshot = this.#makeSnapshot({ ...this.#snapshot, saveError: surface, stale: false, dirty: true })
        this.#notify()
        throw error
      } finally {
        if (this.#isCurrent(token)) this.#setBusy(null)
      }
      if (this.#pendingRaw === undefined && !this.#snapshot.dirty) return
    }
  }
  #acceptSave(result: ApcSaveResult, batchRevision: number): void {
    const decoded = decodeApcPresetConfig(result.raw)
    const config = editableConfig(decoded, this.#snapshot.config)
    this.#persistedConfig = decoded.config === null ? null : cloneValue(decoded.config)
    this.#persistedRaw = cloneValue(result.raw)
    const concurrent = this.#snapshot.revision !== batchRevision
    this.#snapshot = this.#makeSnapshot({
      ...this.#snapshot,
      dirty: concurrent || this.#pendingRaw !== undefined,
      saveError: null,
      stale: false,
      ...(concurrent ? {} : {
        decoded,
        config,
        activeMode: config?.activeMode ?? "single",
      }),
    })
    this.#notify()
  }

  #currentBusyReason(): ApcBusyReason | null {
    return this.#executionBusy ? "execution" : this.#busyReason
  }

  #setBusy(reason: ApcBusyReason | null): void {
    this.#busyReason = reason
    if (this.#disposed) return
    const busyReason = this.#currentBusyReason()
    this.#snapshot = this.#makeSnapshot({ ...this.#snapshot, busy: busyReason !== null, busyReason })
    this.#notify()
  }

  #setConsent(payload: BackendConsentResponse["payload"]): ApcConsent {
    const value: ApcConsent = deepFreeze({
      key: consentKey(payload),
      presetId: payload.presetId,
      threadId: payload.threadId,
      status: payload.status,
      workspaceSource: payload.workspaceSource,
      connectionSourceKey: payload.connectionSourceKey,
      ...(payload.destination === undefined ? {} : { destination: cloneValue(payload.destination) }),
      ...(payload.disclosure === undefined ? {} : { disclosure: cloneValue(payload.disclosure) }),
    })
    this.#consent[value.key] = value
    this.#snapshot = this.#makeSnapshot({ ...this.#snapshot, consent: { ...this.#consent } })
    this.#notify()
    return cloneValue(value)
  }

  #traceState(): ApcTraceState {
    const summaries = this.#traceSummaries.map((trace) => this.#traceSummarySurface(trace))
    const details: Record<string, ApcTraceDetailSurface> = {}
    for (const [key, trace] of Object.entries(this.#traceDetails)) {
      details[key] = this.#traceDetailSurface(trace, key)
    }
    return { summaries, details, ...(this.#traceCursor === undefined ? {} : { nextCursor: this.#traceCursor }) }
  }

  #handleDraftEvent(state: { presetId: string | null; metadata: unknown }, owned: boolean): void {
    if (this.#disposed || owned) return
    if (state.presetId !== this.#snapshot.presetId) {
      this.#presetGeneration += 1
      this.#operationGenerations.clear()
      if (state.presetId === null) {
        this.#replacePresetState(null)
        this.#notify()
        return
      }
      void this.hydrate(state.presetId).catch(() => {})
      return
    }
    if (this.#snapshot.hydrating && state.presetId !== null) {
      void this.hydrate(state.presetId).catch(() => {})
      return
    }
    if (this.#snapshot.stale || !this.#snapshot.hydrated || state.presetId === null) return
    if (this.#snapshot.dirty) {
      this.#presetGeneration += 1
      this.#operationGenerations.clear()
      this.#pendingRaw = undefined
      this.#busyReason = null
      const busyReason = this.#currentBusyReason()
      this.#snapshot = this.#makeSnapshot({
        ...this.#snapshot,
        stale: true,
        busy: busyReason !== null,
        busyReason,
      })
      this.#notify()
      return
    }
    this.#presetGeneration += 1
    this.#operationGenerations.clear()
    this.#executionTopologyInvalidated = this.#execution.executionKey !== null
    if (this.#executionTopologyInvalidated) this.#invalidateExecutionTopology()
    this.#persistedRaw = cloneValue(state.metadata)
    const decoded = decodeApcPresetConfig(state.metadata)
    const config = editableConfig(decoded, this.#snapshot.config)
    this.#persistedConfig = decoded.config === null ? null : cloneValue(decoded.config)
    const activeGraph = decoded.status === "valid" && decoded.config?.supportedModes.some((mode) => mode !== "single") === true
    if (!activeGraph) this.#availableConnections = []
    this.#snapshot = this.#makeSnapshot({
      ...this.#snapshot,
      execution: this.#execution,
      decoded,
      config,
      activeMode: config?.activeMode ?? "single",
      revision: this.#snapshot.revision + 1,
      availableConnections: this.#availableConnections,
    })
    this.#notify()
    if (activeGraph) this.#startConnectionDiscovery(this.#nextOperation("connections", state.presetId), state.presetId)
  }

  #handleDomainMessage(message: ApcDomainResponse): void {
    if (this.#disposed || message.type !== "activity") return
    if (message.payload.presetId !== this.#snapshot.presetId) return
    if (boundedActivityLabel(message.payload.executionId, 128) === undefined) return
    const phase = message.payload.phase
    const expectedTerminal = phase === "completed" || phase === "failed" || phase === "cancelled"
    if (message.payload.terminal !== expectedTerminal) return
    const currentId = this.#executionId
    if (currentId === null) {
      if (phase !== "started" || this.#retiredExecutionIds.has(message.payload.executionId)) return
      this.#executionSerial += 1
      this.#executionId = message.payload.executionId
      this.#executionPresetId = message.payload.presetId
      this.#executionTraceId = message.payload.traceId ?? null
      const executionKey = `execution-${this.#executionSerial}`
      this.#execution = executionFromActivity(message.payload, executionKey)
      this.#executionTopologyInvalidated = false
    } else if (currentId !== message.payload.executionId) {
      if (!this.#execution.terminal || phase !== "started" || this.#retiredExecutionIds.has(message.payload.executionId)) return
      this.#retiredExecutionIds.add(currentId)
      while (this.#retiredExecutionIds.size > 128) {
        const oldest = this.#retiredExecutionIds.values().next().value
        if (typeof oldest !== "string") break
        this.#retiredExecutionIds.delete(oldest)
      }
      this.#executionSerial += 1
      this.#executionId = message.payload.executionId
      this.#executionPresetId = message.payload.presetId
      this.#executionTraceId = message.payload.traceId ?? null
      this.#execution = executionFromActivity(message.payload, `execution-${this.#executionSerial}`)
      this.#executionTopologyInvalidated = false
    } else {
      if (this.#execution.terminal || phase === "started") return
      if (phase !== "progress" && !expectedTerminal) return
      this.#executionTraceId = message.payload.traceId ?? this.#executionTraceId
      this.#execution = executionFromActivity(
        message.payload,
        this.#execution.executionKey as string,
        this.#execution.activity,
        this.#execution.usage,
        this.#execution.topologyActivity,
      )
    }
    if (this.#executionTopologyInvalidated) this.#invalidateExecutionTopology()
    this.#executionActivityGeneration += 1
    this.#executionBusy = !this.#execution.terminal
    const busyReason = this.#currentBusyReason()
    this.#snapshot = this.#makeSnapshot({
      ...this.#snapshot,
      execution: this.#execution,
      busy: busyReason !== null,
      busyReason,
    })
    this.#notify()
  }
  #beginPresetOperation(presetId: string): ApcOperationToken {
    this.#presetGeneration += 1
    this.#operationGenerations.clear()
    return this.#nextOperation("hydrate", presetId)
  }

  #nextOperation(operation: string, presetId: string | null, executionId?: string | null, traceGeneration?: number): ApcOperationToken {
    const requestGeneration = (this.#operationGenerations.get(operation) ?? 0) + 1
    this.#operationGenerations.set(operation, requestGeneration)
    return {
      operation,
      presetId,
      presetGeneration: this.#presetGeneration,
      requestGeneration,
      ...(executionId === undefined ? {} : { executionId }),
      ...(traceGeneration === undefined ? {} : { traceGeneration }),
    }
  }

  #isCurrent(token: ApcOperationToken): boolean {
    return !this.#disposed &&
      token.presetGeneration === this.#presetGeneration &&
      token.presetId === this.#snapshot.presetId &&
      this.#operationGenerations.get(token.operation) === token.requestGeneration &&
      (token.executionId === undefined || token.executionId === this.#executionId) &&
      (token.traceGeneration === undefined || token.traceGeneration === this.#traceGeneration)
  }

  #assertCurrent(token: ApcOperationToken): void {
    if (this.#disposed) throw new ApcFrontendStateError("DISPOSED", "APC frontend state has been disposed")
    if (!this.#isCurrent(token)) throw staleOperationError(token.operation)
  }

  #requirePreset(): string {
    if (this.#snapshot.presetId === null || !this.#snapshot.hydrated) throw new ApcFrontendStateError("NO_PRESET", "APC preset is not hydrated")
    return this.#snapshot.presetId
  }

  #assertUsable(): void {
    if (this.#disposed) throw new ApcFrontendStateError("DISPOSED", "APC frontend state has been disposed")
  }

  #notify(): void {
    if (this.#disposed) return
    for (const listener of [...this.#listeners]) {
      try {
        listener(this.#snapshot)
      } catch {
        // Subscriber failures cannot break state transitions.
      }
    }
  }
}

export function createApcFrontendState(options: ApcFrontendStateOptions): ApcFrontendStore {
  return new ApcFrontendStoreImpl(options)
}
