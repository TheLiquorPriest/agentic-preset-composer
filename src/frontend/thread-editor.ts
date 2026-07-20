import type {
  PromptBlockDTO,
  PromptVariableValuesDTO,
  SpindleComponentsHelper,
  SpindleHostDescriptorV1,
  SpindleLoomBlockEditorHandle,
  SpindleLoomBlockEditorValue,
} from "lumiverse-spindle-types"
import type { ApcMissingPolicy, ApcRole, ApcWorkspaceSource } from "../config/schema"
import { MAX_RUN_TIMEOUT_MS, MIN_RUN_TIMEOUT_MS } from "../config/limits"
import type {
  ConnectionSummary,
  SafeConsentDisclosure,
  SafeDestination,
} from "../protocol/messages"
import type { ApcCatalogKey, ApcTranslate } from "../i18n/catalogs"
import { SpindleCompatibilityError, validateSpindleHostDescriptor } from "../compat"
import { focusElement } from "./accessibility"

/** The only namespace used for invocation-local native Loom workspaces. */
export const THREAD_WORKSPACE_NAMESPACE = "agentic_preset_composer" as const

export type ThreadEditorConsentStatus = "approved" | "revoked" | "required"

export type ThreadEditorOutput = Readonly<{
  id: "final"
  name: string
}>

export type ThreadEditorThreadSnapshot = Readonly<{
  id: string
  name: string
  description: string
  workspaceSource: ApcWorkspaceSource
  connectionSlotId?: string
  blocks: readonly PromptBlockDTO[]
  promptVariableValues: Readonly<PromptVariableValuesDTO>
  output: ThreadEditorOutput
}>

export type ThreadEditorSlotSnapshot = Readonly<{
  id: string
  label: string
  provider?: string
  model?: string
  bound: boolean
  /** Backend-authoritative binding resolution; stale and missing states cannot be approved. */
  bindingStatus?: "bound" | "stale" | "missing"
  boundConnectionId?: string
}>

export type ThreadEditorConsentSnapshot = Readonly<{
  threadId: string
  workspaceSource: ApcWorkspaceSource
  connectionSourceKey: "main" | `slot:${string}`
  status: ThreadEditorConsentStatus
  /** Present only when the backend has resolved the exact current destination. */
  destination?: SafeDestination
  /** Present only when the backend has supplied the current disclosure. */
  disclosure?: SafeConsentDisclosure
}>

export type ThreadEditorEarlierOutputSnapshot = Readonly<{
  runId: string
  threadName: string
  stageName: string
  stageOrdinal: number
  runOrdinal: number
  required: boolean
}>

export type ThreadEditorRunBindingSnapshot = Readonly<{
  id: string
  sourceRunId: string
  role: ApcRole
  onMissing: ApcMissingPolicy
}>

export type ThreadEditorRunSnapshot = Readonly<{
  id: string
  threadId: string
  stageName: string
  stageOrdinal: number
  ordinal: number
  required: boolean
  /** Final-route ownership keeps this run required even while other run fields remain editable. */
  requiredLocked?: boolean
  timeoutMs: number
  earlierOutputs: readonly ThreadEditorEarlierOutputSnapshot[]
  bindings: readonly ThreadEditorRunBindingSnapshot[]
}>

/** Read-only state consumed by the center thread workspace. */
export type ThreadEditorSnapshot = Readonly<{
  installationId: string
  presetId: string
  selectedThreadId: string | null
  /** Monotonic successful workspace/connection publication generation; never rendered as user data. */
  contextAuthorityGeneration: number
  /** Monotonic backend consent publication generation; never rendered as user data. */
  consentAuthorityGeneration: number
  /** When present, selection targets this scheduled use of the selected thread. */
  selectedRun?: ThreadEditorRunSnapshot
  threads: readonly ThreadEditorThreadSnapshot[]
  slots: readonly ThreadEditorSlotSnapshot[]
  connections: readonly ConnectionSummary[]
  consents?: readonly ThreadEditorConsentSnapshot[]
  readOnly: boolean
  /** Execution-specific mutation lock. Navigation and review remain available. */
  mutationLocked?: boolean
  blockedReason?: ThreadEditorMessage
}>

/** Catalog-backed user-facing message supplied by frontend state. */
export type ThreadEditorMessage = Readonly<{
  key: ApcCatalogKey
  values?: Readonly<Record<string, unknown>>
}>

export type ThreadEditorRename = Readonly<{
  name?: string
  description?: string
}>

export type ThreadEditorRunChange = Readonly<{
  required?: boolean
  timeoutMs?: number
}>

export type ThreadEditorRunBindingChange = Readonly<{
  sourceRunId?: string
  role?: ApcRole
  onMissing?: ApcMissingPolicy
}>

export type ThreadEditorConsentSelector = Readonly<{
  presetId: string
  threadId: string
  workspaceSource: ApcWorkspaceSource
  connectionSourceKey: "main" | `slot:${string}`
}>

/** Exact Gate C bridge surface used by the editor. */
export type ThreadEditorLoomBridge = Pick<SpindleComponentsHelper, "mountLoomBlockEditor">
export type ThreadEditorOptions = Readonly<{
  host: SpindleHostDescriptorV1
  presetId: string
  loom: ThreadEditorLoomBridge
  /** Text-only catalog translator owned by the APC host integration. */
  t: ApcTranslate
  /** DOM realm that owns every editor node; defaults to the host global document. */
  document?: Document
  /** Append the returned editor root before the first render when supplied. */
  parent?: HTMLElement
  onBackToGraph?: () => void | Promise<void>
  onRename?: (threadId: string, change: ThreadEditorRename) => void | Promise<void>
  onWorkspaceSourceChange?: (threadId: string, source: ApcWorkspaceSource) => void | Promise<void>
  onConnectionSlotChange?: (threadId: string, slotId: string | undefined) => void | Promise<void>
  onBind?: (slotId: string, connectionId: string) => void | Promise<void>
  onUnbind?: (slotId: string) => void | Promise<void>
  onResolveConsent?: (selector: ThreadEditorConsentSelector) => void | Promise<void>
  onRefreshConnections?: () => void | Promise<void>
  onApproveConsent?: (selector: ThreadEditorConsentSelector) => void | Promise<void>
  onRevokeConsent?: (selector: ThreadEditorConsentSelector) => void | Promise<void>
  onRunChange?: (runId: string, change: ThreadEditorRunChange) => void | Promise<void>
  onRunBindingChange?: (
    runId: string,
    bindingId: string,
    change: ThreadEditorRunBindingChange,
  ) => void | Promise<void>
  onAddRunBinding?: (runId: string) => void | Promise<void>
  onRemoveRunBinding?: (runId: string, bindingId: string) => void | Promise<void>
  onDirty?: (threadId: string, value: SpindleLoomBlockEditorValue) => void | Promise<void>
  onFlush?: () => void | Promise<void>
}>

export type ThreadEditorController = Readonly<{
  element: HTMLElement
  render(snapshot: ThreadEditorSnapshot): void
  flush(): Promise<void>
  destroy(): void
}>

type ThreadEditorFocusBookmark = Readonly<{
  hook: string
  index: number
  selectionStart?: number
  selectionEnd?: number
}>

const THREAD_ID_PATTERN = /^[^\u0000-\u001f\u007f\r\n]+$/u
const ROLE_KEYS: Readonly<Record<ApcRole, ApcCatalogKey>> = Object.freeze({
  system: "binding.roleSystem",
  user: "binding.roleUser",
  assistant: "binding.roleAssistant",
})
const FINAL_RUN_REQUIRED_KEY: ApcCatalogKey = "validation.finalRunRequired"
const MISSING_POLICY_KEYS: Readonly<Record<ApcMissingPolicy, ApcCatalogKey>> = Object.freeze({
  "fail-graph": "binding.missingFailGraph",
  "skip-run": "binding.missingSkipRun",
  "omit-binding": "binding.missingOmit",
})
const DISCLOSURE_KEYS: Readonly<Record<SafeConsentDisclosure["categories"][number], ApcCatalogKey>> = Object.freeze({
  thread: "agentGraph.thread",
  workspace: "graph.workspace",
  source: "inspector.fieldSource",
  destination: "inspector.fieldTarget",
  provider: "inspector.fieldProvider",
  model: "inspector.fieldModel",
  "input-bindings": "graph.inputs",
  "prior-stage-outputs": "binding.output",
  "main-context": "workspace.mainContext",
})

function assertIdentityPart(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || !THREAD_ID_PATTERN.test(value)) {
    throw new SpindleCompatibilityError(`${label} must be a non-empty safe identifier`)
  }
  return value
}

