// @ts-ignore Bun provides the test module at runtime; the extension bundle excludes this file.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import type {
  PromptBlockDTO,
  SpindleHostDescriptorV1,
  SpindleLoomBlockEditorHandle,
  SpindleLoomBlockEditorOptions,
  SpindleLoomBlockEditorValue,
} from "lumiverse-spindle-types"
import type { ConnectionSummary } from "../protocol/messages"
import { createApcTranslator } from "../i18n/catalogs"
import type { ApcCatalogKey, ApcTranslate } from "../i18n/catalogs"
import {
  createThreadEditor,
  type ThreadEditorConsentSelector,
  type ThreadEditorController,
  type ThreadEditorOptions,
  type ThreadEditorRunBindingChange,
  type ThreadEditorRunChange,
  type ThreadEditorSlotSnapshot,
  type ThreadEditorSnapshot,
} from "./thread-editor"

const INSTALLATION_ID = "550e8400-e29b-41d4-a716-446655440000"
const PRESET_ID = "preset-private-id"
const THREAD_A = "thread-private-a"
const THREAD_B = "thread-private-b"
const RUN_SELECTED = "run-private-selected"
const RUN_EARLIER_A = "run-private-earlier-a"
const RUN_EARLIER_B = "run-private-earlier-b"
const BINDING_A = "binding-private-a"
const BINDING_B = "binding-private-b"
const SLOT_A = "slot-private-a"
const SLOT_B = "slot-private-b"
const CONNECTION_PRIMARY = "connection-private-primary"
const CONNECTION_BACKUP = "connection-private-backup"

function translator(locale: string): ApcTranslate {
  return (key: ApcCatalogKey, values?: Readonly<Record<string, unknown>>) => {
    const suffix = values === undefined
      ? ""
      : Object.entries(values).map(([name, value]) => `|${name}=${String(value)}`).join("")
    return `${locale}:${key}${suffix}`
  }
}

async function settleUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await Promise.resolve()
  }
  throw new Error("Asynchronous UI state did not settle")
}

class FakeText extends EventTarget {
  readonly nodeType = 3
  parentElement: FakeElement | null = null
  textContent: string

  constructor(value: string) {
    super()
    this.textContent = value
  }
}

class FakeElement extends EventTarget {
  readonly nodeType = 1
  readonly tagName: string
  readonly dataset: Record<string, string> = {}
  readonly attributes = new Map<string, string>()
  readonly children: FakeElement[] = []
  parentElement: FakeElement | null = null
  textContent = ""
  value = ""
  type = ""
  name = ""
  className = ""
  id = ""
  min = ""
  max = ""
  step = ""
  tabIndex = 0
  selectionStart: number | null = null
  selectionEnd: number | null = null
  checked = false
  readOnly = false
  disabled = false
  isConnected = false
  private listenerCount = 0

  constructor(tagName: string, private readonly owner: FakeDocument) {
    super()
    this.tagName = tagName.toUpperCase()
  }

  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    this.listenerCount += 1
    super.addEventListener(type, listener, options)
  }

  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void {
    this.listenerCount = Math.max(0, this.listenerCount - 1)
    super.removeEventListener(type, listener, options)
  }

  append(...nodes: Array<FakeElement | FakeText | string>): void {
    for (const node of nodes) {
      if (typeof node === "string") {
        this.textContent += node
      } else if (node instanceof FakeText) {
        node.parentElement = this
        this.textContent += node.textContent
      } else {
        this.appendChild(node)
      }
    }
  }

  appendChild(node: FakeElement): FakeElement {
    if (node.parentElement) {
      const oldIndex = node.parentElement.children.indexOf(node)
      if (oldIndex >= 0) node.parentElement.children.splice(oldIndex, 1)
    }
    node.parentElement = this
    this.children.push(node)
    node.updateConnection(this.isConnected)
    return node
  }

  insertBefore(node: FakeElement, reference: FakeElement | null): FakeElement {
    if (reference === null) return this.appendChild(node)
    const referenceIndex = this.children.indexOf(reference)
    if (referenceIndex < 0) throw new Error("reference is not a child")
    if (node.parentElement) {
      const oldIndex = node.parentElement.children.indexOf(node)
      if (oldIndex >= 0) {
        node.parentElement.children.splice(oldIndex, 1)
        if (node.parentElement === this && oldIndex < referenceIndex) {
          node.parentElement = this
          this.children.splice(referenceIndex - 1, 0, node)
          node.updateConnection(this.isConnected)
          return node
        }
      }
    }
    node.parentElement = this
    this.children.splice(referenceIndex, 0, node)
    node.updateConnection(this.isConnected)
    return node
  }

  replaceChildren(...nodes: Array<FakeElement | FakeText | string>): void {
    for (const child of this.children) {
      child.parentElement = null
      child.updateConnection(false)
    }
    this.children.splice(0)
    this.textContent = ""
    this.append(...nodes)
  }

  remove(): void {
    if (!this.parentElement) return
    const parent = this.parentElement
    const index = parent.children.indexOf(this)
    if (index >= 0) parent.children.splice(index, 1)
    this.parentElement = null
    this.updateConnection(false)
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name)
  }

  querySelector<T extends FakeElement = FakeElement>(selector: string): T | null {
    return this.querySelectorAll<T>(selector)[0] ?? null
  }

  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start
    this.selectionEnd = end
  }

  querySelectorAll<T extends FakeElement = FakeElement>(selector = "*"): T[] {
    const result: T[] = []
    const matches = (node: FakeElement): boolean => {
      if (selector === "*") return true
      const dataMatch = /^\[data-([^=\]]+)(?:="([^"]+)")?\]$/.exec(selector)
      if (dataMatch) {
        const key = dataMatch[1]!.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
        return Object.prototype.hasOwnProperty.call(node.dataset, key) &&
          (dataMatch[2] === undefined || node.dataset[key] === dataMatch[2])
      }
      return node.tagName.toLowerCase() === selector.toLowerCase()
    }
    const visit = (node: FakeElement): void => {
      for (const child of node.children) {
        if (matches(child)) result.push(child as T)
        visit(child)
      }
    }
    visit(this)
    return result
  }

  click(): void {
    if (this.disabled || !this.isConnected) return
    if (["button", "input", "select"].includes(this.tagName.toLowerCase())) this.focus()
    this.dispatchEvent(new Event("click"))
  }

  focus(): void {
    if (!this.isConnected || this.disabled) return
    this.owner.activeElement = this
  }

  get activeListeners(): number {
    return this.listenerCount
  }

  updateConnection(parentConnected: boolean): void {
    this.isConnected = parentConnected
    for (const child of this.children) child.updateConnection(parentConnected)
  }

  get ownerDocument(): FakeDocument {
    return this.owner
  }
}

class FakeDocument {
  readonly body: FakeElement
  activeElement: FakeElement | null = null

  constructor() {
    this.body = new FakeElement("body", this)
    this.body.isConnected = true
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName, this)
  }

  createTextNode(value: string): FakeText {
    return new FakeText(value)
  }
}

const globals = globalThis as unknown as Record<string, unknown>
const originalDocument = globals.document
const originalHTMLElement = globals.HTMLElement
const fakeDocument = new FakeDocument()
globals.document = fakeDocument as unknown as Document
globals.HTMLElement = FakeElement
const fakeParent = fakeDocument.body as unknown as HTMLElement

function fakeElement(element: Element): FakeElement {
  return element as unknown as FakeElement
}

function renderedText(element: Element): string {
  const node = fakeElement(element)
  return [node.textContent, ...node.children.map((child) => renderedText(child as unknown as Element))].join(" ")
}

function renderedSurface(element: Element): string {
  const node = fakeElement(element)
  const own = [
    node.textContent,
    node.value,
    node.id,
    node.name,
    ...node.attributes.entries().flatMap(([key, value]) => [key, value]),
    ...Object.entries(node.dataset).flatMap(([key, value]) => [key, value]),
  ].join(" ")
  return [own, ...node.children.map((child) => renderedSurface(child as unknown as Element))].join(" ")
}

afterEach(() => {
  fakeDocument.body.replaceChildren()
  fakeDocument.activeElement = null
})

const host = {
  descriptorVersion: 1 as const,
  lumiverseVersion: "1.0.8",
  extensionInstallationId: INSTALLATION_ID,
  capabilities: {
    "preset-extension-data-v1": 1,
    "preset-editor-v1": 1,
    "loom-block-editor-v1": 1,
    "generation-assembly-v1": 1,
    "interceptor-context-v1": 1,
    "interceptor-final-response-v1": 1,
    "connection-dispatch-resolution-v1": 1,
  },
} satisfies SpindleHostDescriptorV1

const connections: readonly ConnectionSummary[] = [
  { id: CONNECTION_PRIMARY, name: "Research profile", provider: "OpenRouter", model: "Claude Sonnet" },
  { id: CONNECTION_BACKUP, name: "Backup profile", provider: "OpenAI", model: "GPT" },
]

function slot(overrides: Partial<ThreadEditorSlotSnapshot> = {}): ThreadEditorSlotSnapshot {
  return {
    id: SLOT_A,
    label: "Research slot",
    bound: true,
    bindingStatus: "bound",
    boundConnectionId: CONNECTION_PRIMARY,
    ...overrides,
  }
}

function thread(
  id: string,
  overrides: Partial<ThreadEditorSnapshot["threads"][number]> = {},
): ThreadEditorSnapshot["threads"][number] {
  return {
    id,
    name: id === THREAD_A ? "Researcher" : "Synthesizer",
    description: id === THREAD_A ? "Collects evidence" : "Combines evidence",
    workspaceSource: "native-blocks",
    blocks: [] as PromptBlockDTO[],
    promptVariableValues: {},
    output: { id: "final", name: "untranslated-schema-name" },
    ...overrides,
  }
}

function selectedRun(): NonNullable<ThreadEditorSnapshot["selectedRun"]> {
  return {
    id: RUN_SELECTED,
    threadId: THREAD_A,
    stageName: "Synthesis stage",
    stageOrdinal: 3,
    ordinal: 3,
    required: true,
    timeoutMs: 60_000,
    positionTargets: [
      { stageOrdinal: 3, runOrdinal: 2, stageName: "Synthesis stage" },
      { stageOrdinal: 3, runOrdinal: 3, stageName: "Synthesis stage" },
      { stageOrdinal: 4, runOrdinal: 1, stageName: "Final stage" },
    ],
    positionRestricted: true,
    earlierOutputs: [
      {
        runId: RUN_EARLIER_A,
        threadName: "Researcher",
        stageName: "Evidence",
        stageOrdinal: 1,
        runOrdinal: 1,
        required: true,
      },
      {
        runId: RUN_EARLIER_B,
        threadName: "Researcher",
        stageName: "Review",
        stageOrdinal: 2,
        runOrdinal: 2,
        required: false,
      },
    ],
    bindings: [
      { id: BINDING_A, sourceRunId: RUN_EARLIER_A, role: "user", onMissing: "fail-graph" },
      { id: BINDING_B, sourceRunId: RUN_EARLIER_B, role: "assistant", onMissing: "omit-binding" },
    ],
  }
}

function snapshot(overrides: Partial<ThreadEditorSnapshot> = {}): ThreadEditorSnapshot {
  return {
    installationId: INSTALLATION_ID,
    presetId: PRESET_ID,
    contextAuthorityGeneration: 1,
    consentAuthorityGeneration: 1,
    selectedThreadId: THREAD_A,
    threads: [thread(THREAD_A), thread(THREAD_B)],
    slots: [slot()],
    connections,
    consents: [],
    consentImpact: { requiredRuns: 1, optionalRuns: 0 },
    readOnly: false,
    mutationLocked: false,
    ...overrides,
  }
}

function consent(status: "approved" | "revoked" | "required" = "required") {
  return {
    threadId: THREAD_A,
    workspaceSource: "native-blocks" as const,
    connectionSourceKey: `slot:${SLOT_A}` as const,
    status,
    destination: { label: "Safe destination", provider: "Safe provider", model: "Safe model" },
    disclosure: {
      version: 1,
      summary: "Safe disclosure.",
      categories: ["thread", "workspace", "source", "destination", "provider", "model"] as const,
    },
  }
}

function createBridge() {
  const calls: Array<{ target: FakeElement; options: SpindleLoomBlockEditorOptions }> = []
  const handles: Array<{
    destroyed: boolean
    value: SpindleLoomBlockEditorValue
    updates: Array<Partial<SpindleLoomBlockEditorOptions>>
  }> = []
  const bridge = {
    mountLoomBlockEditor(target: Element, options: SpindleLoomBlockEditorOptions): SpindleLoomBlockEditorHandle {
      calls.push({ target: target as unknown as FakeElement, options })
      const state = {
        destroyed: false,
        value: structuredClone(options.value),
        updates: [] as Array<Partial<SpindleLoomBlockEditorOptions>>,
      }
      handles.push(state)
      return {
        componentId: "loom-test",
        element: target as unknown as HTMLElement,
        update(patch) {
          state.updates.push(structuredClone(patch))
          if (patch.value) state.value = structuredClone(patch.value)
        },
        destroy() {
          state.destroyed = true
        },
        getValue() {
          return structuredClone(state.value)
        },
        refreshMacros() {
          return Promise.resolve()
        },
      }
    },
  }
  return { bridge, calls, handles }
}

