// @ts-ignore Bun provides the test module at runtime; extension bundles exclude tests.
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { JSDOM } from "jsdom"
import type { ApcMode, ApcPresetConfigV1, ApcRunV1, ApcStageV1 } from "../config/schema"
import {
  MAX_BINDINGS_PER_RUN,
  MAX_CONNECTION_SLOTS,
  MAX_FINAL_INPUTS,
  MAX_NAME_CHARS,
  MIN_RUN_TIMEOUT_MS,
  MAX_RUNS_PER_PIPELINE,
  MAX_STAGES_PER_PIPELINE,
  MAX_THREADS,
} from "../config/limits"
import { validateConfigForMode } from "../config/validate"
import { createApcTranslator } from "../i18n/catalogs"
import type { ApcSelection } from "./state"
import {
  createGraphEditor,
  type GraphEditorHandle,
  type GraphEditorMutation,
  type GraphEditorOptions,
  type GraphEditorSnapshot,
} from "./graph-editor"

const browser = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
})
const globals = globalThis as unknown as Record<string, unknown>
const previousGlobals = new Map<string, unknown>([
  ["window", globals.window],
  ["document", globals.document],
  ["HTMLElement", globals.HTMLElement],
])
globals.window = browser.window
globals.document = browser.window.document
globals.HTMLElement = browser.window.HTMLElement
const t = createApcTranslator(() => "en")

const IDS = {
  threadA: "11111111-1111-4111-8111-111111111111",
  threadB: "22222222-2222-4222-8222-222222222222",
  stageA: "33333333-3333-4333-8333-333333333333",
  stageB: "44444444-4444-4444-8444-444444444444",
  runA: "55555555-5555-4555-8555-555555555555",
  runB: "66666666-6666-4666-8666-666666666666",
  runC: "77777777-7777-4777-8777-777777777777",
  pipelineSequential: "88888888-8888-4888-8888-888888888888",
  pipelineParallel: "99999999-9999-4999-8999-999999999999",
} as const

function baseConfig(mode: ApcMode = "sequential"): ApcPresetConfigV1 {
  return {
    schemaVersion: 1,
    supportedModes: ["single", "sequential", "parallel"],
    activeMode: mode,
    mainThread: {
      id: "main",
      name: "Main Thread",
      output: { id: "final", name: "Final Response" },
    },
    connectionSlots: [],
    threads: [
      {
        id: IDS.threadA,
        name: "Researcher",
        description: "Collect evidence",
        workspaceSource: "native-blocks",
        blocks: [],
        promptVariableValues: {},
        output: { id: "final", name: "Final Response" },
      },
      {
        id: IDS.threadB,
        name: "Writer",
        description: "Compose a response",
        workspaceSource: "main-context",
        blocks: [],
        promptVariableValues: {},
        output: { id: "final", name: "Final Response" },
      },
    ],
    pipelines: {
      sequential: {
        id: IDS.pipelineSequential,
        stages: [
          {
            id: IDS.stageA,
            name: "Research",
            runs: [{ id: IDS.runA, threadId: IDS.threadA, required: true, timeoutMs: 60_000, inputs: [] }],
          },
          {
            id: IDS.stageB,
            name: "Writing",
            runs: [{
              id: IDS.runB,
              threadId: IDS.threadB,
              required: true,
              timeoutMs: 60_000,
              inputs: [{ source: "output", runId: IDS.runA, role: "user", onMissing: "omit-binding" }],
            }],
          },
        ],
        finalResponse: { source: "thread", runId: IDS.runB },
      },
      parallel: {
        id: IDS.pipelineParallel,
        stages: [
          {
            id: IDS.stageA,
            name: "Research",
            runs: [
              { id: IDS.runA, threadId: IDS.threadA, required: true, timeoutMs: 60_000, inputs: [] },
              { id: IDS.runB, threadId: IDS.threadB, required: false, timeoutMs: 60_000, inputs: [] },
            ],
          },
          {
            id: IDS.stageB,
            name: "Synthesis",
            runs: [{
              id: IDS.runC,
              threadId: IDS.threadA,
              required: true,
              timeoutMs: 60_000,
              inputs: [
                { source: "output", runId: IDS.runA, role: "user", onMissing: "fail-graph" },
                { source: "output", runId: IDS.runB, role: "user", onMissing: "omit-binding" },
              ],
            }],
          },
        ],
        finalResponse: { source: "thread", runId: IDS.runC },
      },
    },
  }
}