/** Build the stable, internal APC identity for one invocation-local Loom workspace. */
export function buildThreadWorkspaceId(
  installationId: string,
  presetId: string,
  threadId: string,
): string {
  return `${THREAD_WORKSPACE_NAMESPACE}:${assertIdentityPart(installationId, "installationId")}:preset:${assertIdentityPart(presetId, "presetId")}:thread:${assertIdentityPart(threadId, "threadId")}`
}

function cloneLoomValue(value: SpindleLoomBlockEditorValue): SpindleLoomBlockEditorValue {
  return structuredClone(value)
}

function cloneThreadValue(thread: ThreadEditorThreadSnapshot): SpindleLoomBlockEditorValue {
  return cloneLoomValue({
    blocks: thread.blocks as PromptBlockDTO[],
    promptVariableValues: thread.promptVariableValues as PromptVariableValuesDTO,
  })
}

function invoke(callback: (() => void | Promise<void>) | undefined): void {
  if (!callback) return
  const result = callback()
  if (result && typeof (result as Promise<void>).then === "function") {
    void (result as Promise<void>).catch(() => {})
  }
}


function statusLabel(t: ApcTranslate, status: ThreadEditorConsentStatus): string {
  if (status === "approved") return t("consent.statusApproved")
  if (status === "revoked") return t("consent.statusRevoked")
  return t("consent.statusRequired")
}

function consentFor(
  snapshot: ThreadEditorSnapshot,
  thread: ThreadEditorThreadSnapshot,
  sourceKey: "main" | `slot:${string}`,
): ThreadEditorConsentSnapshot | undefined {
  return snapshot.consents?.find(
    (consent) =>
      consent.threadId === thread.id &&
      consent.workspaceSource === thread.workspaceSource &&
      consent.connectionSourceKey === sourceKey,
  )
}

function makeSelector(
  snapshot: ThreadEditorSnapshot,
  thread: ThreadEditorThreadSnapshot,
  sourceKey: "main" | `slot:${string}`,
): ThreadEditorConsentSelector {
  return {
    presetId: snapshot.presetId,
    threadId: thread.id,
    workspaceSource: thread.workspaceSource,
    connectionSourceKey: sourceKey,
  }
}

function validateSnapshot(snapshot: ThreadEditorSnapshot, host: SpindleHostDescriptorV1, presetId: string): void {
  if (snapshot.installationId !== host.extensionInstallationId) {
    throw new SpindleCompatibilityError("Thread editor snapshot installation identity does not match the host")
  }
  if (snapshot.presetId !== presetId) {
    throw new SpindleCompatibilityError("Thread editor snapshot preset identity does not match the editor")
  }
  if (!Number.isSafeInteger(snapshot.contextAuthorityGeneration) || snapshot.contextAuthorityGeneration < 0) {
    throw new SpindleCompatibilityError("Thread editor context authority generation is invalid")
  }
  if (!Number.isSafeInteger(snapshot.consentAuthorityGeneration) || snapshot.consentAuthorityGeneration < 0) {
    throw new SpindleCompatibilityError("Thread editor consent authority generation is invalid")
  }
  const threadIds = new Set<string>()
  for (const thread of snapshot.threads) {
    assertIdentityPart(thread.id, "threadId")
    if (threadIds.has(thread.id)) throw new SpindleCompatibilityError("Duplicate thread identity")
    threadIds.add(thread.id)
    if (thread.output.id !== "final") throw new SpindleCompatibilityError("Unsupported thread output")
  }
  if (snapshot.selectedThreadId !== null && !threadIds.has(snapshot.selectedThreadId)) {
    throw new SpindleCompatibilityError("Selected thread is not present in the snapshot")
  }
  const slotIds = new Set<string>()
  for (const slot of snapshot.slots) {
    assertIdentityPart(slot.id, "slotId")
    if (slotIds.has(slot.id)) throw new SpindleCompatibilityError("Duplicate slot identity")
    slotIds.add(slot.id)
  }
  const connectionIds = new Set<string>()
  for (const connection of snapshot.connections) {
    assertIdentityPart(connection.id, "connectionId")
    if (connectionIds.has(connection.id)) throw new SpindleCompatibilityError("Duplicate connection identity")
    connectionIds.add(connection.id)
  }
  for (const slot of snapshot.slots) {
    if (slot.boundConnectionId !== undefined && (!slot.bound || !connectionIds.has(slot.boundConnectionId))) {
      throw new SpindleCompatibilityError("Connection slot has an invalid binding")
    }
  }
  for (const thread of snapshot.threads) {
    if (thread.connectionSlotId !== undefined && !slotIds.has(thread.connectionSlotId)) {
      throw new SpindleCompatibilityError("Thread references an unknown connection slot")
    }
  }
  const run = snapshot.selectedRun
  if (run) {
    assertIdentityPart(run.id, "runId")
    if (snapshot.selectedThreadId === null || run.threadId !== snapshot.selectedThreadId) {
      throw new SpindleCompatibilityError("Selected run does not use the selected thread")
    }
    if (
      !Number.isSafeInteger(run.ordinal) ||
      run.ordinal < 1 ||
      !Number.isSafeInteger(run.stageOrdinal) ||
      run.stageOrdinal < 1
    ) {
      throw new SpindleCompatibilityError("Selected run display position is invalid")
    }
    const earlierRunIds = new Set<string>()
    for (const output of run.earlierOutputs) {
      assertIdentityPart(output.runId, "earlierRunId")
      if (typeof output.required !== "boolean") {
        throw new SpindleCompatibilityError("Earlier output required state is invalid")
      }
      if (
        !Number.isSafeInteger(output.stageOrdinal) ||
        output.stageOrdinal < 1 ||
        !Number.isSafeInteger(output.runOrdinal) ||
        output.runOrdinal < 1
      ) {
        throw new SpindleCompatibilityError("Earlier output display position is invalid")
      }
      if (output.stageOrdinal >= run.stageOrdinal) {
        throw new SpindleCompatibilityError("Earlier output must come from an earlier stage")
      }
      if (earlierRunIds.has(output.runId)) throw new SpindleCompatibilityError("Duplicate earlier output")
      earlierRunIds.add(output.runId)
    }
    const bindingIds = new Set<string>()
    for (const binding of run.bindings) {
      assertIdentityPart(binding.id, "bindingId")
      if (bindingIds.has(binding.id)) throw new SpindleCompatibilityError("Duplicate run binding")
      bindingIds.add(binding.id)
      if (!earlierRunIds.has(binding.sourceRunId)) {
        throw new SpindleCompatibilityError("Run binding does not reference an earlier output")
      }
    }
  }
}

/**
 * Create APC's center thread workspace. The native Loom bridge remains the only
 * block surface; APC supplies identity, run configuration, and consent context.
 */