describe("APC thread center workspace", () => {
  test("requires an undefined-returning synchronous consent phase projector", () => {
    const synchronousProjector: NonNullable<ThreadEditorOptions["onConsentReviewChange"]> =
      () => undefined
    // @ts-expect-error Async projectors cannot satisfy the internal synchronous coordination contract.
    const asyncProjector: NonNullable<ThreadEditorOptions["onConsentReviewChange"]> =
      async () => {}
    expect(synchronousProjector(true)).toBeUndefined()
    expect(typeof asyncProjector).toBe("function")
  })

  test("creates every editor node in the injected document without a global document", () => {
    const injectedDocument = new FakeDocument()
    const previousDocument = globals.document
    delete globals.document
    try {
      const { bridge, calls } = createBridge()
      const editor = createThreadEditor({
        host,
        presetId: PRESET_ID,
        loom: bridge,
        t: translator("en"),
        document: injectedDocument as unknown as Document,
        parent: injectedDocument.body as unknown as HTMLElement,
      })
      editor.render(snapshot())
      expect(fakeElement(editor.element).ownerDocument).toBe(injectedDocument)
      expect(fakeElement(editor.element).dataset.apcThreadSurface).toBe("all")
      expect(calls).toHaveLength(1)
      expect(calls[0]!.target.ownerDocument).toBe(injectedDocument)
      expect(editor.element.querySelector("[data-apc-host-loom-editor]")).toBe(calls[0]!.target)
      editor.destroy()
    } finally {
      globals.document = previousDocument
    }
  })

  test("separates workspace and configuration surfaces without duplicating the host Loom editor", () => {
    const workspaceBridge = createBridge()
    let backCount = 0
    const workspaceEditor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: workspaceBridge.bridge,
      t: translator("en"),
      surface: "workspace",
      parent: fakeParent,
      onBackToGraph: () => {
        backCount += 1
      },
      onDirty: () => {},
    })
    workspaceEditor.render(snapshot({ selectedRun: selectedRun() }))

    expect(fakeElement(workspaceEditor.element).dataset.apcThreadSurface).toBe("workspace")
    expect(workspaceBridge.calls).toHaveLength(1)
    expect(workspaceEditor.element.querySelector("[data-apc-host-loom-editor]"))
      .toBe(workspaceBridge.calls[0]!.target)
    expect(workspaceEditor.element.querySelector("[data-apc-back-to-graph]")).not.toBe(null)
    expect(workspaceEditor.element.querySelector("[data-apc-open-workspace]")).toBe(null)
    expect(workspaceEditor.element.querySelector("[data-apc-thread-identity]")).toBe(null)
    expect(workspaceEditor.element.querySelector("[data-apc-connection]")).toBe(null)
    expect(workspaceEditor.element.querySelector("[data-apc-run-configuration]")).toBe(null)
    expect(workspaceEditor.element.querySelector("h2")).toBe(null)
    workspaceEditor.element.querySelector<HTMLButtonElement>("[data-apc-back-to-graph]")!.click()
    expect(backCount).toBe(1)

    workspaceEditor.render(snapshot({
      threads: [thread(THREAD_A, { workspaceSource: "main-context" }), thread(THREAD_B)],
      selectedRun: undefined,
    }))
    expect(workspaceBridge.calls).toHaveLength(1)
    expect(workspaceBridge.handles[0]!.destroyed).toBe(true)
    expect(workspaceEditor.element.querySelector("[data-apc-host-loom-editor]")).toBe(null)
    expect(workspaceEditor.element.querySelector("[data-apc-main-context]")).toBe(null)
    workspaceEditor.destroy()

    const configurationBridge = createBridge()
    const opened: string[] = []
    const configurationEditor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: configurationBridge.bridge,
      t: translator("en"),
      surface: "configuration",
      parent: fakeParent,
      onOpenWorkspace: (threadId) => {
        opened.push(threadId)
      },
    })
    configurationEditor.render(snapshot({
      selectedRun: selectedRun(),
      mutationLocked: true,
      threads: [thread(THREAD_A, { connectionSlotId: SLOT_A }), thread(THREAD_B)],
    }))

    expect(fakeElement(configurationEditor.element).dataset.apcThreadSurface).toBe("configuration")
    expect(configurationBridge.calls).toHaveLength(0)
    expect(configurationEditor.element.querySelector("[data-apc-host-loom-editor]")).toBe(null)
    expect(configurationEditor.element.querySelector("[data-apc-back-to-graph]")).toBe(null)
    expect(configurationEditor.element.querySelector("[data-apc-thread-identity]")).not.toBe(null)
    expect(configurationEditor.element.querySelector("[data-apc-workspace-source-control]")).not.toBe(null)
    expect(configurationEditor.element.querySelector("[data-apc-connection]")).not.toBe(null)
    expect(configurationEditor.element.querySelector("[data-apc-run-configuration]")).not.toBe(null)
    expect(configurationEditor.element.querySelector("[data-apc-run-stage]")).not.toBe(null)
    expect(configurationEditor.element.querySelector("[data-apc-run-required]")).not.toBe(null)
    expect(configurationEditor.element.querySelector("[data-apc-run-timeout]")).not.toBe(null)
    expect(configurationEditor.element.querySelector("[data-apc-run-position]")).not.toBe(null)
    expect(configurationEditor.element.querySelector("[data-apc-earlier-output-bindings]")).not.toBe(null)
    expect(configurationEditor.element.querySelector("[data-apc-binding-missing]")).not.toBe(null)
    const open = configurationEditor.element.querySelector<HTMLButtonElement>("[data-apc-open-workspace]")!
    expect(open.disabled).toBe(false)
    open.click()
    expect(opened).toEqual([THREAD_A])
    configurationEditor.destroy()
  })

  test("blocks configuration behind consent review and explains optional dismissal", () => {
    const { bridge } = createBridge()
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      surface: "configuration",
      parent: fakeParent,
      onResolveConsent: () => {},
      onConsentReviewChange: () => {},
      onRename: () => {},
    })
    editor.render(snapshot({
      selectedRun: { ...selectedRun(), required: false },
      consentImpact: { requiredRuns: 0, optionalRuns: 1 },
      threads: [thread(THREAD_A, { connectionSlotId: SLOT_A }), thread(THREAD_B)],
      consents: [consent()],
    }))
    editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.click()

    const review = editor.element.querySelector("[data-apc-consent-review]")!
    expect(review.getAttribute("role")).toBe("dialog")
    expect(editor.element.querySelector<HTMLInputElement>("[data-apc-thread-name]")!.readOnly).toBe(true)
    const consequence = editor.element.querySelector("[data-apc-consent-dismissal-consequence]")!
    expect(fakeElement(consequence).dataset.apcConsentDismissalConsequence).toBe("optional")
    expect(renderedText(consequence))
      .toContain("en:consent.impactOptional|requiredCount=0|optionalCount=1")
    expect(renderedText(consequence)).not.toContain("en:consent.impactRequired")

    editor.element.querySelector<HTMLButtonElement>("[data-apc-close-consent-review]")!.click()
    expect(editor.element.querySelector("[data-apc-consent-review]")).toBe(null)
    expect(editor.element.querySelector<HTMLInputElement>("[data-apc-thread-name]")!.readOnly).toBe(true)
    expect(editor.element.querySelector("[data-apc-thread-live-region]")?.textContent)
      .toContain("en:consent.impactOptional|requiredCount=0|optionalCount=1")
    editor.destroy()
  })

  test("derives mixed and unscheduled dismissal effects only from selected-thread consent impact", () => {
    const cases = [
      {
        impact: { requiredRuns: 2, optionalRuns: 3 },
        kind: "mixed",
        message: "en:consent.impactMixed|requiredCount=2|optionalCount=3",
      },
      {
        impact: { requiredRuns: 0, optionalRuns: 0 },
        kind: "unscheduled",
        message: "en:consent.impactUnscheduled|requiredCount=0|optionalCount=0",
      },
    ] as const
    for (const testCase of cases) {
      const editor = createThreadEditor({
        host,
        presetId: PRESET_ID,
        loom: createBridge().bridge,
        t: translator("en"),
        parent: fakeParent,
        onResolveConsent: () => {},
      })
      editor.render(snapshot({
        selectedRun: testCase.kind === "unscheduled" ? undefined : selectedRun(),
        consentImpact: testCase.impact,
        threads: [thread(THREAD_A, { connectionSlotId: SLOT_A })],
        consents: [consent()],
      }))
      editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.click()
      const consequence = editor.element.querySelector("[data-apc-consent-dismissal-consequence]")!
      expect(fakeElement(consequence).dataset.apcConsentDismissalConsequence).toBe(testCase.kind)
      expect(renderedText(consequence)).toContain(testCase.message)
      expect(renderedText(consequence)).not.toContain("en:binding.required")
      expect(renderedText(consequence)).not.toContain("en:binding.optional")
      editor.destroy()
    }
  })

  test("keeps every configuration publisher inert during consent review and restores only the latest lock state", async () => {
    const { bridge, calls, handles } = createBridge()
    let mutationAttempts = 0
    let navigationCount = 0
    let resolutionAttempts = 0
    const mutation = (): void => {
      mutationAttempts += 1
    }
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
      onBackToGraph: () => {
        navigationCount += 1
      },
      onOpenWorkspace: () => {
        navigationCount += 1
      },
      onResolveConsent: () => {
        resolutionAttempts += 1
      },
      onRename: mutation,
      onWorkspaceSourceChange: mutation,
      onConnectionSlotChange: mutation,
      onBind: mutation,
      onUnbind: mutation,
      onRefreshConnections: mutation,
      onRunChange: mutation,
      onRunBindingChange: mutation,
      onAddRunBinding: mutation,
      onRemoveRunBinding: mutation,
      onDirty: mutation,
    })
    const view = snapshot({
      selectedRun: selectedRun(),
      threads: [thread(THREAD_A, { connectionSlotId: SLOT_A })],
      consents: [consent()],
    })
    editor.render(view)
    editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.click()

    const mutationSelectors = [
      "[data-apc-thread-name]",
      "[data-apc-thread-description]",
      "[data-apc-workspace-source-option]",
      "[data-apc-connection-slot]",
      "[data-apc-host-connection]",
      "[data-apc-bind]",
      "[data-apc-unbind]",
      "[data-apc-refresh-connections]",
      "[data-apc-run-required]",
      "[data-apc-run-timeout]",
      "[data-apc-run-position]",
      "[data-apc-binding-source]",
      "[data-apc-binding-role]",
      "[data-apc-binding-missing]",
      "[data-apc-add-run-binding]",
      "[data-apc-remove-run-binding]",
    ] as const
    for (const selector of mutationSelectors) {
      const controls = editor.element.querySelectorAll<
        HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement
      >(selector)
      expect(controls.length).toBeGreaterThan(0)
      for (const control of Array.from(controls)) {
        expect(control.disabled || ("readOnly" in control && control.readOnly)).toBe(true)
        control.dispatchEvent(new Event(control.tagName.toLowerCase() === "button" ? "click" : "change"))
      }
    }
    expect(handles[0]!.updates.at(-1)?.readOnly).toBe(true)
    calls[0]!.options.onChange?.({ blocks: [], promptVariableValues: {} })
    expect(mutationAttempts).toBe(0)

    const back = editor.element.querySelector<HTMLButtonElement>("[data-apc-back-to-graph]")!
    const openWorkspace = editor.element.querySelector<HTMLButtonElement>("[data-apc-open-workspace]")!
    const close = editor.element.querySelector<HTMLButtonElement>("[data-apc-close-consent-review]")!
    expect(back.disabled).toBe(true)
    expect(openWorkspace.disabled).toBe(true)
    expect(close.disabled).toBe(false)
    back.click()
    openWorkspace.click()
    expect(navigationCount).toBe(0)

    close.click()
    expect(editor.element.querySelector("[data-apc-consent-review]")).toBe(null)
    for (const selector of mutationSelectors) {
      const controls = editor.element.querySelectorAll<
        HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement
      >(selector)
      expect(controls.length).toBeGreaterThan(0)
      for (const control of Array.from(controls)) {
        expect(control.disabled || ("readOnly" in control && control.readOnly)).toBe(true)
      }
    }
    expect(handles[0]!.updates.at(-1)?.readOnly).toBe(true)

    await settleUntil(() => resolutionAttempts === 1)
    editor.render({ ...view, consentAuthorityGeneration: 2 })
    await settleUntil(() =>
      editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")?.disabled === false
    )
    for (const selector of mutationSelectors) {
      const controls = editor.element.querySelectorAll<
        HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement
      >(selector)
      expect(controls.length).toBeGreaterThan(0)
      for (const control of Array.from(controls)) {
        expect(control.disabled || ("readOnly" in control && control.readOnly)).toBe(false)
      }
    }
    expect(handles[0]!.updates.at(-1)?.readOnly).toBe(false)
    editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.click()
    await settleUntil(() => resolutionAttempts === 2)
    editor.render({ ...view, consentAuthorityGeneration: 3, mutationLocked: true })
    expect(editor.element.querySelector("[data-apc-consent-review]")).not.toBe(null)
    editor.element.querySelector<HTMLButtonElement>("[data-apc-close-consent-review]")!.click()
    expect(editor.element.querySelector("[data-apc-consent-review]")).toBe(null)
    expect(editor.element.querySelector<HTMLInputElement>("[data-apc-thread-name]")!.readOnly).toBe(true)
    expect(handles[0]!.updates.at(-1)?.readOnly).toBe(true)
    expect(calls).toHaveLength(1)
    expect(mutationAttempts).toBe(0)
    editor.destroy()
  })

  test("keeps queued workspace publishing inert after lock changes during consent review", async () => {
    const workspaceBridge = createBridge()
    let projectedReviewOpen = false
    let workspaceLocked = false
    let flushSettled = false
    let flushCount = 0
    const phaseChanges: boolean[] = []
    const dirty: Array<[string, SpindleLoomBlockEditorValue]> = []
    const workspaceView = snapshot({
      threads: [thread(THREAD_A, { connectionSlotId: SLOT_A })],
      consents: [consent()],
    })
    const workspaceEditor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: workspaceBridge.bridge,
      t: translator("en"),
      surface: "workspace",
      parent: fakeParent,
      onBackToGraph: () => {},
      onDirty: (threadId, value) => {
        dirty.push([threadId, value])
      },
      onFlush: () => {
        flushCount += 1
      },
    })
    const renderWorkspace = (): void => {
      workspaceEditor.render({
        ...workspaceView,
        consentReviewOpen: projectedReviewOpen,
        mutationLocked: workspaceLocked,
      })
    }
    renderWorkspace()

    const configurationEditor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: createBridge().bridge,
      t: translator("en"),
      surface: "configuration",
      parent: fakeParent,
      onResolveConsent: () => {},
      onConsentReviewChange: (open) => {
        projectedReviewOpen = open
        phaseChanges.push(open)
        renderWorkspace()
      },
    })
    configurationEditor.render(workspaceView)

    const keptValue: SpindleLoomBlockEditorValue = {
      blocks: [],
      promptVariableValues: { draft: { value: "kept" } },
    }
    workspaceBridge.calls[0]!.options.onChange?.(keptValue)
    configurationEditor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.click()
    expect(projectedReviewOpen).toBe(true)
    expect(workspaceBridge.handles[0]!.updates.at(-1)?.readOnly).toBe(true)

    workspaceBridge.calls[0]!.options.onChange?.({
      blocks: [],
      promptVariableValues: { draft: { value: "hostile" } },
    })
    const flushPromise = workspaceEditor.flush().then(() => {
      flushSettled = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(dirty).toEqual([])
    expect(flushCount).toBe(0)
    expect(flushSettled).toBe(false)

    workspaceLocked = true
    renderWorkspace()
    configurationEditor.element.querySelector<HTMLButtonElement>("[data-apc-close-consent-review]")!.click()
    await flushPromise
    expect(projectedReviewOpen).toBe(false)
    expect(phaseChanges).toEqual([true, false])
    expect(dirty).toEqual([])
    expect(flushCount).toBe(1)
    expect(workspaceBridge.handles[0]!.updates.at(-1)?.readOnly).toBe(true)

    workspaceLocked = false
    renderWorkspace()
    expect(workspaceBridge.handles[0]!.updates.at(-1)?.readOnly).toBe(false)
    expect(workspaceBridge.calls).toHaveLength(1)
    configurationEditor.destroy()
    workspaceEditor.destroy()
  })

  test("keeps split consent review unavailable without a synchronous phase projector", async () => {
    const workspaceBridge = createBridge()
    let dirtyCount = 0
    let resolverCalls = 0
    const view = snapshot({
      threads: [thread(THREAD_A, { connectionSlotId: SLOT_A })],
      consents: [consent()],
    })
    const workspaceEditor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: workspaceBridge.bridge,
      t: translator("en"),
      surface: "workspace",
      parent: fakeParent,
      onDirty: () => {
        dirtyCount += 1
      },
    })
    workspaceEditor.render(view)
    const configurationEditor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: createBridge().bridge,
      t: translator("en"),
      surface: "configuration",
      parent: fakeParent,
      onResolveConsent: () => {
        resolverCalls += 1
      },
    })
    configurationEditor.render(view)

    const trigger =
      configurationEditor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!
    expect(trigger.disabled).toBe(true)
    expect(configurationEditor.element.querySelector("[data-apc-consent-review-disabled-reason]")?.textContent)
      .toBe("en:error.connection")
    trigger.click()
    expect(resolverCalls).toBe(0)
    expect(configurationEditor.element.querySelector("[data-apc-consent-review]")).toBe(null)
    expect(workspaceBridge.calls[0]!.options.readOnly).toBe(false)

    workspaceBridge.calls[0]!.options.onChange?.({
      blocks: [],
      promptVariableValues: { draft: { value: "still editable" } },
    })
    await settleUntil(() => dirtyCount === 1)
    configurationEditor.destroy()
    workspaceEditor.destroy()
  })

  test("fails closed when the shared consent phase projector throws or returns a thenable", async () => {
    const view = snapshot({
      threads: [thread(THREAD_A, { connectionSlotId: SLOT_A })],
      consents: [consent()],
    })
    let projectedReviewOpen = false
    let resolverCalls = 0
    const throwingTransitions: boolean[] = []
    const throwingEditor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: createBridge().bridge,
      t: translator("en"),
      surface: "configuration",
      parent: fakeParent,
      onRename: () => {},
      onResolveConsent: () => {
        resolverCalls += 1
      },
      onConsentReviewChange: (open) => {
        throwingTransitions.push(open)
        projectedReviewOpen = open
        if (open) throw new Error("hostile synchronous projector")
      },
    })
    throwingEditor.render(view)
    throwingEditor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.click()
    expect(throwingTransitions).toEqual([true, false])
    expect(projectedReviewOpen).toBe(false)
    expect(resolverCalls).toBe(0)
    expect(throwingEditor.element.querySelector("[data-apc-consent-review]")).toBe(null)
    expect(throwingEditor.element.querySelector<HTMLInputElement>("[data-apc-thread-name]")!.readOnly).toBe(false)
    expect(throwingEditor.element.querySelector("[data-apc-thread-live-region]")?.textContent)
      .toBe("en:error.connection")
    throwingEditor.destroy()

    let releaseProjection: (() => void) | undefined
    const deferredProjection = new Promise<void>((resolve) => {
      releaseProjection = resolve
    })
    const thenableTransitions: boolean[] = []
    // Deliberately violates the compile-time contract to exercise runtime fail-closed containment.
    const hostileThenableProjector = ((open: boolean) => {
      thenableTransitions.push(open)
      projectedReviewOpen = open
      return open ? deferredProjection : undefined
    }) as unknown as NonNullable<ThreadEditorOptions["onConsentReviewChange"]>
    const thenableEditor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: createBridge().bridge,
      t: translator("en"),
      surface: "configuration",
      parent: fakeParent,
      onRename: () => {},
      onResolveConsent: () => {
        resolverCalls += 1
      },
      onConsentReviewChange: hostileThenableProjector,
    })
    thenableEditor.render(view)
    thenableEditor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.click()
    expect(thenableTransitions).toEqual([true, false])
    expect(projectedReviewOpen).toBe(false)
    expect(resolverCalls).toBe(0)
    expect(thenableEditor.element.querySelector("[data-apc-consent-review]")).toBe(null)
    thenableEditor.destroy()

    const successorTransitions: boolean[] = []
    const successorEditor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: createBridge().bridge,
      t: translator("en"),
      surface: "configuration",
      parent: fakeParent,
      onResolveConsent: () => {},
      onConsentReviewChange: (open) => {
        successorTransitions.push(open)
        projectedReviewOpen = open
      },
    })
    successorEditor.render(view)
    successorEditor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.click()
    expect(successorTransitions).toEqual([true])
    expect(projectedReviewOpen).toBe(true)
    expect(successorEditor.element.querySelector("[data-apc-consent-review]")).not.toBe(null)

    releaseProjection?.()
    await Promise.resolve()
    expect(thenableTransitions).toEqual([true, false])
    expect(projectedReviewOpen).toBe(true)
    expect(successorEditor.element.querySelector("[data-apc-consent-review]")).not.toBe(null)
    expect(resolverCalls).toBe(0)
    successorEditor.destroy()
    expect(successorTransitions).toEqual([true, false])
  })

  test("renders the selected thread, navigates back, and reconciles the one real Loom mount", () => {
    const { bridge, calls, handles } = createBridge()
    let backCount = 0
    const workspaceChanges: Array<[string, "native-blocks" | "main-context"]> = []
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
      onBackToGraph: () => {
        backCount += 1
      },
      onWorkspaceSourceChange: (threadId, source) => {
        workspaceChanges.push([threadId, source])
      },
    })

    editor.render(snapshot())
    expect(calls).toHaveLength(1)
    expect(editor.element.querySelector("[data-apc-thread-list]")).toBe(null)
    expect(editor.element.querySelector("[data-apc-host-loom-editor]")).toBe(calls[0]!.target)
    expect(renderedText(editor.element.querySelector("h2")!)).toContain("Researcher")
    editor.element.querySelector<HTMLButtonElement>("[data-apc-back-to-graph]")!.click()
    expect(backCount).toBe(1)
    const workspaceOptions = editor.element.querySelectorAll<HTMLInputElement>("[data-apc-workspace-source-option]")
    workspaceOptions[1]!.checked = true
    workspaceOptions[1]!.dispatchEvent(new Event("change"))
    expect(workspaceChanges).toEqual([[THREAD_A, "main-context"]])

    editor.render(snapshot({ readOnly: true }))
    expect(calls).toHaveLength(1)
    expect(handles[0]!.updates.at(-1)?.readOnly).toBe(true)

    editor.render(snapshot({ selectedThreadId: THREAD_B }))
    expect(calls).toHaveLength(2)
    expect(handles[0]!.destroyed).toBe(true)
    expect(renderedText(editor.element.querySelector("h2")!)).toContain("Synthesizer")
    editor.destroy()
    expect(handles[1]!.destroyed).toBe(true)
  })

  test("ignores an obsolete Loom callback after the same thread remounts", async () => {
    const { bridge, calls } = createBridge()
    const dirty: Array<[string, SpindleLoomBlockEditorValue]> = []
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
      onDirty: (threadId, value) => {
        dirty.push([threadId, value])
      },
    })
    editor.render(snapshot())
    const obsoleteOnChange = calls[0]!.options.onChange
    editor.render(snapshot({
      threads: [thread(THREAD_A, { workspaceSource: "main-context" }), thread(THREAD_B)],
    }))
    editor.render(snapshot())
    expect(calls).toHaveLength(2)
    obsoleteOnChange?.({ blocks: [], promptVariableValues: {} })
    expect(dirty).toEqual([])
    calls[1]!.options.onChange?.({ blocks: [], promptVariableValues: {} })
    await settleUntil(() => dirty.length === 1)
    expect(dirty[0]?.[0]).toBe(THREAD_A)
    editor.destroy()
  })

  test("publishes a queued workspace edit through an equivalent rerender", async () => {
    const { bridge, calls } = createBridge()
    const dirty: Array<[string, SpindleLoomBlockEditorValue]> = []
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
      onDirty: (threadId, value) => {
        dirty.push([threadId, value])
      },
    })
    const view = snapshot()
    editor.render(view)
    calls[0]!.options.onChange?.({
      blocks: [],
      promptVariableValues: { draft: { value: "current" } },
    })
    editor.render(view)

    await settleUntil(() => dirty.length === 1)
    expect(dirty).toEqual([[
      THREAD_A,
      { blocks: [], promptVariableValues: { draft: { value: "current" } } },
    ]])
    editor.destroy()
  })

  test("preserves rapid workspace edits across ordinary revision renders", async () => {
    const { bridge, calls } = createBridge()
    const dirty: Array<[string, SpindleLoomBlockEditorValue]> = []
    let editor: ThreadEditorController
    editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
      onDirty: (threadId, value) => {
        dirty.push([threadId, value])
        if (dirty.length === 1) {
          editor.render(snapshot({ contextAuthorityGeneration: 2 }))
        }
      },
    })
    editor.render(snapshot())
    calls[0]!.options.onChange?.({
      blocks: [],
      promptVariableValues: { draft: { value: "first" } },
    })
    calls[0]!.options.onChange?.({
      blocks: [],
      promptVariableValues: { draft: { value: "second" } },
    })

    await settleUntil(() => dirty.length === 2)
    expect(dirty.map(([, value]) => value.promptVariableValues)).toEqual([
      { draft: { value: "first" } },
      { draft: { value: "second" } },
    ])
    editor.destroy()
  })

  test("drops a queued dirty write after the rendered thread context changes", async () => {
    const { bridge, calls } = createBridge()
    const dirty: Array<[string, SpindleLoomBlockEditorValue]> = []
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
      onDirty: (threadId, value) => {
        dirty.push([threadId, value])
      },
    })
    editor.render(snapshot())
    calls[0]!.options.onChange?.({
      blocks: [],
      promptVariableValues: { draft: { value: "stale" } },
    })
    editor.render(snapshot({ consentReviewOpen: true }))
    const flushPromise = editor.flush()
    await Promise.resolve()
    editor.render(snapshot({
      selectedThreadId: THREAD_B,
      contextAuthorityGeneration: 2,
      consentReviewOpen: false,
    }))
    await flushPromise
    expect(dirty).toEqual([])
    editor.destroy()
  })

  test("shows run-only configuration and updates requiredness, timeout, and earlier-output bindings", () => {
    const { bridge } = createBridge()
    const runChanges: Array<[string, ThreadEditorRunChange]> = []
    const bindingChanges: Array<[string, string, ThreadEditorRunBindingChange]> = []
    const added: string[] = []
    const removed: Array<[string, string]> = []
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("fr"),
      parent: fakeParent,
      onRunChange: (runId, change) => {
        runChanges.push([runId, change])
      },
      onRunBindingChange: (runId, bindingId, change) => {
        bindingChanges.push([runId, bindingId, change])
      },
      onAddRunBinding: (runId) => {
        added.push(runId)
      },
      onRemoveRunBinding: (runId, bindingId) => {
        removed.push([runId, bindingId])
      },
    })
    editor.render(snapshot({ selectedRun: selectedRun() }))

    expect(editor.element.querySelector("[data-apc-run-configuration]")).not.toBe(null)
    expect(editor.element.querySelector("[data-apc-thread-output]")?.textContent).toBe("fr:graph.defaultFinalResponseName")
    expect(editor.element.querySelector("[data-apc-run-output]")?.textContent).toBe("fr:graph.defaultFinalResponseName")
    expect(renderedText(editor.element.querySelector("[data-apc-earlier-output-bindings]")!)).not.toContain("untranslated-schema-name")

    const required = editor.element.querySelector<HTMLInputElement>("[data-apc-run-required]")!
    required.checked = false
    required.dispatchEvent(new Event("change"))
    const timeout = editor.element.querySelector<HTMLInputElement>("[data-apc-run-timeout]")!
    expect(timeout.value).toBe("60")
    expect(timeout.min).toBe("1")
    expect(timeout.max).toBe("240")
    timeout.value = "45"
    timeout.dispatchEvent(new Event("change"))
    expect(runChanges).toEqual([
      [RUN_SELECTED, { required: false }],
      [RUN_SELECTED, { timeoutMs: 45_000 }],
    ])

    const sources = editor.element.querySelectorAll<HTMLSelectElement>("[data-apc-binding-source]")
    const sourceOptions = sources[0]!.querySelectorAll("option")
    expect(sourceOptions[0]?.textContent).toContain("fr:graph.defaultStageName|index=1")
    expect(sourceOptions[0]?.textContent).toContain("Evidence")
    expect(sourceOptions[0]?.textContent).toContain("fr:graph.runTitle|thread=Researcher|index=1")
    expect(sourceOptions[1]?.textContent).toContain("fr:graph.defaultStageName|index=2")
    expect(sourceOptions[1]?.textContent).toContain("Review")
    expect(sourceOptions[1]?.textContent).toContain("fr:graph.runTitle|thread=Researcher|index=2")
    expect(sourceOptions[0]?.textContent).not.toBe(sourceOptions[1]?.textContent)
    const missing = editor.element.querySelectorAll<HTMLSelectElement>("[data-apc-binding-missing]")
    const firstMissingOptions = Array.from(missing[0]!.querySelectorAll<HTMLOptionElement>("option"))
    const failGraph = firstMissingOptions.find((option) => option.value === "fail-graph")!
    const skipRun = firstMissingOptions.find((option) => option.value === "skip-run")!
    expect(sourceOptions[1]!.disabled).toBe(true)
    expect(failGraph.disabled).toBe(false)
    expect(skipRun.disabled).toBe(true)
    missing[0]!.value = "omit-binding"
    missing[0]!.dispatchEvent(new Event("change"))
    expect(sourceOptions[1]!.disabled).toBe(false)
    sources[0]!.value = "earlier-output-2"
    sources[0]!.dispatchEvent(new Event("change"))
    expect(failGraph.disabled).toBe(true)
    const roles = editor.element.querySelectorAll<HTMLSelectElement>("[data-apc-binding-role]")
    roles[0]!.value = "system"
    roles[0]!.dispatchEvent(new Event("change"))
    missing[0]!.value = "skip-run"
    missing[0]!.dispatchEvent(new Event("change"))
    missing[0]!.value = "fail-graph"
    missing[0]!.dispatchEvent(new Event("change"))
    expect(missing[0]!.value).toBe("omit-binding")
    expect(bindingChanges).toEqual([
      [RUN_SELECTED, BINDING_A, { onMissing: "omit-binding" }],
      [RUN_SELECTED, BINDING_A, { sourceRunId: RUN_EARLIER_B }],
      [RUN_SELECTED, BINDING_A, { role: "system" }],
    ])
    editor.element.querySelector<HTMLButtonElement>("[data-apc-add-run-binding]")!.click()
    editor.element.querySelector<HTMLButtonElement>("[data-apc-remove-run-binding]")!.click()
    expect(added).toEqual([RUN_SELECTED])
    expect(removed).toEqual([[RUN_SELECTED, BINDING_A]])
    editor.destroy()
  })

  test("reassigns a scheduled run through reusable thread targets and rolls back rejected callbacks", async () => {
    const { bridge } = createBridge()
    const changes: ThreadEditorRunChange[] = []
    let response: boolean | Promise<boolean> = true
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
      onRunChange: (_runId, change) => {
        changes.push(change)
        return response
      },
    })
    const run = {
      ...selectedRun(),
      threadTargets: [
        { id: THREAD_A, name: "Researcher", available: true },
        { id: THREAD_B, name: "Synthesizer", available: true },
      ],
    }
    editor.render(snapshot({ selectedRun: run }))
    const threadSelect = editor.element.querySelector<HTMLSelectElement>("[data-apc-run-thread]")!
    expect(threadSelect.getAttribute("aria-label")).toContain("en:graph.selectThread")
    expect([...threadSelect.querySelectorAll<HTMLOptionElement>("option")].map((option) => option.value)).toEqual([
      "run-thread-1",
      "run-thread-2",
    ])
    expect(threadSelect.value).toBe("run-thread-1")

    threadSelect.value = "run-thread-2"
    threadSelect.dispatchEvent(new Event("change"))
    expect(changes).toEqual([{ threadId: THREAD_B }])
    expect(threadSelect.value).toBe("run-thread-2")

    response = false
    threadSelect.value = "run-thread-2"
    threadSelect.dispatchEvent(new Event("change"))
    expect(threadSelect.value).toBe("run-thread-1")
    expect(changes).toEqual([{ threadId: THREAD_B }, { threadId: THREAD_B }])

    response = Promise.reject(new Error("private rejected thread reassignment"))
    threadSelect.value = "run-thread-2"
    threadSelect.dispatchEvent(new Event("change"))
    expect(threadSelect.disabled).toBe(true)
    await settleUntil(() => threadSelect.disabled === false)
    expect(threadSelect.value).toBe("run-thread-1")
    expect(changes).toHaveLength(3)
    expect(editor.element.querySelector("[data-apc-thread-live-region]")?.textContent)
      .toBe("en:a11y.graphReorderBlocked")
    editor.destroy()
  })

  test("disables duplicate-thread Parallel reassignment candidates", () => {
    const { bridge } = createBridge()
    const changes: ThreadEditorRunChange[] = []
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
      onRunChange: (_runId, change) => {
        changes.push(change)
      },
    })
    editor.render(snapshot({
      selectedRun: {
        ...selectedRun(),
        threadTargets: [
          { id: THREAD_A, name: "Researcher", available: true },
          { id: THREAD_B, name: "Synthesizer", available: false },
        ],
      },
    }))
    const threadSelect = editor.element.querySelector<HTMLSelectElement>("[data-apc-run-thread]")!
    expect(threadSelect.disabled).toBe(true)
    expect(threadSelect.querySelectorAll<HTMLOptionElement>("option")[1]?.disabled).toBe(true)
    threadSelect.value = "run-thread-2"
    threadSelect.dispatchEvent(new Event("change"))
    expect(changes).toEqual([])
    expect(threadSelect.value).toBe("run-thread-1")
    editor.destroy()
  })

  test("moves selected runs through opaque bounded Sequential and Parallel position targets", () => {
    const { bridge } = createBridge()
    const changes: Array<[string, ThreadEditorRunChange]> = []
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
      onRunChange: (runId, change) => {
        changes.push([runId, change])
      },
    })
    const parallelRun = selectedRun()
    editor.render(snapshot({ selectedRun: parallelRun }))

    let position = editor.element.querySelector<HTMLSelectElement>("[data-apc-run-position]")!
    let options = Array.from(position.querySelectorAll<HTMLOptionElement>("option"))
    expect(position.disabled).toBe(false)
    expect(position.value).toBe("run-position-2")
    expect(options.map((option) => option.value)).toEqual([
      "run-position-1",
      "run-position-2",
      "run-position-3",
    ])
    expect(options[0]!.textContent).toContain("en:graph.stageHeading|index=3|name=Synthesis stage")
    expect(options[0]!.textContent).toContain("en:graph.runTitle|thread=Researcher|index=2")
    expect(options[2]!.textContent).toContain("en:graph.stageHeading|index=4|name=Final stage")
    const parallelSurface = renderedSurface(position)
    expect(parallelSurface).not.toContain(RUN_SELECTED)
    expect(parallelSurface).not.toContain(RUN_EARLIER_A)
    expect(parallelSurface).not.toContain(BINDING_A)
    const impact = editor.element.querySelector("[data-apc-run-position-impact]")!
    expect(renderedText(impact)).toContain("en:graph.runPositionBindingImpact")
    expect(renderedText(impact)).not.toContain("en:a11y.graphReorderBlocked")

    position.value = "run-position-3"
    position.dispatchEvent(new Event("change"))
    expect(changes).toEqual([
      [RUN_SELECTED, { position: { stageOrdinal: 4, runOrdinal: 1 } }],
    ])
    expect(editor.element.querySelector("[data-apc-thread-live-region]")?.textContent)
      .toContain("en:a11y.runReordered")
    position.value = RUN_SELECTED
    position.dispatchEvent(new Event("change"))
    expect(position.value).toBe("run-position-2")
    expect(changes).toHaveLength(1)

    const sequentialRun: NonNullable<ThreadEditorSnapshot["selectedRun"]> = {
      ...parallelRun,
      stageName: "Review",
      stageOrdinal: 2,
      ordinal: 1,
      positionRestricted: false,
      positionTargets: [
        { stageOrdinal: 1, runOrdinal: 1, stageName: "Evidence" },
        { stageOrdinal: 2, runOrdinal: 1, stageName: "Review" },
        { stageOrdinal: 3, runOrdinal: 1, stageName: "Synthesis" },
      ],
      earlierOutputs: [parallelRun.earlierOutputs[0]!],
      bindings: [parallelRun.bindings[0]!],
    }
    editor.render(snapshot({ selectedRun: sequentialRun }))
    expect(editor.element.querySelector("[data-apc-run-position-impact]")).toBe(null)
    position = editor.element.querySelector<HTMLSelectElement>("[data-apc-run-position]")!
    options = Array.from(position.querySelectorAll<HTMLOptionElement>("option"))
    expect(position.value).toBe("run-position-2")
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining("en:graph.stageHeading|index=1|name=Evidence"),
      expect.stringContaining("en:graph.stageHeading|index=2|name=Review"),
      expect.stringContaining("en:graph.stageHeading|index=3|name=Synthesis"),
    ])
    position.value = "run-position-3"
    position.dispatchEvent(new Event("change"))
    expect(changes.at(-1)).toEqual([
      RUN_SELECTED,
      { position: { stageOrdinal: 3, runOrdinal: 1 } },
    ])

    editor.render(snapshot({ selectedRun: sequentialRun, consentReviewOpen: true }))
    position = editor.element.querySelector<HTMLSelectElement>("[data-apc-run-position]")!
    expect(position.disabled).toBe(true)
    position.value = "run-position-1"
    position.dispatchEvent(new Event("change"))
    expect(changes).toHaveLength(2)

    editor.render(snapshot({ selectedRun: sequentialRun, mutationLocked: true }))
    position = editor.element.querySelector<HTMLSelectElement>("[data-apc-run-position]")!
    expect(position.disabled).toBe(true)
    position.value = "run-position-1"
    position.dispatchEvent(new Event("change"))
    expect(changes).toHaveLength(2)
    editor.destroy()
  })

  test("ignores an asynchronous run-position completion after rerender", async () => {
    const { bridge } = createBridge()
    let resolveMove: ((accepted: boolean) => void) | undefined
    const pendingMove = new Promise<boolean>((resolve) => {
      resolveMove = resolve
    })
    let changes = 0
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
      onRunChange: () => {
        changes += 1
        return pendingMove
      },
    })
    editor.render(snapshot({ selectedRun: selectedRun() }))
    const detachedPosition = editor.element.querySelector<HTMLSelectElement>("[data-apc-run-position]")!
    detachedPosition.value = "run-position-3"
    detachedPosition.dispatchEvent(new Event("change"))
    expect(changes).toBe(1)

    editor.render(snapshot({ selectedRun: selectedRun(), contextAuthorityGeneration: 2 }))
    resolveMove?.(true)
    await Promise.resolve()
    await Promise.resolve()

    expect(editor.element.querySelector("[data-apc-thread-live-region]")?.textContent).toBe("")
    expect(editor.element.querySelector<HTMLSelectElement>("[data-apc-run-position]")?.value).toBe("run-position-2")
    expect(changes).toBe(1)
    editor.destroy()
  })

  test("announces a synchronous run move after its authoritative rerender", () => {
    const { bridge } = createBridge()
    const initialRun = selectedRun()
    const movedRun: NonNullable<ThreadEditorSnapshot["selectedRun"]> = {
      ...initialRun,
      stageName: "Final stage",
      stageOrdinal: 4,
      ordinal: 1,
    }
    let rerender: (() => void) | undefined
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      surface: "configuration",
      parent: fakeParent,
      onRunChange: () => {
        rerender?.()
      },
    })
    rerender = () => editor.render(snapshot({ selectedRun: movedRun }))
    editor.render(snapshot({ selectedRun: initialRun }))
    const position = editor.element.querySelector<HTMLSelectElement>("[data-apc-run-position]")!
    position.value = "run-position-3"
    position.dispatchEvent(new Event("change"))

    expect(editor.element.querySelector("[data-apc-thread-live-region]")?.textContent)
      .toContain("en:a11y.runReordered")
    expect(editor.element.querySelector<HTMLSelectElement>("[data-apc-run-position]")?.value)
      .toBe("run-position-3")
    editor.destroy()
  })

  test("restores rejected or refused run positions without a false success announcement", async () => {
    const { bridge } = createBridge()
    const changes: ThreadEditorRunChange[] = []
    let response: boolean | Promise<boolean> | undefined = false
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
      onRunChange: (_runId, change) => {
        changes.push(change)
        return response
      },
    })
    editor.render(snapshot({ selectedRun: selectedRun() }))
    const position = editor.element.querySelector<HTMLSelectElement>("[data-apc-run-position]")!

    position.value = "run-position-3"
    position.dispatchEvent(new Event("change"))
    expect(position.value).toBe("run-position-2")
    expect(editor.element.querySelector("[data-apc-thread-live-region]")?.textContent)
      .toBe("en:a11y.graphReorderBlocked")
    expect(editor.element.querySelector("[data-apc-thread-live-region]")?.textContent)
      .not.toContain("en:a11y.runReordered")

    response = Promise.reject(new Error("private rejected move"))
    position.value = "run-position-3"
    position.dispatchEvent(new Event("change"))
    expect(position.disabled).toBe(true)
    await settleUntil(() => position.disabled === false)
    expect(position.value).toBe("run-position-2")
    expect(editor.element.querySelector("[data-apc-thread-live-region]")?.textContent)
      .toBe("en:a11y.graphReorderBlocked")
    expect(editor.element.querySelector("[data-apc-thread-live-region]")?.textContent)
      .not.toContain("private rejected move")

    response = Promise.resolve(true)
    position.value = "run-position-3"
    position.dispatchEvent(new Event("change"))
    await settleUntil(() =>
      editor.element.querySelector("[data-apc-thread-live-region]")?.textContent
        ?.includes("en:a11y.runReordered") === true
    )
    expect(position.disabled).toBe(false)
    expect(changes).toEqual([
      { position: { stageOrdinal: 4, runOrdinal: 1 } },
      { position: { stageOrdinal: 4, runOrdinal: 1 } },
      { position: { stageOrdinal: 4, runOrdinal: 1 } },
    ])
    editor.destroy()
  })

  test("exposes preexisting invalid missing policies and lets the user persist a valid repair", () => {
    const { bridge } = createBridge()
    const changes: ThreadEditorRunBindingChange[] = []
    const run = selectedRun()
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
      onRunBindingChange: (_runId, _bindingId, change) => {
        changes.push(change)
      },
    })
    editor.render(snapshot({
      selectedRun: {
        ...run,
        required: false,
        requiredLocked: true,
        bindings: [
          { ...run.bindings[0]!, onMissing: "skip-run" },
          { ...run.bindings[1]!, onMissing: "fail-graph" },
        ],
      },
    }))
    const missing = editor.element.querySelectorAll<HTMLSelectElement>("[data-apc-binding-missing]")
    expect(missing[0]!.value).toBe("skip-run")
    expect(missing[1]!.value).toBe("fail-graph")
    const firstOptions = Array.from(missing[0]!.querySelectorAll<HTMLOptionElement>("option"))
    const secondOptions = Array.from(missing[1]!.querySelectorAll<HTMLOptionElement>("option"))
    expect(firstOptions.find((option) => option.value === "skip-run")!.disabled).toBe(true)
    expect(secondOptions.find((option) => option.value === "skip-run")!.disabled).toBe(true)
    expect(secondOptions.find((option) => option.value === "fail-graph")!.disabled).toBe(true)
    expect(changes).toEqual([])
    expect(editor.element.querySelector("[data-apc-thread-live-region]")?.textContent).toBe("en:validation.invalid")
    missing[0]!.value = "omit-binding"
    missing[0]!.dispatchEvent(new Event("change"))
    missing[1]!.value = "omit-binding"
    missing[1]!.dispatchEvent(new Event("change"))
    expect(changes).toEqual([
      { onMissing: "omit-binding" },
      { onMissing: "omit-binding" },
    ])
    editor.destroy()
  })

  test("keeps the final-route run required and explains the lock in the active locale", () => {
    const { bridge } = createBridge()
    const runChanges: Array<[string, ThreadEditorRunChange]> = []
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("fr"),
      parent: fakeParent,
      onRunChange: (runId, change) => {
        runChanges.push([runId, change])
      },
    })
    editor.render(snapshot({
      selectedRun: { ...selectedRun(), required: false, requiredLocked: true },
    }))
    const required = editor.element.querySelector<HTMLInputElement>("[data-apc-run-required]")!
    expect(required.checked).toBe(true)
    expect(required.disabled).toBe(true)
    expect(editor.element.querySelector("[data-apc-run-required-reason]")?.textContent)
      .toBe("fr:validation.finalRunRequired")
    expect(editor.element.querySelector<HTMLInputElement>("[data-apc-run-timeout]")!.disabled).toBe(false)
    required.checked = false
    required.dispatchEvent(new Event("change"))
    expect(runChanges).toEqual([])
    editor.destroy()
  })

  test("rejects same-stage output sources before rendering the run form", () => {
    const { bridge } = createBridge()
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
    })
    const run = selectedRun()
    expect(() => editor.render(snapshot({
      selectedRun: {
        ...run,
        earlierOutputs: run.earlierOutputs.map((output, index) =>
          index === 0 ? { ...output, stageOrdinal: run.stageOrdinal } : output
        ),
      },
    }))).toThrow("earlier stage")
    editor.destroy()
  })

  test("requires an explicit review and acknowledgement before backend-authoritative approval", async () => {
    const { bridge } = createBridge()
    const approved: ThreadEditorConsentSelector[] = []
    const consent = {
      threadId: THREAD_A,
      workspaceSource: "native-blocks" as const,
      connectionSourceKey: `slot:${SLOT_A}` as const,
      status: "required" as const,
      destination: { label: "Research profile", provider: "OpenRouter", model: "Claude Sonnet" },
      disclosure: {
        version: 1,
        summary: "The selected workspace and resolved earlier outputs are sent to this destination.",
        categories: ["thread", "workspace", "source", "destination", "provider", "model", "prior-stage-outputs"] as const,
      },
    }
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
      onResolveConsent: () => {},
      onApproveConsent: (selector) => {
        approved.push(selector)
      },
    })
    const view = snapshot({
      threads: [thread(THREAD_A, { connectionSlotId: SLOT_A })],
      consents: [consent],
    })
    editor.render(view)

    expect(editor.element.querySelector("[data-apc-consent-review]")).toBe(null)
    const reviewTrigger = editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!
    reviewTrigger.click()
    editor.render({ ...view, consentAuthorityGeneration: 2 })
    await settleUntil(() =>
      editor.element.querySelector<HTMLInputElement>("[data-apc-consent-acknowledge]")?.disabled === false
    )
    const heading = editor.element.querySelector("[data-apc-consent-review-heading]")!
    expect(fakeDocument.activeElement).toBe(heading)
    const review = editor.element.querySelector("[data-apc-consent-review]")!
    const reviewText = renderedText(review)
    expect(reviewText).toContain("Researcher")
    expect(reviewText).toContain("Research slot")
    expect(reviewText).toContain("Research profile")
    expect(reviewText).toContain("OpenRouter")
    expect(reviewText).toContain("Claude Sonnet")
    expect(reviewText).toContain(
      "en:consent.disclosureSummary|destination=Research profile|workspace=en:workspace.nativeBlocks",
    )
    expect(reviewText).not.toContain(consent.disclosure.summary)

    const approve = editor.element.querySelector<HTMLButtonElement>("[data-apc-approve-consent]")!
    expect(approve.disabled).toBe(true)
    const acknowledgement = editor.element.querySelector<HTMLInputElement>("[data-apc-consent-acknowledge]")!
    acknowledgement.checked = true
    acknowledgement.dispatchEvent(new Event("change"))
    expect(approve.disabled).toBe(false)
    approve.click()
    await Promise.resolve()
    expect(approved).toEqual([{
      presetId: PRESET_ID,
      threadId: THREAD_A,
      workspaceSource: "native-blocks",
      connectionSourceKey: `slot:${SLOT_A}`,
    }])
    expect(approve.disabled).toBe(true)
    editor.render({
      ...view,
      consentAuthorityGeneration: 3,
      consents: [{ ...consent, status: "approved" }],
    })
    await settleUntil(() =>
      editor.element.querySelector("[data-apc-consent-status]")?.textContent === "en:consent.statusApproved" &&
      editor.element.querySelector("[data-apc-revoke-consent]") !== null
    )
    expect(editor.element.querySelector<HTMLButtonElement>("[data-apc-revoke-consent]")!.disabled).toBe(true)
    editor.destroy()
  })

  test("keeps an exact hydrated approval inert when no fresh resolver is available", () => {
    const { bridge } = createBridge()
    let approvals = 0
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
      onApproveConsent: () => {
        approvals += 1
      },
    })
    editor.render(snapshot({
      threads: [thread(THREAD_A, { connectionSlotId: SLOT_A })],
      consents: [{
        threadId: THREAD_A,
        workspaceSource: "native-blocks",
        connectionSourceKey: `slot:${SLOT_A}`,
        status: "approved",
        destination: { label: "Hydrated profile", provider: "Provider", model: "Model" },
        disclosure: {
          version: 1,
          summary: "Hydrated disclosure.",
          categories: ["thread", "workspace", "source", "destination", "provider", "model"],
        },
      }],
    }))
    const trigger = editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!
    expect(trigger.disabled).toBe(true)
    trigger.click()
    expect(editor.element.querySelector("[data-apc-consent-review]")).toBe(null)
    expect(editor.element.querySelector("[data-apc-approve-consent]")).toBe(null)
    expect(editor.element.querySelector("[data-apc-revoke-consent]")).toBe(null)
    expect(renderedText(editor.element)).not.toContain("Retry")
    expect(approvals).toBe(0)
    editor.destroy()
  })

  test("blocks review until an asynchronous workspace mutation settles and a newer snapshot renders", async () => {
    const { bridge } = createBridge()
    const changes: Array<[string, "native-blocks" | "main-context"]> = []
    let releaseMutation: (() => void) | undefined
    const mutationGate = new Promise<void>((resolve) => {
      releaseMutation = resolve
    })
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
      onWorkspaceSourceChange: async (threadId, source) => {
        changes.push([threadId, source])
        await mutationGate
      },
      onResolveConsent: () => {},
    })
    editor.render(snapshot())
    const source = editor.element.querySelectorAll<HTMLInputElement>("[data-apc-workspace-source-option]")[1]!
    source.checked = true
    source.dispatchEvent(new Event("change"))
    expect(changes).toEqual([[THREAD_A, "main-context"]])
    expect(fakeElement(editor.element).dataset.apcConsentContextMutation).toBe("pending")
    expect(editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.disabled).toBe(true)
    expect(editor.element.querySelector<HTMLInputElement>("[data-apc-connection-slot]")!.disabled).toBe(true)
    releaseMutation?.()
    await settleUntil(() =>
      fakeElement(editor.element).dataset.apcConsentContextMutation === "awaiting-authoritative"
    )
    editor.render(snapshot())
    expect(fakeElement(editor.element).dataset.apcConsentContextMutation).toBe("awaiting-authoritative")
    expect(editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.disabled).toBe(true)
    editor.render(snapshot({
      contextAuthorityGeneration: 2,
      selectedThreadId: THREAD_B,
      threads: [thread(THREAD_A, { workspaceSource: "main-context" }), thread(THREAD_B)],
    }))
    expect(fakeElement(editor.element).dataset.apcConsentContextMutation).toBe("idle")
    expect(editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.disabled).toBe(false)
    editor.destroy()
  })

  test("gates connection-slot changes until the selected thread matches the authoritative snapshot", async () => {
    const { bridge } = createBridge()
    const changes: Array<[string, string | undefined]> = []
    let releaseMutation: (() => void) | undefined
    const mutationGate = new Promise<void>((resolve) => {
      releaseMutation = resolve
    })
    const slots = [
      slot(),
      slot({ id: SLOT_B, label: "Backup slot", boundConnectionId: CONNECTION_BACKUP }),
    ]
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
      onConnectionSlotChange: async (threadId, slotId) => {
        changes.push([threadId, slotId])
        await mutationGate
      },
      onResolveConsent: () => {},
    })
    const oldView = snapshot({
      threads: [thread(THREAD_A, { connectionSlotId: SLOT_A })],
      slots,
    })
    editor.render(oldView)
    const source = editor.element.querySelector<HTMLSelectElement>("[data-apc-connection-slot]")!
    source.value = "connection-source-2"
    source.dispatchEvent(new Event("change"))
    expect(changes).toEqual([[THREAD_A, SLOT_B]])
    expect(fakeElement(editor.element).dataset.apcConsentContextMutation).toBe("pending")
    expect(editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.disabled).toBe(true)
    releaseMutation?.()
    await settleUntil(() =>
      fakeElement(editor.element).dataset.apcConsentContextMutation === "awaiting-authoritative"
    )
    editor.render(oldView)
    expect(fakeElement(editor.element).dataset.apcConsentContextMutation).toBe("awaiting-authoritative")
    editor.render(snapshot({
      contextAuthorityGeneration: 2,
      threads: [thread(THREAD_A, { connectionSlotId: SLOT_B })],
      slots,
    }))
    expect(fakeElement(editor.element).dataset.apcConsentContextMutation).toBe("idle")
    expect(editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.disabled).toBe(false)
    editor.destroy()
  })

  test("gates rebind through authoritative rerender and keeps the current Bind listener live", async () => {
    const { bridge } = createBridge()
    const bindings: Array<[string, string]> = []
    let releaseMutation: (() => void) | undefined
    const mutationGate = new Promise<void>((resolve) => {
      releaseMutation = resolve
    })
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
      onBind: async (slotId, connectionId) => {
        bindings.push([slotId, connectionId])
        await mutationGate
      },
      onResolveConsent: () => {},
    })
    editor.render(snapshot({ threads: [thread(THREAD_A, { connectionSlotId: SLOT_A })] }))
    const connection = editor.element.querySelector<HTMLSelectElement>("[data-apc-host-connection]")!
    connection.value = "connection-choice-2"
    connection.dispatchEvent(new Event("change"))
    editor.element.querySelector<HTMLButtonElement>("[data-apc-bind]")!.click()
    expect(bindings).toEqual([[SLOT_A, CONNECTION_BACKUP]])
    expect(fakeElement(editor.element).dataset.apcConsentContextMutation).toBe("pending")
    releaseMutation?.()
    await settleUntil(() =>
      fakeElement(editor.element).dataset.apcConsentContextMutation === "awaiting-authoritative"
    )
    editor.render(snapshot({
      contextAuthorityGeneration: 2,
      threads: [thread(THREAD_A, { connectionSlotId: SLOT_A })],
      slots: [slot({ boundConnectionId: CONNECTION_BACKUP })],
    }))
    const currentConnection = editor.element.querySelector<HTMLSelectElement>("[data-apc-host-connection]")!
    expect(currentConnection.value).toBe("connection-choice-2")
    const currentBind = editor.element.querySelector<HTMLButtonElement>("[data-apc-bind]")!
    expect(currentBind.disabled).toBe(false)
    currentBind.click()
    expect(bindings).toEqual([
      [SLOT_A, CONNECTION_BACKUP],
      [SLOT_A, CONNECTION_BACKUP],
    ])
    editor.destroy()
  })

  test("gates unbind until the exact slot is authoritatively unbound", async () => {
    const { bridge } = createBridge()
    const unbound: string[] = []
    let releaseMutation: (() => void) | undefined
    const mutationGate = new Promise<void>((resolve) => {
      releaseMutation = resolve
    })
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      onApproveConsent: () => {},
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
      onResolveConsent: () => {},
      onUnbind: async (slotId) => {
        unbound.push(slotId)
        await mutationGate
      },
    })
    const boundView = snapshot({
      threads: [thread(THREAD_A, { connectionSlotId: SLOT_A })],
      consents: [{
        threadId: THREAD_A,
        workspaceSource: "native-blocks",
        connectionSourceKey: `slot:${SLOT_A}`,
        status: "required",
        destination: { label: "Profile", provider: "Provider", model: "Model" },
        disclosure: {
          version: 1,
          summary: "Disclosure.",
          categories: ["thread", "workspace", "source", "destination", "provider", "model"],
        },
      }],
    })
    editor.render(boundView)
    editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.click()
    const resolvedBoundView = { ...boundView, consentAuthorityGeneration: 2 }
    editor.render(resolvedBoundView)
    await settleUntil(() =>
      editor.element.querySelector<HTMLInputElement>("[data-apc-consent-acknowledge]")?.disabled === false
    )
    const acknowledgement = editor.element.querySelector<HTMLInputElement>("[data-apc-consent-acknowledge]")!
    acknowledgement.checked = true
    acknowledgement.dispatchEvent(new Event("change"))
    expect(editor.element.querySelector<HTMLButtonElement>("[data-apc-approve-consent]")!.disabled).toBe(false)
    editor.element.querySelector<HTMLButtonElement>("[data-apc-close-consent-review]")!.click()
    editor.element.querySelector<HTMLButtonElement>("[data-apc-unbind]")!.click()
    await settleUntil(() => unbound.length === 1)
    expect(unbound).toEqual([SLOT_A])
    expect(editor.element.querySelector("[data-apc-consent-review]")).toBe(null)
    expect(editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.disabled).toBe(true)
    releaseMutation?.()
    await settleUntil(() =>
      fakeElement(editor.element).dataset.apcConsentContextMutation === "awaiting-authoritative"
    )
    editor.render(resolvedBoundView)
    expect(fakeElement(editor.element).dataset.apcConsentContextMutation).toBe("awaiting-authoritative")
    editor.render(snapshot({
      contextAuthorityGeneration: 2,
      consentAuthorityGeneration: 2,
      threads: [thread(THREAD_A, { connectionSlotId: SLOT_A })],
      slots: [slot({ bound: false, bindingStatus: "missing", boundConnectionId: undefined })],
    }))
    expect(fakeElement(editor.element).dataset.apcConsentContextMutation).toBe("idle")
    expect(editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.disabled).toBe(false)
    editor.destroy()
  })

  test("gates an initial unbound slot bind until the exact authoritative binding renders", async () => {
    const { bridge } = createBridge()
    const bindings: Array<[string, string]> = []
    let releaseMutation: (() => void) | undefined
    const mutationGate = new Promise<void>((resolve) => {
      releaseMutation = resolve
    })
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
      onBind: async (slotId, connectionId) => {
        bindings.push([slotId, connectionId])
        await mutationGate
      },
      onResolveConsent: () => {},
    })
    editor.render(snapshot({
      threads: [thread(THREAD_A, { connectionSlotId: SLOT_A })],
      slots: [slot({ bound: false, bindingStatus: "missing", boundConnectionId: undefined })],
    }))
    const connection = editor.element.querySelector<HTMLSelectElement>("[data-apc-host-connection]")!
    connection.value = "connection-choice-1"
    connection.dispatchEvent(new Event("change"))
    editor.element.querySelector<HTMLButtonElement>("[data-apc-bind]")!.click()
    expect(bindings).toEqual([[SLOT_A, CONNECTION_PRIMARY]])
    expect(fakeElement(editor.element).dataset.apcConsentContextMutation).toBe("pending")
    releaseMutation?.()
    await settleUntil(() =>
      fakeElement(editor.element).dataset.apcConsentContextMutation === "awaiting-authoritative"
    )
    editor.render(snapshot({
      contextAuthorityGeneration: 2,
      threads: [thread(THREAD_A, { connectionSlotId: SLOT_A })],
      slots: [slot()],
    }))
    expect(fakeElement(editor.element).dataset.apcConsentContextMutation).toBe("idle")
    expect(editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.disabled).toBe(false)
    editor.destroy()
  })

  test("keeps unavailable context mutation callbacks inert and visibly disabled", () => {
    const { bridge, calls } = createBridge()
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
      onResolveConsent: () => {},
    })
    editor.render(snapshot({
      selectedRun: selectedRun(),
      threads: [thread(THREAD_A, { connectionSlotId: SLOT_A })],
    }))
    expect(
      Array.from(editor.element.querySelectorAll<HTMLInputElement>("[data-apc-workspace-source-option]"))
        .every((control) => control.disabled)
    ).toBe(true)
    expect(editor.element.querySelector<HTMLSelectElement>("[data-apc-connection-slot]")!.disabled).toBe(true)
    expect(editor.element.querySelector<HTMLButtonElement>("[data-apc-bind]")!.disabled).toBe(true)
    expect(editor.element.querySelector<HTMLButtonElement>("[data-apc-unbind]")!.disabled).toBe(true)
    expect(editor.element.querySelector<HTMLButtonElement>("[data-apc-refresh-connections]")!.disabled).toBe(true)
    expect(editor.element.querySelector<HTMLButtonElement>("[data-apc-back-to-graph]")!.disabled).toBe(true)
    expect(editor.element.querySelector<HTMLInputElement>("[data-apc-thread-name]")!.readOnly).toBe(true)
    expect(editor.element.querySelector<HTMLTextAreaElement>("[data-apc-thread-description]")!.readOnly).toBe(true)
    expect(calls[0]!.options.readOnly).toBe(true)
    for (const selector of [
      "[data-apc-run-required]",
      "[data-apc-run-timeout]",
      "[data-apc-run-position]",
      "[data-apc-binding-source]",
      "[data-apc-binding-role]",
      "[data-apc-binding-missing]",
      "[data-apc-add-run-binding]",
      "[data-apc-remove-run-binding]",
    ]) {
      expect(editor.element.querySelector<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(selector)!.disabled)
        .toBe(true)
    }
    expect(fakeElement(editor.element).dataset.apcConsentContextMutation).toBe("idle")
    editor.destroy()
  })

  test("ignores snapshots that regress either authority generation", () => {
    const { bridge } = createBridge()
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
    })
    editor.render(snapshot({
      contextAuthorityGeneration: 3,
      consentAuthorityGeneration: 4,
      threads: [thread(THREAD_A, { workspaceSource: "main-context" })],
      consents: [{
        threadId: THREAD_A,
        workspaceSource: "main-context",
        connectionSourceKey: "main",
        status: "revoked",
        destination: { label: "Current destination", provider: "Provider", model: "Model" },
        disclosure: {
          version: 1,
          summary: "Current disclosure.",
          categories: ["thread", "workspace", "source", "destination", "provider", "model"],
        },
      }],
    }))
    editor.render(snapshot({
      contextAuthorityGeneration: 2,
      consentAuthorityGeneration: 4,
    }))
    expect(editor.element.querySelector("[data-apc-main-context]")).not.toBe(null)
    editor.render(snapshot({
      contextAuthorityGeneration: 3,
      consentAuthorityGeneration: 3,
    }))
    expect(editor.element.querySelector("[data-apc-consent-status]")?.textContent)
      .toBe("en:consent.statusRevoked")
    editor.destroy()
  })

  test("invalidates consent review while connection refresh awaits authoritative state", async () => {
    const { bridge } = createBridge()
    let approvals = 0
    let releaseRefresh: (() => void) | undefined
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve
    })
    const consent = {
      threadId: THREAD_A,
      workspaceSource: "native-blocks" as const,
      connectionSourceKey: `slot:${SLOT_A}` as const,
      status: "required" as const,
      destination: { label: "Profile", provider: "Provider", model: "Model" },
      disclosure: {
        version: 1,
        summary: "Disclosure.",
        categories: ["thread", "workspace", "source", "destination", "provider", "model"] as const,
      },
    }
    const view = snapshot({
      threads: [thread(THREAD_A, { connectionSlotId: SLOT_A })],
      consents: [consent],
    })
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
      onResolveConsent: () => {},
      onApproveConsent: () => {
        approvals += 1
      },
      onRefreshConnections: () => refreshGate,
    })
    editor.render(view)
    editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.click()
    const resolvedView = { ...view, consentAuthorityGeneration: 2 }
    editor.render(resolvedView)
    await settleUntil(() =>
      editor.element.querySelector<HTMLInputElement>("[data-apc-consent-acknowledge]")?.disabled === false
    )
    const refreshWhileReviewing =
      editor.element.querySelector<HTMLButtonElement>("[data-apc-refresh-connections]")!
    expect(refreshWhileReviewing.disabled).toBe(true)
    const acknowledgement = editor.element.querySelector<HTMLInputElement>("[data-apc-consent-acknowledge]")!
    acknowledgement.checked = true
    acknowledgement.dispatchEvent(new Event("change"))
    const staleApprove = editor.element.querySelector<HTMLButtonElement>("[data-apc-approve-consent]")!
    editor.element.querySelector<HTMLButtonElement>("[data-apc-close-consent-review]")!.click()
    await settleUntil(() =>
      editor.element.querySelector<HTMLButtonElement>("[data-apc-refresh-connections]")?.disabled === false
    )
    editor.element.querySelector<HTMLButtonElement>("[data-apc-refresh-connections]")!.click()
    expect(editor.element.querySelector("[data-apc-consent-review]")).toBe(null)
    staleApprove.click()
    expect(approvals).toBe(0)
    expect(fakeElement(editor.element).dataset.apcConsentContextMutation).toBe("pending")
    releaseRefresh?.()
    await settleUntil(() =>
      fakeElement(editor.element).dataset.apcConsentContextMutation === "awaiting-authoritative"
    )
    editor.render(resolvedView)
    expect(fakeElement(editor.element).dataset.apcConsentContextMutation).toBe("awaiting-authoritative")
    editor.render({ ...resolvedView, contextAuthorityGeneration: 2 })
    expect(fakeElement(editor.element).dataset.apcConsentContextMutation).toBe("idle")
    expect(editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.disabled).toBe(false)
    editor.destroy()
  })

  test("requires a fresh resolver when the same selector destination changes", async () => {
    const { bridge } = createBridge()
    const resolved: ThreadEditorConsentSelector[] = []
    const approved: ThreadEditorConsentSelector[] = []
    const releases: Array<() => void> = []
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
      onResolveConsent: (selector) => {
        resolved.push(selector)
        return new Promise<void>((resolve) => {
          releases.push(resolve)
        })
      },
      onWorkspaceSourceChange: () => {},
      onApproveConsent: (selector) => {
        approved.push(selector)
      },
    })
    const oldConsent = {
      threadId: THREAD_A,
      workspaceSource: "native-blocks" as const,
      connectionSourceKey: `slot:${SLOT_A}` as const,
      status: "approved" as const,
      destination: { label: "Hydration-era profile", provider: "Old provider", model: "Old model" },
      disclosure: {
        version: 1,
        summary: "Hydration-era disclosure.",
        categories: ["thread", "workspace", "source", "destination", "provider", "model"] as const,
      },
    }
    const oldView = snapshot({
      threads: [thread(THREAD_A, { connectionSlotId: SLOT_A })],
      consents: [oldConsent],
    })
    editor.render(oldView)
    editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.click()
    await settleUntil(() => resolved.length === 1)
    const close = editor.element.querySelector<HTMLButtonElement>("[data-apc-close-consent-review]")!
    close.focus()
    const tabEvent = new Event("keydown", { cancelable: true }) as KeyboardEvent
    Object.defineProperties(tabEvent, {
      key: { value: "Tab" },
      shiftKey: { value: false },
    })
    close.dispatchEvent(tabEvent)
    expect(document.activeElement).toBe(close)
    close.click()
    expect(fakeElement(document.activeElement!).dataset.apcThreadWorkspaceHeading).toBe("true")
    expect(editor.element.querySelector("[data-apc-consent-review]")).toBe(null)
    expect(editor.element.querySelector<HTMLInputElement>("[data-apc-workspace-source-option]")!.disabled).toBe(true)

    const freshView = snapshot({
      consentAuthorityGeneration: 2,
      threads: [thread(THREAD_A, { connectionSlotId: SLOT_A })],
      consents: [{
        ...oldConsent,
        status: "required",
        destination: { label: "Fresh profile", provider: "Fresh provider", model: "Fresh model" },
        disclosure: { ...oldConsent.disclosure, version: 2, summary: "Fresh authoritative disclosure." },
      }],
    })
    editor.render(freshView)
    expect(editor.element.querySelector("[data-apc-consent-review]")).toBe(null)
    expect(editor.element.querySelectorAll<HTMLInputElement>("[data-apc-workspace-source-option]")[1]!.disabled).toBe(false)
    expect(fakeElement(document.activeElement!).dataset.apcThreadWorkspaceHeading).toBe("true")
    releases[0]?.()
    await Promise.resolve()
    expect(editor.element.querySelector("[data-apc-consent-review]")).toBe(null)

    editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.click()
    await settleUntil(() => resolved.length === 2)
    expect(editor.element.querySelector("[data-apc-consent-disclosure]")?.textContent).toBe(
      "en:consent.disclosureSummary|destination=Fresh profile|workspace=en:workspace.nativeBlocks",
    )
    releases[1]?.()
    await Promise.resolve()
    expect(editor.element.querySelector<HTMLInputElement>("[data-apc-consent-acknowledge]")!.disabled).toBe(true)
    const authoritativeView = { ...freshView, consentAuthorityGeneration: 3 }
    editor.render(authoritativeView)
    await settleUntil(() =>
      editor.element.querySelector<HTMLInputElement>("[data-apc-consent-acknowledge]")?.disabled === false
    )
    editor.render({ ...authoritativeView, mutationLocked: true })
    expect(editor.element.querySelector<HTMLInputElement>("[data-apc-consent-acknowledge]")!.disabled).toBe(true)
    editor.render(authoritativeView)
    const acknowledgement = editor.element.querySelector<HTMLInputElement>("[data-apc-consent-acknowledge]")!
    acknowledgement.checked = true
    acknowledgement.dispatchEvent(new Event("change"))
    editor.element.querySelector<HTMLButtonElement>("[data-apc-approve-consent]")!.click()
    await settleUntil(() => approved.length === 1)
    expect(approved).toEqual([resolved[1]])
    editor.destroy()
  })

  test("keeps consent review open when resolution supplies its destination and disclosure", async () => {
    const { bridge } = createBridge()
    const resolved: ThreadEditorConsentSelector[] = []
    const approved: ThreadEditorConsentSelector[] = []
    let releaseResolution: (() => void) | undefined
    const resolutionGate = new Promise<void>((resolve) => {
      releaseResolution = resolve
    })
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
      onResolveConsent: async (selector) => {
        resolved.push(selector)
        await resolutionGate
      },
      onApproveConsent: (selector) => {
        approved.push(selector)
      },
    })
    const unresolvedView = snapshot({
      threads: [thread(THREAD_A, { connectionSlotId: SLOT_A })],
      consents: [],
    })
    editor.render(unresolvedView)
    editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.click()
    await settleUntil(() => resolved.length === 1)
    expect(editor.element.querySelector("[data-apc-consent-review]")).not.toBe(null)
    expect(editor.element.querySelector("[data-apc-consent-disclosure]")).toBe(null)
    expect(editor.element.querySelector<HTMLInputElement>("[data-apc-consent-acknowledge]")!.disabled).toBe(true)

    const resolvedView = snapshot({
      consentAuthorityGeneration: 2,
      threads: [thread(THREAD_A, { connectionSlotId: SLOT_A })],
      consents: [consent("required")],
    })
    editor.render(resolvedView)
    expect(editor.element.querySelector("[data-apc-consent-review]")).not.toBe(null)
    expect(editor.element.querySelector("[data-apc-consent-disclosure]")?.textContent).toContain("Safe destination")
    expect(editor.element.querySelector<HTMLInputElement>("[data-apc-consent-acknowledge]")!.disabled).toBe(true)
    releaseResolution?.()
    await settleUntil(() =>
      editor.element.querySelector<HTMLInputElement>("[data-apc-consent-acknowledge]")?.disabled === false
    )
    expect(editor.element.querySelector("[data-apc-consent-review]")).not.toBe(null)
    const acknowledgement = editor.element.querySelector<HTMLInputElement>("[data-apc-consent-acknowledge]")!
    acknowledgement.checked = true
    acknowledgement.dispatchEvent(new Event("change"))
    editor.element.querySelector<HTMLButtonElement>("[data-apc-approve-consent]")!.click()
    await settleUntil(() => approved.length === 1)
    expect(approved).toEqual([resolved[0]])
    editor.destroy()
  })

  test("ignores an older same-selector consent resolution after a newer attempt starts", async () => {
    const { bridge } = createBridge()
    const releases: Array<() => void> = []
    const requests: Promise<void>[] = []
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
      onResolveConsent: () => {
        let release: (() => void) | undefined
        const request = new Promise<void>((resolve) => {
          release = resolve
        })
        requests.push(request)
        releases.push(() => release?.())
        return request
      },
      onApproveConsent: () => {},
    })
    const nativeView = snapshot({
      threads: [thread(THREAD_A, { connectionSlotId: SLOT_A })],
      consents: [{
        threadId: THREAD_A,
        workspaceSource: "native-blocks",
        connectionSourceKey: `slot:${SLOT_A}`,
        status: "required",
        destination: { label: "Profile", provider: "Provider", model: "Model" },
        disclosure: {
          version: 1,
          summary: "Disclosure.",
          categories: ["thread", "workspace", "source", "destination", "provider", "model"],
        },
      }],
    })
    editor.render(nativeView)
    editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.click()
    await settleUntil(() => releases.length === 1)
    editor.render(snapshot({
      threads: [thread(THREAD_A, { workspaceSource: "main-context" }), thread(THREAD_B)],
    }))
    editor.render(nativeView)
    editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.click()
    await settleUntil(() => releases.length === 2)
    releases[0]!()
    await requests[0]
    await Promise.resolve()
    expect(fakeElement(editor.element.querySelector("[data-apc-consent-resolution]")!).dataset.apcConsentResolution)
      .toBe("pending")
    expect(editor.element.querySelector<HTMLInputElement>("[data-apc-consent-acknowledge]")!.disabled).toBe(true)
    releases[1]!()
    editor.render({ ...nativeView, consentAuthorityGeneration: 2 })
    await settleUntil(() =>
      editor.element.querySelector<HTMLInputElement>("[data-apc-consent-acknowledge]")?.disabled === false
    )
    editor.destroy()
  })

  test("restores the closed review trigger when consent resolution settles", async () => {
    const { bridge } = createBridge()
    let releaseResolution: (() => void) | undefined
    let resolutionAttempts = 0
    const resolution = new Promise<void>((resolve) => {
      releaseResolution = resolve
    })
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
      onBackToGraph: () => {},
      onResolveConsent: () => {
        resolutionAttempts += 1
        return resolution
      },
    })
    const view = snapshot({
      threads: [thread(THREAD_A, { connectionSlotId: SLOT_A })],
    })
    editor.render(view)
    editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.click()
    await settleUntil(() =>
      editor.element.querySelector("[data-apc-consent-review]")?.getAttribute("aria-busy") === "true"
    )
    editor.element.querySelector<HTMLButtonElement>("[data-apc-close-consent-review]")!.click()
    const pendingTrigger = editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!
    expect(pendingTrigger.disabled).toBe(true)
    expect(fakeDocument.activeElement?.dataset.apcBackToGraph).toBe("true")
    expect(fakeDocument.activeElement?.isConnected).toBe(true)
    pendingTrigger.click()
    expect(resolutionAttempts).toBe(1)
    releaseResolution?.()
    await Promise.resolve()
    expect(editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.disabled).toBe(true)
    editor.render({ ...view, consentAuthorityGeneration: 2 })
    await settleUntil(() =>
      editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")?.disabled === false
    )
    expect(resolutionAttempts).toBe(1)
    expect(editor.element.querySelector("[data-apc-consent-review]")).toBe(null)
    expect(fakeDocument.activeElement).toBe(
      editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")
    )
    editor.destroy()
  })

  test("keeps failed consent resolution required without exposing retry or backend detail", async () => {
    let resolutionAttempts = 0
    const { bridge } = createBridge()
    let approvalAttempts = 0
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("fr"),
      parent: fakeParent,
      onResolveConsent: () => {
        resolutionAttempts += 1
        throw new Error("private resolution detail")
      },
      onApproveConsent: () => {
        approvalAttempts += 1
      },
    })
    editor.render(snapshot({
      threads: [thread(THREAD_A, { connectionSlotId: SLOT_A })],
      consents: [{
        threadId: THREAD_A,
        workspaceSource: "native-blocks",
        connectionSourceKey: `slot:${SLOT_A}`,
        status: "approved",
        destination: { label: "Hydration-era profile", provider: "Old provider", model: "Old model" },
        disclosure: {
          version: 1,
          summary: "Hydration-era disclosure.",
          categories: ["thread", "workspace", "source", "destination", "provider", "model"],
        },
      }],
    }))
    editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.click()
    await settleUntil(() =>
      editor.element.querySelector("[data-apc-thread-live-region]")?.textContent === "fr:error.connection"
    )
    expect(editor.element.querySelector("[data-apc-consent-status]")?.textContent).toBe("fr:consent.statusRequired")
    expect(fakeElement(editor.element.querySelector("[data-apc-consent-resolution]")!).dataset.apcConsentResolution)
      .toBe("missing")
    const acknowledgement = editor.element.querySelector<HTMLInputElement>("[data-apc-consent-acknowledge]")!
    const approve = editor.element.querySelector<HTMLButtonElement>("[data-apc-approve-consent]")!
    expect(acknowledgement.disabled).toBe(true)
    expect(approve.disabled).toBe(true)
    expect(editor.element.querySelector("[data-apc-revoke-consent]")).toBe(null)
    const trigger = editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!
    expect(trigger.disabled).toBe(true)
    trigger.click()
    editor.element.querySelector<HTMLButtonElement>("[data-apc-close-consent-review]")!.click()
    const closedTrigger = editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!
    expect(closedTrigger.disabled).toBe(true)
    closedTrigger.click()
    expect(resolutionAttempts).toBe(1)
    acknowledgement.checked = true
    acknowledgement.dispatchEvent(new Event("change"))
    approve.click()
    expect(approvalAttempts).toBe(0)
    expect(renderedText(editor.element)).not.toContain("private resolution detail")
    expect(renderedText(editor.element)).not.toContain("Retry")
    editor.destroy()
  })

  test("never inherits approval from another thread using the same slot", () => {
    const { bridge } = createBridge()
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
      onApproveConsent: () => {},
      onResolveConsent: () => {},
    })
    editor.render(snapshot({
      threads: [
        thread(THREAD_A, { connectionSlotId: SLOT_A }),
        thread(THREAD_B, { connectionSlotId: SLOT_A }),
      ],
      consents: [{
        threadId: THREAD_B,
        workspaceSource: "native-blocks",
        connectionSourceKey: `slot:${SLOT_A}`,
        status: "approved",
        destination: { label: "Other destination", provider: "Other provider", model: "Other model" },
        disclosure: {
          version: 1,
          summary: "Approval for the other thread only.",
          categories: ["thread", "workspace", "source", "destination", "provider", "model"],
        },
      }],
    }))
    expect(editor.element.querySelector("[data-apc-consent-status]")?.textContent).toBe("en:consent.statusRequired")
    editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.click()
    expect(fakeElement(editor.element.querySelector("[data-apc-consent-resolution]")!).dataset.apcConsentResolution).toBe("pending")
    expect(editor.element.querySelector("[data-apc-consent-disclosure]")).toBe(null)
    expect(editor.element.querySelector<HTMLButtonElement>("[data-apc-approve-consent]")!.disabled).toBe(true)
    editor.destroy()
  })

  test("requires both a safe destination and disclosure before showing approved slot consent", () => {
    for (const missing of ["destination", "disclosure"] as const) {
      const { bridge } = createBridge()
      const editor = createThreadEditor({
        host,
        presetId: PRESET_ID,
        loom: bridge,
        t: translator("en"),
        parent: fakeParent,
        onApproveConsent: () => {},
        onResolveConsent: () => {},
      })
      editor.render(snapshot({
        threads: [thread(THREAD_A, { connectionSlotId: SLOT_A })],
        consents: [{
          threadId: THREAD_A,
          workspaceSource: "native-blocks",
          connectionSourceKey: `slot:${SLOT_A}`,
          status: "approved",
          ...(missing === "destination"
            ? {}
            : { destination: { label: "Research profile", provider: "OpenRouter", model: "Claude Sonnet" } }),
          ...(missing === "disclosure"
            ? {}
            : {
                disclosure: {
                  version: 1,
                  summary: "Safe disclosure.",
                  categories: ["thread", "workspace", "source", "destination", "provider", "model"] as const,
                },
              }),
        }],
      }))
      expect(editor.element.querySelector("[data-apc-consent-status]")?.textContent).toBe("en:consent.statusRequired")
      editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.click()
      expect(fakeElement(editor.element.querySelector("[data-apc-consent-resolution]")!).dataset.apcConsentResolution).toBe("pending")
      expect(editor.element.querySelector("[data-apc-revoke-consent]")).toBe(null)
      expect(editor.element.querySelector<HTMLInputElement>("[data-apc-consent-acknowledge]")!.disabled).toBe(true)
      expect(editor.element.querySelector<HTMLButtonElement>("[data-apc-approve-consent]")!.disabled).toBe(true)
      editor.destroy()
    }
  })

  test("recovers focus and approval controls after a rejected backend approval", async () => {
    const { bridge } = createBridge()
    let approvalAttempts = 0
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
      onResolveConsent: () => {},
      onApproveConsent: async () => {
        approvalAttempts += 1
        throw new Error("private backend detail")
      },
    })
    const view = snapshot({
      threads: [thread(THREAD_A, { connectionSlotId: SLOT_A })],
      consents: [{
        threadId: THREAD_A,
        workspaceSource: "native-blocks",
        connectionSourceKey: `slot:${SLOT_A}`,
        status: "required",
        destination: { label: "Research profile", provider: "OpenRouter", model: "Claude Sonnet" },
        disclosure: {
          version: 1,
          summary: "Safe current disclosure.",
          categories: ["thread", "workspace", "source", "destination", "provider", "model"],
        },
      }],
    })
    editor.render(view)
    editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.click()
    editor.render({ ...view, consentAuthorityGeneration: 2 })
    await settleUntil(() =>
      editor.element.querySelector<HTMLInputElement>("[data-apc-consent-acknowledge]")?.disabled === false
    )
    const acknowledgement = editor.element.querySelector<HTMLInputElement>("[data-apc-consent-acknowledge]")!
    acknowledgement.checked = true
    acknowledgement.dispatchEvent(new Event("change"))
    editor.element.querySelector<HTMLButtonElement>("[data-apc-approve-consent]")!.click()
    await settleUntil(() =>
      editor.element.querySelector<HTMLButtonElement>("[data-apc-approve-consent]")?.disabled === false
    )
    const approve = editor.element.querySelector<HTMLButtonElement>("[data-apc-approve-consent]")!
    expect(approvalAttempts).toBe(1)
    expect(approve.disabled).toBe(false)
    expect(fakeDocument.activeElement).toBe(approve)
    expect(editor.element.querySelector("[data-apc-thread-live-region]")?.textContent).toBe("en:error.connection")
    expect(renderedText(editor.element)).not.toContain("private backend detail")
    expect(renderedText(editor.element)).not.toContain("Retry")
    editor.destroy()
  })

  test("uses the latest locked snapshot when approval rejects", async () => {
    const { bridge } = createBridge()
    let rejectApproval: (() => void) | undefined
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
      onResolveConsent: () => {},
      onApproveConsent: () => new Promise<void>((_resolve, reject) => {
        rejectApproval = () => reject(new Error("rejected"))
      }),
    })
    const view = snapshot({
      threads: [thread(THREAD_A, { connectionSlotId: SLOT_A })],
      consents: [{
        threadId: THREAD_A,
        workspaceSource: "native-blocks",
        connectionSourceKey: `slot:${SLOT_A}`,
        status: "required",
        destination: { label: "Research profile", provider: "OpenRouter", model: "Claude Sonnet" },
        disclosure: {
          version: 1,
          summary: "Safe current disclosure.",
          categories: ["thread", "workspace", "source", "destination", "provider", "model"],
        },
      }],
    })
    editor.render(view)
    editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.click()
    const resolvedView = { ...view, consentAuthorityGeneration: 2 }
    editor.render(resolvedView)
    await settleUntil(() =>
      editor.element.querySelector<HTMLInputElement>("[data-apc-consent-acknowledge]")?.disabled === false
    )
    const acknowledgement = editor.element.querySelector<HTMLInputElement>("[data-apc-consent-acknowledge]")!
    acknowledgement.checked = true
    acknowledgement.dispatchEvent(new Event("change"))
    editor.element.querySelector<HTMLButtonElement>("[data-apc-approve-consent]")!.click()
    await settleUntil(() => rejectApproval !== undefined)
    editor.render({ ...resolvedView, mutationLocked: true })
    rejectApproval?.()
    await settleUntil(() =>
      editor.element.querySelector("[data-apc-thread-live-region]")?.textContent === "en:error.connection"
    )
    expect(fakeElement(editor.element).dataset.apcMutationLocked).toBe("true")
    expect(editor.element.querySelector<HTMLButtonElement>("[data-apc-approve-consent]")!.disabled).toBe(true)
    expect(fakeDocument.activeElement?.dataset.apcExecutionLock).toBe("true")
    expect(editor.element.querySelector("[data-apc-thread-live-region]")?.textContent).toBe("en:error.connection")
    editor.destroy()
  })

  test("ignores an older approval rejection after a newer same-context attempt starts", async () => {
    const { bridge } = createBridge()
    const rejectors: Array<() => void> = []
    const requests: Promise<void>[] = []
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
      onResolveConsent: () => {},
      onApproveConsent: () => {
        let rejectRequest: ((reason?: unknown) => void) | undefined
        const request = new Promise<void>((_resolve, reject) => {
          rejectRequest = reject
        })
        requests.push(request)
        rejectors.push(() => rejectRequest?.(new Error("rejected")))
        return request
      },
    })
    const consentA = {
      threadId: THREAD_A,
      workspaceSource: "native-blocks" as const,
      connectionSourceKey: `slot:${SLOT_A}` as const,
      status: "required" as const,
      destination: { label: "Profile A", provider: "Provider", model: "Model" },
      disclosure: {
        version: 1,
        summary: "Disclosure A.",
        categories: ["thread", "workspace", "source", "destination", "provider", "model"] as const,
      },
    }
    const viewA = snapshot({
      threads: [thread(THREAD_A, { connectionSlotId: SLOT_A })],
      consents: [consentA],
    })
    editor.render(viewA)
    editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.click()
    const resolvedViewA = { ...viewA, consentAuthorityGeneration: 2 }
    editor.render(resolvedViewA)
    await settleUntil(() =>
      editor.element.querySelector<HTMLInputElement>("[data-apc-consent-acknowledge]")?.disabled === false
    )
    const approve = (): void => {
      const acknowledgement = editor.element.querySelector<HTMLInputElement>("[data-apc-consent-acknowledge]")!
      acknowledgement.checked = true
      acknowledgement.dispatchEvent(new Event("change"))
      editor.element.querySelector<HTMLButtonElement>("[data-apc-approve-consent]")!.click()
    }
    approve()
    await settleUntil(() => rejectors.length === 1)
    editor.render(snapshot({
      consentAuthorityGeneration: 2,
      threads: [thread(THREAD_A, { connectionSlotId: SLOT_A })],
      consents: [{
        ...consentA,
        destination: { label: "Profile B", provider: "Provider", model: "Model" },
        disclosure: { ...consentA.disclosure, summary: "Disclosure B." },
      }],
    }))
    editor.render(resolvedViewA)
    editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.click()
    editor.render({ ...viewA, consentAuthorityGeneration: 3 })
    await settleUntil(() =>
      editor.element.querySelector<HTMLInputElement>("[data-apc-consent-acknowledge]")?.disabled === false
    )
    approve()
    await settleUntil(() => rejectors.length === 2)
    rejectors[0]!()
    await requests[0]!.catch(() => {})
    await Promise.resolve()
    expect(editor.element.querySelector<HTMLButtonElement>("[data-apc-approve-consent]")!.disabled).toBe(true)
    expect(editor.element.querySelector("[data-apc-thread-live-region]")?.textContent)
      .toBe("en:action.approveConsent")
    rejectors[1]!()
    await settleUntil(() =>
      editor.element.querySelector("[data-apc-thread-live-region]")?.textContent === "en:error.connection"
    )
    expect(editor.element.querySelector<HTMLButtonElement>("[data-apc-approve-consent]")!.disabled).toBe(false)
    editor.destroy()
  })

  test("ignores an older approval success after a newer same-context attempt starts", async () => {
    const { bridge } = createBridge()
    const releases: Array<() => void> = []
    const requests: Promise<void>[] = []
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
      onResolveConsent: () => {},
      onApproveConsent: () => {
        let release: (() => void) | undefined
        const request = new Promise<void>((resolve) => {
          release = resolve
        })
        requests.push(request)
        releases.push(() => release?.())
        return request
      },
    })
    const consentA = {
      threadId: THREAD_A,
      workspaceSource: "native-blocks" as const,
      connectionSourceKey: `slot:${SLOT_A}` as const,
      status: "required" as const,
      destination: { label: "Profile A", provider: "Provider", model: "Model" },
      disclosure: {
        version: 1,
        summary: "Disclosure A.",
        categories: ["thread", "workspace", "source", "destination", "provider", "model"] as const,
      },
    }
    const viewA = snapshot({
      threads: [thread(THREAD_A, { connectionSlotId: SLOT_A })],
      consents: [consentA],
    })
    const startApproval = async (projection: ThreadEditorSnapshot): Promise<void> => {
      editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.click()
      editor.render(projection)
      await settleUntil(() =>
        editor.element.querySelector<HTMLInputElement>("[data-apc-consent-acknowledge]")?.disabled === false
      )
      const acknowledgement = editor.element.querySelector<HTMLInputElement>("[data-apc-consent-acknowledge]")!
      acknowledgement.checked = true
      acknowledgement.dispatchEvent(new Event("change"))
      editor.element.querySelector<HTMLButtonElement>("[data-apc-approve-consent]")!.click()
    }
    editor.render(viewA)
    await startApproval({ ...viewA, consentAuthorityGeneration: 2 })
    await settleUntil(() => releases.length === 1)
    editor.render(snapshot({
      consentAuthorityGeneration: 2,
      threads: [thread(THREAD_A, { connectionSlotId: SLOT_A })],
      consents: [{
        ...consentA,
        destination: { label: "Profile B", provider: "Provider", model: "Model" },
        disclosure: { ...consentA.disclosure, summary: "Disclosure B." },
      }],
    }))
    editor.render({ ...viewA, consentAuthorityGeneration: 2 })
    await startApproval({ ...viewA, consentAuthorityGeneration: 3 })
    await settleUntil(() => releases.length === 2)
    releases[0]!()
    await requests[0]
    await Promise.resolve()
    expect(editor.element.querySelector<HTMLButtonElement>("[data-apc-approve-consent]")!.disabled).toBe(true)
    expect(editor.element.querySelector("[data-apc-revoke-consent]")).toBe(null)
    releases[1]!()
    await requests[1]
    await Promise.resolve()
    expect(editor.element.querySelector<HTMLButtonElement>("[data-apc-approve-consent]")!.disabled).toBe(true)
    editor.render({
      ...viewA,
      consentAuthorityGeneration: 4,
      consents: [{ ...consentA, status: "approved" }],
    })
    await settleUntil(() => editor.element.querySelector("[data-apc-revoke-consent]") !== null)
    editor.destroy()
  })


  test("keeps revoke pending until an authoritative revoked projection arrives", async () => {
    const { bridge } = createBridge()
    let releaseRevoke: (() => void) | undefined
    const revokeRequest = new Promise<void>((resolve) => {
      releaseRevoke = resolve
    })
    const consent = {
      threadId: THREAD_A,
      workspaceSource: "native-blocks" as const,
      connectionSourceKey: `slot:${SLOT_A}` as const,
      status: "approved" as const,
      destination: { label: "Profile", provider: "Provider", model: "Model" },
      disclosure: {
        version: 1,
        summary: "Disclosure.",
        categories: ["thread", "workspace", "source", "destination", "provider", "model"] as const,
      },
    }
    const view = snapshot({
      threads: [thread(THREAD_A, { connectionSlotId: SLOT_A })],
      consents: [consent],
    })
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
      onResolveConsent: () => {},
      onRevokeConsent: () => revokeRequest,
    })
    editor.render(view)
    editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.click()
    const resolvedView = { ...view, consentAuthorityGeneration: 2 }
    editor.render(resolvedView)
    await settleUntil(() => editor.element.querySelector("[data-apc-revoke-consent]") !== null)
    editor.element.querySelector<HTMLButtonElement>("[data-apc-revoke-consent]")!.click()
    releaseRevoke?.()
    await revokeRequest
    await Promise.resolve()
    expect(editor.element.querySelector<HTMLButtonElement>("[data-apc-revoke-consent]")!.disabled).toBe(true)
    expect(editor.element.querySelector("[data-apc-consent-review]")).not.toBe(null)
    editor.render({
      ...view,
      consentAuthorityGeneration: 3,
      consents: [{ ...consent, status: "revoked" }],
    })
    await settleUntil(() => editor.element.querySelector("[data-apc-consent-review]") === null)
    expect(editor.element.querySelector("[data-apc-consent-status]")?.textContent).toBe("en:consent.statusRevoked")
    editor.destroy()
  })

  test("rearms revoke after a token-current backend rejection without exposing detail", async () => {
    const { bridge } = createBridge()
    const consent = {
      threadId: THREAD_A,
      workspaceSource: "native-blocks" as const,
      connectionSourceKey: `slot:${SLOT_A}` as const,
      status: "approved" as const,
      destination: { label: "Profile", provider: "Provider", model: "Model" },
      disclosure: {
        version: 1,
        summary: "Disclosure.",
        categories: ["thread", "workspace", "source", "destination", "provider", "model"] as const,
      },
    }
    const view = snapshot({
      threads: [thread(THREAD_A, { connectionSlotId: SLOT_A })],
      consents: [consent],
    })
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
      onResolveConsent: () => {},
      onRevokeConsent: () => Promise.reject(new Error("private revoke detail")),
    })
    editor.render(view)
    editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.click()
    editor.render({ ...view, consentAuthorityGeneration: 2 })
    await settleUntil(() => editor.element.querySelector("[data-apc-revoke-consent]") !== null)
    editor.element.querySelector<HTMLButtonElement>("[data-apc-revoke-consent]")!.click()
    await settleUntil(() =>
      editor.element.querySelector("[data-apc-thread-live-region]")?.textContent === "en:error.connection"
    )
    expect(editor.element.querySelector<HTMLButtonElement>("[data-apc-revoke-consent]")!.disabled).toBe(false)
    expect(renderedText(editor.element)).not.toContain("private revoke detail")
    editor.destroy()
  })

  test("ignores an older revoke success after a newer same-context attempt starts", async () => {
    const { bridge } = createBridge()
    const releases: Array<() => void> = []
    const requests: Promise<void>[] = []
    const consentA = {
      threadId: THREAD_A,
      workspaceSource: "native-blocks" as const,
      connectionSourceKey: `slot:${SLOT_A}` as const,
      status: "approved" as const,
      destination: { label: "Profile A", provider: "Provider", model: "Model" },
      disclosure: {
        version: 1,
        summary: "Disclosure A.",
        categories: ["thread", "workspace", "source", "destination", "provider", "model"] as const,
      },
    }
    const viewA = snapshot({
      threads: [thread(THREAD_A, { connectionSlotId: SLOT_A })],
      consents: [consentA],
    })
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
      onResolveConsent: () => {},
      onRevokeConsent: () => {
        let release: (() => void) | undefined
        const request = new Promise<void>((resolve) => {
          release = resolve
        })
        requests.push(request)
        releases.push(() => release?.())
        return request
      },
    })
    const startRevoke = async (projection: ThreadEditorSnapshot): Promise<void> => {
      editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.click()
      editor.render(projection)
      await settleUntil(() => editor.element.querySelector("[data-apc-revoke-consent]") !== null)
      editor.element.querySelector<HTMLButtonElement>("[data-apc-revoke-consent]")!.click()
    }
    editor.render(viewA)
    await startRevoke({ ...viewA, consentAuthorityGeneration: 2 })
    await settleUntil(() => releases.length === 1)
    editor.render(snapshot({
      consentAuthorityGeneration: 2,
      threads: [thread(THREAD_A, { connectionSlotId: SLOT_A })],
      consents: [{
        ...consentA,
        destination: { label: "Profile B", provider: "Provider", model: "Model" },
        disclosure: { ...consentA.disclosure, summary: "Disclosure B." },
      }],
    }))
    editor.render({ ...viewA, consentAuthorityGeneration: 2 })
    await startRevoke({ ...viewA, consentAuthorityGeneration: 3 })
    await settleUntil(() => releases.length === 2)
    releases[0]!()
    await requests[0]
    await Promise.resolve()
    expect(editor.element.querySelector<HTMLButtonElement>("[data-apc-revoke-consent]")!.disabled).toBe(true)
    releases[1]!()
    await requests[1]
    editor.render({
      ...viewA,
      consentAuthorityGeneration: 4,
      consents: [{ ...consentA, status: "revoked" }],
    })
    await settleUntil(() => editor.element.querySelector("[data-apc-consent-review]") === null)
    editor.destroy()
  })
  test("blocks stale and missing consent, restores review focus, and keeps Main fallback controls", async () => {
    const { bridge, calls } = createBridge()
    const approved: ThreadEditorConsentSelector[] = []
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
      onBackToGraph: () => {},
      onApproveConsent: (selector) => {
        approved.push(selector)
      },
      onResolveConsent: () => {},
    })
    const staleView = snapshot({
      threads: [thread(THREAD_A, { connectionSlotId: SLOT_A })],
      slots: [slot({ bindingStatus: "stale" })],
      consents: [{
        threadId: THREAD_A,
        workspaceSource: "native-blocks",
        connectionSourceKey: `slot:${SLOT_A}`,
        status: "approved",
        destination: { label: "Stale profile", provider: "Provider", model: "Model" },
        disclosure: {
          version: 1,
          summary: "Stale disclosure",
          categories: ["thread", "workspace", "source", "destination", "provider", "model"],
        },
      }],
    })
    editor.render(staleView)
    editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.click()
    expect(editor.element.querySelector("[data-apc-consent-status]")?.textContent).toBe("en:consent.statusRequired")
    expect(editor.element.querySelector("[data-apc-revoke-consent]")).toBe(null)
    expect(fakeElement(editor.element.querySelector("[data-apc-consent-resolution]")!).dataset.apcConsentResolution).toBe("stale")
    expect(editor.element.querySelector<HTMLInputElement>("[data-apc-consent-acknowledge]")!.disabled).toBe(true)
    expect(editor.element.querySelector<HTMLButtonElement>("[data-apc-approve-consent]")!.disabled).toBe(true)

    const close = editor.element.querySelector<HTMLButtonElement>("[data-apc-close-consent-review]")!
    close.click()
    expect(fakeDocument.activeElement?.dataset.apcBackToGraph).toBe("true")
    await Promise.resolve()
    editor.render({ ...staleView, consentAuthorityGeneration: 2 })
    await settleUntil(() =>
      editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")?.disabled === false
    )
    expect(fakeDocument.activeElement).toBe(
      editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")
    )

    editor.render(snapshot({
      consentAuthorityGeneration: 2,
      threads: [thread(THREAD_A, { workspaceSource: "main-context" })],
      slots: [],
      consents: [],
    }))
    expect(calls).toHaveLength(1)
    expect(editor.element.querySelector("[data-apc-host-loom-editor]")).toBe(null)
    expect(editor.element.querySelector("[data-apc-main-context]")?.textContent).toBe("en:threadEditor.mainContextMessage")
    expect(editor.element.querySelector<HTMLSelectElement>("[data-apc-connection-slot]")?.value)
      .toBe("connection-source-main")
    editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.click()
    expect(fakeElement(editor.element.querySelector("[data-apc-consent-resolution]")!).dataset.apcConsentResolution).toBe("pending")
    expect(editor.element.querySelector<HTMLButtonElement>("[data-apc-approve-consent]")!.disabled).toBe(true)
    expect(approved).toHaveLength(0)
    editor.destroy()
  })

  test("keeps authoritative stale consent visible while a deferred resolver remains pending", async () => {
    const { bridge } = createBridge()
    let resolveAttempts = 0
    let releaseResolution: (() => void) | undefined
    const resolution = new Promise<void>((resolve) => {
      releaseResolution = resolve
    })
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
      onResolveConsent: () => {
        resolveAttempts += 1
        return resolution
      },
      onApproveConsent: () => {},
    })
    editor.render(snapshot({
      threads: [thread(THREAD_A, { connectionSlotId: SLOT_A })],
      slots: [slot({ bindingStatus: "stale" })],
      consents: [{
        threadId: THREAD_A,
        workspaceSource: "native-blocks",
        connectionSourceKey: `slot:${SLOT_A}`,
        status: "approved",
        destination: { label: "Former profile", provider: "Provider", model: "Model" },
        disclosure: {
          version: 1,
          summary: "Former disclosure.",
          categories: ["thread", "workspace", "source", "destination", "provider", "model"],
        },
      }],
    }))
    editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.click()
    await settleUntil(() => resolveAttempts === 1)
    expect(editor.element.querySelector("[data-apc-consent-review]")?.getAttribute("aria-busy")).toBe("true")
    const resolutionStatus = editor.element.querySelector("[data-apc-consent-resolution]")!
    expect(fakeElement(resolutionStatus).dataset.apcConsentResolution).toBe("stale")
    expect(resolutionStatus.textContent).toBe("en:privacy.revisionChanged")
    expect(editor.element.querySelector<HTMLInputElement>("[data-apc-consent-acknowledge]")!.disabled).toBe(true)
    expect(editor.element.querySelector<HTMLButtonElement>("[data-apc-approve-consent]")!.disabled).toBe(true)
    expect(editor.element.querySelector("[data-apc-revoke-consent]")).toBe(null)
    releaseResolution?.()
    await Promise.resolve()
    expect(fakeElement(editor.element.querySelector("[data-apc-consent-resolution]")!).dataset.apcConsentResolution)
      .toBe("stale")
    expect(editor.element.querySelector("[data-apc-consent-review]")?.getAttribute("aria-busy")).toBe("true")
    editor.destroy()
  })

  test("fails closed when the backend reports a missing slot binding after fresh resolution", async () => {
    const { bridge } = createBridge()
    let approvals = 0
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
      onResolveConsent: () => {},
      onApproveConsent: () => {
        approvals += 1
      },
    })
    const view = snapshot({
      threads: [thread(THREAD_A, { connectionSlotId: SLOT_A })],
      slots: [slot({ bindingStatus: "missing" })],
      consents: [{
        threadId: THREAD_A,
        workspaceSource: "native-blocks",
        connectionSourceKey: `slot:${SLOT_A}`,
        status: "approved",
        destination: { label: "Former profile", provider: "Provider", model: "Model" },
        disclosure: {
          version: 1,
          summary: "Former disclosure.",
          categories: ["thread", "workspace", "source", "destination", "provider", "model"],
        },
      }],
    })
    editor.render(view)
    editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.click()
    editor.render({ ...view, consentAuthorityGeneration: 2 })
    await settleUntil(() =>
      editor.element.querySelector("[data-apc-consent-review]")?.getAttribute("aria-busy") === "false"
    )
    expect(editor.element.querySelector("[data-apc-consent-status]")?.textContent)
      .toBe("en:consent.statusRequired")
    expect(fakeElement(editor.element.querySelector("[data-apc-consent-resolution]")!).dataset.apcConsentResolution)
      .toBe("missing")
    expect(editor.element.querySelector<HTMLInputElement>("[data-apc-consent-acknowledge]")!.disabled).toBe(true)
    const approve = editor.element.querySelector<HTMLButtonElement>("[data-apc-approve-consent]")!
    expect(approve.disabled).toBe(true)
    expect(editor.element.querySelector("[data-apc-revoke-consent]")).toBe(null)
    approve.click()
    expect(approvals).toBe(0)
    editor.destroy()
  })

  test("treats an omitted slot binding status as missing even when legacy bound is true", async () => {
    const { bridge } = createBridge()
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
      onResolveConsent: () => {},
      onApproveConsent: () => {},
    })
    const view = snapshot({
      threads: [thread(THREAD_A, { connectionSlotId: SLOT_A })],
      slots: [slot({ bindingStatus: undefined })],
      consents: [{
        threadId: THREAD_A,
        workspaceSource: "native-blocks",
        connectionSourceKey: `slot:${SLOT_A}`,
        status: "approved",
        destination: { label: "Profile", provider: "Provider", model: "Model" },
        disclosure: {
          version: 1,
          summary: "Disclosure.",
          categories: ["thread", "workspace", "source", "destination", "provider", "model"],
        },
      }],
    })
    editor.render(view)
    editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.click()
    editor.render({ ...view, consentAuthorityGeneration: 2 })
    await settleUntil(() =>
      editor.element.querySelector("[data-apc-consent-review]")?.getAttribute("aria-busy") === "false"
    )
    expect(fakeElement(editor.element.querySelector("[data-apc-consent-resolution]")!).dataset.apcConsentResolution)
      .toBe("missing")
    expect(editor.element.querySelector<HTMLInputElement>("[data-apc-consent-acknowledge]")!.disabled).toBe(true)
    expect(editor.element.querySelector<HTMLButtonElement>("[data-apc-approve-consent]")!.disabled).toBe(true)
    expect(editor.element.querySelector("[data-apc-revoke-consent]")).toBe(null)
    editor.destroy()
  })

  test("keeps hostile consent disclosure text inert and preserves review lifecycle", async () => {
    const { bridge } = createBridge()
    const resolved: ThreadEditorConsentSelector[] = []
    const approved: ThreadEditorConsentSelector[] = []
    const revoked: ThreadEditorConsentSelector[] = []
    const hostileDestination = {
      label: `<img src="destination" onerror="alert(1)">`,
      provider: `<script>alert("provider")</script>`,
      model: `<svg onload="alert(1)">model</svg>`,
    }
    const hostileSummary = `<img src="disclosure" onerror="alert(1)">`
    const consent = {
      threadId: THREAD_A,
      workspaceSource: "native-blocks" as const,
      connectionSourceKey: `slot:${SLOT_A}` as const,
      status: "required" as const,
      destination: hostileDestination,
      disclosure: {
        version: 1,
        summary: hostileSummary,
        categories: ["thread", "workspace", "source", "destination", "provider", "model"] as const,
      },
    }
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
      onRename: () => {},
      onResolveConsent: (selector) => {
        resolved.push(selector)
      },
      onApproveConsent: (selector) => {
        approved.push(selector)
      },
      onRevokeConsent: (selector) => {
        revoked.push(selector)
      },
    })
    const view = snapshot({
      threads: [thread(THREAD_A, { connectionSlotId: SLOT_A })],
      consents: [consent],
    })
    editor.render(view)
    const trigger = editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!
    trigger.click()

    const pendingReview = editor.element.querySelector("[data-apc-consent-review]")!
    expect(renderedText(pendingReview)).toContain("en:consent.required")
    expect(resolved).toHaveLength(0)
    await settleUntil(() => resolved.length === 1)
    editor.render({ ...view, consentAuthorityGeneration: 2 })
    await settleUntil(() =>
      editor.element.querySelector<HTMLInputElement>("[data-apc-consent-acknowledge]")?.disabled === false
    )

    const review = editor.element.querySelector("[data-apc-consent-review]")!
    const reviewText = renderedText(review)
    expect(reviewText).toContain(hostileDestination.label)
    expect(reviewText).toContain(hostileDestination.provider)
    expect(reviewText).toContain(hostileDestination.model)
    expect(reviewText).not.toContain(hostileSummary)
    expect(reviewText).toContain("en:consent.disclosureSummary")
    expect(reviewText).toContain("en:workspace.nativeBlocks")
    expect(reviewText).not.toContain("native-blocks")
    expect(reviewText).not.toContain("main-context")
    expect(review.querySelector("img")).toBe(null)
    expect(review.querySelector("script")).toBe(null)
    expect(review.querySelector("svg")).toBe(null)
    expect(review.getAttribute("role")).toBe("dialog")
    expect(review.getAttribute("aria-modal")).toBe("true")
    const consequence = editor.element.querySelector("[data-apc-consent-dismissal-consequence]")!
    expect(fakeElement(consequence).dataset.apcConsentDismissalConsequence).toBe("required")
    expect(renderedText(consequence))
      .toContain("en:consent.impactRequired|requiredCount=1|optionalCount=0")
    editor.element.querySelector<HTMLButtonElement>("[data-apc-close-consent-review]")!.click()
    expect(editor.element.querySelector("[data-apc-consent-review]")).toBe(null)
    expect(editor.element.querySelector<HTMLInputElement>("[data-apc-thread-name]")!.readOnly).toBe(false)
    expect(editor.element.querySelector("[data-apc-thread-live-region]")?.textContent)
      .toContain("en:consent.impactRequired|requiredCount=1|optionalCount=0")

    editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.click()
    await settleUntil(() => resolved.length === 2)
    editor.render({ ...view, consentAuthorityGeneration: 3 })
    await settleUntil(() =>
      editor.element.querySelector<HTMLInputElement>("[data-apc-consent-acknowledge]")?.disabled === false
    )
    const acknowledgement = editor.element.querySelector<HTMLInputElement>("[data-apc-consent-acknowledge]")!
    expect(acknowledgement.parentElement?.textContent)
      .toContain("en:consent.acknowledgeDisclosure")
    const approve = editor.element.querySelector<HTMLButtonElement>("[data-apc-approve-consent]")!
    expect(approve.disabled).toBe(true)
    approve.click()
    expect(approved).toHaveLength(0)
    acknowledgement.checked = true
    acknowledgement.dispatchEvent(new Event("change"))
    expect(approve.disabled).toBe(false)
    approve.click()
    await settleUntil(() => approved.length === 1)

    editor.element.querySelector<HTMLButtonElement>("[data-apc-close-consent-review]")!.click()
    expect(editor.element.querySelector("[data-apc-consent-review]")).toBe(null)
    const approvedView = {
      ...view,
      consentAuthorityGeneration: 4,
      consents: [{ ...consent, status: "approved" as const }],
    }
    editor.render(approvedView)
    await settleUntil(() =>
      editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")?.disabled === false
    )
    editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.click()
    await settleUntil(() => resolved.length === 3)
    editor.render({ ...approvedView, consentAuthorityGeneration: 5 })
    await settleUntil(() =>
      editor.element.querySelector<HTMLButtonElement>("[data-apc-revoke-consent]")?.disabled === false
    )
    editor.element.querySelector<HTMLButtonElement>("[data-apc-revoke-consent]")!.click()
    await settleUntil(() => revoked.length === 1)
    editor.render({
      ...approvedView,
      consentAuthorityGeneration: 6,
      consents: [{ ...consent, status: "revoked" as const }],
    })
    await settleUntil(() => editor.element.querySelector("[data-apc-consent-review]") === null)
    expect(editor.element.querySelector("[data-apc-consent-status]")?.textContent)
      .toBe("en:consent.statusRevoked")

    const surface = renderedSurface(editor.element)
    for (const privateValue of [
      INSTALLATION_ID,
      PRESET_ID,
      THREAD_A,
      THREAD_B,
      RUN_SELECTED,
      RUN_EARLIER_A,
      RUN_EARLIER_B,
      BINDING_A,
      BINDING_B,
      SLOT_A,
      SLOT_B,
      CONNECTION_PRIMARY,
      CONNECTION_BACKUP,
      "untranslated-schema-name",
      "credential",
      "Retry",
      "native-blocks",
      "main-context",
      "slot:",
    ]) {
      expect(surface).not.toContain(privateValue)
    }
    editor.destroy()
  })

  test("localizes disclosure summaries without exposing backend summaries or workspace tokens", async () => {
    const workspaceLabels = {
      zh: {
        "native-blocks": "原生块",
        "main-context": "主上下文",
      },
      ja: {
        "native-blocks": "標準ブロック",
        "main-context": "メインコンテキスト",
      },
    } as const
    for (const locale of ["zh", "ja"] as const) {
      for (const workspaceSource of ["native-blocks", "main-context"] as const) {
        const { bridge } = createBridge()
        const editor = createThreadEditor({
          host,
          presetId: PRESET_ID,
          loom: bridge,
          t: createApcTranslator(() => locale),
          parent: fakeParent,
          onResolveConsent: () => {},
        })
        const destinationLabel = locale === "zh" ? "研究目的地" : "研究先"
        const backendSummary = `<script>backend summary ${locale}</script>`
        const view = snapshot({
          threads: [thread(THREAD_A, {
            workspaceSource,
            connectionSlotId: workspaceSource === "native-blocks" ? SLOT_A : undefined,
          })],
          consents: [{
            threadId: THREAD_A,
            workspaceSource,
            connectionSourceKey: workspaceSource === "native-blocks" ? `slot:${SLOT_A}` : "main",
            status: "required",
            destination: { label: destinationLabel, provider: "Provider", model: "Model" },
            disclosure: {
              version: 1,
              summary: backendSummary,
              categories: ["thread", "workspace", "source", "destination", "provider", "model"],
            },
          }],
        })
        editor.render(view)
        editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.click()
        editor.render({ ...view, consentAuthorityGeneration: 2 })
        await settleUntil(() =>
          editor.element.querySelector<HTMLInputElement>("[data-apc-consent-acknowledge]")?.disabled === false
        )
        const summary = editor.element.querySelector("[data-apc-consent-disclosure]")!
        expect(summary.textContent).toContain(destinationLabel)
        expect(summary.textContent).toContain(workspaceLabels[locale][workspaceSource])
        expect(summary.textContent).not.toContain(backendSummary)
        expect(summary.textContent).not.toContain("native-blocks")
        expect(summary.textContent).not.toContain("main-context")
        expect(summary.querySelector("script")).toBe(null)
        editor.destroy()
      }
    }
  })

  test("restores semantic focus and text selection after an ordinary snapshot render", () => {
    const { bridge } = createBridge()
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
    })
    const view = snapshot({ selectedRun: selectedRun() })
    editor.render(view)
    const originalName = editor.element.querySelector<HTMLInputElement>("[data-apc-thread-name]")!
    originalName.focus()
    originalName.setSelectionRange(2, 7)
    editor.render(view)
    const restoredName = editor.element.querySelector<HTMLInputElement>("[data-apc-thread-name]")!
    expect(restoredName).not.toBe(originalName)
    expect(fakeDocument.activeElement).toBe(restoredName)
    expect(fakeElement(restoredName).selectionStart).toBe(2)
    expect(fakeElement(restoredName).selectionEnd).toBe(7)
    editor.destroy()
  })

  test("keeps focus inside the connected host Loom subtree across ordinary renders", () => {
    const { bridge, calls } = createBridge()
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
    })
    const view = snapshot()
    editor.render(view)
    const originalWorkspace = calls[0]!.target.parentElement
    const hostControl = fakeDocument.createElement("input")
    calls[0]!.target.appendChild(hostControl)
    hostControl.focus()
    editor.render(view)
    expect(calls).toHaveLength(1)
    expect(fakeDocument.activeElement).toBe(hostControl)
    expect(hostControl.isConnected).toBe(true)
    expect(calls[0]!.target.parentElement).toBe(originalWorkspace)
    expect(originalWorkspace?.isConnected).toBe(true)
    expect(editor.element.querySelector("[data-apc-host-loom-editor]")).toBe(calls[0]!.target)
    editor.destroy()
  })

  test("moves focus to execution status when a lock disables the focused control", () => {
    const { bridge } = createBridge()
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
    })
    const view = snapshot({ selectedRun: selectedRun() })
    editor.render(view)
    editor.element.querySelector<HTMLInputElement>("[data-apc-run-required]")!.focus()
    editor.render({ ...view, mutationLocked: true })
    const lock = editor.element.querySelector("[data-apc-execution-lock]")!
    expect(fakeDocument.activeElement).toBe(lock)
    expect(fakeElement(lock).tabIndex).toBe(-1)
    expect(editor.element.querySelector<HTMLInputElement>("[data-apc-run-required]")!.disabled).toBe(true)
    editor.destroy()
  })

  test("locks every mutation during execution while leaving navigation and review available", () => {
    const { bridge, calls } = createBridge()
    let mutationAttempts = 0
    let navigationCount = 0
    const mutation = (): void => {
      mutationAttempts += 1
    }
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
      onBackToGraph: () => {
        navigationCount += 1
      },
      onOpenWorkspace: () => {
        navigationCount += 1
      },
      onResolveConsent: () => {},
      onRename: mutation,
      onWorkspaceSourceChange: mutation,
      onConnectionSlotChange: mutation,
      onBind: mutation,
      onUnbind: mutation,
      onRefreshConnections: mutation,
      onApproveConsent: mutation,
      onRevokeConsent: mutation,
      onRunChange: mutation,
      onRunBindingChange: mutation,
      onAddRunBinding: mutation,
      onRemoveRunBinding: mutation,
      onDirty: mutation,
    })
    editor.render(snapshot({
      selectedRun: selectedRun(),
      mutationLocked: true,
      threads: [thread(THREAD_A, { connectionSlotId: SLOT_A })],
      consents: [consent("approved")],
    }))
    expect(calls[0]!.options.readOnly).toBe(true)
    expect(editor.element.querySelector("[data-apc-execution-lock]")).not.toBe(null)
    const mutationSelectors = [
      "[data-apc-thread-name]",
      "[data-apc-thread-description]",
      "[data-apc-workspace-source-option]",
      "[data-apc-connection-slot]",
      "[data-apc-host-connection]",
      "[data-apc-bind]",
      "[data-apc-unbind]",
      "[data-apc-refresh-connections]",
      "[data-apc-run-required]",
      "[data-apc-run-timeout]",
      "[data-apc-run-position]",
      "[data-apc-binding-source]",
      "[data-apc-binding-role]",
      "[data-apc-binding-missing]",
      "[data-apc-add-run-binding]",
      "[data-apc-remove-run-binding]",
    ] as const
    for (const selector of mutationSelectors) {
      const control = editor.element.querySelector<HTMLInputElement>(selector)
      expect(control === null ? false : control.disabled || control.readOnly).toBe(true)
      control?.dispatchEvent(new Event(control.tagName.toLowerCase() === "button" ? "click" : "change"))
    }
    calls[0]!.options.onChange?.({ blocks: [], promptVariableValues: {} })
    expect(mutationAttempts).toBe(0)

    const back = editor.element.querySelector<HTMLButtonElement>("[data-apc-back-to-graph]")!
    const openWorkspace = editor.element.querySelector<HTMLButtonElement>("[data-apc-open-workspace]")!
    const review = editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!
    expect(back.disabled).toBe(false)
    expect(openWorkspace.disabled).toBe(false)
    expect(review.disabled).toBe(false)
    back.click()
    openWorkspace.click()
    review.click()
    expect(navigationCount).toBe(2)
    expect(editor.element.querySelector("[data-apc-consent-review]")).not.toBe(null)
    expect(editor.element.querySelector<HTMLInputElement>("[data-apc-consent-acknowledge]")!.disabled).toBe(true)
    expect(mutationAttempts).toBe(0)
    editor.destroy()
  })

  test("does not enter the save coordinator after teardown during a dirty write", async () => {
    const { bridge, handles } = createBridge()
    let releaseDirty: (() => void) | undefined
    const dirtyGate = new Promise<void>((resolve) => {
      releaseDirty = resolve
    })
    let flushes = 0
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
      onDirty: async () => {
        await dirtyGate
      },
      onFlush: () => {
        flushes += 1
      },
    })
    editor.render(snapshot())
    handles[0]!.value = {
      blocks: [] as PromptBlockDTO[],
      promptVariableValues: { "block-safe": { tone: "pending" } },
    }
    const flushing = editor.flush()
    await Promise.resolve()
    editor.destroy()
    releaseDirty?.()
    await flushing
    expect(flushes).toBe(0)
  })

  test("removes undefined optional Loom fields before publishing dirty state", async () => {
    const { bridge, calls, handles } = createBridge()
    let received: SpindleLoomBlockEditorValue | undefined
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
      onDirty: (_threadId, value) => {
        received = value
      },
      onFlush: () => {},
    })
    editor.render(snapshot())
    const block: PromptBlockDTO = {
      id: "block-safe",
      name: "Block",
      content: "Prompt",
      role: "system",
      enabled: true,
      position: "pre_history",
      depth: 0,
      marker: null,
      isLocked: false,
      color: null,
      injectionTrigger: [],
      group: null,
      variables: undefined,
    }
    const localValue: SpindleLoomBlockEditorValue = {
      blocks: [block],
      promptVariableValues: {},
    }
    handles[0]!.value = structuredClone(localValue)
    calls[0]!.options.onChange?.(localValue)

    await editor.flush()

    expect(Object.prototype.hasOwnProperty.call(block, "variables")).toBe(true)
    expect(received?.blocks).toHaveLength(1)
    expect(Object.prototype.hasOwnProperty.call(received?.blocks[0], "variables")).toBe(false)
    editor.destroy()
  })

  test("awaits serialized dirty writes before flush and reconciles authoritative state after success", async () => {
    const { bridge, handles } = createBridge()
    const order: string[] = []
    let releaseDirty: (() => void) | undefined
    const dirtyGate = new Promise<void>((resolve) => {
      releaseDirty = resolve
    })
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
      onDirty: async () => {
        order.push("dirty-start")
        await dirtyGate
        order.push("dirty-complete")
      },
      onFlush: () => {
        order.push("flush")
      },
    })
    editor.render(snapshot())
    const localValue: SpindleLoomBlockEditorValue = {
      blocks: [] as PromptBlockDTO[],
      promptVariableValues: { "block-safe": { tone: "focused" } },
    }
    handles[0]!.value = structuredClone(localValue)
    const flushing = editor.flush()
    await Promise.resolve()
    expect(order).toEqual(["dirty-start"])
    releaseDirty?.()
    await flushing
    expect(order).toEqual(["dirty-start", "dirty-complete", "flush"])

    const authoritativeValue: SpindleLoomBlockEditorValue = {
      blocks: [] as PromptBlockDTO[],
      promptVariableValues: { "block-safe": { tone: "authoritative" } },
    }
    editor.render(snapshot({
      threads: [
        thread(THREAD_A, { promptVariableValues: authoritativeValue.promptVariableValues }),
        thread(THREAD_B),
      ],
    }))
    expect(handles[0]!.updates.at(-1)?.value).toEqual(authoritativeValue)
    const controls = fakeElement(editor.element).querySelectorAll()
    editor.destroy()
    expect(handles[0]!.destroyed).toBe(true)
    expect(editor.element.parentElement).toBe(null)
    expect(controls.every((control) => control.activeListeners === 0)).toBe(true)
  })

  test("flushes again when Loom changes during an asynchronous coordinator flush", async () => {
    const { bridge, calls, handles } = createBridge()
    let flushCount = 0
    let releaseFirstFlush: (() => void) | undefined
    const firstFlushGate = new Promise<void>((resolve) => {
      releaseFirstFlush = resolve
    })
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
      onDirty: () => {},
      onFlush: async () => {
        flushCount += 1
        if (flushCount === 1) await firstFlushGate
      },
    })
    editor.render(snapshot())
    handles[0]!.value = {
      blocks: [] as PromptBlockDTO[],
      promptVariableValues: { "block-safe": { tone: "first" } },
    }
    const flushing = editor.flush()
    await settleUntil(() => flushCount === 1)
    expect(flushCount).toBe(1)
    const duringFlush: SpindleLoomBlockEditorValue = {
      blocks: [] as PromptBlockDTO[],
      promptVariableValues: { "block-safe": { tone: "during-flush" } },
    }
    handles[0]!.value = structuredClone(duringFlush)
    calls[0]!.options.onChange?.(structuredClone(duringFlush))
    releaseFirstFlush?.()
    await flushing
    expect(flushCount).toBe(2)

    const authoritative: SpindleLoomBlockEditorValue = {
      blocks: [] as PromptBlockDTO[],
      promptVariableValues: { "block-safe": { tone: "saved" } },
    }
    editor.render(snapshot({
      threads: [
        thread(THREAD_A, { promptVariableValues: authoritative.promptVariableValues }),
        thread(THREAD_B),
      ],
    }))
    expect(handles[0]!.updates.at(-1)?.value).toEqual(authoritative)
    editor.destroy()
  })

  test("retains the detached Loom value when the save coordinator fails", async () => {
    const { bridge, handles } = createBridge()
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
      onDirty: () => {},
      onFlush: () => {
        throw new Error("save failed")
      },
    })
    editor.render(snapshot())
    const localValue: SpindleLoomBlockEditorValue = {
      blocks: [] as PromptBlockDTO[],
      promptVariableValues: { "block-safe": { tone: "unsaved" } },
    }
    handles[0]!.value = structuredClone(localValue)
    let rejected = false
    try {
      await editor.flush()
    } catch {
      rejected = true
    }
    expect(rejected).toBe(true)
    editor.render(snapshot({
      threads: [
        thread(THREAD_A, { promptVariableValues: { "block-safe": { tone: "old-authoritative" } } }),
        thread(THREAD_B),
      ],
    }))
    expect(handles[0]!.updates.at(-1)?.value).toEqual(localValue)
    editor.destroy()
  })

  test("retains and retries dirty state after an asynchronous dirty-write rejection", async () => {
    const { bridge, handles } = createBridge()
    let dirtyAttempts = 0
    let flushes = 0
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
      onDirty: async () => {
        dirtyAttempts += 1
        if (dirtyAttempts === 1) throw new Error("dirty write failed")
      },
      onFlush: () => {
        flushes += 1
      },
    })
    editor.render(snapshot())
    handles[0]!.value = {
      blocks: [] as PromptBlockDTO[],
      promptVariableValues: { "block-safe": { tone: "retry" } },
    }
    let rejected = false
    try {
      await editor.flush()
    } catch {
      rejected = true
    }
    expect(rejected).toBe(true)
    expect(flushes).toBe(0)
    await editor.flush()
    expect(dirtyAttempts).toBe(2)
    expect(flushes).toBe(1)
    editor.destroy()
  })

  test("keeps deferred approval locked across review close and restores the live trigger after projection", async () => {
    const { bridge } = createBridge()
    let approvals = 0
    let releaseApproval: (() => void) | undefined
    const approvalGate = new Promise<void>((resolve) => {
      releaseApproval = resolve
    })
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
      onBackToGraph: () => {},
      onResolveConsent: () => {},
      onApproveConsent: () => {
        approvals += 1
        return approvalGate
      },
    })
    const view = snapshot({
      threads: [thread(THREAD_A, { connectionSlotId: SLOT_A })],
      consents: [consent()],
    })
    editor.render(view)
    editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.click()
    const resolvedView = { ...view, consentAuthorityGeneration: 2 }
    editor.render(resolvedView)
    await settleUntil(() =>
      editor.element.querySelector<HTMLInputElement>("[data-apc-consent-acknowledge]")?.disabled === false
    )
    const acknowledgement = editor.element.querySelector<HTMLInputElement>("[data-apc-consent-acknowledge]")!
    acknowledgement.checked = true
    acknowledgement.dispatchEvent(new Event("change"))
    editor.element.querySelector<HTMLButtonElement>("[data-apc-approve-consent]")!.click()
    await settleUntil(() => approvals === 1)
    editor.element.querySelector<HTMLButtonElement>("[data-apc-close-consent-review]")!.click()
    const pendingTrigger = editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!
    expect(pendingTrigger.disabled).toBe(true)
    pendingTrigger.click()
    expect(approvals).toBe(1)
    expect(editor.element.querySelector("[data-apc-consent-review]")).toBe(null)
    expect(fakeDocument.activeElement?.isConnected).toBe(true)
    expect(fakeDocument.activeElement?.disabled).toBe(false)
    releaseApproval?.()
    await Promise.resolve()
    expect(editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.disabled).toBe(true)
    editor.render({
      ...resolvedView,
      consentAuthorityGeneration: 3,
      consents: [consent("approved")],
    })
    await settleUntil(() =>
      editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")?.disabled === false
    )
    const restoredTrigger = editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!
    expect(fakeDocument.activeElement).toBe(restoredTrigger)
    editor.destroy()
  })

  test("keeps deferred revocation locked across review close and restores the live trigger after projection", async () => {
    const { bridge } = createBridge()
    let revocations = 0
    let releaseRevoke: (() => void) | undefined
    const revokeGate = new Promise<void>((resolve) => {
      releaseRevoke = resolve
    })
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
      onBackToGraph: () => {},
      onResolveConsent: () => {},
      onRevokeConsent: () => {
        revocations += 1
        return revokeGate
      },
    })
    const view = snapshot({
      threads: [thread(THREAD_A, { connectionSlotId: SLOT_A })],
      consents: [consent("approved")],
    })
    editor.render(view)
    editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.click()
    const resolvedView = { ...view, consentAuthorityGeneration: 2 }
    editor.render(resolvedView)
    await settleUntil(() =>
      editor.element.querySelector<HTMLButtonElement>("[data-apc-revoke-consent]")?.disabled === false
    )
    editor.element.querySelector<HTMLButtonElement>("[data-apc-revoke-consent]")!.click()
    await settleUntil(() => revocations === 1)
    editor.element.querySelector<HTMLButtonElement>("[data-apc-close-consent-review]")!.click()
    const pendingTrigger = editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!
    expect(pendingTrigger.disabled).toBe(true)
    pendingTrigger.click()
    expect(revocations).toBe(1)
    expect(editor.element.querySelector("[data-apc-consent-review]")).toBe(null)
    expect(fakeDocument.activeElement?.isConnected).toBe(true)
    expect(fakeDocument.activeElement?.disabled).toBe(false)
    releaseRevoke?.()
    await Promise.resolve()
    expect(editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.disabled).toBe(true)
    editor.render({
      ...resolvedView,
      consentAuthorityGeneration: 3,
      consents: [consent("revoked")],
    })
    await settleUntil(() =>
      editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")?.disabled === false
    )
    const restoredTrigger = editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!
    expect(fakeDocument.activeElement).toBe(restoredTrigger)
    editor.destroy()
  })

  test("focuses the live review trigger when deferred approval rejects after review close", async () => {
    const { bridge } = createBridge()
    let rejectApproval: ((reason?: unknown) => void) | undefined
    const approvalGate = new Promise<void>((_resolve, reject) => {
      rejectApproval = reject
    })
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
      onBackToGraph: () => {},
      onResolveConsent: () => {},
      onApproveConsent: () => approvalGate,
    })
    const view = snapshot({
      threads: [thread(THREAD_A, { connectionSlotId: SLOT_A })],
      consents: [consent()],
    })
    editor.render(view)
    editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.click()
    editor.render({ ...view, consentAuthorityGeneration: 2 })
    await settleUntil(() =>
      editor.element.querySelector<HTMLInputElement>("[data-apc-consent-acknowledge]")?.disabled === false
    )
    const acknowledgement = editor.element.querySelector<HTMLInputElement>("[data-apc-consent-acknowledge]")!
    acknowledgement.checked = true
    acknowledgement.dispatchEvent(new Event("change"))
    editor.element.querySelector<HTMLButtonElement>("[data-apc-approve-consent]")!.click()
    await settleUntil(() => rejectApproval !== undefined)
    editor.element.querySelector<HTMLButtonElement>("[data-apc-close-consent-review]")!.click()
    rejectApproval?.(new Error("private approval failure"))
    await settleUntil(() =>
      editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")?.disabled === false
    )
    const trigger = editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!
    expect(fakeDocument.activeElement).toBe(trigger)
    expect(fakeElement(trigger).isConnected).toBe(true)
    expect(trigger.disabled).toBe(false)
    expect(editor.element.querySelector("[data-apc-thread-live-region]")?.textContent).toBe("en:error.connection")
    editor.destroy()
  })

  test("focuses the live review trigger when deferred revocation rejects after review close", async () => {
    const { bridge } = createBridge()
    let rejectRevoke: ((reason?: unknown) => void) | undefined
    const revokeGate = new Promise<void>((_resolve, reject) => {
      rejectRevoke = reject
    })
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
      onBackToGraph: () => {},
      onResolveConsent: () => {},
      onRevokeConsent: () => revokeGate,
    })
    const view = snapshot({
      threads: [thread(THREAD_A, { connectionSlotId: SLOT_A })],
      consents: [consent("approved")],
    })
    editor.render(view)
    editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.click()
    editor.render({ ...view, consentAuthorityGeneration: 2 })
    await settleUntil(() =>
      editor.element.querySelector<HTMLButtonElement>("[data-apc-revoke-consent]")?.disabled === false
    )
    editor.element.querySelector<HTMLButtonElement>("[data-apc-revoke-consent]")!.click()
    await settleUntil(() => rejectRevoke !== undefined)
    editor.element.querySelector<HTMLButtonElement>("[data-apc-close-consent-review]")!.click()
    rejectRevoke?.(new Error("private revoke failure"))
    await settleUntil(() =>
      editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")?.disabled === false
    )
    const trigger = editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!
    expect(fakeDocument.activeElement).toBe(trigger)
    expect(fakeElement(trigger).isConnected).toBe(true)
    expect(trigger.disabled).toBe(false)
    expect(editor.element.querySelector("[data-apc-thread-live-region]")?.textContent).toBe("en:error.connection")
    editor.destroy()
  })

  test("fails closed instead of hanging when approval publishes an unexpected authoritative status", async () => {
    for (const status of ["revoked", "required"] as const) {
      const { bridge } = createBridge()
      const editor = createThreadEditor({
        host,
        presetId: PRESET_ID,
        loom: bridge,
        t: translator("en"),
        parent: fakeParent,
        onResolveConsent: () => {},
        onApproveConsent: () => {},
      })
      const view = snapshot({
        threads: [thread(THREAD_A, { connectionSlotId: SLOT_A })],
        consents: [consent()],
      })
      editor.render(view)
      editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.click()
      const resolvedView = { ...view, consentAuthorityGeneration: 2 }
      editor.render(resolvedView)
      await settleUntil(() =>
        editor.element.querySelector<HTMLInputElement>("[data-apc-consent-acknowledge]")?.disabled === false
      )
      const acknowledgement = editor.element.querySelector<HTMLInputElement>("[data-apc-consent-acknowledge]")!
      acknowledgement.checked = true
      acknowledgement.dispatchEvent(new Event("change"))
      editor.element.querySelector<HTMLButtonElement>("[data-apc-approve-consent]")!.click()
      await Promise.resolve()
      editor.render({
        ...resolvedView,
        consentAuthorityGeneration: 3,
        consents: [consent(status)],
      })
      expect(editor.element.querySelector("[data-apc-thread-live-region]")?.textContent).toBe("en:error.connection")
      expect(editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.disabled).toBe(true)
      expect(renderedText(editor.element)).not.toContain("Retry")
      editor.destroy()
    }
  })

  test("fails closed instead of hanging when revocation publishes an unexpected authoritative status", async () => {
    for (const status of ["required", "approved"] as const) {
      const { bridge } = createBridge()
      const editor = createThreadEditor({
        host,
        presetId: PRESET_ID,
        loom: bridge,
        t: translator("en"),
        parent: fakeParent,
        onResolveConsent: () => {},
        onRevokeConsent: () => {},
      })
      const view = snapshot({
        threads: [thread(THREAD_A, { connectionSlotId: SLOT_A })],
        consents: [consent("approved")],
      })
      editor.render(view)
      editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.click()
      const resolvedView = { ...view, consentAuthorityGeneration: 2 }
      editor.render(resolvedView)
      await settleUntil(() =>
        editor.element.querySelector<HTMLButtonElement>("[data-apc-revoke-consent]")?.disabled === false
      )
      editor.element.querySelector<HTMLButtonElement>("[data-apc-revoke-consent]")!.click()
      await Promise.resolve()
      editor.render({
        ...resolvedView,
        consentAuthorityGeneration: 3,
        consents: [consent(status)],
      })
      expect(editor.element.querySelector("[data-apc-thread-live-region]")?.textContent).toBe("en:error.connection")
      expect(renderedText(editor.element)).not.toContain("Retry")
      editor.destroy()
    }
  })

  test("keeps every context mutation locked across hostile same-thread context drift", async () => {
    const assertPendingFocus = (editor: ThreadEditorController): void => {
      expect(fakeElement(editor.element).dataset.apcConsentContextMutation).toBe("awaiting-authoritative")
      const active = fakeDocument.activeElement
      expect(active?.isConnected).toBe(true)
      expect(active?.disabled).toBe(false)
      expect(active?.dataset.apcThreadWorkspaceHeading).toBe("true")
    }

    {
      const { bridge } = createBridge()
      const editor = createThreadEditor({
        host,
        presetId: PRESET_ID,
        loom: bridge,
        t: translator("en"),
        parent: fakeParent,
        onWorkspaceSourceChange: () => {},
      })
      const view = snapshot({ threads: [thread(THREAD_A, { connectionSlotId: SLOT_A })] })
      editor.render(view)
      const source = editor.element.querySelectorAll<HTMLInputElement>("[data-apc-workspace-source-option]")[1]!
      source.checked = true
      source.dispatchEvent(new Event("change"))
      await settleUntil(() =>
        fakeElement(editor.element).dataset.apcConsentContextMutation === "awaiting-authoritative"
      )
      editor.render({
        ...view,
        contextAuthorityGeneration: 2,
        threads: [thread(THREAD_A, { workspaceSource: "main-context", connectionSlotId: SLOT_B })],
        slots: [slot(), slot({ id: SLOT_B, label: "Second slot" })],
      })
      assertPendingFocus(editor)
      editor.render({
        ...view,
        contextAuthorityGeneration: 3,
        threads: [thread(THREAD_A, { workspaceSource: "main-context", connectionSlotId: SLOT_A })],
      })
      expect(fakeElement(editor.element).dataset.apcConsentContextMutation).toBe("idle")
      editor.destroy()
    }

    {
      const { bridge } = createBridge()
      const editor = createThreadEditor({
        host,
        presetId: PRESET_ID,
        loom: bridge,
        t: translator("en"),
        parent: fakeParent,
        onConnectionSlotChange: () => {},
      })
      const view = snapshot({ threads: [thread(THREAD_A, { connectionSlotId: SLOT_A })] })
      editor.render(view)
      const select = editor.element.querySelector<HTMLSelectElement>("[data-apc-connection-slot]")!
      select.value = "main"
      select.dispatchEvent(new Event("change"))
      await settleUntil(() =>
        fakeElement(editor.element).dataset.apcConsentContextMutation === "awaiting-authoritative"
      )
      editor.render({
        ...view,
        contextAuthorityGeneration: 2,
        threads: [thread(THREAD_A, { connectionSlotId: SLOT_B })],
        slots: [slot(), slot({ id: SLOT_B, label: "Second slot" })],
      })
      assertPendingFocus(editor)
      editor.render({
        ...view,
        contextAuthorityGeneration: 3,
        threads: [thread(THREAD_A, { connectionSlotId: undefined })],
      })
      expect(fakeElement(editor.element).dataset.apcConsentContextMutation).toBe("idle")
      editor.destroy()
    }

    {
      const { bridge } = createBridge()
      const editor = createThreadEditor({
        host,
        presetId: PRESET_ID,
        loom: bridge,
        t: translator("en"),
        parent: fakeParent,
        onBind: () => {},
      })
      const view = snapshot({
        threads: [thread(THREAD_A, { connectionSlotId: SLOT_A })],
        slots: [slot({ bound: false, bindingStatus: "missing", boundConnectionId: undefined })],
      })
      editor.render(view)
      const connection = editor.element.querySelector<HTMLSelectElement>("[data-apc-host-connection]")!
      connection.value = "connection-choice-1"
      connection.dispatchEvent(new Event("change"))
      editor.element.querySelector<HTMLButtonElement>("[data-apc-bind]")!.click()
      await settleUntil(() =>
        fakeElement(editor.element).dataset.apcConsentContextMutation === "awaiting-authoritative"
      )
      const boundSlot = slot({ bound: true, bindingStatus: "bound", boundConnectionId: CONNECTION_PRIMARY })
      editor.render({
        ...view,
        contextAuthorityGeneration: 2,
        threads: [thread(THREAD_A, { workspaceSource: "main-context", connectionSlotId: SLOT_A })],
        slots: [boundSlot],
      })
      assertPendingFocus(editor)
      editor.render({ ...view, contextAuthorityGeneration: 3, slots: [boundSlot] })
      expect(fakeElement(editor.element).dataset.apcConsentContextMutation).toBe("idle")
      editor.destroy()
    }

    {
      const { bridge } = createBridge()
      const editor = createThreadEditor({
        host,
        presetId: PRESET_ID,
        loom: bridge,
        t: translator("en"),
        parent: fakeParent,
        onUnbind: () => {},
      })
      const view = snapshot({ threads: [thread(THREAD_A, { connectionSlotId: SLOT_A })] })
      editor.render(view)
      editor.element.querySelector<HTMLButtonElement>("[data-apc-unbind]")!.click()
      await settleUntil(() =>
        fakeElement(editor.element).dataset.apcConsentContextMutation === "awaiting-authoritative"
      )
      const unboundSlot = slot({ bound: false, bindingStatus: "missing", boundConnectionId: undefined })
      editor.render({
        ...view,
        contextAuthorityGeneration: 2,
        threads: [thread(THREAD_A, { workspaceSource: "main-context", connectionSlotId: SLOT_A })],
        slots: [unboundSlot],
      })
      assertPendingFocus(editor)
      editor.render({ ...view, contextAuthorityGeneration: 3, slots: [unboundSlot] })
      expect(fakeElement(editor.element).dataset.apcConsentContextMutation).toBe("idle")
      editor.destroy()
    }

    {
      const { bridge } = createBridge()
      const editor = createThreadEditor({
        host,
        presetId: PRESET_ID,
        loom: bridge,
        t: translator("en"),
        parent: fakeParent,
        onRefreshConnections: () => {},
      })
      const view = snapshot({
        threads: [thread(THREAD_A, { connectionSlotId: SLOT_A })],
        slots: [slot({ bindingStatus: "stale" })],
      })
      editor.render(view)
      editor.element.querySelector<HTMLButtonElement>("[data-apc-refresh-connections]")!.click()
      await settleUntil(() =>
        fakeElement(editor.element).dataset.apcConsentContextMutation === "awaiting-authoritative"
      )
      editor.render({
        ...view,
        contextAuthorityGeneration: 2,
        threads: [thread(THREAD_A, { workspaceSource: "main-context", connectionSlotId: SLOT_A })],
        slots: [slot({ bound: false, bindingStatus: "missing", boundConnectionId: undefined })],
      })
      assertPendingFocus(editor)
      editor.render({
        ...view,
        contextAuthorityGeneration: 3,
        slots: [slot({ bound: false, bindingStatus: "missing", boundConnectionId: undefined })],
      })
      expect(fakeElement(editor.element).dataset.apcConsentContextMutation).toBe("idle")
      editor.destroy()
    }
  })
  test("renders the final consent hierarchy and restores configuration focus from Back and Change", async () => {
    const { bridge } = createBridge()
    const editor = createThreadEditor({
      host,
      presetId: PRESET_ID,
      loom: bridge,
      t: translator("en"),
      parent: fakeParent,
      onResolveConsent: () => {},
      onConsentReviewChange: () => undefined,
      onConnectionSlotChange: () => {},
    })
    const view = snapshot({
      threads: [thread(THREAD_A, { connectionSlotId: SLOT_A })],
      consents: [consent()],
    })
    editor.render(view)
    editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.click()
    editor.render({ ...view, consentAuthorityGeneration: 2 })
    await settleUntil(() =>
      editor.element.querySelector<HTMLInputElement>("[data-apc-consent-acknowledge]")?.disabled === false
    )
    const review = editor.element.querySelector<HTMLElement>("[data-apc-consent-review]")!
    expect(review.querySelector("[data-apc-consent-review-header]")).not.toBe(null)
    expect(review.querySelector("[data-apc-consent-review-progress]")).not.toBe(null)
    expect(review.querySelector("[data-apc-consent-review-body]")).not.toBe(null)
    expect(review.querySelector("[data-apc-consent-review-footer]")).not.toBe(null)
    expect(review.querySelector("[data-apc-consent-source]")).not.toBe(null)
    expect(review.querySelector("[data-apc-consent-destination-state=\"available\"]")).not.toBe(null)
    expect(review.querySelector("[data-apc-consent-purpose]")).not.toBe(null)
    expect(review.querySelector("[data-apc-consent-scope]")).not.toBe(null)
    expect(review.querySelector("[data-apc-consent-local-approval]")).not.toBe(null)

    review.querySelector<HTMLButtonElement>("[data-apc-consent-back]")!.click()
    expect(editor.element.querySelector("[data-apc-consent-review]")).toBe(null)
    expect(fakeDocument.activeElement!.dataset.apcConnectionSlot).toBe("true")

    editor.element.querySelector<HTMLButtonElement>("[data-apc-open-consent-review]")!.click()
    editor.render({ ...view, consentAuthorityGeneration: 3 })
    await settleUntil(() =>
      editor.element.querySelector<HTMLInputElement>("[data-apc-consent-acknowledge]")?.disabled === false
    )
    editor.element.querySelector<HTMLButtonElement>("[data-apc-consent-change-destination]")!.click()
    expect(editor.element.querySelector("[data-apc-consent-review]")).toBe(null)
    expect(fakeDocument.activeElement!.dataset.apcHostConnection).toBe("true")
    editor.destroy()
  })
})

afterAll(() => {
  if (originalDocument === undefined) delete globals.document
  else globals.document = originalDocument
  if (originalHTMLElement === undefined) delete globals.HTMLElement
  else globals.HTMLElement = originalHTMLElement
})
