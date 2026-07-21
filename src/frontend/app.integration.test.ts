// @ts-ignore Bun provides the test module at runtime; extension bundles exclude tests.
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { JSDOM } from "jsdom"
import type {
  SpindleFrontendContext,
  SpindleHostDescriptorV1,
  SpindleLoomBlockEditorHandle,
  SpindleLoomBlockEditorOptions,
  SpindlePresetEditorExtensionState,
  SpindlePresetEditorScopedHelper,
  SpindlePresetEditorTabHandle,
  SpindlePresetEditorTabOptions,
  SpindlePresetEditorToolbarItemHandle,
  SpindlePresetEditorToolbarItemOptions,
} from "lumiverse-spindle-types"
import { setup } from "../frontend"
import { createApcApp, inspectorStatus } from "./app"
import {
  createBackendActivityResponse,
  PROTOCOL_VERSION,
  decodeFrontendIntent,
  type ActivityRunStatus,
  type BackendActivityUsage,
  type BackendActivityResponse,
  type BackendBindingResponse,
  type BackendCancellationResponse,
  type BackendConnectionListResponse,
  type BackendConsentResponse,
  type BackendHydrationResponse,
  type ConnectionSummary,
  type ConsentSelector,
  type FrontendMessage,
} from "../protocol/messages"
import { createApcTranslator, type ApcLocale } from "../i18n/catalogs"
import { createDefaultApcConfig, type ApcPresetConfigV1, type ApcThreadV1 } from "../config/schema"
import { validateConfigForMode } from "../config/validate"

const browser = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
})
const globals = globalThis as unknown as Record<string, unknown>
const previousGlobals = new Map<string, unknown>([
  ["window", globals.window],
  ["document", globals.document],
  ["Node", globals.Node],
  ["HTMLElement", globals.HTMLElement],
  ["HTMLInputElement", globals.HTMLInputElement],
  ["HTMLSelectElement", globals.HTMLSelectElement],
  ["HTMLTextAreaElement", globals.HTMLTextAreaElement],
  ["HTMLButtonElement", globals.HTMLButtonElement],
  ["Event", globals.Event],
  ["MouseEvent", globals.MouseEvent],
  ["KeyboardEvent", globals.KeyboardEvent],
])
globals.window = browser.window
globals.document = browser.window.document
globals.Node = browser.window.Node
globals.HTMLElement = browser.window.HTMLElement
globals.HTMLInputElement = browser.window.HTMLInputElement
globals.HTMLSelectElement = browser.window.HTMLSelectElement
globals.HTMLTextAreaElement = browser.window.HTMLTextAreaElement
globals.HTMLButtonElement = browser.window.HTMLButtonElement
globals.Event = browser.window.Event
globals.MouseEvent = browser.window.MouseEvent
globals.KeyboardEvent = browser.window.KeyboardEvent

const PRESET_A = "550e8400-e29b-41d4-a716-446655440000"
const PRESET_B = "550e8400-e29b-41d4-a716-446655440001"
const THREAD_A = "550e8400-e29b-41d4-a716-446655440002"
const THREAD_B = "550e8400-e29b-41d4-a716-446655440003"
const SLOT_ID = "550e8400-e29b-41d4-a716-446655440004"
const PIPELINE_ID = "550e8400-e29b-41d4-a716-446655440005"
const STAGE_ID = "550e8400-e29b-41d4-a716-446655440006"
const RUN_ID = "550e8400-e29b-41d4-a716-446655440007"
const STAGE_B_ID = "550e8400-e29b-41d4-a716-446655440014"
const RUN_B_ID = "550e8400-e29b-41d4-a716-446655440015"
const THREAD_C = "550e8400-e29b-41d4-a716-446655440016"
const RUN_C_ID = "550e8400-e29b-41d4-a716-446655440017"
const RUN_D_ID = "550e8400-e29b-41d4-a716-446655440018"
const EXECUTION_B_ID = "550e8400-e29b-41d4-a716-446655440019"
const EXECUTION_ID = "550e8400-e29b-41d4-a716-446655440008"
const TRACE_ID = "550e8400-e29b-41d4-a716-446655440013"
const EVENT_CORRELATION_ID = "550e8400-e29b-41d4-a716-446655440009"
const INSTALLATION_ID = "550e8400-e29b-41d4-a716-446655440010"
const CONNECTION_ID = "550e8400-e29b-41d4-a716-446655440011"
const HOSTILE_CONNECTION_ID = "550e8400-e29b-41d4-a716-446655440012"

const CONNECTION: ConnectionSummary = {
  id: CONNECTION_ID,
  name: "Current connection",
  provider: "openai",
  model: "gpt-5",
}
const HOSTILE_CONNECTION: ConnectionSummary = {
  id: HOSTILE_CONNECTION_ID,
  name: "Hostile connection",
  provider: "unknown",
  model: "hostile-model",
}

function graphConfig(
  label: "A" | "B",
  activeMode: "single" | "sequential" | "parallel" = "parallel",
): ApcPresetConfigV1 {
  const config = createDefaultApcConfig()
  const thread = (id: string, name: string, workspaceSource: ApcThreadV1["workspaceSource"]): ApcThreadV1 => ({
    id,
    name,
    description: `${label} description`,
    workspaceSource,
    connectionSlotId: SLOT_ID,
    blocks: [],
    promptVariableValues: {},
    output: { id: "final", name: "Final Response" },
  })
  const pipeline = {
    id: PIPELINE_ID,
    stages: [
      {
        id: STAGE_ID,
        name: `${label} research`,
        runs: [{ id: RUN_ID, threadId: THREAD_A, required: true, timeoutMs: 60_000, inputs: [] }],
      },
      {
        id: STAGE_B_ID,
        name: `${label} synthesis`,
        runs: [{
          id: RUN_B_ID,
          threadId: THREAD_B,
          required: true,
          timeoutMs: 90_000,
          inputs: [{ source: "output" as const, runId: RUN_ID, role: "user" as const, onMissing: "fail-graph" as const }],
        }],
      },
    ],
    finalResponse: { source: "thread" as const, runId: RUN_B_ID },
  }
  config.supportedModes = ["single", "sequential", "parallel"]
  config.activeMode = activeMode
  config.connectionSlots = [{ id: SLOT_ID, label: `${label} connection`, hint: { provider: "openai", model: "gpt-5" } }]
  config.threads = [thread(THREAD_A, `${label} Research`, "native-blocks"), thread(THREAD_B, `${label} Context`, "main-context")]
  config.pipelines = { sequential: pipeline, parallel: structuredClone(pipeline) }
  return config
}

