import type {
  SpindleFrontendContext,
  SpindleFrontendTeardown,
  SpindleHostDescriptorV1,
  SpindlePresetEditorTabHandle,
  SpindlePresetEditorToolbarItemHandle,
} from "lumiverse-spindle-types"
import type {
  ApcInputBindingV1,
  ApcMode,
  ApcPipelineV1,
  ApcPresetConfigV1,
  ApcRunV1,
  ApcThreadV1,
} from "../config/schema"
import {
  MAX_BINDINGS_PER_RUN,
  MAX_CONNECTION_SLOTS,
  MAX_PARALLEL_WIDTH,
  MAX_RUNS_PER_PIPELINE,
  MAX_STAGES_PER_PIPELINE,
} from "../config/limits"
import { validateConfigForMode } from "../config/validate"
import { SpindleCompatibilityError, validateSpindleHostDescriptor } from "../compat"
import {
  createApcTranslator,
  type ApcTranslate,
} from "../i18n/catalogs"
import {
  decodeBackendResponse,
  type ActivityErrorCategory,
  type ActivityOutcome,
  type BackendResponse,
  type ConsentSelector,
  type FrontendMessage,
} from "../protocol/messages"
import {
  createApcPersistence,
  type ApcPersistence,
  type ApcPresetEditorDraftAdapter,
  type ApcDomainTransport,
} from "./persistence"
import {
  createApcFrontendState,
  type ApcExecutionActivity,
  type ApcFrontendSnapshot,
  type ApcFrontendStore,
} from "./state"
import {
  createGraphEditor,
  GRAPH_EDITOR_TAB_ID,
  GRAPH_EDITOR_TOOLBAR_ITEM_ID,
  type GraphEditorHandle,
  type GraphEditorMutation,
  type GraphEditorSnapshot,
} from "./graph-editor"
import {
  createThreadEditor,
  type ThreadEditorConsentSelector,
  type ThreadEditorController,
  type ThreadEditorLoomBridge,
  type ThreadEditorRunBindingChange,
  type ThreadEditorRunChange,
  type ThreadEditorSurface,
  type ThreadEditorSnapshot,
} from "./thread-editor"
import {
  createExecutionInspector,
  type ExecutionInspectorController,
  type ExecutionInspectorSnapshot,
  type InspectorErrorCategory,
  type InspectorInputSourceSummary,
  type InspectorActivityItem,
  type InspectorOutcomeInput,
  type InspectorRunSnapshot,
} from "./inspector"
import { createLiveRegion, focusElement, type LiveRegion } from "./accessibility"
import { createDomScope, type DomScope } from "./dom"
import {
  installScopedStyles,
  APC_EDITOR_REDUCED_MOTION_STYLE,
  APC_EDITOR_STYLE,
  type ScopedStylesheet,
} from "./styles"

const APC_TOOLBAR_STYLE = `
:scope .apc-mode-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: flex-start;
}
:scope .apc-mode-toolbar button {
  color: inherit;
  background: var(--lumiverse-fill-subtle, transparent);
  border: 0.0625rem solid var(--lumiverse-border, currentColor);
  border-radius: 0.25rem;
  padding: 0.35rem 0.65rem;
}
:scope .apc-mode-toolbar button[aria-checked="true"] {
  color: var(--lumiverse-accent-fg, var(--lumiverse-text, CanvasText));
  background: var(--lumiverse-accent, var(--lumiverse-primary, Highlight));
}
:scope .apc-mode-toolbar button:disabled {
  cursor: not-allowed;
  opacity: 0.65;
}
:scope .apc-mode-toolbar button:focus-visible {
  outline: 0.125rem solid var(--lumiverse-accent, var(--lumiverse-primary, Highlight));
  outline-offset: 0.125rem;
}
`

/** Stable setup errors let the loader expose an actionable failure without mounting APC. */
export type ApcFrontendSetupErrorCode =
  | "HOST_API_UNAVAILABLE"
  | "PERMISSION_DENIED"
  | "CONNECTION_SELECTION_UNAVAILABLE"

export class ApcFrontendSetupError extends Error {
  readonly code: ApcFrontendSetupErrorCode
  readonly missingPermissions: readonly string[]

