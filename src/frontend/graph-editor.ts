import type {
  ApcConnectionSlotV1,
  ApcFinalResponseV1,
  ApcInputBindingV1,
  ApcMode,
  ApcPipelineV1,
  ApcPresetConfigV1,
  ApcRunV1,
  ApcStageV1,
  ApcThreadV1,
} from "../config/schema"
import { createDefaultApcConfig } from "../config/schema"
import { deriveModeAvailability, validateConfigForMode } from "../config/validate"
import {
  MAX_BINDINGS_PER_RUN,
  MAX_CONNECTION_SLOTS,
  MAX_FINAL_INPUTS,
  MAX_NAME_CHARS,
  MAX_PARALLEL_WIDTH,
  MAX_RUNS_PER_PIPELINE,
  MAX_STAGES_PER_PIPELINE,
  MAX_THREADS,
  characterCount,
} from "../config/limits"
import type { ApcCatalogKey, ApcTranslate } from "../i18n/catalogs"
import type {
  ApcRunActivityStatus,
  ApcSaveErrorSurface,
  ApcSelection,
  ApcUiMessage,
  ApcValidationIssueSurface,
} from "./state"

/** The mode choices are intentionally stable: they are also the toolbar order. */
export const APC_MODES: readonly ApcMode[] = ["single", "sequential", "parallel"] as const
export const GRAPH_EDITOR_TAB_ID = "agent-graph"
export const GRAPH_EDITOR_TOOLBAR_ITEM_ID = "agent-graph-mode"

const MODE_KEYS: Record<ApcMode, ApcCatalogKey> = {
  single: "mode.single",
  sequential: "mode.sequential",
  parallel: "mode.parallel",
}
const DEFAULT_RUN_TIMEOUT_MS = 60_000
const RUN_STATUSES: readonly ApcRunActivityStatus[] = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
  "timed-out",
  "skipped",
]

export type GraphEditorSurface = "all" | "navigation" | "topology"
export type GraphEditorExecutionActivity = Readonly<{
  stageIndex: number
  runIndex: number
  status: ApcRunActivityStatus
}>
export type GraphEditorExecutionProjection = Readonly<{
  terminal: boolean
  outcome?: "graph-fallback"
  activity: readonly GraphEditorExecutionActivity[]
}>

/** Read-only data consumed by the embedded graph module. */
export interface GraphEditorSnapshot {
  readonly presetId?: string | null
  readonly config: ApcPresetConfigV1 | null
  readonly activeMode?: ApcMode | string | null
  readonly selection?: ApcSelection
  readonly supportedModes?: readonly ApcMode[]
  readonly modeAvailability?: Partial<Record<ApcMode, { supported: boolean; valid: boolean; disabledReason?: ApcUiMessage }>>
  readonly modeIssues?: Partial<Record<ApcMode, readonly ApcValidationIssueSurface[]>>
  readonly validationIssues?: readonly ApcValidationIssueSurface[]
  readonly dirty?: boolean
  readonly busy?: boolean
  readonly blockedReasons?: readonly ApcUiMessage[]
  readonly saveError?: ApcSaveErrorSurface | null
  readonly stale?: boolean
  readonly finalResponseAvailable?: boolean
  readonly finalResponseBlockedReason?: ApcUiMessage
  /** Safe, identity-free execution state used only to project topology status. */
  readonly execution?: GraphEditorExecutionProjection
  /** Explicit state-owner authority for rejecting every graph/config mutation. */
  readonly mutationLocked?: boolean
  readonly locale?: string
}

export interface GraphEditorStateReader {
  get?(): GraphEditorSnapshot
  getSnapshot?(): GraphEditorSnapshot
  subscribe(listener: (snapshot: GraphEditorSnapshot) => void): () => void
}

export type GraphEditorMutation =
  | { readonly type: "mode"; readonly mode: ApcMode }
  | { readonly type: "config"; readonly config: ApcPresetConfigV1; readonly reason: string }

export interface GraphEditorMutationCallbacks {
  /** Receives every immutable config update, including mode changes. */
  readonly onConfigChange?: (config: ApcPresetConfigV1, mutation: GraphEditorMutation) => void | Promise<void>
  /** Optional specialized mode path (usually FrontendState.requestMode). */
  readonly onModeChange?: (mode: ApcMode) => void | Promise<void>
  /** Optional generic mutation path for state stores that own draft bookkeeping. */
  readonly onMutation?: (mutation: GraphEditorMutation) => void | Promise<void>
  /** Adds a portable connection slot; the graph allocates its opaque identifier. */
  readonly onAddConnectionSlot?: (slot: ApcConnectionSlotV1) => void | Promise<void>
  /** Renames a portable connection slot using its opaque identifier. */
  readonly onRenameConnectionSlot?: (slotId: string, label: string) => void | Promise<void>
  /** Removes an unreferenced portable connection slot using its opaque identifier. */
  readonly onRemoveConnectionSlot?: (slotId: string) => void | Promise<void>
}

export interface GraphEditorLiveRegion {
  readonly element?: HTMLElement
  announce(message: string, priority?: "polite" | "assertive"): void
  clear?(): void
  cleanup?(): void
}

export interface GraphEditorAccessibility {
  readonly liveRegion?: GraphEditorLiveRegion
  readonly announce?: (message: string, priority?: "polite" | "assertive") => void
  readonly focusElement?: (element: HTMLElement) => void
}

/** Host/frontend DOM helpers are injected so this view never reaches through the host document. */
export interface GraphEditorDomPrimitives {
  readonly createLiveRegion?: (
    root: HTMLElement,
    options?: { priority?: "polite" | "assertive"; label?: string },
  ) => GraphEditorLiveRegion
  readonly focusElement?: (element: HTMLElement) => void
}

export interface GraphEditorOptions extends GraphEditorMutationCallbacks {
  readonly t: ApcTranslate
  /** Optional deterministic UUID prefix source for collision-focused tests. */
  readonly idFactory?: () => string | undefined
  readonly document?: Document
  readonly snapshot?: GraphEditorSnapshot
  /** Defaults to all; split mounts use navigation on the left and topology in the center. */
  readonly surface?: GraphEditorSurface
  /** Optional host root for the navigation/all surface's single execution-mode toolbar. */
  readonly toolbarHost?: HTMLElement
  readonly state?: GraphEditorStateReader
  readonly liveRegion?: GraphEditorLiveRegion
  readonly announce?: (message: string, priority?: "polite" | "assertive") => void
  readonly focusElement?: (element: HTMLElement) => void
  readonly accessibility?: GraphEditorAccessibility
  readonly dom?: GraphEditorDomPrimitives
  readonly canFinalizeThread?: boolean
  readonly threadFinalBlockedReason?: ApcUiMessage
  /** Emits navigation only. The state owner decides which separate detail pane to mount. */
  readonly onSelectionChange?: (selection: ApcSelection) => void | Promise<void>
  /** Opens the selected thread's host-controlled Loom workspace without mutating graph state. */
  readonly onOpenLoom?: (threadId: string) => void | Promise<void>
}

export interface GraphEditorHandle {
  readonly element: HTMLElement
  render(snapshot: GraphEditorSnapshot): void
  destroy(): void
}

interface InternalSnapshot extends GraphEditorSnapshot {
  readonly config: ApcPresetConfigV1 | null
  readonly selection: ApcSelection
}

interface ActionTarget extends HTMLElement {
  dataset: DOMStringMap & {
    action?: string
    mode?: string
    apcStageKey?: string
    apcRunKey?: string
    apcThreadKey?: string
    apcSlotKey?: string
    direction?: string
    confirmationKind?: string
    preserveMode?: string
    value?: string
  }
}

type RemovalKind = "thread" | "stage" | "run" | "slot"
function sanitizeConnectionSlotLabel(value: string): string | null {
  const trimmed = value.trim()
  if (
    trimmed.length === 0 ||
    characterCount(trimmed) > MAX_NAME_CHARS ||
    /[\u0000-\u001f\u007f\n\r]/u.test(trimmed)
  ) return null
  return trimmed
}
interface PendingConfirmation {
  readonly kind: RemovalKind
  readonly id: string
  readonly label: string
  readonly affectedRuns: number
  readonly affectedBindings: number
  readonly affectsFinalRoute: boolean
}

function clone<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value)
  return JSON.parse(JSON.stringify(value)) as T
}