class FakePresetEditor implements SpindlePresetEditorScopedHelper {
  #state: SpindlePresetEditorExtensionState = {
    open: true,
    presetId: null,
    activeTabId: null,
    blocks: [],
    promptVariableValues: {},
    metadata: null,
  }
  readonly #listeners = new Set<(state: SpindlePresetEditorExtensionState) => void>()
  flushCount = 0
  builtinActivations: string[] = []
  #flushBarrier: Promise<void> | null = null
  #queuedFlushBarriers: Array<Readonly<{
    promise: Promise<void>
    release: () => void
  }>> = []
  #releaseFlush: (() => void) | null = null
  #flushFailure: Error | null = null

  getState(): SpindlePresetEditorExtensionState {
    return structuredClone(this.#state)
  }

  onChange(listener: (state: SpindlePresetEditorExtensionState) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  setMetadata(value: Record<string, unknown>): void {
    this.#state = { ...this.#state, metadata: structuredClone(value) }
    this.#notify()
  }

  updateMetadata(mutator: (current: unknown) => Record<string, unknown>): void {
    this.#state = { ...this.#state, metadata: structuredClone(mutator(structuredClone(this.#state.metadata))) }
    this.#notify()
  }

  activateBuiltinTab(tab: "blocks"): void {
    this.builtinActivations.push(tab)
    this.#state = { ...this.#state, activeTabId: tab }
    this.#notify()
  }

  flush(): Promise<void> {
    this.flushCount += 1
    const failure = this.#flushFailure
    this.#flushFailure = null
    if (failure !== null) return Promise.reject(failure)
    if (this.#flushBarrier !== null) return this.#flushBarrier
    return this.#queuedFlushBarriers.shift()?.promise ?? Promise.resolve()
  }
  rejectNextFlush(): void {
    this.#flushFailure = new Error("flush failed")
  }

  blockFlush(): () => void {
    if (this.#flushBarrier !== null) throw new Error("A flush is already blocked")
    this.#flushBarrier = new Promise<void>((resolve) => {
      this.#releaseFlush = resolve
    })
    return () => {
      const release = this.#releaseFlush
      this.#releaseFlush = null
      this.#flushBarrier = null
      release?.()
    }
  }
  deferFlush(): () => void {
    let release!: () => void
    const promise = new Promise<void>((resolve) => { release = resolve })
    this.#queuedFlushBarriers.push({ promise, release })
    return release
  }

  switchPreset(presetId: string | null, metadata: unknown): void {
    this.#state = {
      ...this.#state,
      presetId,
      metadata: structuredClone(metadata),
    }
    this.#notify()
  }

  listenerCount(): number {
    return this.#listeners.size
  }

  #notify(): void {
    const snapshot = this.getState()
    for (const listener of [...this.#listeners]) listener(snapshot)
  }
}

class FakeBackend {
  readonly sent: FrontendMessage[] = []
  rejectNextUnbind = false
  #listeners = new Set<(payload: unknown) => void>()
  #sequence = 0

  send(payload: unknown): void {
    const message = decodeFrontendIntent(payload)
    this.sent.push(message)
    if (message.type === "hydrate_preset") {
      queueMicrotask(() => {
        const response: BackendHydrationResponse = {
          version: PROTOCOL_VERSION,
          type: "hydration",
          correlationId: message.correlationId,
          sequence: ++this.#sequence,
          payload: {
            presetId: message.payload.presetId,
            bindings: [{
              slotId: SLOT_ID,
              bound: true,
              status: "bound",
              descriptor: {
                label: CONNECTION.name,
                provider: CONNECTION.provider,
                model: CONNECTION.model,
              },
            } as BackendHydrationResponse["payload"]["bindings"][number] & { readonly status: "bound" }],
            consents: [
              {
                threadId: THREAD_A,
                workspaceSource: "native-blocks",
                connectionSourceKey: `slot:${SLOT_ID}`,
                status: "required",
                destination: {
                  label: CONNECTION.name,
                  provider: CONNECTION.provider,
                  model: CONNECTION.model,
                },
                disclosure: {
                  version: 1,
                  summary: "The selected thread workspace will send its disclosed context to the current destination.",
                  categories: [
                    "thread",
                    "workspace",
                    "source",
                    "destination",
                    "provider",
                    "model",
                    "input-bindings",
                    "prior-stage-outputs",
                  ],
                },
              },
            ],
          },
        }
        this.respond(response)
      })
      return
    }
    if (message.type === "bind_slot" || message.type === "unbind_slot") {
      if (message.type === "unbind_slot" && this.rejectNextUnbind) {
        this.rejectNextUnbind = false
        queueMicrotask(() => {
          this.respond({
            version: PROTOCOL_VERSION,
            type: "binding",
            correlationId: message.correlationId,
            sequence: ++this.#sequence,
            payload: {
              presetId: message.payload.presetId,
              slotId: message.payload.slotId,
              bound: "invalid",
            },
          })
        })
        return
      }
      queueMicrotask(() => {
        const bound = message.type === "bind_slot"
        const response: BackendBindingResponse = {
          version: PROTOCOL_VERSION,
          type: "binding",
          correlationId: message.correlationId,
          sequence: ++this.#sequence,
          payload: {
            presetId: message.payload.presetId,
            slotId: message.payload.slotId,
            bound,
            status: bound ? "bound" : "missing",
            ...(bound
              ? {
                  descriptor: {
                    label: CONNECTION.name,
                    provider: CONNECTION.provider,
                    model: CONNECTION.model,
                  },
                }
              : {}),
          } as BackendBindingResponse["payload"] & { readonly status: "bound" | "missing" },
        }
        this.respond(response)
      })
      return
    }
    if (message.type === "cancel_execution") {
      const cancellation = message.payload as typeof message.payload & {
        readonly presetId: string
        readonly reason?: "user" | "stop" | "replacement"
      }
      queueMicrotask(() => {
        const response: BackendCancellationResponse = {
          version: PROTOCOL_VERSION,
          type: "cancellation",
          correlationId: message.correlationId,
          sequence: ++this.#sequence,
          payload: {
            executionId: cancellation.executionId,
            presetId: cancellation.presetId,
            accepted: true,
            status: "accepted",
            cancellationSource: cancellation.reason ?? "user",
          },
        }
        this.respond(response)
      })
    }
  }

  onMessage(listener: (payload: unknown) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  requests(type: FrontendMessage["type"]): FrontendMessage[] {
    return this.sent.filter((message) => message.type === type)
  }
  nextSequence(): number {
    return ++this.#sequence
  }


  respond(message: unknown): void {
    for (const listener of [...this.#listeners]) listener(message)
  }

  respondConnections(correlationId: string, connections: readonly ConnectionSummary[]): void {
    const response: BackendConnectionListResponse = {
      version: PROTOCOL_VERSION,
      type: "connections",
      correlationId,
      sequence: ++this.#sequence,
      payload: { connections },
    }
    this.respond(response)
  }

  respondMalformedConnections(correlationId: string, privateCarrierMessage: string): void {
    this.respond({
      version: PROTOCOL_VERSION,
      type: "connections",
      correlationId,
      sequence: ++this.#sequence,
      payload: { connections: privateCarrierMessage },
      privateCarrierMessage,
    })
  }

  respondConsent(
    correlationId: string,
    selector: ConsentSelector,
    status: "approved" | "revoked" | "required",
  ): void {
    if (selector.workspaceSource === undefined || selector.connectionSourceKey === undefined) {
      throw new Error("Expected a fully scoped consent selector")
    }
    const response: BackendConsentResponse = {
      version: PROTOCOL_VERSION,
      type: "consent",
      correlationId,
      sequence: ++this.#sequence,
      payload: {
        presetId: selector.presetId,
        threadId: selector.threadId,
        workspaceSource: selector.workspaceSource,
        connectionSourceKey: selector.connectionSourceKey,
        status,
        destination: {
          label: CONNECTION.name,
          provider: CONNECTION.provider,
          model: CONNECTION.model,
        },
        disclosure: {
          version: 1,
          summary: "The selected thread workspace will send its disclosed context to the current destination.",
          categories: selector.workspaceSource === "native-blocks"
            ? [
                "thread",
                "workspace",
                "source",
                "destination",
                "provider",
                "model",
                "input-bindings",
                "prior-stage-outputs",
              ]
            : [
                "thread",
                "workspace",
                "source",
                "destination",
                "provider",
                "model",
                "main-context",
                "input-bindings",
                "prior-stage-outputs",
              ],
        },
      },
    }
    this.respond(response)
  }

  respondActivity(
    presetId: string,
    phase: BackendActivityResponse["payload"]["phase"],
    outcome: BackendActivityResponse["payload"]["outcome"] = phase === "completed" ? "success" : undefined,
    options: Readonly<{
      runStatus?: ActivityRunStatus
      usage?: BackendActivityUsage
      stageIndex?: number
      runIndex?: number
      runCount?: number
      errorCategory?: BackendActivityResponse["payload"]["errorCategory"]
      runtimeTerminal?: boolean
      executionId?: string
    }> = {},
  ): void {
    const terminal = phase === "completed" || phase === "failed" || phase === "cancelled"
    const response = createBackendActivityResponse({
      correlationId: EVENT_CORRELATION_ID,
      sequence: ++this.#sequence,
      executionId: options.executionId ?? EXECUTION_ID,
      presetId,
      kind: "graph",
      phase,
      terminal,
      traceId: TRACE_ID,
      ...(options.runtimeTerminal
        ? {}
        : {
            provider: "openai",
            model: "gpt-5",
            stageIndex: options.stageIndex ?? 1,
            runIndex: options.runIndex ?? 0,
            runCount: options.runCount ?? 1,
            completedRuns: terminal ? 2 : 1,
            totalRuns: 2,
            remainingBudgetMs: terminal ? 0 : 30_000,
          }),
      ...(options.runStatus === undefined ? {} : { runStatus: options.runStatus }),
      ...(options.usage === undefined ? {} : { usage: options.usage }),
      ...(outcome === undefined ? {} : { outcome }),
      ...(options.errorCategory !== undefined
        ? { errorCategory: options.errorCategory }
        : phase === "failed" ? { errorCategory: "provider" as const } : {}),
      ...(phase === "cancelled"
        ? { cancellationSource: "stop" as const, outcome: "parent-cancel" as const }
        : {}),
    })
    this.respond(response)
  }

  listenerCount(): number {
    return this.#listeners.size
  }
}

class FakeEvents {
  readonly #listeners = new Map<string, Set<(payload: unknown) => void>>()

  on(event: string, listener: (payload: unknown) => void): () => void {
    const listeners = this.#listeners.get(event) ?? new Set<(payload: unknown) => void>()
    listeners.add(listener)
    this.#listeners.set(event, listeners)
    return () => listeners.delete(listener)
  }

  emit(event: string, payload: unknown): void {
    for (const listener of [...(this.#listeners.get(event) ?? [])]) listener(payload)
  }

  listenerCount(): number {
    let count = 0
    for (const listeners of this.#listeners.values()) count += listeners.size
    return count
  }
}

class FakeLocale {
  #listeners = new Set<(locale: ApcLocale) => void>()
  #locale: ApcLocale = "en"
  onSubscribe: (() => void) | null = null
  failSubscribe = false

  get(): ApcLocale {
    return this.#locale
  }

  subscribe(listener: (locale: ApcLocale) => void): () => void {
    if (this.failSubscribe) throw new Error("locale subscription failed")
    this.#listeners.add(listener)
    const onSubscribe = this.onSubscribe
    this.onSubscribe = null
    onSubscribe?.()
    return () => this.#listeners.delete(listener)
  }

  set(locale: ApcLocale): void {
    this.#locale = locale
    for (const listener of [...this.#listeners]) listener(locale)
  }

  listenerCount(): number {
    return this.#listeners.size
  }
}

type LoomMount = {
  readonly target: HTMLElement
  readonly options: SpindleLoomBlockEditorOptions
  handle: SpindleLoomBlockEditorHandle
  destroyed: boolean
  destroyCount: number
}

class FakeUi {
  tab: SpindlePresetEditorTabHandle | null = null
  toolbar: SpindlePresetEditorToolbarItemHandle | null = null
  tabDestroyed = false
  toolbarDestroyed = false
  onSetVisible: (() => void) | null = null
  onActivateRegister: (() => void) | null = null
  tabDestroyCount = 0
  toolbarDestroyCount = 0
  tabActivateCount = 0
  toolbarVisibility: boolean[] = []
  readonly #tabActivationListeners = new Set<() => void>()

  registerPresetEditorTab(options: SpindlePresetEditorTabOptions): SpindlePresetEditorTabHandle {
    const root = browser.window.document.createElement("div")
    root.dataset.hostPresetTab = options.id
    root.dataset.hostTitle = options.title
    browser.window.document.body.append(root)
    const handle: SpindlePresetEditorTabHandle = {
      root,
      tabId: options.id,
      setTitle: (title) => { root.dataset.hostTitle = title },
      activate: () => {
        this.tabActivateCount += 1
        root.dataset.hostActive = "true"
        for (const listener of [...this.#tabActivationListeners]) listener()
      },
      destroy: () => {
        this.tabDestroyCount += 1
        this.tabDestroyed = true
        root.remove()
      },
      onActivate: (listener) => {
        this.#tabActivationListeners.add(listener)
        const onActivateRegister = this.onActivateRegister
        this.onActivateRegister = null
        onActivateRegister?.()
        return () => this.#tabActivationListeners.delete(listener)
      },
    }
    this.tab = handle
    return handle
  }

  registerPresetEditorToolbarItem(options: SpindlePresetEditorToolbarItemOptions): SpindlePresetEditorToolbarItemHandle {
    const root = browser.window.document.createElement("div")
    root.dataset.hostPresetToolbar = options.id
    browser.window.document.body.append(root)
    const handle: SpindlePresetEditorToolbarItemHandle = {
      root,
      itemId: options.id,
      setVisible: (visible) => {
        this.toolbarVisibility.push(visible)
        root.hidden = !visible
        const onSetVisible = this.onSetVisible
        this.onSetVisible = null
        onSetVisible?.()
      },
      destroy: () => {
        this.toolbarDestroyCount += 1
        this.toolbarDestroyed = true
        root.remove()
      },
    }
    this.toolbar = handle
    return handle
  }
}

class HostFixture {
  readonly editor = new FakePresetEditor()
  readonly backend = new FakeBackend()
  readonly events = new FakeEvents()
  readonly locale = new FakeLocale()
  readonly ui = new FakeUi()
  readonly loomMounts: LoomMount[] = []
  onLoomMount: (() => void) | null = null
  readyCalls = 0
  deferReadyCalls = 0
  grantedPermissions = ["interceptor", "generation", "presets", "final_response"]
  #loomCounter = 0
  #permissionRead: Promise<string[]> | null = null
  #releasePermissionRead: ((permissions: string[]) => void) | null = null
  readonly context: SpindleFrontendContext

  constructor() {
    const mountLoomBlockEditor = (target: string | Element, options: SpindleLoomBlockEditorOptions): SpindleLoomBlockEditorHandle => {
      const element = typeof target === "string"
        ? browser.window.document.querySelector<HTMLElement>(target)
        : target instanceof browser.window.HTMLElement
          ? target
          : null
      if (element === null || !element.isConnected) throw new Error("Loom target must be connected")
      let value = structuredClone(options.value)
      const mount: LoomMount = {
        target: element,
        options,
        destroyed: false,
        destroyCount: 0,
        handle: undefined as unknown as SpindleLoomBlockEditorHandle,
      }
      const handle: SpindleLoomBlockEditorHandle = {
        componentId: `loom-${++this.#loomCounter}`,
        element,
        update: (patch) => {
          if (patch.value !== undefined) value = structuredClone(patch.value)
        },
        destroy: () => {
          mount.destroyCount += 1
          mount.destroyed = true
        },
        getValue: () => structuredClone(value),
        refreshMacros: async () => {},
      }
      mount.handle = handle
      this.loomMounts.push(mount)
      const onLoomMount = this.onLoomMount
      this.onLoomMount = null
      onLoomMount?.()
      return handle
    }

    const dom = {
      inject: (target: string | Element, html: string, position: InsertPosition = "beforeend"): Element => {
        const parent = typeof target === "string" ? browser.window.document.querySelector(target) : target
        if (!parent) throw new Error("DOM target not found")
        const wrapper = browser.window.document.createElement("div")
        wrapper.innerHTML = html
        parent.insertAdjacentElement(position, wrapper)
        return wrapper
      },
      uninject: (element: Element) => element.remove(),
      addStyle: (css: string) => {
        const style = browser.window.document.createElement("style")
        style.textContent = css
        browser.window.document.head.append(style)
        return () => style.remove()
      },
      createElement: <K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Record<string, string>) => {
        const element = browser.window.document.createElement(tag)
        for (const [key, value] of Object.entries(attrs ?? {})) element.setAttribute(key, value)
        return element
      },
      createSandboxFrame: () => {
        const element = browser.window.document.createElement("iframe")
        return {
          element,
          setContent: (html: string) => { element.srcdoc = html },
          postMessage: () => {},
          onMessage: () => () => {},
          destroy: () => element.remove(),
        }
      },
      query: (selector: string) => browser.window.document.querySelector(selector),
      queryAll: (selector: string) => [...browser.window.document.querySelectorAll(selector)],
      getMessageId: () => null,
      findMessageElement: () => null,
      listMessageElements: () => [],
      cleanup: () => {},
    } as SpindleFrontendContext["dom"]

    const presetEditor = {
      getState: () => ({
        open: true,
        presetId: this.editor.getState().presetId,
        activeTabId: null,
        preset: null,
      }),
      onChange: () => () => {},
      updatePreset: () => {},
      flush: async () => {},
      extension: this.editor,
    } as SpindleFrontendContext["ui"]["presetEditor"]

    const ui = {
      events: {},
      mount: () => browser.window.document.createElement("div"),
      registerPresetEditorTab: (options: SpindlePresetEditorTabOptions) => this.ui.registerPresetEditorTab(options),
      registerPresetEditorToolbarItem: (options: SpindlePresetEditorToolbarItemOptions) => this.ui.registerPresetEditorToolbarItem(options),
      presetEditor,
    } as unknown as SpindleFrontendContext["ui"]

    const components = { mountLoomBlockEditor } as unknown as SpindleFrontendContext["components"]
    this.context = {
      host: {
        descriptorVersion: 1,
        lumiverseVersion: "1.0.8",
        capabilities: {
          "preset-extension-data-v1": 1,
          "preset-editor-v1": 1,
          "loom-block-editor-v1": 1,
          "generation-assembly-v1": 1,
          "interceptor-context-v1": 1,
          "interceptor-final-response-v1": 1,
          "connection-dispatch-resolution-v1": 1,
        },
        extensionInstallationId: INSTALLATION_ID,
      } satisfies SpindleHostDescriptorV1,
      locale: this.locale,
      dom,
      events: this.events,
      ui,
      components,
      containers: { registerContainer: () => {}, unregisterContainer: () => {} },
      uploads: { pickFile: async () => [] },
      permissions: {
        getGranted: () => this.#permissionRead ?? Promise.resolve([...this.grantedPermissions]),
        request: async (permissions: string[]) => permissions,
      },
      getActiveChat: () => ({ chatId: null, characterId: null }),
      ready: () => { this.readyCalls += 1 },
      deferReady: () => { this.deferReadyCalls += 1 },
      sendToBackend: (payload: unknown) => this.backend.send(payload),
      onBackendMessage: (listener: (payload: unknown) => void) => this.backend.onMessage(listener),
      processes: {} as SpindleFrontendContext["processes"],
      messages: {} as SpindleFrontendContext["messages"],
      characters: { get: async () => null },
      chats: { updateMessage: async () => null },
      manifest: {
        version: "0.1.0",
        name: "Agentic Preset Composer",
        identifier: "agentic_preset_composer",
        author: "TheLiquorPriest",
        github: "https://github.com/TheLiquorPriest/agentic-preset-composer",
        homepage: "https://github.com/TheLiquorPriest/agentic-preset-composer",
        permissions: ["interceptor", "generation", "presets", "final_response"],
      },
    } as unknown as SpindleFrontendContext
  }

  blockPermissionRead(): () => void {
    if (this.#permissionRead !== null) throw new Error("The permission read is already blocked")
    this.#permissionRead = new Promise<string[]>((resolve) => {
      this.#releasePermissionRead = resolve
    })
    return () => {
      const release = this.#releasePermissionRead
      this.#releasePermissionRead = null
      this.#permissionRead = null
      release?.(["interceptor", "generation", "presets", "final_response"])
    }
  }
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}
async function settleUntil(predicate: () => boolean, description: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return
    await settle()
  }
  throw new Error(`Timed out waiting for ${description}`)
}


function click(root: ParentNode, selector: string): void {
  const element = root.querySelector<HTMLElement>(selector)
  expect(element).not.toBeNull()
  element?.dispatchEvent(new browser.window.MouseEvent("click", { bubbles: true }))
}

function clickEnabled(root: ParentNode, selector: string): void {
  const element = root.querySelector<HTMLButtonElement>(selector)
  expect(element).not.toBeNull()
  expect(element?.disabled).toBe(false)
  element?.click()
}

function actionByText(root: ParentNode, action: string, text: string): HTMLElement {
  const match = [...root.querySelectorAll<HTMLElement>(`[data-action="${action}"]`)]
    .find((element) => element.textContent?.includes(text))
  expect(match).toBeDefined()
  if (match === undefined) throw new Error(`Missing ${action} action for ${text}`)
  return match
}

function changeValue(
  control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  value: string | boolean,
): void {
  if (typeof value === "boolean" && control instanceof browser.window.HTMLInputElement) {
    control.checked = value
  } else {
    control.value = String(value)
  }
  control.dispatchEvent(new browser.window.Event("change", { bubbles: true }))
}

function assertDisarmed(fixture: HostFixture): void {
  expect(fixture.ui.tabDestroyed).toBe(true)
  expect(fixture.ui.toolbarDestroyed).toBe(true)
  expect(fixture.backend.listenerCount()).toBe(0)
  expect(fixture.editor.listenerCount()).toBe(0)
  expect(fixture.locale.listenerCount()).toBe(0)
  expect(fixture.events.listenerCount()).toBe(0)
  expect(fixture.loomMounts.every((mount) => mount.destroyed)).toBe(true)
  expect(fixture.loomMounts.every((mount) => mount.destroyCount === 1)).toBe(true)
  expect(browser.window.document.querySelector("[data-apc-app]")).toBeNull()
  expect(browser.window.document.querySelector("[data-apc-inspector]")).toBeNull()
  expect(browser.window.document.querySelector("[data-host-preset-tab]")).toBeNull()
  expect(browser.window.document.querySelector("[data-host-preset-toolbar]")).toBeNull()
  expect(browser.window.document.head.querySelectorAll("style")).toHaveLength(0)
}


beforeEach(() => {
  browser.window.document.body.replaceChildren()
  browser.window.document.head.replaceChildren()
})

describe("APC public frontend application", () => {
  test("fails closed before registration when events or built-in tab activation are unavailable", async () => {
    for (const missing of ["events", "activateBuiltinTab"] as const) {
      const fixture = new HostFixture()
      if (missing === "events") {
        Object.defineProperty(fixture.context.events, "on", { configurable: true, value: undefined })
      } else {
        Object.defineProperty(fixture.context.ui.presetEditor.extension, "activateBuiltinTab", {
          configurable: true,
          value: undefined,
        })
      }

      await expect(createApcApp(fixture.context)).rejects.toMatchObject({ code: "HOST_API_UNAVAILABLE" })
      expect(fixture.deferReadyCalls).toBe(0)
      expect(fixture.readyCalls).toBe(0)
      expect(fixture.ui.tab).toBeNull()
      expect(fixture.ui.toolbar).toBeNull()
      expect(browser.window.document.querySelector("[data-apc-app]")).toBeNull()
    }
  })

  test("destroys partial host registrations when a returned handle is malformed", async () => {
    const malformedTabFixture = new HostFixture()
    const registerTab = malformedTabFixture.ui.registerPresetEditorTab.bind(malformedTabFixture.ui)
    Object.defineProperty(malformedTabFixture.context.ui, "registerPresetEditorTab", {
      configurable: true,
      value: (options: SpindlePresetEditorTabOptions) => {
        const handle = registerTab(options)
        Object.defineProperty(handle, "activate", { configurable: true, value: undefined })
        return handle
      },
    })
    await expect(createApcApp(malformedTabFixture.context)).rejects.toMatchObject({ code: "HOST_API_UNAVAILABLE" })
    expect(malformedTabFixture.ui.tabDestroyCount).toBe(1)
    expect(malformedTabFixture.ui.toolbar).toBeNull()
    expect(browser.window.document.querySelector("[data-apc-app]")).toBeNull()

    const malformedToolbarFixture = new HostFixture()
    const registerToolbar = malformedToolbarFixture.ui.registerPresetEditorToolbarItem.bind(malformedToolbarFixture.ui)
    Object.defineProperty(malformedToolbarFixture.context.ui, "registerPresetEditorToolbarItem", {
      configurable: true,
      value: (options: SpindlePresetEditorToolbarItemOptions) => {
        const handle = registerToolbar(options)
        Object.defineProperty(handle, "setVisible", { configurable: true, value: undefined })
        return handle
      },
    })
    await expect(createApcApp(malformedToolbarFixture.context)).rejects.toMatchObject({ code: "HOST_API_UNAVAILABLE" })
    expect(malformedToolbarFixture.ui.tabDestroyCount).toBe(1)
    expect(malformedToolbarFixture.ui.toolbarDestroyCount).toBe(1)
    expect(browser.window.document.querySelector("[data-apc-app]")).toBeNull()
  })
  test("rejects and disposes a malformed controlled Loom handle at the mount boundary", async () => {
    const fixture = new HostFixture()
    const malformedElements: HTMLElement[] = []
    const mountLoom = fixture.context.components.mountLoomBlockEditor.bind(fixture.context.components)
    Object.defineProperty(fixture.context.components, "mountLoomBlockEditor", {
      configurable: true,
      value: (target: string | Element, options: SpindleLoomBlockEditorOptions) => {
        const handle = mountLoom(target, options)
        const replacement = browser.window.document.createElement("div")
        const parent = typeof target === "string" ? browser.window.document.body : target.parentElement
        parent?.append(replacement)
        malformedElements.push(replacement)
        Object.defineProperty(handle, "element", { configurable: true, value: replacement })
        Object.defineProperty(handle, "getValue", { configurable: true, value: undefined })
        return handle
      },
    })
    const app = await createApcApp(fixture.context)
    fixture.editor.switchPreset(PRESET_A, graphConfig("A"))
    await settleUntil(() => app.state.getSnapshot().hydrated, "malformed Loom fixture hydration")

    app.state.setSelection({ kind: "thread", threadId: THREAD_A })
    await settle()
    click(
      app.root.querySelector<HTMLElement>('[data-apc-thread-surface="configuration"]') as HTMLElement,
      "[data-apc-open-workspace]",
    )
    await settle()
    expect(fixture.loomMounts).toHaveLength(1)
    expect(fixture.loomMounts[0]?.destroyed).toBe(true)
    expect(fixture.loomMounts[0]?.destroyCount).toBe(1)
    expect(fixture.loomMounts[0]?.target.isConnected).toBe(false)
    expect(malformedElements).toHaveLength(1)
    expect(malformedElements[0]?.isConnected).toBe(false)
    expect(app.root.querySelector('[data-apc-pane="workspace"]')?.getAttribute("data-apc-center-surface"))
      .toBe("topology")
    expect(app.root.querySelector('[data-apc-thread-surface="workspace"]')).toBeNull()

    fixture.locale.set("fr")
    await settle()
    expect(fixture.loomMounts).toHaveLength(1)
    click(
      app.root.querySelector<HTMLElement>('[data-apc-thread-surface="configuration"]') as HTMLElement,
      "[data-apc-open-workspace]",
    )
    await settle()
    expect(fixture.loomMounts).toHaveLength(2)
    expect(fixture.loomMounts.every((mount) => mount.destroyed && mount.destroyCount === 1)).toBe(true)
    expect(fixture.loomMounts.every((mount) => !mount.target.isConnected)).toBe(true)
    expect(malformedElements).toHaveLength(2)
    expect(malformedElements.every((element) => !element.isConnected)).toBe(true)

    await app.teardown()
    assertDisarmed(fixture)
  })


  const setupAuthorityLossCases = [
    { label: "permission revocation", event: "PERMISSION_CHANGED", payload: { permission: "presets", granted: false } },
    { label: "disable", event: "EXTENSION_DISABLED", payload: {} },
    { label: "updated", event: "EXTENSION_UPDATED", payload: {} },
    { label: "update", event: "EXTENSION_UPDATE", payload: {} },
    { label: "unload", event: "EXTENSION_UNLOADED", payload: {} },
  ] as const

  for (const { label, event, payload } of setupAuthorityLossCases) {
    test(`cancels setup synchronously on ${label} during the first permission await`, async () => {
      const fixture = new HostFixture()
      const releasePermissionRead = fixture.blockPermissionRead()
      const pendingSetup = setup(fixture.context)
      expect(fixture.deferReadyCalls).toBe(1)
      expect(fixture.events.listenerCount()).toBe(5)
      expect(fixture.ui.tab).toBeNull()
      expect(fixture.ui.toolbar).toBeNull()

      fixture.events.emit(event, payload)
      expect(fixture.events.listenerCount()).toBe(0)
      expect(fixture.ui.tab).toBeNull()
      expect(fixture.ui.toolbar).toBeNull()
      expect(fixture.backend.listenerCount()).toBe(0)
      expect(fixture.editor.listenerCount()).toBe(0)
      expect(fixture.locale.listenerCount()).toBe(0)
      expect(fixture.editor.flushCount).toBe(0)
      expect(browser.window.document.body.childElementCount).toBe(0)
      expect(browser.window.document.head.childElementCount).toBe(0)

      releasePermissionRead()
      await expect(pendingSetup).rejects.toThrow("cancelled before mount")
      expect(fixture.readyCalls).toBe(1)
      expect(fixture.events.listenerCount()).toBe(0)
      expect(browser.window.document.body.childElementCount).toBe(0)
      expect(browser.window.document.head.childElementCount).toBe(0)
    })
  }

  test("coalesces concurrent and repeated active setup for the same context", async () => {
    const fixture = new HostFixture()
    const releasePermissionRead = fixture.blockPermissionRead()
    const firstSetup = setup(fixture.context)
    const concurrentSetup = setup(fixture.context)
    expect(concurrentSetup).toBe(firstSetup)
    expect(fixture.deferReadyCalls).toBe(1)
    expect(fixture.events.listenerCount()).toBe(5)

    releasePermissionRead()
    const firstTeardown = await firstSetup
    expect(await concurrentSetup).toBe(firstTeardown)
    expect(fixture.readyCalls).toBe(1)
    expect(browser.window.document.querySelectorAll("[data-apc-app]")).toHaveLength(1)
    expect(browser.window.document.head.querySelectorAll("style")).toHaveLength(2)

    const repeatedSetup = setup(fixture.context)
    expect(repeatedSetup).toBe(firstSetup)
    expect(await repeatedSetup).toBe(firstTeardown)
    expect(fixture.deferReadyCalls).toBe(1)
    expect(browser.window.document.querySelectorAll("[data-apc-app]")).toHaveLength(1)

    const teardownResult = firstTeardown()
    assertDisarmed(fixture)
    await teardownResult
  })

  test("projects only the final authoritative mode surface across an ABA preset switch", async () => {
    const fixture = new HostFixture()
    const app = await createApcApp(fixture.context)

    fixture.editor.switchPreset(PRESET_A, graphConfig("A", "parallel"))
    fixture.editor.switchPreset(PRESET_B, graphConfig("B", "parallel"))
    fixture.editor.switchPreset(PRESET_A, graphConfig("A", "single"))

    await settleUntil(
      () => app.state.getSnapshot().presetId === PRESET_A &&
        app.state.getSnapshot().hydrated &&
        app.state.getSnapshot().activeMode === "single" &&
        fixture.editor.builtinActivations.at(-1) === "blocks",
      "final ABA Single surface",
    )
    expect(fixture.ui.tabActivateCount).toBe(0)
    expect(fixture.editor.builtinActivations).toEqual(["blocks"])

    await app.teardown()
  })

  test("registers one host toolbar, activates the tab from toolbar interaction, and localizes host surfaces", async () => {
    const fixture = new HostFixture()
    const app = await createApcApp(fixture.context)
    const tabRoot = fixture.ui.tab?.root
    const toolbarRoot = fixture.ui.toolbar?.root
    expect(tabRoot).not.toBeNull()
    expect(toolbarRoot).not.toBeNull()
    expect(toolbarRoot?.querySelectorAll("[data-apc-graph-toolbar-owned=true]")).toHaveLength(1)
    expect(tabRoot?.querySelector(".apc-mode-toolbar")).toBeNull()
    expect(tabRoot?.querySelector("[data-apc-panel=graph] > h2")).toBeNull()
    expect(toolbarRoot?.querySelector("[data-apc-toolbar-label]")).toBeNull()
    expect(fixture.ui.toolbarVisibility.at(-1)).toBe(true)
    expect(toolbarRoot?.hidden).toBe(false)
    const appRoot = app.root
    const panes = [...app.root.children]
      .filter((element): element is HTMLElement => element instanceof browser.window.HTMLElement && element.hasAttribute("data-apc-pane"))
    expect(panes.map((pane) => pane.dataset.apcPane)).toEqual(["navigation", "workspace", "configuration"])
    expect(panes.every((pane) => pane.getAttribute("role") === "region")).toBe(true)
    expect(panes.every((pane) => (pane.getAttribute("aria-label")?.length ?? 0) > 0)).toBe(true)
    expect(app.root.querySelector('[data-apc-pane="configuration"] [data-apc-placeholder=true]')).not.toBeNull()
    expect(app.root.querySelector("[data-apc-inspector]")).toBeNull()
    const appScope = appRoot.getAttribute("data-apc-scope")
    const toolbarScope = toolbarRoot?.getAttribute("data-apc-scope")
    if (appScope === null || toolbarScope === null || toolbarRoot === undefined) {
      throw new Error("Expected scoped APC roots")
    }
    const ownedStyles = [...browser.window.document.head.querySelectorAll<HTMLStyleElement>("[data-apc-owned-style]")]
    expect(ownedStyles).toHaveLength(2)
    expect(ownedStyles.find((style) => style.dataset.apcStyleId === "apc-app")?.textContent)
      .toContain(`[data-apc-scope="${appScope}"]`)
    expect(ownedStyles.find((style) => style.dataset.apcStyleId === "apc-toolbar")?.textContent)
      .toContain(`[data-apc-scope="${toolbarScope}"]`)
    const toolbarStyleText = ownedStyles.find((style) => style.dataset.apcStyleId === "apc-toolbar")?.textContent ?? ""
    expect(toolbarStyleText).toContain("var(--lumiverse-fill-subtle, transparent)")
    expect(toolbarStyleText).toContain("var(--lumiverse-border, currentColor)")
    expect(toolbarStyleText).toContain("var(--lumiverse-accent-fg, var(--lumiverse-text, CanvasText))")
    expect(toolbarStyleText).toContain("var(--lumiverse-accent, var(--lumiverse-primary, Highlight))")
    expect(toolbarStyleText).not.toContain("--surface-secondary")
    expect(toolbarStyleText).not.toContain("--border-subtle")
    expect(toolbarStyleText).not.toContain("--accent-foreground")
    expect(toolbarStyleText).not.toContain("--focus-ring")
    expect(toolbarStyleText).toContain(".apc-mode-toolbar button:focus-visible")

    expect(toolbarStyleText).toContain("container-name: apc-toolbar")
    expect(toolbarStyleText).toContain("@container apc-toolbar (max-width: 48rem)")
    expect(toolbarStyleText).toContain(".apc-disabled-reason")
    expect(toolbarStyleText).toContain("grid-column: 1 / -1")
    expect(toolbarStyleText).toContain("@media (forced-colors: active)")
    expect(toolbarStyleText).toContain("forced-color-adjust: auto")
    fixture.editor.switchPreset(PRESET_A, graphConfig("A"))
    await settleUntil(
      () => app.state.getSnapshot().hydrated && fixture.backend.requests("list_connections").length > 0,
      "toolbar workflow hydration",
    )
    await settleUntil(
      () => fixture.ui.tabActivateCount === 1 && app.state.getSnapshot().activeMode === "parallel",
      "persisted Parallel surface activation",
    )
    expect(app.root.querySelectorAll('[data-apc-graph-surface="navigation"]')).toHaveLength(1)
    expect(app.root.querySelectorAll('[data-apc-graph-surface="topology"]')).toHaveLength(1)
    expect(app.root.querySelectorAll(
      '[data-apc-pane="navigation"] > [data-apc-graph-surface="navigation"]',
    )).toHaveLength(1)
    expect(app.root.querySelectorAll(
      '[data-apc-pane="workspace"] > [data-apc-graph-surface="topology"]',
    )).toHaveLength(1)
    expect(app.root.querySelector(
      '[data-apc-pane="navigation"] [data-apc-graph-surface="topology"], ' +
      '[data-apc-pane="workspace"] [data-apc-graph-surface="navigation"]',
    )).toBeNull()
    expect(app.root.querySelectorAll('[data-apc-thread-surface="configuration"]')).toHaveLength(1)
    expect(app.root.querySelectorAll('[data-apc-thread-surface="workspace"]')).toHaveLength(0)
    expect(app.root.querySelector('[data-apc-pane="navigation"]')?.getAttribute("role")).toBe("region")
    expect(app.root.querySelector('[data-apc-pane="workspace"]')?.getAttribute("role")).toBe("region")
    expect(app.root.querySelector('[data-apc-pane="configuration"]')?.getAttribute("role")).toBe("region")
    const tabActivationsBeforeToolbar = fixture.ui.tabActivateCount
    const connectionRequest = fixture.backend.requests("list_connections").at(-1)
    fixture.backend.respondConnections(connectionRequest?.correlationId ?? "", [CONNECTION])
    await settleUntil(
      () => toolbarRoot?.querySelector<HTMLButtonElement>(
        '[data-action="select-mode"][data-mode="sequential"]',
      )?.disabled === false,
      "Sequential toolbar availability",
    )
    clickEnabled(toolbarRoot as HTMLElement, '[data-action="select-mode"][data-mode="sequential"]')
    await settleUntil(
      () => fixture.ui.tabActivateCount === tabActivationsBeforeToolbar + 1 &&
        app.state.getSnapshot().activeMode === "sequential",
      "Sequential mode activation",
    )
    expect(fixture.ui.tabActivateCount).toBe(tabActivationsBeforeToolbar + 1)
    expect(tabRoot?.dataset.hostActive).toBe("true")
    clickEnabled(toolbarRoot as HTMLElement, '[data-action="select-mode"][data-mode="single"]')
    await settleUntil(
      () => fixture.editor.builtinActivations.at(-1) === "blocks" && app.state.getSnapshot().activeMode === "single",
      "Single mode activation",
    )
    expect(fixture.editor.builtinActivations.at(-1)).toBe("blocks")
    const builtinActivationsBeforeRestore = fixture.editor.builtinActivations.length
    fixture.editor.switchPreset(PRESET_B, graphConfig("B", "single"))
    await settleUntil(
      () => app.state.getSnapshot().presetId === PRESET_B &&
        app.state.getSnapshot().hydrated &&
        fixture.editor.builtinActivations.length === builtinActivationsBeforeRestore + 1,
      "persisted Single surface activation",
    )
    expect(fixture.editor.builtinActivations.at(-1)).toBe("blocks")
    fixture.ui.tab?.activate()
    expect(fixture.ui.toolbarVisibility.at(-1)).toBe(true)
    expect(toolbarRoot?.hidden).toBe(false)

    for (const locale of ["en", "zh", "zh-TW", "ja", "fr", "it"] as const) {
      fixture.locale.set(locale)
      const t = createApcTranslator(() => locale)
      expect(tabRoot?.dataset.hostTitle).toBe(t("agentGraph.title"))
      expect(toolbarRoot?.getAttribute("aria-label")).toBe(t("agentGraph.title"))
      for (const [mode, key] of [
        ["single", "mode.single"],
        ["sequential", "mode.sequential"],
        ["parallel", "mode.parallel"],
      ] as const) {
        expect(toolbarRoot?.querySelector(`[data-mode="${mode}"]`)?.textContent).toContain(t(key))
      }
      expect(app.root.getAttribute("aria-label")).toBe(t("agentGraph.title"))
      expect(app.root.querySelector('[data-apc-pane="navigation"]')?.getAttribute("aria-label"))
        .toBe(t("graph.threadNavigation"))
      expect(app.root.querySelector('[data-apc-pane="workspace"]')?.getAttribute("aria-label"))
        .toBe(t("graph.stages"))
      expect(app.root.querySelector('[data-apc-pane="configuration"]')?.getAttribute("aria-label"))
        .toBe(t("threadEditor.ariaLabel"))
    }

    const result = app.teardown()
    assertDisarmed(fixture)
    expect(fixture.ui.tabDestroyCount).toBe(1)
    expect(fixture.ui.toolbarDestroyCount).toBe(1)
    expect(app.teardown()).toBe(result)
    await result
    expect(appRoot.getAttribute("data-apc-scope")).toBeNull()
    expect(toolbarRoot?.getAttribute("data-apc-scope")).toBeNull()
  })

  test("loads safe trace summaries and details while ignoring a cross-preset stale response", async () => {
    const fixture = new HostFixture()
    const app = await createApcApp(fixture.context)
    fixture.editor.switchPreset(PRESET_A, graphConfig("A"))
    await settleUntil(
      () => app.state.getSnapshot().hydrated && app.state.getSnapshot().presetId === PRESET_A,
      "trace workflow hydration",
    )
    fixture.backend.respondActivity(PRESET_A, "started", undefined, { runStatus: "running" })
    await settle()
    const inspector = app.root.querySelector<HTMLElement>("[data-apc-inspector]")
    expect(inspector?.querySelector("[data-inspector-action=load-traces]")).not.toBeNull()

    click(inspector as HTMLElement, "[data-inspector-action=load-traces]")
    await settleUntil(() => fixture.backend.requests("list_traces").length === 1, "trace list request")
    const listRequest = fixture.backend.requests("list_traces")[0]
    if (listRequest?.type !== "list_traces") throw new Error("Expected a trace list request")
    expect(listRequest.payload).toMatchObject({ presetId: PRESET_A, executionId: EXECUTION_ID })
    fixture.backend.respond({
      version: PROTOCOL_VERSION,
      type: "trace",
      correlationId: listRequest.correlationId,
      sequence: fixture.backend.nextSequence(),
      payload: {
        traces: [{
          traceId: TRACE_ID,
          executionId: EXECUTION_ID,
          presetId: PRESET_A,
          status: "completed",
          startedAt: 1_000,
          finishedAt: 2_500,
          eventCount: 1,
          preview: "Safe trace summary",
        }],
      },
    })
    await settleUntil(
      () => {
        const summary = app.state.getSnapshot().traces.summaries[0]
        return summary?.status === "completed" &&
          summary.eventCount === 1 &&
          !Object.prototype.hasOwnProperty.call(summary, "preview") &&
          inspector?.querySelector(".apc-inspector-trace") !== null
      },
      "safe trace summary projection",
    )
    const traceNode = inspector?.querySelector<HTMLElement>(".apc-inspector-trace")
    expect(traceNode?.dataset.inspectorTracePosition).toBe("1")
    const traceKey = app.state.getSnapshot().traces.summaries[0]?.key
    expect(typeof traceKey).toBe("string")
    if (typeof traceKey !== "string") throw new Error("Expected an opaque trace key")
    expect(traceKey).not.toContain(TRACE_ID)
    expect(traceKey).not.toContain(EXECUTION_ID)
    expect(JSON.stringify(app.state.getSnapshot().traces)).not.toContain(TRACE_ID)
    expect(JSON.stringify(app.state.getSnapshot().traces)).not.toContain(EXECUTION_ID)
    expect(traceNode?.textContent).not.toContain("Safe trace summary")
    expect(traceNode?.textContent).not.toContain(TRACE_ID)
    expect(traceNode?.textContent).not.toContain(EXECUTION_ID)

    click(traceNode as HTMLElement, "[data-inspector-action=load-trace]")
    await settleUntil(() => fixture.backend.requests("get_trace").length === 1, "trace detail request")
    const detailRequest = fixture.backend.requests("get_trace")[0]
    if (detailRequest?.type !== "get_trace") throw new Error("Expected a trace detail request")
    expect(detailRequest.payload).toEqual({
      presetId: PRESET_A,
      executionId: EXECUTION_ID,
      traceId: TRACE_ID,
    })
    fixture.backend.respond({
      version: PROTOCOL_VERSION,
      type: "trace",
      correlationId: detailRequest.correlationId,
      sequence: fixture.backend.nextSequence(),
      payload: {
        trace: {
          traceId: TRACE_ID,
          executionId: EXECUTION_ID,
          presetId: PRESET_A,
          status: "completed",
          startedAt: 1_000,
          finishedAt: 2_500,
          eventCount: 1,
          preview: "Safe trace summary",
          events: [{
            kind: "dispatch",
            sequence: 1,
            timestamp: 1_500,
            status: "private-provider-state",
            preview: "Safe trace event",
          }],
        },
      },
    })
    await settleUntil(
      () => Object.values(app.state.getSnapshot().traces.details)
        .some((detail) => detail.events.length === 1 &&
          !Object.prototype.hasOwnProperty.call(detail, "preview") &&
          !Object.prototype.hasOwnProperty.call(detail.events[0] ?? {}, "preview")),
      "safe trace detail projection",
    )
    expect(inspector?.textContent).not.toContain("Safe trace event")
    expect(inspector?.textContent).not.toContain("private-provider-state")

    click(inspector as HTMLElement, "[data-inspector-action=load-traces]")
    await settleUntil(() => fixture.backend.requests("list_traces").length === 2, "stale trace list request")
    const staleRequest = fixture.backend.requests("list_traces")[1]
    if (staleRequest?.type !== "list_traces") throw new Error("Expected a stale trace list request")
    fixture.editor.switchPreset(PRESET_B, graphConfig("B", "single"))
    await settleUntil(
      () => app.state.getSnapshot().hydrated && app.state.getSnapshot().presetId === PRESET_B,
      "replacement preset hydration",
    )
    fixture.backend.respond({
      version: PROTOCOL_VERSION,
      type: "trace",
      correlationId: staleRequest.correlationId,
      sequence: fixture.backend.nextSequence(),
      payload: {
        traces: [{
          traceId: TRACE_ID,
          executionId: EXECUTION_ID,
          presetId: PRESET_A,
          status: "completed",
          startedAt: 1_000,
          finishedAt: 2_500,
          eventCount: 1,
          preview: "STALE TRACE SHOULD NOT RENDER",
        }],
      },
    })
    await settle()
    expect(app.root.textContent).not.toContain("STALE TRACE SHOULD NOT RENDER")
    expect(app.state.getSnapshot().traces.summaries).toHaveLength(0)

    await app.teardown()
  })


  test("keeps the prior mode surface active when a cross-surface mode save fails", async () => {
    const fixture = new HostFixture()
    const app = await createApcApp(fixture.context)
    fixture.editor.switchPreset(PRESET_A, graphConfig("A"))
    await settle()
    const connectionRequest = fixture.backend.requests("list_connections").at(-1)
    fixture.backend.respondConnections(connectionRequest?.correlationId ?? "", [CONNECTION])
    await settle()
    const toolbar = fixture.ui.toolbar?.root as HTMLElement
    browser.window.document.body.append(toolbar)
    const tabActivationBaseline = fixture.ui.tabActivateCount
    clickEnabled(toolbar, '[data-action="select-mode"][data-mode="parallel"]')
    await settle()
    expect((browser.window.document.activeElement as HTMLElement | null)?.dataset.mode).toBe("parallel")
    expect(fixture.ui.tabActivateCount).toBe(tabActivationBaseline)

    fixture.editor.rejectNextFlush()
    clickEnabled(toolbar, '[data-action="select-mode"][data-mode="single"]')
    expect(fixture.editor.builtinActivations).toHaveLength(0)
    await settleUntil(
      () => app.state.getSnapshot().activeMode === "parallel" &&
        !app.state.getSnapshot().dirty &&
        toolbar.querySelector('[data-mode="parallel"]')?.getAttribute("aria-checked") === "true",
      "failed mode rollback",
    )
    expect(app.state.getSnapshot().activeMode).toBe("parallel")
    expect(toolbar.querySelector('[data-mode="parallel"]')?.getAttribute("aria-checked")).toBe("true")
    expect((browser.window.document.activeElement as HTMLElement | null)?.dataset.mode).toBe("single")
    toolbar.remove()
    expect(fixture.editor.builtinActivations).toHaveLength(0)
    expect(fixture.ui.tabActivateCount).toBe(tabActivationBaseline)

    const teardown = app.teardown()
    assertDisarmed(fixture)
    await teardown
  })

  test("ignores stale mode completion while preserving the latest persisted surface and consent", async () => {
    const fixture = new HostFixture()
    const app = await createApcApp(fixture.context)
    fixture.editor.switchPreset(PRESET_A, graphConfig("A", "single"))
    await settleUntil(
      () => app.state.getSnapshot().hydrated && fixture.backend.requests("list_connections").length > 0,
      "mode transition hydration",
    )
    const connectionRequest = fixture.backend.requests("list_connections").at(-1)
    fixture.backend.respondConnections(connectionRequest?.correlationId ?? "", [CONNECTION])
    const toolbar = fixture.ui.toolbar?.root as HTMLElement
    await settleUntil(
      () => toolbar.querySelector<HTMLButtonElement>(
        '[data-action="select-mode"][data-mode="sequential"]',
      )?.disabled === false,
      "mode transition availability",
    )
    await settle()
    const builtinBaseline = fixture.editor.builtinActivations.length
    const tabActivationBaseline = fixture.ui.tabActivateCount
    app.state.setSelection({ kind: "thread", threadId: THREAD_B })
    const consentBaseline = fixture.backend.requests("resolve_consent").length
    const originalSetActiveMode = app.state.setActiveMode.bind(app.state)
    let modeRequestCount = 0
    Object.defineProperty(app.state, "setActiveMode", {
      configurable: true,
      value: (mode: Parameters<typeof app.state.setActiveMode>[0]) => {
        modeRequestCount += 1
        return originalSetActiveMode(mode)
      },
    })

    const releaseFirstFlush = fixture.editor.blockFlush()
    const releaseSecondFlush = fixture.editor.deferFlush()

    clickEnabled(toolbar, '[data-action="select-mode"][data-mode="parallel"]')
    clickEnabled(toolbar, '[data-action="select-mode"][data-mode="sequential"]')
    expect(app.state.getSnapshot().activeMode).toBe("sequential")
    expect(modeRequestCount).toBe(2)
    expect(fixture.editor.builtinActivations).toHaveLength(builtinBaseline)
    expect(fixture.ui.tabActivateCount).toBe(tabActivationBaseline)

    releaseFirstFlush()
    await settleUntil(
      () => (fixture.editor.getState().metadata as Record<string, unknown>).activeMode === "sequential",
      "superseding mode staged",
    )
    expect(fixture.backend.requests("resolve_consent").slice(consentBaseline)).toHaveLength(0)
    expect(fixture.editor.builtinActivations).toHaveLength(builtinBaseline)
    expect(fixture.ui.tabActivateCount).toBe(tabActivationBaseline)

    releaseSecondFlush()
    await settleUntil(
      () => {
        const snapshot = app.state.getSnapshot()
        return snapshot.activeMode === "sequential" &&
          snapshot.config?.activeMode === "sequential" &&
          !snapshot.dirty &&
          (fixture.editor.getState().metadata as Record<string, unknown>).activeMode === "sequential"
      },
      "latest mode persistence",
    )
    expect(fixture.editor.builtinActivations).toHaveLength(builtinBaseline)
    expect(fixture.ui.tabActivateCount).toBe(tabActivationBaseline + 1)
    await settleUntil(
      () => fixture.backend.requests("resolve_consent").length > consentBaseline,
      "latest mode consent resolution",
    )
    expect(fixture.backend.requests("resolve_consent").slice(consentBaseline)).toHaveLength(1)
    const consent = fixture.backend.requests("resolve_consent").at(-1)
    if (consent?.type !== "resolve_consent") throw new Error("Expected latest mode consent resolution")
    fixture.backend.respondConsent(consent.correlationId, consent.payload, "required")
    await settle()

    const teardown = app.teardown()
    assertDisarmed(fixture)
    await teardown
  })

  test("supersedes a save transition from keyboard radio arrows", async () => {
    const fixture = new HostFixture()
    const app = await createApcApp(fixture.context)
    fixture.editor.switchPreset(PRESET_A, graphConfig("A", "single"))
    await settleUntil(
      () => app.state.getSnapshot().hydrated && fixture.backend.requests("list_connections").length > 0,
      "keyboard mode hydration",
    )
    const connectionRequest = fixture.backend.requests("list_connections").at(-1)
    fixture.backend.respondConnections(connectionRequest?.correlationId ?? "", [CONNECTION])
    const toolbar = fixture.ui.toolbar?.root as HTMLElement
    browser.window.document.body.append(toolbar)
    await settleUntil(
      () => toolbar.querySelector<HTMLButtonElement>(
        '[data-action="select-mode"][data-mode="sequential"]',
      )?.disabled === false,
      "keyboard mode availability",
    )
    const releaseFirstFlush = fixture.editor.blockFlush()
    const releaseSecondFlush = fixture.editor.deferFlush()
    clickEnabled(toolbar, '[data-action="select-mode"][data-mode="sequential"]')
    const sequential = toolbar.querySelector<HTMLElement>('[data-action="select-mode"][data-mode="sequential"]')
    expect(app.state.getSnapshot().busyReason).toBe("save")
    sequential?.dispatchEvent(new browser.window.KeyboardEvent("keydown", {
      bubbles: true,
      key: "ArrowRight",
    }))
    expect(app.state.getSnapshot().activeMode).toBe("parallel")
    expect((browser.window.document.activeElement as HTMLElement | null)?.dataset.mode).toBe("parallel")
    releaseFirstFlush()
    await settleUntil(
      () => (fixture.editor.getState().metadata as Record<string, unknown>).activeMode === "parallel",
      "keyboard superseding mode staged",
    )
    releaseSecondFlush()
    await settleUntil(
      () => {
        const snapshot = app.state.getSnapshot()
        return snapshot.activeMode === "parallel" &&
          snapshot.config?.activeMode === "parallel" &&
          !snapshot.dirty
      },
      "keyboard superseding mode persisted",
    )
    toolbar.remove()
    const teardown = app.teardown()
    assertDisarmed(fixture)
    await teardown
  })

  test("supersedes a pending transition when the same mode is requested again", async () => {
    const fixture = new HostFixture()
    const app = await createApcApp(fixture.context)
    fixture.editor.switchPreset(PRESET_A, graphConfig("A", "single"))
    await settleUntil(
      () => app.state.getSnapshot().hydrated && fixture.backend.requests("list_connections").length > 0,
      "same-mode transition hydration",
    )
    const connectionRequest = fixture.backend.requests("list_connections").at(-1)
    fixture.backend.respondConnections(connectionRequest?.correlationId ?? "", [CONNECTION])
    const toolbar = fixture.ui.toolbar?.root as HTMLElement
    await settleUntil(
      () => toolbar.querySelector<HTMLButtonElement>(
        '[data-action="select-mode"][data-mode="parallel"]',
      )?.disabled === false,
      "same-mode transition availability",
    )
    await settle()
    const builtinBaseline = fixture.editor.builtinActivations.length
    const tabActivationBaseline = fixture.ui.tabActivateCount
    app.state.setSelection({ kind: "thread", threadId: THREAD_B })
    const consentBaseline = fixture.backend.requests("resolve_consent").length
    const originalSetActiveMode = app.state.setActiveMode.bind(app.state)
    let modeRequestCount = 0
    Object.defineProperty(app.state, "setActiveMode", {
      configurable: true,
      value: (mode: Parameters<typeof app.state.setActiveMode>[0]) => {
        modeRequestCount += 1
        return originalSetActiveMode(mode)
      },
    })
    const releaseFlush = fixture.editor.blockFlush()

    clickEnabled(toolbar, '[data-action="select-mode"][data-mode="parallel"]')
    clickEnabled(toolbar, '[data-action="select-mode"][data-mode="parallel"]')
    expect(fixture.editor.builtinActivations).toHaveLength(builtinBaseline)
    expect(fixture.ui.tabActivateCount).toBe(tabActivationBaseline)
    expect(app.state.getSnapshot().activeMode).toBe("parallel")
    expect(modeRequestCount).toBe(2)

    releaseFlush()
    await settleUntil(
      () => {
        const snapshot = app.state.getSnapshot()
        return snapshot.activeMode === "parallel" &&
          snapshot.config?.activeMode === "parallel" &&
          !snapshot.dirty &&
          (fixture.editor.getState().metadata as Record<string, unknown>).activeMode === "parallel"
      },
      "same-mode transition persistence",
    )
    expect(fixture.editor.builtinActivations).toHaveLength(builtinBaseline)
    expect(fixture.ui.tabActivateCount).toBe(tabActivationBaseline + 1)
    await settleUntil(
      () => fixture.backend.requests("resolve_consent").length > consentBaseline,
      "same-mode transition consent resolution",
    )
    expect(fixture.backend.requests("resolve_consent").slice(consentBaseline)).toHaveLength(1)
    const consent = fixture.backend.requests("resolve_consent").at(-1)
    if (consent?.type !== "resolve_consent") throw new Error("Expected same-mode consent resolution")
    fixture.backend.respondConsent(consent.correlationId, consent.payload, "required")
    await settle()

    const teardown = app.teardown()
    assertDisarmed(fixture)
    await teardown
  })

  test("creates the first bounded graph only after the user's explicit first-use action", async () => {
    const fixture = new HostFixture()
    const app = await createApcApp(fixture.context)
    fixture.editor.switchPreset(PRESET_A, createDefaultApcConfig())
    await settle()
    expect(app.root.querySelector('[data-apc-pane="configuration"] [data-apc-placeholder=true]')).not.toBeNull()
    expect(app.state.getSnapshot().config?.threads).toHaveLength(0)
    const topology = app.root.querySelector<HTMLElement>(
      '[data-apc-pane="workspace"] > [data-apc-graph-surface="topology"]',
    )
    expect(topology).not.toBeNull()
    const firstUse = topology?.querySelector<HTMLElement>("[data-apc-graph-empty=true]")
    expect(firstUse).not.toBeNull()
    expect(firstUse?.querySelector(".apc-consent-note")?.textContent?.length ?? 0).toBeGreaterThan(0)
    click(firstUse as HTMLElement, '[data-action="create-graph"][data-mode="parallel"]')
    await settle()
    const config = app.state.getSnapshot().config
    expect(config?.activeMode).toBe("parallel")
    expect(config?.threads).toHaveLength(1)
    expect(config?.pipelines.parallel?.stages).toHaveLength(1)
    expect(config?.pipelines.parallel?.finalResponse.source).toBe("thread")
    expect(app.state.getSnapshot().dirty).toBe(true)
    const teardown = app.teardown()
    assertDisarmed(fixture)
    await teardown
  })

  test("runs the opaque graph-to-thread workflow from one state source without exposing private identity", async () => {
    const fixture = new HostFixture()
    const app = await createApcApp(fixture.context)
    const toolbarRoot = fixture.ui.toolbar?.root as HTMLElement
    expect(app.root.querySelector('[data-apc-pane="configuration"] [data-apc-placeholder=true]')).not.toBeNull()
    expect(app.root.querySelector("[data-apc-inspector]")).toBeNull()

    fixture.editor.switchPreset(PRESET_A, graphConfig("A"))
    await settle()
    const connectionRequest = fixture.backend.requests("list_connections").at(-1)
    expect(connectionRequest).toBeDefined()
    fixture.backend.respondConnections(connectionRequest?.correlationId ?? "", [CONNECTION])
    await settle()
    expect(app.state.getSnapshot().hydrated).toBe(true)
    expect(app.root.querySelector('[data-apc-pane="configuration"] [data-apc-placeholder=true]')).toBeNull()
    const graph = app.root.querySelector<HTMLElement>('[data-apc-graph-surface="navigation"]')
    const topology = app.root.querySelector<HTMLElement>('[data-apc-graph-surface="topology"]')
    let thread = app.root.querySelector<HTMLElement>('[data-apc-thread-surface="configuration"]')
    expect(graph).not.toBeNull()
    expect(thread).not.toBeNull()
    expect(topology).not.toBeNull()
    expect(app.root.querySelectorAll("[data-apc-graph-editor]")).toHaveLength(2)
    expect(app.root.querySelectorAll('[data-apc-thread-surface="configuration"]')).toHaveLength(1)
    expect(app.root.querySelectorAll('[data-apc-thread-surface="workspace"]')).toHaveLength(0)

    actionByText(graph as HTMLElement, "select-thread", "A Research").click()
    await settle()
    expect(app.state.getSnapshot().selection).toEqual({ kind: "thread", threadId: THREAD_A })
    expect(thread?.querySelector<HTMLInputElement>("[data-apc-thread-name]")?.value).toBe("A Research")
    expect(app.root.querySelector("[data-apc-inspector]")).toBeNull()
    expect(fixture.loomMounts.some((mount) => !mount.destroyed)).toBe(false)
    expect(app.root.querySelectorAll("[data-apc-open-workspace]")).toHaveLength(1)
    expect(app.root.querySelectorAll("[data-apc-thread-name]")).toHaveLength(1)
    expect(app.root.querySelectorAll("[data-apc-workspace-source-option]")).toHaveLength(2)
    expect(app.root.querySelectorAll('[data-action="select-thread"]')).toHaveLength(2)

    const mainConsentBaseline = fixture.backend.requests("resolve_consent").length
    const workspaceSourceOptions = [
      ...thread!.querySelectorAll<HTMLInputElement>("[data-apc-workspace-source-option]"),
    ]
    expect(workspaceSourceOptions.map((control) => control.value)).toEqual([
      "workspace-choice-1",
      "workspace-choice-2",
    ])
    const mainContext = workspaceSourceOptions.find((control) => !control.checked)
    expect(mainContext).toBeDefined()
    changeValue(mainContext as HTMLInputElement, true)
    await settleUntil(
      () => app.state.getSnapshot().config?.threads.find((candidate) => candidate.id === THREAD_A)?.workspaceSource ===
          "main-context" &&
        fixture.backend.requests("resolve_consent").slice(mainConsentBaseline).some((request) =>
          request.type === "resolve_consent" &&
          request.payload.workspaceSource === "main-context" &&
          request.payload.connectionSourceKey === `slot:${SLOT_ID}`
        ),
      "Main-context workspace consent",
    )
    const mainConsent = fixture.backend.requests("resolve_consent").slice(mainConsentBaseline)
      .find((request) =>
        request.type === "resolve_consent" &&
        request.payload.workspaceSource === "main-context" &&
        request.payload.connectionSourceKey === `slot:${SLOT_ID}`
      )
    if (mainConsent?.type !== "resolve_consent") throw new Error("Expected Main-context consent resolution")
    fixture.backend.respondConsent(mainConsent.correlationId, mainConsent.payload, "required")
    await settleUntil(
      () => [...thread!.querySelectorAll<HTMLInputElement>("[data-apc-workspace-source-option]")]
        .every((control) => !control.disabled),
      "Main-context workspace settlement",
    )

    const nativeConsentBaseline = fixture.backend.requests("resolve_consent").length
    const nativeBlocks = [
      ...thread!.querySelectorAll<HTMLInputElement>("[data-apc-workspace-source-option]"),
    ].find((control) => !control.checked)
    expect(nativeBlocks).toBeDefined()
    changeValue(nativeBlocks as HTMLInputElement, true)
    await settleUntil(
      () => app.state.getSnapshot().config?.threads.find((candidate) => candidate.id === THREAD_A)?.workspaceSource ===
          "native-blocks" &&
        fixture.backend.requests("resolve_consent").slice(nativeConsentBaseline).some((request) =>
          request.type === "resolve_consent" &&
          request.payload.workspaceSource === "native-blocks" &&
          request.payload.connectionSourceKey === `slot:${SLOT_ID}`
        ),
      "native-blocks workspace consent",
    )
    const nativeConsent = fixture.backend.requests("resolve_consent").slice(nativeConsentBaseline)
      .find((request) =>
        request.type === "resolve_consent" &&
        request.payload.workspaceSource === "native-blocks" &&
        request.payload.connectionSourceKey === `slot:${SLOT_ID}`
      )
    if (nativeConsent?.type !== "resolve_consent") throw new Error("Expected native-blocks consent resolution")
    fixture.backend.respondConsent(nativeConsent.correlationId, nativeConsent.payload, "required")
    await settleUntil(
      () => [...thread!.querySelectorAll<HTMLInputElement>("[data-apc-workspace-source-option]")]
        .every((control) => !control.disabled),
      "native-blocks workspace settlement",
    )

    click(thread as HTMLElement, "[data-apc-open-workspace]")
    await settle()
    const workspace = app.root.querySelector<HTMLElement>('[data-apc-thread-surface="workspace"]')
    expect(workspace).not.toBeNull()
    expect(app.root.querySelector('[data-apc-pane="workspace"]')?.getAttribute("data-apc-center-surface")).toBe("loom")
    expect(graph?.isConnected).toBe(true)
    expect(thread?.isConnected).toBe(true)
    expect(topology?.isConnected).toBe(false)
    expect(app.root.querySelectorAll('[data-apc-thread-surface="configuration"]')).toHaveLength(1)
    expect(app.root.querySelectorAll('[data-apc-thread-surface="workspace"]')).toHaveLength(1)

    const loom = fixture.loomMounts.findLast((mount) => !mount.destroyed)
    const loomValue = { blocks: [], promptVariableValues: { "block-safe": { tone: "focused" } } }
    loom?.options.onChange?.(structuredClone(loomValue))
    await settle()
    expect(app.state.getSnapshot().config?.threads.find((candidate) => candidate.id === THREAD_A)?.promptVariableValues)
      .toEqual(loomValue.promptVariableValues)
    const flushesBeforeLoomSave = fixture.editor.flushCount
    await app.flushWorkspace()
    expect(fixture.editor.flushCount).toBe(flushesBeforeLoomSave + 1)
    fixture.locale.set("fr")
    await settle()
    const frT = createApcTranslator(() => fixture.locale.get())
    expect(app.root.querySelector('[data-apc-pane="workspace"]')?.getAttribute("aria-label"))
      .toBe(frT("threadEditor.workspaceAria", { name: "A Research" }))
    expect(app.root.querySelector('[data-apc-pane="configuration"]')?.getAttribute("aria-label"))
      .toBe(frT("threadEditor.ariaLabel"))
    expect(workspace?.isConnected).toBe(true)
    fixture.locale.set("en")
    await settle()
    click(workspace as HTMLElement, "[data-apc-back-to-graph]")
    await settle()
    expect(app.state.getSnapshot().selection).toEqual({ kind: "thread", threadId: THREAD_A })
    expect(app.root.querySelector('[data-apc-pane="workspace"]')?.getAttribute("data-apc-center-surface"))
      .toBe("topology")
    expect(topology?.isConnected).toBe(true)
    expect(app.root.querySelector('[data-apc-thread-surface="workspace"]')).toBeNull()
    expect(fixture.loomMounts.every((mount) => mount.destroyed)).toBe(true)

    const unbind = thread?.querySelector<HTMLButtonElement>("[data-apc-unbind]")
    expect(unbind).not.toBeNull()
    const consentCountBeforeUnbind = fixture.backend.requests("resolve_consent").length
    expect(unbind?.disabled).toBe(false)
    unbind?.click()
    await settleUntil(
      () => app.state.getSnapshot().connectionBindings[SLOT_ID]?.bound === false,
      "unbind settlement",
    )
    expect(app.state.getSnapshot().connectionBindings[SLOT_ID]?.bound).toBe(false)
    await settleUntil(
      () => fixture.backend.requests("resolve_consent").slice(consentCountBeforeUnbind).some((request) =>
        request.type === "resolve_consent" &&
        request.payload.workspaceSource === "native-blocks" &&
        request.payload.connectionSourceKey === `slot:${SLOT_ID}`
      ),
      "post-unbind consent resolution",
    )
    expect(fixture.backend.requests("unbind_slot").at(-1)?.payload).toEqual({
      presetId: PRESET_A,
      slotId: SLOT_ID,
    })
    const unboundConsent = fixture.backend.requests("resolve_consent")
      .slice(consentCountBeforeUnbind)
      .find((request) =>
        request.type === "resolve_consent" &&
        request.payload.workspaceSource === "native-blocks" &&
        request.payload.connectionSourceKey === `slot:${SLOT_ID}`
      )
    if (unboundConsent?.type !== "resolve_consent") throw new Error("Expected consent resolution after unbind")
    fixture.backend.respondConsent(unboundConsent.correlationId, unboundConsent.payload, "required")
    await settleUntil(
      () => thread?.querySelector<HTMLSelectElement>("[data-apc-host-connection]")?.disabled === false,
      "unbind completion",
    )
    const hostConnection = thread?.querySelector<HTMLSelectElement>("[data-apc-host-connection]")
    expect(hostConnection).not.toBeNull()
    changeValue(hostConnection as HTMLSelectElement, "connection-choice-1")
    await settleUntil(
      () => thread?.querySelector<HTMLButtonElement>("[data-apc-bind]")?.disabled === false,
      "connection selection",
    )
    const consentCountBeforeBind = fixture.backend.requests("resolve_consent").length
    const bindCountBeforeClick = fixture.backend.requests("bind_slot").length
    thread?.querySelector<HTMLButtonElement>("[data-apc-bind]")?.click()
    await settleUntil(
      () => fixture.backend.requests("bind_slot").length > bindCountBeforeClick,
      "bind request",
    )
    expect(fixture.backend.requests("bind_slot").at(-1)?.payload).toEqual({
      presetId: PRESET_A,
      slotId: SLOT_ID,
      patch: { connectionId: CONNECTION_ID },
    })
    await settleUntil(
      () => app.state.getSnapshot().connectionBindings[SLOT_ID]?.bound === true,
      "bind settlement",
    )
    await settleUntil(
      () => fixture.backend.requests("resolve_consent").slice(consentCountBeforeBind).some((request) =>
        request.type === "resolve_consent" &&
        request.payload.workspaceSource === "native-blocks" &&
        request.payload.connectionSourceKey === `slot:${SLOT_ID}`
      ),
      "post-bind consent resolution",
    )
    const reboundConsent = fixture.backend.requests("resolve_consent")
      .slice(consentCountBeforeBind)
      .find((request) =>
        request.type === "resolve_consent" &&
        request.payload.workspaceSource === "native-blocks" &&
        request.payload.connectionSourceKey === `slot:${SLOT_ID}`
      )
    expect(reboundConsent?.payload).toEqual({
      presetId: PRESET_A,
      threadId: THREAD_A,
      workspaceSource: "native-blocks",
      connectionSourceKey: `slot:${SLOT_ID}`,
    })
    if (reboundConsent?.type !== "resolve_consent") throw new Error("Expected consent resolution after bind")
    fixture.backend.respondConsent(reboundConsent.correlationId, reboundConsent.payload, "required")
    await settleUntil(
      () => thread?.querySelector<HTMLButtonElement>("[data-apc-refresh-connections]")?.disabled === false,
      "post-bind consent authority",
    )
    const connectionRefreshBaseline = fixture.backend.requests("list_connections").length
    click(thread as HTMLElement, "[data-apc-refresh-connections]")
    await settleUntil(
      () => fixture.backend.requests("list_connections").length > connectionRefreshBaseline,
      "connection refresh request",
    )
    expect(thread?.querySelector<HTMLButtonElement>("[data-apc-refresh-connections]")?.disabled).toBe(true)
    fixture.locale.set("fr")
    expect(thread?.querySelector<HTMLButtonElement>("[data-apc-refresh-connections]")?.disabled).toBe(true)
    const refreshRequest = fixture.backend.requests("list_connections").at(-1)
    fixture.backend.respondConnections(refreshRequest?.correlationId ?? "", [CONNECTION])
    await settleUntil(
      () => thread?.querySelector<HTMLButtonElement>("[data-apc-refresh-connections]")?.disabled === false,
      "authoritative connection refresh",
    )

    click(thread as HTMLElement, "[data-apc-open-workspace]")
    await settle()
    const reviewWorkspace = app.root.querySelector<HTMLElement>('[data-apc-thread-surface="workspace"]')
    const reviewLoom = fixture.loomMounts.findLast((mount) => !mount.destroyed)
    expect(reviewWorkspace).not.toBeNull()
    expect(reviewLoom).toBeDefined()
    const selectionBeforeReview = structuredClone(app.state.getSnapshot().selection)
    const promptValuesBeforeReview = structuredClone(
      app.state.getSnapshot().config?.threads.find((candidate) => candidate.id === THREAD_A)?.promptVariableValues,
    )
    const modeBeforeReview = app.state.getSnapshot().activeMode
    const flushesBeforeReview = fixture.editor.flushCount
    const unrelatedToolbarContent = browser.window.document.createElement("span")
    unrelatedToolbarContent.dataset.hostUnrelatedToolbar = "true"
    toolbarRoot.append(unrelatedToolbarContent)
    const navigationPane = app.root.querySelector<HTMLElement>('[data-apc-pane="navigation"]')
    const workspacePane = app.root.querySelector<HTMLElement>('[data-apc-pane="workspace"]')
    const configurationPane = app.root.querySelector<HTMLElement>('[data-apc-pane="configuration"]')
    const ownedToolbar = toolbarRoot.querySelector<HTMLElement>("[data-apc-graph-toolbar-owned=true]")


    const consentRequestsBeforeReview = fixture.backend.requests("resolve_consent").length
    click(thread as HTMLElement, "[data-apc-open-consent-review]")
    expect(navigationPane?.hasAttribute("inert")).toBe(true)
    expect(navigationPane?.getAttribute("aria-hidden")).toBe("true")
    expect(workspacePane?.hasAttribute("inert")).toBe(true)
    expect(workspacePane?.getAttribute("aria-hidden")).toBe("true")
    expect(ownedToolbar?.hasAttribute("inert")).toBe(true)
    expect(ownedToolbar?.getAttribute("aria-hidden")).toBe("true")
    expect(unrelatedToolbarContent.hasAttribute("inert")).toBe(false)
    expect(configurationPane?.hasAttribute("inert")).toBe(false)
    expect(configurationPane?.getAttribute("aria-hidden")).toBeNull()
    expect([...ownedToolbar?.querySelectorAll<HTMLButtonElement>('[data-action="select-mode"]') ?? []]
      .every((control) => control.disabled)).toBe(true)

    actionByText(graph as HTMLElement, "select-thread", "A Context").click()
    ownedToolbar?.querySelector<HTMLButtonElement>('[data-action="select-mode"][data-mode="sequential"]')?.click()
    click(reviewWorkspace as HTMLElement, "[data-apc-back-to-graph]")
    reviewLoom?.options.onChange?.({ blocks: [], promptVariableValues: { blocked: { state: "review-open" } } })
    await app.flushWorkspace()
    await settle()
    expect(app.state.getSnapshot().selection).toEqual(selectionBeforeReview)
    expect(app.state.getSnapshot().activeMode).toBe(modeBeforeReview)
    expect(app.state.getSnapshot().config?.threads.find((candidate) => candidate.id === THREAD_A)?.promptVariableValues)
      .toEqual(promptValuesBeforeReview)
    expect(fixture.editor.flushCount).toBe(flushesBeforeReview)
    expect(reviewWorkspace?.isConnected).toBe(true)

    await settleUntil(
      () => fixture.backend.requests("resolve_consent").length > consentRequestsBeforeReview,
      "fresh consent review resolution",
    )
    expect(thread?.querySelector<HTMLButtonElement>("[data-apc-approve-consent]")?.disabled).toBe(true)
    const reviewConsent = fixture.backend.requests("resolve_consent").at(-1)
    if (reviewConsent?.type !== "resolve_consent") throw new Error("Expected review consent resolution")
    fixture.backend.respondConsent(reviewConsent.correlationId, reviewConsent.payload, "required")
    fixture.locale.set("ja")
    expect(thread?.querySelector<HTMLButtonElement>("[data-apc-approve-consent]")?.disabled).toBe(true)
    await settleUntil(
      () => {
        const acknowledge = thread?.querySelector<HTMLInputElement>("[data-apc-consent-acknowledge]")
        return acknowledge !== null && acknowledge !== undefined && !acknowledge.disabled
      },
      "resolved slot consent review",
    )
    const review = thread?.querySelector<HTMLElement>("[data-apc-consent-review]")
    expect(review?.textContent).toContain(CONNECTION.name)
    expect(review?.textContent).toContain(CONNECTION.provider)
    expect(review?.textContent).toContain(CONNECTION.model)

    const t = createApcTranslator(() => fixture.locale.get())
    expect(review?.textContent).toContain(t("consent.disclosureSummary", {
      destination: CONNECTION.name,
      workspace: t("workspace.nativeBlocks"),
    }))
    expect(review?.textContent).toContain(createApcTranslator(() => fixture.locale.get())("graph.inputs"))
    expect(review?.textContent).toContain(createApcTranslator(() => fixture.locale.get())("binding.output"))
    changeValue(
      thread?.querySelector<HTMLInputElement>("[data-apc-consent-acknowledge]") as HTMLInputElement,
      true,
    )
    await settleUntil(
      () => thread?.querySelector<HTMLButtonElement>("[data-apc-approve-consent]")?.disabled === false,
      "slot consent acknowledgement",
    )
    const approvalBaseline = fixture.backend.requests("approve_consent").length
    click(thread as HTMLElement, "[data-apc-approve-consent]")
    await settleUntil(
      () => fixture.backend.requests("approve_consent").length > approvalBaseline,
      "slot consent approval",
    )
    const approve = fixture.backend.requests("approve_consent").at(-1)
    expect(approve?.payload).toEqual({
      presetId: PRESET_A,
      threadId: THREAD_A,
      workspaceSource: "native-blocks",
      connectionSourceKey: `slot:${SLOT_ID}`,
    })
    if (approve?.type !== "approve_consent") throw new Error("Expected approve consent")
    fixture.backend.respondConsent(approve.correlationId, approve.payload, "approved")
    await settleUntil(
      () => thread?.querySelector("[data-apc-consent-status]")?.getAttribute("data-apc-consent-status") === "approved",
      "approved slot consent",
    )
    const revokeBaseline = fixture.backend.requests("revoke_consent").length
    click(thread as HTMLElement, "[data-apc-revoke-consent]")
    await settleUntil(
      () => fixture.backend.requests("revoke_consent").length > revokeBaseline,
      "slot consent revocation",
    )
    const revoke = fixture.backend.requests("revoke_consent").at(-1)
    expect(revoke?.payload).toEqual(approve.payload)
    if (revoke?.type !== "revoke_consent") throw new Error("Expected revoke consent")
    fixture.backend.respondConsent(revoke.correlationId, revoke.payload, "revoked")
    await settleUntil(
      () => thread?.querySelector("[data-apc-consent-status]")?.getAttribute("data-apc-consent-status") === "revoked",
      "revoked slot consent",
    )
    expect(navigationPane?.hasAttribute("inert")).toBe(false)
    expect(navigationPane?.getAttribute("aria-hidden")).toBeNull()
    expect(workspacePane?.hasAttribute("inert")).toBe(false)
    expect(workspacePane?.getAttribute("aria-hidden")).toBeNull()
    expect(ownedToolbar?.hasAttribute("inert")).toBe(false)
    expect(ownedToolbar?.getAttribute("aria-hidden")).toBeNull()
    expect(unrelatedToolbarContent.hasAttribute("inert")).toBe(false)
    expect(ownedToolbar?.querySelector<HTMLButtonElement>(
      '[data-action="select-mode"][data-mode="sequential"]',
    )?.disabled).toBe(false)
    click(reviewWorkspace as HTMLElement, "[data-apc-back-to-graph]")
    await settle()
    expect(app.root.querySelector('[data-apc-thread-surface="workspace"]')).toBeNull()


    actionByText(graph as HTMLElement, "select-run", "A Context").click()
    await settleUntil(
      () => app.state.getSnapshot().selection?.kind === "run" &&
        thread?.querySelector("[data-apc-run-configuration]") !== null,
      "selected run projection",
    )
    expect(app.state.getSnapshot().selection).toEqual({ kind: "run", runId: RUN_B_ID })
    expect(thread?.querySelector("[data-apc-run-configuration]")).not.toBeNull()
    expect(app.root.querySelector("[data-apc-inspector]")).toBeNull()
    expect(app.root.querySelector('[data-apc-pane="configuration"]')?.getAttribute("data-apc-right-surface"))
      .toBe("configuration")
    for (const locale of ["en", "zh", "zh-TW", "ja", "fr", "it"] as const) {
      fixture.locale.set(locale)
      await settle()
      const t = createApcTranslator(() => locale)
      expect(thread?.querySelector("[data-apc-run-output]")?.textContent)
        .toContain(t("graph.defaultFinalResponseName"))
      expect(app.root.querySelector('[data-apc-pane="navigation"]')?.getAttribute("aria-label"))
        .toBe(t("graph.threadNavigation"))
      expect(app.root.querySelector('[data-apc-pane="workspace"]')?.getAttribute("aria-label"))
        .toBe(t("graph.stages"))
      expect(app.root.querySelector('[data-apc-pane="configuration"]')?.getAttribute("aria-label"))
        .toBe(t("threadEditor.ariaLabel"))
    }
    fixture.locale.set("en")
    await settle()
    expect(thread?.querySelector<HTMLInputElement>("[data-apc-run-required]")?.disabled).toBe(true)
    click(topology as HTMLElement, '[data-action="final-main"]')
    await settleUntil(
      () => app.state.getSnapshot().config?.pipelines.parallel?.finalResponse.source === "main",
      "Main final route",
    )
    await settleUntil(
      () => !app.state.getSnapshot().busy && !app.state.getSnapshot().stale,
      "Main route mutation settlement",
    )
    expect(app.state.getSnapshot().busyReason).toBeNull()
    expect(app.state.getSnapshot().blockedReasons).toEqual([])
    await settleUntil(
      () => {
        const currentThread = app.root.querySelector<HTMLElement>('[data-apc-thread-surface="configuration"]')
        return app.state.getSnapshot().selection?.kind === "run" &&
          currentThread?.querySelector("[data-apc-run-configuration]") !== null &&
          currentThread?.querySelector<HTMLInputElement>("[data-apc-run-required]")?.disabled === true &&
          currentThread?.querySelector<HTMLInputElement>("[data-apc-run-timeout]")?.disabled === false
      },
      "structurally required Main input run",
    )
    expect(app.state.getSnapshot().selection).toEqual({ kind: "run", runId: RUN_B_ID })
    expect(thread?.querySelector<HTMLInputElement>("[data-apc-run-required]")?.disabled).toBe(true)
    expect(thread?.querySelector<HTMLInputElement>("[data-apc-run-timeout]")?.disabled).toBe(false)
    actionByText(graph as HTMLElement, "select-run", "A Research").click()
    await settleUntil(
      () => {
        const selection = app.state.getSnapshot().selection
        return selection?.kind === "run" &&
          selection.runId === RUN_ID &&
          app.root.querySelector<HTMLInputElement>("[data-apc-run-required]")?.disabled === true
      },
      "transitive fail-graph dependency lock",
    )
    app.state.updateConfig((config) => {
      const next = structuredClone(config)
      const pipeline = next.pipelines.parallel
      const finalInput = pipeline?.finalResponse.source === "main"
        ? pipeline.finalResponse.inputs[0]
        : undefined
      const consumer = pipeline?.stages[1]?.runs[0]
      const dependency = consumer?.inputs[0]
      if (finalInput) finalInput.onMissing = "omit-binding"
      if (consumer) consumer.required = false
      if (dependency?.source === "output") dependency.onMissing = "skip-run"
      return next
    })
    await settleUntil(
      () => app.state.getSnapshot().modeIssues.parallel.length === 0 &&
        app.root.querySelector<HTMLInputElement>("[data-apc-run-required]")?.disabled === false,
      "optional omission and skip policies",
    )
    const staleOptionalRequired = app.root.querySelector<HTMLInputElement>("[data-apc-run-required]")
    app.state.updateConfig((config) => {
      const next = structuredClone(config)
      const pipeline = next.pipelines.parallel
      const finalInput = pipeline?.finalResponse.source === "main"
        ? pipeline.finalResponse.inputs[0]
        : undefined
      const consumer = pipeline?.stages[1]?.runs[0]
      const dependency = consumer?.inputs[0]
      if (finalInput) finalInput.onMissing = "fail-graph"
      if (consumer) consumer.required = true
      if (dependency?.source === "output") dependency.onMissing = "fail-graph"
      return next
    })
    changeValue(staleOptionalRequired as HTMLInputElement, false)
    expect(app.state.getSnapshot().config?.pipelines.parallel?.stages[0]?.runs[0]?.required).toBe(true)
    actionByText(graph as HTMLElement, "select-run", "A Context").click()
    await settleUntil(
      () => {
        const selection = app.state.getSnapshot().selection
        return selection?.kind === "run" && selection.runId === RUN_B_ID
      },
      "restored final Main run",
    )
    thread = app.root.querySelector<HTMLElement>('[data-apc-thread-surface="configuration"]')
    expect(thread?.querySelector("[data-apc-run-configuration]")).not.toBeNull()
    changeValue(thread?.querySelector<HTMLInputElement>("[data-apc-run-timeout]") as HTMLInputElement, "45")
    changeValue(thread?.querySelector<HTMLSelectElement>("[data-apc-binding-role]") as HTMLSelectElement, "assistant")
    changeValue(thread?.querySelector<HTMLSelectElement>("[data-apc-binding-missing]") as HTMLSelectElement, "omit-binding")
    click(thread as HTMLElement, "[data-apc-add-run-binding]")
    await settle()
    click(thread as HTMLElement, "[data-apc-remove-run-binding]")
    await settle()
    const configuredRun = app.state.getSnapshot().config?.pipelines.parallel?.stages[1]?.runs[0]
    expect(configuredRun?.required).toBe(true)
    expect(configuredRun?.timeoutMs).toBe(45_000)
    expect(configuredRun?.inputs).toEqual([{
      source: "output",
      runId: RUN_ID,
      role: "user",
      onMissing: "fail-graph",
    }])
    const currentGraph = app.root.querySelector<HTMLElement>('[data-apc-graph-surface="topology"]')
    await settleUntil(
      () => currentGraph?.querySelector<HTMLButtonElement>('[data-action="final-thread"]')?.disabled === false,
      "current Thread final route action",
    )
    click(currentGraph as HTMLElement, '[data-action="final-thread"]')
    await settleUntil(
      () => app.state.getSnapshot().config?.pipelines.parallel?.finalResponse.source === "thread",
      "Thread final route",
    )

    thread = app.root.querySelector<HTMLElement>('[data-apc-thread-surface="configuration"]')
    actionByText(graph as HTMLElement, "select-thread", "A Research").click()
    await settle()
    expect(app.state.getSnapshot().selection).toEqual({ kind: "thread", threadId: THREAD_A })
    expect(app.root.querySelector("[data-apc-inspector]")).toBeNull()
    expect(app.root.querySelector('[data-apc-pane="configuration"]')?.getAttribute("data-apc-right-surface"))
      .toBe("configuration")

    click(thread as HTMLElement, "[data-apc-open-workspace]")
    await settle()
    expect(app.root.querySelector('[data-apc-pane="workspace"]')?.getAttribute("data-apc-center-surface"))
      .toBe("loom")
    expect(currentGraph?.isConnected).toBe(false)

    fixture.backend.respondActivity(PRESET_A, "started", undefined, {
      runStatus: "running",
      usage: { input: 10, output: 3, total: 13 },
    })
    await settle()
    let inspector = app.root.querySelector<HTMLElement>("[data-apc-inspector]")
    if (inspector === null) throw new Error("Expected the execution inspector")
    fixture.backend.respondActivity(PRESET_A, "progress", undefined, {
      runStatus: "completed",
      usage: { input: 20, output: 4, total: 24 },
    })
    fixture.backend.respondActivity(PRESET_A, "progress", undefined, { runStatus: "failed" })
    await settle()
    inspector = app.root.querySelector<HTMLElement>("[data-apc-inspector]")
    if (inspector === null) throw new Error("Expected the updated execution inspector")
    expect(app.state.getSnapshot().executionMutationLocked).toBe(true)
    expect(app.root.querySelector('[data-apc-pane="workspace"]')?.getAttribute("data-apc-center-surface"))
      .toBe("topology")
    expect(app.root.querySelector('[data-apc-pane="configuration"]')?.getAttribute("data-apc-right-surface"))
      .toBe("execution")
    expect(currentGraph?.isConnected).toBe(true)
    expect(graph?.isConnected).toBe(true)
    expect(app.root.querySelector('[data-apc-thread-surface="configuration"]')).toBeNull()
    expect(fixture.loomMounts.every((mount) => mount.destroyed)).toBe(true)
    expect([...currentGraph?.querySelectorAll<HTMLButtonElement>("[data-apc-mutates=true]") ?? []]
      .every((control) => control.disabled)).toBe(true)
    expect((actionByText(graph as HTMLElement, "select-thread", "A Context") as HTMLButtonElement).disabled).toBe(false)
    expect(inspector?.dataset.inspectorView).toBe("execution")
    expect(inspector?.querySelector("[data-inspector-field=stage-progress]")).not.toBeNull()
    const activityItem = inspector?.querySelector<HTMLElement>(".apc-inspector-activity-item")
    expect(activityItem?.dataset.activityStatus).toBe("running")
    const activityItems = [...(inspector?.querySelectorAll<HTMLElement>(".apc-inspector-activity-item") ?? [])]
    expect(activityItems.map((item) => item.dataset.activityStatus)).toEqual(["running", "completed", "failed"])
    expect(activityItems.at(-1)?.textContent).toContain("A Context")
    const usage = inspector?.querySelector<HTMLElement>("[data-inspector-section=usage]")
    expect(usage?.textContent).toContain("Input 20")
    expect(usage?.textContent).toContain("output 4")
    expect(usage?.textContent).toContain("total 24")
    expect(activityItem?.textContent).toContain("A Context")
    expect(activityItem?.textContent).not.toContain(EXECUTION_ID)
    expect(activityItem?.textContent).not.toContain(TRACE_ID)
    click(inspector, "[data-inspector-action=stop]")
    await settle()
    const cancellation = fixture.backend.requests("cancel_execution").at(-1)
    expect(cancellation?.payload).toEqual({
      executionId: EXECUTION_ID,
      presetId: PRESET_A,
      reason: "stop",
    })

    fixture.backend.respondActivity(PRESET_A, "completed", "graph-fallback")
    await settle()
    expect(app.state.getSnapshot().executionMutationLocked).toBe(false)
    expect(app.root.querySelector('[data-apc-pane="workspace"]')?.getAttribute("data-apc-center-surface"))
      .toBe("topology")
    expect(app.root.querySelector('[data-apc-pane="configuration"]')?.getAttribute("data-apc-right-surface"))
      .toBe("execution")
    expect(currentGraph?.querySelector<HTMLButtonElement>('[data-action="final-main"]')?.disabled).toBe(false)
    expect(app.state.getSnapshot().execution.usage).toEqual({ input: 20, output: 4, total: 24 })
    expect(inspector?.querySelector("[data-inspector-section=usage]")?.textContent).toContain("total 24")
    expect(inspector?.querySelector("[data-inspector-field=main-fallback-result]")?.textContent)
      .toContain(createApcTranslator(() => fixture.locale.get())("diagnostic.unknown"))
    const fallback = inspector?.querySelector<HTMLButtonElement>("[data-inspector-action=use-main-fallback]")
    expect(fallback).not.toBeNull()
    fallback?.focus()
    fallback?.click()
    await settle()
    expect(app.state.getSnapshot().config?.pipelines.parallel?.finalResponse).toEqual({
      source: "main",
      inputs: [{
        source: "output",
        runId: RUN_B_ID,
        onMissing: "fail-graph",
      }],
    })
    expect(app.state.getSnapshot().modeIssues.parallel).toEqual([])
    expect(app.state.getSnapshot().blockedReasons).toEqual([])
    expect(app.state.getSnapshot().execution.topologyApplicable).toBe(false)
    expect(app.state.getSnapshot().execution.outcome).toBe("graph-fallback")
    expect(app.state.getSnapshot().execution.activity).toHaveLength(4)
    expect(app.state.getSnapshot().execution.usage).toEqual({ input: 20, output: 4, total: 24 })
    expect(inspector?.isConnected).toBe(false)
    expect(app.root.querySelector("[data-apc-inspector]")).toBeNull()
    expect(app.root.querySelector('[data-apc-pane="configuration"]')?.getAttribute("data-apc-right-surface"))
      .toBe("configuration")
    expect(app.root.querySelector('[data-apc-thread-surface="configuration"]')).not.toBeNull()
    expect(browser.window.document.activeElement?.getAttribute("data-apc-thread-workspace-heading")).toBe("true")

    const preservedSelection = app.state.getSnapshot().selection
    const preservedConfig = structuredClone(app.state.getSnapshot().config)
    for (const locale of ["en", "zh", "zh-TW", "ja", "fr", "it"] as const) {
      fixture.locale.set(locale)
      await settle()
      const t = createApcTranslator(() => locale)
      expect(fixture.ui.tab?.root.dataset.hostTitle).toBe(t("agentGraph.title"))
      expect(toolbarRoot.querySelector('[data-mode="single"]')?.textContent).toContain(t("mode.single"))
      expect(app.root.querySelector('[data-apc-pane="navigation"]')?.getAttribute("aria-label"))
        .toBe(t("graph.threadNavigation"))
      expect(app.root.querySelector('[data-apc-pane="workspace"]')?.getAttribute("aria-label"))
        .toBe(t("graph.stages"))
      expect(app.root.querySelector('[data-apc-pane="configuration"]')?.getAttribute("aria-label"))
        .toBe(t("threadEditor.ariaLabel"))
      expect(app.root.querySelector('[data-apc-thread-surface="configuration"] h2')?.textContent?.length ?? 0)
        .toBeGreaterThan(0)
      expect(app.state.getSnapshot().selection).toEqual(preservedSelection)
      expect(app.state.getSnapshot().config).toEqual(preservedConfig)
    }

    const publicDom = `${app.root.innerHTML}${toolbarRoot.innerHTML}`
    for (const privateValue of [
      PRESET_A,
      THREAD_A,
      THREAD_B,
      SLOT_ID,
      PIPELINE_ID,
      STAGE_ID,
      STAGE_B_ID,
      RUN_ID,
      RUN_B_ID,
      EXECUTION_ID,
      TRACE_ID,
      CONNECTION_ID,
      EVENT_CORRELATION_ID,
      INSTALLATION_ID,
    ]) expect(publicDom).not.toContain(privateValue)
    expect(publicDom).not.toContain("Retry")
    expect(publicDom).not.toContain("receipt")
    expect(app.root.querySelector("[data-execution-id]")).toBeNull()

    const staleGraphAction = actionByText(graph as HTMLElement, "select-thread", "A Context")
    const flushCountBeforeTeardown = fixture.editor.flushCount
    const sentBeforeTeardown = fixture.backend.sent.length
    const teardown = app.teardown()
    assertDisarmed(fixture)
    expect(fixture.editor.flushCount).toBe(flushCountBeforeTeardown)
    staleGraphAction.click()
    expect(fixture.backend.sent).toHaveLength(sentBeforeTeardown)
    expect(app.teardown()).toBe(teardown)
    await teardown
  })

  test("projects consent dismissal impact for mixed, optional-only, and unscheduled selected threads", async () => {
    for (const kind of ["mixed", "optional", "unscheduled"] as const) {
      const fixture = new HostFixture()
      const app = await createApcApp(fixture.context)
      const config = graphConfig("A")
      if (kind === "mixed") {
        config.pipelines.parallel!.stages[1]!.runs.push({
          id: RUN_C_ID,
          threadId: THREAD_A,
          required: false,
          timeoutMs: 60_000,
          inputs: [],
        })
      } else if (kind === "optional") {
        config.pipelines.parallel!.stages[0]!.runs[0]!.required = false
        config.pipelines.parallel!.stages[1]!.runs[0]!.inputs = []
      } else {
        config.threads.push({
          ...structuredClone(config.threads[0]!),
          id: THREAD_C,
          name: "A Review",
        })
      }
      fixture.editor.switchPreset(PRESET_A, config)
      await settleUntil(() => app.state.getSnapshot().hydrated, `${kind} consent impact hydration`)
      const navigation = app.root.querySelector<HTMLElement>('[data-apc-graph-surface="navigation"]')
      actionByText(
        navigation as HTMLElement,
        "select-thread",
        kind === "unscheduled" ? "A Review" : "A Research",
      ).click()
      await settle()
      const configuration = app.root.querySelector<HTMLElement>(
        '[data-apc-thread-surface="configuration"]',
      )
      click(configuration as HTMLElement, "[data-apc-open-consent-review]")
      expect(
        app.root.querySelector("[data-apc-consent-dismissal-consequence]")
          ?.getAttribute("data-apc-consent-dismissal-consequence"),
      ).toBe(kind)
      const teardown = app.teardown()
      assertDisarmed(fixture)
      await teardown
    }
  })

  test("keeps bounded topology status authoritative until the first post-terminal config edit", async () => {
    const fixture = new HostFixture()
    const app = await createApcApp(fixture.context)
    fixture.editor.switchPreset(PRESET_A, graphConfig("A"))
    await settleUntil(() => app.state.getSnapshot().hydrated, "topology activity hydration")

    const topology = app.root.querySelector<HTMLElement>(
      '[data-apc-pane="workspace"] > [data-apc-graph-surface="topology"]',
    )
    expect(topology).not.toBeNull()
    expect(app.state.getSnapshot().execution.executionKey).toBeNull()
    expect(app.state.getSnapshot().execution.topologyApplicable).toBe(false)
    expect(topology?.querySelectorAll("[data-activity-status]")).toHaveLength(0)

    fixture.backend.respondActivity(PRESET_A, "started", undefined, {
      stageIndex: 0,
      runIndex: 0,
      runStatus: "completed",
    })
    for (let index = 0; index < 33; index += 1) {
      fixture.backend.respondActivity(PRESET_A, "progress", undefined, {
        stageIndex: 1,
        runIndex: 0,
        runStatus: "running",
      })
    }
    await settle()

    const activeExecution = app.state.getSnapshot().execution
    expect(activeExecution.topologyApplicable).toBe(true)
    expect(activeExecution.activity).toHaveLength(32)
    expect(activeExecution.activity.every((activity) => activity.stageIndex === 1)).toBe(true)
    expect(activeExecution.topologyActivity).toHaveLength(2)
    const runCards = [...(topology?.querySelectorAll<HTMLElement>(".apc-run-card") ?? [])]
    expect(runCards).toHaveLength(2)
    expect(runCards[0]?.dataset.activityStatus).toBe("completed")
    expect(runCards[1]?.dataset.activityStatus).toBe("running")
    const inspector = app.root.querySelector<HTMLElement>("[data-apc-inspector]")
    expect(inspector).not.toBeNull()
    const recentActivity = [...(inspector?.querySelectorAll<HTMLElement>(".apc-inspector-activity-item") ?? [])]
    expect(recentActivity).toHaveLength(8)
    const navigation = app.root.querySelector<HTMLElement>(
      '[data-apc-pane="navigation"] > [data-apc-graph-surface="navigation"]',
    )
    actionByText(navigation as HTMLElement, "select-thread", "A Context").click()
    await settle()
    expect(app.state.getSnapshot().selection).toEqual({ kind: "thread", threadId: THREAD_B })
    expect(inspector?.isConnected).toBe(true)
    expect(app.root.querySelector('[data-apc-pane="configuration"]')?.getAttribute("data-apc-right-surface"))
      .toBe("execution")
    expect(recentActivity.every((item) => item.dataset.activityStatus === "running")).toBe(true)

    fixture.backend.respondActivity(PRESET_A, "failed", "selected-final-failure", {
      stageIndex: 1,
      runIndex: 0,
      runStatus: "failed",
      runtimeTerminal: true,
      errorCategory: "config",
    })
    await settle()
    expect(app.state.getSnapshot().execution.terminal).toBe(true)
    expect(app.state.getSnapshot().execution.outcome).toBe("selected-final-failure")
    expect(app.state.getSnapshot().execution.stageIndex).toBe(1)
    expect(app.state.getSnapshot().execution.runIndex).toBe(0)
    expect(app.state.getSnapshot().execution.provider).toBe("openai")
    expect(app.state.getSnapshot().execution.model).toBe("gpt-5")
    expect(app.state.getSnapshot().execution.topologyApplicable).toBe(true)
    expect(inspector?.querySelector('[data-error-category="graph"]')).not.toBeNull()

    click(topology as HTMLElement, '[data-action="final-main"]')
    await settleUntil(
      () => app.state.getSnapshot().config?.pipelines.parallel?.finalResponse.source === "main",
      "post-terminal topology mutation",
    )
    const editedExecution = app.state.getSnapshot().execution
    expect(editedExecution.topologyApplicable).toBe(false)
    expect(editedExecution.topologyActivity).toEqual([])
    expect(editedExecution.outcome).toBe("selected-final-failure")
    expect(editedExecution.activity).toHaveLength(32)
    expect(topology?.querySelectorAll("[data-activity-status]")).toHaveLength(0)
    expect(inspector?.isConnected).toBe(false)
    expect(app.root.querySelector("[data-apc-inspector]")).toBeNull()
    const topologyIndependentProjection = inspectorStatus(
      app.state.getSnapshot(),
      createApcTranslator(() => fixture.locale.get()),
    )
    expect(topologyIndependentProjection.progress?.stageIndex).toBeUndefined()
    expect(topologyIndependentProjection.progress?.stageCount).toBeUndefined()
    expect(topologyIndependentProjection.progress?.completedRuns).toBe(editedExecution.completedRuns)
    expect(topologyIndependentProjection.progress?.totalRuns).toBe(editedExecution.totalRuns)
    expect(app.root.querySelector('[data-apc-pane="configuration"]')?.getAttribute("data-apc-right-surface"))
      .toBe("configuration")
    expect(app.root.querySelector('[data-apc-thread-surface="configuration"]')).not.toBeNull()

    const teardown = app.teardown()
    assertDisarmed(fixture)
    await teardown
  })

  test("returns terminal execution to configuration by button or explicit selection and restores new activity", async () => {
    const fixture = new HostFixture()
    const app = await createApcApp(fixture.context)
    fixture.editor.switchPreset(PRESET_A, graphConfig("A"))
    await settleUntil(() => app.state.getSnapshot().hydrated, "terminal selection hydration")
    const navigation = app.root.querySelector<HTMLElement>(
      '[data-apc-pane="navigation"] > [data-apc-graph-surface="navigation"]',
    )

    actionByText(navigation as HTMLElement, "select-run", "A Research").click()
    await settle()
    fixture.backend.respondActivity(PRESET_A, "started", undefined, {
      stageIndex: 0,
      runIndex: 0,
      runStatus: "running",
    })
    fixture.backend.respondActivity(PRESET_A, "progress", undefined, {
      stageIndex: 1,
      runIndex: 0,
      runStatus: "running",
    })
    fixture.backend.respondActivity(PRESET_A, "failed", "selected-final-failure", {
      runtimeTerminal: true,
      errorCategory: "dispatch",
    })
    await settle()
    const terminalExecution = app.state.getSnapshot().execution
    const retainedTraces = structuredClone(app.state.getSnapshot().traces)
    expect(terminalExecution.terminal).toBe(true)
    expect(terminalExecution.topologyApplicable).toBe(true)
    expect(app.root.querySelector("[data-apc-inspector]")).not.toBeNull()
    expect(app.root.querySelector('[data-apc-pane="configuration"]')?.getAttribute("data-apc-right-surface"))
      .toBe("execution")
    expect(terminalExecution.stageIndex).toBe(1)
    expect(terminalExecution.runIndex).toBe(0)
    expect(terminalExecution.provider).toBe("openai")
    expect(terminalExecution.model).toBe("gpt-5")
    const terminalInspector = app.root.querySelector<HTMLElement>("[data-apc-inspector]")
    const currentRun = terminalInspector?.querySelector<HTMLElement>("[data-inspector-section=current-run]")
    const dispatch = terminalInspector?.querySelector<HTMLElement>("[data-inspector-section=dispatch]")
    expect(currentRun?.dataset.currentRunStatus).toBe("running")
    expect(currentRun?.textContent).toContain("A Context")
    expect(currentRun?.querySelector("[data-error-category]")).toBeNull()
    expect(terminalInspector?.querySelector('[data-error-category="provider"]')).toBeNull()
    expect(terminalInspector?.querySelector('[data-error-category="connection"]')).not.toBeNull()
    expect(dispatch?.dataset.dispatchSource).toBe("slot")
    expect(dispatch?.querySelector("[data-inspector-field=provider]")?.textContent).toContain("openai")
    expect(dispatch?.querySelector("[data-inspector-field=model]")?.textContent).toContain("gpt-5")
    expect(terminalInspector?.innerHTML).not.toContain(EXECUTION_ID)
    expect(terminalInspector?.innerHTML).not.toContain(TRACE_ID)
    const backToConfiguration = terminalInspector?.querySelector<HTMLButtonElement>("[data-apc-back-to-configuration]")
    expect(backToConfiguration).not.toBeNull()
    backToConfiguration?.focus()
    backToConfiguration?.click()
    await settle()
    expect(app.state.getSnapshot().execution).toEqual(terminalExecution)
    expect(app.state.getSnapshot().traces).toEqual(retainedTraces)
    expect(app.root.querySelector("[data-apc-inspector]")).toBeNull()
    expect(app.root.querySelector('[data-apc-pane="configuration"]')?.getAttribute("data-apc-right-surface"))
      .toBe("configuration")
    expect(app.root.querySelector("[data-apc-run-configuration]")).not.toBeNull()
    expect(browser.window.document.activeElement?.getAttribute("data-apc-thread-workspace-heading")).toBe("true")

    fixture.backend.respondActivity(PRESET_A, "started", undefined, {
      executionId: EXECUTION_B_ID,
      stageIndex: 0,
      runIndex: 0,
      runStatus: "running",
    })
    await settle()
    expect(app.state.getSnapshot().execution.executionKey).not.toBe(terminalExecution.executionKey)
    expect(app.root.querySelector("[data-apc-inspector]")).not.toBeNull()
    expect(app.root.querySelector('[data-apc-pane="configuration"]')?.getAttribute("data-apc-right-surface"))
      .toBe("execution")
    fixture.backend.respondActivity(PRESET_A, "failed", "selected-final-failure", {
      executionId: EXECUTION_B_ID,
      runtimeTerminal: true,
    })
    await settle()
    const secondTerminal = app.state.getSnapshot().execution
    const retainedSecondTraces = structuredClone(app.state.getSnapshot().traces)
    expect(secondTerminal.terminal).toBe(true)
    expect(app.root.querySelector("[data-apc-inspector]")).not.toBeNull()

    actionByText(navigation as HTMLElement, "select-run", "A Context").click()
    await settle()
    expect(app.state.getSnapshot().selection).toEqual({ kind: "run", runId: RUN_B_ID })
    expect(app.root.querySelector("[data-apc-inspector]")).toBeNull()
    expect(app.root.querySelector('[data-apc-pane="configuration"]')?.getAttribute("data-apc-right-surface"))
      .toBe("configuration")
    const configuration = app.root.querySelector<HTMLElement>('[data-apc-thread-surface="configuration"]')
    expect(configuration?.querySelector("[data-apc-run-configuration]")).not.toBeNull()

    changeValue(
      configuration?.querySelector<HTMLInputElement>("[data-apc-run-timeout]") as HTMLInputElement,
      "45",
    )
    await settle()
    expect(app.state.getSnapshot().config?.pipelines.parallel?.stages[1]?.runs[0]?.timeoutMs).toBe(45_000)
    expect(app.state.getSnapshot().execution.topologyApplicable).toBe(false)
    expect(app.state.getSnapshot().execution.executionKey).toBe(secondTerminal.executionKey)
    expect(app.state.getSnapshot().execution.outcome).toBe(secondTerminal.outcome)
    expect(app.state.getSnapshot().execution.activity).toEqual(secondTerminal.activity)
    expect(app.state.getSnapshot().traces).toEqual(retainedSecondTraces)

    const teardown = app.teardown()
    assertDisarmed(fixture)
    await teardown
  })

  test("moves Sequential and Parallel runs through opaque bounded position targets", async () => {
    const sequentialFixture = new HostFixture()
    const sequentialApp = await createApcApp(sequentialFixture.context)
    const sequentialConfig = graphConfig("A", "sequential")
    sequentialConfig.pipelines.sequential!.stages[1]!.runs[0]!.inputs = []
    sequentialConfig.pipelines.sequential!.finalResponse = {
      source: "main",
      inputs: [
        { source: "output", runId: RUN_ID, onMissing: "fail-graph" },
        { source: "output", runId: RUN_B_ID, onMissing: "fail-graph" },
      ],
    }
    sequentialFixture.editor.switchPreset(PRESET_A, sequentialConfig)
    await settleUntil(() => sequentialApp.state.getSnapshot().hydrated, "Sequential position hydration")
    const sequentialNavigation = sequentialApp.root.querySelector<HTMLElement>(
      '[data-apc-graph-surface="navigation"]',
    )
    actionByText(sequentialNavigation as HTMLElement, "select-run", "A Context").click()
    await settle()
    const sequentialPosition = sequentialApp.root.querySelector<HTMLSelectElement>("[data-apc-run-position]")
    expect(sequentialPosition).not.toBeNull()
    expect([...sequentialPosition?.options ?? []]).toHaveLength(2)
    changeValue(sequentialPosition as HTMLSelectElement, sequentialPosition?.options[0]?.value ?? "")
    await settle()
    expect(sequentialApp.state.getSnapshot().config?.pipelines.sequential?.stages
      .map((stage) => stage.runs[0]?.id)).toEqual([RUN_B_ID, RUN_ID])
    expect(validateConfigForMode(sequentialApp.state.getSnapshot().config!, "sequential").valid).toBe(true)
    expect(sequentialPosition?.innerHTML).not.toContain(RUN_ID)
    expect(sequentialPosition?.innerHTML).not.toContain(RUN_B_ID)
    expect(sequentialApp.state.getSnapshot().config?.threads.map((thread) => thread.id))
      .toEqual([THREAD_A, THREAD_B])
    const mainConsentBaseline = sequentialFixture.backend.requests("resolve_consent").length
    click(
      sequentialApp.root.querySelector<HTMLElement>('[data-apc-thread-surface="configuration"]') as HTMLElement,
      "[data-apc-open-consent-review]",
    )
    await settleUntil(
      () => sequentialFixture.backend.requests("resolve_consent").length > mainConsentBaseline,
      "Sequential Main consent projection",
    )
    expect(sequentialFixture.backend.requests("resolve_consent").at(-1)?.payload).toMatchObject({
      threadId: THREAD_B,
      connectionSourceKey: "main",
    })
    const sequentialTeardown = sequentialApp.teardown()
    assertDisarmed(sequentialFixture)
    await sequentialTeardown

    const parallelFixture = new HostFixture()
    const parallelApp = await createApcApp(parallelFixture.context)
    const parallelConfig = graphConfig("A")
    parallelConfig.threads.push({
      ...structuredClone(parallelConfig.threads[0]!),
      id: THREAD_C,
      name: "A Review",
    })
    parallelConfig.pipelines.parallel!.stages[0]!.runs.push({
      id: RUN_C_ID,
      threadId: THREAD_C,
      required: true,
      timeoutMs: 60_000,
      inputs: [],
    })
    parallelConfig.pipelines.parallel!.finalResponse = {
      source: "main",
      inputs: [
        { source: "output", runId: RUN_ID, onMissing: "fail-graph" },
        { source: "output", runId: RUN_B_ID, onMissing: "fail-graph" },
        { source: "output", runId: RUN_C_ID, onMissing: "fail-graph" },
      ],
    }
    parallelFixture.editor.switchPreset(PRESET_A, parallelConfig)
    await settleUntil(() => parallelApp.state.getSnapshot().hydrated, "Parallel position hydration")
    const parallelNavigation = parallelApp.root.querySelector<HTMLElement>(
      '[data-apc-graph-surface="navigation"]',
    )
    actionByText(parallelNavigation as HTMLElement, "select-run", "A Review").click()
    await settle()
    const parallelPosition = parallelApp.root.querySelector<HTMLSelectElement>("[data-apc-run-position]")
    expect([...parallelPosition?.options ?? []]).toHaveLength(4)
    changeValue(parallelPosition as HTMLSelectElement, parallelPosition?.options[3]?.value ?? "")
    await settle()
    expect(parallelApp.state.getSnapshot().config?.pipelines.parallel?.stages).toHaveLength(2)
    expect(parallelApp.state.getSnapshot().config?.pipelines.parallel?.stages[0]?.runs.map((run) => run.id))
      .toEqual([RUN_ID])
    expect(parallelApp.state.getSnapshot().config?.pipelines.parallel?.stages[1]?.runs.map((run) => run.id))
      .toEqual([RUN_B_ID, RUN_C_ID])
    actionByText(parallelNavigation as HTMLElement, "select-run", "A Research").click()
    await settle()
    const soleSourcePosition = parallelApp.root.querySelector<HTMLSelectElement>("[data-apc-run-position]")
    expect([...soleSourcePosition?.options ?? []]).toHaveLength(1)
    expect(soleSourcePosition?.disabled).toBe(true)
    expect(parallelApp.state.getSnapshot().config?.pipelines.parallel?.stages).toHaveLength(2)
    for (const privateId of [THREAD_C, RUN_C_ID]) {
      expect(parallelPosition?.innerHTML).not.toContain(privateId)
      expect(soleSourcePosition?.innerHTML).not.toContain(privateId)
    }
    const parallelTeardown = parallelApp.teardown()
    assertDisarmed(parallelFixture)
    await parallelTeardown
  })

  test("omits binding-order and repeated-thread Parallel destinations without exposing IDs", async () => {
    const fixture = new HostFixture()
    const app = await createApcApp(fixture.context)
    const config = graphConfig("A")
    config.threads.push({
      ...structuredClone(config.threads[0]!),
      id: THREAD_C,
      name: "A Review",
    })
    config.pipelines.parallel!.stages[0]!.runs.push(
      {
        id: RUN_C_ID,
        threadId: THREAD_C,
        required: true,
        timeoutMs: 60_000,
        inputs: [],
      },
      {
        id: RUN_D_ID,
        threadId: THREAD_B,
        required: true,
        timeoutMs: 60_000,
        inputs: [],
      },
    )
    config.pipelines.parallel!.finalResponse = {
      source: "main",
      inputs: [
        { source: "output", runId: RUN_ID, onMissing: "fail-graph" },
        { source: "output", runId: RUN_B_ID, onMissing: "fail-graph" },
        { source: "output", runId: RUN_C_ID, onMissing: "fail-graph" },
        { source: "output", runId: RUN_D_ID, onMissing: "fail-graph" },
      ],
    }
    fixture.editor.switchPreset(PRESET_A, config)
    await settleUntil(() => app.state.getSnapshot().hydrated, "Parallel restriction hydration")
    const navigation = app.root.querySelector<HTMLElement>('[data-apc-graph-surface="navigation"]')
    const repeatedThreadRuns = [...navigation!.querySelectorAll<HTMLElement>('[data-action="select-run"]')]
      .filter((control) => control.textContent?.includes("A Context"))
    expect(repeatedThreadRuns).toHaveLength(2)
    repeatedThreadRuns[0]?.click()
    await settle()
    const repeatedThreadPosition = app.root.querySelector<HTMLSelectElement>("[data-apc-run-position]")
    expect([...repeatedThreadPosition?.options ?? []]).toHaveLength(3)
    expect([...repeatedThreadPosition?.options ?? []].every((option) => !option.textContent?.includes("A synthesis")))
      .toBe(true)
    expect(app.root.querySelector("[data-apc-run-position-impact]")).not.toBeNull()

    actionByText(navigation as HTMLElement, "select-run", "A Research").click()
    await settle()
    const bindingPosition = app.root.querySelector<HTMLSelectElement>("[data-apc-run-position]")
    expect([...bindingPosition?.options ?? []]).toHaveLength(3)
    expect([...bindingPosition?.options ?? []].every((option) => !option.textContent?.includes("A synthesis")))
      .toBe(true)
    const beforeRejectedMove = structuredClone(app.state.getSnapshot().config?.pipelines.parallel)
    const liveTextBefore = [...app.root.querySelectorAll<HTMLElement>("[aria-live]")]
      .map((region) => region.textContent)
    changeValue(bindingPosition as HTMLSelectElement, "run-position-999")
    await settle()
    expect(app.state.getSnapshot().config?.pipelines.parallel).toEqual(beforeRejectedMove)
    expect([...app.root.querySelectorAll<HTMLElement>("[aria-live]")].map((region) => region.textContent))
      .toEqual(liveTextBefore)
    expect(app.root.querySelector("[data-apc-run-position-impact]")?.textContent?.length ?? 0).toBeGreaterThan(0)
    for (const privateId of [THREAD_A, THREAD_B, THREAD_C, RUN_ID, RUN_B_ID, RUN_C_ID, RUN_D_ID]) {
      expect(repeatedThreadPosition?.innerHTML).not.toContain(privateId)
      expect(bindingPosition?.innerHTML).not.toContain(privateId)
    }

    const teardown = app.teardown()
    assertDisarmed(fixture)
    await teardown
  })

  test("rejects REQUIRED_CLOSURE binding candidates before staging", async () => {
    const fixture = new HostFixture()
    const app = await createApcApp(fixture.context)
    const config = graphConfig("A")
    config.pipelines.parallel!.stages[0]!.runs[0]!.required = false
    const requiredClosureBinding = config.pipelines.parallel!.stages[1]!.runs[0]!.inputs[0]
    if (requiredClosureBinding?.source !== "output") throw new Error("expected output binding")
    requiredClosureBinding.onMissing = "omit-binding"
    fixture.editor.switchPreset(PRESET_A, config)
    await settleUntil(() => app.state.getSnapshot().hydrated, "required closure hydration")
    const connectionRequest = fixture.backend.requests("list_connections").at(-1)
    fixture.backend.respondConnections(connectionRequest?.correlationId ?? "", [CONNECTION])
    await settle()
    const navigation = app.root.querySelector<HTMLElement>('[data-apc-graph-surface="navigation"]')
    actionByText(navigation as HTMLElement, "select-run", "A Context").click()
    await settle()
    const thread = app.root.querySelector<HTMLElement>('[data-apc-thread-surface="configuration"]')
    const missing = thread?.querySelector<HTMLSelectElement>("[data-apc-binding-missing]")
    expect(missing?.value).toBe("omit-binding")
    changeValue(missing as HTMLSelectElement, "fail-graph")
    await settle()
    const retainedRequiredClosureBinding =
      app.state.getSnapshot().config?.pipelines.parallel?.stages[1]?.runs[0]?.inputs[0]
    expect(retainedRequiredClosureBinding?.source === "output" ? retainedRequiredClosureBinding.onMissing : undefined)
      .toBe("omit-binding")
    const teardown = app.teardown()
    assertDisarmed(fixture)
    await teardown
  })

  test("rejects SKIP_REQUIRED binding candidates before staging", async () => {
    const fixture = new HostFixture()
    const app = await createApcApp(fixture.context)
    fixture.editor.switchPreset(PRESET_A, graphConfig("A"))
    await settleUntil(() => app.state.getSnapshot().hydrated, "skip required hydration")
    const connectionRequest = fixture.backend.requests("list_connections").at(-1)
    fixture.backend.respondConnections(connectionRequest?.correlationId ?? "", [CONNECTION])
    await settle()
    const navigation = app.root.querySelector<HTMLElement>('[data-apc-graph-surface="navigation"]')
    actionByText(navigation as HTMLElement, "select-run", "A Context").click()
    await settle()
    const thread = app.root.querySelector<HTMLElement>('[data-apc-thread-surface="configuration"]')
    const missing = thread?.querySelector<HTMLSelectElement>("[data-apc-binding-missing]")
    expect(missing?.value).toBe("fail-graph")
    changeValue(missing as HTMLSelectElement, "skip-run")
    await settle()
    const retainedRequiredBinding =
      app.state.getSnapshot().config?.pipelines.parallel?.stages[1]?.runs[0]?.inputs[0]
    expect(retainedRequiredBinding?.source === "output" ? retainedRequiredBinding.onMissing : undefined)
      .toBe("fail-graph")
    const teardown = app.teardown()
    assertDisarmed(fixture)
    await teardown
  })

  test("adds an optional earlier source with an omit-binding policy", async () => {
    const fixture = new HostFixture()
    const app = await createApcApp(fixture.context)
    const config = graphConfig("A")
    config.pipelines.parallel!.stages[0]!.runs[0]!.required = false
    const optionalSourceBinding = config.pipelines.parallel!.stages[1]!.runs[0]!.inputs[0]
    if (optionalSourceBinding?.source !== "output") throw new Error("expected output binding")
    optionalSourceBinding.onMissing = "omit-binding"
    fixture.editor.switchPreset(PRESET_A, config)
    await settleUntil(() => app.state.getSnapshot().hydrated, "optional source hydration")
    const connectionRequest = fixture.backend.requests("list_connections").at(-1)
    fixture.backend.respondConnections(connectionRequest?.correlationId ?? "", [CONNECTION])
    await settle()
    const navigation = app.root.querySelector<HTMLElement>('[data-apc-graph-surface="navigation"]')
    actionByText(navigation as HTMLElement, "select-run", "A Context").click()
    await settle()
    const thread = app.root.querySelector<HTMLElement>('[data-apc-thread-surface="configuration"]')
    click(thread as HTMLElement, "[data-apc-add-run-binding]")
    await settle()
    const inputs = app.state.getSnapshot().config?.pipelines.parallel?.stages[1]?.runs[0]?.inputs ?? []
    expect(inputs).toHaveLength(2)
    expect(inputs.at(-1)).toEqual({
      source: "output",
      runId: RUN_ID,
      role: "user",
      onMissing: "omit-binding",
    })
    const teardown = app.teardown()
    assertDisarmed(fixture)
    await teardown
  })

  test("creates a Parallel connection slot through graph UI and reaches the scoped bind flow", async () => {
    const fixture = new HostFixture()
    const app = await createApcApp(fixture.context)
    const config = graphConfig("A")
    config.connectionSlots = []
    config.threads = config.threads.map(({ connectionSlotId: _slot, ...thread }) => thread)
    fixture.editor.switchPreset(PRESET_A, config)
    await settleUntil(
      () => app.state.getSnapshot().hydrated && fixture.backend.requests("list_connections").length > 0,
      "Parallel slot editor hydration",
    )
    const connectionRequest = fixture.backend.requests("list_connections").at(-1)
    fixture.backend.respondConnections(connectionRequest?.correlationId ?? "", [CONNECTION])
    const graph = app.root.querySelector<HTMLElement>('[data-apc-graph-surface="topology"]')
    expect(graph).not.toBeNull()
    await settleUntil(
      () => graph?.querySelector<HTMLButtonElement>('[data-action="add-connection-slot"]')?.disabled === false,
      "connection slot creation action",
    )
    click(graph as HTMLElement, '[data-action="add-connection-slot"]')
    await settleUntil(
      () => (app.state.getSnapshot().config?.connectionSlots.length ?? 0) === 1,
      "created connection slot",
    )
    const slot = app.state.getSnapshot().config?.connectionSlots[0]
    expect(slot).toBeDefined()
    expect(slot ? validateConfigForMode(app.state.getSnapshot().config!, "parallel").valid : false).toBe(true)
    expect(graph?.innerHTML).not.toContain(slot?.id ?? "")

    const navigation = app.root.querySelector<HTMLElement>('[data-apc-graph-surface="navigation"]')
    const threadAction = actionByText(navigation as HTMLElement, "select-thread", "A Research")
    threadAction.click()
    await settleUntil(
      () => app.root.querySelector('[data-apc-thread-surface="configuration"]') !== null,
      "selected thread editor",
    )
    const thread = app.root.querySelector<HTMLElement>('[data-apc-thread-surface="configuration"]')
    const slotSelect = thread?.querySelector<HTMLSelectElement>("[data-apc-connection-slot]")
    expect(slotSelect?.querySelector('option[value="connection-source-1"]')?.textContent).toBe(slot?.label)
    changeValue(slotSelect as HTMLSelectElement, "connection-source-1")
    await settleUntil(
      () => app.state.getSnapshot().config?.threads.find((candidate) => candidate.id === THREAD_A)?.connectionSlotId === slot?.id,
      "thread slot assignment",
    )
    const slotConsent = fixture.backend.requests("resolve_consent").at(-1)
    if (slotConsent?.type !== "resolve_consent") throw new Error("Expected slot consent resolution")
    fixture.backend.respondConsent(slotConsent.correlationId, slotConsent.payload, "required")
    await settleUntil(
      () => thread?.querySelector<HTMLSelectElement>("[data-apc-host-connection]")?.disabled === false,
      "scoped host connection selection",
    )
    const hostSelect = thread?.querySelector<HTMLSelectElement>("[data-apc-host-connection]")
    changeValue(hostSelect as HTMLSelectElement, "connection-choice-1")
    click(thread as HTMLElement, "[data-apc-bind]")
    await settleUntil(
      () => fixture.backend.requests("bind_slot").some((request) =>
        request.type === "bind_slot" && request.payload.slotId === slot?.id,
      ),
      "generated slot bind request",
    )
    const bind = fixture.backend.requests("bind_slot").at(-1)
    expect(bind?.type).toBe("bind_slot")
    if (bind?.type === "bind_slot") {
      expect(bind.payload).toMatchObject({
        presetId: PRESET_A,
        slotId: slot?.id,
        patch: { connectionId: CONNECTION_ID },
      })
    }
    await settleUntil(
      () => app.state.getSnapshot().connectionBindings[slot?.id ?? ""]?.bound === true,
      "authoritative slot binding",
    )
    const postBindConsent = fixture.backend.requests("resolve_consent").at(-1)
    if (postBindConsent?.type === "resolve_consent") {
      fixture.backend.respondConsent(postBindConsent.correlationId, postBindConsent.payload, "required")
    }
    expect(`${app.root.innerHTML}${fixture.ui.toolbar?.root.innerHTML ?? ""}`).not.toContain(slot?.id ?? "")
    const teardown = app.teardown()
    await teardown
    assertDisarmed(fixture)
  })

  test("unbinds a bound host slot before removing its unreferenced graph slot", async () => {
    const fixture = new HostFixture()
    const app = await createApcApp(fixture.context)
    const config = graphConfig("A")
    config.threads = config.threads.map(({ connectionSlotId: _slot, ...thread }) => thread)
    fixture.editor.switchPreset(PRESET_A, config)
    await settleUntil(
      () => app.state.getSnapshot().hydrated && fixture.backend.requests("list_connections").length > 0,
      "bound slot removal hydration",
    )
    const connectionRequest = fixture.backend.requests("list_connections").at(-1)
    fixture.backend.respondConnections(connectionRequest?.correlationId ?? "", [CONNECTION])
    const graph = app.root.querySelector<HTMLElement>('[data-apc-graph-surface="topology"]')
    await settleUntil(
      () => graph?.querySelector<HTMLButtonElement>('[data-action="remove-connection-slot"]')?.disabled === false,
      "bound slot removal action",
    )
    click(graph as HTMLElement, '[data-action="remove-connection-slot"]')
    click(graph as HTMLElement, '[data-action="confirm-removal"]')
    await settleUntil(
      () => fixture.backend.requests("unbind_slot").some((request) =>
        request.type === "unbind_slot" && request.payload.slotId === SLOT_ID,
      ),
      "authoritative slot unbind",
    )
    expect(fixture.backend.requests("unbind_slot").at(-1)?.payload).toEqual({
      presetId: PRESET_A,
      slotId: SLOT_ID,
    })
    await settleUntil(
      () => (app.state.getSnapshot().config?.connectionSlots.length ?? 0) === 0,
      "bound slot removal",
    )
    const teardown = app.teardown()
    assertDisarmed(fixture)
    await teardown
  })

  test("keeps a graph slot when authoritative unbinding fails", async () => {
    const fixture = new HostFixture()
    fixture.backend.rejectNextUnbind = true
    const app = await createApcApp(fixture.context)
    const config = graphConfig("A")
    config.threads = config.threads.map(({ connectionSlotId: _slot, ...thread }) => thread)
    fixture.editor.switchPreset(PRESET_A, config)
    await settleUntil(
      () => app.state.getSnapshot().hydrated && fixture.backend.requests("list_connections").length > 0,
      "failed unbind hydration",
    )
    const connectionRequest = fixture.backend.requests("list_connections").at(-1)
    fixture.backend.respondConnections(connectionRequest?.correlationId ?? "", [CONNECTION])
    const graph = app.root.querySelector<HTMLElement>('[data-apc-graph-surface="topology"]')
    await settleUntil(
      () => graph?.querySelector<HTMLButtonElement>('[data-action="remove-connection-slot"]')?.disabled === false,
      "failed unbind removal action",
    )
    click(graph as HTMLElement, '[data-action="remove-connection-slot"]')
    click(graph as HTMLElement, '[data-action="confirm-removal"]')
    await settleUntil(
      () => fixture.backend.requests("unbind_slot").some((request) =>
        request.type === "unbind_slot" && request.payload.slotId === SLOT_ID,
      ),
      "failed slot unbind request",
    )
    await settle()
    expect(app.state.getSnapshot().config?.connectionSlots).toHaveLength(1)
    expect(graph?.querySelector("[data-apc-connection-slot=true]")).not.toBeNull()
    const teardown = app.teardown()
    assertDisarmed(fixture)
    await teardown
  })

  test("removes an unbound graph slot without issuing an authoritative unbind", async () => {
    const fixture = new HostFixture()
    const app = await createApcApp(fixture.context)
    const slotId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    const config = graphConfig("A")
    config.connectionSlots = [{ id: slotId, label: "Local slot" }]
    config.threads = config.threads.map(({ connectionSlotId: _slot, ...thread }) => thread)
    fixture.editor.switchPreset(PRESET_A, config)
    await settleUntil(
      () => app.state.getSnapshot().hydrated && fixture.backend.requests("list_connections").length > 0,
      "unbound slot removal hydration",
    )
    const connectionRequest = fixture.backend.requests("list_connections").at(-1)
    fixture.backend.respondConnections(connectionRequest?.correlationId ?? "", [CONNECTION])
    const graph = app.root.querySelector<HTMLElement>('[data-apc-graph-surface="topology"]')
    await settleUntil(
      () => graph?.querySelector<HTMLButtonElement>('[data-action="remove-connection-slot"]')?.disabled === false,
      "unbound slot removal action",
    )
    const unbindCount = fixture.backend.requests("unbind_slot").length
    click(graph as HTMLElement, '[data-action="remove-connection-slot"]')
    click(graph as HTMLElement, '[data-action="confirm-removal"]')
    await settleUntil(
      () => (app.state.getSnapshot().config?.connectionSlots.length ?? 0) === 0,
      "unbound slot removal",
    )
    expect(fixture.backend.requests("unbind_slot")).toHaveLength(unbindCount)
    const teardown = app.teardown()
    assertDisarmed(fixture)
    await teardown
  })

  test("projects Sequential threads onto authoritative Main consent and omits slot choices", async () => {
    const fixture = new HostFixture()
    const app = await createApcApp(fixture.context)
    fixture.editor.switchPreset(PRESET_A, graphConfig("A"))
    await settleUntil(
      () => app.state.getSnapshot().hydrated && fixture.backend.requests("list_connections").length > 0,
      "Sequential workflow hydration",
    )
    const connectionRequest = fixture.backend.requests("list_connections").at(-1)
    fixture.backend.respondConnections(connectionRequest?.correlationId ?? "", [CONNECTION])
    await settleUntil(
      () => fixture.ui.toolbar?.root.querySelector<HTMLButtonElement>(
        '[data-action="select-mode"][data-mode="sequential"]',
      )?.disabled === false,
      "Sequential mode availability",
    )

    const graph = app.root.querySelector<HTMLElement>('[data-apc-graph-surface="navigation"]')
    actionByText(graph as HTMLElement, "select-thread", "A Research").click()
    await settle()
    expect(app.state.getSnapshot().selection).toEqual({ kind: "thread", threadId: THREAD_A })

    const toolbar = fixture.ui.toolbar?.root as HTMLElement
    clickEnabled(toolbar, '[data-action="select-mode"][data-mode="sequential"]')
    await settleUntil(
      () => app.state.getSnapshot().config?.activeMode === "sequential",
      "Sequential mode persistence",
    )
    expect(app.state.getSnapshot().config?.activeMode).toBe("sequential")
    expect(app.state.getSnapshot().selection).toEqual({ kind: "thread", threadId: THREAD_A })

    const thread = app.root.querySelector<HTMLElement>('[data-apc-thread-surface="configuration"]')
    const connectionSlot = thread?.querySelector<HTMLSelectElement>("[data-apc-connection-slot]")
    expect([...connectionSlot?.options ?? []].map((option) => option.value)).toEqual(["connection-source-main"])
    await settleUntil(
      () => fixture.backend.requests("resolve_consent").some((request) =>
        request.type === "resolve_consent" && request.payload.connectionSourceKey === "main"
      ),
      "Main consent resolution",
    )
    const resolve = fixture.backend.requests("resolve_consent").at(-1)
    expect(resolve?.payload).toEqual({
      presetId: PRESET_A,
      threadId: THREAD_A,
      workspaceSource: "native-blocks",
      connectionSourceKey: "main",
    })
    if (resolve?.type !== "resolve_consent") throw new Error("Expected resolve consent")
    fixture.backend.respondConsent(resolve.correlationId, resolve.payload, "required")
    await settle()
    const mainRequestsBeforeReview = fixture.backend.requests("resolve_consent").length
    click(thread as HTMLElement, "[data-apc-open-consent-review]")
    await settleUntil(
      () => fixture.backend.requests("resolve_consent").length > mainRequestsBeforeReview,
      "fresh Main consent review resolution",
    )
    expect(thread?.querySelector<HTMLButtonElement>("[data-apc-approve-consent]")?.disabled).toBe(true)
    const reviewResolve = fixture.backend.requests("resolve_consent").at(-1)
    if (reviewResolve?.type !== "resolve_consent") throw new Error("Expected fresh Main consent resolution")
    fixture.backend.respondConsent(reviewResolve.correlationId, reviewResolve.payload, "required")
    await settleUntil(
      () => {
        const acknowledge = thread?.querySelector<HTMLInputElement>("[data-apc-consent-acknowledge]")
        return acknowledge !== null && acknowledge !== undefined && !acknowledge.disabled
      },
      "resolved Main consent review",
    )
    const review = thread?.querySelector<HTMLElement>("[data-apc-consent-review]")
    expect(review?.textContent).toContain(CONNECTION.name)
    const t = createApcTranslator(() => fixture.locale.get())
    expect(review?.textContent).toContain(t("consent.disclosureSummary", {
      destination: CONNECTION.name,
      workspace: t("workspace.nativeBlocks"),
    }))
    expect(review?.textContent).toContain(createApcTranslator(() => fixture.locale.get())("workspace.nativeBlocks"))
    expect(review?.textContent).toContain(createApcTranslator(() => fixture.locale.get())("graph.inputs"))
    expect(review?.textContent).toContain(createApcTranslator(() => fixture.locale.get())("binding.output"))
    changeValue(
      thread?.querySelector<HTMLInputElement>("[data-apc-consent-acknowledge]") as HTMLInputElement,
      true,
    )
    click(thread as HTMLElement, "[data-apc-approve-consent]")
    await settleUntil(
      () => fixture.backend.requests("approve_consent").some((request) =>
        request.type === "approve_consent" &&
        request.payload.workspaceSource === "native-blocks" &&
        request.payload.connectionSourceKey === "main"
      ),
      "Main consent approval",
    )
    expect(fixture.backend.requests("approve_consent").at(-1)?.payload).toEqual({
      presetId: PRESET_A,
      threadId: THREAD_A,
      workspaceSource: "native-blocks",
      connectionSourceKey: "main",
    })

    const teardown = app.teardown()
    assertDisarmed(fixture)
    await teardown
  })

  test("disarms when a mixed permission update omits a required permission", async () => {
    const fixture = new HostFixture()
    const app = await createApcApp(fixture.context)

    fixture.events.emit("PERMISSION_CHANGED", {
      permission: "final_response",
      granted: false,
      allGranted: ["interceptor", "generation", "final_response"],
    })

    assertDisarmed(fixture)
    await app.teardown()
  })

  test("keeps final-response permission optional and updates Thread route availability in place", async () => {
    const fixture = new HostFixture()
    const releasePermissionRead = fixture.blockPermissionRead()
    const appPromise = createApcApp(fixture.context)
    fixture.events.emit("PERMISSION_CHANGED", {
      permission: "final_response",
      granted: false,
      allGranted: ["interceptor", "generation", "presets"],
    })
    releasePermissionRead()
    const app = await appPromise
    fixture.editor.switchPreset(PRESET_A, graphConfig("A"))
    await settle()
    const connectionRequest = fixture.backend.requests("list_connections").at(-1)
    fixture.backend.respondConnections(connectionRequest?.correlationId ?? "", [CONNECTION])
    await settle()
    const navigation = app.root.querySelector<HTMLElement>('[data-apc-graph-surface="navigation"]')
    const graph = app.root.querySelector<HTMLElement>('[data-apc-graph-surface="topology"]')
    actionByText(navigation as HTMLElement, "select-run", "A Research").click()
    await settle()

    expect(graph?.querySelector<HTMLButtonElement>('[data-action="final-thread"]')?.disabled).toBe(true)
    fixture.events.emit("PERMISSION_CHANGED", {
      permission: "final_response",
      granted: true,
      allGranted: ["interceptor", "generation", "presets", "final_response"],
    })
    expect(graph?.querySelector<HTMLButtonElement>('[data-action="final-thread"]')?.disabled).toBe(false)
    fixture.events.emit("PERMISSION_CHANGED", {
      permission: "final_response",
      granted: false,
      allGranted: ["interceptor", "generation", "presets"],
    })
    expect(graph?.querySelector<HTMLButtonElement>('[data-action="final-thread"]')?.disabled).toBe(true)
    expect(fixture.ui.tabDestroyed).toBe(false)

    const teardown = app.teardown()
    assertDisarmed(fixture)
    await teardown
  })

  test("disarms synchronously while an ordinary autosave flush is still pending", async () => {
    const fixture = new HostFixture()
    const teardown = await setup(fixture.context)
    fixture.editor.switchPreset(PRESET_A, graphConfig("A"))
    await settleUntil(
      () => fixture.backend.requests("list_connections").length > 0,
      "autosave teardown hydration",
    )
    const toolbarRoot = fixture.ui.toolbar?.root
    const pendingConnections = fixture.backend.requests("list_connections")[0]
    const sequentialMode = toolbarRoot?.querySelector<HTMLElement>('[data-action="select-mode"][data-mode="sequential"]')
    fixture.backend.respondConnections(pendingConnections?.correlationId ?? "", [CONNECTION])
    await settleUntil(
      () => sequentialMode?.hasAttribute("disabled") === false,
      "autosave teardown mode availability",
    )
    expect(sequentialMode).not.toBeNull()
    expect(sequentialMode?.hasAttribute("disabled")).toBe(false)

    const releaseFlush = fixture.editor.blockFlush()
    const flushCountBeforeSave = fixture.editor.flushCount
    sequentialMode?.dispatchEvent(new browser.window.MouseEvent("click", { bubbles: true }))
    await settle()
    expect(fixture.editor.flushCount).toBe(flushCountBeforeSave + 1)
    const flushCountAtAuthorityLoss = fixture.editor.flushCount
    const sentAtAuthorityLoss = fixture.backend.sent.length

    fixture.events.emit("EXTENSION_DISABLED", {})
    assertDisarmed(fixture)
    expect(fixture.editor.flushCount).toBe(flushCountAtAuthorityLoss)
    sequentialMode?.dispatchEvent(new browser.window.MouseEvent("click", { bubbles: true }))
    fixture.backend.respondConnections(pendingConnections?.correlationId ?? "", [HOSTILE_CONNECTION])
    expect(fixture.editor.flushCount).toBe(flushCountAtAuthorityLoss)
    expect(fixture.backend.sent).toHaveLength(sentAtAuthorityLoss)

    releaseFlush()
    await settle()
    assertDisarmed(fixture)
    expect(fixture.editor.flushCount).toBe(flushCountAtAuthorityLoss)
    await teardown()
  })

  test("settles a controlled workspace flush without remounting after authority loss", async () => {
    const fixture = new HostFixture()
    const app = await createApcApp(fixture.context)
    fixture.editor.switchPreset(PRESET_A, graphConfig("A"))
    await settle()
    const graph = app.root.querySelector<HTMLElement>('[data-apc-graph-surface="navigation"]')
    actionByText(graph as HTMLElement, "select-thread", "A Research").click()
    await settle()
    const configuration = app.root.querySelector<HTMLElement>('[data-apc-thread-surface="configuration"]')
    click(configuration as HTMLElement, "[data-apc-open-workspace]")
    await settle()
    const loom = fixture.loomMounts.findLast((mount) => !mount.destroyed)
    loom?.options.onChange?.({ blocks: [], promptVariableValues: { "block-safe": { tone: "durable" } } })
    const releaseFlush = fixture.editor.blockFlush()
    const flushCountBeforeSave = fixture.editor.flushCount
    const flush = app.flushWorkspace()
    await settleUntil(
      () => fixture.editor.flushCount === flushCountBeforeSave + 1,
      "controlled workspace host flush",
    )

    fixture.events.emit("EXTENSION_DISABLED", {})
    assertDisarmed(fixture)
    releaseFlush()
    await flush
    assertDisarmed(fixture)
    expect(fixture.editor.flushCount).toBe(flushCountBeforeSave + 1)
    await app.teardown()
  })

  test("drops a bind continuation when authority is lost after its endpoint settles", async () => {
    const fixture = new HostFixture()
    const app = await createApcApp(fixture.context)
    fixture.editor.switchPreset(PRESET_A, graphConfig("A"))
    await settle()
    const connectionRequest = fixture.backend.requests("list_connections").at(-1)
    fixture.backend.respondConnections(connectionRequest?.correlationId ?? "", [CONNECTION])
    await settle()
    const graph = app.root.querySelector<HTMLElement>('[data-apc-graph-surface="navigation"]')
    actionByText(graph as HTMLElement, "select-thread", "A Research").click()
    await settle()
    const thread = app.root.querySelector<HTMLElement>('[data-apc-thread-surface="configuration"]')
    const consentBaseline = fixture.backend.requests("resolve_consent").length
    click(thread as HTMLElement, "[data-apc-unbind]")
    await settleUntil(
      () => fixture.backend.requests("resolve_consent").length > consentBaseline,
      "post-unbind consent resolution",
    )
    const unboundConsent = fixture.backend.requests("resolve_consent").at(-1)
    if (unboundConsent?.type !== "resolve_consent") throw new Error("Expected consent resolution after unbind")
    fixture.backend.respondConsent(unboundConsent.correlationId, unboundConsent.payload, "required")
    await settleUntil(
      () => thread?.querySelector<HTMLSelectElement>("[data-apc-host-connection]")?.disabled === false,
      "unbound connection selection",
    )
    const hostConnection = thread?.querySelector<HTMLSelectElement>("[data-apc-host-connection]")
    changeValue(hostConnection as HTMLSelectElement, "connection-choice-1")
    await settleUntil(
      () => thread?.querySelector<HTMLButtonElement>("[data-apc-bind]")?.disabled === false,
      "bind action",
    )
    const resolveCountBeforeBind = fixture.backend.requests("resolve_consent").length
    click(thread as HTMLElement, "[data-apc-bind]")
    const bind = fixture.backend.requests("bind_slot").at(-1)
    if (bind?.type !== "bind_slot") throw new Error("Expected pending bind")
    const settledBinding: BackendBindingResponse = {
      version: PROTOCOL_VERSION,
      type: "binding",
      correlationId: bind.correlationId,
      sequence: 9_001,
      payload: {
        presetId: PRESET_A,
        slotId: SLOT_ID,
        bound: true,
        status: "bound",
        descriptor: {
          label: CONNECTION.name,
          provider: CONNECTION.provider,
          model: CONNECTION.model,
        },
      },
    }
    fixture.backend.respond(settledBinding)
    fixture.events.emit("EXTENSION_DISABLED", {})
    assertDisarmed(fixture)
    await settle()
    assertDisarmed(fixture)
    expect(fixture.backend.requests("resolve_consent")).toHaveLength(resolveCountBeforeBind)
    await app.teardown()
  })

  test("cleans every resource when authority is lost in initial toolbar visibility", async () => {
    const fixture = new HostFixture()
    fixture.ui.onSetVisible = () => fixture.events.emit("EXTENSION_DISABLED", {})
    await expect(setup(fixture.context)).rejects.toThrow(/cancelled/)
    assertDisarmed(fixture)
  })

  test("cleans every resource when authority is lost during tab activation registration", async () => {
    const fixture = new HostFixture()
    fixture.ui.onActivateRegister = () => fixture.events.emit("EXTENSION_DISABLED", {})
    await expect(setup(fixture.context)).rejects.toThrow(/cancelled/)
    assertDisarmed(fixture)
  })

  test("immediately unregisters a locale listener when subscription loses authority", async () => {
    const fixture = new HostFixture()
    fixture.locale.onSubscribe = () => fixture.events.emit("EXTENSION_DISABLED", {})
    await expect(setup(fixture.context)).rejects.toThrow(/cancelled/)
    assertDisarmed(fixture)
    expect(fixture.locale.listenerCount()).toBe(0)
  })

  test("destroys a Loom handle exactly once when authority is lost during mount", async () => {
    const fixture = new HostFixture()
    const app = await createApcApp(fixture.context)
    fixture.editor.switchPreset(PRESET_A, graphConfig("A"))
    await settleUntil(() => app.state.getSnapshot().hydrated, "Loom authority hydration")
    const navigation = app.root.querySelector<HTMLElement>('[data-apc-graph-surface="navigation"]')
    actionByText(navigation as HTMLElement, "select-thread", "A Research").click()
    await settle()
    const configuration = app.root.querySelector<HTMLElement>('[data-apc-thread-surface="configuration"]')
    fixture.onLoomMount = () => fixture.events.emit("EXTENSION_DISABLED", {})
    click(configuration as HTMLElement, "[data-apc-open-workspace]")
    await settle()
    expect(fixture.loomMounts).toHaveLength(1)
    expect(fixture.loomMounts[0]?.destroyed).toBe(true)
    expect(fixture.loomMounts[0]?.destroyCount).toBe(1)
    assertDisarmed(fixture)
    await app.teardown()
  })

  for (const event of ["EXTENSION_DISABLED", "EXTENSION_UPDATED", "EXTENSION_UPDATE", "EXTENSION_UNLOADED"]) {
    test(`synchronously disarms on ${event} and rejects late host responses`, async () => {
      const fixture = new HostFixture()
      const teardown = await setup(fixture.context)
      fixture.editor.switchPreset(PRESET_A, graphConfig("A"))
      await settle()
      const pendingConnections = fixture.backend.requests("list_connections")[0]
      fixture.backend.respondConnections(pendingConnections?.correlationId ?? "", [CONNECTION])
      await settle()
      const graph = fixture.ui.tab?.root.querySelector<HTMLElement>('[data-apc-graph-surface="navigation"]')
      actionByText(graph as HTMLElement, "select-thread", "A Research").click()
      await settle()
      const thread = fixture.ui.tab?.root.querySelector<HTMLElement>('[data-apc-thread-surface="configuration"]')
      click(thread as HTMLElement, "[data-apc-open-workspace]")
      await settle()
      expect(fixture.loomMounts.some((mount) => !mount.destroyed)).toBe(true)
      const consentBaseline = fixture.backend.requests("resolve_consent").length
      click(thread as HTMLElement, "[data-apc-open-consent-review]")
      await settleUntil(
        () => fixture.backend.requests("resolve_consent").length > consentBaseline,
        "pending review resolver",
      )
      const pendingConsent = fixture.backend.requests("resolve_consent").at(-1)
      if (pendingConsent?.type !== "resolve_consent") throw new Error("Expected pending consent resolution")
      fixture.backend.respondConsent(pendingConsent.correlationId, pendingConsent.payload, "required")
      const sentAtAuthorityLoss = fixture.backend.sent.length
      const flushCount = fixture.editor.flushCount

      fixture.events.emit(event, {})
      assertDisarmed(fixture)
      expect(fixture.editor.flushCount).toBe(flushCount)
      fixture.backend.respondConnections(pendingConnections?.correlationId ?? "", [HOSTILE_CONNECTION])
      fixture.backend.respondActivity(PRESET_A, "completed")
      await settle()
      expect(fixture.backend.sent).toHaveLength(sentAtAuthorityLoss)
      assertDisarmed(fixture)
      expect(browser.window.document.body.textContent).not.toContain("Hostile connection")
      expect(browser.window.document.body.textContent).not.toContain("Completed")
      await teardown()
    })
  }

  test("synchronously disarms when a required permission is revoked", async () => {
    const fixture = new HostFixture()
    const teardown = await setup(fixture.context)
    fixture.editor.switchPreset(PRESET_A, graphConfig("A"))
    await settle()
    const graph = fixture.ui.tab?.root.querySelector<HTMLElement>('[data-apc-graph-surface="navigation"]')
    actionByText(graph as HTMLElement, "select-thread", "A Research").click()
    await settle()
    const configuration = fixture.ui.tab?.root.querySelector<HTMLElement>('[data-apc-thread-surface="configuration"]')
    click(configuration as HTMLElement, "[data-apc-open-workspace]")
    await settle()
    expect(fixture.loomMounts.some((mount) => !mount.destroyed)).toBe(true)
    const flushCount = fixture.editor.flushCount

    fixture.events.emit("PERMISSION_CHANGED", { permission: "presets", granted: false })
    assertDisarmed(fixture)
    expect(fixture.editor.flushCount).toBe(flushCount)
    await teardown()
  })

  test("cleans a partially mounted application when setup fails", async () => {
    const fixture = new HostFixture()
    fixture.locale.failSubscribe = true

    await expect(setup(fixture.context)).rejects.toThrow("locale subscription failed")
    assertDisarmed(fixture)
    expect(fixture.ui.tabDestroyCount).toBe(1)
    expect(fixture.ui.toolbarDestroyCount).toBe(1)
    expect(fixture.editor.flushCount).toBe(0)
    fixture.locale.failSubscribe = false
    const retryTeardown = await setup(fixture.context)
    expect(fixture.deferReadyCalls).toBe(2)
    expect(fixture.readyCalls).toBe(2)
    expect(browser.window.document.querySelectorAll("[data-apc-app]")).toHaveLength(1)
    const retryResult = retryTeardown()
    assertDisarmed(fixture)
    await retryResult
  })

  test("rejects an incompatible host before registering any resource", () => {
    const fixture = new HostFixture()
    const incompatible = {
      ...fixture.context,
      host: { ...fixture.context.host, lumiverseVersion: "0.0.0" },
    } as SpindleFrontendContext

    expect(() => setup(incompatible)).toThrow()
    expect(fixture.deferReadyCalls).toBe(0)
    expect(fixture.readyCalls).toBe(0)
    expect(fixture.ui.tab).toBeNull()
    expect(fixture.ui.toolbar).toBeNull()
    expect(fixture.backend.listenerCount()).toBe(0)
    expect(fixture.editor.listenerCount()).toBe(0)
    expect(fixture.locale.listenerCount()).toBe(0)
    expect(fixture.events.listenerCount()).toBe(0)
    expect(browser.window.document.body.childElementCount).toBe(0)
    expect(browser.window.document.head.childElementCount).toBe(0)
  })

  test("rejects malformed correlated backend replies without retaining private payloads", async () => {
    const fixture = new HostFixture()
    const app = await createApcApp(fixture.context)
    fixture.editor.switchPreset(PRESET_A, graphConfig("A"))
    await settle()
    await settle()
    expect(app.state.getSnapshot().hydrated).toBe(true)

    const pendingRefresh = app.state.refreshConnections()
    const requests = fixture.backend.requests("list_connections")
    const request = requests[requests.length - 1]
    expect(request).toBeDefined()
    const privateCarrierMessage = "PRIVATE carrier receipt must never reach frontend state"
    fixture.backend.respondMalformedConnections(request?.correlationId ?? "", privateCarrierMessage)

    await expect(pendingRefresh).rejects.toMatchObject({
      code: "APC_BACKEND_PROTOCOL_ERROR",
      message: "APC backend response could not be decoded",
    })
    expect(JSON.stringify(app.state.getSnapshot())).not.toContain(privateCarrierMessage)
    expect(app.root.textContent).not.toContain(privateCarrierMessage)

    fixture.backend.respondConnections(request?.correlationId ?? "", [HOSTILE_CONNECTION])
    await settle()
    expect(app.state.getSnapshot().availableConnections).toEqual([])
    expect(app.root.textContent).not.toContain("Hostile connection")

    const disposeResult = app.teardown()
    assertDisarmed(fixture)
    await disposeResult
  })

  test("disposes the public app state synchronously before its Promise settles", async () => {
    const fixture = new HostFixture()
    const app = await createApcApp(fixture.context)

    const disposeResult = app.teardown()
    assertDisarmed(fixture)
    expect(() => app.state.setSelection({ kind: "main" })).toThrow("disposed")
    expect(app.teardown()).toBe(disposeResult)
    await disposeResult
  })

  test("supports idempotent public dispose followed by a clean re-setup", async () => {
    const fixture = new HostFixture()
    const firstTeardown = await setup(fixture.context)
    const firstResult = firstTeardown()
    assertDisarmed(fixture)
    expect(firstTeardown()).toBe(firstResult)
    await firstResult
    expect(fixture.ui.tabDestroyCount).toBe(1)
    expect(fixture.ui.toolbarDestroyCount).toBe(1)

    const secondTeardown = await setup(fixture.context)
    expect(fixture.deferReadyCalls).toBe(2)
    expect(fixture.readyCalls).toBe(2)
    expect(fixture.backend.listenerCount()).toBeGreaterThan(0)
    expect(fixture.editor.listenerCount()).toBeGreaterThan(0)
    expect(fixture.locale.listenerCount()).toBeGreaterThan(0)
    expect(fixture.events.listenerCount()).toBeGreaterThan(0)
    expect(browser.window.document.querySelectorAll("[data-apc-app]")).toHaveLength(1)
    expect(browser.window.document.head.querySelectorAll("style")).toHaveLength(2)

    const secondResult = secondTeardown()
    assertDisarmed(fixture)
    expect(secondTeardown()).toBe(secondResult)
    await secondResult
    expect(fixture.ui.tabDestroyCount).toBe(2)
    expect(fixture.ui.toolbarDestroyCount).toBe(2)
  })
})

afterAll(() => {
  for (const [name, value] of previousGlobals) globals[name] = value
})