function generatedId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`
}

function capacityBoundParallelConfig(kind: "downstream" | "final"): Readonly<{
  config: ApcPresetConfigV1
  targetStageName: string
  finalRunId?: string
}> {
  const config = baseConfig("parallel")
  config.threads = Array.from({ length: 4 }, (_, index) => ({
    ...structuredClone(config.threads[index % config.threads.length]!),
    id: generatedId(700 + index),
    name: `Capacity thread ${index + 1}`,
  }))
  const sourceCounts = kind === "downstream"
    ? [4, 4, 4, 4, 4, 4, 4, 1, 3]
    : [4, 4, 4, 4, 4, 4, 4, 3, 1]
  const sourceRuns: ApcRunV1[] = []
  const stages: ApcStageV1[] = sourceCounts.map((count, stageIndex) => {
    const runs = Array.from({ length: count }, (_, runIndex): ApcRunV1 => ({
      id: generatedId(800 + sourceRuns.length + runIndex),
      threadId: config.threads[runIndex]!.id,
      required: true,
      timeoutMs: MIN_RUN_TIMEOUT_MS,
      inputs: [],
    }))
    sourceRuns.push(...runs)
    return {
      id: generatedId(900 + stageIndex),
      name: `Capacity source ${stageIndex + 1}`,
      runs,
    }
  })
  const targetStageName = stages.at(-1)!.name
  if (kind === "final") {
    config.pipelines.parallel = {
      id: generatedId(950),
      stages,
      finalResponse: {
        source: "main",
        inputs: sourceRuns.map((run) => ({
          source: "output",
          runId: run.id,
          onMissing: "fail-graph",
        })),
      },
    }
    return { config, targetStageName }
  }
  const finalRunId = generatedId(960)
  stages.push({
    id: generatedId(959),
    name: "Capacity final",
    runs: [{
      id: finalRunId,
      threadId: config.threads[0]!.id,
      required: true,
      timeoutMs: MIN_RUN_TIMEOUT_MS,
      inputs: sourceRuns.map((run) => ({
        source: "output",
        runId: run.id,
        role: "user",
        onMissing: "fail-graph",
      })),
    }],
  })
  config.pipelines.parallel = {
    id: generatedId(950),
    stages,
    finalResponse: { source: "thread", runId: finalRunId },
  }
  return { config, targetStageName, finalRunId }
}

function collisionFactory(ids: readonly string[]): () => string {
  let index = 0
  return () => ids[index++] ?? generatedId(10_000 + index)
}

function configuredSnapshot(mode: ApcMode = "sequential", selection: ApcSelection = null): GraphEditorSnapshot {
  const config = baseConfig(mode)
  return {
    config,
    activeMode: mode,
    selection,
    supportedModes: config.supportedModes,
    dirty: false,
    busy: false,
    blockedReasons: [],
  }
}

function firstUseSnapshot(): GraphEditorSnapshot {
  const config = baseConfig("single")
  config.supportedModes = ["single"]
  config.pipelines = {}
  config.threads = []
  return {
    config,
    activeMode: "single",
    selection: null,
    supportedModes: ["single"],
    dirty: false,
    busy: false,
    blockedReasons: [],
  }
}

interface Mounted {
  readonly handle: GraphEditorHandle
  readonly root: HTMLElement
  readonly mutations: GraphEditorMutation[]
  readonly selections: ApcSelection[]
  getSnapshot(): GraphEditorSnapshot
}

function mount(
  initial: GraphEditorSnapshot = configuredSnapshot(),
  options: Partial<GraphEditorOptions> = {},
  syncConfigChange = true,
): Mounted {
  let current = initial
  let handle: GraphEditorHandle
  const mutations: GraphEditorMutation[] = []
  const selections: ApcSelection[] = []
  handle = createGraphEditor({
    ...options,
    document: browser.window.document,
    snapshot: current,
    t: options.t ?? t,
    onConfigChange: (config, mutation) => {
      mutations.push(mutation)
      current = { ...current, config, activeMode: config.activeMode, supportedModes: config.supportedModes, dirty: true }
      options.onConfigChange?.(config, mutation)
      if (syncConfigChange) handle.render(current)
    },
    onSelectionChange: (selection) => {
      selections.push(selection)
      current = { ...current, selection }
      options.onSelectionChange?.(selection)
      handle.render(current)
    },
  })
  const root = browser.window.document.createElement("div")
  root.append(handle.element)
  browser.window.document.body.append(root)
  return { handle, root, mutations, selections, getSnapshot: () => current }
}

function click(root: HTMLElement, selector: string): HTMLElement {
  const element = root.querySelector<HTMLElement>(selector)
  expect(element).not.toBeNull()
  element?.dispatchEvent(new browser.window.MouseEvent("click", { bubbles: true }))
  return element as HTMLElement
}

function actionIn(
  root: HTMLElement,
  containerSelector: string,
  label: string,
  action: string,
): HTMLElement {
  const container = [...root.querySelectorAll<HTMLElement>(containerSelector)]
    .find((candidate) => candidate.textContent?.includes(label))
  const element = container?.querySelector<HTMLElement>(`[data-action="${action}"]`) ?? null
  expect(element).not.toBeNull()
  return element as HTMLElement
}

function threadAction(root: HTMLElement, thread: string, action: string): HTMLElement {
  return actionIn(root, "[data-apc-thread-navigation=true] li", thread, action)
}

function stageAction(root: HTMLElement, stage: string, action: string): HTMLElement {
  return actionIn(root, "[data-apc-stage=true]", stage, action)
}

function runAction(root: HTMLElement, stage: string, thread: string, action: string): HTMLElement {
  const stageCard = [...root.querySelectorAll<HTMLElement>("[data-apc-stage=true]")]
    .find((candidate) => candidate.querySelector("h3")?.textContent?.includes(stage))
  expect(stageCard).not.toBeNull()
  return actionIn(stageCard as HTMLElement, "[data-apc-run-card=true]", thread, action)
}

function clickElement(element: HTMLElement): void {
  element.dispatchEvent(new browser.window.MouseEvent("click", { bubbles: true }))
}

function key(target: HTMLElement, value: string, altKey = false): void {
  target.dispatchEvent(new browser.window.KeyboardEvent("keydown", { key: value, altKey, bubbles: true }))
}

beforeEach(() => {
  browser.window.document.body.replaceChildren()
})

afterAll(() => {
  browser.window.close()
  for (const [name, value] of previousGlobals) {
    if (value === undefined) delete globals[name]
    else globals[name] = value
  }
})

describe("APC compact graph editor", () => {
  test("keeps first use explicit and offers separate graph creation actions", () => {
    const mounted = mount(firstUseSnapshot())

    const creationActions = [...mounted.root.querySelectorAll<HTMLButtonElement>(
      "[data-apc-first-use-actions=true] [data-action=create-graph]",
    )]
    expect(creationActions.map((action) => action.dataset.mode)).toEqual(["sequential", "parallel"])
    expect(creationActions.map((action) => action.textContent)).toEqual([
      t("action.createSequentialGraph"),
      t("action.createParallelGraph"),
    ])

    expect(mounted.root.querySelector("[data-apc-graph-empty=true]")).not.toBeNull()
    expect(mounted.root.querySelector('[data-mode="sequential"]')?.hasAttribute("disabled")).toBe(true)
    expect(mounted.root.querySelector('[data-mode="parallel"]')?.hasAttribute("disabled")).toBe(true)
    expect(mounted.root.querySelectorAll('[data-action="create-graph"]')).toHaveLength(2)
    const unavailable = mounted.root.querySelectorAll<HTMLButtonElement>("[data-apc-unavailable-graph-action=true]")
    expect(unavailable).toHaveLength(2)
    expect([...unavailable].every((control) => control.disabled)).toBe(true)
    expect(mounted.root.querySelector("[data-apc-unavailable-graph-actions=true] + [role=note]")?.textContent).not.toBe("")
    expect(mounted.getSnapshot().config?.threads).toHaveLength(0)
    expect(mounted.getSnapshot().config?.pipelines.parallel).toBeUndefined()
    expect(mounted.mutations).toHaveLength(0)

    click(mounted.root, '[data-action="create-graph"][data-mode="parallel"]')

    expect(mounted.getSnapshot().config?.activeMode).toBe("parallel")
    expect(mounted.getSnapshot().config?.threads).toHaveLength(1)
    expect(mounted.getSnapshot().config?.pipelines.parallel?.stages).toHaveLength(1)
    expect(mounted.getSnapshot().config?.pipelines.sequential).toBeUndefined()
    expect(mounted.mutations.at(-1)).toMatchObject({ type: "config", reason: "graph-created-parallel" })
    expect(browser.window.document.activeElement?.getAttribute("data-mode")).toBe("parallel")
    expect(mounted.root.querySelector('[data-action="create-graph"][data-mode="sequential"][data-preserve-mode="true"]')).not.toBeNull()
    click(mounted.root, '[data-action="create-graph"][data-mode="sequential"][data-preserve-mode="true"]')
    expect(mounted.getSnapshot().config?.pipelines.sequential?.stages).toHaveLength(1)
    expect(mounted.getSnapshot().config?.pipelines.parallel?.stages).toHaveLength(1)
    expect(mounted.getSnapshot().config?.activeMode).toBe("parallel")
    expect(browser.window.document.activeElement?.getAttribute("data-mode")).toBe("parallel")
    mounted.handle.destroy()
  })

  test("localizes the default thread output when creating a graph", () => {
    const translator = createApcTranslator(() => "fr")
    const mounted = mount(firstUseSnapshot(), { t: translator })

    click(mounted.root, '[data-action="create-graph"][data-mode="sequential"]')

    const thread = mounted.getSnapshot().config?.threads[0]
    const expected = translator("graph.defaultFinalResponseName")
    const createdConfig = mounted.getSnapshot().config
    expect(thread?.output).toEqual({ id: "final", name: "Final Response" })
    expect(createdConfig ? validateConfigForMode(createdConfig, "sequential").valid : false).toBe(true)
    expect(mounted.root.querySelector<HTMLElement>("[data-apc-final-route=true] .apc-final-output")?.textContent).toContain(expected)
    mounted.handle.destroy()
  })

  test("keeps hostile thread, stage, and output labels in text and ARIA content", () => {
    const hostileThread = '<img src="thread" onerror="window.__apcInjected=1">'
    const hostileStage = '<svg onload="window.__apcInjected=1">'
    const hostileOutput = '<script>window.__apcInjected=1</script>'
    const config = baseConfig("sequential")
    config.threads[0].name = hostileThread
    config.pipelines.sequential!.stages[0].name = hostileStage
    const catalogTranslator = createApcTranslator(() => "en")
    const translator = ((key: Parameters<typeof t>[0], values?: Parameters<typeof t>[1]) =>
      key === "graph.defaultFinalResponseName" ? hostileOutput : catalogTranslator(key, values)) as typeof t
    const mounted = mount({ ...configuredSnapshot("sequential"), config }, { t: translator })

    const threadControl = threadAction(mounted.root, hostileThread, "select-thread")
    expect(threadControl.textContent).toContain(hostileThread)
    expect(threadControl.getAttribute("aria-label")).toContain(hostileThread)
    const stage = mounted.root.querySelector<HTMLElement>("[data-apc-stage=true]")
    expect(stage?.textContent).toContain(hostileStage)
    expect(mounted.root.querySelector<HTMLElement>("[data-apc-final-route=true] .apc-final-output")?.textContent)
      .toContain(hostileOutput)
    expect(mounted.root.querySelector("img, svg, script, iframe, object, embed")).toBeNull()
    mounted.handle.destroy()
  })
  test("renders complete earlier-output binding summaries with source, role, and missing policy", () => {
    const config = baseConfig("parallel")
    const consumer = config.pipelines.parallel!.stages[1]!.runs[0]!
    consumer.inputs = [
      { source: "output", runId: IDS.runA, role: "system", onMissing: "fail-graph" },
      { source: "output", runId: IDS.runB, role: "assistant", onMissing: "omit-binding" },
    ]
    const mounted = mount({ ...configuredSnapshot("parallel"), config })
    const summaries = [...mounted.root.querySelectorAll<HTMLElement>("[data-apc-earlier-output-binding=true]")]

    expect(summaries).toHaveLength(2)
    expect(summaries.every((item) => item.classList.contains("apc-binding"))).toBe(true)
    expect(summaries.map((item) => item.dataset.apcBindingKind)).toEqual(["output", "output"])
    expect(summaries[0]?.querySelector<HTMLElement>("[data-apc-binding-source=true]")?.textContent)
      .toBe("Researcher · Final Response")
    expect(summaries[1]?.querySelector<HTMLElement>("[data-apc-binding-source=true]")?.textContent)
      .toBe("Writer · Final Response")
    expect(summaries[0]?.querySelector<HTMLElement>("[data-apc-binding-role=true]")?.textContent)
      .toBe(`${t("binding.role")}: ${t("binding.roleSystem")}`)
    expect(summaries[1]?.querySelector<HTMLElement>("[data-apc-binding-role=true]")?.textContent)
      .toBe(`${t("binding.role")}: ${t("binding.roleAssistant")}`)
    expect(summaries[0]?.querySelector<HTMLElement>("[data-apc-binding-missing=true]")?.textContent)
      .toBe(`${t("binding.missingPolicy")}: ${t("binding.missingFailGraph")}`)
    expect(summaries[1]?.querySelector<HTMLElement>("[data-apc-binding-missing=true]")?.textContent)
      .toBe(`${t("binding.missingPolicy")}: ${t("binding.missingOmit")}`)
    mounted.handle.destroy()
  })

  test("renders explicit output text for Main and thread final routes", () => {
    const mainConfig = baseConfig("parallel")
    mainConfig.pipelines.parallel!.finalResponse = {
      source: "main",
      inputs: [{ source: "output", runId: IDS.runC, onMissing: "fail-graph" }],
    }
    const main = mount({ ...configuredSnapshot("parallel"), config: mainConfig })
    expect(main.root.querySelector<HTMLElement>('[data-apc-final-output=true][data-route-source="main"]')?.textContent)
      .toBe(`${t("agentGraph.finalMain")} · ${t("graph.defaultFinalResponseName")}`)

    const thread = mount(configuredSnapshot("parallel"))
    expect(thread.root.querySelector<HTMLElement>('[data-apc-final-output=true][data-route-source="thread"]')?.textContent)
      .toBe("Researcher · Final Response")
    main.handle.destroy()
    thread.handle.destroy()
  })


  test("emits exact thread and run selections and renders selected state without inline forms", () => {
    const mounted = mount(configuredSnapshot("parallel"))

    clickElement(threadAction(mounted.root, "Writer", "select-thread"))
    expect(mounted.selections.at(-1)).toEqual({ kind: "thread", threadId: IDS.threadB })
    expect(threadAction(mounted.root, "Writer", "select-thread").getAttribute("aria-pressed")).toBe("true")

    clickElement(runAction(mounted.root, "Synthesis", "Researcher", "select-run"))
    expect(mounted.selections.at(-1)).toEqual({ kind: "run", runId: IDS.runC })
    expect(runAction(mounted.root, "Synthesis", "Researcher", "select-run").closest("[data-apc-run-card=true]")?.getAttribute("data-selected")).toBe("true")
    expect(mounted.root.querySelector("[data-apc-selection-detail=true]")?.textContent).toContain("Researcher")
    expect(mounted.root.querySelector("[data-apc-selection-detail=true] input")).toBeNull()
    mounted.handle.destroy()
  })

  test("renders bounded run timeouts with localized seconds and no placeholder braces", () => {
    for (const locale of ["en", "fr"] as const) {
      const translator = createApcTranslator(() => locale)
      const mounted = mount(
        configuredSnapshot("parallel", { kind: "run", runId: IDS.runC }),
        { t: translator },
      )
      const expected = translator("validation.timeoutValue", { seconds: 60 })
      const runCard = runAction(mounted.root, "Synthesis", "Researcher", "select-run")
        .closest<HTMLElement>("[data-apc-run-card=true]")
      const detail = mounted.root.querySelector<HTMLElement>("[data-apc-selection-detail=true]")

      expect(runCard?.textContent).toContain(expected)
      expect(detail?.textContent).toContain(expected)
      expect(runCard?.textContent).not.toContain("{")
      expect(detail?.textContent).not.toContain("{")
      mounted.handle.destroy()
    }
  })

  test("resolves mode and safe callback-error placeholders in English and French", () => {
    for (const locale of ["en", "fr"] as const) {
      const translator = createApcTranslator(() => locale)
      const mode = translator("mode.parallel")
      const unsupported = mount({
        ...configuredSnapshot("sequential"),
        modeAvailability: {
          parallel: { supported: false, valid: false },
        },
      }, { t: translator })
      const unsupportedReason = unsupported.root.querySelector<HTMLElement>('[data-mode-reason="parallel"]')?.textContent ?? ""
      expect(unsupportedReason).toContain(translator("mode.unsupported", { mode }))
      expect(unsupportedReason).not.toContain("{")

      const invalid = mount({
        ...configuredSnapshot("sequential"),
        modeAvailability: {
          parallel: { supported: true, valid: false },
        },
      }, { t: translator })
      const invalidReason = invalid.root.querySelector<HTMLElement>('[data-mode-reason="parallel"]')?.textContent ?? ""
      expect(invalidReason).toContain(translator("mode.invalid", { mode }))
      expect(invalidReason).not.toContain("{")

      const announcements: string[] = []
      const callbackError = mount(configuredSnapshot("parallel"), {
        t: translator,
        accessibility: { announce: (message) => announcements.push(message) },
        onSelectionChange: () => {
          throw new Error("private callback detail")
        },
      })
      clickElement(runAction(callbackError.root, "Synthesis", "Researcher", "select-run"))
      const expectedError = translator("a11y.error", { message: translator("status.editorBusyOrBlocked") })
      expect(announcements).toContain(expectedError)
      expect(announcements.join("\n")).not.toContain("{")
      expect(announcements.join("\n")).not.toContain("private callback detail")

      unsupported.handle.destroy()
      invalid.handle.destroy()
      callbackError.handle.destroy()
    }
  })

  test("never exposes raw thread, stage, run, or pipeline identifiers in any rendered DOM", () => {
    const mounted = mount(configuredSnapshot("parallel", { kind: "run", runId: IDS.runC }))
    const renderedDom = mounted.root.outerHTML

    for (const id of Object.values(IDS)) expect(renderedDom).not.toContain(id)
    expect(renderedDom).not.toContain("data-thread-id")
    expect(renderedDom).not.toContain("data-stage-id")
    expect(renderedDom).not.toContain("data-run-id")
    expect(renderedDom).toContain("Researcher")
    expect(renderedDom).toContain("Writer")
    mounted.handle.destroy()
  })

  test("requires inline confirmation and supports no-op, cancel, Escape, and focus restoration", () => {
    const mounted = mount(configuredSnapshot("parallel"))
    const before = structuredClone(mounted.getSnapshot().config)
    const removeRunA = (): HTMLElement => runAction(mounted.root, "Research", "Researcher", "remove-run")

    clickElement(removeRunA())
    expect(mounted.getSnapshot().config).toEqual(before)
    expect(mounted.mutations).toHaveLength(0)
    expect(mounted.root.querySelector('[data-apc-confirmation=true][data-confirmation-kind="run"]')).not.toBeNull()
    expect(mounted.root.querySelector("[data-apc-confirmation=true]")?.textContent).toContain("Affected runs: 1")
    expect(mounted.root.querySelector("[data-apc-confirmation=true]")?.textContent).toContain("Affected bindings: 2")
    expect(mounted.root.querySelector("[data-apc-confirmation=true]")?.textContent).not.toContain(IDS.runA)

    click(mounted.root, '[data-action="cancel-confirmation"]')
    expect(mounted.getSnapshot().config).toEqual(before)
    expect(browser.window.document.activeElement?.getAttribute("data-action")).toBe("remove-run")

    clickElement(removeRunA())
    key(mounted.handle.element, "Escape")
    expect(mounted.root.querySelector("[data-apc-confirmation=true]")).toBeNull()
    expect(mounted.getSnapshot().config).toEqual(before)
    expect(browser.window.document.activeElement?.getAttribute("data-action")).toBe("remove-run")

    clickElement(removeRunA())
    click(mounted.root, '[data-action="confirm-removal"]')
    expect(mounted.getSnapshot().config?.pipelines.parallel?.stages[0].runs.map((run) => run.id)).toEqual([IDS.runB])
    expect(mounted.mutations.at(-1)).toMatchObject({ type: "config", reason: "run-removed" })
    expect(browser.window.document.activeElement?.getAttribute("data-action")).toBe("select-run")
    expect(browser.window.document.activeElement?.getAttribute("data-apc-run-key")).toBe(
      runAction(mounted.root, "Research", "Writer", "select-run").dataset.apcRunKey,
    )

    const stageMounted = mount(configuredSnapshot("parallel"))
    clickElement(stageAction(stageMounted.root, "Research", "remove-stage"))
    expect(stageMounted.mutations).toHaveLength(0)
    expect(stageMounted.root.querySelector('[data-confirmation-kind="stage"]')).not.toBeNull()

    const removableConfig = baseConfig("parallel")
    removableConfig.pipelines.sequential!.finalResponse = { source: "main", inputs: [] }
    removableConfig.pipelines.parallel!.finalResponse = { source: "main", inputs: [] }
    const removableThreadId = generatedId(900)
    removableConfig.threads.push({
      ...structuredClone(removableConfig.threads[1]),
      id: removableThreadId,
      name: "Unused reviewer",
    })
    const threadMounted = mount({ ...configuredSnapshot("parallel"), config: removableConfig })
    const removeUnusedThread = threadAction(threadMounted.root, "Unused reviewer", "remove-thread") as HTMLButtonElement
    expect(removeUnusedThread.disabled).toBe(false)
    expect(removeUnusedThread.dataset.apcThreadKey).toMatch(/^thread-\d+$/)
    expect(removeUnusedThread.dataset.apcThreadKey).not.toBe(removableThreadId)
    clickElement(removeUnusedThread)
    expect(threadMounted.mutations).toHaveLength(0)
    expect(threadMounted.root.querySelector('[data-confirmation-kind="thread"]')).not.toBeNull()

    const mutationDismissed = mount(configuredSnapshot("parallel"))
    clickElement(runAction(mutationDismissed.root, "Research", "Researcher", "remove-run"))
    click(mutationDismissed.root, '[data-action="final-main"]')
    expect(mutationDismissed.root.querySelector("[data-apc-confirmation=true]")).toBeNull()
    expect(browser.window.document.activeElement?.getAttribute("data-action")).toBe("select-run")

    const lockDismissed = mount(configuredSnapshot("parallel"))
    const lockedRunKey = runAction(lockDismissed.root, "Research", "Researcher", "remove-run").dataset.apcRunKey
    clickElement(runAction(lockDismissed.root, "Research", "Researcher", "remove-run"))
    lockDismissed.handle.render({ ...configuredSnapshot("parallel"), busy: true })
    expect(lockDismissed.root.querySelector("[data-apc-confirmation=true]")).toBeNull()
    expect(browser.window.document.activeElement?.getAttribute("data-action")).toBe("select-run")
    expect(browser.window.document.activeElement?.getAttribute("data-apc-run-key")).toBe(lockedRunKey)

    const draftConfig = baseConfig("parallel")
    const draftSnapshot = { ...configuredSnapshot("parallel"), config: draftConfig }
    const draftDismissed = mount(draftSnapshot)
    clickElement(runAction(draftDismissed.root, "Research", "Researcher", "remove-run"))
    draftConfig.pipelines.parallel!.stages[0]!.name = "Externally changed"
    draftDismissed.handle.render(draftSnapshot)
    expect(draftDismissed.root.querySelector("[data-apc-confirmation=true]")).toBeNull()

    mounted.handle.destroy()
    stageMounted.handle.destroy()
    threadMounted.handle.destroy()
    mutationDismissed.handle.destroy()
    lockDismissed.handle.destroy()
    draftDismissed.handle.destroy()
  })

  test("locks mutations for execution, saving, and stale state while preserving graph navigation", () => {
    const selections: ApcSelection[] = []
    const executing = configuredSnapshot("parallel")
    const mounted = mount(
      { ...executing, blockedReasons: [{ key: "execution.running" }] },
      { onSelectionChange: (selection) => { selections.push(selection) } },
    )

    expect(mounted.root.querySelector('[data-lock-state="execution"]')).not.toBeNull()
    expect(mounted.root.querySelector<HTMLButtonElement>('[data-action="add-stage"]')?.disabled).toBe(true)
    clickElement(runAction(mounted.root, "Synthesis", "Researcher", "select-run"))
    expect(selections.at(-1)).toEqual({ kind: "run", runId: IDS.runC })
    expect(mounted.mutations).toHaveLength(0)
    const focusedRun = runAction(mounted.root, "Synthesis", "Researcher", "select-run")
    const focusedRunKey = focusedRun.dataset.apcRunKey
    focusedRun.focus()

    mounted.handle.render({ ...executing, busy: true })
    expect(mounted.root.querySelector('[data-lock-state="saving"]')).not.toBeNull()
    expect(mounted.root.querySelector<HTMLButtonElement>('[data-action="add-stage"]')?.disabled).toBe(true)
    expect(browser.window.document.activeElement?.getAttribute("data-action")).toBe("select-run")
    expect(browser.window.document.activeElement?.getAttribute("data-apc-run-key")).toBe(focusedRunKey)
    mounted.handle.render({
      ...executing,
      saveError: { code: "SAVE_FAILED", message: { key: "error.staleConfigReload" }, reloadRequired: false },
    })
    expect(browser.window.document.activeElement?.getAttribute("data-action")).toBe("select-run")
    expect(browser.window.document.activeElement?.getAttribute("data-apc-run-key")).toBe(focusedRunKey)

    const mutationFocused = mount(configuredSnapshot("parallel"))
    mutationFocused.root.querySelector<HTMLElement>('[data-action="add-stage"]')?.focus()
    mutationFocused.handle.render({ ...configuredSnapshot("parallel"), busy: true })
    expect(browser.window.document.activeElement?.getAttribute("data-apc-editor-status")).toBe("true")
    expect(browser.window.document.activeElement?.getAttribute("data-lock-state")).toBe("saving")
    mutationFocused.handle.render({
      ...configuredSnapshot("parallel"),
      saveError: { code: "SAVE_FAILED", message: { key: "error.staleConfigReload" }, reloadRequired: false },
    })
    expect(browser.window.document.activeElement?.getAttribute("data-apc-editor-status")).toBe("true")

    mounted.handle.render({ ...executing, stale: true })
    expect(mounted.root.querySelector('[data-lock-state="stale"]')).not.toBeNull()
    expect(mounted.root.querySelector<HTMLButtonElement>('[data-action="add-stage"]')?.disabled).toBe(true)
    let staleModeCalls = 0
    const staleFirstUse = mount(
      { ...firstUseSnapshot(), stale: true },
      { onModeChange: () => { staleModeCalls += 1 } },
    )
    click(staleFirstUse.root, '[data-action="create-graph"][data-mode="parallel"]')
    expect(staleModeCalls).toBe(0)
    expect(staleFirstUse.mutations).toHaveLength(0)
    staleFirstUse.handle.destroy()
    mounted.handle.destroy()
    mutationFocused.handle.destroy()
  })

  test("uses an enabled mode as the roving tab stop when the active mode is blocked", () => {
    const mounted = mount({
      ...configuredSnapshot("parallel"),
      modeAvailability: {
        parallel: { supported: true, valid: false, disabledReason: { key: "validation.invalid" } },
      },
    })

    expect(mounted.root.querySelector<HTMLElement>('[data-mode="parallel"]')?.tabIndex).toBe(-1)
    expect(mounted.root.querySelector<HTMLElement>('[data-mode="single"]')?.tabIndex).toBe(0)
    mounted.handle.destroy()
  })

  test("preserves local mutation focus when config persistence is asynchronous", () => {
    const mounted = mount(configuredSnapshot("parallel"), {}, false)
    const addStage = mounted.root.querySelector<HTMLElement>('[data-action="add-stage"]')
    addStage?.focus()
    click(mounted.root, '[data-action="add-stage"]')

    expect(mounted.mutations.at(-1)).toMatchObject({ type: "config", reason: "stage-added" })
    const mutation = mounted.mutations.at(-1)
    if (mutation?.type !== "config") throw new Error("stage mutation missing")
    const pipeline = mutation.config.pipelines.parallel
    const addedRun = pipeline?.stages.at(-1)?.runs[0]
    expect(addedRun?.inputs).toEqual([{
      source: "output",
      runId: IDS.runC,
      role: "user",
      onMissing: "fail-graph",
    }])
    expect(pipeline?.finalResponse).toEqual({ source: "thread", runId: addedRun?.id })
    expect(validateConfigForMode(mutation.config, "parallel").valid).toBe(true)
    expect(browser.window.document.activeElement?.getAttribute("data-action")).toBe("add-stage")
    mounted.handle.destroy()
  })

  test("extends a Main-routed graph without orphaning the existing topology", () => {
    const config = baseConfig("sequential")
    const pipeline = config.pipelines.sequential
    if (!pipeline) throw new Error("sequential pipeline missing")
    pipeline.stages[1]!.name = "Stage 3"
    pipeline.finalResponse = {
      source: "main",
      inputs: [{ source: "output", runId: IDS.runB, onMissing: "fail-graph" }],
    }
    const mounted = mount({ ...configuredSnapshot("sequential"), config })
    click(mounted.root, '[data-action="add-stage"]')

    const mutation = mounted.mutations.at(-1)
    if (mutation?.type !== "config") throw new Error("stage mutation missing")
    const updated = mutation.config.pipelines.sequential
    const addedRun = updated?.stages.at(-1)?.runs[0]
    expect(updated?.stages.at(-1)?.name).toBe("Stage 4")
    expect(addedRun?.inputs).toEqual([{
      source: "output",
      runId: IDS.runB,
      role: "user",
      onMissing: "fail-graph",
    }])
    expect(updated?.finalResponse).toEqual({
      source: "main",
      inputs: [{ source: "output", runId: addedRun?.id, onMissing: "fail-graph" }],
    })
    expect(validateConfigForMode(mutation.config, "sequential").valid).toBe(true)
    mounted.handle.destroy()
  })

  test("clears and emits a run selection that is not present in the newly active pipeline", () => {
    const mounted = mount(configuredSnapshot("parallel", { kind: "run", runId: IDS.runC }))
    clickElement(runAction(mounted.root, "Research", "Researcher", "remove-run"))
    expect(mounted.root.querySelector("[data-apc-confirmation=true]")).not.toBeNull()
    click(mounted.root, '[data-action="select-mode"][data-mode="sequential"]')

    expect(mounted.getSnapshot().selection).toBeNull()
    expect(mounted.selections.at(-1)).toBeNull()
    expect(mounted.root.querySelector("[data-apc-selection-detail=true]")?.textContent).not.toContain("Selected run")
    expect(browser.window.document.activeElement?.getAttribute("data-mode")).toBe("sequential")
    mounted.handle.destroy()
  })

  test("protects final-route dependencies and designates the explicitly selected run", () => {
    const blocked = mount(configuredSnapshot("parallel"))
    expect((runAction(blocked.root, "Synthesis", "Researcher", "remove-run") as HTMLButtonElement).disabled).toBe(true)
    expect((stageAction(blocked.root, "Synthesis", "remove-stage") as HTMLButtonElement).disabled).toBe(true)
    expect((threadAction(blocked.root, "Researcher", "remove-thread") as HTMLButtonElement).disabled).toBe(true)
    click(blocked.root, '[data-action="final-main"]')
    expect(blocked.getSnapshot().config?.pipelines.parallel?.finalResponse).toEqual({
      source: "main",
      inputs: [{ source: "output", runId: IDS.runC, onMissing: "fail-graph" }],
    })
    const mainRoutedConfig = blocked.getSnapshot().config
    expect(mainRoutedConfig ? validateConfigForMode(mainRoutedConfig, "parallel").valid : false).toBe(true)
    expect((stageAction(blocked.root, "Synthesis", "remove-stage") as HTMLButtonElement).disabled).toBe(true)
    expect(blocked.root.outerHTML).not.toContain(IDS.runC)
    expect(blocked.root.querySelector<HTMLButtonElement>('[data-action="final-thread"]')?.disabled).toBe(false)
    click(blocked.root, '[data-action="final-thread"]')
    expect(blocked.getSnapshot().config?.pipelines.parallel?.finalResponse).toEqual({
      source: "thread",
      runId: IDS.runC,
    })
    const threadRoutedConfig = blocked.getSnapshot().config
    expect(threadRoutedConfig ? validateConfigForMode(threadRoutedConfig, "parallel").valid : false).toBe(true)

    const staleConfig = baseConfig("parallel")
    staleConfig.pipelines.parallel!.finalResponse = {
      source: "main",
      inputs: [{ source: "output", runId: IDS.runC, onMissing: "fail-graph" }],
    }
    const staleInverse = mount({
      ...configuredSnapshot("parallel", { kind: "run", runId: generatedId(901) }),
      config: staleConfig,
    })
    expect(staleInverse.root.querySelector<HTMLButtonElement>('[data-action="final-thread"]')?.disabled).toBe(false)
    click(staleInverse.root, '[data-action="final-thread"]')
    expect(staleInverse.getSnapshot().config?.pipelines.parallel?.finalResponse).toEqual({
      source: "thread",
      runId: IDS.runC,
    })

    const existing = mount(configuredSnapshot("parallel"))
    expect(existing.root.querySelector<HTMLButtonElement>('[data-action="final-thread"]')?.disabled).toBe(false)
    expect(existing.root.querySelector("[data-apc-final-route=true]")?.textContent).not.toContain("Select a run")

    const config = baseConfig("parallel")
    config.pipelines.parallel!.finalResponse = { source: "main", inputs: [] }
    const selected = mount({ ...configuredSnapshot("parallel"), config })
    expect(selected.root.querySelector<HTMLButtonElement>('[data-action="final-thread"]')?.disabled).toBe(true)
    clickElement(runAction(selected.root, "Research", "Researcher", "select-run"))
    expect(selected.root.querySelector<HTMLButtonElement>('[data-action="final-thread"]')?.disabled).toBe(false)
    click(selected.root, '[data-action="final-thread"]')
    expect(selected.getSnapshot().config?.pipelines.parallel?.finalResponse).toEqual({ source: "thread", runId: IDS.runA })

    blocked.handle.destroy()
    selected.handle.destroy()
    staleInverse.handle.destroy()
    existing.handle.destroy()
  })

  test("changes only finalResponse when selecting a final route", () => {
    const config = baseConfig("parallel")
    const pipeline = config.pipelines.parallel
    if (!pipeline) throw new Error("parallel pipeline missing")
    pipeline.finalResponse = { source: "thread", runId: IDS.runA }
    const beforeStages = structuredClone(pipeline.stages)
    const mounted = mount({
      ...configuredSnapshot("parallel", { kind: "run", runId: IDS.runA }),
      config,
    })

    click(mounted.root, '[data-action="final-main"]')

    expect(mounted.getSnapshot().config?.pipelines.parallel?.finalResponse).toEqual({
      source: "main",
      inputs: [{ source: "output", runId: IDS.runA, onMissing: "fail-graph" }],
    })
    expect(mounted.getSnapshot().config?.pipelines.parallel?.stages).toEqual(beforeStages)
    mounted.handle.destroy()
  })

  test("rejects optional selected runs for both final routes and preserves a repairable graph", () => {
    const config = baseConfig("parallel")
    const announcements: string[] = []
    const mounted = mount(
      { ...configuredSnapshot("parallel", { kind: "run", runId: IDS.runB }), config },
      { accessibility: { announce: (message) => announcements.push(message) } },
    )
    const before = structuredClone(mounted.getSnapshot().config)

    expect(validateConfigForMode(config, "parallel").valid).toBe(true)
    const finalThread = mounted.root.querySelector<HTMLButtonElement>('[data-action="final-thread"]')
    const finalMain = mounted.root.querySelector<HTMLButtonElement>('[data-action="final-main"]')
    expect(finalThread?.disabled).toBe(true)
    expect(finalMain?.disabled).toBe(true)
    if (finalThread && finalMain) {
      finalThread.disabled = false
      finalMain.disabled = false
      clickElement(finalThread)
      clickElement(finalMain)
    }

    expect(mounted.mutations).toHaveLength(0)
    expect(mounted.getSnapshot().config).toEqual(before)
    expect(announcements.filter((message) => message === t("validation.required"))).toHaveLength(2)
    const afterOptional = mounted.getSnapshot().config
    expect(afterOptional ? validateConfigForMode(afterOptional, "parallel").valid : false).toBe(true)
    clickElement(runAction(mounted.root, "Synthesis", "Researcher", "select-run"))
    expect(mounted.root.querySelector<HTMLButtonElement>('[data-action="final-main"]')?.disabled).toBe(false)
    click(mounted.root, '[data-action="final-main"]')
    expect(mounted.getSnapshot().config?.pipelines.parallel?.finalResponse).toEqual({
      source: "main",
      inputs: [{ source: "output", runId: IDS.runC, onMissing: "fail-graph" }],
    })
    const repairedConfig = mounted.getSnapshot().config
    expect(repairedConfig ? validateConfigForMode(repairedConfig, "parallel").valid : false).toBe(true)
    mounted.handle.destroy()
  })

  test("blocks removing the only run-owning thread from any stored pipeline", () => {
    const config = baseConfig("parallel")
    config.pipelines.parallel!.stages = [{
      ...config.pipelines.parallel!.stages[0],
      runs: [config.pipelines.parallel!.stages[0].runs[0]],
    }]
    config.pipelines.parallel!.finalResponse = { source: "main", inputs: [] }
    const mounted = mount({ ...configuredSnapshot("parallel"), config })
    const remove = threadAction(mounted.root, "Researcher", "remove-thread") as HTMLButtonElement

    expect(remove?.disabled).toBe(true)
    expect(remove?.closest("li")?.textContent).toContain("Add another run")
    clickElement(remove)
    expect(mounted.root.querySelector("[data-apc-confirmation=true]")).toBeNull()
    expect(mounted.mutations).toHaveLength(0)
    mounted.handle.destroy()
  })

  test("preserves configured Main bindings and honors authoritative thread-final availability", () => {
    const config = baseConfig("parallel")
    config.pipelines.parallel!.finalResponse = {
      source: "main",
      inputs: [
        { source: "output", runId: IDS.runA, onMissing: "omit-binding" },
        { source: "output", runId: IDS.runC, onMissing: "omit-binding" },
      ],
    }
    const bound = mount({ ...configuredSnapshot("parallel", { kind: "run", runId: IDS.runA }), config })
    click(bound.root, '[data-action="final-main"]')
    expect(bound.mutations).toHaveLength(0)
    expect(bound.getSnapshot().config?.pipelines.parallel?.finalResponse).toEqual(config.pipelines.parallel!.finalResponse)
    expect(bound.root.querySelector<HTMLButtonElement>('[data-action="final-thread"]')?.disabled).toBe(false)
    expect(bound.root.textContent).not.toContain("Remove 2 configured final binding")
    click(bound.root, '[data-action="final-thread"]')
    expect(bound.getSnapshot().config?.pipelines.parallel?.finalResponse).toEqual({
      source: "thread",
      runId: IDS.runA,
    })
    const switched = bound.getSnapshot().config
    expect(switched?.pipelines.parallel?.stages).toEqual(config.pipelines.parallel?.stages)

    const unavailable = mount({
      ...configuredSnapshot("parallel", { kind: "run", runId: IDS.runA }),
      finalResponseAvailable: false,
      finalResponseBlockedReason: { key: "permission.required" },
    })
    expect(unavailable.root.querySelector<HTMLButtonElement>('[data-action="final-thread"]')?.disabled).toBe(true)
    expect(unavailable.root.textContent).toContain(t("permission.required"))
    bound.handle.destroy()
    unavailable.handle.destroy()
  })

  test("disables add controls at canonical thread, stage, and run caps", () => {
    const threadConfig = baseConfig("parallel")
    const templateThread = threadConfig.threads[0]
    threadConfig.threads = Array.from({ length: MAX_THREADS }, (_, index) => ({
      ...structuredClone(templateThread),
      id: generatedId(100 + index),
      name: `Thread ${index + 1}`,
    }))
    const threadCap = mount({ ...configuredSnapshot("parallel"), config: threadConfig })
    expect(threadCap.root.querySelector<HTMLButtonElement>('[data-action="add-thread"]')?.disabled).toBe(true)

    const stageConfig = baseConfig("sequential")
    stageConfig.pipelines.sequential!.stages = Array.from({ length: MAX_STAGES_PER_PIPELINE }, (_, index) => ({
      id: generatedId(200 + index),
      name: `Stage ${index + 1}`,
      runs: [{
        id: generatedId(300 + index),
        threadId: IDS.threadA,
        required: true,
        timeoutMs: 1_000,
        inputs: [],
      }],
    }))
    stageConfig.pipelines.sequential!.finalResponse = { source: "thread", runId: generatedId(300) }
    const stageCap = mount({ ...configuredSnapshot("sequential"), config: stageConfig })
    expect(stageCap.root.querySelector<HTMLButtonElement>('[data-action="add-stage"]')?.disabled).toBe(true)
    expect(stageCap.root.querySelector('[data-action="add-stage"]')?.textContent).toBe(t("action.addStage"))

    const runConfig = baseConfig("parallel")
    runConfig.threads.push({
      ...structuredClone(runConfig.threads[0]),
      id: generatedId(499),
      name: "Third thread",
    })
    runConfig.pipelines.parallel!.stages = Array.from({ length: MAX_RUNS_PER_PIPELINE / 2 }, (_, index) => ({
      id: generatedId(500 + index),
      name: `Stage ${index + 1}`,
      runs: [
        { id: generatedId(600 + index * 2), threadId: IDS.threadA, required: true, timeoutMs: 1_000, inputs: [] },
        { id: generatedId(601 + index * 2), threadId: IDS.threadB, required: true, timeoutMs: 1_000, inputs: [] },
      ],
    }))
    runConfig.pipelines.parallel!.finalResponse = { source: "thread", runId: generatedId(600) }
    const runCap = mount({ ...configuredSnapshot("parallel"), config: runConfig })
    expect(runCap.root.querySelector<HTMLButtonElement>('[data-action="add-run"]')?.disabled).toBe(true)

    threadCap.handle.destroy()
    stageCap.handle.destroy()
    runCap.handle.destroy()
  })

  test("supports keyboard selection and ordered-stage reorder announcements", () => {
    const announcements: string[] = []
    const config = baseConfig("sequential")
    config.pipelines.sequential!.stages[1].runs[0].inputs = []
    const mounted = mount(
      { ...configuredSnapshot("sequential"), config },
      { accessibility: { announce: (message) => announcements.push(message) } },
    )
    const firstRun = runAction(mounted.root, "Research", "Researcher", "select-run")
    expect(firstRun).not.toBeNull()

    if (firstRun) {
      key(firstRun, "Enter")
      expect(mounted.selections.at(-1)).toEqual({ kind: "run", runId: IDS.runA })
      const currentFirstRun = runAction(mounted.root, "Research", "Researcher", "select-run")
      key(currentFirstRun, "ArrowDown", true)
    }

    expect(mounted.getSnapshot().config?.pipelines.sequential?.stages.map((stage) => stage.name)).toEqual(["Writing", "Research"])
    expect(announcements.some((message) => message.includes(t("a11y.directionDown")))).toBe(true)
    mounted.handle.destroy()
  })

  test("mounts one coherent mode toolbar in an external host and cleans up only its contribution", () => {
    const toolbarHost = browser.window.document.createElement("div")
    const sentinel = browser.window.document.createElement("span")
    sentinel.textContent = "Host-owned"
    toolbarHost.append(sentinel)
    browser.window.document.body.append(toolbarHost)
    let locale = "en"
    const localized = ((key: Parameters<typeof t>[0], values?: Parameters<typeof t>[1]) =>
      `${locale}:${t(key, values)}`) as typeof t
    const mounted = mount(configuredSnapshot("sequential"), { toolbarHost, t: localized })

    expect(toolbarHost.querySelectorAll("[data-apc-graph-toolbar-owned=true]")).toHaveLength(1)
    expect(toolbarHost.querySelectorAll('[role="radiogroup"]')).toHaveLength(1)
    expect(mounted.root.querySelector("[data-apc-mode-toolbar=true]")).toBeNull()
    expect(mounted.root.querySelector('[role="radiogroup"]')).toBeNull()

    click(toolbarHost, '[data-action="select-mode"][data-mode="parallel"]')
    expect(mounted.getSnapshot().config?.activeMode).toBe("parallel")
    expect(browser.window.document.activeElement?.getAttribute("data-mode")).toBe("parallel")

    locale = "fr"
    mounted.handle.render({ ...mounted.getSnapshot(), locale: "fr", busy: true })
    expect(toolbarHost.textContent).toContain(`fr:${t("mode.parallel")}`)
    expect(toolbarHost.querySelector<HTMLButtonElement>('[data-mode="parallel"]')?.disabled).toBe(true)
    expect(browser.window.document.activeElement?.getAttribute("data-apc-editor-status")).toBe("true")

    mounted.handle.destroy()
    expect(toolbarHost.querySelector("[data-apc-graph-toolbar-owned=true]")).toBeNull()
    expect(toolbarHost.contains(sentinel)).toBe(true)
  })

  test("switches valid modes without recreating or deleting either pipeline", () => {
    const modes: ApcMode[] = []
    const mounted = mount(configuredSnapshot("sequential", { kind: "thread", threadId: IDS.threadA }), {
      onModeChange: (mode) => { modes.push(mode) },
    })
    const before = structuredClone(mounted.getSnapshot().config?.pipelines)

    click(mounted.root, '[data-action="select-mode"][data-mode="parallel"]')

    expect(mounted.getSnapshot().config?.activeMode).toBe("parallel")
    expect(mounted.getSnapshot().config?.pipelines).toEqual(before)
    expect(mounted.getSnapshot().selection).toEqual({ kind: "thread", threadId: IDS.threadA })
    expect(modes).toEqual(["parallel"])
    expect(mounted.mutations.at(-1)).toEqual({ type: "mode", mode: "parallel" })
    mounted.handle.destroy()
  })

  test("renders sequential stages in configured order and blocks reference-breaking reorders", () => {
    const announcements: string[] = []
    const mounted = mount(configuredSnapshot("sequential"), {
      accessibility: { announce: (message) => announcements.push(message) },
    })
    const stages = [...mounted.root.querySelectorAll<HTMLElement>("[data-apc-stage=true]")]

    expect(stages.map((stage) => stage.dataset.stagePosition)).toEqual(["1", "2"])
    expect(stages[0].textContent).toContain("Researcher")
    expect(stages[1].textContent).toContain("Writer")
    expect(stages[1].textContent).toContain("Researcher")

    const firstRun = runAction(mounted.root, "Research", "Researcher", "select-run")
    key(firstRun, "ArrowDown", true)
    expect(mounted.getSnapshot().config?.pipelines.sequential?.stages.map((stage) => stage.name)).toEqual(["Research", "Writing"])
    expect(announcements.some((message) => message.includes("earlier-stage"))).toBe(true)
    mounted.handle.destroy()
  })
  test("renders visible THEN cues in sequential stage order", () => {
    const mounted = mount(configuredSnapshot("sequential"), { surface: "topology" })
    const chain = mounted.root.querySelector<HTMLElement>("[data-apc-causal-chain=true]")
    if (!chain) throw new Error("sequential causal chain missing")
    const connectors = [...chain.querySelectorAll<HTMLElement>("[data-apc-sequential-connector=true]")]

    expect(connectors).toHaveLength(1)
    expect(connectors[0]?.textContent).toBe("THEN")
    expect(connectors[0]?.getAttribute("aria-label")).toBe("THEN")
    expect(chain.children[0]?.getAttribute("data-stage-position")).toBe("1")
    expect(chain.children[1]).toBe(connectors[0])
    expect(chain.children[2]?.getAttribute("data-stage-position")).toBe("2")
    mounted.handle.destroy()
  })

  test("creates, trims, validates, and caps connection slots through the rendered controls", () => {
    const mounted = mount(configuredSnapshot("parallel"))
    const section = mounted.root.querySelector<HTMLElement>("[data-apc-connection-slots=true]")
    expect(section).not.toBeNull()
    expect(section?.textContent).toContain("No connection slots configured.")

    click(mounted.root, '[data-action="add-connection-slot"]')

    const created = mounted.getSnapshot().config?.connectionSlots[0]
    expect(created?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
    expect(created?.label).toBe("Connection slot 1")
    expect(created ? validateConfigForMode(mounted.getSnapshot().config!, "parallel").valid : false).toBe(true)
    expect(mounted.root.outerHTML).not.toContain(created?.id ?? "")
    const firstId = created?.id
    click(mounted.root, '[data-action="remove-connection-slot"]')
    click(mounted.root, '[data-action="confirm-removal"]')
    expect(mounted.getSnapshot().config?.connectionSlots).toHaveLength(0)
    click(mounted.root, '[data-action="add-connection-slot"]')
    const replacement = mounted.getSnapshot().config?.connectionSlots[0]
    expect(replacement?.id).toBeDefined()
    expect(replacement?.id).not.toBe(firstId)

    const input = mounted.root.querySelector<HTMLInputElement>("[data-apc-connection-slot-label=true]")
    expect(input?.maxLength).toBe(MAX_NAME_CHARS * 2)
    if (!input) throw new Error("Connection slot label input was not rendered")
    input.value = "  Primary research  "
    input.dispatchEvent(new browser.window.Event("change", { bubbles: true }))
    expect(mounted.getSnapshot().config?.connectionSlots[0]?.label).toBe("Primary research")

    input.value = "x".repeat(MAX_NAME_CHARS + 1)
    input.dispatchEvent(new browser.window.Event("change", { bubbles: true }))
    expect(mounted.getSnapshot().config?.connectionSlots[0]?.label).toBe("Primary research")


    for (let index = 1; index < MAX_CONNECTION_SLOTS; index += 1) {
      click(mounted.root, '[data-action="add-connection-slot"]')
    }
    expect(mounted.getSnapshot().config?.connectionSlots).toHaveLength(MAX_CONNECTION_SLOTS)
    expect((mounted.root.querySelector('[data-action="add-connection-slot"]') as HTMLButtonElement).disabled).toBe(true)
    mounted.handle.destroy()
  })

  test("delivers specialized slot callbacks and generic observers exactly once", () => {
    let configChanges = 0
    let mutations = 0
    let added = 0
    let renamed = 0
    let removed = 0
    const mounted = mount(configuredSnapshot("parallel"), {
      onConfigChange: () => { configChanges += 1 },
      onMutation: () => { mutations += 1 },
      onAddConnectionSlot: () => { added += 1 },
      onRenameConnectionSlot: () => { renamed += 1 },
      onRemoveConnectionSlot: () => { removed += 1 },
    })

    click(mounted.root, '[data-action="add-connection-slot"]')
    expect({ configChanges, mutations, added, renamed, removed }).toEqual({
      configChanges: 1,
      mutations: 1,
      added: 1,
      renamed: 0,
      removed: 0,
    })
    const input = mounted.root.querySelector<HTMLInputElement>("[data-apc-connection-slot-label=true]")
    if (!input) throw new Error("connection slot input missing")
    input.value = "Primary"
    input.dispatchEvent(new browser.window.Event("change", { bubbles: true }))
    expect({ configChanges, mutations, added, renamed, removed }).toEqual({
      configChanges: 2,
      mutations: 2,
      added: 1,
      renamed: 1,
      removed: 0,
    })
    click(mounted.root, '[data-action="remove-connection-slot"]')
    click(mounted.root, '[data-action="confirm-removal"]')
    expect({ configChanges, mutations, added, renamed, removed }).toEqual({
      configChanges: 3,
      mutations: 3,
      added: 1,
      renamed: 1,
      removed: 1,
    })
    mounted.handle.destroy()
  })

  test("rolls back a rejected specialized slot mutation without generic bookkeeping", async () => {
    const config = baseConfig("parallel")
    const slotId = generatedId(982)
    config.connectionSlots = [{ id: slotId, label: "Primary" }]
    const before = structuredClone(config)
    const mounted = mount({ ...configuredSnapshot("parallel"), config }, {
      onRemoveConnectionSlot: () => Promise.reject(new Error("private removal failure")),
    })

    click(mounted.root, '[data-action="remove-connection-slot"]')
    click(mounted.root, '[data-action="confirm-removal"]')
    await Promise.resolve()
    await Promise.resolve()

    expect(mounted.getSnapshot().config).toEqual(before)
    expect(mounted.mutations).toHaveLength(0)
    expect(mounted.root.querySelector<HTMLInputElement>("[data-apc-connection-slot-label=true]")?.value)
      .toBe("Primary")
    mounted.handle.destroy()
  })

  test("rolls back a rejected slot mutation after an optimistic cloned render", async () => {
    const config = baseConfig("parallel")
    const slotId = generatedId(983)
    config.connectionSlots = [{ id: slotId, label: "Primary" }]
    const before = structuredClone(config)
    let mounted: Mounted
    mounted = mount({ ...configuredSnapshot("parallel"), config }, {
      onRemoveConnectionSlot: () => {
        const echoed = structuredClone(before)
        echoed.connectionSlots = []
        mounted.handle.render({
          ...mounted.getSnapshot(),
          config: echoed,
          activeMode: "parallel",
        })
        return Promise.reject(new Error("private removal failure"))
      },
    })

    click(mounted.root, '[data-action="remove-connection-slot"]')
    click(mounted.root, '[data-action="confirm-removal"]')
    await Promise.resolve()
    await Promise.resolve()

    expect(mounted.getSnapshot().config).toEqual(before)
    expect(mounted.mutations).toHaveLength(0)
    expect(mounted.root.querySelector<HTMLInputElement>("[data-apc-connection-slot-label=true]")?.value)
      .toBe("Primary")
    expect((mounted.root.querySelector('[data-action="remove-connection-slot"]') as HTMLButtonElement).disabled)
      .toBe(false)
    mounted.handle.destroy()
  })

  test("preserves newer authoritative state when a pending slot mutation rejects", async () => {
    const config = baseConfig("parallel")
    const slotId = generatedId(985)
    config.connectionSlots = [{ id: slotId, label: "Primary" }]
    let rejectRemoval: ((reason: Error) => void) | undefined
    const removal = new Promise<void>((_resolve, reject) => {
      rejectRemoval = reject
    })
    const mounted = mount({ ...configuredSnapshot("parallel"), config }, {
      onRemoveConnectionSlot: () => removal,
    })

    click(mounted.root, '[data-action="remove-connection-slot"]')
    click(mounted.root, '[data-action="confirm-removal"]')
    expect(mounted.root.querySelector("[data-apc-connection-slot=true]")).toBeNull()

    const authoritativeConfig = structuredClone(config)
    authoritativeConfig.connectionSlots = []
    mounted.handle.render({
      ...configuredSnapshot("parallel"),
      config: authoritativeConfig,
      dirty: false,
    })
    rejectRemoval?.(new Error("stale removal rejected"))
    await Promise.resolve()
    await Promise.resolve()

    expect(mounted.root.querySelector("[data-apc-connection-slot=true]")).toBeNull()
    expect(mounted.mutations).toHaveLength(0)
    mounted.handle.destroy()
  })

  test("preserves newer authoritative state when a slot callback renders then throws", () => {
    const config = baseConfig("parallel")
    const slotId = generatedId(986)
    config.connectionSlots = [{ id: slotId, label: "Primary" }]
    let mounted: Mounted
    mounted = mount({ ...configuredSnapshot("parallel"), config }, {
      onRemoveConnectionSlot: () => {
        const authoritativeConfig = structuredClone(config)
        authoritativeConfig.connectionSlots = []
        mounted.handle.render({
          ...configuredSnapshot("parallel"),
          config: authoritativeConfig,
          dirty: false,
        })
        throw new Error("stale removal failed synchronously")
      },
    })

    click(mounted.root, '[data-action="remove-connection-slot"]')
    click(mounted.root, '[data-action="confirm-removal"]')

    expect(mounted.root.querySelector("[data-apc-connection-slot=true]")).toBeNull()
    expect(mounted.mutations).toHaveLength(0)
    mounted.handle.destroy()
  })

  test("does not publish stale slot config after a newer synchronous render succeeds", () => {
    const config = baseConfig("parallel")
    const slotId = generatedId(987)
    config.connectionSlots = [{ id: slotId, label: "Primary" }]
    let mounted: Mounted
    mounted = mount({ ...configuredSnapshot("parallel"), config }, {
      onRemoveConnectionSlot: () => {
        const authoritativeConfig = structuredClone(config)
        authoritativeConfig.connectionSlots = [{ id: generatedId(988), label: "Concurrent" }]
        mounted.handle.render({
          ...configuredSnapshot("parallel"),
          config: authoritativeConfig,
          dirty: false,
        })
      },
    })

    click(mounted.root, '[data-action="remove-connection-slot"]')
    click(mounted.root, '[data-action="confirm-removal"]')

    expect(mounted.root.querySelector<HTMLInputElement>("[data-apc-connection-slot-label=true]")?.value)
      .toBe("Concurrent")
    expect(mounted.mutations).toHaveLength(0)
    mounted.handle.destroy()
  })

  test("does not reuse imported graph identifiers removed by a later render", () => {
    const imported = baseConfig("parallel")
    imported.connectionSlots = [{ id: generatedId(1), label: "Imported" }]
    const mounted = mount(configuredSnapshot("parallel"), {
      idFactory: () => generatedId(0),
    })

    mounted.handle.render({ ...configuredSnapshot("parallel"), config: imported })
    mounted.handle.render(configuredSnapshot("parallel"))
    click(mounted.root, '[data-action="add-connection-slot"]')

    expect(mounted.getSnapshot().config?.connectionSlots[0]?.id).toBe(generatedId(2))
    mounted.handle.destroy()
  })

  test("unlocks controls after a specialized callback renders before success bookkeeping", () => {
    const config = baseConfig("parallel")
    const slotId = generatedId(984)
    config.connectionSlots = [{ id: slotId, label: "Primary" }]
    let mounted: Mounted
    mounted = mount({ ...configuredSnapshot("parallel"), config }, {
      onRenameConnectionSlot: () => {
        const echoed = structuredClone(config)
        echoed.connectionSlots[0]!.label = "Updated"
        mounted.handle.render({
          ...mounted.getSnapshot(),
          config: echoed,
          activeMode: "parallel",
        })
      },
    }, false)
    const input = mounted.root.querySelector<HTMLInputElement>("[data-apc-connection-slot-label=true]")!
    input.value = "Updated"
    input.dispatchEvent(new browser.window.Event("change", { bubbles: true }))

    const currentInput = mounted.root.querySelector<HTMLInputElement>("[data-apc-connection-slot-label=true]")
    expect(currentInput?.disabled).toBe(false)
    expect(currentInput?.value).toBe("Updated")
    mounted.handle.destroy()
  })

  test("gives repeated graph controls contextual labels and parallel stages list semantics", () => {
    for (const mode of ["sequential", "parallel"] as const) {
      const config = baseConfig(mode)
      if (mode === "parallel") {
        config.connectionSlots = [
          { id: generatedId(980), label: "Primary" },
          { id: generatedId(981), label: "Backup" },
        ]
      }
      const mounted = mount({ ...configuredSnapshot(mode), config })
      const stages = mounted.root.querySelector<HTMLElement>(".apc-topology-stages")
      expect(stages?.getAttribute("role")).toBe("list")
      const stageItems = mounted.root.querySelectorAll<HTMLElement>("[data-apc-stage=true]")
      expect(stageItems).toHaveLength(config.pipelines[mode]!.stages.length)
      expect([...stageItems].every((item) => item.getAttribute("role") === "listitem")).toBe(true)

      const stageLabels = [...mounted.root.querySelectorAll<HTMLElement>('[data-action="remove-stage"]')]
        .map((control) => control.getAttribute("aria-label") ?? "")
      expect(new Set(stageLabels).size).toBe(stageLabels.length)
      expect(stageLabels.join(" ")).toContain("Research")
      expect(stageLabels.join(" ")).toContain(mode === "parallel" ? "Synthesis" : "Writing")

      const runLabels = [...mounted.root.querySelectorAll<HTMLElement>('[data-action="remove-run"]')]
        .map((control) => control.getAttribute("aria-label") ?? "")
      expect(new Set(runLabels).size).toBe(runLabels.length)
      expect(runLabels.join(" ")).toContain("Researcher")
      expect(runLabels.join(" ")).toContain("Writer")

      const threadLabels = [...mounted.root.querySelectorAll<HTMLElement>('[data-action="remove-thread"]')]
        .map((control) => control.getAttribute("aria-label") ?? "")
      expect(new Set(threadLabels).size).toBe(threadLabels.length)
      expect(threadLabels.join(" ")).toContain("Researcher")
      expect(threadLabels.join(" ")).toContain("Writer")

      if (mode === "parallel") {
        const slotLabels = [...mounted.root.querySelectorAll<HTMLElement>('[data-action="remove-connection-slot"]')]
          .map((control) => control.getAttribute("aria-label") ?? "")
        expect(new Set(slotLabels).size).toBe(slotLabels.length)
        expect(slotLabels.join(" ")).toContain("Primary")
        expect(slotLabels.join(" ")).toContain("Backup")
      }
      mounted.handle.destroy()
    }
  })

  test("keeps a newly added parallel sibling reachable from the final response", () => {
    const config = baseConfig("parallel")
    const spareThreadId = generatedId(905)
    config.threads.push({ ...structuredClone(config.threads[1]), id: spareThreadId, name: "Spare thread" })
    const mounted = mount(
      { ...configuredSnapshot("parallel"), config },
      { idFactory: () => generatedId(906) },
    )
    click(mounted.root, '[data-action="add-run"]')
    const updated = mounted.getSnapshot().config
    if (updated === null) throw new Error("parallel config disappeared")
    const addedRun = updated.pipelines.parallel?.stages[0]?.runs.find(
      (run) => run.threadId === spareThreadId,
    )
    expect(addedRun?.id).toBe(generatedId(906))
    expect(updated.pipelines.parallel?.finalResponse).toEqual({
      source: "thread",
      runId: IDS.runC,
    })
    expect(updated.pipelines.parallel?.stages[1]?.runs[0]?.inputs).toContainEqual({
      source: "output",
      runId: generatedId(906),
      role: "user",
      onMissing: "fail-graph",
    })
    expect(validateConfigForMode(updated, "parallel").valid).toBe(true)
    mounted.handle.destroy()
  })

  test("falls back to a bounded Main final route when every reachable downstream run is full", () => {
    const { config, targetStageName, finalRunId } = capacityBoundParallelConfig("downstream")
    expect(validateConfigForMode(config, "parallel").issues).toEqual([])
    const mounted = mount(
      { ...configuredSnapshot("parallel"), config },
      { idFactory: () => generatedId(970) },
    )
    const add = actionIn(mounted.root, "[data-apc-stage=true]", targetStageName, "add-run") as HTMLButtonElement
    expect(add.disabled).toBe(false)
    clickElement(add)
    const updated = mounted.getSnapshot().config
    if (updated === null) throw new Error("parallel config disappeared")
    const addedRunId = updated.pipelines.parallel?.stages
      .find((stage) => stage.name === targetStageName)
      ?.runs.find((run) => run.threadId === updated.threads[3]!.id)?.id
    expect(addedRunId).toBeDefined()
    const fullDownstreamRun = updated.pipelines.parallel?.stages.at(-1)?.runs[0]
    expect(fullDownstreamRun?.inputs).toHaveLength(MAX_BINDINGS_PER_RUN)
    expect(updated.pipelines.parallel?.finalResponse).toEqual({
      source: "main",
      inputs: [
        { source: "output", runId: finalRunId, onMissing: "fail-graph" },
        { source: "output", runId: addedRunId, onMissing: "fail-graph" },
      ],
    })
    expect(validateConfigForMode(updated, "parallel").valid).toBe(true)
    mounted.handle.destroy()
  })

  test("fails closed when a terminal Main route is already at input capacity", () => {
    const { config, targetStageName } = capacityBoundParallelConfig("final")
    expect(validateConfigForMode(config, "parallel").issues).toEqual([])
    expect(config.pipelines.parallel?.finalResponse.source === "main"
      ? config.pipelines.parallel.finalResponse.inputs
      : []).toHaveLength(MAX_FINAL_INPUTS)
    const announcements: string[] = []
    const mounted = mount(
      { ...configuredSnapshot("parallel"), config },
      {
        idFactory: () => generatedId(971),
        accessibility: { announce: (message) => announcements.push(message) },
      },
    )
    const add = actionIn(mounted.root, "[data-apc-stage=true]", targetStageName, "add-run") as HTMLButtonElement
    expect(add.disabled).toBe(true)
    expect(add.parentElement?.textContent).toContain(String(MAX_FINAL_INPUTS))
    add.removeAttribute("disabled")
    clickElement(add)
    expect(mounted.mutations).toHaveLength(0)
    expect(announcements.some((message) => message.includes(String(MAX_FINAL_INPUTS)))).toBe(true)
    mounted.handle.destroy()
  })

  test("does not reuse removed thread or run identifiers", () => {
    const threadConfig = baseConfig("parallel")
    const removedThreadId = generatedId(1)
    threadConfig.threads.push({ ...structuredClone(threadConfig.threads[1]), id: removedThreadId, name: "Unused thread" })
    const threadMounted = mount(
      { ...configuredSnapshot("parallel"), config: threadConfig },
      { idFactory: collisionFactory([removedThreadId]) },
    )
    clickElement(threadAction(threadMounted.root, "Unused thread", "remove-thread"))
    click(threadMounted.root, '[data-action="confirm-removal"]')
    click(threadMounted.root, '[data-action="add-thread"]')
    const replacementThread = threadMounted.getSnapshot().config?.threads.find((thread) => thread.name === t("graph.defaultThreadName", { index: 3 }))
    expect(replacementThread?.id).toBeDefined()
    expect(replacementThread?.id).not.toBe(removedThreadId)

    const runConfig = baseConfig("parallel")
    const spareThreadId = generatedId(906)
    runConfig.threads.push({ ...structuredClone(runConfig.threads[1]), id: spareThreadId, name: "Spare thread" })
    const runMounted = mount(
      { ...configuredSnapshot("parallel"), config: runConfig },
      { idFactory: collisionFactory([generatedId(908), generatedId(908), generatedId(909)]) },
    )
    click(runMounted.root, '[data-action="add-run"]')
    const addedRun = runMounted.getSnapshot().config?.pipelines.parallel?.stages[0]?.runs.find(
      (run) => run.id !== IDS.runA && run.id !== IDS.runB,
    )
    expect(addedRun?.threadId).toBe(spareThreadId)
    clickElement(runAction(runMounted.root, "Research", "Spare thread", "remove-run"))
    click(runMounted.root, '[data-action="confirm-removal"]')
    click(runMounted.root, '[data-action="add-run"]')
    const replacementRun = runMounted.getSnapshot().config?.pipelines.parallel?.stages[0]?.runs.find(
      (run) => run.id !== IDS.runA && run.id !== IDS.runB,
    )
    expect(replacementRun?.id).toBeDefined()
    expect(replacementRun?.id).not.toBe(addedRun?.id)
    threadMounted.handle.destroy()
    runMounted.handle.destroy()
  })

  test("blocks removal of a referenced connection slot with an actionable localized reason", () => {
    const config = baseConfig("parallel")
    const slotId = generatedId(902)
    config.connectionSlots = [{ id: slotId, label: "Referenced slot" }]
    config.threads[0].connectionSlotId = slotId
    const mounted = mount({ ...configuredSnapshot("parallel"), config })
    const item = mounted.root.querySelector<HTMLElement>("[data-apc-connection-slot=true]")
    const remove = item?.querySelector<HTMLButtonElement>('[data-action="remove-connection-slot"]')

    expect(remove?.disabled).toBe(true)
    expect(item?.textContent).toContain("Change the threads using this connection slot before removing it.")
    expect(mounted.mutations).toHaveLength(0)
    clickElement(remove as HTMLElement)
    expect(mounted.getSnapshot().config?.connectionSlots).toHaveLength(1)
    expect(mounted.root.querySelector('[data-apc-confirmation=true]')).toBeNull()
    mounted.handle.destroy()
  })

  test("confirms removal of an unreferenced connection slot without leaving dangling references", () => {
    const config = baseConfig("parallel")
    const slotId = generatedId(903)
    config.connectionSlots = [{ id: slotId, label: "Unused slot" }]
    const mounted = mount({ ...configuredSnapshot("parallel"), config })

    click(mounted.root, '[data-action="remove-connection-slot"]')
    expect(mounted.mutations).toHaveLength(0)
    expect(mounted.root.querySelector('[data-apc-confirmation=true][data-confirmation-kind="slot"]')).not.toBeNull()
    click(mounted.root, '[data-action="cancel-confirmation"]')
    expect(browser.window.document.activeElement?.getAttribute("data-action")).toBe("remove-connection-slot")
    click(mounted.root, '[data-action="remove-connection-slot"]')
    click(mounted.root, '[data-action="confirm-removal"]')
    expect(mounted.getSnapshot().config?.connectionSlots).toHaveLength(0)
    expect(mounted.getSnapshot().config?.threads.every((thread) => thread.connectionSlotId === undefined)).toBe(true)
    expect(mounted.mutations.at(-1)).toMatchObject({ type: "config", reason: "connection-slot-removed" })
    mounted.handle.destroy()
  })

  test("renders hostile connection slot labels as input text without interpreting markup", () => {
    const hostile = '<img src="slot" onerror="window.__apcInjected=1">'
    const config = baseConfig("parallel")
    config.connectionSlots = [{ id: generatedId(904), label: hostile }]
    const mounted = mount({ ...configuredSnapshot("parallel"), config })
    const input = mounted.root.querySelector<HTMLInputElement>("[data-apc-connection-slot-label=true]")

    expect(input?.value).toBe(hostile)
    expect(mounted.root.querySelector("img, svg, script, iframe, object, embed")).toBeNull()
    mounted.handle.destroy()
  })

  test("ignores a detached Parallel slot control after the editor renders Sequential", () => {
    const slotId = generatedId(905)
    const parallelConfig = baseConfig("parallel")
    parallelConfig.connectionSlots = [{ id: slotId, label: "Research route" }]
    const mounted = mount({ ...configuredSnapshot("parallel"), config: parallelConfig })
    const detachedInput = mounted.root.querySelector<HTMLInputElement>("[data-apc-connection-slot-label=true]")
    expect(detachedInput).not.toBeNull()

    const sequentialConfig = structuredClone(parallelConfig)
    sequentialConfig.activeMode = "sequential"
    mounted.handle.render({ ...configuredSnapshot("sequential"), config: sequentialConfig })
    expect(mounted.root.querySelector("[data-apc-connection-slots=true]")).toBeNull()

    if (detachedInput) {
      detachedInput.value = "Detached rename"
      detachedInput.dispatchEvent(new browser.window.Event("change", { bubbles: true }))
    }

    expect(mounted.mutations).toHaveLength(0)
    expect(mounted.getSnapshot().config?.connectionSlots).toEqual([{ id: slotId, label: "Research route" }])
    mounted.handle.destroy()
  })
  test("splits navigation and topology ownership without duplicating the host toolbar", () => {
    const toolbarHost = browser.window.document.createElement("div")
    browser.window.document.body.append(toolbarHost)
    const opened: string[] = []
    const snapshot = configuredSnapshot("parallel", { kind: "run", runId: IDS.runC })
    const combined = mount(snapshot)
    expect(combined.handle.element.dataset.apcGraphSurface).toBe("all")
    expect(combined.root.querySelectorAll('[data-apc-graph-surface="all"]')).toHaveLength(1)
    expect(combined.root.querySelectorAll('[data-apc-graph-root="true"][data-apc-graph-surface="all"]')).toHaveLength(1)
    expect(combined.handle.element.tagName).toBe("SECTION")
    expect(combined.root.querySelector("[data-apc-thread-navigation=true]")).not.toBeNull()
    expect(combined.root.querySelector("[data-apc-topology=parallel]")).not.toBeNull()
    expect(combined.root.querySelector("[data-apc-final-route=true]")).not.toBeNull()
    expect(combined.root.querySelector("[data-apc-connection-slots=true]")).not.toBeNull()
    expect(combined.root.querySelector('[data-action="open-loom"]')).toBeNull()
    expect(combined.root.querySelector("[data-apc-run-navigation=true]")).toBeNull()
    expect(combined.root.querySelectorAll("[data-apc-run-select=true]")).toHaveLength(3)
    const selectedRun = runAction(combined.root, "Synthesis", "Researcher", "select-run")
    selectedRun.focus()
    key(selectedRun, "ArrowUp")
    expect(browser.window.document.activeElement?.textContent).toContain("Writer")
    combined.handle.destroy()
    const navigation = mount(snapshot, {
      surface: "navigation",
      toolbarHost,
      onOpenLoom: (threadId) => { opened.push(threadId) },
    })
    const topology = mount(snapshot, { surface: "topology", toolbarHost })

    expect(navigation.handle.element.dataset.apcGraphSurface).toBe("navigation")
    expect(topology.handle.element.dataset.apcGraphSurface).toBe("topology")
    expect(navigation.root.querySelectorAll('[data-apc-graph-surface="navigation"]')).toHaveLength(1)
    expect(topology.root.querySelectorAll('[data-apc-graph-surface="topology"]')).toHaveLength(1)
    expect(navigation.root.querySelectorAll(
      '[data-apc-graph-root="true"][data-apc-graph-surface="navigation"]',
    )).toHaveLength(1)
    expect(topology.root.querySelectorAll(
      '[data-apc-graph-root="true"][data-apc-graph-surface="topology"]',
    )).toHaveLength(1)
    expect(navigation.handle.element.tagName).toBe("SECTION")
    expect(topology.handle.element.tagName).toBe("SECTION")
    expect(toolbarHost.querySelectorAll("[data-apc-graph-toolbar-owned=true]")).toHaveLength(1)
    expect(toolbarHost.querySelectorAll('[role="radiogroup"]')).toHaveLength(1)
    expect(navigation.root.querySelector("[data-apc-thread-navigation=true]")).not.toBeNull()
    expect(navigation.root.querySelector("[data-apc-topology]")).toBeNull()
    expect(navigation.root.querySelector("[data-apc-final-route=true]")).toBeNull()
    expect(navigation.root.querySelector("[data-apc-connection-slots=true]")).toBeNull()
    expect(topology.root.querySelector("[data-apc-thread-navigation=true]")).toBeNull()
    expect(topology.root.querySelector("[data-apc-topology=parallel]")).not.toBeNull()
    expect(topology.root.querySelector("[data-apc-final-route=true]")).not.toBeNull()
    expect(topology.root.querySelector("[data-apc-connection-slots=true]")).not.toBeNull()
    expect(topology.root.querySelector('[role="radiogroup"]')).toBeNull()
    expect(topology.root.querySelector("[data-apc-editor-status=true]")).toBeNull()

    const runOrder = [...navigation.root.querySelectorAll<HTMLElement>("[data-apc-run-navigation=true] > li")]
      .map((item) => item.querySelector("[data-apc-run-select=true]")?.textContent)
    expect(runOrder).toEqual(["Researcher", "Writer", "Researcher"])
    expect(navigation.root.querySelector("[data-apc-run-navigation=true] [data-selected=true]")?.textContent)
      .toContain("Researcher")
    clickElement(threadAction(navigation.root, "Writer", "open-loom"))
    expect(opened).toEqual([IDS.threadB])

    const callbacklessNavigation = mount(snapshot, { surface: "navigation" })
    expect(callbacklessNavigation.root.querySelector('[data-action="open-loom"]')).toBeNull()
    callbacklessNavigation.handle.destroy()

    topology.handle.destroy()
    navigation.handle.destroy()
  })

  test("renders Sequential as a Main-dispatch causal chain and Parallel with slot and final-route controls", () => {
    const sequentialConfig = baseConfig("sequential")
    const slotId = generatedId(920)
    sequentialConfig.connectionSlots = [{ id: slotId, label: "Hidden override" }]
    sequentialConfig.threads[0].connectionSlotId = slotId
    const sequential = mount({ ...configuredSnapshot("sequential"), config: sequentialConfig }, { surface: "topology" })

    expect(sequential.root.querySelector("[data-apc-connection-slots=true]")).toBeNull()
    expect(sequential.root.querySelector("[data-apc-connection-slot-label=true]")).toBeNull()
    expect(sequential.root.querySelector('[data-action="add-connection-slot"], [data-action="remove-connection-slot"]')).toBeNull()
    const causalStages = [...sequential.root.querySelectorAll<HTMLElement>("[data-apc-causal-chain=true] > [data-apc-causal-stage=true]")]
    expect(causalStages.map((stage) => stage.dataset.stagePosition)).toEqual(["1", "2"])
    expect(causalStages.map((stage) => stage.querySelectorAll("[data-apc-run-card=true]").length)).toEqual([1, 1])
    expect(causalStages.map((stage) => stage.querySelector("[data-apc-run-select=true]")?.textContent))
      .toEqual(["Researcher", "Writer"])
    expect(causalStages.map((stage) => stage.querySelector("[data-apc-main-dispatch=true]")?.textContent))
      .toEqual([
        expect.stringContaining(t("privacy.mainSource")),
        expect.stringContaining(t("privacy.mainSource")),
      ])
    expect(sequential.root.querySelector("[data-apc-causal-chain=true]")?.getAttribute("data-connection-source")).toBe("main")
    expect(sequential.root.querySelector("[data-apc-final-route=true]")).not.toBeNull()

    const parallelConfig = baseConfig("parallel")
    parallelConfig.connectionSlots = [{ id: slotId, label: "Research route" }]
    const parallel = mount({ ...configuredSnapshot("parallel"), config: parallelConfig }, { surface: "topology" })
    const slotSection = parallel.root.querySelector<HTMLElement>("[data-apc-connection-slots=true]")
    expect(slotSection?.querySelector<HTMLInputElement>("[data-apc-connection-slot-label=true]")?.value)
      .toBe("Research route")
    expect(slotSection?.querySelector('[data-action="add-connection-slot"]')).not.toBeNull()
    expect(slotSection?.querySelector('[data-action="remove-connection-slot"]')).not.toBeNull()
    expect(parallel.root.outerHTML).not.toContain(slotId)
    const finalRoute = parallel.root.querySelector<HTMLElement>("[data-apc-final-route=true]")
    expect(finalRoute).not.toBeNull()
    expect(finalRoute?.querySelector('[data-action="final-main"]')).not.toBeNull()
    expect(finalRoute?.querySelector('[data-action="final-thread"]')).not.toBeNull()
    expect(parallel.root.querySelector("[data-apc-run-card=true] .apc-run-inputs")).not.toBeNull()
    expect(parallel.root.querySelector(".apc-council-warning h3")).not.toBeNull()
    expect(parallel.root.querySelector("[data-apc-topology=parallel] h2")).not.toBeNull()

    sequential.handle.destroy()
    parallel.handle.destroy()
  })

  test("projects only bounded activity positions to textual data-status states and Main Graph-fallback delivery", () => {
    const snapshot = configuredSnapshot("parallel")
    const mounted = mount({
      ...snapshot,
      execution: {
        terminal: false,
        activity: [
          { stageIndex: 0, runIndex: 0, status: "completed" },
          { stageIndex: 0, runIndex: 1, status: "failed" },
          { stageIndex: 99, runIndex: 99, status: "timed-out" },
        ],
      },
    }, { surface: "topology" })
    const card = (stage: string, thread: string): HTMLElement =>
      runAction(mounted.root, stage, thread, "select-run").closest<HTMLElement>("[data-apc-run-card=true]")!

    expect(card("Research", "Researcher").dataset.status).toBe("completed")
    expect(card("Research", "Researcher").textContent).toContain(t("inspector.statusCompleted"))
    expect(card("Research", "Writer").dataset.status).toBe("failed")
    expect(card("Synthesis", "Researcher").dataset.status).toBe("pending")
    expect(card("Research", "Writer").textContent).toContain(t("inspector.statusFailed"))
    expect(mounted.root.querySelectorAll('[data-status="timed-out"]')).toHaveLength(0)
    expect(card("Synthesis", "Researcher").textContent).toContain(t("inspector.statusPending"))

    for (const status of ["running", "cancelled", "timed-out", "skipped"] as const) {
      mounted.handle.render({
        ...snapshot,
        execution: { terminal: false, activity: [{ stageIndex: 1, runIndex: 0, status }] },
      })
      expect(card("Synthesis", "Researcher").dataset.status).toBe(status)
      expect(card("Synthesis", "Researcher").textContent).toContain(
        t(status === "running"
          ? "inspector.statusRunning"
          : status === "cancelled"
            ? "inspector.statusCancelled"
            : status === "timed-out"
              ? "inspector.statusTimedOut"
              : "inspector.statusSkipped"),
      )
    }

    mounted.handle.render({
      ...snapshot,
      execution: { terminal: true, outcome: "graph-fallback", activity: [] },
    })
    const finalRoute = mounted.root.querySelector<HTMLElement>("[data-apc-final-route=true]")
    expect(finalRoute?.dataset.status).toBe("completed")
    expect(finalRoute?.dataset.outcome).toBe("graph-fallback")
    expect(finalRoute?.dataset.outcomeClass).toBe("graph-fallback")
    expect(finalRoute?.textContent).toContain(t("fallback.main"))
    mounted.handle.destroy()
  })

  test("rejects explicit and nonterminal execution mutation locks without blocking selection or Open Loom", () => {
    const snapshot = configuredSnapshot("parallel")
    let configCalls = 0
    let modeCalls = 0
    let slotCalls = 0
    const opened: string[] = []
    const lockedSnapshot: GraphEditorSnapshot = {
      ...snapshot,
      mutationLocked: true,
      execution: { terminal: false, activity: [{ stageIndex: 0, runIndex: 0, status: "running" }] },
    }
    const mounted = mount(lockedSnapshot, {
      onConfigChange: () => { configCalls += 1 },
      onModeChange: () => { modeCalls += 1 },
      onAddConnectionSlot: () => { slotCalls += 1 },
      onOpenLoom: (threadId) => { opened.push(threadId) },
    })

    expect([...mounted.root.querySelectorAll<HTMLButtonElement>("[data-apc-mutates=true]")]
      .every((control) => control.disabled && control.getAttribute("aria-disabled") === "true")).toBe(true)
    clickElement(runAction(mounted.root, "Synthesis", "Researcher", "select-run"))
    clickElement(threadAction(mounted.root, "Writer", "open-loom"))
    expect(mounted.selections.at(-1)).toEqual({ kind: "run", runId: IDS.runC })
    expect(opened).toEqual([IDS.threadB])

    for (const selector of [
      '[data-action="add-stage"]',
      '[data-action="add-connection-slot"]',
      '[data-action="select-mode"][data-mode="sequential"]',
    ]) {
      const control = mounted.root.querySelector<HTMLButtonElement>(selector)
      expect(control).not.toBeNull()
      control?.removeAttribute("disabled")
      control?.removeAttribute("aria-disabled")
      if (control) clickElement(control)
    }
    expect(mounted.mutations).toHaveLength(0)
    expect(configCalls).toBe(0)
    expect(modeCalls).toBe(0)
    expect(slotCalls).toBe(0)

    mounted.handle.render({
      ...snapshot,
      mutationLocked: false,
      execution: { terminal: false, activity: [{ stageIndex: 0, runIndex: 0, status: "running" }] },
    })
    const nonterminalAddStage = mounted.root.querySelector<HTMLButtonElement>('[data-action="add-stage"]')
    expect(nonterminalAddStage?.disabled).toBe(true)
    nonterminalAddStage?.removeAttribute("disabled")
    nonterminalAddStage?.removeAttribute("aria-disabled")
    if (nonterminalAddStage) clickElement(nonterminalAddStage)
    expect(configCalls).toBe(0)

    mounted.handle.render({
      ...snapshot,
      mutationLocked: false,
      execution: { terminal: true, activity: [{ stageIndex: 1, runIndex: 0, status: "completed" }] },
    })
    expect(mounted.root.querySelector<HTMLButtonElement>('[data-action="add-stage"]')?.disabled).toBe(false)
    click(mounted.root, '[data-action="add-stage"]')
    expect(configCalls).toBe(1)
    expect(mounted.mutations.at(-1)).toMatchObject({ type: "config", reason: "stage-added" })
    mounted.handle.destroy()
  })

  test("keeps the editor status live node stable and silent across unchanged rerenders", () => {
    const announcements: string[] = []
    const liveElement = browser.window.document.createElement("div")
    const snapshot = configuredSnapshot("parallel")
    const mounted = mount(snapshot, {
      liveRegion: {
        element: liveElement,
        announce: (message) => { announcements.push(message) },
      },
    })
    const status = mounted.root.querySelector<HTMLElement>("[data-apc-editor-status=true]")
    const observer = new browser.window.MutationObserver(() => undefined)
    if (status) observer.observe(status, { childList: true, characterData: true, subtree: true })

    mounted.handle.render({ ...snapshot })

    expect(mounted.root.querySelector("[data-apc-editor-status=true]")).toBe(status)
    expect(observer.takeRecords()).toHaveLength(0)
    expect(announcements).toHaveLength(0)
    observer.disconnect()
    mounted.handle.destroy()
  })

  test("renders hostile long navigation and topology labels as text without creating markup", () => {
    const hostile = `<img src=x onerror="window.__apcInjected=1">${"界".repeat(512)}`
    const config = baseConfig("parallel")
    config.threads[0].name = hostile
    config.pipelines.parallel!.stages[0].name = `<svg onload="window.__apcInjected=2">${"長".repeat(512)}`
    const mounted = mount({ ...configuredSnapshot("parallel"), config })

    expect(threadAction(mounted.root, hostile, "select-thread").textContent).toBe(hostile)
    expect(mounted.root.querySelector("[data-apc-stage=true] h3")?.textContent).toContain("<svg")
    expect(mounted.root.textContent).toContain("界".repeat(512))
    expect(mounted.root.querySelector("img, svg, script, iframe, object, embed")).toBeNull()
    mounted.handle.destroy()
  })
})