  constructor(
    code: ApcFrontendSetupErrorCode,
    message: string,
    missingPermissions: readonly string[] = [],
  ) {
    super(message)
    this.name = "ApcFrontendSetupError"
    this.code = code
    this.missingPermissions = Object.freeze([...missingPermissions])
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export type ApcAppOptions = Readonly<{
  document?: Document
}>

type ThreadContinuationToken = Readonly<{
  thread: ThreadEditorController
  presetId: string
  threadId: string
  contextAuthorityGeneration: number
  consentAuthorityGeneration: number
}>
type InspectorContinuationToken = Readonly<{
  inspector: ExecutionInspectorController
  presetId: string
  executionKey: string
}>
export type ApcAppHandle = Readonly<{
  root: HTMLElement
  toolbarRoot: HTMLElement
  state: ApcFrontendStore
  flushWorkspace(): Promise<void>
  teardown: () => Promise<void>
}>

type PresetEditorExtension = SpindleFrontendContext["ui"]["presetEditor"]["extension"]
type ApcActivityGate = { active: boolean }
type ModeTransitionOperation = Readonly<{
  generation: number
  mode: ApcMode
  presetId: string | null
}>
type ModeSurfaceProjection = Readonly<{
  presetId: string
  mode: ApcMode
}>




function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function clone<T>(value: T): T {
  return structuredClone(value)
}
function consentSelector(value: ThreadEditorConsentSelector): ConsentSelector {
  if (
    typeof value.workspaceSource !== "string" ||
    (value.workspaceSource !== "native-blocks" && value.workspaceSource !== "main-context") ||
    typeof value.connectionSourceKey !== "string" ||
    (value.connectionSourceKey !== "main" && !value.connectionSourceKey.startsWith("slot:"))
  ) {
    throw new ApcFrontendSetupError("HOST_API_UNAVAILABLE", "Consent source information is unavailable")
  }
  return {
    presetId: value.presetId,
    threadId: value.threadId,
    workspaceSource: value.workspaceSource,
    connectionSourceKey: value.connectionSourceKey,
  }
}

function requiredPermissions(ctx: SpindleFrontendContext): readonly string[] {
  if (!Array.isArray(ctx.manifest?.permissions)) return []
  return ctx.manifest.permissions
    .map((permission) => String(permission))
    .filter((permission) => permission !== "final_response")
}

function finalResponsePermissionChange(payload: unknown): boolean | undefined {
  if (!isRecord(payload)) return undefined
  if (payload.permission === "final_response" && typeof payload.granted === "boolean") {
    return payload.granted
  }
  if (Array.isArray(payload.allGranted)) return payload.allGranted.includes("final_response")
  return undefined
}

function isPermissionRevoked(ctx: SpindleFrontendContext, payload: unknown): boolean {
  if (!isRecord(payload)) return false
  const permission = typeof payload.permission === "string" ? payload.permission : undefined
  if (Array.isArray(payload.allGranted) && missingPermissions(ctx, payload.allGranted).length > 0) return true
  if (payload.granted === false) {
    return permission === undefined || requiredPermissions(ctx).includes(permission)
  }
  return false
}


function asHostApiError(name: string): ApcFrontendSetupError {
  return new ApcFrontendSetupError(
    "HOST_API_UNAVAILABLE",
    `The host does not provide the required Spindle frontend API: ${name}`,
  )
}

function requireFunction(value: unknown, name: string): void {
  if (typeof value !== "function") throw asHostApiError(name)
}
function requireHtmlElement(value: unknown, name: string): asserts value is HTMLElement {
  if (!isRecord(value) || !("ownerDocument" in value)) throw asHostApiError(name)
  const ownerDocument = value.ownerDocument
  if (!isRecord(ownerDocument) || !("defaultView" in ownerDocument)) throw asHostApiError(name)
  const view = ownerDocument.defaultView
  if (!isRecord(view) || !("HTMLElement" in view) || typeof view.HTMLElement !== "function") {
    throw asHostApiError(name)
  }
  if (!(value instanceof view.HTMLElement)) throw asHostApiError(name)
}

function validateTabHandle(value: unknown): asserts value is SpindlePresetEditorTabHandle {
  if (!isRecord(value)) throw asHostApiError("ui.registerPresetEditorTab return value")
  requireHtmlElement(value.root, "ui.registerPresetEditorTab return value.root")
  requireFunction(value.setTitle, "ui.registerPresetEditorTab return value.setTitle")
  requireFunction(value.activate, "ui.registerPresetEditorTab return value.activate")
  requireFunction(value.onActivate, "ui.registerPresetEditorTab return value.onActivate")
  requireFunction(value.destroy, "ui.registerPresetEditorTab return value.destroy")
}

function validateToolbarHandle(value: unknown): asserts value is SpindlePresetEditorToolbarItemHandle {
  if (!isRecord(value)) throw asHostApiError("ui.registerPresetEditorToolbarItem return value")
  requireHtmlElement(value.root, "ui.registerPresetEditorToolbarItem return value.root")
  requireFunction(value.setVisible, "ui.registerPresetEditorToolbarItem return value.setVisible")
  requireFunction(value.destroy, "ui.registerPresetEditorToolbarItem return value.destroy")
}

function validateLoomHandle(value: unknown): void {
  if (!isRecord(value)) throw asHostApiError("components.mountLoomBlockEditor return value")
  requireHtmlElement(value.element, "components.mountLoomBlockEditor return value.element")
  requireFunction(value.update, "components.mountLoomBlockEditor return value.update")
  requireFunction(value.destroy, "components.mountLoomBlockEditor return value.destroy")
  requireFunction(value.getValue, "components.mountLoomBlockEditor return value.getValue")
  requireFunction(value.refreshMacros, "components.mountLoomBlockEditor return value.refreshMacros")
}

function disposeMalformedLoomHandle(value: unknown, target: string | Element): void {
  if (isRecord(value) && typeof value.destroy === "function") {
    try {
      value.destroy()
    } catch {
      // Preserve the boundary failure while still attempting to detach the mount.
    }
  }
  const element = isRecord(value) ? value.element : undefined
  if (isRecord(element) && typeof element.remove === "function") {
    try {
      element.remove()
    } catch {
      // Preserve the boundary failure when the host element cannot be detached.
    }
  }
  if (typeof target !== "string") {
    try {
      target.remove()
    } catch {
      // Preserve the boundary failure when the mount target cannot be detached.
    }
  }
}


function destroyPartialRegistration(value: unknown): void {
  if (!isRecord(value)) return
  try {
    if (typeof value.destroy === "function") value.destroy()
  } finally {
    const root = value.root
    if (isRecord(root) && typeof root.remove === "function") root.remove()
  }
}


function validateHostSurface(ctx: SpindleFrontendContext): void {
  requireFunction(ctx.deferReady, "deferReady")
  requireFunction(ctx.ready, "ready")
  requireFunction(ctx.sendToBackend, "sendToBackend")
  requireFunction(ctx.onBackendMessage, "onBackendMessage")
  requireFunction(ctx.locale?.get, "locale.get")
  requireFunction(ctx.locale?.subscribe, "locale.subscribe")
  requireFunction(ctx.permissions?.getGranted, "permissions.getGranted")
  requireFunction(ctx.events?.on, "events.on")
  requireFunction(ctx.ui?.registerPresetEditorTab, "ui.registerPresetEditorTab")
  requireFunction(ctx.ui?.registerPresetEditorToolbarItem, "ui.registerPresetEditorToolbarItem")
  requireFunction(ctx.ui?.presetEditor?.extension?.getState, "ui.presetEditor.extension.getState")
  requireFunction(ctx.ui?.presetEditor?.extension?.onChange, "ui.presetEditor.extension.onChange")
  requireFunction(ctx.ui?.presetEditor?.extension?.updateMetadata, "ui.presetEditor.extension.updateMetadata")
  requireFunction(ctx.ui?.presetEditor?.extension?.flush, "ui.presetEditor.extension.flush")
  requireFunction(ctx.ui?.presetEditor?.extension?.activateBuiltinTab, "ui.presetEditor.extension.activateBuiltinTab")
  requireFunction(ctx.components?.mountLoomBlockEditor, "components.mountLoomBlockEditor")
}

function missingPermissions(ctx: SpindleFrontendContext, granted: unknown): readonly string[] {
  const required = requiredPermissions(ctx)
  if (!Array.isArray(granted)) return Object.freeze([...new Set(required)])
  return Object.freeze([...new Set(required.filter((permission) => !granted.includes(permission)))])
}

function createEditorAdapter(editor: PresetEditorExtension, gate: ApcActivityGate): ApcPresetEditorDraftAdapter {
  return {
    getState: () => {
      if (!gate.active) return { presetId: null, metadata: null }
      const state = editor.getState()
      return {
        presetId: state.presetId,
        metadata: clone(state.metadata),
      }
    },
    onChange: (listener) => editor.onChange((state) => {
      if (!gate.active) return
      listener({
        presetId: state.presetId,
        metadata: clone(state.metadata),
      })
    }),
    updateMetadata: (mutator) => {
      if (!gate.active) return
      editor.updateMetadata((current) => {
        const next = mutator(clone(current))
        if (!isRecord(next)) {
          throw new TypeError("APC preset metadata must remain a plain JSON object")
        }
        return clone(next)
      })
    },
    flush: () => gate.active ? editor.flush() : Promise.resolve(),
  }
}

function createDomainTransport(
  ctx: SpindleFrontendContext,
  gate: ApcActivityGate,
  onInvalidMessage: (raw: unknown) => void,
): ApcDomainTransport {
  return {
    send: (message: FrontendMessage): void => {
      if (gate.active) ctx.sendToBackend(message)
    },
    onMessage: (listener): (() => void) => {
      if (!gate.active) return () => {}
      return ctx.onBackendMessage((payload) => {
        if (!gate.active) return
        let message: BackendResponse
        try {
          message = decodeBackendResponse(payload)
        } catch {
          onInvalidMessage(payload)
          return
        }
        listener(message)
      })
    },
  }
}

function threadFinalAvailable(host: SpindleHostDescriptorV1, granted: unknown): boolean {
  return (host.capabilities["interceptor-final-response-v1"] ?? 0) >= 1 &&
    Array.isArray(granted) &&
    granted.includes("final_response")
}

function graphSnapshot(
  snapshot: ApcFrontendSnapshot,
  finalResponseAvailable: boolean,
  locale: string,
  uiMutationLocked = false,
): GraphEditorSnapshot {
  const execution: GraphEditorSnapshot["execution"] =
    snapshot.execution.executionKey === null || !snapshot.execution.topologyApplicable
      ? undefined
      : {
          terminal: snapshot.execution.terminal,
          ...(snapshot.execution.outcome === "graph-fallback" ? { outcome: "graph-fallback" as const } : {}),
          activity: snapshot.execution.topologyActivity.flatMap((item) => {
            const { stageIndex, runIndex, status } = item
            if (
              typeof stageIndex !== "number" ||
              !Number.isInteger(stageIndex) ||
              stageIndex < 0 ||
              typeof runIndex !== "number" ||
              !Number.isInteger(runIndex) ||
              runIndex < 0
            ) return []
            return [{ stageIndex, runIndex, status }]
          }),
        }
  return {
    presetId: snapshot.presetId,
    config: snapshot.config,
    activeMode: snapshot.activeMode,
    selection: snapshot.selection,
    supportedModes: snapshot.config?.supportedModes ?? ["single"],
    modeAvailability: snapshot.modeAvailability,
    modeIssues: snapshot.modeIssues,
    validationIssues: snapshot.decoded?.issues,
    dirty: snapshot.dirty,
    busy: snapshot.busy,
    blockedReasons: snapshot.blockedReasons,
    saveError: snapshot.saveError,
    stale: snapshot.stale,
    finalResponseAvailable,
    ...(finalResponseAvailable ? {} : { finalResponseBlockedReason: { key: "mode.threadFinalUnavailable" } }),
    ...(execution === undefined ? {} : { execution }),
    mutationLocked: snapshot.executionMutationLocked || uiMutationLocked,
    locale,
  }
}

function activePipeline(config: ApcPresetConfigV1 | null): ApcPipelineV1 | undefined {
  if (config === null || config.activeMode === "single") return undefined
  return config.pipelines[config.activeMode]
}

type RunLocation = Readonly<{
  pipeline: ApcPipelineV1
  stageIndex: number
  runIndex: number
  run: ApcRunV1
  thread: ApcThreadV1
}>

function findRun(
  config: ApcPresetConfigV1,
  runId: string,
  pipeline: ApcPipelineV1 | undefined = activePipeline(config),
): RunLocation | undefined {
  if (pipeline === undefined) return undefined
  for (const [stageIndex, stage] of pipeline.stages.entries()) {
    const runIndex = stage.runs.findIndex((run) => run.id === runId)
    if (runIndex < 0) continue
    const run = stage.runs[runIndex]
    const thread = config.threads.find((candidate) => candidate.id === run?.threadId)
    if (run !== undefined && thread !== undefined) {
      return { pipeline, stageIndex, runIndex, run, thread }
    }
  }
  return undefined
}

function selectedRunLocation(snapshot: ApcFrontendSnapshot): RunLocation | undefined {
  const config = snapshot.config
  const selection = snapshot.selection
  return config !== null && selection?.kind === "run"
    ? findRun(config, selection.runId)
    : undefined
}

function selectionThreadId(snapshot: ApcFrontendSnapshot): string | null {
  const selection = snapshot.selection
  if (selection?.kind === "thread") return selection.threadId
  return selectedRunLocation(snapshot)?.run.threadId ?? null
}

function matchingConsent(
  snapshot: ApcFrontendSnapshot,
  presetId: string,
  threadId: string,
  workspaceSource: ApcThreadV1["workspaceSource"],
  connectionSourceKey: "main" | `slot:${string}`,
): ApcFrontendSnapshot["consent"][string] | undefined {
  const matches = Object.values(snapshot.consent)
    .filter((consent) => consent.presetId === presetId)
    .filter((consent) => consent.threadId === threadId)
    .filter((consent) => consent.workspaceSource === workspaceSource)
    .filter((consent) => consent.connectionSourceKey === connectionSourceKey)
  return matches[matches.length - 1]
}

type OutputBindingEntry = Readonly<{
  key: string
  inputIndex: number
  binding: Extract<ApcInputBindingV1, { source: "output" }>
}>

function outputBindings(run: ApcRunV1): readonly OutputBindingEntry[] {
  const entries: OutputBindingEntry[] = []
  for (const [inputIndex, binding] of run.inputs.entries()) {
    if (binding.source !== "output") continue
    entries.push({
      key: `binding-${entries.length + 1}`,
      inputIndex,
      binding,
    })
  }
  return entries
}

function earlierRunLocations(
  config: ApcPresetConfigV1,
  location: RunLocation,
): readonly RunLocation[] {
  const earlier: RunLocation[] = []
  for (let stageIndex = 0; stageIndex < location.stageIndex; stageIndex += 1) {
    const stage = location.pipeline.stages[stageIndex]
    if (stage === undefined) continue
    for (const [runIndex, run] of stage.runs.entries()) {
      const thread = config.threads.find((candidate) => candidate.id === run.threadId)
      if (thread !== undefined) {
        earlier.push({ pipeline: location.pipeline, stageIndex, runIndex, run, thread })
      }
    }
  }
  return earlier
}
function requiredLockedRunIds(pipeline: ApcPipelineV1): ReadonlySet<string> {
  const runs = pipeline.stages.flatMap((stage) => stage.runs)
  const locked = new Set<string>()
  if (pipeline.finalResponse.source === "thread") {
    locked.add(pipeline.finalResponse.runId)
  } else {
    for (const input of pipeline.finalResponse.inputs) {
      if (input.onMissing === "fail-graph") locked.add(input.runId)
    }
  }

  let changed = true
  while (changed) {
    changed = false
    for (const run of runs) {
      if (!run.required && !locked.has(run.id)) continue
      for (const input of run.inputs) {
        if (input.source !== "output" || input.onMissing !== "fail-graph" || locked.has(input.runId)) continue
        locked.add(input.runId)
        changed = true
      }
    }
  }
  return locked
}


function threadSnapshot(
  snapshot: ApcFrontendSnapshot,
  host: SpindleHostDescriptorV1,
  boundConnectionKeys: ReadonlyMap<string, string>,
  contextAuthorityGeneration: number,
  consentAuthorityGeneration: number,
  consentReviewOpen = false,
): ThreadEditorSnapshot | null {
  const presetId = snapshot.presetId
  const config = snapshot.config
  const activeMode = config?.activeMode
  const activeGraph = activeMode !== undefined &&
    activeMode !== "single" &&
    config?.pipelines[activeMode] !== undefined
  if (presetId === null || config === null || !snapshot.hydrated || !activeGraph) return null
  const usesMainConnection = config.activeMode === "sequential"

  const selectedLocation = selectedRunLocation(snapshot)
  const selectedThreadId = selectionThreadId(snapshot)
  const consentImpact = selectedThreadId === null
    ? undefined
    : activePipeline(config)?.stages.reduce((impact, stage) => {
        for (const run of stage.runs) {
          if (run.threadId !== selectedThreadId) continue
          if (run.required) impact.requiredRuns += 1
          else impact.optionalRuns += 1
        }
        return impact
      }, { requiredRuns: 0, optionalRuns: 0 })
  const selectedRun = selectedLocation === undefined
    ? undefined
    : (() => {
        const earlier = earlierRunLocations(config, selectedLocation)
        const earlierIds = new Set(earlier.map((location) => location.run.id))
        const position = runPositionProjection(config, selectedLocation)
        return {
          id: selectedLocation.run.id,
          threadId: selectedLocation.run.threadId,
          stageName: selectedLocation.pipeline.stages[selectedLocation.stageIndex]?.name ?? "",
          stageOrdinal: selectedLocation.stageIndex + 1,
          ordinal: selectedLocation.runIndex + 1,
          positionTargets: position.targets,
          ...(position.restricted ? { positionRestricted: true } : {}),
          required: selectedLocation.run.required,
          requiredLocked: requiredLockedRunIds(selectedLocation.pipeline).has(selectedLocation.run.id),
          timeoutMs: selectedLocation.run.timeoutMs,
          earlierOutputs: earlier.map((location) => ({
            runId: location.run.id,
            threadName: location.thread.name,
            stageName: location.pipeline.stages[location.stageIndex]?.name ?? "",
            stageOrdinal: location.stageIndex + 1,
            runOrdinal: location.runIndex + 1,
            required: location.run.required,
          })),
          bindings: outputBindings(selectedLocation.run)
            .filter(({ binding }) => earlierIds.has(binding.runId))
            .map(({ key, binding }) => ({
              id: key,
              sourceRunId: binding.runId,
              role: binding.role,
              onMissing: binding.onMissing,
            })),
        }
      })()
  const mutationLocked = snapshot.executionMutationLocked
  const readOnly = mutationLocked || snapshot.busyReason === "save" || snapshot.stale

  return {
    installationId: host.extensionInstallationId,
    presetId,
    contextAuthorityGeneration,
    consentAuthorityGeneration,
    selectedThreadId,
    ...(consentImpact === undefined ? {} : { consentImpact }),
    ...(consentReviewOpen ? { consentReviewOpen: true } : {}),
    ...(selectedRun === undefined ? {} : { selectedRun }),
    threads: config.threads.map((thread) => ({
      id: thread.id,
      name: thread.name,
      description: thread.description,
      workspaceSource: thread.workspaceSource,
      ...(
        usesMainConnection || thread.connectionSlotId === undefined
          ? {}
          : { connectionSlotId: thread.connectionSlotId }
      ),
      blocks: clone(thread.blocks),
      promptVariableValues: clone(thread.promptVariableValues),
      output: clone(thread.output),
    })),
    slots: usesMainConnection
      ? []
      : config.connectionSlots.map((slot) => {
          const binding = snapshot.connectionBindings[slot.id]
          return {
            id: slot.id,
            label: slot.label,
            ...(slot.hint?.provider === undefined ? {} : { provider: slot.hint.provider }),
            ...(slot.hint?.model === undefined ? {} : { model: slot.hint.model }),
            bound: binding?.bound === true,
            ...(binding?.status === undefined ? {} : { bindingStatus: binding.status }),
            ...(
              binding?.bound === true && boundConnectionKeys.has(slot.id)
                ? { boundConnectionId: boundConnectionKeys.get(slot.id) }
                : {}
            ),
          }
        }),
    connections: usesMainConnection
      ? []
      : snapshot.availableConnections.map((connection) => ({
          id: connection.key,
          name: connection.name,
          provider: connection.provider,
          model: connection.model,
        })),
    consents: config.threads.map((thread) => {
      const connectionSourceKey: "main" | `slot:${string}` = usesMainConnection ||
        thread.connectionSlotId === undefined
        ? "main"
        : `slot:${thread.connectionSlotId}`
      const consent = matchingConsent(
        snapshot,
        presetId,
        thread.id,
        thread.workspaceSource,
        connectionSourceKey,
      )
      return {
        threadId: thread.id,
        workspaceSource: thread.workspaceSource,
        connectionSourceKey,
        status: consent?.status ?? "required",
        ...(consent?.destination === undefined ? {} : { destination: clone(consent.destination) }),
        ...(consent?.disclosure === undefined ? {} : { disclosure: clone(consent.disclosure) }),
      }
    }),
    consentReviewOpen,
    readOnly: readOnly || snapshot.blockedReasons.length > 0,
    mutationLocked,
    ...(snapshot.blockedReasons[0] === undefined ? {} : { blockedReason: snapshot.blockedReasons[0] }),
  }
}

function inspectorErrorCategory(category: ActivityErrorCategory | undefined): InspectorErrorCategory {
  switch (category) {
    case "integrity": return "integrity"
    case "consent": return "consent"
    case "provider": return "provider"
    case "timeout": return "timeout"
    case "dispatch": return "connection"
    case "config":
    case "capacity":
    case "assembly":
    case "tool": return "graph"
    case "unknown":
    case undefined: return "unknown"
  }
  return "unknown"
}

function inspectorOutcome(
  outcome: ActivityOutcome,
  category: ActivityErrorCategory | undefined,
): InspectorOutcomeInput {
  return {
    class: outcome,
    ...(category === undefined ? {} : { category: inspectorErrorCategory(category) }),
  }
}

function roleLabel(role: Extract<ApcInputBindingV1, { source: "output" }>["role"], t: ApcTranslate): string {
  if (role === "system") return t("binding.roleSystem")
  if (role === "assistant") return t("binding.roleAssistant")
  return t("binding.roleUser")
}

function inspectorRun(
  config: ApcPresetConfigV1,
  location: RunLocation,
  t: ApcTranslate,
): InspectorRunSnapshot {
  const earlier = new Map(
    earlierRunLocations(config, location).map((candidate) => [candidate.run.id, candidate] as const),
  )
  const inputSources: InspectorInputSourceSummary[] = []
  for (const input of location.run.inputs) {
    if (input.source === "literal") {
      inputSources.push({ kind: "literal", roleLabel: roleLabel(input.role, t) })
      continue
    }
    const source = earlier.get(input.runId)
    if (source === undefined) continue
    inputSources.push({
      kind: "earlier-output",
      label: source.thread.name,
      roleLabel: roleLabel(input.role, t),
      required: input.onMissing === "fail-graph",
      missingPolicy: input.onMissing,
    })
  }
  const outputLabel = t("graph.defaultFinalResponseName")
  return {
    threadLabel: location.thread.name,
    stageLabel: location.pipeline.stages[location.stageIndex]?.name,
    index: location.runIndex + 1,
    status: "pending",
    optional: !location.run.required,
    deadline: { timeoutMs: location.run.timeoutMs },
    inputSources,
    output: { label: outputLabel },
  }
}
function inspectorActivity(
  config: ApcPresetConfigV1 | null,
  pipeline: ApcPipelineV1 | undefined,
  activity: ApcExecutionActivity,
): InspectorActivityItem {
  const stage = pipeline?.stages[activity.stageIndex ?? -1]
  const run = stage?.runs[activity.runIndex ?? -1]
  const thread = config?.threads.find((candidate) => candidate.id === run?.threadId)
  return {
    status: activity.status,
    ...(thread === undefined ? {} : { threadLabel: thread.name, runLabel: thread.name }),
    ...(stage === undefined ? {} : { stageLabel: stage.name }),
    ...(activity.errorCategory === undefined
      ? {}
      : { error: { category: inspectorErrorCategory(activity.errorCategory) } }),
  }
}


function inspectorTraceStatus(status: string | undefined):
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed-out"
  | undefined {
  if (
    status === "running" ||
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "timed-out"
  ) return status
  return undefined
}

export function inspectorStatus(snapshot: ApcFrontendSnapshot, t: ApcTranslate): ExecutionInspectorSnapshot {
  const config = snapshot.config
  const execution = snapshot.execution
  const pipeline = activePipeline(config)
  const selection = snapshot.selection
  const selectedLocation = config === null ? undefined : selectedRunLocation(snapshot)
  const traceView = {
    traces: snapshot.traces.summaries,
    traceDetails: Object.fromEntries(Object.entries(snapshot.traces.details).map(([key, detail]) => [
      key,
      {
        ...detail,
        events: detail.events.map((event) => {
          const status = inspectorTraceStatus(event.status)
          return {
            sequence: event.sequence,
            timestamp: event.timestamp,
            kind: event.kind,
            ...(status === undefined ? {} : { status }),
            ...(event.preview === undefined ? {} : { preview: event.preview }),
          }
        }),
      },
    ])),
  }
  const selectedThread = config === null || selection?.kind !== "thread"
    ? undefined
    : config.threads.find((thread) => thread.id === selection.threadId)
  const topologyIdentityApplicable = execution.executionKey === null || execution.topologyApplicable
  let finalRoute: ExecutionInspectorSnapshot["finalRoute"]
  if (topologyIdentityApplicable && pipeline !== undefined) {
    const response = pipeline.finalResponse
    if (response.source === "main") {
      finalRoute = { target: "main" }
    } else {
      const finalRun = config === null ? undefined : findRun(config, response.runId, pipeline)
      finalRoute = {
        target: "thread",
        ...(finalRun === undefined ? {} : { targetLabel: finalRun.thread.name }),
      }
    }
  }

  if (execution.executionKey === null) {
    if (selectedLocation !== undefined && config !== null) {
      return {
        view: "selected-run",
        status: "idle",
        selection: {
          kind: "run",
          threadLabel: selectedLocation.thread.name,
          workspaceSource: selectedLocation.thread.workspaceSource,
          stageLabel: selectedLocation.pipeline.stages[selectedLocation.stageIndex]?.name,
          stageIndex: selectedLocation.stageIndex + 1,
          run: inspectorRun(config, selectedLocation, t),
        },
        ...traceView,
        ...(finalRoute === undefined ? {} : { finalRoute }),
      }
    }
    if (selectedThread !== undefined) {
      return {
        view: "selected-thread",
        status: "idle",
        selection: {
          kind: "thread",
          threadLabel: selectedThread.name,
          workspaceSource: selectedThread.workspaceSource,
        },
        ...(finalRoute === undefined ? {} : { finalRoute }),
        ...traceView,
      }
    }
    return {
      view: "idle",
      status: "idle",
      ...(finalRoute === undefined ? {} : { finalRoute }),
      ...traceView,
    }
  }

  const currentStage = execution.topologyApplicable ? pipeline?.stages[execution.stageIndex ?? -1] : undefined
  const currentRun = execution.topologyApplicable ? currentStage?.runs[execution.runIndex ?? -1] : undefined
  const currentThread = execution.topologyApplicable
    ? config?.threads.find((thread) => thread.id === currentRun?.threadId)
    : undefined
  const source = currentThread === undefined
    ? undefined
    : config?.activeMode === "sequential" || currentThread.connectionSlotId === undefined
      ? "main" as const
      : "slot" as const
  const descriptor = execution.provider === undefined && execution.model === undefined
    ? undefined
    : {
        ...(execution.provider === undefined ? {} : { provider: execution.provider }),
        ...(execution.model === undefined ? {} : { model: execution.model }),
      }
  const currentDispatch = source === undefined
    ? undefined
    : { source, ...(descriptor === undefined ? {} : { descriptor }) }
  const currentLocation: RunLocation | undefined =
    execution.topologyApplicable &&
      pipeline !== undefined &&
      currentStage !== undefined &&
      currentRun !== undefined &&
      currentThread !== undefined &&
      execution.stageIndex !== undefined &&
      execution.runIndex !== undefined
      ? {
          pipeline,
          stageIndex: execution.stageIndex,
          runIndex: execution.runIndex,
          run: currentRun,
          thread: currentThread,
        }
      : undefined
  const currentActivity = execution.topologyApplicable
    ? execution.topologyActivity.findLast(
        (item) => item.stageIndex === execution.stageIndex && item.runIndex === execution.runIndex,
      )
    : undefined
  const currentActivityOwnsError = currentActivity?.status === "failed" &&
    currentActivity.errorCategory !== undefined
  const inspectedRun = currentLocation === undefined || config === null
    ? undefined
    : {
        ...inspectorRun(config, currentLocation, t),
        status: currentActivity?.status ?? "pending",
        ...(currentDispatch === undefined ? {} : { dispatch: currentDispatch }),
        ...(currentActivityOwnsError
          ? { error: { category: inspectorErrorCategory(currentActivity?.errorCategory) } }
          : {}),
      }
  const cancellationReason = execution.cancellationSource === "user" ||
      execution.cancellationSource === "stop" ||
      execution.cancellationSource === "replacement" ||
      execution.cancellationSource === "timeout"
    ? execution.cancellationSource
    : undefined
  const canUseMainFallback = execution.topologyApplicable &&
    execution.terminal &&
    execution.outcome === "graph-fallback" &&
    pipeline?.finalResponse.source === "thread"
  const executionStageCount = execution.topologyApplicable
    ? execution.stageCount ?? pipeline?.stages.length
    : undefined
  const progressStageIndex = execution.topologyApplicable ? execution.stageIndex : undefined

  return {
    view: "execution",
    status: execution.status,
    terminal: execution.terminal,
    ...(inspectedRun === undefined ? {} : { inspectedRun }),
    ...(execution.usage === undefined ? {} : { usage: execution.usage }),
    ...(execution.outcome === undefined
      ? {}
      : { outcome: inspectorOutcome(execution.outcome, execution.errorCategory) }),
    ...(execution.errorCategory === undefined
      ? {}
      : { error: { category: inspectorErrorCategory(execution.errorCategory) } }),
    ...(progressStageIndex === undefined &&
      executionStageCount === undefined &&
      execution.completedRuns === undefined &&
      execution.totalRuns === undefined
      ? {}
      : {
          progress: {
            ...(progressStageIndex === undefined ? {} : { stageIndex: progressStageIndex + 1 }),
            ...(executionStageCount === undefined ? {} : { stageCount: executionStageCount }),
            ...(execution.completedRuns === undefined ? {} : { completedRuns: execution.completedRuns }),
            ...(execution.totalRuns === undefined ? {} : { totalRuns: execution.totalRuns }),
            ...(execution.completedRuns === undefined || execution.totalRuns === undefined || execution.totalRuns === 0
              ? {}
              : { percent: execution.completedRuns / execution.totalRuns * 100 }),
          },
        }),
    ...(execution.remainingBudgetMs === undefined
      ? {}
      : { deadline: { remainingMs: execution.remainingBudgetMs } }),
    ...(execution.status !== "cancelled"
      ? {}
      : {
          cancellation: {
            requested: true,
            acknowledged: true,
            ...(cancellationReason === undefined ? {} : { reason: cancellationReason }),
          },
        }),
    stoppable: execution.status === "running" && !execution.terminal,
    ...(currentDispatch === undefined ? {} : { currentDispatch }),
    ...(execution.activity.length === 0
      ? {}
      : {
          activity: execution.activity.map((item) => execution.topologyApplicable
            ? inspectorActivity(config, pipeline, item)
            : inspectorActivity(null, undefined, item)),
        }),
    ...traceView,
    ...(finalRoute === undefined ? {} : { finalRoute }),
    ...(canUseMainFallback ? { canUseMainFallback: true } : {}),
  }
}

function updateRun(
  config: Readonly<ApcPresetConfigV1>,
  runId: string,
  updater: (run: ApcRunV1, location: RunLocation) => ApcRunV1,
): ApcPresetConfigV1 {
  if (config.activeMode === "single") return config as ApcPresetConfigV1
  const pipeline = config.pipelines[config.activeMode]
  if (pipeline === undefined) return config as ApcPresetConfigV1
  const location = findRun(config as ApcPresetConfigV1, runId, pipeline)
  if (location === undefined) return config as ApcPresetConfigV1
  const stages = pipeline.stages.map((stage, stageIndex) => stageIndex !== location.stageIndex
    ? stage
    : {
        ...stage,
        runs: stage.runs.map((run, runIndex) =>
          runIndex === location.runIndex ? updater(run, location) : run
        ),
      })
  return {
    ...config,
    pipelines: {
      ...config.pipelines,
      [config.activeMode]: { ...pipeline, stages },
    },
  }
}


function changeRunBinding(
  config: Readonly<ApcPresetConfigV1>,
  runId: string,
  bindingId: string,
  change: ThreadEditorRunBindingChange,
): ApcPresetConfigV1 {
  const candidate = updateRun(config, runId, (run, location) => {
    const entry = outputBindings(run).find((candidate) => candidate.key === bindingId)
    if (entry === undefined) return run
    if (
      change.sourceRunId !== undefined &&
      !earlierRunLocations(config as ApcPresetConfigV1, location)
        .some((candidate) => candidate.run.id === change.sourceRunId)
    ) return run
    return {
      ...run,
      inputs: run.inputs.map((input, inputIndex) => inputIndex !== entry.inputIndex
        ? input
        : {
            ...entry.binding,
            ...(change.sourceRunId === undefined ? {} : { runId: change.sourceRunId }),
            ...(change.role === undefined ? {} : { role: change.role }),
            ...(change.onMissing === undefined ? {} : { onMissing: change.onMissing }),
          }),
    }
  })
  try {
    return validateConfigForMode(candidate, candidate.activeMode).valid
      ? candidate
      : config as ApcPresetConfigV1
  } catch {
    return config as ApcPresetConfigV1
  }
}

function addRunBinding(config: Readonly<ApcPresetConfigV1>, runId: string): ApcPresetConfigV1 {
  const candidate = updateRun(config, runId, (run, location) => {
    const earlier = earlierRunLocations(config as ApcPresetConfigV1, location)
    const source = earlier.find((candidate) => candidate.run.required) ?? earlier[0]
    if (run.inputs.length >= MAX_BINDINGS_PER_RUN) return run
    if (source === undefined) return run
    return {
      ...run,
      inputs: [
        ...run.inputs,
        {
          source: "output",
          runId: source.run.id,
          role: "user",
          onMissing: source.run.required ? "fail-graph" : "omit-binding",
        },
      ],
    }
  })
  try {
    return validateConfigForMode(candidate, candidate.activeMode).valid
      ? candidate
      : config as ApcPresetConfigV1
  } catch {
    return config as ApcPresetConfigV1
  }
}

function removeRunBinding(
  config: Readonly<ApcPresetConfigV1>,
  runId: string,
  bindingId: string,
): ApcPresetConfigV1 {
  return updateRun(config, runId, (run) => {
    const entry = outputBindings(run).find((candidate) => candidate.key === bindingId)
    return entry === undefined
      ? run
      : { ...run, inputs: run.inputs.filter((_, inputIndex) => inputIndex !== entry.inputIndex) }
  })
}

type RunPosition = NonNullable<ThreadEditorRunChange["position"]>
type RunPositionProjection = Readonly<{
  targets: readonly Readonly<RunPosition & { stageName: string }>[]
  restricted: boolean
}>

function runPositionProjection(
  config: ApcPresetConfigV1,
  location: RunLocation,
): RunPositionProjection {
  const plausible = config.activeMode === "sequential"
    ? location.pipeline.stages.map((stage, stageIndex) => ({
        stageOrdinal: stageIndex + 1,
        runOrdinal: 1,
        stageName: stage.name,
      }))
    : config.activeMode === "parallel"
      ? location.pipeline.stages.flatMap((stage, stageIndex) => {
          const positions = stageIndex === location.stageIndex
            ? Math.min(stage.runs.length, MAX_PARALLEL_WIDTH)
            : stage.runs.length >= MAX_PARALLEL_WIDTH
              ? 0
              : stage.runs.length + 1
          return Array.from({ length: positions }, (_, runIndex) => ({
            stageOrdinal: stageIndex + 1,
            runOrdinal: runIndex + 1,
            stageName: stage.name,
          }))
        })
      : []
  let restricted = false
  const targets = plausible.filter((target) => {
    const current = target.stageOrdinal === location.stageIndex + 1 &&
      target.runOrdinal === location.runIndex + 1
    if (current) return true
    if (moveRun(config, location.run.id, target) !== config) return true
    restricted = true
    return false
  })
  return { targets, restricted }
}

function bindingsReferenceEarlierRuns(pipeline: ApcPipelineV1): boolean {
  const stageByRun = new Map<string, number>()
  pipeline.stages.forEach((stage, stageIndex) => {
    stage.runs.forEach((run) => stageByRun.set(run.id, stageIndex))
  })
  return pipeline.stages.every((stage, stageIndex) => stage.runs.every((run) =>
    run.inputs.every((input) => {
      if (input.source !== "output") return true
      const sourceStageIndex = stageByRun.get(input.runId)
      return sourceStageIndex !== undefined && sourceStageIndex < stageIndex
    })
  ))
}

function moveRun(
  config: Readonly<ApcPresetConfigV1>,
  runId: string,
  position: RunPosition,
): ApcPresetConfigV1 {
  if (
    config.activeMode === "single" ||
    !Number.isInteger(position.stageOrdinal) ||
    !Number.isInteger(position.runOrdinal)
  ) return config as ApcPresetConfigV1
  const pipeline = config.pipelines[config.activeMode]
  if (
    pipeline === undefined ||
    pipeline.stages.length === 0 ||
    pipeline.stages.length > MAX_STAGES_PER_PIPELINE ||
    pipeline.stages.reduce((count, stage) => count + stage.runs.length, 0) > MAX_RUNS_PER_PIPELINE
  ) return config as ApcPresetConfigV1
  const location = findRun(config as ApcPresetConfigV1, runId, pipeline)
  const targetStageIndex = position.stageOrdinal - 1
  if (
    location === undefined ||
    targetStageIndex < 0 ||
    targetStageIndex >= pipeline.stages.length
  ) return config as ApcPresetConfigV1

  let stages: ApcPipelineV1["stages"]
  if (config.activeMode === "sequential") {
    if (
      position.runOrdinal !== 1 ||
      pipeline.stages.some((stage) => stage.runs.length !== 1) ||
      targetStageIndex === location.stageIndex
    ) return config as ApcPresetConfigV1
    const reordered = [...pipeline.stages]
    const [sourceStage] = reordered.splice(location.stageIndex, 1)
    if (sourceStage === undefined) return config as ApcPresetConfigV1
    reordered.splice(targetStageIndex, 0, sourceStage)
    stages = reordered
  } else {
    const targetStage = pipeline.stages[targetStageIndex]
    const sourceStage = pipeline.stages[location.stageIndex]
    if (
      targetStage === undefined ||
      sourceStage === undefined ||
      (sourceStage.runs.length === 1 && targetStageIndex !== location.stageIndex)
    ) return config as ApcPresetConfigV1
    const targetLength = targetStage.runs.length + (targetStageIndex === location.stageIndex ? 0 : 1)
    if (
      position.runOrdinal < 1 ||
      (
        targetStageIndex !== location.stageIndex &&
        targetStage.runs.some((run) => run.threadId === location.run.threadId)
      ) ||
      position.runOrdinal > targetLength ||
      targetLength > MAX_PARALLEL_WIDTH ||
      (
        targetStageIndex === location.stageIndex &&
        position.runOrdinal === location.runIndex + 1
      )
    ) return config as ApcPresetConfigV1
    const withoutRun = pipeline.stages.map((stage, stageIndex) => stageIndex === location.stageIndex
      ? { ...stage, runs: stage.runs.filter((run) => run.id !== runId) }
      : stage)
    stages = withoutRun.map((stage, stageIndex) => {
      if (stageIndex !== targetStageIndex) return stage
      const runs = [...stage.runs]
      runs.splice(position.runOrdinal - 1, 0, location.run)
      return { ...stage, runs }
    })
  }

  const candidatePipeline: ApcPipelineV1 = { ...pipeline, stages }
  if (!bindingsReferenceEarlierRuns(candidatePipeline)) return config as ApcPresetConfigV1
  const candidateConfig: ApcPresetConfigV1 = {
    ...config,
    pipelines: {
      ...config.pipelines,
      [config.activeMode]: candidatePipeline,
    },
  }
  return validateConfigForMode(candidateConfig, config.activeMode).valid
    ? candidateConfig
    : config as ApcPresetConfigV1
}

function changeRun(
  config: Readonly<ApcPresetConfigV1>,
  runId: string,
  change: ThreadEditorRunChange,
): ApcPresetConfigV1 {
  const positioned = change.position === undefined ? config as ApcPresetConfigV1 : moveRun(config, runId, change.position)
  if (change.position !== undefined && positioned === config) return config as ApcPresetConfigV1
  return updateRun(positioned, runId, (run) => ({
    ...run,
    ...(change.required === undefined ? {} : { required: change.required }),
    ...(change.timeoutMs === undefined ? {} : { timeoutMs: change.timeoutMs }),
  }))
}

function routeActivePipelineToMain(config: Readonly<ApcPresetConfigV1>): ApcPresetConfigV1 {
  if (config.activeMode === "single") return config as ApcPresetConfigV1
  const pipeline = config.pipelines[config.activeMode]
  if (pipeline === undefined || pipeline.finalResponse.source === "main") {
    return config as ApcPresetConfigV1
  }
  return {
    ...config,
    pipelines: {
      ...config.pipelines,
      [config.activeMode]: {
        ...pipeline,
        finalResponse: {
          source: "main",
          inputs: [{
            source: "output",
            runId: pipeline.finalResponse.runId,
            onMissing: "fail-graph",
          }],
        },
      },
    },
  }
}

class ApcAppImpl implements ApcAppHandle {
  readonly #ctx: SpindleFrontendContext
  readonly #host: SpindleHostDescriptorV1
  readonly #document: Document
  #modeSurfaceActivation: ModeSurfaceProjection | null = null

  readonly #activity: ApcActivityGate
  readonly #onDisarmed: () => void
  readonly #t: ApcTranslate
  readonly #tab: SpindlePresetEditorTabHandle
  readonly #toolbar: SpindlePresetEditorToolbarItemHandle
  readonly #scope: DomScope
  readonly #styles: ScopedStylesheet
  readonly #toolbarStyles: ScopedStylesheet
  readonly #navigationPanel: HTMLElement
  readonly #workspacePanel: HTMLElement
  readonly #inspectorPanel: HTMLElement
  readonly #state: ApcFrontendStore
  readonly #loom: ThreadEditorLoomBridge
  #finalResponseAvailable: boolean
  readonly #boundConnectionKeys = new Map<string, string>()
  #boundConnectionKeysPresetId: string | null = null
  #threadContextAuthorityGeneration = 0
  #threadConsentAuthorityGeneration = 0
  #modeTransitionGeneration = 0
  #modeTransitionOperation: ModeTransitionOperation | null = null
  #modeSurfaceGeneration = 0
  #modeSurfaceProjection: ModeSurfaceProjection | null = null
  #graphNavigation: GraphEditorHandle | null = null
  #graphTopology: GraphEditorHandle | null = null
  #threadConfiguration: ThreadEditorController | null = null
  #threadWorkspace: ThreadEditorController | null = null
  #inspector: ExecutionInspectorController | null = null
  #presetId: string | null = null
  #workspaceThreadId: string | null = null
  #dismissedTerminalExecutionKey: string | null = null
  #focusConfigurationAfterInspector = false
  #consentReviewOpen = false
  #consentReviewSelectionKey: string | null = null
  #unsubscribeState: (() => void) | null = null
  #unsubscribeLocale: (() => void) | null = null
  #unsubscribeEvents: Array<() => void> = []
  #disposed = false
  #teardownPromise: Promise<void> | null = null

  private constructor(
    ctx: SpindleFrontendContext,
    host: SpindleHostDescriptorV1,
    document: Document,
    activity: ApcActivityGate,
    onDisarmed: () => void,
    t: ApcTranslate,
    tab: SpindlePresetEditorTabHandle,
    toolbar: SpindlePresetEditorToolbarItemHandle,
    scope: DomScope,
    styles: ScopedStylesheet,
    toolbarStyles: ScopedStylesheet,
    state: ApcFrontendStore,
    finalResponseAvailable: boolean,
  ) {
    this.#activity = activity
    this.#onDisarmed = onDisarmed
    this.#ctx = ctx
    this.#host = host
    this.#document = document
    this.#t = t
    this.#tab = tab
    this.#toolbar = toolbar
    this.#scope = scope
    this.#styles = styles
    this.#state = state
    this.#loom = {
      mountLoomBlockEditor: (target, loomOptions) => {
        if (!this.#activity.active || this.#disposed) {
          throw new Error("APC frontend authority was lost before Loom mount")
        }
        const handle = ctx.components.mountLoomBlockEditor(target, loomOptions)
        try {
          validateLoomHandle(handle)
        } catch (error) {
          disposeMalformedLoomHandle(handle, target)
          throw error
        }
        if (!this.#activity.active || this.#disposed) {
          disposeMalformedLoomHandle(handle, target)
          throw new Error("APC frontend authority was lost during Loom mount")
        }
        return handle
      },
    }
    this.#toolbarStyles = toolbarStyles
    this.#finalResponseAvailable = finalResponseAvailable
    this.#navigationPanel = scope.createElement("div", {
      "data-apc-panel": "threads",
      "data-apc-pane": "navigation",
      role: "region",
      "aria-label": t("graph.threadNavigation"),
    })
    this.#workspacePanel = scope.createElement("div", {
      "data-apc-panel": "graph",
      "data-apc-pane": "workspace",
      role: "region",
      "aria-label": t("graph.stages"),
    })
    this.#inspectorPanel = scope.createElement("div", {
      "data-apc-panel": "inspector",
      "data-apc-pane": "configuration",
      role: "region",
      "aria-label": t("threadEditor.ariaLabel"),
    })
    toolbar.root.replaceChildren()
    toolbar.root.setAttribute("data-apc-toolbar", "true")
    toolbar.root.setAttribute("aria-label", t("agentGraph.title"))
    scope.append(this.#navigationPanel)
    scope.append(this.#workspacePanel)
    scope.append(this.#inspectorPanel)
    tab.root.append(scope.element)
  }

  static async create(
    ctx: SpindleFrontendContext,
    options: ApcAppOptions = {},
    onDisarmed: () => void = () => {},
  ): Promise<ApcAppImpl> {
    const host = validateSpindleHostDescriptor(ctx.host)
    validateHostSurface(ctx)
    ctx.deferReady()
    let tab: SpindlePresetEditorTabHandle | null = null
    let toolbar: SpindlePresetEditorToolbarItemHandle | null = null
    let scope: DomScope | null = null
    let styles: ScopedStylesheet | null = null
    let toolbarStyles: ScopedStylesheet | null = null
    let persistence: ApcPersistence | null = null
    let state: ApcFrontendStore | null = null
    let pendingFinalResponseGranted: boolean | undefined
    let app: ApcAppImpl | null = null
    let readyCalled = false
    const activity: ApcActivityGate = { active: true }
    const setupUnsubscribeEvents: Array<() => void> = []
    const removeSetupEventListeners = (): void => {
      for (const unsubscribe of setupUnsubscribeEvents.splice(0)) {
        try {
          unsubscribe()
        } catch {
          // A failed host unsubscriber must not preserve any other setup listener.
        }
      }
    }
    const cancelSetup = (): void => {
      if (!activity.active) return
      activity.active = false
      if (app !== null) void app.teardown().catch(() => {})
      else removeSetupEventListeners()
    }
    try {
      if (typeof ctx.events?.on === "function") {
        setupUnsubscribeEvents.push(ctx.events.on("PERMISSION_CHANGED", (payload) => {
          if (isPermissionRevoked(ctx, payload)) {
            cancelSetup()
            return
          }
          const finalResponseGranted = finalResponsePermissionChange(payload)
          if (app === null && finalResponseGranted !== undefined) {
            pendingFinalResponseGranted = finalResponseGranted
          } else {
            app?.permissionChanged(payload)
          }
        }))
        for (const event of ["EXTENSION_DISABLED", "EXTENSION_UPDATED", "EXTENSION_UPDATE", "EXTENSION_UNLOADED"]) {
          setupUnsubscribeEvents.push(ctx.events.on(event, cancelSetup))
        }
      }
      const granted = await ctx.permissions.getGranted()
      if (!activity.active) throw new Error("APC frontend setup was cancelled before mount")
      const missing = missingPermissions(ctx, granted)
      if (missing.length > 0) {
        throw new ApcFrontendSetupError(
          "PERMISSION_DENIED",
          `APC frontend permissions are not granted: ${missing.join(", ")}`,
          missing,
        )
      }
      const editor = ctx.ui.presetEditor.extension
      const t = createApcTranslator(() => ctx.locale.get())
      const registeredTab = ctx.ui.registerPresetEditorTab({ id: GRAPH_EDITOR_TAB_ID, title: t("agentGraph.title") })
      tab = registeredTab
      validateTabHandle(registeredTab)
      if (!activity.active) throw new Error("APC frontend setup was cancelled while registering its tab")
      const document = options.document ?? registeredTab.root.ownerDocument ?? globalThis.document
      if (!document) throw new SpindleCompatibilityError("An owner document is required to mount APC")
      const registeredToolbar = ctx.ui.registerPresetEditorToolbarItem({ id: GRAPH_EDITOR_TOOLBAR_ITEM_ID, ariaLabel: t("agentGraph.title") })
      toolbar = registeredToolbar
      validateToolbarHandle(registeredToolbar)
      if (!activity.active) throw new Error("APC frontend setup was cancelled while registering its toolbar")
      const toolbarStylesheet = installScopedStyles(APC_TOOLBAR_STYLE, {
        root: registeredToolbar.root,
        document,
        id: "apc-toolbar",
        reducedMotionCss: APC_EDITOR_REDUCED_MOTION_STYLE,
      })
      toolbarStyles = toolbarStylesheet
      const appScope = createDomScope({
        parent: registeredTab.root,
        tag: "section",
        className: "apc-app",
        attributes: { "data-apc-app": "true", "aria-label": t("agentGraph.title") },
        ownerDocument: document,
      })
      scope = appScope
      const appStyles = installScopedStyles(APC_EDITOR_STYLE, {
        root: appScope.element,
        document,
        id: "apc-app",
        reducedMotionCss: APC_EDITOR_REDUCED_MOTION_STYLE,
      })
      styles = appStyles
      const appPersistence = createApcPersistence({
        editor: createEditorAdapter(editor, activity),
        transport: createDomainTransport(ctx, activity, (raw) => persistence?.handleInvalidMessage(raw)),
      })
      persistence = appPersistence
      const appState = createApcFrontendState({ persistence: appPersistence })
      state = appState
      const createdApp = new ApcAppImpl(
        ctx,
        host,
        document,
        activity,
        onDisarmed,
        t,
        registeredTab,
        registeredToolbar,
        appScope,
        appStyles,
        toolbarStylesheet,
        appState,
        threadFinalAvailable(
          host,
          pendingFinalResponseGranted === undefined
            ? granted
            : pendingFinalResponseGranted
              ? ["final_response"]
              : [],
        ),
      )
      app = createdApp
      if (!activity.active) throw new Error("APC frontend setup was cancelled while constructing the app")
      createdApp.#unsubscribeEvents.push(...setupUnsubscribeEvents.splice(0))
      createdApp.mount()
      if (!activity.active) throw new Error("APC frontend setup was cancelled during mount")
      const localeUnsubscribe = ctx.locale.subscribe(() => createdApp.localeChanged())
      if (!activity.active || createdApp.#disposed) {
        try {
          localeUnsubscribe()
        } catch {
          // Preserve the lifecycle failure while still releasing the late subscription.
        }
        throw new Error("APC frontend setup was cancelled during locale subscription")
      }
      createdApp.subscribeLocale(localeUnsubscribe)
      const initial = editor.getState()
      if (!activity.active || createdApp.#disposed) {
        throw new Error("APC frontend setup was cancelled while reading the initial preset")
      }
      if (initial.presetId !== null) {
        try {
          await appState.hydrate(initial.presetId)
        } catch {
          // Invalid metadata is rendered as a state-owned blocked surface.
        }
      }
      if (!activity.active) throw new Error("APC frontend setup was cancelled before readiness")
      createdApp.render(appState.getSnapshot())
      if (!activity.active) throw new Error("APC frontend setup was cancelled while rendering")
      readyCalled = true
      ctx.ready()
      if (!activity.active) throw new Error("APC frontend setup was cancelled during readiness")
      return createdApp
    } catch (error) {
      activity.active = false
      removeSetupEventListeners()
      if (app !== null) app.disarm()
      else {
        const cleanups = [
          () => state?.dispose(),
          () => persistence?.dispose(),
          () => styles?.remove(),
          () => scope?.cleanup(),
          () => toolbarStyles?.remove(),
          () => destroyPartialRegistration(toolbar),
          () => destroyPartialRegistration(tab),
        ]
        for (const cleanup of cleanups) {
          try {
            cleanup()
          } catch {
            // Preserve the setup failure while still attempting every cleanup.
          }
        }
      }
      if (!readyCalled) {
        try {
          ctx.ready()
        } catch {
          // The host may already have failed the startup gate.
        }
      }
      throw error
    }
  }

  get root(): HTMLElement {
    return this.#scope.element
  }

  get toolbarRoot(): HTMLElement {
    return this.#toolbar.root
  }

  get state(): ApcFrontendStore {
    return this.#state
  }

  private beginModeTransition(mode: ApcMode): ModeTransitionOperation {
    const generation = this.#modeTransitionGeneration >= Number.MAX_SAFE_INTEGER
      ? 0
      : this.#modeTransitionGeneration + 1
    const operation = { generation, mode, presetId: this.#state.getSnapshot().presetId }
    this.#modeTransitionGeneration = generation
    this.#modeTransitionOperation = operation
    return operation
  }

  private isModeTransitionCurrent(operation: ModeTransitionOperation): boolean {
    const snapshot = this.#state.getSnapshot()
    return !this.#disposed &&
      this.#activity.active &&
      snapshot.hydrated &&
      snapshot.presetId === operation.presetId &&
      this.#modeTransitionGeneration === operation.generation &&
      this.#modeTransitionOperation === operation
  }

  private activateCurrentModeSurface(): ApcFrontendSnapshot {
    const snapshot = this.#state.getSnapshot()
    if (snapshot.hydrated && snapshot.presetId !== null && !snapshot.dirty) {
      this.queueModeSurface(snapshot)
    }
    return snapshot
  }


  private queueModeSurface(snapshot: ApcFrontendSnapshot): void {
    if (
      !snapshot.hydrated ||
      snapshot.presetId === null ||
      snapshot.activeMode === undefined ||
      snapshot.dirty
    ) {
      this.#modeSurfaceGeneration = this.#modeSurfaceGeneration >= Number.MAX_SAFE_INTEGER
        ? 0
        : this.#modeSurfaceGeneration + 1
      this.#modeSurfaceProjection = null
      return
    }
    const desired: ModeSurfaceProjection = { presetId: snapshot.presetId, mode: snapshot.activeMode }
    const active = this.#modeSurfaceActivation
    if (active?.presetId === desired.presetId && active.mode === desired.mode) {
      this.#modeSurfaceProjection = desired
      return
    }
    const projected = this.#modeSurfaceProjection
    if (projected?.presetId === desired.presetId && projected.mode === desired.mode) return
    const generation = this.#modeSurfaceGeneration >= Number.MAX_SAFE_INTEGER
      ? 0
      : this.#modeSurfaceGeneration + 1
    this.#modeSurfaceGeneration = generation
    this.#modeSurfaceProjection = desired
    queueMicrotask(() => {
      if (this.#disposed || !this.#activity.active || generation !== this.#modeSurfaceGeneration) return
      const current = this.#state.getSnapshot()
      if (
        !current.hydrated ||
        current.presetId !== desired.presetId ||
        current.activeMode !== desired.mode ||
        current.dirty
      ) return
      const currentActivation = this.#modeSurfaceActivation
      if (currentActivation?.presetId === desired.presetId && currentActivation.mode === desired.mode) return
      this.#modeSurfaceActivation = desired
      this.#modeSurfaceProjection = desired
      this.activateModeSurface(desired.mode)
    })
  }

  private releaseModeToolbarSaveLock(snapshot: ApcFrontendSnapshot): void {
    if (
      !snapshot.busy ||
      snapshot.busyReason !== "save" ||
      snapshot.stale ||
      snapshot.blockedReasons.length > 0
    ) return
    for (const control of this.#toolbar.root.querySelectorAll<HTMLButtonElement>('[data-action="select-mode"]')) {
      const mode = control.dataset.mode
      if (mode !== "single" && mode !== "sequential" && mode !== "parallel") continue
      const availability = snapshot.modeAvailability[mode]
      if (!availability.supported || !availability.valid) continue
      control.disabled = false
      control.removeAttribute("aria-disabled")
    }
  }

  private captureInspectorContinuation(): InspectorContinuationToken | null {
    const snapshot = this.#state.getSnapshot()
    const executionKey = snapshot.execution.executionKey
    if (
      this.#disposed ||
      !this.#activity.active ||
      this.#inspector === null ||
      snapshot.presetId === null ||
      executionKey === null
    ) return null
    return { inspector: this.#inspector, presetId: snapshot.presetId, executionKey }
  }

  private isInspectorContinuationActive(token: InspectorContinuationToken): boolean {
    return !this.#disposed &&
      this.#activity.active &&
      this.#inspector === token.inspector &&
      this.#state.getSnapshot().presetId === token.presetId &&
      this.#state.getSnapshot().execution.executionKey === token.executionKey
  }

  private activateModeSurface(mode: string | undefined): void {
    if (this.#disposed || !this.#activity.active) return
    this.#toolbar.setVisible(true)
    if (this.#disposed || !this.#activity.active) return
    if (mode === "single") {
      this.#ctx.ui.presetEditor.extension.activateBuiltinTab("blocks")
    } else if (mode === "sequential" || mode === "parallel") {
      this.#tab.activate()
    }
  }

  private captureThreadContinuation(thread: ThreadEditorController | null): ThreadContinuationToken | null {
    const snapshot = this.#state.getSnapshot()
    const threadId = selectionThreadId(snapshot)
    if (
      this.#disposed ||
      !this.#activity.active ||
      thread === null ||
      this.#presetId === null ||
      threadId === null ||
      snapshot.presetId !== this.#presetId ||
      (this.#threadConfiguration !== thread && this.#threadWorkspace !== thread)
    ) return null
    return {
      thread,
      presetId: this.#presetId,
      threadId,
      contextAuthorityGeneration: this.#threadContextAuthorityGeneration,
      consentAuthorityGeneration: this.#threadConsentAuthorityGeneration,
    }
  }

  private beginThreadContextMutation(
    thread: ThreadEditorController | null,
    expectedThreadId?: string,
  ): ThreadContinuationToken | null {
    const token = this.captureThreadContinuation(thread)
    if (token === null || (expectedThreadId !== undefined && token.threadId !== expectedThreadId)) return null
    this.#threadContextAuthorityGeneration += 1
    return {
      ...token,
      contextAuthorityGeneration: this.#threadContextAuthorityGeneration,
    }
  }

  private isThreadContinuationActive(token: ThreadContinuationToken): boolean {
    return !this.#disposed &&
      this.#activity.active &&
      (this.#threadConfiguration === token.thread || this.#threadWorkspace === token.thread) &&
      this.#presetId === token.presetId &&
      this.#threadContextAuthorityGeneration === token.contextAuthorityGeneration &&
      this.#threadConsentAuthorityGeneration === token.consentAuthorityGeneration &&
      this.#state.getSnapshot().presetId === token.presetId &&
      selectionThreadId(this.#state.getSnapshot()) === token.threadId
  }

  private async resolveSelectedConsent(
    force = false,
    token?: ThreadContinuationToken,
  ): Promise<void> {
    if (this.#disposed || !this.#activity.active || (token !== undefined && !this.isThreadContinuationActive(token))) return
    const snapshot = this.#state.getSnapshot()
    const config = snapshot.config
    const presetId = snapshot.presetId
    const threadId = selectionThreadId(snapshot)
    if (config === null || presetId === null || threadId === null) return
    const thread = config.threads.find((candidate) => candidate.id === threadId)
    if (thread === undefined) return
    const connectionSourceKey: "main" | `slot:${string}` =
      config.activeMode === "sequential" || thread.connectionSlotId === undefined
        ? "main"
        : `slot:${thread.connectionSlotId}`
    const existing = matchingConsent(
      snapshot,
      presetId,
      thread.id,
      thread.workspaceSource,
      connectionSourceKey,
    )
    if (!force && existing?.destination !== undefined && existing.disclosure !== undefined) return
    try {
      await this.#state.resolveConsent({
        presetId,
        threadId: thread.id,
        workspaceSource: thread.workspaceSource,
        connectionSourceKey,
      })
    } catch (error) {
      if (force && (token === undefined || this.isThreadContinuationActive(token))) throw error
      // The review remains unavailable until safe consent details can be resolved.
    }
  }

  private advanceThreadContextAuthority(token: ThreadContinuationToken): void {
    if (!this.isThreadContinuationActive(token)) return
    this.#threadContextAuthorityGeneration += 1
    this.renderThread(this.#state.getSnapshot())
  }

  private advanceThreadConsentAuthority(token: ThreadContinuationToken): void {
    if (!this.isThreadContinuationActive(token)) return
    this.#threadConsentAuthorityGeneration += 1
    this.renderThread(this.#state.getSnapshot())
  }

  private openLoomWorkspace(threadId: string): void {
    const snapshot = this.#state.getSnapshot()
    const thread = snapshot.config?.threads.find((candidate) => candidate.id === threadId)
    if (
      this.#disposed ||
      this.#consentReviewOpen ||
      thread?.workspaceSource !== "native-blocks"
    ) return
    this.#workspaceThreadId = threadId
    this.#state.setSelection({ kind: "thread", threadId })
  }

  private closeLoomWorkspace(): void {
    if (this.#workspaceThreadId === null) return
    this.#workspaceThreadId = null
    this.render(this.#state.getSnapshot())
  }

  mount(): void {
    let tabActivationUnsubscribe: (() => void) | null = null
    let liveRegion: LiveRegion | null = null
    let localNavigation: GraphEditorHandle | null = null
    let localTopology: GraphEditorHandle | null = null
    let localStateUnsubscribe: (() => void) | null = null
    try {
      this.#toolbar.setVisible(true)
      if (this.#disposed || !this.#activity.active) {
        throw new Error("APC frontend setup was cancelled during toolbar visibility")
      }
      tabActivationUnsubscribe = this.#tab.onActivate(() => {
        if (this.#disposed || !this.#activity.active) return
        this.#toolbar.setVisible(true)
      })
      if (this.#disposed || !this.#activity.active) {
        tabActivationUnsubscribe?.()
        tabActivationUnsubscribe = null
        throw new Error("APC frontend setup was cancelled during tab activation registration")
      }
      this.#unsubscribeEvents.push(tabActivationUnsubscribe)
      tabActivationUnsubscribe = null
    const interceptModeClick = (event: Event): void => {
      const elementConstructor = this.#document.defaultView?.Element
      const target = event.target
      if (elementConstructor === undefined || !(target instanceof elementConstructor)) return
      const control = target.closest<HTMLElement>('[data-action="select-mode"]')
      if (this.#consentReviewOpen) return
      if (control === null || !this.#toolbar.root.contains(control)) return
      if (
        (control.hasAttribute("disabled") || control.getAttribute("aria-disabled") === "true") &&
        !this.#state.getSnapshot().busy
      ) return
      const mode = control.dataset.mode
      if (mode !== "single" && mode !== "sequential" && mode !== "parallel") return
      const snapshot = this.#state.getSnapshot()
      const availability = snapshot.modeAvailability[mode]
      if (
        snapshot.config === null ||
        snapshot.stale ||
        snapshot.blockedReasons.length > 0 ||
        (snapshot.busy && snapshot.busyReason !== "save") ||
        !availability.supported ||
        !availability.valid
      ) return
      event.preventDefault()
      event.stopImmediatePropagation()
      this.configChanged(snapshot.config, mode)
      this.#toolbar.root.querySelector<HTMLElement>(
        `[data-action="select-mode"][data-mode="${mode}"]`,
      )?.focus()
    }
    const interceptModeKey = (event: Event): void => {
      const keyboard = event as KeyboardEvent
      const elementConstructor = this.#document.defaultView?.Element
      const target = event.target
      if (elementConstructor === undefined || !(target instanceof elementConstructor)) return
      const control = target.closest<HTMLElement>('[data-action="select-mode"]')
      if (this.#consentReviewOpen || control === null || !this.#toolbar.root.contains(control)) return
      const snapshot = this.#state.getSnapshot()
      if (
        !snapshot.busy ||
        snapshot.busyReason !== "save" ||
        snapshot.config === null ||
        snapshot.stale ||
        snapshot.blockedReasons.length > 0
      ) return
      const mode = control.dataset.mode
      if (mode !== "single" && mode !== "sequential" && mode !== "parallel") return
      let nextMode: ApcMode | null = mode
      if (keyboard.key === "ArrowRight" || keyboard.key === "ArrowDown" ||
        keyboard.key === "ArrowLeft" || keyboard.key === "ArrowUp") {
        const direction = keyboard.key === "ArrowRight" || keyboard.key === "ArrowDown" ? 1 : -1
        const modes: readonly ApcMode[] = ["single", "sequential", "parallel"]
        const index = modes.indexOf(mode)
        nextMode = null
        for (let offset = 1; offset <= modes.length; offset += 1) {
          const candidate = modes[(index + direction * offset + modes.length * 2) % modes.length]
          const availability = snapshot.modeAvailability[candidate]
          if (availability.supported && availability.valid) {
            nextMode = candidate
            break
          }
        }
      } else if (keyboard.key !== " " && keyboard.key !== "Enter") {
        return
      }
      const availability = nextMode === null ? undefined : snapshot.modeAvailability[nextMode]
      if (
        nextMode === null ||
        availability === undefined ||
        !availability.supported ||
        !availability.valid
      ) return
      event.preventDefault()
      event.stopImmediatePropagation()
      this.configChanged(snapshot.config, nextMode)
      this.#toolbar.root.querySelector<HTMLElement>(
        `[data-action="select-mode"][data-mode="${nextMode}"]`,
      )?.focus()
    }
    this.#toolbar.root.addEventListener("keydown", interceptModeKey, true)
    this.#unsubscribeEvents.push(() => this.#toolbar.root.removeEventListener("keydown", interceptModeKey, true))
    this.#toolbar.root.addEventListener("click", interceptModeClick, true)
    this.#unsubscribeEvents.push(() => this.#toolbar.root.removeEventListener("click", interceptModeClick, true))

    liveRegion = createLiveRegion(this.#navigationPanel, { label: this.#t("graph.editorAria") })
    if (this.#disposed || !this.#activity.active) {
      throw new Error("APC frontend setup was cancelled while creating accessibility resources")
    }
    const graphView = (): GraphEditorSnapshot => graphSnapshot(
      this.#state.getSnapshot(),
      this.#finalResponseAvailable,
      this.#ctx.locale.get(),
      this.#consentReviewOpen,
    )
    const graphState = {
      getSnapshot: graphView,
      subscribe: (listener: (snapshot: GraphEditorSnapshot) => void) => this.#state.subscribe((snapshot) => listener(
        graphSnapshot(snapshot, this.#finalResponseAvailable, this.#ctx.locale.get(), this.#consentReviewOpen),
      )),
    }
    const graphCallbacks = {
      onConfigChange: (config: ApcPresetConfigV1, mutation: GraphEditorMutation) => this.configChanged(
        config,
        mutation.type === "mode" ? mutation.mode : undefined,
      ),
      onAddConnectionSlot: (slot: ApcPresetConfigV1["connectionSlots"][number]) => {
        if (this.#consentReviewOpen) return
        this.#state.updateConfig((config) => {
          if (
            config.activeMode === "single" ||
            config.connectionSlots.length >= MAX_CONNECTION_SLOTS ||
            config.connectionSlots.some((candidate) => candidate.id === slot.id)
          ) return config
          return {
            ...config,
            connectionSlots: [...config.connectionSlots, clone(slot)],
          }
        })
      },
      onRenameConnectionSlot: (slotId: string, label: string) => {
        if (this.#consentReviewOpen) return
        this.#state.updateConfig((config) => {
          if (config.activeMode === "single" || !config.connectionSlots.some((slot) => slot.id === slotId)) return config
          return {
            ...config,
            connectionSlots: config.connectionSlots.map((slot) => slot.id === slotId ? { ...slot, label } : slot),
          }
        })
      },
      onRemoveConnectionSlot: async (slotId: string) => {
        if (this.#disposed || !this.#activity.active || this.#consentReviewOpen) return
        const operationSnapshot = this.#state.getSnapshot()
        const operationPresetId = operationSnapshot.presetId
        const binding = operationSnapshot.connectionBindings[slotId]
        if (binding?.bound === true) {
          try {
            const unbound = await this.#state.unbindConnection(slotId)
            if (unbound.bound !== false) throw new Error("Connection slot remains bound")
          } catch (error) {
            this.renderGraphProjection(this.#state.getSnapshot())
            throw error
          }
        }
        if (
          this.#disposed ||
          !this.#activity.active ||
          this.#consentReviewOpen ||
          this.#state.getSnapshot().presetId !== operationPresetId
        ) return
        this.#state.updateConfig((config) => {
          if (
            config.activeMode === "single" ||
            !config.connectionSlots.some((slot) => slot.id === slotId) ||
            config.threads.some((thread) => thread.connectionSlotId === slotId)
          ) return config
          return {
            ...config,
            connectionSlots: config.connectionSlots.filter((slot) => slot.id !== slotId),
          }
        })
      },
      onSelectionChange: (selection: ApcFrontendSnapshot["selection"]) => {
        if (this.#disposed || this.#consentReviewOpen || selection === undefined) return
        const snapshot = this.#state.getSnapshot()
        if (snapshot.execution.executionKey !== null && snapshot.execution.terminal) {
          this.#dismissedTerminalExecutionKey = snapshot.execution.executionKey
        }
        this.#threadContextAuthorityGeneration += 1
        this.#threadConsentAuthorityGeneration += 1
        this.#state.setSelection(selection)
        void this.resolveSelectedConsent()
      },
    }
    localNavigation = createGraphEditor({
      t: this.#t,
      document: this.#document,
      toolbarHost: this.#toolbar.root,
      state: graphState,
      liveRegion: liveRegion ?? undefined,
      surface: "navigation",
      ...graphCallbacks,
    })
    if (this.#disposed || !this.#activity.active) {
      throw new Error("APC frontend setup was cancelled while mounting navigation")
    }
    localTopology = createGraphEditor({
      t: this.#t,
      document: this.#document,
      state: graphState,
      liveRegion: liveRegion ?? undefined,
      surface: "topology",
      ...graphCallbacks,
    })
    if (this.#disposed || !this.#activity.active) {
      throw new Error("APC frontend setup was cancelled while mounting topology")
    }
    if (localNavigation === null || localTopology === null) {
      throw new Error("APC frontend graph registration returned no handle")
    }
    const mountedNavigation = localNavigation
    const mountedTopology = localTopology
    this.#graphNavigation = mountedNavigation
    localNavigation = null
    this.#graphTopology = mountedTopology
    localTopology = null
    this.#navigationPanel.append(mountedNavigation.element)
    this.#workspacePanel.append(mountedTopology.element)
    localStateUnsubscribe = this.#state.subscribe((snapshot) => this.render(snapshot))
    if (this.#disposed || !this.#activity.active) {
      throw new Error("APC frontend setup was cancelled while subscribing to state")
    }
    this.#unsubscribeState = localStateUnsubscribe
    localStateUnsubscribe = null
    this.render(this.#state.getSnapshot())
    if (this.#disposed || !this.#activity.active) {
      throw new Error("APC frontend setup was cancelled while rendering")
    }
    } catch (error) {
      try {
        localStateUnsubscribe?.()
      } catch {
        // Preserve the lifecycle failure while still releasing every local resource.
      }
      localStateUnsubscribe = null
      try {
        localTopology?.destroy()
      } catch {
        // Preserve the lifecycle failure while still releasing every local resource.
      }
      localTopology = null
      try {
        localNavigation?.destroy()
      } catch {
        // Preserve the lifecycle failure while still releasing every local resource.
      }
      localNavigation = null
      try {
        liveRegion?.cleanup()
      } catch {
        // Preserve the lifecycle failure while still releasing every local resource.
      }
      liveRegion = null
      try {
        tabActivationUnsubscribe?.()
      } catch {
        // Preserve the lifecycle failure while still releasing every local resource.
      }
      tabActivationUnsubscribe = null
      this.disarm()
      throw error
    }
  }

  subscribeLocale(unsubscribe: () => void): void {
    if (this.#disposed || !this.#activity.active) {
      try {
        unsubscribe()
      } catch {
        // Preserve the lifecycle failure while still releasing the late subscription.
      }
      return
    }
    this.#unsubscribeLocale = unsubscribe
  }

  localeChanged(): void {
    if (this.#disposed || !this.#activity.active) return
    const title = this.#t("agentGraph.title")
    this.#tab.setTitle(title)
    if (this.#disposed || !this.#activity.active) return
    this.#toolbar.root.setAttribute("aria-label", title)
    this.#scope.element.setAttribute("aria-label", title)
    const snapshot = this.#state.getSnapshot()
    const graphView = graphSnapshot(
      snapshot,
      this.#finalResponseAvailable,
      this.#ctx.locale.get(),
      this.#consentReviewOpen,
    )
    if (this.#disposed || !this.#activity.active) return
    this.#graphNavigation?.render(graphView)
    this.#graphTopology?.render(graphView)
    this.render(snapshot)
  }
  permissionChanged(payload: unknown): void {
    if (this.#disposed || !this.#activity.active) return
    const granted = finalResponsePermissionChange(payload)
    if (granted === undefined) return
    const available = granted && (this.#host.capabilities["interceptor-final-response-v1"] ?? 0) >= 1
    if (available === this.#finalResponseAvailable) return
    this.#finalResponseAvailable = available
    const snapshot = this.#state.getSnapshot()
    const graphView = graphSnapshot(snapshot, available, this.#ctx.locale.get(), this.#consentReviewOpen)
    if (this.#disposed || !this.#activity.active) return
    this.#graphNavigation?.render(graphView)
    this.#graphTopology?.render(graphView)
    this.render(snapshot)
  }

  configChanged(config: ApcPresetConfigV1, mode: ApcMode | undefined): void {
    if (this.#disposed || !this.#activity.active || this.#consentReviewOpen || !this.#state.getSnapshot().hydrated) return
    try {
      if (mode !== undefined) {
        const operation = this.beginModeTransition(mode)
        const snapshot = this.#state.getSnapshot()
        if (snapshot.activeMode === mode && !snapshot.dirty) {
          this.activateCurrentModeSurface()
          return
        }
        void this.#state.setActiveMode(mode).then((saved) => {
          if (!this.isModeTransitionCurrent(operation)) return
          const snapshot = this.#state.getSnapshot()
          if (!saved) {
            this.queueModeSurface(snapshot)
            this.#toolbar.root.querySelector<HTMLElement>(
              `[data-action="select-mode"][data-mode="${operation.mode}"]`,
            )?.focus()
            return
          }
          if (
            saved &&
            snapshot.hydrated &&
            snapshot.presetId !== null &&
            snapshot.activeMode === operation.mode
          ) {
            void this.resolveSelectedConsent()
          }
        }).catch(() => {
          if (!this.isModeTransitionCurrent(operation)) return
          this.queueModeSurface(this.#state.getSnapshot())
          const control = this.#toolbar.root.querySelector<HTMLElement>(
            `[data-action="select-mode"][data-mode="${operation.mode}"]`,
          )
          control?.focus()
        })
        return
      }
      this.#state.updateConfig(() => clone(config))
    } catch {
      // Graph controls are observational while the host is changing presets.
    }
  }
  render(snapshot: ApcFrontendSnapshot): void {
    if (this.#disposed || !this.#activity.active) return
    if (
      snapshot.execution.executionKey === null ||
      !snapshot.execution.terminal
    ) this.#dismissedTerminalExecutionKey = null
    this.queueModeSurface(snapshot)
    this.releaseModeToolbarSaveLock(snapshot)
    this.renderThread(snapshot)
    this.renderInspector(snapshot)
    this.updatePaneLandmarks(snapshot)
  }

  private executionInspectorVisible(snapshot: ApcFrontendSnapshot): boolean {
    const execution = snapshot.execution
    return execution.executionKey !== null &&
      !(
        execution.terminal &&
        (
          this.#dismissedTerminalExecutionKey === execution.executionKey ||
          !execution.topologyApplicable
        )
      )
  }

  private renderGraphProjection(snapshot: ApcFrontendSnapshot): void {
    if (this.#disposed || !this.#activity.active) return
    const view = graphSnapshot(
      snapshot,
      this.#finalResponseAvailable,
      this.#ctx.locale.get(),
      this.#consentReviewOpen,
    )
    this.#graphNavigation?.render(view)
    this.#graphTopology?.render(view)
  }

  private applyConsentReviewLock(): void {
    const locked = this.#consentReviewOpen
    const ownedToolbar = this.#toolbar.root.querySelector<HTMLElement>("[data-apc-graph-toolbar-owned=true]")
    const reviewOwner = locked
      ? [this.#workspacePanel, this.#inspectorPanel].find((surface) =>
          surface.querySelector("[data-apc-consent-review=true]") !== null
        ) ?? null
      : null
    for (const surface of [this.#navigationPanel, this.#workspacePanel, this.#inspectorPanel, ownedToolbar]) {
      if (surface === null) continue
      const surfaceLocked = locked && surface !== reviewOwner
      surface.toggleAttribute("inert", surfaceLocked)
      if (surfaceLocked) surface.setAttribute("aria-hidden", "true")
      else surface.removeAttribute("aria-hidden")
    }
  }

  private consentReviewSelectionKey(snapshot: ApcFrontendSnapshot): string | null {
    const selection = snapshot.selection
    if (selection === null) return null
    switch (selection.kind) {
      case "thread": return `thread:${selection.threadId}`
      case "run": return `run:${selection.runId}`
      case "stage": return `stage:${selection.stageId}`
      case "main": return "main"
    }
  }

  private setConsentReviewOpen(open: boolean): void {
    if (this.#disposed || this.#consentReviewOpen === open) return
    const snapshot = this.#state.getSnapshot()
    this.#consentReviewOpen = open
    this.#consentReviewSelectionKey = open ? this.consentReviewSelectionKey(snapshot) : null
    this.applyConsentReviewLock()
    this.renderGraphProjection(snapshot)
    this.renderThread(snapshot)
    this.updatePaneLandmarks(snapshot)
  }

  private updatePaneLandmarks(snapshot: ApcFrontendSnapshot): void {
    const centerSurface = this.#threadWorkspace === null ? "topology" : "loom"
    const rightSurface = this.executionInspectorVisible(snapshot) ? "execution" : "configuration"
    const workspaceThread = snapshot.config?.threads.find((thread) => thread.id === this.#workspaceThreadId)
    const centerLabel = centerSurface === "loom" && workspaceThread !== undefined
      ? this.#t("threadEditor.workspaceAria", { name: workspaceThread.name })
      : this.#t("graph.stages")
    this.#navigationPanel.setAttribute("aria-label", this.#t("graph.threadNavigation"))
    this.#workspacePanel.setAttribute("aria-label", centerLabel)
    this.#inspectorPanel.setAttribute(
      "aria-label",
      this.#t(rightSurface === "execution" ? "inspector.title" : "threadEditor.ariaLabel"),
    )
    this.#workspacePanel.dataset.apcCenterSurface = centerSurface
    this.#inspectorPanel.dataset.apcRightSurface = rightSurface
    this.applyConsentReviewLock()
  }

  private destroyThreadSurfaces(): void {
    const configuration = this.#threadConfiguration
    this.#threadConfiguration = null
    configuration?.destroy()
    const workspace = this.#threadWorkspace
    this.#threadWorkspace = null
    workspace?.destroy()
    this.#presetId = null
  }

  private createThreadSurface(view: ThreadEditorSnapshot, surface: ThreadEditorSurface): ThreadEditorController {
    let editor: ThreadEditorController | null = null
    editor = createThreadEditor({
      host: this.#host,
      presetId: view.presetId,
      loom: this.#loom,
      t: this.#t,
      document: this.#document,
      surface,
      onBackToGraph: () => {
        if (!this.#consentReviewOpen) this.closeLoomWorkspace()
      },
      onOpenWorkspace: (threadId) => {
        if (!this.#consentReviewOpen) this.openLoomWorkspace(threadId)
      },
      onConsentReviewChange: (open) => {
        this.setConsentReviewOpen(open)
        return undefined
      },
      onRename: (threadId, change) => {
        if (this.#consentReviewOpen) return
        this.#state.updateConfig((config) => ({
          ...config,
          threads: config.threads.map((thread) => thread.id === threadId ? { ...thread, ...change } : thread),
        }))
      },
      onWorkspaceSourceChange: async (threadId, workspaceSource) => {
        if (this.#consentReviewOpen) return
        const token = this.beginThreadContextMutation(editor, threadId)
        if (token === null) return
        this.#state.updateConfig((config) => ({
          ...config,
          threads: config.threads.map((thread) => thread.id === threadId
            ? { ...thread, workspaceSource }
            : thread),
        }))
        await this.resolveSelectedConsent(true, token)
        this.advanceThreadContextAuthority(token)
      },
      onConnectionSlotChange: async (threadId, slotId) => {
        if (this.#consentReviewOpen) return
        const token = this.beginThreadContextMutation(editor, threadId)
        if (token === null) return
        this.#state.updateConfig((config) => ({
          ...config,
          threads: config.threads.map((thread) => {
            if (thread.id !== threadId) return thread
            if (slotId !== undefined) return { ...thread, connectionSlotId: slotId }
            const { connectionSlotId: _removed, ...withoutSlot } = thread
            return withoutSlot
          }),
        }))
        await this.resolveSelectedConsent(true, token)
        this.advanceThreadContextAuthority(token)
      },
      onRunChange: (runId, change) => {
        if (this.#consentReviewOpen) return change.position === undefined ? undefined : false
        let positionChanged = false
        this.#state.updateConfig((config) => {
          const pipeline = activePipeline(config)
          if (
            change.required === false &&
            pipeline !== undefined &&
            requiredLockedRunIds(pipeline).has(runId)
          ) return config
          const changed = changeRun(config, runId, change)
          if (change.position !== undefined) positionChanged = changed !== config
          return changed
        })
        return change.position === undefined ? undefined : positionChanged
      },
      onRunBindingChange: (runId, bindingId, change) => {
        if (this.#consentReviewOpen) return
        this.#state.updateConfig((config) => changeRunBinding(config, runId, bindingId, change))
      },
      onAddRunBinding: (runId) => {
        if (this.#consentReviewOpen) return
        this.#state.updateConfig((config) => addRunBinding(config, runId))
      },
      onRemoveRunBinding: (runId, bindingId) => {
        if (this.#consentReviewOpen) return
        this.#state.updateConfig((config) => removeRunBinding(config, runId, bindingId))
      },
      onDirty: (threadId, value) => {
        if (this.#consentReviewOpen) return
        this.#state.updateConfig((config) => ({
          ...config,
          threads: config.threads.map((thread) => thread.id === threadId
            ? {
                ...thread,
                blocks: clone(value.blocks),
                promptVariableValues: clone(value.promptVariableValues),
              }
            : thread),
        }))
      },
      onFlush: async () => {
        if (this.#consentReviewOpen) return
        const token = this.captureThreadContinuation(editor)
        if (token === null) return
        try {
          await this.#state.flush()
        } catch (error) {
          if (this.isThreadContinuationActive(token)) throw error
        }
      },
      onBind: async (slotId, connectionId) => {
        if (this.#consentReviewOpen) return
        const token = this.beginThreadContextMutation(editor)
        if (token === null) return
        await this.#state.bindConnection(slotId, connectionId)
        if (!this.isThreadContinuationActive(token)) return
        this.#boundConnectionKeys.set(slotId, connectionId)
        await this.resolveSelectedConsent(true, token)
        this.advanceThreadContextAuthority(token)
      },
      onUnbind: async (slotId) => {
        if (this.#consentReviewOpen) return
        const token = this.beginThreadContextMutation(editor)
        if (token === null) return
        await this.#state.unbindConnection(slotId)
        if (!this.isThreadContinuationActive(token)) return
        this.#boundConnectionKeys.delete(slotId)
        await this.resolveSelectedConsent(true, token)
        this.advanceThreadContextAuthority(token)
      },
      onRefreshConnections: async () => {
        if (this.#consentReviewOpen) return
        const token = this.beginThreadContextMutation(editor)
        if (token === null) return
        await this.#state.refreshConnections()
        this.advanceThreadContextAuthority(token)
      },
      onResolveConsent: async (selector: ThreadEditorConsentSelector) => {
        const token = this.captureThreadContinuation(editor)
        if (token === null) return
        await this.#state.resolveConsent(consentSelector(selector))
        this.advanceThreadConsentAuthority(token)
      },
      onApproveConsent: async (selector) => {
        const token = this.captureThreadContinuation(editor)
        if (token === null) return
        await this.#state.approveConsent(consentSelector(selector))
        this.advanceThreadConsentAuthority(token)
      },
      onRevokeConsent: async (selector) => {
        const token = this.captureThreadContinuation(editor)
        if (token === null) return
        await this.#state.revokeConsent(consentSelector(selector))
        this.advanceThreadConsentAuthority(token)
      },
    })
    if (this.#disposed || !this.#activity.active) {
      editor?.destroy()
      throw new Error("APC frontend authority was lost while creating a thread surface")
    }
    return editor
  }

  renderThread(snapshot: ApcFrontendSnapshot): void {
    if (this.#disposed || !this.#activity.active) return
    if (
      this.#consentReviewOpen &&
      (
        snapshot.executionMutationLocked ||
        snapshot.presetId !== this.#presetId ||
        this.consentReviewSelectionKey(snapshot) !== this.#consentReviewSelectionKey
      )
    ) {
      this.#consentReviewOpen = false
      this.#consentReviewSelectionKey = null
      this.renderGraphProjection(snapshot)
    }
    if (snapshot.presetId !== this.#boundConnectionKeysPresetId) {
      this.#boundConnectionKeys.clear()
      this.#boundConnectionKeysPresetId = snapshot.presetId
      this.#workspaceThreadId = null
    }
    const view = threadSnapshot(
      snapshot,
      this.#host,
      this.#boundConnectionKeys,
      this.#threadContextAuthorityGeneration,
      this.#threadConsentAuthorityGeneration,
      this.#consentReviewOpen,
    )
    const selectedThread = view?.threads.find((thread) => thread.id === view.selectedThreadId)
    if (
      snapshot.executionMutationLocked ||
      selectedThread?.id !== this.#workspaceThreadId ||
      selectedThread?.workspaceSource !== "native-blocks"
    ) {
      this.#workspaceThreadId = null
    }
    if (view === null) {
      this.destroyThreadSurfaces()
      if (this.#graphTopology !== null) this.#workspacePanel.replaceChildren(this.#graphTopology.element)
      return
    }
    if (this.#presetId !== view.presetId) {
      this.destroyThreadSurfaces()
      try {
        const configuration = this.createThreadSurface(view, "configuration")
        if (this.#disposed || !this.#activity.active) {
          configuration.destroy()
          return
        }
        this.#threadConfiguration = configuration
        this.#presetId = view.presetId
      } catch (error) {
        if (this.#disposed || !this.#activity.active) return
        throw error
      }
    } else if (this.#threadConfiguration === null) {
      try {
        const configuration = this.createThreadSurface(view, "configuration")
        if (this.#disposed || !this.#activity.active) {
          configuration.destroy()
          return
        }
        this.#threadConfiguration = configuration
      } catch (error) {
        if (this.#disposed || !this.#activity.active) return
        throw error
      }
    }
    const configuration = this.#threadConfiguration
    if (configuration === null) return
    configuration.render(view)
    if (this.#disposed || !this.#activity.active) return
    if (this.#workspaceThreadId === null) {
      const workspace = this.#threadWorkspace
      this.#threadWorkspace = null
      workspace?.destroy()
      if (this.#graphTopology !== null) this.#workspacePanel.replaceChildren(this.#graphTopology.element)
      return
    }
    if (this.#threadWorkspace === null) {
      try {
        const workspace = this.createThreadSurface(view, "workspace")
        if (this.#disposed || !this.#activity.active) {
          workspace.destroy()
          return
        }
        this.#threadWorkspace = workspace
      } catch (error) {
        if (this.#disposed || !this.#activity.active) return
        throw error
      }
    }
    const workspace = this.#threadWorkspace
    if (workspace === null) return
    this.#workspacePanel.replaceChildren(workspace.element)
    try {
      workspace.render(view)
      if (this.#disposed || !this.#activity.active) return
    } catch {
      this.#threadWorkspace = null
      this.#workspaceThreadId = null
      workspace.destroy()
      if (this.#graphTopology !== null && !this.#disposed) this.#workspacePanel.replaceChildren(this.#graphTopology.element)
    }
  }
  renderInspector(snapshot: ApcFrontendSnapshot): void {
    if (this.#disposed || !this.#activity.active) return
    if (!this.executionInspectorVisible(snapshot)) {
      const inspector = this.#inspector
      this.#inspector = null
      inspector?.destroy()
      this.#inspectorPanel.replaceChildren(
        this.#threadConfiguration?.element ?? this.placeholder(this.#t("validation.configNotHydrated")),
      )
      if (this.#focusConfigurationAfterInspector) {
        this.#focusConfigurationAfterInspector = false
        focusElement(
          this.#inspectorPanel.querySelector<HTMLElement>("[data-apc-thread-workspace-heading]") ??
            this.#inspectorPanel.querySelector<HTMLElement>("[data-apc-thread-name]"),
        )
      }
      return
    }
    const view = inspectorStatus(snapshot, this.#t)
    if (this.#inspector === null) {
      const inspectorOptions = {
        t: this.#t,
        document: this.#document,
        snapshot: view,
        locale: () => this.#ctx.locale.get(),
        onLoadTraces: async () => {
          const token = this.captureInspectorContinuation()
          if (token === null) return
          await this.#state.loadTraces({ executionKey: token.executionKey })
          if (this.isInspectorContinuationActive(token)) this.renderInspector(this.#state.getSnapshot())
        },
        onLoadTrace: async (key: string) => {
          const token = this.captureInspectorContinuation()
          if (token === null) return
          await this.#state.loadTrace(key, { executionKey: token.executionKey })
          if (this.isInspectorContinuationActive(token)) this.renderInspector(this.#state.getSnapshot())
        },
        onStop: () => {
          const executionKey = this.#state.getSnapshot().execution.executionKey
          if (executionKey !== null) return this.#state.cancelExecution(executionKey, "stop")
        },
        onUseMainFallback: () => {
          this.#focusConfigurationAfterInspector = true
          try {
            this.#state.updateConfig(routeActivePipelineToMain)
          } catch (error) {
            this.#focusConfigurationAfterInspector = false
            throw error
          }
        },
        onBackToConfiguration: () => {
          const current = this.#state.getSnapshot()
          if (current.execution.executionKey === null || !current.execution.terminal) return
          this.#focusConfigurationAfterInspector = true
          this.#dismissedTerminalExecutionKey = current.execution.executionKey
          this.render(current)
        },
      }
      const inspector = createExecutionInspector(inspectorOptions)
      if (this.#disposed || !this.#activity.active) {
        inspector.destroy()
        return
      }
      this.#inspector = inspector
    } else {
      this.#inspector.render(view)
    }
    if (this.#disposed || !this.#activity.active || this.#inspector === null) return
    this.#inspectorPanel.replaceChildren(this.#inspector.element)
  }

  async flushWorkspace(): Promise<void> {
    if (this.#disposed || !this.#activity.active || this.#consentReviewOpen) return
    const workspace = this.#threadWorkspace
    if (workspace === null) {
      await this.#state.flush()
      return
    }
    await workspace.flush()
  }

  placeholder(message: string): HTMLElement {
    const node = this.#document.createElement("p")
    node.dataset.apcPlaceholder = "true"
    node.textContent = message
    return node
  }

  teardown(): Promise<void> {
    if (this.#teardownPromise !== null) return this.#teardownPromise
    let resolveTeardown!: () => void
    let rejectTeardown!: (error: unknown) => void
    const teardownPromise = new Promise<void>((resolve, reject) => {
      resolveTeardown = resolve
      rejectTeardown = reject
    })
    this.#teardownPromise = teardownPromise
    const failure = this.disarm()
    if (failure === undefined) resolveTeardown()
    else rejectTeardown(failure)
    return teardownPromise
  }

  private disarm(): unknown {
    if (this.#disposed) return undefined
    this.#disposed = true
    this.#modeTransitionOperation = null
    this.#focusConfigurationAfterInspector = false
    this.#dismissedTerminalExecutionKey = null
    this.#consentReviewOpen = false
    this.#consentReviewSelectionKey = null
    this.#activity.active = false
    let failure: unknown
    const runCleanup = (cleanup: () => void): void => {
      try {
        cleanup()
      } catch (error) {
        if (failure === undefined) failure = error
      }
    }
    runCleanup(this.#onDisarmed)
    for (const unsubscribe of this.#unsubscribeEvents.splice(0)) runCleanup(unsubscribe)
    const unsubscribeLocale = this.#unsubscribeLocale
    this.#unsubscribeLocale = null
    runCleanup(() => unsubscribeLocale?.())
    const unsubscribeState = this.#unsubscribeState
    this.#unsubscribeState = null
    runCleanup(() => unsubscribeState?.())
    const graphNavigation = this.#graphNavigation
    this.#graphNavigation = null
    runCleanup(() => graphNavigation?.destroy())
    const graphTopology = this.#graphTopology
    this.#graphTopology = null
    runCleanup(() => graphTopology?.destroy())
    const threadConfiguration = this.#threadConfiguration
    this.#threadConfiguration = null
    runCleanup(() => threadConfiguration?.destroy())
    const threadWorkspace = this.#threadWorkspace
    this.#threadWorkspace = null
    this.#presetId = null
    this.#workspaceThreadId = null
    runCleanup(() => threadWorkspace?.destroy())
    const inspector = this.#inspector
    this.#inspector = null
    runCleanup(() => inspector?.destroy())
    runCleanup(() => this.#state.dispose())
    runCleanup(() => this.#styles.remove())
    runCleanup(() => this.#toolbarStyles.remove())
    runCleanup(() => this.#scope.cleanup())
    runCleanup(() => this.#toolbar.destroy())
    runCleanup(() => this.#tab.destroy())
    return failure
  }
}

const activeApcSetups = new WeakMap<SpindleFrontendContext, Promise<SpindleFrontendTeardown>>()

export async function createApcApp(ctx: SpindleFrontendContext, options: ApcAppOptions = {}): Promise<ApcAppHandle> {
  return ApcAppImpl.create(ctx, options)
}

export function setupApcApp(ctx: SpindleFrontendContext): Promise<SpindleFrontendTeardown> {
  const active = activeApcSetups.get(ctx)
  if (active !== undefined) return active
  let setupPromise!: Promise<SpindleFrontendTeardown>
  setupPromise = ApcAppImpl.create(ctx, {}, () => {
    if (activeApcSetups.get(ctx) === setupPromise) activeApcSetups.delete(ctx)
  }).then((app) => app.teardown.bind(app)).catch((error: unknown) => {
    if (activeApcSetups.get(ctx) === setupPromise) activeApcSetups.delete(ctx)
    throw error
  })
  activeApcSetups.set(ctx, setupPromise)
  return setupPromise
}