function asMode(value: unknown): ApcMode | null {
  return value === "single" || value === "sequential" || value === "parallel" ? value : null
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const MAX_ID_COUNTER = 0xffffffffffff
type GraphIdFactory = () => string | undefined
type GraphIdAllocator = (config: ApcPresetConfigV1, extra?: readonly string[]) => string
interface GraphIdCounter {
  value: number
}

function createGraphIdPrefix(idFactory: GraphIdFactory | undefined): string {
  const prefix = idFactory ? idFactory() : globalThis.crypto?.randomUUID?.()
  if (prefix !== undefined && UUID_PATTERN.test(prefix)) return prefix.toLowerCase()
  throw new Error("Unable to initialize a graph identifier prefix")
}

function collectGraphIds(config: ApcPresetConfigV1 | null): Set<string> {
  const ids = new Set<string>()
  if (!config) return ids
  ids.add(config.mainThread.id)
  for (const slot of config.connectionSlots) ids.add(slot.id)
  for (const thread of config.threads) ids.add(thread.id)
  for (const pipeline of [config.pipelines.sequential, config.pipelines.parallel]) {
    if (!pipeline) continue
    ids.add(pipeline.id)
    for (const stage of pipeline.stages) {
      ids.add(stage.id)
      for (const run of stage.runs) ids.add(run.id)
    }
  }
  return ids
}

function nextId(
  config: ApcPresetConfigV1,
  extra: readonly string[],
  prefix: string,
  counter: GraphIdCounter,
): string {
  const used = collectGraphIds(config)
  for (const id of extra) used.add(id)
  for (const id of used) {
    const normalized = id.toLowerCase()
    if (normalized !== id) used.add(normalized)
  }
  while (counter.value < MAX_ID_COUNTER) {
    counter.value += 1
    const candidate = `${prefix.slice(0, 24)}${counter.value.toString(16).padStart(12, "0")}`
    if (!used.has(candidate)) return candidate
  }
  throw new Error("Graph identifier counter exhausted")
}

function retainFinalRouteAncestors(
  pipeline: ApcPipelineV1,
  route: ApcFinalResponseV1,
): ApcPipelineV1 {
  return {
    ...pipeline,
    finalResponse: clone(route),
  }
}

function textFromTemplate(template: string, values: Readonly<Record<string, unknown>>): string {
  return template.replace(/\{\{([A-Za-z0-9_]+)\}\}/gu, (token, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : token,
  )
}

/** Uses the catalog while retaining explicit fallback copy for isolated test translators. */
function copy(
  t: ApcTranslate,
  key: ApcCatalogKey,
  fallback: string,
  values: Readonly<Record<string, unknown>> = {},
): string {
  const localized = t(key, values)
  return localized || textFromTemplate(fallback, values)
}

function modeLabel(mode: ApcMode, t: ApcTranslate): string {
  return t(MODE_KEYS[mode])
}

function htmlElement(document: Document, tag: string, className?: string): HTMLElement {
  const element = document.createElement(tag)
  if (className) element.className = className
  return element
}

function actionButton(
  document: Document,
  label: string,
  action: string,
  data: Readonly<Record<string, string>> = {},
  mutates = false,
): HTMLButtonElement {
  const element = document.createElement("button")
  element.type = "button"
  element.textContent = label
  element.dataset.action = action
  if (mutates) element.dataset.apcMutates = "true"
  for (const [key, value] of Object.entries(data)) element.dataset[key] = value
  return element
}

function localizeMessage(message: ApcUiMessage, t: ApcTranslate): string {
  return t(message.key, message.values)
}

function issueCatalogKey(code: string): ApcCatalogKey {
  if (code.includes("TIMEOUT")) return "validation.issueTimeout"
  if (code.includes("REFERENCE")) return "validation.issueReference"
  if (code.includes("MODE")) return "validation.issueMode"
  if (code.includes("PIPELINE")) return "validation.issuePipeline"
  if (code.includes("STAGE")) return "validation.issueStage"
  if (code.includes("RUN")) return "validation.issueRun"
  if (code.includes("THREAD")) return "validation.issueThread"
  if (code.includes("ROUTE") || code.includes("FINAL")) return "validation.issueRoute"
  if (code.includes("POLICY") || code === "SKIP_REQUIRED" || code === "REQUIRED_CLOSURE") return "validation.issuePolicy"
  if (code.endsWith("_LIMIT")) return "validation.issueLimit"
  if (code.endsWith("_TYPE")) return "validation.issueType"
  return "validation.issueUnknown"
}

function issueMessage(issue: Pick<ApcValidationIssueSurface, "code">): ApcUiMessage {
  const key = issueCatalogKey(issue.code)
  return key === "validation.issueUnknown" ? { key, values: { code: issue.code } } : { key }
}

function localizeIssues(issues: readonly Pick<ApcValidationIssueSurface, "code">[], t: ApcTranslate): string {
  return issues.map((issue) => localizeMessage(issueMessage(issue), t)).join(" ") || t("validation.invalid")
}

function pipelineFor(config: ApcPresetConfigV1 | null, mode: ApcMode): ApcPipelineV1 | undefined {
  if (!config || mode === "single") return undefined
  return config.pipelines[mode]
}

function effectiveMode(snapshot: GraphEditorSnapshot): ApcMode | null {
  return asMode(snapshot.activeMode ?? snapshot.config?.activeMode)
}

function defaultThread(config: ApcPresetConfigV1, id: string, t: ApcTranslate): ApcThreadV1 {
  return {
    id,
    name: t("graph.defaultThreadName", { index: config.threads.length + 1 }),
    description: "",
    workspaceSource: "native-blocks",
    blocks: [],
    promptVariableValues: {},
    output: { id: "final", name: "Final Response" },
  }
}

function defaultRun(threadId: string, id: string): ApcRunV1 {
  return { id, threadId, required: true, timeoutMs: DEFAULT_RUN_TIMEOUT_MS, inputs: [] }
}

function createPipeline(
  config: ApcPresetConfigV1,
  mode: "sequential" | "parallel",
  t: ApcTranslate,
  allocateId: GraphIdAllocator,
): ApcPresetConfigV1 {
  let next = clone(config)
  let thread = next.threads[0]
  if (!thread) {
    const threadId = allocateId(next)
    thread = defaultThread(next, threadId, t)
    next = { ...next, threads: [...next.threads, thread] }
  }
  const runId = allocateId(next)
  const stageId = allocateId(next, [runId])
  const pipelineId = allocateId(next, [runId, stageId])
  const stage: ApcStageV1 = {
    id: stageId,
    name: t("graph.defaultStageName", { index: 1 }),
    runs: [defaultRun(thread.id, runId)],
  }
  return {
    ...next,
    activeMode: mode,
    supportedModes: next.supportedModes.includes(mode) ? next.supportedModes : [...next.supportedModes, mode],
    pipelines: {
      ...next.pipelines,
      [mode]: { id: pipelineId, stages: [stage], finalResponse: { source: "thread", runId } },
    },
  }
}

function modeIsBlocked(snapshot: GraphEditorSnapshot, mode: ApcMode, t: ApcTranslate): string | null {
  const availability = snapshot.modeAvailability?.[mode]
  if (availability && !availability.supported) {
    const label = modeLabel(mode, t)
    const reason = availability.disabledReason
      ? localizeMessage(availability.disabledReason, t)
      : t("mode.unsupported", { mode: label })
    return t("mode.unsupportedReason", { mode: label, reason })
  }
  if (availability && !availability.valid) {
    const label = modeLabel(mode, t)
    const reason = snapshot.modeIssues?.[mode]?.length
      ? localizeIssues(snapshot.modeIssues[mode] ?? [], t)
      : availability.disabledReason
        ? localizeMessage(availability.disabledReason, t)
        : t("mode.invalid", { mode: label })
    return t("mode.invalidReason", { mode: modeLabel(mode, t), reason })
  }
  if (mode === "single") return null
  if (!snapshot.config) return t("mode.configUnavailable")
  if (!(snapshot.supportedModes ?? snapshot.config.supportedModes).includes(mode)) {
    const label = modeLabel(mode, t)
    return t("mode.unsupportedReason", { mode: label, reason: t("mode.unsupported", { mode: label }) })
  }
  try {
    const derived = deriveModeAvailability(snapshot.config)[mode]
    if (!derived.supported) {
      const label = modeLabel(mode, t)
      return t("mode.unsupportedReason", { mode: label, reason: t("mode.unsupported", { mode: label }) })
    }
    if (!derived.valid) {
      const validation = validateConfigForMode(snapshot.config, mode)
      return t("mode.invalidReason", {
        mode: modeLabel(mode, t),
        reason: validation.valid ? t("mode.invalid", { mode: modeLabel(mode, t) }) : localizeIssues(validation.issues, t),
      })
    }
  } catch {
    const label = modeLabel(mode, t)
    return t("mode.invalidReason", { mode: label, reason: t("mode.invalid", { mode: label }) })
  }
  return null
}

function updatePipeline(
  config: ApcPresetConfigV1,
  mode: "sequential" | "parallel",
  mutate: (pipeline: ApcPipelineV1) => ApcPipelineV1,
): ApcPresetConfigV1 {
  const pipeline = config.pipelines[mode]
  if (!pipeline) return config
  return { ...config, pipelines: { ...config.pipelines, [mode]: mutate(clone(pipeline)) } }
}

function removeReferences(config: ApcPresetConfigV1, runIds: ReadonlySet<string>): ApcPresetConfigV1 {
  const pipelines = { ...config.pipelines }
  for (const mode of ["sequential", "parallel"] as const) {
    const pipeline = pipelines[mode]
    if (!pipeline) continue
    const stages = pipeline.stages
      .map((stage) => ({
        ...stage,
        runs: stage.runs.map((run) => ({
          ...run,
          inputs: run.inputs.filter((input) => input.source !== "output" || !runIds.has(input.runId)),
        })),
      }))
      .filter((stage) => stage.runs.length > 0)
    const finalResponse: ApcFinalResponseV1 = pipeline.finalResponse.source === "main"
      ? {
          source: "main",
          inputs: pipeline.finalResponse.inputs.filter((input) => !runIds.has(input.runId)),
        }
      : clone(pipeline.finalResponse)
    pipelines[mode] = { ...pipeline, stages, finalResponse }
  }
  return { ...config, pipelines }
}

function outputReferencesAreEarlier(stages: readonly ApcStageV1[]): boolean {
  const stageIndexByRun = new Map<string, number>()
  stages.forEach((stage, stageIndex) => {
    for (const run of stage.runs) stageIndexByRun.set(run.id, stageIndex)
  })
  return stages.every((stage, stageIndex) =>
    stage.runs.every((run) =>
      run.inputs.every((input) =>
        input.source !== "output" || (stageIndexByRun.get(input.runId) ?? stageIndex) < stageIndex,
      ),
    ),
  )
}

function runCount(pipeline: ApcPipelineV1): number {
  return pipeline.stages.reduce((total, stage) => total + stage.runs.length, 0)
}

type ParallelRunAttachment =
  | Readonly<{ kind: "downstream"; runId: string }>
  | Readonly<{ kind: "final" }>

function parallelRunAttachment(
  pipeline: ApcPipelineV1,
  stageIndex: number,
  reachableRunIds: ReadonlySet<string>,
): ParallelRunAttachment | null {
  for (let index = stageIndex + 1; index < pipeline.stages.length; index += 1) {
    const stage = pipeline.stages[index]
    if (stage === undefined) continue
    for (const run of stage.runs) {
      if (reachableRunIds.has(run.id) && run.inputs.length < MAX_BINDINGS_PER_RUN) {
        return { kind: "downstream", runId: run.id }
      }
    }
  }
  if (pipeline.finalResponse.source === "main" && pipeline.finalResponse.inputs.length >= MAX_FINAL_INPUTS) {
    return null
  }
  return { kind: "final" }
}

function canonicalMainFinalRunId(pipeline: ApcPipelineV1): string | undefined {
  if (pipeline.finalResponse.source !== "main" || pipeline.finalResponse.inputs.length !== 1) return undefined
  const input = pipeline.finalResponse.inputs[0]
  return input.onMissing === "fail-graph" ? input.runId : undefined
}

function finalRouteUsesRun(pipeline: ApcPipelineV1, runId: string): boolean {
  return pipeline.finalResponse.source === "thread"
    ? pipeline.finalResponse.runId === runId
    : pipeline.finalResponse.inputs.some((input) => input.runId === runId)
}

function threadOwnsFinalRoute(config: ApcPresetConfigV1, threadId: string): boolean {
  return [config.pipelines.sequential, config.pipelines.parallel].some((pipeline) =>
    pipeline?.stages.some((stage) =>
      stage.runs.some((run) => run.threadId === threadId && finalRouteUsesRun(pipeline, run.id)),
    ) === true,
  )
}

function threadOwnsEveryRunInPipeline(config: ApcPresetConfigV1, threadId: string): boolean {
  return [config.pipelines.sequential, config.pipelines.parallel].some((pipeline) => {
    const runs = pipeline?.stages.flatMap((stage) => stage.runs) ?? []
    return runs.some((run) => run.threadId === threadId) && runs.every((run) => run.threadId === threadId)
  })
}

function selectionExists(config: ApcPresetConfigV1, selection: ApcSelection, mode: ApcMode): boolean {
  if (selection === null || selection.kind === "main") return true
  if (selection.kind === "thread") return config.threads.some((thread) => thread.id === selection.threadId)
  const pipeline = mode === "single" ? undefined : config.pipelines[mode]
  if (!pipeline) return false
  if (selection.kind === "stage") return pipeline.stages.some((stage) => stage.id === selection.stageId)
  return pipeline.stages.some((stage) => stage.runs.some((run) => run.id === selection.runId))
}

function sameSelection(left: ApcSelection, right: ApcSelection): boolean {
  if (left === null || right === null) return left === right
  if (left.kind !== right.kind) return false
  if (left.kind === "main") return true
  if (left.kind === "thread" && right.kind === "thread") return left.threadId === right.threadId
  if (left.kind === "stage" && right.kind === "stage") return left.stageId === right.stageId
  return left.kind === "run" && right.kind === "run" && left.runId === right.runId
}

/**
 * Mount the extension-owned Agent Graph editor. It renders compact topology and
 * emits immutable mutation and selection intents; persistence and detail panes
 * remain owned by the injected frontend state owner.
 */
export function createGraphEditor(options: GraphEditorOptions): GraphEditorHandle {
  const document = options.document ?? globalThis.document
  if (!document) throw new Error("A document is required to mount the Agent Graph editor")
  const t = options.t
  const surface: GraphEditorSurface =
    options.surface === "navigation" || options.surface === "topology" ? options.surface : "all"
  const element = htmlElement(document, "section", "apc-graph-editor")
  element.dataset.apcGraphEditor = "true"
  element.dataset.apcGraphRoot = "true"
  element.dataset.apcModule = "graph-editor"
  element.dataset.apcGraphSurface = surface
  element.setAttribute("aria-label", t("graph.editorAria"))
  const editorStatus = htmlElement(document, "div", "apc-editor-status")
  editorStatus.dataset.apcEditorStatus = "true"
  editorStatus.tabIndex = -1
  editorStatus.setAttribute("aria-live", "polite")
  let lastEditorStatusText: string | undefined
  const toolbarRoot = surface !== "topology" && options.toolbarHost
    ? htmlElement(document, "div", "apc-graph-toolbar-contribution")
    : null
  const ownsLiveRegion = surface !== "topology"
  if (toolbarRoot) {
    toolbarRoot.dataset.apcGraphToolbarOwned = "true"
    options.toolbarHost?.append(toolbarRoot)
  }
  const interactiveRoots = (): readonly HTMLElement[] =>
    toolbarRoot ? [element, toolbarRoot] : [element]

  let current = normalizeSnapshot(options.snapshot)
  let destroyed = false
  let pendingConfirmation: PendingConfirmation | null = null
  let focusAfterRender: Readonly<Record<string, string>> | null = null
  let renderRevision = 0
  let authoritativeRenderRevision = 0
  let liveRegion = options.liveRegion ?? options.accessibility?.liveRegion
  let connectionSlotMutationPending = false
  let unsubscribeState: (() => void) | undefined

  const graphIdPrefix = createGraphIdPrefix(options.idFactory)
  const graphIdCounter: GraphIdCounter = { value: 0 }
  const graphIdStem = graphIdPrefix.slice(0, 24)
  const observeImportedIds = (config: ApcPresetConfigV1 | null): void => {
    for (const id of collectGraphIds(config)) {
      const normalized = id.toLowerCase()
      if (!UUID_PATTERN.test(normalized) || !normalized.startsWith(graphIdStem)) continue
      const suffix = Number.parseInt(normalized.slice(graphIdStem.length), 16)
      if (Number.isSafeInteger(suffix) && suffix > graphIdCounter.value) graphIdCounter.value = suffix
    }
  }
  const allocateId: GraphIdAllocator = (config, extra = []) => {
    observeImportedIds(config)
    return nextId(config, extra, graphIdPrefix, graphIdCounter)
  }
  observeImportedIds(current.config)


  type UiEntityKind = "thread" | "stage" | "run" | "slot"
  const uiKeys: Record<UiEntityKind, {
    next: number
    readonly byId: Map<string, string>
    readonly byKey: Map<string, string>
  }> = {
    thread: { next: 1, byId: new Map(), byKey: new Map() },
    stage: { next: 1, byId: new Map(), byKey: new Map() },
    run: { next: 1, byId: new Map(), byKey: new Map() },
    slot: { next: 1, byId: new Map(), byKey: new Map() },
  }
  const uiKeyFor = (kind: UiEntityKind, id: string): string => {
    const registry = uiKeys[kind]
    const existing = registry.byId.get(id)
    if (existing) return existing
    const key = `${kind}-${registry.next}`
    registry.next += 1
    registry.byId.set(id, key)
    registry.byKey.set(key, id)
    return key
  }
  const idForUiKey = (kind: UiEntityKind, key: string | undefined): string | undefined =>
    key === undefined ? undefined : uiKeys[kind].byKey.get(key)
  const focusEntity = (action: string, kind: UiEntityKind, id: string): Readonly<Record<string, string>> => ({
    action,
    [`apc${kind[0].toUpperCase()}${kind.slice(1)}Key`]: uiKeyFor(kind, id),
  })
  if (ownsLiveRegion && !liveRegion && options.dom?.createLiveRegion) {
    liveRegion = options.dom.createLiveRegion(element, { priority: "polite", label: t("graph.editorAria") })
  }

  const announce = (message: string, priority: "polite" | "assertive" = "polite"): void => {
    if (liveRegion) liveRegion.announce(message, priority)
    else if (options.announce) options.announce(message, priority)
    else options.accessibility?.announce?.(message, priority)
  }

  const focus = (target: HTMLElement | null): void => {
    if (!target) return
    if (options.focusElement) options.focusElement(target)
    else if (options.accessibility?.focusElement) options.accessibility.focusElement(target)
    else if (options.dom?.focusElement) options.dom.focusElement(target)
    else target.focus()
  }

  const invoke = (callback: (() => void | Promise<void>) | undefined): void => {
    if (!callback) return
    try {
      const result = callback()
      if (result && typeof (result as Promise<void>).then === "function") {
        void (result as Promise<void>).catch(() => announce(t("a11y.error", { message: t("status.editorBusyOrBlocked") }), "assertive"))
      }
    } catch {
      announce(t("a11y.error", { message: t("status.editorBusyOrBlocked") }), "assertive")
    }
  }

  const locked = (): boolean =>
    connectionSlotMutationPending ||
    current.mutationLocked === true ||
    (current.execution !== undefined && !current.execution.terminal) ||
    current.busy === true ||
    current.stale === true ||
    (current.blockedReasons?.length ?? 0) > 0
  const dismissPendingConfirmation = (): void => {
    const confirmation = pendingConfirmation
    if (!confirmation) return
    pendingConfirmation = null
    if (confirmation.kind === "thread") {
      focusAfterRender = focusEntity("select-thread", "thread", confirmation.id)
      return
    }
    if (confirmation.kind === "run") {
      focusAfterRender = focusEntity("select-run", "run", confirmation.id)
      return
    }
    if (confirmation.kind === "slot") {
      focusAfterRender = focusEntity("remove-connection-slot", "slot", confirmation.id)
      return
    }
    const mode = effectiveMode(current) ?? "single"
    const run = pipelineFor(current.config, mode)?.stages.find((stage) => stage.id === confirmation.id)?.runs[0]
    focusAfterRender = run ? focusEntity("select-run", "run", run.id) : { action: "select-mode", mode }
  }


  const emitSelection = (selection: ApcSelection, label: string): void => {
    if (destroyed || sameSelection(current.selection, selection)) return
    current = { ...current, selection }
    const revisionBeforeCallbacks = renderRevision
    invoke(() => options.onSelectionChange?.(selection))
    announce(copy(t, "a11y.graphSelectionChanged", "Selected {{label}}.", { label }))
    if (renderRevision === revisionBeforeCallbacks) renderCurrent()
  }

  const emitMutation = (
    config: ApcPresetConfigV1,
    mutation: GraphEditorMutation,
    announcementKey: ApcCatalogKey | "a11y.graphCreated",
    fallback: string,
    values: Readonly<Record<string, unknown>> = {},
  ): void => {
    if (destroyed) return
    if (locked()) {
      announce(current.stale ? t("error.staleConfigReload") : t("status.editorBusyOrBlocked"), "assertive")
      return
    }
    dismissPendingConfirmation()
    const nextConfig = clone(config)
    const nextSelection = selectionExists(nextConfig, current.selection, nextConfig.activeMode) ? current.selection : null
    const selectionChanged = !sameSelection(nextSelection, current.selection)
    current = { ...current, config: nextConfig, activeMode: nextConfig.activeMode, selection: nextSelection, dirty: true }
    const revisionBeforeCallbacks = renderRevision
    if (selectionChanged) invoke(() => options.onSelectionChange?.(nextSelection))
    invoke(() => options.onMutation?.(mutation))
    invoke(() => options.onConfigChange?.(clone(nextConfig), mutation))
    announce(t("a11y.changeUnsaved", { change: copy(t, announcementKey, fallback, values) }))
    if (renderRevision === revisionBeforeCallbacks) renderCurrent()
  }
  const emitConnectionSlotMutation = (
    config: ApcPresetConfigV1,
    mutation: GraphEditorMutation,
    callback: (() => void | Promise<void>) | undefined,
    announcementKey: ApcCatalogKey,
    fallback: string,
  ): void => {
    if (!callback) {
      emitMutation(config, mutation, announcementKey, fallback)
      return
    }
    if (destroyed) return
    if (locked()) {
      announce(current.stale ? t("error.staleConfigReload") : t("status.editorBusyOrBlocked"), "assertive")
      return
    }
    dismissPendingConfirmation()
    const previousSnapshot = current
    const nextConfig = clone(config)
    const optimisticConfigKey = JSON.stringify(nextConfig)
    const nextSelection = selectionExists(nextConfig, current.selection, nextConfig.activeMode) ? current.selection : null
    const selectionChanged = !sameSelection(nextSelection, current.selection)
    connectionSlotMutationPending = true
    current = { ...current, config: nextConfig, activeMode: nextConfig.activeMode, selection: nextSelection, dirty: true }
    const revisionBeforeCallbacks = renderRevision
    if (selectionChanged) invoke(() => options.onSelectionChange?.(nextSelection))
    if (renderRevision === revisionBeforeCallbacks) renderCurrent()
    let callbackAuthorityRevision = authoritativeRenderRevision
    const rollback = (): void => {
      const shouldRestore = authoritativeRenderRevision === callbackAuthorityRevision
        && current.config !== null
        && JSON.stringify(current.config) === optimisticConfigKey
      connectionSlotMutationPending = false
      if (destroyed) return
      if (shouldRestore) {
        current = {
          ...current,
          config: previousSnapshot.config,
          activeMode: previousSnapshot.activeMode,
          selection: previousSnapshot.selection,
          dirty: previousSnapshot.dirty,
        }
      }
      renderCurrent()
    }
    const publish = (): void => {
      connectionSlotMutationPending = false
      if (destroyed) return
      if (
        authoritativeRenderRevision !== callbackAuthorityRevision ||
        current.config === null ||
        JSON.stringify(current.config) !== optimisticConfigKey
      ) {
        renderCurrent()
        return
      }
      const revisionBeforeObservers = renderRevision
      invoke(() => options.onMutation?.(mutation))
      invoke(() => options.onConfigChange?.(clone(nextConfig), mutation))
      announce(t("a11y.changeUnsaved", { change: copy(t, announcementKey, fallback) }))
      if (renderRevision === revisionBeforeObservers) renderCurrent()
    }
    const fail = (): void => {
      rollback()
      announce(t("a11y.error", { message: t("status.editorBusyOrBlocked") }), "assertive")
    }
    try {
      const result = callback()
      callbackAuthorityRevision = authoritativeRenderRevision
      if (result && typeof (result as Promise<void>).then === "function") {
        void (result as Promise<void>).then(publish, fail)
      } else {
        publish()
      }
    } catch {
      fail()
    }
  }

  const selectedMode = (): ApcMode => effectiveMode(current) ?? "single"
  const limitMessage = (kind: string, limit: number): string =>
    copy(t, "graph.limitReached", "{{kind}} limit reached ({{limit}}).", { kind, limit })


  const emitMode = (mode: ApcMode): void => {
    if (locked()) return
    const reason = modeIsBlocked(current, mode, t)
    if (reason) {
      announce(t("mode.unavailableReason", { mode: modeLabel(mode, t), reason }), "assertive")
      return
    }
    if (!current.config) {
      invoke(() => options.onModeChange?.(mode))
      invoke(() => options.onMutation?.({ type: "mode", mode }))
      announce(t("a11y.modeChanged", { mode: modeLabel(mode, t) }))
      return
    }
    const next = { ...clone(current.config), activeMode: mode }
    dismissPendingConfirmation()
    invoke(() => options.onModeChange?.(mode))
    focusAfterRender = { action: "select-mode", mode }
    emitMutation(next, { type: "mode", mode }, "a11y.modeChanged", "Execution mode changed to {{mode}}.", { mode: modeLabel(mode, t) })
  }
  const createGraph = (mode: "sequential" | "parallel", activate = true): void => {
    if (locked()) {
      announce(current.stale ? t("error.staleConfigReload") : t("status.editorBusyOrBlocked"), "assertive")
      return
    }
    const config = current.config ? clone(current.config) : createDefaultApcConfig()
    if (config.pipelines[mode]) return
    const created = createPipeline(config, mode, t, allocateId)
    const next = activate ? created : { ...created, activeMode: config.activeMode }
    dismissPendingConfirmation()
    if (activate) invoke(() => options.onModeChange?.(mode))
    focusAfterRender = { action: "select-mode", mode: next.activeMode }
    emitMutation(next, { type: "config", config: clone(next), reason: `graph-created-${mode}` }, "a11y.graphCreated", "{{mode}} graph created.", { mode: modeLabel(mode, t) })
  }
  const addThread = (): void => {
    if (!current.config) return
    if (current.config.threads.length >= MAX_THREADS) {
      announce(limitMessage(t("graph.threads"), MAX_THREADS), "assertive")
      return
    }
    const config = clone(current.config)
    const id = allocateId(config)
    const next = { ...config, threads: [...config.threads, defaultThread(config, id, t)] }
    emitMutation(
      next,
      { type: "config", config: clone(next), reason: "thread-added" },
      "a11y.changeThreadAdded",
      "Thread added.",
    )
  }
  const addConnectionSlot = (): void => {
    if (!current.config || selectedMode() !== "parallel") return
    if (current.config.connectionSlots.length >= MAX_CONNECTION_SLOTS) {
      announce(limitMessage(t("agentGraph.slot"), MAX_CONNECTION_SLOTS), "assertive")
      return
    }
    const config = clone(current.config)
    const slot: ApcConnectionSlotV1 = {
      id: allocateId(config),
      label: `${t("agentGraph.slot")} ${config.connectionSlots.length + 1}`,
    }
    const next = { ...config, connectionSlots: [...config.connectionSlots, slot] }
    emitConnectionSlotMutation(
      next,
      { type: "config", config: clone(next), reason: "connection-slot-added" },
      options.onAddConnectionSlot === undefined ? undefined : () => options.onAddConnectionSlot!(clone(slot)),
      "a11y.changeConnectionSlotAdded",
      "Connection slot added.",
    )
  }

  const renameConnectionSlot = (slotId: string, value: string): void => {
    if (!current.config || selectedMode() !== "parallel") return
    const label = sanitizeConnectionSlotLabel(value)
    if (label === null) {
      announce(t("validation.invalid"), "assertive")
      renderCurrent()
      return
    }
    const slot = current.config.connectionSlots.find((candidate) => candidate.id === slotId)
    if (!slot || slot.label === label) return
    const config = clone(current.config)
    const next = {
      ...config,
      connectionSlots: config.connectionSlots.map((candidate) =>
        candidate.id === slotId ? { ...candidate, label } : candidate
      ),
    }
    emitConnectionSlotMutation(
      next,
      { type: "config", config: clone(next), reason: "connection-slot-renamed" },
      options.onRenameConnectionSlot === undefined ? undefined : () => options.onRenameConnectionSlot!(slotId, label),
      "a11y.changeConnectionSlotRenamed",
      "Connection slot renamed.",
    )
  }

  const removeConnectionSlot = (slotId: string): void => {
    if (!current.config || selectedMode() !== "parallel") return
    const slot = current.config.connectionSlots.find((candidate) => candidate.id === slotId)
    if (!slot) return
    if (current.config.threads.some((thread) => thread.connectionSlotId === slotId)) {
      announce(copy(t, "graph.connectionSlotReferenced", "Change the threads using this connection slot before removing it."), "assertive")
      return
    }
    const config = clone(current.config)
    const next = { ...config, connectionSlots: config.connectionSlots.filter((candidate) => candidate.id !== slotId) }
    emitConnectionSlotMutation(
      next,
      { type: "config", config: clone(next), reason: "connection-slot-removed" },
      options.onRemoveConnectionSlot === undefined ? undefined : () => options.onRemoveConnectionSlot!(slotId),
      "a11y.changeConnectionSlotRemoved",
      "Connection slot removed.",
    )
  }

  const addStage = (): void => {
    const mode = selectedMode()
    if (mode === "single" || !current.config) return
    const pipeline = pipelineFor(current.config, mode)
    const thread = current.config.threads[0]
    if (!pipeline || !thread) return
    if (pipeline.stages.length >= MAX_STAGES_PER_PIPELINE) {
      announce(limitMessage(t("graph.stages"), MAX_STAGES_PER_PIPELINE), "assertive")
      return
    }
    if (runCount(pipeline) >= MAX_RUNS_PER_PIPELINE) {
      announce(limitMessage(t("agentGraph.run"), MAX_RUNS_PER_PIPELINE), "assertive")
      return
    }
    const config = clone(current.config)
    const runId = allocateId(config)
    const stageId = allocateId(config, [runId])
    const existingStageNames = new Set(pipeline.stages.map((stage) => stage.name))
    let defaultStageIndex = pipeline.stages.length + 1
    let defaultStageName = t("graph.defaultStageName", { index: defaultStageIndex })
    for (let attempts = 0; existingStageNames.has(defaultStageName) && attempts <= pipeline.stages.length; attempts += 1) {
      defaultStageIndex += 1
      defaultStageName = t("graph.defaultStageName", { index: defaultStageIndex })
    }
    const runsById = new Map(pipeline.stages.flatMap((stage) => stage.runs).map((run) => [run.id, run]))
    const priorFinalRunIds = pipeline.finalResponse.source === "thread"
      ? [pipeline.finalResponse.runId]
      : pipeline.finalResponse.inputs.map((input) => input.runId)
    const inputs: ApcInputBindingV1[] = priorFinalRunIds.map((sourceRunId) => ({
      source: "output",
      runId: sourceRunId,
      role: "user",
      onMissing: runsById.get(sourceRunId)?.required === true ? "fail-graph" : "omit-binding",
    }))
    const stage: ApcStageV1 = {
      id: stageId,
      name: defaultStageName,
      runs: [{ ...defaultRun(thread.id, runId), inputs }],
    }
    const finalResponse: ApcFinalResponseV1 = pipeline.finalResponse.source === "thread"
      ? { source: "thread", runId }
      : { source: "main", inputs: [{ source: "output", runId, onMissing: "fail-graph" }] }
    const next = updatePipeline(config, mode, (value) => ({
      ...value,
      stages: [...value.stages, stage],
      finalResponse,
    }))
    emitMutation(next, { type: "config", config: clone(next), reason: "stage-added" }, "a11y.changeStageAdded", "Stage added.")
  }

  const addRun = (stageId: string): void => {
    if (selectedMode() !== "parallel" || !current.config) return
    const pipeline = current.config.pipelines.parallel
    const stage = pipeline?.stages.find((candidate) => candidate.id === stageId)
    if (!pipeline || !stage || stage.runs.length >= MAX_PARALLEL_WIDTH) return
    if (runCount(pipeline) >= MAX_RUNS_PER_PIPELINE) {
      announce(limitMessage(t("agentGraph.run"), MAX_RUNS_PER_PIPELINE), "assertive")
      return
    }
    const used = new Set(stage.runs.map((run) => run.threadId))
    const thread = current.config.threads.find((candidate) => !used.has(candidate.id))
    if (!thread) return
    const stageIndex = pipeline.stages.findIndex((candidate) => candidate.id === stageId)
    const reachableRunIds = validateConfigForMode(current.config, "parallel").reachableRunIds
    const attachment = parallelRunAttachment(pipeline, stageIndex, reachableRunIds)
    if (attachment === null) {
      announce(limitMessage(t("graph.finalResponse"), MAX_FINAL_INPUTS), "assertive")
      return
    }
    const config = clone(current.config)
    const runId = allocateId(config)
    const priorFinalResponse = pipeline.finalResponse
    const priorFinalRun = priorFinalResponse.source === "thread"
      ? pipeline.stages.flatMap((candidate) => candidate.runs)
        .find((candidate) => candidate.id === priorFinalResponse.runId)
      : undefined
    const finalResponse: ApcFinalResponseV1 = attachment.kind === "downstream"
      ? priorFinalResponse
      : priorFinalResponse.source === "main"
        ? {
            source: "main",
            inputs: [
              ...priorFinalResponse.inputs,
              { source: "output", runId, onMissing: "fail-graph" },
            ],
          }
        : {
            source: "main",
            inputs: [
              {
                source: "output",
                runId: priorFinalResponse.runId,
                onMissing: priorFinalRun?.required === true ? "fail-graph" : "omit-binding",
              },
              { source: "output", runId, onMissing: "fail-graph" },
            ],
          }
    const next = updatePipeline(config, "parallel", (value) => ({
      ...value,
      stages: value.stages.map((candidate) => ({
        ...candidate,
        runs: [
          ...candidate.runs.map((run) => attachment.kind === "downstream" && run.id === attachment.runId
            ? {
                ...run,
                inputs: [
                  ...run.inputs,
                  { source: "output" as const, runId, role: "user" as const, onMissing: "fail-graph" as const },
                ],
              }
            : run),
          ...(candidate.id === stageId ? [defaultRun(thread.id, runId)] : []),
        ],
      })),
      finalResponse,
    }))
    emitMutation(next, { type: "config", config: clone(next), reason: "run-added" }, "a11y.changeRunAdded", "Run added.")
  }

  const reorderStage = (stageId: string, direction: "up" | "down"): void => {
    const mode = selectedMode()
    if (mode === "single" || !current.config) return
    const pipeline = pipelineFor(current.config, mode)
    if (!pipeline) return
    const index = pipeline.stages.findIndex((stage) => stage.id === stageId)
    const target = direction === "up" ? index - 1 : index + 1
    if (index < 0 || target < 0 || target >= pipeline.stages.length) return
    const stages = pipeline.stages.map((stage) => clone(stage))
    const [moved] = stages.splice(index, 1)
    stages.splice(target, 0, moved)
    if (!outputReferencesAreEarlier(stages)) {
      announce(copy(t, "a11y.graphReorderBlocked", "Reorder blocked because output bindings must reference an earlier-stage run."), "assertive")
      return
    }
    const next = updatePipeline(clone(current.config), mode, (value) => ({ ...value, stages }))
    focusAfterRender = moved.runs[0] ? focusEntity("select-run", "run", moved.runs[0].id) : { action: "add-stage" }
    emitMutation(
      next,
      { type: "config", config: clone(next), reason: `stage-moved-${direction}` },
      "a11y.changeStageMoved",
      "Stage moved {{direction}}.",
      { direction: t(direction === "up" ? "a11y.directionUp" : "a11y.directionDown") },
    )
  }

  const reorderRun = (runId: string, direction: "up" | "down"): void => {
    if (selectedMode() !== "parallel" || !current.config) return
    const pipeline = current.config.pipelines.parallel
    const stage = pipeline?.stages.find((candidate) => candidate.runs.some((run) => run.id === runId))
    if (!pipeline || !stage) return
    const index = stage.runs.findIndex((run) => run.id === runId)
    const target = direction === "up" ? index - 1 : index + 1
    if (index < 0 || target < 0 || target >= stage.runs.length) return
    const runs = stage.runs.map((run) => clone(run))
    const [moved] = runs.splice(index, 1)
    runs.splice(target, 0, moved)
    const next = updatePipeline(clone(current.config), "parallel", (value) => ({
      ...value,
      stages: value.stages.map((candidate) => candidate.id === stage.id ? { ...candidate, runs } : candidate),
    }))
    focusAfterRender = focusEntity("select-run", "run", moved.id)
    emitMutation(
      next,
      { type: "config", config: clone(next), reason: `run-moved-${direction}` },
      "a11y.changeRunMoved",
      "Run moved {{direction}}.",
      { direction: t(direction === "up" ? "a11y.directionUp" : "a11y.directionDown") },
    )
  }

  const reorderThread = (threadId: string, direction: "up" | "down"): void => {
    if (!current.config) return
    const config = clone(current.config)
    const index = config.threads.findIndex((thread) => thread.id === threadId)
    const target = direction === "up" ? index - 1 : index + 1
    if (index < 0 || target < 0 || target >= config.threads.length) return
    const threads = config.threads.slice()
    const [moved] = threads.splice(index, 1)
    threads.splice(target, 0, moved)
    const next = { ...config, threads }
    focusAfterRender = focusEntity("select-thread", "thread", moved.id)
    emitMutation(
      next,
      { type: "config", config: clone(next), reason: `thread-moved-${direction}` },
      "a11y.changeThreadMoved",
      "Thread moved {{direction}}.",
      { direction: t(direction === "up" ? "a11y.directionUp" : "a11y.directionDown") },
    )
  }

  const removeThread = (threadId: string): void => {
    if (!current.config || current.config.threads.length <= 1) return
    if (threadOwnsFinalRoute(current.config, threadId)) {
      announce(copy(t, "graph.finalRouteRemovalBlocked", "Choose a different final route before removing this item."), "assertive")
      return
    }
    if (threadOwnsEveryRunInPipeline(current.config, threadId)) {
      announce(copy(t, "graph.pipelineRemovalBlocked", "Add another run to this graph before removing its only thread."), "assertive")
      return
    }
    const config = clone(current.config)
    const runIds = new Set<string>()
    for (const pipeline of [config.pipelines.sequential, config.pipelines.parallel]) {
      for (const stage of pipeline?.stages ?? []) {
        for (const run of stage.runs) if (run.threadId === threadId) runIds.add(run.id)
      }
    }
    const pipelines = { ...config.pipelines }
    for (const mode of ["sequential", "parallel"] as const) {
      const pipeline = pipelines[mode]
      if (!pipeline) continue
      pipelines[mode] = {
        ...pipeline,
        stages: pipeline.stages.map((stage) => ({
          ...stage,
          runs: stage.runs.filter((run) => run.threadId !== threadId),
        })),
      }
    }
    const next = removeReferences({ ...config, threads: config.threads.filter((thread) => thread.id !== threadId), pipelines }, runIds)
    emitMutation(next, { type: "config", config: clone(next), reason: "thread-removed" }, "a11y.changeThreadRemoved", "Thread removed.")
  }

  const removeStage = (stageId: string): void => {
    const mode = selectedMode()
    if (mode === "single" || !current.config) return
    const pipeline = pipelineFor(current.config, mode)
    if (!pipeline || pipeline.stages.length <= 1) return
    const stage = pipeline.stages.find((candidate) => candidate.id === stageId)
    if (!stage) return
    if (stage.runs.some((run) => finalRouteUsesRun(pipeline, run.id))) {
      announce(copy(t, "graph.finalRouteRemovalBlocked", "Choose a different final route before removing this item."), "assertive")
      return
    }
    const runIds = new Set(stage.runs.map((run) => run.id))
    const config = updatePipeline(clone(current.config), mode, (value) => ({
      ...value,
      stages: value.stages.filter((candidate) => candidate.id !== stageId),
    }))
    const next = removeReferences(config, runIds)
    emitMutation(next, { type: "config", config: clone(next), reason: "stage-removed" }, "a11y.changeStageRemoved", "Stage removed.")
  }

  const removeRun = (runId: string): void => {
    const mode = selectedMode()
    if (mode === "single" || !current.config) return
    const pipeline = pipelineFor(current.config, mode)
    const stage = pipeline?.stages.find((candidate) => candidate.runs.some((run) => run.id === runId))
    if (!pipeline || !stage) return
    if (finalRouteUsesRun(pipeline, runId)) {
      announce(copy(t, "graph.finalRouteRemovalBlocked", "Choose a different final route before removing this item."), "assertive")
      return
    }
    if (mode === "sequential") {
      if (pipeline.stages.length > 1) removeStage(stage.id)
      return
    }
    if (stage.runs.length <= 1) return
    const config = updatePipeline(clone(current.config), mode, (value) => ({
      ...value,
      stages: value.stages.map((candidate) => candidate.id === stage.id
        ? { ...candidate, runs: candidate.runs.filter((run) => run.id !== runId) }
        : candidate),
    }))
    const next = removeReferences(config, new Set([runId]))
    emitMutation(next, { type: "config", config: clone(next), reason: "run-removed" }, "a11y.changeRunRemoved", "Run removed.")
  }

  const setFinalRoute = (route: ApcFinalResponseV1): void => {
    const mode = selectedMode()
    if (mode === "single" || !current.config) return
    const pipeline = pipelineFor(current.config, mode)
    if (!pipeline) return
    const runs = pipeline.stages.flatMap((stage) => stage.runs)
    const routeRunIds = route.source === "thread" ? [route.runId] : route.inputs.map((input) => input.runId)
    if (routeRunIds.some((runId) => runs.find((run) => run.id === runId)?.required !== true)) {
      announce(t("validation.required"), "assertive")
      return
    }
    if (route.source === "thread" && (options.canFinalizeThread === false || current.finalResponseAvailable === false)) {
      announce(current.finalResponseBlockedReason ? localizeMessage(current.finalResponseBlockedReason, t) : options.threadFinalBlockedReason ? localizeMessage(options.threadFinalBlockedReason, t) : t("mode.threadFinalUnavailable"), "assertive")
      return
    }
    const next = updatePipeline(clone(current.config), mode, (value) => retainFinalRouteAncestors(value, route))
    emitMutation(next, { type: "config", config: clone(next), reason: "final-route-updated" }, "a11y.changeFinalRouteUpdated", "Final route updated.")
  }

  const removalImpact = (kind: RemovalKind, id: string): Pick<PendingConfirmation, "affectedRuns" | "affectedBindings" | "affectsFinalRoute"> => {
    const config = current.config
    if (!config) return { affectedRuns: 0, affectedBindings: 0, affectsFinalRoute: false }
    const removedRunIds = new Set<string>()
    const activePipeline = pipelineFor(config, selectedMode())
    if (kind === "run") {
      removedRunIds.add(id)
    } else if (kind === "stage") {
      for (const run of activePipeline?.stages.find((stage) => stage.id === id)?.runs ?? []) removedRunIds.add(run.id)
    } else {
      for (const pipeline of [config.pipelines.sequential, config.pipelines.parallel]) {
        for (const stage of pipeline?.stages ?? []) {
          for (const run of stage.runs) if (run.threadId === id) removedRunIds.add(run.id)
        }
      }
    }
    let affectedBindings = 0
    let affectsFinalRoute = false
    for (const pipeline of [config.pipelines.sequential, config.pipelines.parallel]) {
      if (!pipeline) continue
      for (const run of pipeline.stages.flatMap((stage) => stage.runs)) {
        affectedBindings += run.inputs.filter((input) => input.source === "output" && removedRunIds.has(input.runId)).length
      }
      if (pipeline.finalResponse.source === "main") {
        affectedBindings += pipeline.finalResponse.inputs.filter((input) => removedRunIds.has(input.runId)).length
      } else if (removedRunIds.has(pipeline.finalResponse.runId)) {
        affectsFinalRoute = true
      }
    }
    return { affectedRuns: removedRunIds.size, affectedBindings, affectsFinalRoute }
  }

  const requestRemoval = (kind: RemovalKind, id: string, label: string): void => {
    if (locked()) return
    pendingConfirmation = { kind, id, label, ...removalImpact(kind, id) }
    focusAfterRender = { action: "cancel-confirmation" }
    announce(copy(t, "a11y.graphRemovalConfirmation", "Confirm removal of {{label}}.", { label }), "assertive")
    renderCurrent()
  }

  const cancelRemoval = (): void => {
    if (!pendingConfirmation) return
    const restore = pendingConfirmation
    pendingConfirmation = null
    focusAfterRender = focusEntity(
      restore.kind === "slot" ? "remove-connection-slot" : `remove-${restore.kind}`,
      restore.kind,
      restore.id,
    )
    announce(copy(t, "a11y.graphRemovalCancelled", "Removal cancelled."))
    renderCurrent()
  }

  const setFocusAfterRemoval = (confirmation: PendingConfirmation): void => {
    const config = current.config
    if (!config) return
    if (confirmation.kind === "thread") {
      const index = config.threads.findIndex((thread) => thread.id === confirmation.id)
      const target = config.threads[index + 1] ?? config.threads[index - 1]
      focusAfterRender = target ? focusEntity("select-thread", "thread", target.id) : { action: "add-thread" }
      return
    }
    if (confirmation.kind === "slot") {
      const index = config.connectionSlots.findIndex((slot) => slot.id === confirmation.id)
      const target = config.connectionSlots[index + 1] ?? config.connectionSlots[index - 1]
      focusAfterRender = target
        ? { apcConnectionSlotLabel: "true", apcSlotKey: uiKeyFor("slot", target.id) }
        : { action: "add-connection-slot" }
      return
    }
    const mode = selectedMode()
    const pipeline = pipelineFor(config, mode)
    if (!pipeline) return
    if (confirmation.kind === "stage") {
      const index = pipeline.stages.findIndex((stage) => stage.id === confirmation.id)
      const target = pipeline.stages[index + 1] ?? pipeline.stages[index - 1]
      const run = target?.runs[0]
      focusAfterRender = run ? focusEntity("select-run", "run", run.id) : { action: "add-stage" }
      return
    }
    const stageIndex = pipeline.stages.findIndex((stage) => stage.runs.some((run) => run.id === confirmation.id))
    const stage = pipeline.stages[stageIndex]
    const runIndex = stage?.runs.findIndex((run) => run.id === confirmation.id) ?? -1
    const target = stage?.runs[runIndex + 1] ?? stage?.runs[runIndex - 1]
      ?? pipeline.stages[stageIndex + 1]?.runs[0] ?? pipeline.stages[stageIndex - 1]?.runs[0]
    focusAfterRender = target ? focusEntity("select-run", "run", target.id) : { action: "add-stage" }
  }

  const confirmRemoval = (): void => {
    const confirmation = pendingConfirmation
    if (!confirmation || locked()) return
    setFocusAfterRemoval(confirmation)
    pendingConfirmation = null
    if (confirmation.kind === "thread") removeThread(confirmation.id)
    else if (confirmation.kind === "stage") removeStage(confirmation.id)
    else if (confirmation.kind === "run") removeRun(confirmation.id)
    else removeConnectionSlot(confirmation.id)
  }

  const threadForRun = (config: ApcPresetConfigV1, run: ApcRunV1): ApcThreadV1 | undefined =>
    config.threads.find((thread) => thread.id === run.threadId)

  const runLabel = (config: ApcPresetConfigV1, run: ApcRunV1): string =>
    threadForRun(config, run)?.name || t("graph.missingThread")
  type ProjectedStatus = ApcRunActivityStatus
  let projectedRunStatuses = new Map<string, ProjectedStatus>()
  const statusLabel = (status: ProjectedStatus): string => {
    if (status === "running") return t("inspector.statusRunning")
    if (status === "completed") return t("inspector.statusCompleted")
    if (status === "failed") return t("inspector.statusFailed")
    if (status === "cancelled") return t("inspector.statusCancelled")
    if (status === "timed-out") return t("inspector.statusTimedOut")
    if (status === "skipped") return t("inspector.statusSkipped")
    return t("inspector.statusPending")
  }
  const projectExecutionStatuses = (pipeline: ApcPipelineV1 | undefined): void => {
    const projected = new Map<string, ProjectedStatus>()
    const execution = current.execution
    if (!pipeline || !execution) {
      projectedRunStatuses = projected
      return
    }
    for (const stage of pipeline.stages) {
      for (const run of stage.runs) projected.set(run.id, "pending")
    }
    for (const activity of execution.activity) {
      const stageIndex = activity.stageIndex
      const runIndex = activity.runIndex
      if (
        stageIndex === undefined ||
        runIndex === undefined ||
        !Number.isSafeInteger(stageIndex) ||
        !Number.isSafeInteger(runIndex) ||
        stageIndex < 0 ||
        runIndex < 0
      ) continue
      if (!RUN_STATUSES.includes(activity.status)) continue
      const run = pipeline.stages[stageIndex]?.runs[runIndex]
      if (run) projected.set(run.id, activity.status)
    }
    projectedRunStatuses = projected
  }
  const stageStatus = (stage: ApcStageV1): ProjectedStatus | undefined => {
    const statuses = stage.runs
      .map((run) => projectedRunStatuses.get(run.id))
      .filter((status): status is ProjectedStatus => status !== undefined)
    if (!statuses.length) return undefined
    if (statuses.includes("running")) return "running"
    if (statuses.includes("failed")) return "failed"
    if (statuses.includes("timed-out")) return "timed-out"
    if (statuses.includes("cancelled")) return "cancelled"
    if (statuses.every((status) => status === "completed" || status === "skipped")) {
      return statuses.every((status) => status === "skipped") ? "skipped" : "completed"
    }
    return "pending"
  }

  const bindingLabel = (config: ApcPresetConfigV1, pipeline: ApcPipelineV1, input: ApcInputBindingV1): string => {
    if (input.source === "literal") return t("binding.literal")
    const sourceRun = pipeline.stages.flatMap((stage) => stage.runs).find((run) => run.id === input.runId)
    const source = sourceRun ? runLabel(config, sourceRun) : t("graph.missingThread")
    return copy(t, "graph.outputLabel", "{{thread}} · {{output}}", {
      thread: source,
      output: t("graph.defaultFinalResponseName"),
    })
  }

  const renderConfirmation = (parent: HTMLElement, kind: RemovalKind, id: string, label: string): void => {
    if (!pendingConfirmation || pendingConfirmation.kind !== kind || pendingConfirmation.id !== id) return
    const region = htmlElement(document, "div", "apc-inline-confirmation")
    region.dataset.apcConfirmation = "true"
    region.dataset.confirmationKind = kind
    region.setAttribute("role", "group")
    region.setAttribute("aria-label", copy(t, "graph.confirmRemovalTitle", "Confirm removal"))
    const message = htmlElement(document, "p")
    message.textContent = copy(t, "graph.confirmRemovalMessage", "Remove {{label}}? Affected runs: {{runs}}. Affected bindings: {{bindings}}. Final-route dependency: {{route}}.", {
      label,
      runs: pendingConfirmation.affectedRuns,
      bindings: pendingConfirmation.affectedBindings,
      route: pendingConfirmation.affectsFinalRoute ? t("common.yes") : t("common.no"),
    })
    const actions = htmlElement(document, "div", "apc-card-actions")
    actions.append(
      actionButton(document, copy(t, "action.confirmRemove", "Remove"), "confirm-removal", {}, true),
      actionButton(document, copy(t, "action.cancelConfirmation", "Cancel"), "cancel-confirmation"),
    )
    region.append(message, actions)
    parent.append(region)
  }

  const renderToolbar = (parent: HTMLElement): void => {
    const wrapper = htmlElement(document, "div", "apc-mode-toolbar-shell")
    wrapper.dataset.apcModeToolbar = "true"
    const heading = htmlElement(document, "h2", "apc-module-heading")
    heading.textContent = t("agentGraph.title")
    const toolbar = htmlElement(document, "div", "apc-mode-toolbar")
    toolbar.setAttribute("role", "radiogroup")
    toolbar.setAttribute("aria-label", t("mode.execution"))
    const active = effectiveMode(current)
    const tabStop = active !== null && modeIsBlocked(current, active, t) === null
      ? active
      : APC_MODES.find((mode) => modeIsBlocked(current, mode, t) === null)
    for (const mode of APC_MODES) {
      const label = modeLabel(mode, t)
      const control = actionButton(document, label, "select-mode", { mode }, true)
      control.dataset.mode = mode
      control.setAttribute("role", "radio")
      control.setAttribute("aria-checked", String(active === mode))
      control.tabIndex = tabStop === mode ? 0 : -1
      const reason = modeIsBlocked(current, mode, t)
      if (reason) {
        const reasonId = `${GRAPH_EDITOR_TOOLBAR_ITEM_ID}-${mode}-reason`
        control.disabled = true
        control.setAttribute("aria-describedby", reasonId)
        const note = htmlElement(document, "span", "apc-disabled-reason")
        note.id = reasonId
        note.dataset.modeReason = mode
        note.setAttribute("role", "note")
        note.textContent = reason
        toolbar.append(control, note)
      } else {
        toolbar.append(control)
      }
    }
    wrapper.append(heading, toolbar)
    parent.append(wrapper)
  }

  const renderStatus = (parent: HTMLElement): void => {
    editorStatus.dataset.busy = String(current.busy === true)
    editorStatus.dataset.dirty = String(current.dirty === true)
    editorStatus.dataset.stale = String(current.stale === true)
    const blockedReasons = current.blockedReasons ?? []
    const executionLocked =
      (current.execution !== undefined && !current.execution.terminal) ||
      blockedReasons.some((reason) => reason.key === "execution.running" || reason.key === "execution.starting")
    editorStatus.dataset.lockState = current.stale
      ? "stale"
      : current.busy
        ? "saving"
        : executionLocked
          ? "execution"
          : current.mutationLocked || blockedReasons.length
            ? "blocked"
            : "none"
    editorStatus.setAttribute("role", current.saveError || current.stale ? "alert" : "status")
    const nextText = current.busy
      ? t("status.busy")
      : current.saveError
        ? localizeMessage(current.saveError.message, t)
        : current.stale
          ? t("error.staleConfigReload")
          : executionLocked
            ? t("execution.running")
            : current.mutationLocked
              ? t("status.editorBusyOrBlocked")
              : current.dirty
                ? t("status.unsavedChanges")
                : t("status.saved")
    if (nextText !== lastEditorStatusText) {
      editorStatus.textContent = nextText
      lastEditorStatusText = nextText
    }
    parent.append(editorStatus)
    if (blockedReasons.length) {
      const blocked = htmlElement(document, "p", "apc-blocked-status")
      blocked.setAttribute("role", "alert")
      blocked.textContent = t("status.blockedReason", { reason: blockedReasons.map((reason) => localizeMessage(reason, t)).join(" ") })
      parent.append(blocked)
    }
  }

  const renderEmpty = (parent: HTMLElement): void => {
    const empty = htmlElement(document, "section", "apc-graph-empty")
    empty.dataset.apcGraphEmpty = "true"
    const heading = htmlElement(document, "h2")
    heading.textContent = copy(t, "graph.emptyTitle", "Give this preset a team")
    const description = htmlElement(document, "p")
    description.textContent = copy(t, "graph.emptyDescription", "Create a thread, arrange execution, then choose the final route. Native Single behavior remains available until the graph is ready.")
    const steps = document.createElement("ol")
    for (const [key, fallback] of [
      ["graph.emptyStepThread", "Create a reusable thread workspace"],
      ["graph.emptyStepExecution", "Arrange its ordered execution"],
      ["graph.emptyStepRoute", "Choose the final response route"],
    ] as const) {
      const item = document.createElement("li")
      item.textContent = copy(t, key, fallback)
      steps.append(item)
    }
    const consent = htmlElement(document, "p", "apc-consent-note")
    consent.textContent = copy(t, "graph.emptyConsent", "Connections require review and approval before anything is dispatched.")
    const actions = htmlElement(document, "div", "apc-card-actions")
    actions.append(
      actionButton(document, copy(t, "action.createParallelGraph", "Create Parallel graph"), "create-graph", { mode: "parallel" }, true),
      actionButton(document, copy(t, "action.createSequentialGraph", "Create Sequential graph"), "create-graph", { mode: "sequential" }, true),
    )
    const unavailableActions = htmlElement(document, "div", "apc-card-actions")
    unavailableActions.dataset.apcUnavailableGraphActions = "true"
    const unavailableStage = actionButton(document, t("action.addStage"), "add-stage", {}, true)
    unavailableStage.disabled = true
    unavailableStage.setAttribute("aria-disabled", "true")
    unavailableStage.dataset.apcUnavailableGraphAction = "true"
    const unavailableRun = actionButton(document, t("action.addRun"), "add-run", {}, true)
    unavailableRun.disabled = true
    unavailableRun.setAttribute("aria-disabled", "true")
    unavailableRun.dataset.apcUnavailableGraphAction = "true"
    const unavailableReason = htmlElement(document, "p", "apc-disabled-reason")
    unavailableReason.setAttribute("role", "note")
    unavailableReason.textContent = t("status.blockedReason", { reason: t("graph.emptyStepThread") })
    unavailableActions.append(unavailableStage, unavailableRun)
    empty.append(heading, description, steps, consent, actions, unavailableActions, unavailableReason)
    parent.append(empty)
  }

  const renderConnectionSlots = (parent: HTMLElement, config: ApcPresetConfigV1): void => {
    const section = htmlElement(document, "section", "apc-connection-slots")
    section.dataset.apcConnectionSlots = "true"
    section.setAttribute("aria-label", t("graph.connectionSlots"))
    const heading = htmlElement(document, "h3")
    heading.textContent = t("graph.connectionSlots")
    const description = htmlElement(document, "p")
    description.textContent = t("graph.connectionSlotDescription")
    const list = document.createElement("ul")
    list.dataset.apcConnectionSlotList = "true"
    if (config.connectionSlots.length === 0) {
      const empty = htmlElement(document, "li", "apc-disabled-reason")
      empty.textContent = t("graph.connectionSlotEmpty")
      list.append(empty)
    }
    config.connectionSlots.forEach((slot, index) => {
      const item = document.createElement("li")
      const slotKey = uiKeyFor("slot", slot.id)
      const slotContext = `${t("graph.connectionSlotLabel")} ${index + 1}: ${slot.label}`
      item.dataset.apcConnectionSlot = "true"
      item.dataset.apcSlotKey = slotKey
      const field = document.createElement("label")
      const fieldLabel = document.createElement("span")
      fieldLabel.textContent = t("graph.connectionSlotLabel")
      const input = document.createElement("input")
      input.type = "text"
      input.value = slot.label
      input.maxLength = MAX_NAME_CHARS * 2
      input.dataset.apcConnectionSlotLabel = "true"
      input.dataset.apcSlotKey = slotKey
      input.disabled = locked()
      input.setAttribute("aria-label", slotContext)
      input.addEventListener("input", () => {
        if (characterCount(input.value) > MAX_NAME_CHARS) {
          input.value = [...input.value].slice(0, MAX_NAME_CHARS).join("")
        }
      })
      input.addEventListener("change", () => {
        if (!input.disabled) renameConnectionSlot(slot.id, input.value)
      })
      input.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" || input.disabled) return
        event.preventDefault()
        renameConnectionSlot(slot.id, input.value)
      })
      field.append(fieldLabel, input)
      const actions = htmlElement(document, "div", "apc-card-actions")
      const referenced = config.threads.some((thread) => thread.connectionSlotId === slot.id)
      const remove = actionButton(document, t("action.removeConnectionSlot"), "remove-connection-slot", { apcSlotKey: slotKey }, true)
      remove.setAttribute("aria-label", `${t("action.removeConnectionSlot")} · ${slotContext}`)
      remove.disabled = locked() || referenced
      actions.append(remove)
      item.append(field, actions)
      if (referenced) {
        const note = htmlElement(document, "span", "apc-disabled-reason")
        note.setAttribute("role", "note")
        note.textContent = t("graph.connectionSlotReferenced")
        item.append(note)
      }
      renderConfirmation(item, "slot", slot.id, slot.label)
      list.append(item)
    })
    const actions = htmlElement(document, "div", "apc-card-actions")
    const add = actionButton(document, t("action.addConnectionSlot"), "add-connection-slot", {}, true)
    add.disabled = locked() || config.connectionSlots.length >= MAX_CONNECTION_SLOTS
    actions.append(add)
    if (config.connectionSlots.length >= MAX_CONNECTION_SLOTS) {
      const note = htmlElement(document, "span", "apc-disabled-reason")
      note.setAttribute("role", "note")
      note.textContent = limitMessage(t("agentGraph.slot"), MAX_CONNECTION_SLOTS)
      actions.append(note)
    }
    section.append(heading, description, list, actions)
    parent.append(section)
  }

  const renderThreadNavigation = (
    parent: HTMLElement,
    config: ApcPresetConfigV1,
    pipeline?: ApcPipelineV1,
  ): void => {
    const nav = htmlElement(document, "nav", "apc-thread-list")
    nav.dataset.apcThreadNavigation = "true"
    nav.setAttribute("aria-label", copy(t, "graph.threadNavigation", "Threads"))
    const heading = htmlElement(document, "h2")
    heading.textContent = t("graph.threads")
    const list = document.createElement("ul")
    config.threads.forEach((thread, index) => {
      const item = document.createElement("li")
      const threadKey = uiKeyFor("thread", thread.id)
      const selected = current.selection?.kind === "thread" && current.selection.threadId === thread.id
      const label = thread.name || t("graph.defaultThreadName", { index: index + 1 })
      const threadContext = copy(t, "graph.selectThread", "Select thread {{thread}}", { thread: `${index + 1}: ${label}` })
      const control = actionButton(document, label, "select-thread", { apcThreadKey: threadKey })
      control.dataset.apcThreadSelect = "true"
      control.dataset.selected = String(selected)
      control.setAttribute("aria-pressed", String(selected))
      control.setAttribute("aria-label", threadContext)
      const source = htmlElement(document, "span", "apc-thread-source")
      source.textContent = thread.workspaceSource === "native-blocks" ? t("workspace.nativeBlocks") : t("workspace.mainContext")
      const actions = htmlElement(document, "div", "apc-card-actions")
      item.append(control, source, actions)
      const up = actionButton(document, t("action.moveUp"), "move-thread", { apcThreadKey: threadKey, direction: "up" }, true)
      up.setAttribute("aria-label", `${t("action.moveUp")} · ${threadContext}`)
      const down = actionButton(document, t("action.moveDown"), "move-thread", { apcThreadKey: threadKey, direction: "down" }, true)
      down.setAttribute("aria-label", `${t("action.moveDown")} · ${threadContext}`)
      up.disabled = index === 0
      down.disabled = index === config.threads.length - 1
      const finalBlocked = threadOwnsFinalRoute(config, thread.id)
      const pipelineBlocked = threadOwnsEveryRunInPipeline(config, thread.id)
      const remove = actionButton(document, t("action.removeThread"), "remove-thread", { apcThreadKey: threadKey }, true)
      remove.setAttribute("aria-label", `${t("action.removeThread")} · ${threadContext}`)
      remove.disabled = config.threads.length <= 1 || finalBlocked || pipelineBlocked
      if (options.onOpenLoom) {
        const openLoomLabel = t("threadEditor.workspaceAria", { name: label })
        const openLoom = actionButton(document, openLoomLabel, "open-loom", { apcThreadKey: threadKey })
        openLoom.setAttribute("aria-label", openLoomLabel)
        actions.append(openLoom)
      }
      actions.append(up, down, remove)
      if (finalBlocked || pipelineBlocked) {
        const note = htmlElement(document, "span", "apc-disabled-reason")
        note.setAttribute("role", "note")
        note.textContent = finalBlocked
          ? copy(t, "graph.finalRouteRemovalBlocked", "Choose a different final route before removing this item.")
          : copy(t, "graph.pipelineRemovalBlocked", "Add another run to this graph before removing its only thread.")
        item.append(note)
      }
      renderConfirmation(item, "thread", thread.id, thread.name)
      list.append(item)
    })
    const add = actionButton(document, t("action.addThread"), "add-thread", {}, true)
    add.disabled = config.threads.length >= MAX_THREADS
    nav.append(heading, list, add)
    if (add.disabled) {
      const note = htmlElement(document, "span", "apc-disabled-reason")
      note.setAttribute("role", "note")
      note.textContent = limitMessage(t("graph.threads"), MAX_THREADS)
      nav.append(note)
    }
    if (pipeline) {
      const runsHeading = htmlElement(document, "h3")
      runsHeading.textContent = t("agentGraph.run")
      const orderedRuns = document.createElement("ol")
      orderedRuns.dataset.apcRunNavigation = "true"
      pipeline.stages.forEach((stage, stageIndex) => {
        stage.runs.forEach((run, runIndex) => {
          const item = document.createElement("li")
          const runKey = uiKeyFor("run", run.id)
          const selected = current.selection?.kind === "run" && current.selection.runId === run.id
          const label = runLabel(config, run)
          const runContext = copy(t, "graph.selectRun", "Select run {{run}}, stage {{stage}}", {
            run: `${runIndex + 1}: ${label}`,
            stage: stageIndex + 1,
          })
          const control = actionButton(document, label, "select-run", { apcRunKey: runKey })
          control.dataset.apcRunSelect = "true"
          control.dataset.selected = String(selected)
          control.setAttribute("aria-pressed", String(selected))
          control.setAttribute("aria-label", runContext)
          const position = htmlElement(document, "span", "apc-run-meta")
          position.textContent = copy(t, "graph.runStagePosition", "Run {{run}} · Stage {{stage}}", {
            run: runIndex + 1,
            stage: stageIndex + 1,
          })
          const status = projectedRunStatuses.get(run.id)
          item.append(control, position)
          if (status) {
            item.dataset.status = status
            item.dataset.activityStatus = status
            const statusText = htmlElement(document, "span", "apc-run-status")
            statusText.textContent = statusLabel(status)
            item.append(statusText)
          }
          orderedRuns.append(item)
        })
      })
      nav.append(runsHeading, orderedRuns)
    }
    parent.append(nav)
  }

  const renderRunCard = (
    parent: HTMLElement,
    config: ApcPresetConfigV1,
    pipeline: ApcPipelineV1,
    mode: "sequential" | "parallel",
    stage: ApcStageV1,
    stageIndex: number,
    run: ApcRunV1,
    runIndex: number,
  ): void => {
    const label = runLabel(config, run)
    const selected = current.selection?.kind === "run" && current.selection.runId === run.id
    const runKey = uiKeyFor("run", run.id)
    const runContext = copy(t, "graph.selectRun", "Select run {{run}}, stage {{stage}}", {
      run: `${runIndex + 1}: ${label}`,
      stage: stageIndex + 1,
    })
    const card = htmlElement(document, "article", "apc-run-card")
    card.dataset.apcRunKey = runKey
    card.dataset.selected = String(selected)
    card.dataset.apcRunCard = "true"
    if (mode === "sequential") {
      card.dataset.apcMainDispatch = "true"
      card.dataset.connectionSource = "main"
    }
    const selectRun = actionButton(document, label, "select-run", { apcRunKey: runKey })
    selectRun.dataset.apcRunSelect = "true"
    selectRun.dataset.selected = String(selected)
    selectRun.setAttribute("aria-pressed", String(selected))
    selectRun.setAttribute("aria-label", runContext)
    const runHeading = htmlElement(document, "h4")
    runHeading.append(selectRun)
    const meta = htmlElement(document, "p", "apc-run-meta")
    meta.textContent = mode === "sequential"
      ? `${stageIndex === 0
        ? copy(t, "graph.startsWithPreset", "Starts with preset context")
        : copy(t, "graph.startsAfter", "Starts after {{thread}}", {
            thread: runLabel(config, pipeline.stages[stageIndex - 1].runs[0]),
          })} · ${t("privacy.mainSource")}`
      : copy(t, "graph.parallelPosition", "Run {{run}} of stage {{stage}}", { run: runIndex + 1, stage: stageIndex + 1 })
    const flags = htmlElement(document, "p", "apc-run-flags")
    flags.textContent = `${run.required ? t("binding.required") : t("binding.optional")} · ${t("validation.timeoutValue", { seconds: run.timeoutMs / 1_000 })}`
    card.append(runHeading, meta, flags)
    const projectedStatus = projectedRunStatuses.get(run.id)
    if (projectedStatus) {
      card.dataset.status = projectedStatus
      card.dataset.activityStatus = projectedStatus
      const status = htmlElement(document, "p", "apc-run-status")
      status.textContent = statusLabel(projectedStatus)
      card.append(status)
    }
    if (run.inputs.length) {
      const inputs = document.createElement("ul")
      inputs.className = "apc-run-inputs"
      inputs.setAttribute("aria-label", t("graph.inputs"))
      for (const input of run.inputs) {
        const item = document.createElement("li")
        item.textContent = bindingLabel(config, pipeline, input)
        inputs.append(item)
      }
      card.append(inputs)
    }
    const actions = htmlElement(document, "div", "apc-card-actions")
    if (mode === "parallel") {
      const up = actionButton(document, t("action.moveUp"), "move-run", { apcRunKey: runKey, direction: "up" }, true)
      up.setAttribute("aria-label", `${t("action.moveUp")} · ${runContext}`)
      const down = actionButton(document, t("action.moveDown"), "move-run", { apcRunKey: runKey, direction: "down" }, true)
      down.setAttribute("aria-label", `${t("action.moveDown")} · ${runContext}`)
      up.disabled = runIndex === 0
      down.disabled = runIndex === stage.runs.length - 1
      actions.append(up, down)
    }
    const finalBlocked = finalRouteUsesRun(pipeline, run.id)
    const remove = actionButton(document, t("action.removeRun"), "remove-run", { apcRunKey: runKey }, true)
    remove.disabled = finalBlocked || (mode === "parallel" ? stage.runs.length <= 1 : pipeline.stages.length <= 1)
    remove.setAttribute("aria-label", `${t("action.removeRun")} · ${runContext}`)
    actions.append(remove)
    card.append(actions)
    if (finalBlocked) {
      const note = htmlElement(document, "span", "apc-disabled-reason")
      note.setAttribute("role", "note")
      note.textContent = copy(t, "graph.finalRouteRemovalBlocked", "Choose a different final route before removing this item.")
      card.append(note)
    }
    renderConfirmation(card, "run", run.id, label)
    parent.append(card)
  }

  const renderStage = (
    parent: HTMLElement,
    config: ApcPresetConfigV1,
    pipeline: ApcPipelineV1,
    mode: "sequential" | "parallel",
    stage: ApcStageV1,
    stageIndex: number,
    reachableRunIds: ReadonlySet<string>,
  ): void => {
    const stageKey = uiKeyFor("stage", stage.id)
    const card = htmlElement(document, "section", "apc-stage-card")
    card.dataset.apcStageKey = stageKey
    card.dataset.apcStage = "true"
    card.dataset.stagePosition = String(stageIndex + 1)
    card.setAttribute("role", "listitem")
    if (mode === "sequential") {
      card.dataset.apcCausalStage = "true"
    }
    const heading = htmlElement(document, "h3")
    heading.textContent = copy(t, "graph.stageHeading", "Stage {{index}} · {{name}}", {
      index: stageIndex + 1,
      name: stage.name || t("graph.defaultStageName", { index: stageIndex + 1 }),
    })
    const stageContext = copy(t, "graph.stageHeading", "Stage {{index}} · {{name}}", {
      index: stageIndex + 1,
      name: stage.name || t("graph.defaultStageName", { index: stageIndex + 1 }),
    })
    const projectedStageStatus = stageStatus(stage)
    const status = projectedStageStatus ? htmlElement(document, "p", "apc-stage-status") : null
    if (projectedStageStatus && status) {
      card.dataset.status = projectedStageStatus
      card.dataset.activityStatus = projectedStageStatus
      status.textContent = statusLabel(projectedStageStatus)
    }
    const actions = htmlElement(document, "div", "apc-card-actions")
    const up = actionButton(document, t("action.moveUp"), "move-stage", { apcStageKey: stageKey, direction: "up" }, true)
    up.setAttribute("aria-label", `${t("action.moveUp")} · ${stageContext}`)
    const down = actionButton(document, t("action.moveDown"), "move-stage", { apcStageKey: stageKey, direction: "down" }, true)
    down.setAttribute("aria-label", `${t("action.moveDown")} · ${stageContext}`)
    up.disabled = stageIndex === 0
    down.disabled = stageIndex === pipeline.stages.length - 1
    const finalBlocked = stage.runs.some((run) => finalRouteUsesRun(pipeline, run.id))
    const remove = actionButton(document, t("action.removeStage"), "remove-stage", { apcStageKey: stageKey }, true)
    remove.setAttribute("aria-label", `${t("action.removeStage")} · ${stageContext}`)
    remove.disabled = pipeline.stages.length <= 1 || finalBlocked
    actions.append(up, down, remove)
    if (finalBlocked) {
      const note = htmlElement(document, "span", "apc-disabled-reason")
      note.setAttribute("role", "note")
      note.textContent = copy(t, "graph.finalRouteRemovalBlocked", "Choose a different final route before removing this item.")
      card.append(note)
    }
    if (mode === "parallel") {
      const used = new Set(stage.runs.map((run) => run.threadId))
      const attachment = parallelRunAttachment(pipeline, stageIndex, reachableRunIds)
      const canAdd = stage.runs.length < MAX_PARALLEL_WIDTH
        && runCount(pipeline) < MAX_RUNS_PER_PIPELINE
        && config.threads.some((thread) => !used.has(thread.id))
        && attachment !== null
      const add = actionButton(document, t("action.addRun"), "add-run", { apcStageKey: stageKey }, true)
      add.disabled = !canAdd
      actions.append(add)
      if (!canAdd) {
        const note = htmlElement(document, "span", "apc-disabled-reason")
        note.setAttribute("role", "note")
        note.textContent = runCount(pipeline) >= MAX_RUNS_PER_PIPELINE
          ? limitMessage(t("agentGraph.run"), MAX_RUNS_PER_PIPELINE)
          : stage.runs.length >= MAX_PARALLEL_WIDTH
            ? limitMessage(t("graph.parallelRuns"), MAX_PARALLEL_WIDTH)
            : !config.threads.some((thread) => !used.has(thread.id))
              ? copy(t, "graph.noAvailableThreadForRun", "Add another thread before adding a distinct run to this stage.")
              : limitMessage(t("graph.finalResponse"), MAX_FINAL_INPUTS)
        actions.append(note)
      }
    }
    const runs = htmlElement(document, "div", "apc-stage-runs")
    stage.runs.forEach((run, runIndex) => renderRunCard(runs, config, pipeline, mode, stage, stageIndex, run, runIndex))
    card.prepend(heading)
    if (status) heading.after(status)
    card.append(actions, runs)
    renderConfirmation(card, "stage", stage.id, stage.name)
    parent.append(card)
  }

  const renderFinalRoute = (parent: HTMLElement, config: ApcPresetConfigV1, pipeline: ApcPipelineV1): void => {
    const section = htmlElement(document, "section", "apc-final-response")
    section.dataset.apcFinalRoute = "true"
    const heading = htmlElement(document, "h3")
    heading.textContent = t("graph.finalResponse")
    const route = pipeline.finalResponse
    const selectedRunId = current.selection?.kind === "run" ? current.selection.runId : undefined
    const selectedRun = selectedRunId === undefined
      ? undefined
      : pipeline.stages.flatMap((stage) => stage.runs).find((run) => run.id === selectedRunId)
    const currentFinalRunId = route.source === "thread" ? route.runId : canonicalMainFinalRunId(pipeline)
    const currentFinalRun = currentFinalRunId === undefined
      ? undefined
      : pipeline.stages.flatMap((stage) => stage.runs).find((run) => run.id === currentFinalRunId)
    const routeCandidate = selectedRun ?? currentFinalRun
    const main = actionButton(document, t("graph.routeFinalToMain"), "final-main", {}, true)
    main.setAttribute("aria-pressed", String(route.source === "main"))
    main.dataset.selected = String(route.source === "main")
    const thread = actionButton(document, t("graph.routeFinalToThread"), "final-thread", {}, true)
    thread.setAttribute("aria-pressed", String(route.source === "thread"))
    thread.dataset.selected = String(route.source === "thread")
    const permissionBlocked = options.canFinalizeThread === false || current.finalResponseAvailable === false
    const candidateBlocked = routeCandidate !== undefined && routeCandidate.required !== true
    main.disabled = candidateBlocked
    thread.disabled = permissionBlocked || candidateBlocked || routeCandidate === undefined
    const actions = htmlElement(document, "div", "apc-card-actions")
    actions.append(main, thread)
    section.append(heading, actions)
    const fallbackDelivered = current.execution?.terminal === true && current.execution.outcome === "graph-fallback"
    const routeStatus = fallbackDelivered
      ? "completed"
      : currentFinalRun === undefined
        ? undefined
        : projectedRunStatuses.get(currentFinalRun.id)
    if (routeStatus) {
      section.dataset.status = routeStatus
      section.dataset.activityStatus = routeStatus
      const status = htmlElement(document, "p", "apc-final-route-status")
      status.textContent = fallbackDelivered
        ? `${t("fallback.title")} · ${t("fallback.main")}`
        : statusLabel(routeStatus)
      if (fallbackDelivered) {
        section.dataset.outcome = "graph-fallback"
        section.dataset.outcomeClass = "graph-fallback"
      }
      section.append(status)
    }
    if (route.source === "thread") {
      const finalRun = pipeline.stages.flatMap((stage) => stage.runs).find((run) => run.id === route.runId)
      const output = htmlElement(document, "p", "apc-final-output")
      output.textContent = copy(t, "graph.outputLabel", "{{thread}} · {{output}}", {
        thread: finalRun ? runLabel(config, finalRun) : t("graph.missingThread"),
        output: t("graph.defaultFinalResponseName"),
      })
      section.append(output)
    }
    if (permissionBlocked || candidateBlocked || routeCandidate === undefined) {
      const reason = htmlElement(document, "p", "apc-disabled-reason")
      reason.setAttribute("role", "note")
      reason.textContent = permissionBlocked
        ? current.finalResponseBlockedReason
          ? localizeMessage(current.finalResponseBlockedReason, t)
          : options.threadFinalBlockedReason
            ? localizeMessage(options.threadFinalBlockedReason, t)
            : t("mode.threadFinalUnavailable")
        : candidateBlocked
          ? t("validation.required")
          : copy(t, "graph.selectRunForFinalRoute", "Select a run before choosing a thread final route.")
      section.append(reason)
    }
    parent.append(section)
  }

  const renderSelectionDetail = (parent: HTMLElement, config: ApcPresetConfigV1, pipeline: ApcPipelineV1): void => {
    const aside = htmlElement(document, "aside", "apc-selection-detail")
    aside.dataset.apcSelectionDetail = "true"
    const selection = current.selection
    if (selection?.kind === "thread") {
      const thread = config.threads.find((candidate) => candidate.id === selection.threadId)
      if (thread) {
        const heading = htmlElement(document, "h3")
        heading.textContent = thread.name
        const kind = htmlElement(document, "p")
        kind.textContent = thread.workspaceSource === "native-blocks" ? t("workspace.nativeBlocks") : t("workspace.mainContext")
        const hint = htmlElement(document, "p")
        hint.textContent = copy(t, "graph.threadDetailHint", "Thread workspace settings open in the thread pane.")
        aside.append(heading, kind, hint)
      }
    } else if (selection?.kind === "run") {
      const stageIndex = pipeline.stages.findIndex((stage) => stage.runs.some((run) => run.id === selection.runId))
      const stage = pipeline.stages[stageIndex]
      const runIndex = stage?.runs.findIndex((run) => run.id === selection.runId) ?? -1
      const run = runIndex >= 0 ? stage.runs[runIndex] : undefined
      if (run) {
        const heading = htmlElement(document, "h3")
        heading.textContent = copy(t, "graph.selectedRunHeading", "Selected run · {{thread}}", { thread: runLabel(config, run) })
        const position = htmlElement(document, "p")
        position.textContent = copy(t, "graph.runStagePosition", "Run {{run}} · Stage {{stage}}", { run: runIndex + 1, stage: stageIndex + 1 })
        const settings = htmlElement(document, "p")
        settings.textContent = `${run.required ? t("binding.required") : t("binding.optional")} · ${t("validation.timeoutValue", { seconds: run.timeoutMs / 1_000 })}`
        const inputs = htmlElement(document, "p")
        inputs.textContent = copy(t, "graph.inputCount", "Input bindings: {{count}}", { count: run.inputs.length })
        const hint = htmlElement(document, "p")
        hint.textContent = copy(t, "graph.runDetailHint", "Run settings and earlier-stage bindings open in the selected-run pane.")
        aside.append(heading, position, settings, inputs, hint)
      }
    }
    if (!aside.childElementCount) {

      const heading = htmlElement(document, "h3")
      heading.textContent = copy(t, "graph.selectionTitle", "Selection")
      const hint = htmlElement(document, "p")
      hint.textContent = copy(t, "graph.selectionHint", "Select a thread or run to open its details.")
      aside.append(heading, hint)
    }
    parent.append(aside)
  }
  const renderMissingGraphActions = (parent: HTMLElement, config: ApcPresetConfigV1): void => {
    const missing = (["parallel", "sequential"] as const).filter((mode) => config.pipelines[mode] === undefined)
    if (!missing.length) return
    const section = htmlElement(document, "section", "apc-missing-graph-actions")
    section.dataset.apcMissingGraphActions = "true"
    const heading = htmlElement(document, "h3")
    heading.textContent = copy(t, "graph.createAnotherTopology", "Create another graph topology")
    const actions = htmlElement(document, "div", "apc-card-actions")
    for (const mode of missing) {
      actions.append(actionButton(
        document,
        mode === "parallel"
          ? copy(t, "action.createParallelGraph", "Create Parallel graph")
          : copy(t, "action.createSequentialGraph", "Create Sequential graph"),
        "create-graph",
        { mode, preserveMode: "true" },
        true,
      ))
    }
    section.append(heading, actions)
    parent.append(section)
  }


  const renderGraph = (parent: HTMLElement, mode: "sequential" | "parallel", config: ApcPresetConfigV1, pipeline: ApcPipelineV1): void => {
    const workspace = htmlElement(document, "div", "apc-graph-workspace")
    workspace.dataset.apcGraphWorkspace = mode
    if (surface === "navigation") renderThreadNavigation(workspace, config, pipeline)
    else if (surface === "all") renderThreadNavigation(workspace, config)
    if (surface !== "navigation") {
      if (mode === "parallel") renderConnectionSlots(workspace, config)
      const topology = htmlElement(document, "section", "apc-stage-list")
      topology.dataset.apcTopology = mode
      topology.setAttribute("aria-label", mode === "sequential"
        ? copy(t, "graph.sequentialFlow", "Sequential agent flow")
        : copy(t, "graph.parallelTopology", "Parallel agent graph"))
      const heading = htmlElement(document, "h2")
      heading.textContent = mode === "sequential"
        ? copy(t, "graph.sequentialFlow", "Sequential agent flow")
        : copy(t, "graph.parallelTopology", "Parallel agent graph")
      const description = htmlElement(document, "p")
      description.textContent = mode === "sequential"
        ? `${copy(t, "graph.sequentialDescription", "Runs execute one at a time in configured stage order.")} ${t("privacy.mainSource")}.`
        : copy(t, "graph.parallelDescription", "Runs may overlap within a stage; stages remain ordered.")
      const warning = htmlElement(document, "section", "apc-council-warning")
      warning.setAttribute("role", "note")
      const warningHeading = htmlElement(document, "h3")
      warningHeading.textContent = t("privacy.title")
      const warningText = document.createElement("p")
      warningText.textContent = t("council.effects")
      warning.append(warningHeading, warningText)
      topology.append(heading, description, warning)
      const stages = htmlElement(document, "div", "apc-topology-stages")
      stages.setAttribute("role", "list")
      if (mode === "sequential") {
        stages.dataset.apcCausalChain = "true"
        stages.dataset.connectionSource = "main"
      }
      const reachableRunIds = mode === "parallel"
        ? validateConfigForMode(config, "parallel").reachableRunIds
        : new Set<string>()
      pipeline.stages.forEach((stage, stageIndex) =>
        renderStage(stages, config, pipeline, mode, stage, stageIndex, reachableRunIds))
      topology.append(stages)
      const graphActions = htmlElement(document, "div", "apc-card-actions")
      const addStage = actionButton(document, t("action.addStage"), "add-stage", {}, true)
      const stageLimitReached = pipeline.stages.length >= MAX_STAGES_PER_PIPELINE
      const runLimitReached = runCount(pipeline) >= MAX_RUNS_PER_PIPELINE
      addStage.disabled = stageLimitReached || runLimitReached
      renderMissingGraphActions(topology, config)
      graphActions.append(addStage)
      if (stageLimitReached || runLimitReached) {
        const note = htmlElement(document, "span", "apc-disabled-reason")
        note.setAttribute("role", "note")
        note.textContent = stageLimitReached
          ? limitMessage(t("graph.stages"), MAX_STAGES_PER_PIPELINE)
          : limitMessage(t("agentGraph.run"), MAX_RUNS_PER_PIPELINE)
        graphActions.append(note)
      }
      topology.append(graphActions)
      renderFinalRoute(topology, config, pipeline)
      workspace.append(topology)
    }
    if (surface === "all") renderSelectionDetail(workspace, config, pipeline)
    parent.append(workspace)
  }

  const renderErrors = (parent: HTMLElement, mode: ApcMode): void => {
    const issues = current.validationIssues ?? current.modeIssues?.[mode] ?? []
    if (!issues.length) return
    const list = htmlElement(document, "ul", "apc-validation-errors")
    list.setAttribute("role", "alert")
    for (const issue of issues) {
      const item = document.createElement("li")
      item.textContent = localizeMessage(issueMessage(issue), t)
      list.append(item)
    }
    parent.append(list)
  }

  const applyMutationLocks = (): void => {
    if (!locked()) return
    for (const root of interactiveRoots()) {
      for (const control of root.querySelectorAll<HTMLButtonElement>("[data-apc-mutates=true]")) {
        control.disabled = true
        control.setAttribute("aria-disabled", "true")
      }
    }
  }

  const focusRequestedControl = (): void => {
    const request = focusAfterRender
    focusAfterRender = null
    if (!request) return
    const candidates = interactiveRoots().flatMap((root) =>
      [...root.querySelectorAll<HTMLElement>("[data-action], [data-apc-editor-status], [data-apc-connection-slot-label]")],
    )
    const target = candidates.find((candidate) => Object.entries(request).every(([key, value]) => candidate.dataset[key] === value)) ?? null
    if (target?.matches(":disabled")) {
      focus(element.querySelector<HTMLElement>("[data-apc-editor-status=true]"))
      return
    }
    focus(target)
  }

  const captureFocusedAction = (): void => {
    if (focusAfterRender !== null) return
    const active = document.activeElement
    if (!(active instanceof HTMLElement) || !interactiveRoots().some((root) => root.contains(active))) return
    if (active.dataset.apcConnectionSlotLabel === "true") {
      focusAfterRender = { apcConnectionSlotLabel: "true", apcSlotKey: active.dataset.apcSlotKey ?? "" }
      return
    }
    const action = active.dataset.action
    if (active.dataset.apcEditorStatus === "true") {
      focusAfterRender = { apcEditorStatus: "true" }
      return
    }
    if (!action) return
    const request: Record<string, string> = { action }
    for (const key of ["mode", "apcThreadKey", "apcRunKey", "apcStageKey", "apcSlotKey", "direction"] as const) {
      const value = active.dataset[key]
      if (value !== undefined) request[key] = value
    }
    focusAfterRender = request
  }

  const renderCurrent = (): void => {
    if (destroyed) return
    captureFocusedAction()
    renderRevision += 1
    const liveElement = liveRegion?.element
    element.replaceChildren()
    if (surface !== "topology") {
      if (toolbarRoot) {
        toolbarRoot.replaceChildren()
        renderToolbar(toolbarRoot)
      } else {
        renderToolbar(element)
      }
      renderStatus(element)
    }
    const content = htmlElement(document, "div", "apc-graph-content")
    const mode = effectiveMode(current)
    const pipeline = mode !== null && mode !== "single" && current.config
      ? pipelineFor(current.config, mode)
      : undefined
    projectExecutionStatuses(pipeline)
    if (!mode) {
      const alert = htmlElement(document, "p", "apc-blocked")
      alert.setAttribute("role", "alert")
      alert.textContent = t("validation.activeModeInvalid")
      content.append(alert)
    } else if (!current.config) {
      const alert = htmlElement(document, "p", "apc-blocked")
      alert.setAttribute("role", "alert")
      alert.textContent = t("validation.configInvalid")
      content.append(alert)
    } else {
      const hasGraph = current.config.pipelines.sequential !== undefined || current.config.pipelines.parallel !== undefined
      if (!hasGraph || (mode !== "single" && !pipeline)) {
        if (surface === "navigation") renderThreadNavigation(content, current.config)
        else renderEmpty(content)
      } else if (mode === "single") {
        if (surface === "navigation") {
          renderThreadNavigation(content, current.config)
        } else {
          const heading = htmlElement(document, "h2")
          heading.textContent = t("mode.singleTitle")
          const description = htmlElement(document, "p")
          description.textContent = t("mode.singleDescription")
          content.append(heading, description)
          renderMissingGraphActions(content, current.config)
        }
      } else if (pipeline) {
        renderGraph(content, mode, current.config, pipeline)
      }
      if (surface !== "navigation") renderErrors(content, mode)
    }
    element.append(content)
    applyMutationLocks()
    if (ownsLiveRegion && liveElement && liveElement !== element) element.append(liveElement)
    focusRequestedControl()
  }

  const readActionTarget = (event: Event): ActionTarget | null => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return null
    return target.closest<HTMLElement>("[data-action]") as ActionTarget | null
  }

  const selectFromTarget = (target: ActionTarget): void => {
    if (!current.config) return
    if (target.dataset.action === "select-thread") {
      const threadId = idForUiKey("thread", target.dataset.apcThreadKey)
      const thread = current.config.threads.find((candidate) => candidate.id === threadId)
      if (thread) emitSelection({ kind: "thread", threadId: thread.id }, thread.name)
    } else if (target.dataset.action === "select-run") {
      const runId = idForUiKey("run", target.dataset.apcRunKey)
      const pipeline = pipelineFor(current.config, selectedMode())
      const run = pipeline?.stages.flatMap((stage) => stage.runs).find((candidate) => candidate.id === runId)
      if (run && pipeline) emitSelection({ kind: "run", runId: run.id }, runLabel(current.config, run))
    }
  }

  const onClick = (event: Event): void => {
    const target = readActionTarget(event)
    if (!target || destroyed || target.hasAttribute("disabled") || target.getAttribute("aria-disabled") === "true") return
    const action = target.dataset.action
    const threadId = idForUiKey("thread", target.dataset.apcThreadKey)
    const stageId = idForUiKey("stage", target.dataset.apcStageKey)
    const runId = idForUiKey("run", target.dataset.apcRunKey)
    const slotId = idForUiKey("slot", target.dataset.apcSlotKey)
    if (action === "select-mode") {
      const mode = asMode(target.dataset.mode)
      if (mode) emitMode(mode)
    } else if (action === "create-graph") {
      const mode = asMode(target.dataset.mode)
      if (mode === "sequential" || mode === "parallel") createGraph(mode, target.dataset.preserveMode !== "true")
    } else if (action === "select-thread" || action === "select-run") selectFromTarget(target)
    else if (action === "open-loom" && threadId) invoke(() => options.onOpenLoom?.(threadId))
    else if (action === "add-thread") addThread()
    else if (action === "add-connection-slot") addConnectionSlot()
    else if (action === "add-stage") addStage()
    else if (action === "add-run" && stageId) addRun(stageId)
    else if (action === "move-thread" && threadId && target.dataset.direction) reorderThread(threadId, target.dataset.direction as "up" | "down")
    else if (action === "move-stage" && stageId && target.dataset.direction) reorderStage(stageId, target.dataset.direction as "up" | "down")
    else if (action === "move-run" && runId && target.dataset.direction) reorderRun(runId, target.dataset.direction as "up" | "down")
    else if (action === "remove-connection-slot" && slotId) {
      const slot = current.config?.connectionSlots.find((candidate) => candidate.id === slotId)
      if (slot && !current.config?.threads.some((thread) => thread.connectionSlotId === slot.id)) {
        requestRemoval("slot", slot.id, slot.label)
      }
    }
    else if (action === "remove-thread" && threadId) {
      const thread = current.config?.threads.find((candidate) => candidate.id === threadId)
      if (thread) requestRemoval("thread", thread.id, thread.name)
    } else if (action === "remove-stage" && stageId) {
      const stage = pipelineFor(current.config, selectedMode())?.stages.find((candidate) => candidate.id === stageId)
      if (stage) requestRemoval("stage", stage.id, stage.name)
    } else if (action === "remove-run" && runId) {
      const pipeline = pipelineFor(current.config, selectedMode())
      const run = pipeline?.stages.flatMap((stage) => stage.runs).find((candidate) => candidate.id === runId)
      if (run && current.config) requestRemoval("run", run.id, runLabel(current.config, run))
    } else if (action === "cancel-confirmation") cancelRemoval()
    else if (action === "confirm-removal") confirmRemoval()
    else if (action === "final-main") {
      const pipeline = pipelineFor(current.config, selectedMode())
      const selectedRunId = current.selection?.kind === "run" ? current.selection.runId : undefined
      const runs = pipeline?.stages.flatMap((stage) => stage.runs) ?? []
      const selectedRun = selectedRunId === undefined ? undefined : runs.find((candidate) => candidate.id === selectedRunId)
      const currentFinalRoute = pipeline?.finalResponse
      const currentFinalRun = currentFinalRoute?.source === "thread"
        ? runs.find((candidate) => candidate.id === currentFinalRoute.runId)
        : undefined
      const run = selectedRun ?? currentFinalRun
      if (pipeline?.finalResponse.source === "thread" && run) {
        setFinalRoute({
          source: "main",
          inputs: [{
            source: "output",
            runId: run.id,
            onMissing: "fail-graph",
          }],
        })
      }
    } else if (action === "final-thread") {
      const pipeline = pipelineFor(current.config, selectedMode())
      const selectedRunId = current.selection?.kind === "run" ? current.selection.runId : undefined
      const runs = pipeline?.stages.flatMap((stage) => stage.runs) ?? []
      const selectedRun = selectedRunId === undefined ? undefined : runs.find((candidate) => candidate.id === selectedRunId)
      const canonicalRunId = pipeline ? canonicalMainFinalRunId(pipeline) : undefined
      const run = selectedRun ?? (canonicalRunId === undefined ? undefined : runs.find((candidate) => candidate.id === canonicalRunId))
      if (run && (!pipeline || pipeline.finalResponse.source !== "thread" || pipeline.finalResponse.runId !== run.id)) {
        setFinalRoute({ source: "thread", runId: run.id })
      }
    }
  }

  const focusAdjacentSelection = (target: ActionTarget, direction: number): void => {
    const selector = target.dataset.action === "select-thread" ? "[data-apc-thread-select=true]" : "[data-apc-run-select=true]"
    const controls = [...element.querySelectorAll<HTMLElement>(selector)]
    const index = controls.indexOf(target)
    if (index < 0) return
    const next = controls[index + direction]
    if (next) focus(next)
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (destroyed) return
    if ((event.key === "Escape" || event.key === "Esc") && pendingConfirmation) {
      event.preventDefault()
      cancelRemoval()
      return
    }
    const target = readActionTarget(event)
    if (!target || target.hasAttribute("disabled") || target.getAttribute("aria-disabled") === "true") return
    const action = target.dataset.action
    if (action === "select-mode") {
      const mode = asMode(target.dataset.mode)
      if (!mode) return
      if (["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(event.key)) {
        event.preventDefault()
        const direction = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1
        const index = APC_MODES.indexOf(mode)
        for (let offset = 1; offset <= APC_MODES.length; offset += 1) {
          const candidate = APC_MODES[(index + direction * offset + APC_MODES.length * 2) % APC_MODES.length]
          if (!modeIsBlocked(current, candidate, t)) {
            emitMode(candidate)
            return
          }
        }
      } else if (event.key === " " || event.key === "Enter") {
        event.preventDefault()
        emitMode(mode)
      }
      return
    }
    if (action !== "select-thread" && action !== "select-run") return
    if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault()
      const direction = event.key === "ArrowUp" ? "up" : "down"
      if (action === "select-thread") {
        const threadId = idForUiKey("thread", target.dataset.apcThreadKey)
        if (threadId) reorderThread(threadId, direction)
      } else {
        const runId = idForUiKey("run", target.dataset.apcRunKey)
        if (!runId) return
        if (selectedMode() === "sequential") {
          const stage = pipelineFor(current.config, "sequential")?.stages.find((candidate) => candidate.runs.some((run) => run.id === runId))
          if (stage) reorderStage(stage.id, direction)
        } else {
          reorderRun(runId, direction)
        }
      }
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault()
      focusAdjacentSelection(target, -1)
    } else if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault()
      focusAdjacentSelection(target, 1)
    } else if (event.key === " " || event.key === "Enter") {
      event.preventDefault()
      selectFromTarget(target)
    }
  }

  element.addEventListener("click", onClick)
  element.addEventListener("keydown", onKeyDown)
  toolbarRoot?.addEventListener("click", onClick)
  toolbarRoot?.addEventListener("keydown", onKeyDown)

  const render = (snapshot: GraphEditorSnapshot): void => {
    if (destroyed) return
    authoritativeRenderRevision += 1
    captureFocusedAction()
    const next = normalizeSnapshot(snapshot)
    observeImportedIds(next.config)
    if (next.saveError && next.saveError !== current.saveError) announce(localizeMessage(next.saveError.message, t), "assertive")
    if (next.busy && !current.busy) announce(t("a11y.saving", { mode: modeLabel(effectiveMode(next) ?? "single", t) }))
    if (!next.busy && current.busy && !next.saveError) announce(t("a11y.saved", { mode: modeLabel(effectiveMode(next) ?? "single", t) }))
    if (next.stale && !current.stale) announce(t("error.staleConfigReload"), "assertive")
    if (
      pendingConfirmation !== null ||
      next.mutationLocked ||
      (next.execution !== undefined && !next.execution.terminal) ||
      next.busy ||
      next.stale ||
      (next.blockedReasons?.length ?? 0) > 0
    ) {
      dismissPendingConfirmation()
    }
    current = next
    renderCurrent()
  }

  const destroy = (): void => {
    if (destroyed) return
    destroyed = true
    element.removeEventListener("click", onClick)
    element.removeEventListener("keydown", onKeyDown)
    toolbarRoot?.removeEventListener("click", onClick)
    toolbarRoot?.removeEventListener("keydown", onKeyDown)
    unsubscribeState?.()
    unsubscribeState = undefined
    pendingConfirmation = null
    graphIdCounter.value = 0
    if (ownsLiveRegion) liveRegion?.cleanup?.()
    liveRegion = undefined
    element.replaceChildren()
    toolbarRoot?.remove()
  }

  if (options.state) {
    unsubscribeState = options.state.subscribe(render)
    const stateSnapshot = options.state.get?.() ?? options.state.getSnapshot?.()
    if (stateSnapshot) {
      const normalized = normalizeSnapshot(stateSnapshot)
      observeImportedIds(normalized.config)
      current = normalized
    }
  }
  renderCurrent()
  return { element, render, destroy }
}