export function createThreadEditor(options: ThreadEditorOptions): ThreadEditorController {
  const host = validateSpindleHostDescriptor(options.host)
  assertIdentityPart(options.presetId, "presetId")
  if (!options.loom || typeof options.loom.mountLoomBlockEditor !== "function") {
    throw new SpindleCompatibilityError("The host did not provide the Loom block editor bridge")
  }
  const document = options.document ?? globalThis.document
  if (!document) {
    throw new SpindleCompatibilityError("The thread editor requires a host document")
  }
  const text = (value: string): Text => document.createTextNode(value)
  const button = (label: string, hook: string): HTMLButtonElement => {
    const node = document.createElement("button")
    node.type = "button"
    node.textContent = label
    node.dataset[hook] = "true"
    return node
  }
  const appendLabel = (parent: HTMLElement, label: string, control: HTMLElement): HTMLLabelElement => {
    const wrapper = document.createElement("label")
    wrapper.className = "apc-field"
    const caption = document.createElement("span")
    caption.className = "apc-field-label"
    caption.append(text(label))
    wrapper.append(caption, control)
    parent.append(wrapper)
    return wrapper
  }
  const appendDefinition = (list: HTMLDListElement, label: string, value: string): void => {
    const term = document.createElement("dt")
    term.append(text(label))
    const description = document.createElement("dd")
    description.append(text(value))
    list.append(term, description)
  }

  const element = document.createElement("section")
  element.className = "apc-thread-workspace-pane"
  element.dataset.apcThreadEditor = "true"
  element.setAttribute("aria-label", options.t("threadEditor.ariaLabel"))
  if (options.parent) options.parent.append(element)

  let destroyed = false
  let currentSnapshot: ThreadEditorSnapshot | null = null
  let liveRegion: HTMLElement | null = null
  let loomWorkspace: HTMLElement | null = null
  let loomTarget: HTMLElement | null = null
  let loomHandle: SpindleLoomBlockEditorHandle | null = null
  let mountedWorkspaceId: string | null = null
  let mountedThreadId: string | null = null
  let mountGeneration = 0
  let reviewOpen = false
  let acknowledged = false
  let consentResolveGeneration = 0
  let consentResolvePending: {
    selectorKey: string
    contextKey: string
    authorityFloor: number
    token: number
    settled: boolean
  } | null = null
  let consentResolveFailure: Readonly<{ selectorKey: string; contextKey: string }> | null = null
  let consentResolved: Readonly<{ selectorKey: string; contextKey: string }> | null = null
  let currentConsentContextKey: string | null = null
  let reviewContextKey: string | null = null
  let approvalGeneration = 0
  let approvalPending: {
    contextKey: string
    authorityFloor: number
    startStatus: ThreadEditorConsentStatus
    expectedStatus: "approved"
    token: number
    settled: boolean
  } | null = null
  let contextMutationGeneration = 0
  let contextMutation: {
    token: number
    renderFloor: number
    authorityFloor: number
    settled: boolean
    matches(snapshot: ThreadEditorSnapshot): boolean
  } | null = null
  let revokeGeneration = 0
  let revokePending: {
    contextKey: string
    authorityFloor: number
    startStatus: ThreadEditorConsentStatus
    expectedStatus: "revoked"
    token: number
    settled: boolean
  } | null = null
  let focusConsentTriggerOnRender = false
  let renderGeneration = 0
  let reviewTrigger: HTMLButtonElement | null = null
  const cleanupListeners: Array<() => void> = []
  const dirtyValues = new Map<string, SpindleLoomBlockEditorValue>()
  const reportedValues = new Map<string, SpindleLoomBlockEditorValue>()
  let pendingDirtyWrites: Promise<void> = Promise.resolve()
  let dirtyWriteFailure: unknown = undefined
  let dirtyWriteFailed = false
  let dirtyGeneration = 0

  function listen<T extends EventTarget>(target: T, type: string, listener: EventListener): void {
    target.addEventListener(type, listener)
    cleanupListeners.push(() => target.removeEventListener(type, listener))
  }

  function clearListeners(): void {
    for (const cleanup of cleanupListeners.splice(0)) cleanup()
  }

  function captureFocusBookmark(): ThreadEditorFocusBookmark | null {
    const active = document.activeElement
    if (active === null || !("dataset" in active)) return null
    const activeElement = active as HTMLElement
    let ancestor: HTMLElement | null = activeElement
    while (ancestor !== null && ancestor !== element) ancestor = ancestor.parentElement
    if (ancestor !== element) return null
    const hook = Object.keys(activeElement.dataset).find((key) => key.startsWith("apc"))
    if (!hook) return null
    const attribute = hook.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
    const candidates = Array.from(element.querySelectorAll<HTMLElement>(`[data-${attribute}]`))
    const index = candidates.indexOf(activeElement)
    if (index < 0) return null
    const selectable = activeElement as HTMLInputElement | HTMLTextAreaElement
    const selectionStart = typeof selectable.selectionStart === "number" ? selectable.selectionStart : undefined
    const selectionEnd = typeof selectable.selectionEnd === "number" ? selectable.selectionEnd : undefined
    return {
      hook,
      index,
      ...(selectionStart === undefined ? {} : { selectionStart }),
      ...(selectionEnd === undefined ? {} : { selectionEnd }),
    }
  }

  function restoreFocusBookmark(bookmark: ThreadEditorFocusBookmark | null): boolean {
    if (!bookmark) return false
    const attribute = bookmark.hook.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
    const target = element.querySelectorAll<HTMLElement>(`[data-${attribute}]`)[bookmark.index]
    if (!target || (target as HTMLButtonElement | HTMLInputElement | HTMLSelectElement).disabled) return false
    if (!focusElement(target)) return false
    if (bookmark.selectionStart === undefined || bookmark.selectionEnd === undefined) return true
    const selectable = target as HTMLInputElement | HTMLTextAreaElement
    if (typeof selectable.setSelectionRange !== "function") return true
    try {
      selectable.setSelectionRange(bookmark.selectionStart, bookmark.selectionEnd)
    } catch {
      // Some input types expose selection properties but reject range updates.
    }
    return true
  }

  function announce(message: string): void {
    liveRegion?.replaceChildren(text(message))
  }

  function invalidateConsentReview(): void {
    reviewOpen = false
    acknowledged = false
    consentResolvePending = null
    consentResolveFailure = null
    consentResolved = null
    approvalPending = null
    revokePending = null
  }

  function matchesSelectedThreadContext(
    candidate: ThreadEditorSnapshot,
    threadId: string,
    workspaceSource: ThreadEditorThreadSnapshot["workspaceSource"],
    connectionSlotId: string | undefined,
  ): boolean {
    if (candidate.selectedThreadId !== threadId) return false
    const thread = candidate.threads.find((candidateThread) => candidateThread.id === threadId)
    return thread?.workspaceSource === workspaceSource && thread.connectionSlotId === connectionSlotId
  }


  function beginConsentContextMutation(
    snapshot: ThreadEditorSnapshot,
    callback: () => void | Promise<void>,
    successMessage: string,
    matches: (snapshot: ThreadEditorSnapshot) => boolean,
  ): void {
    invalidateConsentReview()
    const token = ++contextMutationGeneration
    contextMutation = {
      token,
      renderFloor: renderGeneration,
      authorityFloor: snapshot.contextAuthorityGeneration,
      settled: false,
      matches,
    }
    element.dataset.apcConsentContextMutation = "pending"
    renderInternal(snapshot, "thread-heading")
    if (contextMutation?.token === token) contextMutation.renderFloor = renderGeneration
    const fail = (): void => {
      if (destroyed || contextMutation?.token !== token || currentSnapshot === null) return
      contextMutation = null
      renderInternal(currentSnapshot)
      announce(options.t("error.connection"))
    }
    let result: void | Promise<void>
    try {
      result = callback()
    } catch {
      fail()
      return
    }
    void Promise.resolve(result)
      .then(() => {
        if (destroyed || contextMutation?.token !== token) return
        contextMutation.settled = true
        element.dataset.apcConsentContextMutation = "awaiting-authoritative"
        if (
          renderGeneration <= contextMutation.renderFloor ||
          currentSnapshot === null ||
          currentSnapshot.contextAuthorityGeneration <= contextMutation.authorityFloor ||
          !contextMutation.matches(currentSnapshot)
        ) return
        contextMutation = null
        renderInternal(currentSnapshot)
        announce(successMessage)
      })
      .catch(fail)
  }

  function reportDirty(threadId: string, value: SpindleLoomBlockEditorValue): void {
    const detached = cloneLoomValue(value)
    const previous = reportedValues.get(threadId)
    dirtyValues.set(threadId, detached)
    if (previous && JSON.stringify(previous) === JSON.stringify(detached)) return
    dirtyGeneration += 1
    reportedValues.set(threadId, cloneLoomValue(detached))
    if (!options.onDirty) return
    const writeValue = cloneLoomValue(detached)
    pendingDirtyWrites = pendingDirtyWrites.then(async () => {
      try {
        await options.onDirty?.(threadId, writeValue)
      } catch (error) {
        dirtyWriteFailed = true
        dirtyWriteFailure ??= error
      }
    })
  }

  async function awaitDirtyWrites(): Promise<void> {
    let observed: Promise<void>
    do {
      observed = pendingDirtyWrites
      await observed
      if (destroyed) return
    } while (observed !== pendingDirtyWrites)
    if (dirtyWriteFailed) {
      const failure = dirtyWriteFailure
      dirtyWriteFailed = false
      dirtyWriteFailure = undefined
      reportedValues.clear()
      throw failure ?? new SpindleCompatibilityError("Unable to persist Loom workspace changes")
    }
  }

  function captureLoom(): void {
    if (!loomHandle || !mountedThreadId) return
    reportDirty(mountedThreadId, loomHandle.getValue())
  }

  function destroyLoom(): void {
    mountGeneration += 1
    loomHandle?.destroy()
    loomWorkspace?.remove()
    loomHandle = null
    loomTarget = null
    loomWorkspace = null
    mountedWorkspaceId = null
    mountedThreadId = null
  }
  function clearRenderSurface(): void {
    if (!loomWorkspace || !loomTarget || !loomHandle || !loomWorkspace.isConnected) {
      element.replaceChildren()
      return
    }
    for (const child of Array.from(element.children)) {
      if (child !== loomWorkspace) child.remove()
    }
  }

  function appendBeforeWorkspace(node: HTMLElement): void {
    const anchor = loomWorkspace?.parentElement === element ? loomWorkspace : null
    element.insertBefore(node, anchor)
  }

  function ensureLoom(
    snapshot: ThreadEditorSnapshot,
    thread: ThreadEditorThreadSnapshot,
    workspace: HTMLElement,
    locked: boolean,
  ): void {
    const workspaceId = buildThreadWorkspaceId(host.extensionInstallationId, snapshot.presetId, thread.id)
    workspace.dataset.apcWorkspaceSource = thread.workspaceSource
    workspace.setAttribute("aria-label", options.t("threadEditor.workspaceAria", { name: thread.name }))

    if (thread.workspaceSource === "main-context") {
      const explanation = document.createElement("p")
      explanation.dataset.apcMainContext = "true"
      explanation.append(text(options.t("threadEditor.mainContextMessage")))
      workspace.append(explanation)
      return
    }

    const value = dirtyValues.get(thread.id) ?? cloneThreadValue(thread)
    if (loomTarget && loomHandle && mountedWorkspaceId === workspaceId && mountedThreadId === thread.id) {
      loomHandle.update({ compact: true, readOnly: locked, value })
      return
    }

    if (loomHandle || loomTarget) throw new SpindleCompatibilityError("Loom workspace lifecycle is inconsistent")
    const target = document.createElement("div")
    target.className = "apc-host-loom-editor"
    target.dataset.apcHostLoomEditor = "true"
    workspace.append(target)
    loomTarget = target
    mountedWorkspaceId = workspaceId
    mountedThreadId = thread.id
    const generation = ++mountGeneration
    const mount = (): void => {
      if (destroyed || generation !== mountGeneration || !target.isConnected) return
      loomHandle = options.loom.mountLoomBlockEditor(target, {
        compact: true,
        readOnly: locked,
        value,
        onChange: (next) => {
          if (
            destroyed ||
            generation !== mountGeneration ||
            loomTarget !== target ||
            mountedThreadId !== thread.id
          ) return
          reportDirty(thread.id, next)
        },
      })
    }
    if (target.isConnected) mount()
    else queueMicrotask(mount)
  }

  function renderRunConfiguration(
    thread: ThreadEditorThreadSnapshot,
    run: ThreadEditorRunSnapshot,
    parent: HTMLElement,
    locked: boolean,
  ): void {
    const panel = document.createElement("section")
    panel.className = "apc-run-configuration"
    panel.dataset.apcRunConfiguration = "true"
    const heading = document.createElement("h3")
    heading.append(text(options.t("graph.runTitle", { thread: thread.name, index: run.ordinal })))
    const stage = document.createElement("p")
    stage.dataset.apcRunStage = "true"
    stage.append(
      text(options.t("graph.defaultStageName", { index: run.stageOrdinal })),
      text(" · "),
      text(run.stageName),
    )
    panel.append(heading, stage)

    const required = document.createElement("input")
    required.type = "checkbox"
    const requiredLocked = run.requiredLocked === true
    const effectivelyRequired = run.required || requiredLocked
    required.checked = requiredLocked || run.required
    required.disabled = locked || requiredLocked || options.onRunChange === undefined
    required.dataset.apcRunRequired = "true"
    const requiredLabel = document.createElement("label")
    requiredLabel.className = "apc-checkbox-field"
    requiredLabel.append(required, text(required.checked ? options.t("binding.required") : options.t("binding.optional")))
    panel.append(requiredLabel)
    if (requiredLocked) {
      const reason = document.createElement("p")
      reason.dataset.apcRunRequiredReason = "true"
      reason.append(text(options.t(FINAL_RUN_REQUIRED_KEY)))
      panel.append(reason)
    }
    listen(required, "change", () => {
      if (locked || requiredLocked || destroyed || !options.onRunChange) return
      invoke(() => options.onRunChange!(run.id, { required: required.checked }))
      announce(required.checked ? options.t("a11y.changeRunMarkedRequired") : options.t("a11y.changeRunMarkedOptional"))
    })

    const timeout = document.createElement("input")
    const minSeconds = MIN_RUN_TIMEOUT_MS / 1000
    const maxSeconds = MAX_RUN_TIMEOUT_MS / 1000
    timeout.type = "number"
    timeout.min = String(minSeconds)
    timeout.max = String(maxSeconds)
    timeout.step = "1"
    timeout.value = String(run.timeoutMs / 1000)
    timeout.disabled = locked || options.onRunChange === undefined
    timeout.dataset.apcRunTimeout = "true"
    timeout.setAttribute("aria-label", options.t("validation.timeoutValue", { seconds: run.timeoutMs / 1000 }))
    appendLabel(panel, options.t("validation.timeout"), timeout)
    listen(timeout, "change", () => {
      if (locked || destroyed || !options.onRunChange) return
      const seconds = Number(timeout.value)
      const timeoutMs = seconds * 1000
      if (
        !Number.isFinite(seconds) ||
        seconds < minSeconds ||
        seconds > maxSeconds ||
        !Number.isSafeInteger(timeoutMs)
      ) {
        announce(options.t("validation.timeoutValue", { seconds: `${minSeconds}–${maxSeconds}` }))
        return
      }
      invoke(() => options.onRunChange!(run.id, { timeoutMs }))
      announce(options.t("a11y.changeRunTimeoutUpdated"))
    })

    const bindings = document.createElement("section")
    bindings.className = "apc-bindings"
    bindings.dataset.apcEarlierOutputBindings = "true"
    const bindingsHeading = document.createElement("h4")
    bindingsHeading.append(text(options.t("graph.inputs")))
    bindings.append(bindingsHeading)
    for (const binding of run.bindings) {
      const bindingPanel = document.createElement("fieldset")
      bindingPanel.className = "apc-binding"
      bindingPanel.dataset.apcEarlierOutputBinding = "true"
      const legend = document.createElement("legend")
      legend.append(text(options.t("binding.output")))
      bindingPanel.append(legend)

      const source = document.createElement("select")
      source.disabled = locked || options.onRunBindingChange === undefined
      source.dataset.apcBindingSource = "true"
      let selectedSourceToken = ""
      const sourceOptions: Array<{
        element: HTMLOptionElement
        output: ThreadEditorEarlierOutputSnapshot
      }> = []
      run.earlierOutputs.forEach((output, index) => {
        const token = `earlier-output-${index + 1}`
        const option = document.createElement("option")
        option.value = token
        option.textContent = [
          options.t("graph.defaultStageName", { index: output.stageOrdinal }),
          output.stageName,
          options.t("graph.runTitle", { thread: output.threadName, index: output.runOrdinal }),
          options.t("graph.defaultFinalResponseName"),
        ].join(" · ")
        source.append(option)
        sourceOptions.push({ element: option, output })
        if (output.runId === binding.sourceRunId) selectedSourceToken = token
      })
      source.value = selectedSourceToken
      let acceptedSourceToken = selectedSourceToken
      appendLabel(bindingPanel, options.t("binding.outputSource"), source)

      const role = document.createElement("select")
      role.disabled = locked || options.onRunBindingChange === undefined
      role.dataset.apcBindingRole = "true"
      for (const roleValue of Object.keys(ROLE_KEYS) as ApcRole[]) {
        const option = document.createElement("option")
        option.value = roleValue
        option.textContent = options.t(ROLE_KEYS[roleValue])
        role.append(option)
      }
      role.value = binding.role
      appendLabel(bindingPanel, options.t("binding.role"), role)
      listen(role, "change", () => {
        if (locked || destroyed || !options.onRunBindingChange || !(role.value in ROLE_KEYS)) return
        invoke(() => options.onRunBindingChange!(run.id, binding.id, { role: role.value as ApcRole }))
        announce(options.t("a11y.changeInputRoleUpdated"))
      })

      const missing = document.createElement("select")
      missing.disabled = locked || options.onRunBindingChange === undefined
      missing.dataset.apcBindingMissing = "true"
      const missingOptions = new Map<ApcMissingPolicy, HTMLOptionElement>()
      for (const policy of Object.keys(MISSING_POLICY_KEYS) as ApcMissingPolicy[]) {
        const option = document.createElement("option")
        option.value = policy
        option.textContent = options.t(MISSING_POLICY_KEYS[policy])
        missingOptions.set(policy, option)
        missing.append(option)
      }
      const selectedOutput = run.earlierOutputs.find((output) => output.runId === binding.sourceRunId)
      const initialPolicyIsValid =
        !(binding.onMissing === "skip-run" && effectivelyRequired) &&
        !(binding.onMissing === "fail-graph" && selectedOutput?.required !== true)
      missing.value = binding.onMissing
      let acceptedPolicy = binding.onMissing
      if (!initialPolicyIsValid) announce(options.t("validation.invalid"))
      const synchronizePolicyOptions = (): void => {
        const selectedSource = sourceOptions.find(({ element }) => element.value === source.value)?.output
        for (const { element: option, output } of sourceOptions) {
          option.disabled = missing.value === "fail-graph" && !output.required
        }
        const skipRun = missingOptions.get("skip-run")
        if (skipRun) skipRun.disabled = effectivelyRequired
        const failGraph = missingOptions.get("fail-graph")
        if (failGraph) failGraph.disabled = selectedSource?.required !== true
      }
      synchronizePolicyOptions()
      appendLabel(bindingPanel, options.t("binding.missingPolicy"), missing)
      listen(source, "change", () => {
        if (locked || destroyed || !options.onRunBindingChange) return
        const selectedOption = sourceOptions.find(({ element }) => element.value === source.value)
        if (!selectedOption || selectedOption.element.disabled) {
          source.value = acceptedSourceToken
          return
        }
        synchronizePolicyOptions()
        acceptedSourceToken = source.value
        invoke(() => options.onRunBindingChange!(run.id, binding.id, { sourceRunId: selectedOption.output.runId }))
        announce(options.t("a11y.changeOutputSourceUpdated"))
      })
      listen(missing, "change", () => {
        if (locked || destroyed || !options.onRunBindingChange || !(missing.value in MISSING_POLICY_KEYS)) return
        const policy = missing.value as ApcMissingPolicy
        if (missingOptions.get(policy)?.disabled) {
          missing.value = acceptedPolicy
          return
        }
        synchronizePolicyOptions()
        invoke(() => options.onRunBindingChange!(run.id, binding.id, { onMissing: policy }))
        acceptedPolicy = policy
        announce(options.t("a11y.changeMissingPolicyUpdated"))
      })

      const remove = button(options.t("action.removeBinding"), "apcRemoveRunBinding")
      remove.disabled = locked || options.onRemoveRunBinding === undefined
      bindingPanel.append(remove)
      listen(remove, "click", () => {
        if (locked || destroyed || !options.onRemoveRunBinding) return
        invoke(() => options.onRemoveRunBinding!(run.id, binding.id))
        announce(options.t("a11y.changeInputBindingRemoved"))
      })
      bindings.append(bindingPanel)
    }
    const add = button(options.t("action.addBinding"), "apcAddRunBinding")
    add.disabled = locked || run.earlierOutputs.length === 0 || options.onAddRunBinding === undefined
    bindings.append(add)
    listen(add, "click", () => {
      if (locked || destroyed || run.earlierOutputs.length === 0 || !options.onAddRunBinding) return
      invoke(() => options.onAddRunBinding!(run.id))
      announce(options.t("a11y.changeInputBindingAdded"))
    })
    panel.append(bindings)

    const output = document.createElement("output")
    output.dataset.apcRunOutput = "true"
    output.append(text(options.t("graph.defaultFinalResponseName")))
    panel.append(output)
    parent.append(panel)
  }

  function renderConsentReview(
    snapshot: ThreadEditorSnapshot,
    thread: ThreadEditorThreadSnapshot,
    sourceKey: "main" | `slot:${string}`,
    slot: ThreadEditorSlotSnapshot | undefined,
    parent: HTMLElement,
    locked: boolean,
  ): void {
    const consent = consentFor(snapshot, thread, sourceKey)
    const selector = makeSelector(snapshot, thread, sourceKey)
    const selectorKey = JSON.stringify(selector)
    const bindingStatus = consent === undefined || !consent.destination || !consent.disclosure
      ? (slot?.bindingStatus === "stale" ? "stale" : "missing")
      : sourceKey === "main"
        ? "bound"
        : slot?.bindingStatus === "bound"
          ? "bound"
          : slot?.bindingStatus === "stale" ? "stale" : "missing"
    const authoritativeStatus: ThreadEditorConsentStatus =
      bindingStatus === "bound" ? (consent?.status ?? "required") : "required"
    const sourceLabel = sourceKey === "main" ? options.t("privacy.mainSource") : (slot?.label ?? options.t("privacy.slotSource"))
    const destination = consent?.destination
    const disclosure = consent?.disclosure
    const consentContextKey = JSON.stringify([
      thread.id,
      thread.workspaceSource,
      sourceKey,
      bindingStatus,
      destination?.label,
      destination?.provider,
      destination?.model,
      disclosure?.version,
      disclosure?.summary,
      disclosure?.categories.join("\u0000"),
    ])
    if (currentConsentContextKey !== null && currentConsentContextKey !== consentContextKey) {
      if (revokePending !== null && revokePending.contextKey !== consentContextKey) revokePending = null
      consentResolvePending = null
      consentResolved = null
      consentResolveFailure = null
      acknowledged = false
      if (approvalPending !== null && approvalPending.contextKey !== consentContextKey) approvalPending = null
      reviewOpen = false
    }
    currentConsentContextKey = consentContextKey
    const contextKey = JSON.stringify([consentContextKey, authoritativeStatus])
    let consentOperationFailed = false
    if (
      consentResolvePending?.settled &&
      consentResolvePending.selectorKey === selectorKey &&
      consentResolvePending.contextKey === consentContextKey &&
      snapshot.consentAuthorityGeneration > consentResolvePending.authorityFloor
    ) {
      consentResolvePending = null
      consentResolveFailure = null
      consentResolved = { selectorKey, contextKey: consentContextKey }
      if (!reviewOpen) focusConsentTriggerOnRender = true
    }
    if (
      approvalPending !== null &&
      approvalPending.contextKey === consentContextKey &&
      snapshot.consentAuthorityGeneration > approvalPending.authorityFloor
    ) {
      if (authoritativeStatus !== approvalPending.expectedStatus) {
        approvalPending = null
        acknowledged = false
        consentOperationFailed = true
      } else if (approvalPending.settled) {
        approvalPending = null
        if (!reviewOpen) focusConsentTriggerOnRender = true
      }
    }
    if (
      revokePending !== null &&
      revokePending.contextKey === consentContextKey &&
      snapshot.consentAuthorityGeneration > revokePending.authorityFloor
    ) {
      if (authoritativeStatus !== revokePending.expectedStatus) {
        revokePending = null
        consentOperationFailed = true
      } else if (revokePending.settled) {
        revokePending = null
        reviewOpen = false
        acknowledged = false
        focusConsentTriggerOnRender = true
      }
    }
    if (consentOperationFailed) announce(options.t("error.connection"))
    if (contextKey !== reviewContextKey) {
      reviewContextKey = contextKey
      acknowledged = false
    }
    const resolutionPending =
      consentResolvePending?.selectorKey === selectorKey &&
      consentResolvePending.contextKey === consentContextKey
    const resolutionFailed =
      consentResolveFailure?.selectorKey === selectorKey &&
      consentResolveFailure.contextKey === consentContextKey
    const resolutionFresh =
      consentResolved?.selectorKey === selectorKey &&
      consentResolved.contextKey === consentContextKey
    const approvalIsPending = approvalPending?.contextKey === consentContextKey
    const contextMutationPending = contextMutation !== null
    const status: ThreadEditorConsentStatus =
      resolutionPending ||
      resolutionFailed ||
      contextMutationPending ||
      approvalIsPending ||
      (reviewOpen && !resolutionFresh)
        ? "required"
        : authoritativeStatus

    const statusText = document.createElement("p")
    statusText.dataset.apcConsentStatus = status
    statusText.append(text(statusLabel(options.t, status)))
    parent.append(statusText)

    reviewTrigger = button(options.t("consent.title"), "apcOpenConsentReview")
    reviewTrigger.setAttribute("aria-expanded", String(reviewOpen))
    reviewTrigger.disabled =
      options.onResolveConsent === undefined ||
      contextMutationPending ||
      resolutionPending ||
      resolutionFailed ||
      approvalPending !== null ||
      revokePending !== null ||
      reviewOpen
    parent.append(reviewTrigger)
    listen(reviewTrigger, "click", () => {
      if (destroyed || reviewTrigger?.disabled) return
      reviewOpen = true
      acknowledged = false
      approvalPending = null
      consentResolved = null
      if (!options.onResolveConsent) {
        renderInternal(snapshot, "consent-heading")
        return
      }
      const token = ++consentResolveGeneration
      consentResolvePending = {
        selectorKey,
        contextKey: consentContextKey,
        authorityFloor: snapshot.consentAuthorityGeneration,
        token,
        settled: false,
      }
      renderInternal(snapshot, "consent-heading")
      void Promise.resolve()
        .then(() => options.onResolveConsent?.(selector))
        .then(() => {
          if (
            destroyed ||
            consentResolvePending?.token !== token ||
            consentResolvePending.selectorKey !== selectorKey ||
            consentResolvePending.contextKey !== consentContextKey ||
            currentConsentContextKey !== consentContextKey ||
            currentSnapshot === null
          ) return
          consentResolvePending.settled = true
          renderInternal(currentSnapshot, reviewOpen ? "consent-heading" : undefined)
        })
        .catch(() => {
          if (
            destroyed ||
            consentResolvePending?.token !== token ||
            consentResolvePending.selectorKey !== selectorKey ||
            consentResolvePending.contextKey !== consentContextKey ||
            currentConsentContextKey !== consentContextKey ||
            currentSnapshot === null
          ) return
          consentResolvePending = null
          consentResolved = null
          consentResolveFailure = { selectorKey, contextKey: consentContextKey }
          renderInternal(currentSnapshot, reviewOpen ? "consent-heading" : "consent-trigger")
          announce(options.t("error.connection"))
        })
    })

    if (!reviewOpen) return
    const review = document.createElement("section")
    review.className = "apc-consent-review"
    review.dataset.apcConsentReview = "true"
    review.setAttribute("aria-label", options.t("consent.title"))
    review.dataset.apcConsentResolving = String(resolutionPending)
    review.setAttribute("aria-busy", String(resolutionPending))
    const heading = document.createElement("h3")
    heading.tabIndex = -1
    heading.dataset.apcConsentReviewHeading = "true"
    heading.append(text(options.t("consent.title")))
    review.append(heading)

    const details = document.createElement("dl")
    details.className = "apc-consent-details"
    appendDefinition(details, options.t("agentGraph.thread"), thread.name)
    appendDefinition(
      details,
      options.t("graph.workspace"),
      options.t(thread.workspaceSource === "native-blocks" ? "workspace.nativeBlocks" : "workspace.mainContext"),
    )
    appendDefinition(details, options.t("inspector.fieldSource"), sourceLabel)
    appendDefinition(details, options.t("inspector.fieldTarget"), destination?.label ?? options.t("validation.required"))
    appendDefinition(details, options.t("inspector.fieldProvider"), destination?.provider ?? options.t("validation.required"))
    appendDefinition(details, options.t("inspector.fieldModel"), destination?.model ?? options.t("validation.required"))
    review.append(details)

    if (disclosure) {
      const disclosureHeading = document.createElement("h4")
      disclosureHeading.append(text(options.t("privacy.title")))
      const summary = document.createElement("p")
      summary.dataset.apcConsentDisclosure = "true"
      summary.append(text(options.t("consent.disclosureSummary", {
        destination: destination?.label ?? options.t("validation.required"),
        workspace: options.t(
          thread.workspaceSource === "native-blocks" ? "workspace.nativeBlocks" : "workspace.mainContext",
        ),
      })))
      const categories = document.createElement("ul")
      for (const category of disclosure.categories) {
        const item = document.createElement("li")
        item.append(text(options.t(DISCLOSURE_KEYS[category])))
        categories.append(item)
      }
      review.append(disclosureHeading, summary, categories)
    }

    const resolutionMessage = document.createElement("p")
    resolutionMessage.dataset.apcConsentResolution =
      bindingStatus === "stale"
        ? "stale"
        : resolutionPending || contextMutationPending
          ? "pending"
          : resolutionFailed || !resolutionFresh ? "missing" : bindingStatus
    if (bindingStatus === "stale") {
      resolutionMessage.setAttribute("role", "alert")
      resolutionMessage.append(text(options.t("privacy.revisionChanged")))
    } else if (resolutionPending || contextMutationPending) {
      resolutionMessage.append(text(options.t("consent.required")))
    } else if (resolutionFailed || !resolutionFresh) {
      if (resolutionFailed) resolutionMessage.setAttribute("role", "alert")
      resolutionMessage.append(text(options.t("consent.required")))
    } else if (bindingStatus === "missing" || !destination || !disclosure) {
      resolutionMessage.setAttribute("role", "alert")
      resolutionMessage.append(text(options.t("consent.required")))
    } else {
      resolutionMessage.append(text(statusLabel(options.t, status)))
    }
    review.append(resolutionMessage)

    const acknowledge = document.createElement("input")
    acknowledge.type = "checkbox"
    acknowledge.checked = acknowledged
    acknowledge.disabled =
      locked ||
      contextMutationPending ||
      resolutionPending ||
      resolutionFailed ||
      !resolutionFresh ||
      options.onResolveConsent === undefined ||
      bindingStatus !== "bound" ||
      !destination ||
      !disclosure
    acknowledge.dataset.apcConsentAcknowledge = "true"
    const acknowledgeLabel = document.createElement("label")
    acknowledgeLabel.className = "apc-checkbox-field"
    acknowledgeLabel.append(acknowledge, text(options.t("consent.acknowledgeDisclosure")))
    review.append(acknowledgeLabel)

    const approve = button(options.t("action.approveConsent"), "apcApproveConsent")
    const ready =
      !contextMutationPending &&
      !resolutionPending &&
      !resolutionFailed &&
      resolutionFresh &&
      options.onResolveConsent !== undefined &&
      bindingStatus === "bound" &&
      destination !== undefined &&
      disclosure !== undefined &&
      options.onApproveConsent !== undefined
    approve.disabled = locked || !ready || !acknowledged || status === "approved" || approvalIsPending
    review.append(approve)
    listen(acknowledge, "change", () => {
      acknowledged = acknowledge.checked
      approve.disabled = locked || !ready || !acknowledged || status === "approved" || approvalPending?.contextKey === consentContextKey
    })
    listen(approve, "click", () => {
      if (destroyed || approve.disabled || !ready || !options.onApproveConsent) return
      const token = ++approvalGeneration
      approvalPending = {
        contextKey: consentContextKey,
        authorityFloor: snapshot.consentAuthorityGeneration,
        token,
        startStatus: authoritativeStatus,
        expectedStatus: "approved",
        settled: false,
      }
      approve.disabled = true
      announce(options.t("action.approveConsent"))
      const approvalSelector = makeSelector(snapshot, thread, sourceKey)
      void Promise.resolve()
        .then(() => options.onApproveConsent?.(approvalSelector))
        .then(() => {
          if (
            destroyed ||
            approvalPending?.token !== token ||
            approvalPending.contextKey !== consentContextKey ||
            currentConsentContextKey !== consentContextKey ||
            currentSnapshot === null
          ) return
          approvalPending.settled = true
          renderInternal(currentSnapshot, reviewOpen ? "consent-approve" : undefined)
        })
        .catch(() => {
          if (
            destroyed ||
            approvalPending?.token !== token ||
            approvalPending.contextKey !== consentContextKey ||
            currentConsentContextKey !== consentContextKey ||
            currentSnapshot === null
          ) return
          approvalPending = null
          renderInternal(currentSnapshot, reviewOpen ? "consent-approve" : "consent-trigger")
          announce(options.t("error.connection"))
        })
    })

    if (status === "approved") {
      const revoke = button(options.t("action.revokeConsent"), "apcRevokeConsent")
      revoke.disabled = locked || options.onRevokeConsent === undefined || revokePending !== null
      review.append(revoke)
      listen(revoke, "click", () => {
        if (destroyed || revoke.disabled || !options.onRevokeConsent) return
        const token = ++revokeGeneration
        revokePending = {
          contextKey: consentContextKey,
          authorityFloor: snapshot.consentAuthorityGeneration,
          token,
          settled: false,
          startStatus: authoritativeStatus,
          expectedStatus: "revoked",
        }
        revoke.disabled = true
        announce(options.t("action.revokeConsent"))
        const revokeSelector = makeSelector(snapshot, thread, sourceKey)
        void Promise.resolve()
          .then(() => options.onRevokeConsent?.(revokeSelector))
          .then(() => {
            if (
              destroyed ||
              revokePending?.token !== token ||
              revokePending.contextKey !== consentContextKey ||
              currentConsentContextKey !== consentContextKey ||
              currentSnapshot === null
            ) return
            revokePending.settled = true
            renderInternal(currentSnapshot, reviewOpen ? "consent-heading" : undefined)
          })
          .catch(() => {
            if (
              destroyed ||
              revokePending?.token !== token ||
              revokePending.contextKey !== consentContextKey ||
              currentConsentContextKey !== consentContextKey ||
              currentSnapshot === null
            ) return
            revokePending = null
            renderInternal(currentSnapshot, reviewOpen ? "consent-heading" : "consent-trigger")
            announce(options.t("error.connection"))
          })
      })
    }
    const close = button(options.t("action.cancel"), "apcCloseConsentReview")
    review.append(close)
    listen(close, "click", () => {
      if (destroyed) return
      reviewOpen = false
      if (currentSnapshot !== null) renderInternal(currentSnapshot, "consent-trigger")
    })
    parent.append(review)
  }

  function setBlocked(reason: ThreadEditorMessage): void {
    destroyLoom()
    clearListeners()
    element.replaceChildren()
    const banner = document.createElement("p")
    banner.dataset.apcBlocked = "true"
    banner.setAttribute("role", "alert")
    banner.append(text(options.t(reason.key, reason.values)))
    element.append(banner)
  }

  function renderInternal(
    snapshot: ThreadEditorSnapshot,
    focusTarget?: "consent-heading" | "consent-trigger" | "consent-approve" | "thread-heading",
  ): void {
    if (destroyed) return
    const focusBookmark = focusTarget === undefined ? captureFocusBookmark() : null
    validateSnapshot(snapshot, host, options.presetId)
    if (
      currentSnapshot !== null &&
      (
        snapshot.contextAuthorityGeneration < currentSnapshot.contextAuthorityGeneration ||
        snapshot.consentAuthorityGeneration < currentSnapshot.consentAuthorityGeneration
      )
    ) return
    currentSnapshot = snapshot
    renderGeneration += 1
    if (
      contextMutation?.settled &&
      renderGeneration > contextMutation.renderFloor &&
      snapshot.contextAuthorityGeneration > contextMutation.authorityFloor &&
      contextMutation.matches(snapshot)
    ) {
      contextMutation = null
    }
    element.dataset.apcConsentContextMutation = contextMutation === null
      ? "idle"
      : contextMutation.settled ? "awaiting-authoritative" : "pending"
    element.setAttribute("aria-label", options.t("threadEditor.ariaLabel"))
    if (snapshot.blockedReason) {
      setBlocked(snapshot.blockedReason)
      return
    }

    clearListeners()
    clearRenderSurface()
    liveRegion = document.createElement("p")
    liveRegion.dataset.apcThreadLiveRegion = "true"
    liveRegion.setAttribute("role", "status")
    liveRegion.setAttribute("aria-live", "polite")

    const selected = snapshot.threads.find((thread) => thread.id === snapshot.selectedThreadId) ?? null
    if (!selected) {
      destroyLoom()
      const empty = document.createElement("p")
      empty.dataset.apcThreadEmpty = "true"
      empty.append(text(options.t("threadEditor.selectPrompt")))
      element.append(empty, liveRegion)
      return
    }
    const expectedWorkspaceId = buildThreadWorkspaceId(host.extensionInstallationId, snapshot.presetId, selected.id)
    const reuseWorkspace =
      selected.workspaceSource === "native-blocks" &&
      loomWorkspace !== null &&
      loomHandle !== null &&
      mountedWorkspaceId === expectedWorkspaceId &&
      mountedThreadId === selected.id &&
      loomWorkspace.isConnected
    let workspace: HTMLElement
    if (reuseWorkspace) {
      workspace = loomWorkspace as HTMLElement
    } else {
      if (loomWorkspace || loomHandle || loomTarget) destroyLoom()
      workspace = document.createElement("section")
      loomWorkspace = workspace
    }

    const locked = snapshot.readOnly || snapshot.mutationLocked === true
    const contextLocked =
      locked ||
      contextMutation !== null ||
      reviewOpen ||
      consentResolvePending !== null ||
      approvalPending !== null ||
      revokePending !== null
    element.dataset.apcMutationLocked = String(locked)
    const selectedSlot = selected.connectionSlotId === undefined
      ? undefined
      : snapshot.slots.find((candidate) => candidate.id === selected.connectionSlotId)
    const header = document.createElement("header")
    header.className = "apc-thread-workspace-header"
    const back = button(options.t("agentGraph.title"), "apcBackToGraph")
    back.disabled = options.onBackToGraph === undefined
    const eyebrow = document.createElement("p")
    eyebrow.append(text(options.t("threadEditor.title")))
    const heading = document.createElement("h2")
    heading.tabIndex = -1
    heading.dataset.apcThreadWorkspaceHeading = "true"
    heading.append(text(selected.name || options.t("graph.defaultThreadName", { index: 1 })))
    const context = document.createElement("p")
    context.dataset.apcThreadContext = "true"
    context.append(
      text(options.t(selected.workspaceSource === "native-blocks" ? "workspace.nativeBlocks" : "workspace.mainContext")),
      text(" · "),
      text(selectedSlot?.label ?? options.t("threadEditor.mainConnection")),
    )
    header.append(back, eyebrow, heading, context)
    appendBeforeWorkspace(header)
    listen(back, "click", () => {
      if (destroyed || !options.onBackToGraph) return
      announce(options.t("agentGraph.title"))
      invoke(options.onBackToGraph)
    })

    let executionLockStatus: HTMLElement | null = null
    if (snapshot.mutationLocked) {
      const lock = document.createElement("p")
      lock.tabIndex = -1
      lock.dataset.apcExecutionLock = "true"
      lock.setAttribute("role", "status")
      lock.append(text(options.t("status.busy")))
      executionLockStatus = lock
      appendBeforeWorkspace(lock)
    }

    const details = document.createElement("section")
    details.className = "apc-thread-identity"
    details.dataset.apcThreadIdentity = "true"
    const name = document.createElement("input")
    name.type = "text"
    name.value = selected.name
    name.dataset.apcThreadName = "true"
    name.readOnly = locked || options.onRename === undefined
    appendLabel(details, options.t("threadEditor.threadName"), name)
    listen(name, "change", () => {
      if (locked || destroyed || !options.onRename) return
      invoke(() => options.onRename!(selected.id, { name: name.value }))
    })
    const description = document.createElement("textarea")
    description.value = selected.description
    description.dataset.apcThreadDescription = "true"
    description.readOnly = locked || options.onRename === undefined
    appendLabel(details, options.t("threadEditor.description"), description)
    listen(description, "change", () => {
      if (locked || destroyed || !options.onRename) return
      invoke(() => options.onRename!(selected.id, { description: description.value }))
    })

    const workspaceChoices = document.createElement("fieldset")
    workspaceChoices.className = "apc-workspace-source"
    workspaceChoices.dataset.apcWorkspaceSourceControl = "true"
    const workspaceLegend = document.createElement("legend")
    workspaceLegend.append(text(options.t("graph.workspace")))
    workspaceChoices.append(workspaceLegend)
    for (const source of ["native-blocks", "main-context"] as const) {
      const control = document.createElement("input")
      control.type = "radio"
      control.name = "apc-thread-workspace-source"
      control.value = source
      control.checked = selected.workspaceSource === source
      control.disabled = contextLocked || options.onWorkspaceSourceChange === undefined
      control.dataset.apcWorkspaceSourceOption = source
      const label = document.createElement("label")
      label.className = "apc-radio-field"
      label.append(control, text(options.t(source === "native-blocks" ? "workspace.nativeBlocks" : "workspace.mainContext")))
      workspaceChoices.append(label)
      listen(control, "change", () => {
        if (contextLocked || destroyed || !options.onWorkspaceSourceChange || !control.checked || source === selected.workspaceSource) return
        beginConsentContextMutation(
          snapshot,
          () => options.onWorkspaceSourceChange!(selected.id, source),
          options.t("a11y.changeThreadWorkspaceUpdated"),
          (candidate) =>
            matchesSelectedThreadContext(candidate, selected.id, source, selected.connectionSlotId),
        )
      })
    }
    details.append(workspaceChoices)

    const output = document.createElement("output")
    output.dataset.apcThreadOutput = "true"
    output.append(text(options.t("graph.defaultFinalResponseName")))
    details.append(output)
    appendBeforeWorkspace(details)

    const connection = document.createElement("fieldset")
    connection.className = "apc-thread-connection"
    connection.dataset.apcConnection = "true"
    const connectionLegend = document.createElement("legend")
    connectionLegend.append(text(options.t("threadEditor.connectionConsent")))
    connection.append(connectionLegend)

    const slotSelect = document.createElement("select")
    slotSelect.dataset.apcConnectionSlot = "true"
    slotSelect.disabled = contextLocked || options.onConnectionSlotChange === undefined
    const inherited = document.createElement("option")
    inherited.value = "main"
    inherited.textContent = options.t("threadEditor.mainConnection")
    slotSelect.append(inherited)
    let selectedSlotToken = "main"
    snapshot.slots.forEach((slot, index) => {
      const token = `connection-source-${index + 1}`
      const option = document.createElement("option")
      option.value = token
      option.textContent = slot.label
      slotSelect.append(option)
      if (slot.id === selected.connectionSlotId) selectedSlotToken = token
    })
    slotSelect.value = selectedSlotToken
    appendLabel(connection, options.t("threadEditor.connectionSlot"), slotSelect)
    listen(slotSelect, "change", () => {
      if (contextLocked || destroyed || !options.onConnectionSlotChange) return
      const index = slotSelect.value === "main" ? -1 : Number(slotSelect.value.slice("connection-source-".length)) - 1
      const nextSlot = index < 0 ? undefined : snapshot.slots[index]
      beginConsentContextMutation(
        snapshot,
        () => options.onConnectionSlotChange!(selected.id, nextSlot?.id),
        options.t("a11y.changeThreadConnectionUpdated"),
        (candidate) =>
          matchesSelectedThreadContext(candidate, selected.id, selected.workspaceSource, nextSlot?.id),
      )
    })

    const slot = selectedSlot
    const sourceKey: "main" | `slot:${string}` = slot ? `slot:${slot.id}` : "main"
    if (slot) {
      const hostSelect = document.createElement("select")
      hostSelect.dataset.apcHostConnection = "true"
      hostSelect.disabled = contextLocked || snapshot.connections.length === 0
      const choose = document.createElement("option")
      choose.value = ""
      choose.textContent = snapshot.connections.length === 0
        ? options.t("threadEditor.noConnections")
        : options.t("threadEditor.chooseConnection")
      hostSelect.append(choose)
      let selectedConnectionToken = ""
      snapshot.connections.forEach((candidate, index) => {
        const token = `connection-choice-${index + 1}`
        const option = document.createElement("option")
        option.value = token
        option.textContent = [candidate.name, candidate.provider, candidate.model].filter((value) => value.length > 0).join(" · ")
        hostSelect.append(option)
        if (candidate.id === slot.boundConnectionId) selectedConnectionToken = token
      })
      hostSelect.value = selectedConnectionToken
      appendLabel(connection, options.t("threadEditor.hostConnection"), hostSelect)

      let pendingConnectionId = slot.boundConnectionId ?? null
      const bind = button(slot.bound ? options.t("action.rebindConnection") : options.t("action.bindConnection"), "apcBind")
      bind.disabled = contextLocked || pendingConnectionId === null || options.onBind === undefined
      connection.append(bind)
      listen(hostSelect, "change", () => {
        const index = Number(hostSelect.value.slice("connection-choice-".length)) - 1
        pendingConnectionId = snapshot.connections[index]?.id ?? null
        bind.disabled = contextLocked || pendingConnectionId === null || options.onBind === undefined
      })
      listen(bind, "click", () => {
        if (contextLocked || destroyed || pendingConnectionId === null || !options.onBind) return
        const connectionId = pendingConnectionId
        beginConsentContextMutation(
          snapshot,
          () => options.onBind!(slot.id, connectionId),
          options.t(slot.bound ? "action.rebindConnection" : "action.bindConnection"),
          (candidate) => {
            if (!matchesSelectedThreadContext(candidate, selected.id, selected.workspaceSource, slot.id)) return false
            const resolvedSlot = candidate.slots.find((candidateSlot) => candidateSlot.id === slot.id)
            return resolvedSlot?.bound === true && resolvedSlot.boundConnectionId === connectionId
          },
        )
      })
      if (slot.bound) {
        const boundConnection = snapshot.connections.find((candidate) => candidate.id === slot.boundConnectionId)
        if (boundConnection) {
          const bound = document.createElement("output")
          bound.dataset.apcBoundConnection = "true"
          bound.append(text(options.t("threadEditor.boundConnection", { name: boundConnection.name })))
          connection.append(bound)
        }
        const unbind = button(options.t("action.unbindConnection"), "apcUnbind")
        unbind.disabled = contextLocked || options.onUnbind === undefined
        connection.append(unbind)
        listen(unbind, "click", () => {
          if (contextLocked || destroyed || !options.onUnbind) return
          beginConsentContextMutation(
            snapshot,
            () => options.onUnbind!(slot.id),
            options.t("action.unbindConnection"),
            (candidate) => {
              if (!matchesSelectedThreadContext(candidate, selected.id, selected.workspaceSource, slot.id)) return false
              const resolvedSlot = candidate.slots.find((candidateSlot) => candidateSlot.id === slot.id)
              return resolvedSlot !== undefined &&
                !resolvedSlot.bound &&
                resolvedSlot.boundConnectionId === undefined
            },
          )
        })
      }
    }
    const refresh = button(options.t("action.refreshConnections"), "apcRefreshConnections")
    refresh.disabled = contextLocked || options.onRefreshConnections === undefined
    connection.append(refresh)
    listen(refresh, "click", () => {
      if (contextLocked || destroyed || !options.onRefreshConnections) return
      beginConsentContextMutation(
        snapshot,
        () => options.onRefreshConnections!(),
        options.t("action.refreshConnections"),
        (candidate) =>
          matchesSelectedThreadContext(
            candidate,
            selected.id,
            selected.workspaceSource,
            selected.connectionSlotId,
          ),
      )
    })
    renderConsentReview(snapshot, selected, sourceKey, slot, connection, locked)
    appendBeforeWorkspace(connection)

    workspace.className = "apc-thread-workspace"
    workspace.dataset.apcWorkspace = "true"
    if (workspace.parentElement !== element) element.append(workspace)
    const loomLocked = locked || options.onDirty === undefined
    workspace.setAttribute("aria-readonly", String(selected.workspaceSource === "main-context" || loomLocked))
    ensureLoom(snapshot, selected, workspace, loomLocked)

    if (snapshot.selectedRun) renderRunConfiguration(selected, snapshot.selectedRun, element, locked)
    element.append(liveRegion)

    if (focusTarget === "consent-heading") {
      if (!focusElement(element.querySelector("[data-apc-consent-review-heading]"))) focusElement(back)
    } else if (focusTarget === "consent-trigger") {
      if (!reviewTrigger || reviewTrigger.disabled || !focusElement(reviewTrigger)) focusElement(back)
    } else if (focusTarget === "consent-approve") {
      const approve = element.querySelector<HTMLButtonElement>("[data-apc-approve-consent]")
      if (!approve || approve.disabled || !focusElement(approve)) {
        focusElement(executionLockStatus ?? back)
      }
    } else if (focusTarget === "thread-heading") {
      if (!focusElement(heading)) focusElement(back)
    } else if (focusConsentTriggerOnRender) {
      focusConsentTriggerOnRender = false
      if (!reviewTrigger || reviewTrigger.disabled || !focusElement(reviewTrigger)) focusElement(back)
    } else {
      const restored = restoreFocusBookmark(focusBookmark)
      const active = document.activeElement
      if (
        !restored &&
        snapshot.mutationLocked &&
        (focusBookmark !== null || active === null || !active.isConnected)
      ) {
        focusElement(executionLockStatus ?? heading)
      }
    }
  }

  function render(snapshot: ThreadEditorSnapshot): void {
    renderInternal(snapshot)
  }

  async function flush(): Promise<void> {
    if (destroyed) return
    while (!destroyed) {
      captureLoom()
      for (const [threadId, value] of dirtyValues) reportDirty(threadId, value)
      await awaitDirtyWrites()
      if (destroyed) return
      const flushedGeneration = dirtyGeneration
      if (destroyed) return
      if (options.onFlush) {
        await options.onFlush()
        if (destroyed) return
      }
      if (flushedGeneration !== dirtyGeneration) continue
      dirtyValues.clear()
      reportedValues.clear()
      return
    }
  }

  function destroy(): void {
    if (destroyed) return
    destroyed = true
    clearListeners()
    destroyLoom()
    dirtyValues.clear()
    reportedValues.clear()
    currentSnapshot = null
    element.replaceChildren()
    element.remove()
  }

  return Object.freeze({ element, render, flush, destroy })
}