function normalizeSnapshot(snapshot: GraphEditorSnapshot | undefined): InternalSnapshot {
  const config = snapshot?.config ?? null
  return {
    config,
    presetId: snapshot?.presetId ?? null,
    activeMode: snapshot?.activeMode ?? config?.activeMode ?? null,
    selection: snapshot?.selection ?? null,
    supportedModes: snapshot?.supportedModes ?? config?.supportedModes ?? ["single"],
    modeAvailability: snapshot?.modeAvailability,
    modeIssues: snapshot?.modeIssues,
    validationIssues: snapshot?.validationIssues,
    dirty: snapshot?.dirty ?? false,
    busy: snapshot?.busy ?? false,
    blockedReasons: snapshot?.blockedReasons ?? [],
    saveError: snapshot?.saveError ?? null,
    stale: snapshot?.stale ?? false,
    finalResponseAvailable: snapshot?.finalResponseAvailable,
    finalResponseBlockedReason: snapshot?.finalResponseBlockedReason,
    execution: snapshot?.execution,
    mutationLocked: snapshot?.mutationLocked ?? false,
    locale: snapshot?.locale,
  }
}

export type {
  ApcFinalResponseV1,
  ApcInputBindingV1,
  ApcMode,
  ApcPresetConfigV1,
  ApcRunV1,
  ApcSelection,
  ApcStageV1,
  ApcThreadV1,
}
