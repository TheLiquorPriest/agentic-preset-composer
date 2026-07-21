// @ts-ignore Bun provides the test module at runtime; the extension bundle excludes this file.
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { JSDOM } from "jsdom"
import {
  createExecutionInspector,
  selectInspectorOutcome,
  truncateInspectorText,
  type ExecutionInspectorController,
  type ExecutionInspectorOptions,
  type ExecutionInspectorSnapshot,
  type InspectorOutcomeInput,
} from "./inspector"
import type { ApcCatalogKey, ApcTranslate } from "../i18n/catalogs"
import type { OutcomeClass } from "../runtime/outcome"

const browser = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://lumiverse.test/",
})
const testDocument = browser.window.document
let testLocale = "en"

const testTranslator: ApcTranslate = (
  key: ApcCatalogKey,
  values?: Readonly<Record<string, unknown>>,
): string => {
  const suffix = values === undefined
    ? ""
    : `:${Object.entries(values).sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => `${name}=${String(value)}`).join(",")}`
  return `${testLocale}:${key}${suffix}`
}


function snapshot(
  status: ExecutionInspectorSnapshot["status"],
  extra: Partial<ExecutionInspectorSnapshot> = {},
): ExecutionInspectorSnapshot {
  return { status, ...extra }
}

type TestInspectorOptions = Omit<ExecutionInspectorOptions, "document" | "t"> & {
  readonly t?: ApcTranslate
}

function mountInspector(options: TestInspectorOptions = {}): ExecutionInspectorController {
  const inspector = createExecutionInspector({
    document: testDocument,
    t: options.t ?? testTranslator,
    ...options,
  })
  testDocument.body.append(inspector.element)
  return inspector
}

function actionButton(inspector: ExecutionInspectorController, action: string): HTMLButtonElement | null {
  return inspector.element.querySelector<HTMLButtonElement>(`button[data-inspector-action="${action}"]`)
}

beforeEach(() => {
  testLocale = "en"
  testDocument.body.replaceChildren()
  testDocument.documentElement.lang = "en"
})

afterAll(() => {
  browser.window.close()
})

describe("safe execution inspector", () => {
  test("renders bounded live progress, budget, dispatch, usage, and activity", () => {
    const inspector = mountInspector({ onStop: () => undefined, maxItems: 3 })
    inspector.render(snapshot("running", {
      stoppable: true,
      progress: {
        stageIndex: 2,
        stageCount: 3,
        completedRuns: 2,
        totalRuns: 5,
        percent: 40,
      },
      deadline: {
        elapsedMs: 37_000,
        remainingMs: 223_000,
        timeoutMs: 60_000,
        phase: "working",
      },
      stages: [{
        label: "Synthesis stage",
        index: 2,
        status: "running",
        runs: [{
          label: "Synthesize answer",
          threadLabel: "Synthesizer",
          roleLabel: "Synthesis",
          status: "running",
          optional: false,
          index: 1,
          dispatch: {
            source: "main",
            descriptor: {
              label: "Main route",
              provider: "OpenRouter",
              model: "Claude Sonnet",
            },
          },
        }],
      }],
      usage: { input: 10_400, output: 2_100, total: 12_500 },
      activity: [
        { status: "completed", runLabel: "Researcher", elapsedMs: 8_400 },
        { status: "completed", runLabel: "Critic", elapsedMs: 11_200 },
        { status: "running", runLabel: "Synthesizer", elapsedMs: 18_000 },
        { status: "pending", runLabel: "Bounded away" },
      ],
    }))

    expect(inspector.element.dataset.inspectorView).toBe("execution")
    expect(inspector.element.querySelector<HTMLProgressElement>("progress")?.value).toBe(40)
    expect(inspector.element.querySelector("[data-inspector-field=stage-progress]")?.textContent).toContain("2 / 3")
    expect(inspector.element.querySelector("[data-inspector-field=run-progress]")?.textContent).toContain("2 / 5")
    expect(inspector.element.querySelector("[data-inspector-field=remaining-budget]")?.textContent).toContain("count=223")
    expect(inspector.element.querySelector("[data-inspector-field=elapsed-seconds]")?.textContent).toMatch(/37.*s/i)
    expect(inspector.element.querySelector("[data-inspector-field=provider]")?.textContent).toContain("OpenRouter")
    expect(inspector.element.querySelector("[data-inspector-field=model]")?.textContent).toContain("Claude Sonnet")
    expect(inspector.element.querySelector("[data-inspector-section=usage]")?.textContent).toContain("input=10400")
    expect(inspector.element.querySelector("[data-inspector-field=stage-position]")?.textContent).toContain("index=2")
    expect(inspector.element.querySelectorAll(".apc-inspector-activity-item")).toHaveLength(3)
    expect(inspector.element.querySelectorAll("[data-inspector-action=stop]")).toHaveLength(1)
    inspector.destroy()
  })

  test("answers four execution questions with safe run, input, outcome, and delivery summaries", () => {
    const loadedTraceKeys: string[] = []
    let traceLists = 0
    const inspector = mountInspector({
      onStop: () => undefined,
      onLoadTraces: () => {
        traceLists += 1
      },
      onLoadTrace: key => {
        loadedTraceKeys.push(key)
      },
    })
    const privateTraceKey = "frontend-trace-private-key"
    const hostilePreview = "<img src=x onerror=steal()> token=private-secret https://private.example.test/v1"
    inspector.render(snapshot("running", {
      stoppable: true,
      inspectedRun: {
        label: "Synthesize answer",
        threadLabel: "Synthesizer",
        stageLabel: "Compose",
        status: "running",
        optional: false,
        dispatch: {
          source: "slot",
          status: "dispatched",
          descriptor: {
            label: "Approved research connection",
            provider: "Safe provider",
            model: "Safe model",
          },
        },
        inputSources: [
          {
            kind: "earlier-output",
            label: "Research summary",
            roleLabel: "User",
            required: true,
            missingPolicy: "fail-graph",
          },
          {
            kind: "main-context",
            label: "Main context",
            required: false,
            missingPolicy: "omit-binding",
          },
        ],
      },
      stages: [{
        label: "Research",
        status: "completed",
        runs: [{ label: "Researcher", status: "completed" }],
      }, {
        label: "Compose",
        status: "running",
        runs: [{ label: "Synthesizer", status: "running" }],
      }],
      finalRoute: { target: "thread", targetLabel: "Synthesizer" },
      traces: [{
        key: privateTraceKey,
        status: "running",
        eventCount: 1,
        preview: hostilePreview,
      }],
      traceDetails: {
        [privateTraceKey]: {
          key: privateTraceKey,
          status: "running",
          eventCount: 1,
          preview: hostilePreview,
          events: [{
            sequence: 1,
            kind: "dispatch",
            status: "running",
            preview: hostilePreview,
          }],
        },
      },
    }))

    const questions = [...inspector.element.querySelectorAll<HTMLElement>("[data-inspector-question]")]
    expect(questions.map(node => node.dataset.inspectorQuestion)).toEqual([
      "ran",
      "inputs",
      "happened",
      "delivered",
    ])
    expect(questions.map(node => node.querySelector(":scope > h3")?.textContent)).toEqual([
      "en:agentGraph.run",
      "en:graph.inputs",
      "en:inspector.outcome",
      "en:inspector.finalRoute",
    ])
    expect(questions[0]?.textContent).toContain("Synthesize answer")
    expect(questions[0]?.textContent).toContain("Approved research connection")
    expect(questions[0]?.textContent).toContain("Safe provider")
    expect(questions[1]?.querySelectorAll(".apc-inspector-source")).toHaveLength(2)
    expect(questions[1]?.textContent).toContain("Research summary")
    expect(questions[1]?.textContent).toContain("en:workspace.mainContext")
    expect(questions[2]?.textContent).toContain("en:inspector.statusRunning")
    expect(questions[3]?.textContent).toContain("Synthesizer")
    expect(questions[3]?.textContent).toContain("en:terminal.finalizing")

    const statusTokens = [...inspector.element.querySelectorAll<HTMLElement>(".apc-inspector-status-token")]
    expect(statusTokens.length).toBeGreaterThan(0)
    for (const token of statusTokens) {
      expect(token.getAttribute("aria-label")).toBeTruthy()
      expect(token.querySelector("[aria-hidden=true]")?.textContent).toBeTruthy()
      expect(token.querySelector(".apc-inspector-status-label")?.textContent).toBe(token.getAttribute("aria-label"))
    }
    expect(inspector.element.querySelector("[data-status-kind=completed]")?.textContent).toContain("✓")
    expect(inspector.element.querySelector("[data-status-kind=running]")?.textContent).toContain("●")

    const traceList = actionButton(inspector, "load-traces")
    const traceDetail = actionButton(inspector, "load-trace")
    expect(traceList?.textContent).toBe("en:inspector.traces")
    expect(traceDetail?.textContent).toBe("en:inspector.traceDetails")
    expect(inspector.element.textContent).not.toContain("en:action.refreshConnections")
    traceDetail?.click()
    actionButton(inspector, "load-traces")?.click()
    expect(traceLists).toBe(1)
    expect(loadedTraceKeys).toEqual([privateTraceKey])

    const text = inspector.element.textContent ?? ""
    const html = inspector.element.outerHTML
    expect(text).not.toContain(hostilePreview)
    expect(html).not.toContain("private-secret")
    expect(html).not.toContain("private.example.test")
    expect(html).not.toContain(privateTraceKey)
    expect(html).not.toContain("onerror")
    expect(text).not.toContain("en:action.retry")
    inspector.destroy()
  })

  test("execution state overrides stale selection views and terminal dispatch comes from the final route", () => {
    const inspector = mountInspector({ onStop: () => undefined })
    inspector.render(snapshot("running", {
      view: "selected-run",
      stoppable: true,
      selection: {
        kind: "run",
        threadLabel: "Old selection",
        run: { status: "completed", label: "Already completed" },
      },
    }))
    expect(inspector.element.dataset.inspectorView).toBe("execution")
    expect(inspector.element.querySelector("[data-inspector-section=current-run]")).toBeNull()
    expect(actionButton(inspector, "stop")).not.toBeNull()

    inspector.render(snapshot("completed", {
      view: "selected-thread",
      terminal: true,
      outcome: { class: "success" },
      finalRoute: {
        target: "thread",
        delivered: true,
        dispatch: {
          source: "slot",
          descriptor: { provider: "Terminal provider", model: "Terminal model" },
        },
      },
    }))
    expect(inspector.element.dataset.inspectorView).toBe("execution")
    expect(inspector.element.querySelector("[data-inspector-outcome]")).not.toBeNull()
    expect(inspector.element.querySelector("[data-inspector-field=provider]")?.textContent).toContain("Terminal provider")

    inspector.render(snapshot("idle", { view: "idle" }))
    expect(inspector.element.querySelector("[data-inspector-status]")).toBeNull()
    inspector.destroy()
  })

  test("bounds topology-derived activity before rendering", () => {
    const stages = Array.from({ length: 33 }, (_, index) => index < 32
      ? { status: "pending" as const, runs: [] }
      : { status: "running" as const, runs: [{ status: "running" as const, label: "Beyond stage bound" }] })
    const inspector = mountInspector()
    inspector.render(snapshot("running", { stages }))
    expect(inspector.element.textContent).not.toContain("Beyond stage bound")
    expect(inspector.element.querySelectorAll(".apc-inspector-activity-item")).toHaveLength(0)
    inspector.destroy()
  })

  test("renders selected-run configuration from human labels and safe source summaries", () => {
    const inspector = mountInspector()
    inspector.render(snapshot("idle", {
      view: "selected-run",
      selection: {
        kind: "run",
        threadLabel: "Synthesizer",
        stageLabel: "Compose",
        stageIndex: 2,
        run: {
          status: "pending",
          index: 3,
          label: "Final synthesis",
          threadLabel: "Synthesizer",
          roleLabel: "Synthesis",
          optional: false,
          deadline: { timeoutMs: 60_000 },
          dispatch: {
            source: "main",
            descriptor: { label: "Main route", provider: "OpenRouter", model: "Claude Sonnet" },
          },
          inputSources: [
            {
              kind: "earlier-output",
              label: "Researcher · Final response",
              roleLabel: "User",
              required: true,
              missingPolicy: "fail-graph",
            },
            {
              kind: "earlier-output",
              label: "Critic · Final response",
              roleLabel: "User",
              required: false,
              missingPolicy: "omit-binding",
            },
          ],
          output: { label: "Final response", available: true },
        },
      },
    }))

    expect(inspector.element.dataset.inspectorView).toBe("selected-run")
    expect(inspector.element.querySelector("[data-inspector-section=selected-run]")?.textContent).toContain("Final synthesis")
    expect(inspector.element.querySelector("[data-inspector-section=selected-run]")?.textContent).toContain("Synthesizer")
    expect(inspector.element.querySelector("[data-inspector-field=stage-position]")?.textContent).toContain("index=2")
    expect(inspector.element.querySelector("[data-inspector-field=run-position]")?.textContent).toContain("index=3")
    expect(inspector.element.querySelector("[data-badge-kind=required]")).not.toBeNull()
    expect(inspector.element.querySelector("[data-badge-kind=optional]")).not.toBeNull()
    expect(inspector.element.querySelectorAll(".apc-inspector-source")).toHaveLength(2)
    expect(inspector.element.querySelector("[data-inspector-field=output-label]")?.textContent).toContain("Final response")
    expect(inspector.element.textContent).not.toContain("en:action.retry")
    inspector.destroy()
  })

  test("projects completed, selected-final failure, cancelled, and Graph-fallback outcomes", () => {
    const inspector = mountInspector()
    const cases: readonly {
      snapshot: ExecutionInspectorSnapshot
      outcome: OutcomeClass
      expected: string
    }[] = [
      {
        snapshot: snapshot("completed", {
          terminal: true,
          outcome: { class: "success" },
          finalRoute: { target: "thread", targetLabel: "Synthesizer", delivered: true },
        }),
        outcome: "success",
        expected: "en:outcome.success",
      },
      {
        snapshot: snapshot("failed", {
          terminal: true,
          outcome: { class: "selected-final-failure", category: "provider" },
          error: { category: "provider", messageKey: "error.graph" },
          finalRoute: { target: "thread", targetLabel: "Synthesizer", delivered: false },
        }),
        outcome: "selected-final-failure",
        expected: "en:outcome.selectedFinalFailed",
      },
      {
        snapshot: snapshot("cancelled", { terminal: true }),
        outcome: "parent-cancel",
        expected: "en:outcome.parentCancelled",
      },
      {
        snapshot: snapshot("completed", {
          terminal: true,
          outcome: { class: "graph-fallback", category: "graph" },
          fallback: { category: "graph", mainResponded: true },
          finalRoute: { target: "main", delivered: true, retainedCompletedRuns: 2 },
        }),
        outcome: "graph-fallback",
        expected: "en:fallback.title",
      },
    ]

    for (const item of cases) {
      inspector.render(item.snapshot)
      const outcome = inspector.element.querySelector<HTMLElement>("[data-inspector-outcome]")
      expect(outcome?.dataset.outcomeClass).toBe(item.outcome)
      expect(outcome?.textContent).toContain(item.expected)
    }

    inspector.render(snapshot("completed", {
      terminal: true,
      outcome: { class: "graph-fallback", category: "timeout" },
      fallback: { category: "timeout", mainResponded: false },
      finalRoute: { target: "main", delivered: false },
    }))
    expect(inspector.element.querySelector("[data-inspector-field=fallback-cause]")?.textContent).toContain("en:error.timeout")
    expect(inspector.element.querySelector("[data-inspector-field=main-fallback-result]")?.textContent).toContain("en:terminal.unavailable")
    expect(inspector.element.querySelector("[data-inspector-field=final-delivery] [data-status-kind=failed]")?.textContent).toContain("en:terminal.unavailable")
    inspector.destroy()
  })

  test("distinguishes failed work, amber Main fallback, and explicit final delivery without output bodies", () => {
    const inspector = mountInspector()
    inspector.render(snapshot("completed", {
      terminal: true,
      outcome: { class: "graph-fallback", category: "timeout" },
      inspectedRun: {
        label: "Synthesizer",
        status: "timed-out",
        optional: false,
        error: { category: "timeout" },
        output: {
          label: "Final response",
          available: false,
        },
      },
      activity: [
        { status: "completed", runLabel: "Researcher" },
        { status: "failed", runLabel: "Synthesizer", error: { category: "timeout" } },
      ],
      fallback: { category: "timeout", mainResponded: true },
      finalRoute: {
        target: "thread",
        targetLabel: "Configured Synthesizer",
        delivered: true,
        retainedCompletedRuns: 1,
      },
    }))

    const happened = inspector.element.querySelector<HTMLElement>("[data-inspector-question=happened]")
    const delivered = inspector.element.querySelector<HTMLElement>("[data-inspector-question=delivered]")
    expect(inspector.element.querySelector("[data-inspector-status=graph-fallback][data-outcome-class=graph-fallback]")?.textContent).toContain("en:fallback.title")
    expect(inspector.element.querySelector("[data-current-run-status=timed-out]")).not.toBeNull()
    expect(inspector.element.querySelector("[data-activity-status=completed] [data-status-kind=completed]")?.textContent).toContain("✓")
    expect(inspector.element.querySelector("[data-activity-status=failed] [data-status-kind=failed]")?.textContent).toContain("×")
    expect(happened?.querySelector("[data-outcome-class=graph-fallback]")).not.toBeNull()
    expect(happened?.textContent).toContain("en:error.timeout")
    expect(delivered?.querySelector("[data-outcome-class=graph-fallback]")).not.toBeNull()
    expect(delivered?.querySelector("[data-status-kind=graph-fallback]")?.textContent).toContain("◆")
    expect(delivered?.querySelector("[data-inspector-field=final-route]")?.textContent).toContain("Main")
    expect(delivered?.textContent).not.toContain("Configured Synthesizer")
    expect(delivered?.querySelector("[data-inspector-field=final-delivery] [data-status-kind=completed]")?.textContent).toContain("en:terminal.ready")
    expect(delivered?.querySelector("[data-inspector-field=main-fallback-result] [data-status-kind=completed]")?.textContent).toContain("en:terminal.ready")
    expect(inspector.element.querySelector("[data-inspector-section=output] [data-inspector-field=output-label]")?.textContent).toContain("Final response")
    expect(inspector.element.querySelector("[data-inspector-section=output] [data-inspector-field=output-availability]")?.textContent).toContain("en:terminal.unavailable")
    expect(inspector.element.textContent).not.toContain("en:action.retry")
    inspector.destroy()
  })

  test("renders current and terminal run output label and availability metadata", () => {
    const inspector = mountInspector()
    inspector.render(snapshot("running", {
      inspectedRun: {
        label: "Current run",
        status: "running",
        output: { label: "Live response" },
      },
    }))
    const currentOutput = inspector.element.querySelector<HTMLElement>(
      "[data-current-run-status=running] [data-inspector-section=output]",
    )
    expect(currentOutput?.querySelector("[data-inspector-field=output-label]")?.textContent).toContain("Live response")
    expect(currentOutput?.querySelector("[data-inspector-field=output-availability]")?.textContent).toContain("en:terminal.unavailable")

    inspector.render(snapshot("completed", {
      terminal: true,
      outcome: { class: "success" },
      inspectedRun: {
        label: "Terminal run",
        status: "completed",
        output: { label: "Final response" },
      },
    }))
    const terminalOutput = inspector.element.querySelector<HTMLElement>(
      "[data-current-run-status=completed] [data-inspector-section=output]",
    )
    expect(terminalOutput?.querySelector("[data-inspector-field=output-label]")?.textContent).toContain("Final response")
    expect(terminalOutput?.querySelector("[data-inspector-field=output-availability]")?.textContent).toContain("en:terminal.ready")
    inspector.destroy()
  })

  test("selects and freezes the canonical safe outcome projection", () => {
    const mutableFatal: { class: OutcomeClass; category: "integrity" | "unknown" } = {
      class: "integrity-fatal",
      category: "integrity",
    }
    const candidates: InspectorOutcomeInput[] = [
      ...Array.from({ length: 20 }, (): InspectorOutcomeInput => ({ class: "success" })),
      { class: "graph-fallback", category: "consent" },
      { class: "parent-cancel", category: "cancelled" },
      mutableFatal,
    ]
    const selected = selectInspectorOutcome(snapshot("completed", { outcomes: candidates }))
    expect(selected).toEqual({ class: "integrity-fatal", category: "integrity" })
    expect(Object.isFrozen(selected)).toBe(true)

    mutableFatal.category = "unknown"
    expect(selected).toEqual({ class: "integrity-fatal", category: "integrity" })
    const inspector = mountInspector()
    inspector.render(snapshot("completed", { terminal: true, outcomes: candidates }))
    expect(inspector.element.querySelector("[data-outcome-class=integrity-fatal]")).not.toBeNull()
    inspector.destroy()
  })

  test("gates one irreversible Stop action to stoppable nonterminal execution and never renders Retry", () => {
    let calls = 0
    const inspector = mountInspector({
      onStop: () => {
        calls += 1
      },
    })
    const unavailable: readonly ExecutionInspectorSnapshot[] = [
      snapshot("running", { stoppable: false }),
      snapshot("running", { stoppable: true, terminal: true }),
      snapshot("completed", { stoppable: true }),
      snapshot("running", { stoppable: true, cancellation: { requested: true } }),
    ]
    for (const current of unavailable) {
      inspector.render(current)
      expect(actionButton(inspector, "stop")).toBeNull()
    }

    inspector.render(snapshot("running", { stoppable: true }))
    const stop = actionButton(inspector, "stop")
    expect(inspector.element.querySelectorAll("button[data-inspector-action=stop]")).toHaveLength(1)
    expect(inspector.element.querySelector("[data-inspector-stop-control]")?.textContent).toContain("en:cancel.confirm")
    expect(inspector.element.querySelector("[data-inspector-stop-control]")?.textContent).toContain("en:council.effects")
    expect(stop?.getAttribute("aria-label")).toContain("en:council.effects")
    expect(inspector.element.querySelector("button[data-inspector-action=retry]")).toBeNull()
    expect(inspector.element.textContent).not.toContain("en:action.retry")

    stop?.click()
    expect(calls).toBe(1)
    expect(actionButton(inspector, "stop")).toBeNull()
    inspector.element.dispatchEvent(new browser.window.Event("click", { bubbles: true }))
    expect(calls).toBe(1)
    inspector.destroy()
  })

  test("preserves focused actions across progress rerenders and rehomes focus when Stop settles", () => {
    const inspector = mountInspector({ onStop: () => undefined })
    inspector.render(snapshot("running", {
      stoppable: true,
      progress: { stageIndex: 1, stageCount: 2 },
    }))
    actionButton(inspector, "stop")?.focus()
    expect(testDocument.activeElement?.getAttribute("data-inspector-action")).toBe("stop")

    inspector.render(snapshot("running", {
      stoppable: true,
      progress: { stageIndex: 2, stageCount: 2 },
    }))
    expect(testDocument.activeElement?.getAttribute("data-inspector-action")).toBe("stop")
    actionButton(inspector, "stop")?.click()
    expect(testDocument.activeElement).toBe(inspector.element)
    inspector.destroy()
  })

  test("falls back to the inspector panel when a pending trace action has no enabled replacement", async () => {
    let resolveTrace = () => {}
    const pending = new Promise<void>(resolve => {
      resolveTrace = () => resolve()
    })
    const inspector = mountInspector({ onLoadTrace: () => pending })
    inspector.render(snapshot("completed", {
      terminal: true,
      outcome: { class: "success" },
      traces: [{ key: "trace-pending", status: "completed", eventCount: 1 }],
    }))

    const load = actionButton(inspector, "load-trace")
    load?.focus()
    expect(testDocument.activeElement).toBe(load)
    load?.click()

    expect(actionButton(inspector, "load-trace")?.disabled).toBe(true)
    expect(testDocument.activeElement).toBe(inspector.element)

    resolveTrace()
    await pending
    await Promise.resolve()
    inspector.destroy()
  })

  test("falls back to the inspector panel when an enabled replacement cannot receive focus", () => {
    const inspector = mountInspector({ onLoadTrace: () => undefined })
    const traceSnapshot = snapshot("completed", {
      terminal: true,
      outcome: { class: "success" },
      traces: [{ key: "trace-noop-focus", status: "completed", eventCount: 1 }],
    })
    inspector.render(traceSnapshot)
    const load = actionButton(inspector, "load-trace")
    load?.focus()
    expect(testDocument.activeElement).toBe(load)

    const buttonPrototype = browser.window.HTMLButtonElement.prototype
    const originalFocus = buttonPrototype.focus
    buttonPrototype.focus = () => {}
    try {
      inspector.render(traceSnapshot)
    } finally {
      buttonPrototype.focus = originalFocus
    }

    expect(testDocument.activeElement).toBe(inspector.element)
    inspector.destroy()
  })

  test("preserves trace-detail focus by opaque identity when summaries reorder", () => {
    const inspector = mountInspector({ onLoadTrace: () => undefined })
    inspector.render(snapshot("completed", {
      terminal: true,
      outcome: { class: "success" },
      traces: [
        { key: "trace-first", status: "completed", eventCount: 1 },
        { key: "trace-second", status: "failed", eventCount: 2 },
      ],
    }))
    const buttons = inspector.element.querySelectorAll<HTMLButtonElement>(
      "[data-inspector-action=load-trace]",
    )
    buttons[1]?.focus()
    expect(testDocument.activeElement?.getAttribute("data-inspector-trace-position")).toBe("2")

    inspector.render(snapshot("completed", {
      terminal: true,
      outcome: { class: "success" },
      traces: [
        { key: "trace-second", status: "failed", eventCount: 2 },
        { key: "trace-first", status: "completed", eventCount: 1 },
      ],
    }))

    expect(testDocument.activeElement?.getAttribute("data-inspector-action")).toBe("load-trace")
    expect(testDocument.activeElement?.getAttribute("data-inspector-trace-position")).toBe("1")
    inspector.destroy()
  })

  test("gives repeated trace-detail actions distinct localized accessible names and status descriptions", () => {
    const privateTraceKeys = ["trace-private-alpha", "trace-private-beta"]
    const inspector = mountInspector({ onLoadTrace: () => undefined })
    inspector.render(snapshot("completed", {
      terminal: true,
      outcome: { class: "success" },
      traces: [
        { key: privateTraceKeys[0]!, status: "completed", eventCount: 1 },
        { key: privateTraceKeys[1]!, status: "failed", eventCount: 2 },
      ],
    }))

    const buttons = [...inspector.element.querySelectorAll<HTMLButtonElement>(
      "button[data-inspector-action=load-trace]",
    )]
    expect(buttons).toHaveLength(2)
    const labelIds = buttons.map(button => button.getAttribute("aria-labelledby"))
    const descriptionIds = buttons.map(button => button.getAttribute("aria-describedby"))
    expect(new Set(labelIds).size).toBe(2)
    expect(new Set(descriptionIds).size).toBe(2)

    const expectedStatuses = ["en:inspector.statusCompleted", "en:inspector.statusFailed"]
    for (const [index, button] of buttons.entries()) {
      const labelId = labelIds[index]
      const descriptionId = descriptionIds[index]
      if (labelId === null || descriptionId === null) throw new Error("trace action a11y references are missing")
      const labelParts = labelId.split(/\s+/u)
      if (labelParts.length !== 2) throw new Error("trace action must reference action and ordinal labels")
      expect(labelParts[0]).toMatch(/^apc-inspector-\d+-trace-\d+-action$/u)
      expect(labelParts[1]).toMatch(/^apc-inspector-\d+-trace-\d+-label$/u)
      expect(descriptionId).toMatch(/^apc-inspector-\d+-trace-\d+-status$/u)
      const actionLabel = testDocument.getElementById(labelParts[0]!)
      const ordinalLabel = testDocument.getElementById(labelParts[1]!)
      const description = testDocument.getElementById(descriptionId)
      expect(actionLabel?.textContent).toContain("en:inspector.traceDetails")
      expect(ordinalLabel?.textContent).toContain(`en:inspector.runTitle:index=${index + 1}`)
      expect(button.textContent).toContain("en:inspector.traceDetails")
      expect(description?.getAttribute("aria-label")).toBe(expectedStatuses[index])
      expect(button.getAttribute("aria-labelledby")).not.toContain(privateTraceKeys[index]!)
      expect(button.getAttribute("aria-describedby")).not.toContain(privateTraceKeys[index]!)
    }
    const html = inspector.element.outerHTML
    for (const key of privateTraceKeys) expect(html).not.toContain(key)
    inspector.destroy()
  })

  test("discloses each bounded trace truncation signal without preview or raw text", () => {
    const rawPreview = "<raw trace preview> token=private-trace-secret"
    const singleEvent = {
      sequence: 1,
      kind: "safe-event",
      status: "completed" as const,
      preview: rawPreview,
    }
    const oversizedEvents = Array.from({ length: 65 }, (_, index) => ({
      sequence: index + 1,
      kind: "safe-event",
      status: "completed" as const,
      preview: rawPreview,
    }))
    const inspector = mountInspector()
    inspector.render(snapshot("completed", {
      terminal: true,
      outcome: { class: "success" },
      traces: [
        {
          key: "summary-truncated",
          status: "completed",
          eventCount: 1,
          preview: rawPreview,
          truncated: true,
        },
        {
          key: "detail-truncated",
          status: "completed",
          eventCount: 1,
          preview: rawPreview,
        },
        {
          key: "locally-truncated",
          status: "completed",
          eventCount: 64,
          preview: rawPreview,
        },
        {
          key: "detail-count-truncated",
          status: "completed",
          eventCount: 1,
          preview: rawPreview,
        },
      ],
      traceDetails: {
        "detail-truncated": {
          key: "detail-truncated",
          status: "completed",
          eventCount: 1,
          preview: rawPreview,
          truncated: true,
          events: [singleEvent],
        },
        "locally-truncated": {
          key: "locally-truncated",
          status: "completed",
          eventCount: 64,
          preview: rawPreview,
          events: oversizedEvents,
        },
        "detail-count-truncated": {
          key: "detail-count-truncated",
          status: "completed",
          eventCount: 2,
          preview: rawPreview,
          events: [singleEvent],
        },
      },
    }))

    expect(inspector.element.querySelectorAll(".apc-inspector-trace-truncated")).toHaveLength(4)
    expect(inspector.element.textContent).toContain("en:inspector.previewTruncated")
    expect(inspector.element.textContent).toContain("en:inspector.additionalEventsOmitted")
    for (const position of [1, 2, 3, 4]) {
      expect(inspector.element.querySelector(
        `[data-inspector-trace-position="${position}"] .apc-inspector-trace-truncated`,
      )).not.toBeNull()
    }
    expect(inspector.element.querySelectorAll(
      "[data-inspector-trace-position='3'] .apc-inspector-trace-events > li",
    )).toHaveLength(64)
    expect(inspector.element.querySelectorAll(
      "[data-inspector-trace-position='4'] .apc-inspector-trace-events > li",
    )).toHaveLength(1)
    const html = inspector.element.outerHTML
    expect(html).not.toContain(rawPreview)
    expect(html).not.toContain("private-trace-secret")
    for (const key of ["summary-truncated", "detail-truncated", "locally-truncated", "detail-count-truncated"]) {
      expect(html).not.toContain(key)
    }
    inspector.destroy()
  })

  test("does not rearm Stop after a synchronous or asynchronous callback failure", async () => {
    let calls = 0
    const synchronous = mountInspector({
      onStop: () => {
        calls += 1
        throw new Error("private failure")
      },
    })
    synchronous.render(snapshot("running", { stoppable: true }))
    actionButton(synchronous, "stop")?.click()
    expect(calls).toBe(1)
    expect(actionButton(synchronous, "stop")).toBeNull()
    expect(synchronous.element.textContent).toContain("en:diagnostic.unknown")
    synchronous.destroy()

    const asynchronous = mountInspector({
      onStop: () => {
        calls += 1
        return Promise.reject(new Error("private failure"))
      },
    })
    asynchronous.render(snapshot("running", { stoppable: true }))
    actionButton(asynchronous, "stop")?.click()
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toBe(2)
    expect(actionButton(asynchronous, "stop")).toBeNull()
    asynchronous.destroy()
  })

  test("ignores out-of-contract transport fields and redacts opaque or private labels", () => {
    const executionId = "10000000-0000-4000-8000-000000000001"
    const presetId = "20000000-0000-4000-8000-000000000002"
    const connectionId = "30000000-0000-4000-8000-000000000003"
    const revision = "revision-private-4fd4dc3e"
    const receipt = "receipt-private-48a0"
    const privateText = "token=credential-private endpoint=https://private.example.test/v1 Authorization: Bearer authorization-private"
    const inspector = mountInspector({ onStop: () => undefined })
    const unsafeSnapshot = {
      status: "running",
      stoppable: true,
      executionId,
      presetId,
      stages: [{
        id: "40000000-0000-4000-8000-000000000004",
        label: "50000000-0000-4000-8000-000000000005",
        status: "running",
        runs: [{
          id: "60000000-0000-4000-8000-000000000006",
          label: "70000000-0000-4000-8000-000000000007",
          status: "running",
          dispatch: {
            source: "slot",
            connectionId,
            dispatchRevision: revision,
            purpose: receipt,
            descriptor: { label: privateText, provider: "Safe provider", model: "Safe model" },
          },
        }],
      }],
      error: { code: receipt, message: privateText, details: [{ path: revision, reason: privateText }] },
      trace: { preview: privateText, traceId: connectionId },
    } as unknown as ExecutionInspectorSnapshot
    inspector.render(unsafeSnapshot)

    const text = inspector.element.textContent ?? ""
    for (const secret of [executionId, presetId, connectionId, revision, receipt, "credential-private", "authorization-private", "private.example.test"]) {
      expect(text).not.toContain(secret)
      expect(inspector.element.outerHTML).not.toContain(secret)
    }
    expect(text).not.toContain("en:action.retry")
    expect(truncateInspectorText(privateText)).not.toContain("credential-private")
    inspector.destroy()
  })

  test("uses only allow-listed error catalog keys and safely falls back for unknown keys", () => {
    const inspector = mountInspector()
    inspector.render(snapshot("failed", {
      terminal: true,
      error: { category: "timeout", messageKey: "error.timeout" },
    }))
    expect(inspector.element.querySelector("[data-error-category=timeout]")?.textContent).toContain("en:error.timeout")

    inspector.render(snapshot("failed", {
      terminal: true,
      error: {
        category: "unknown",
        messageKey: "private.backend.error" as ApcCatalogKey,
      },
    }))
    const error = inspector.element.querySelector("[data-error-category=unknown]")?.textContent ?? ""
    expect(error).toContain("en:diagnostic.unknown")
    expect(error).not.toContain("private.backend.error")
    expect(error).not.toContain("private backend payload")
    inspector.destroy()
  })

  test("offers an explicit Main fallback configuration callback without retry semantics", async () => {
    let uses = 0
    const inspector = mountInspector({
      onUseMainFallback: async () => {
        uses += 1
      },
    })
    inspector.render(snapshot("idle", {
      view: "selected-run",
      canUseMainFallback: true,
      selection: {
        kind: "run",
        threadLabel: "Finalizer",
        run: { status: "pending", label: "Finalizer run", optional: false },
      },
    }))
    const fallback = actionButton(inspector, "use-main-fallback")
    expect(fallback).not.toBeNull()
    expect(fallback?.textContent).toContain("en:fallback.main")
    expect(inspector.element.textContent).not.toContain("en:action.retry")
    fallback?.click()
    await Promise.resolve()
    expect(uses).toBe(1)
    inspector.destroy()
  })

  test("offers one keyboard-accessible terminal return action without retrying or changing execution state", () => {
    let returns = 0
    let stops = 0
    const inspector = mountInspector({
      onBackToConfiguration: () => {
        returns += 1
      },
      onStop: () => {
        stops += 1
      },
      onLoadTrace: () => undefined,
    })
    const terminalCases: readonly ExecutionInspectorSnapshot[] = [
      snapshot("completed", {
        terminal: true,
        outcome: { class: "success" },
      }),
      snapshot("failed", {
        terminal: true,
        outcome: { class: "selected-final-failure", category: "provider" },
      }),
      snapshot("completed", {
        terminal: true,
        outcome: { class: "graph-fallback", category: "timeout" },
        fallback: { category: "timeout", mainResponded: true },
      }),
    ]

    for (const terminal of terminalCases) {
      inspector.render(terminal)
      const actions = inspector.element.querySelectorAll<HTMLButtonElement>("[data-apc-back-to-configuration]")
      expect(actions).toHaveLength(1)
      expect(actions[0]?.tagName).toBe("BUTTON")
      expect(actions[0]?.type).toBe("button")
      expect(actions[0]?.textContent).toBe("en:action.backToConfiguration")
      expect(actions[0]?.getAttribute("aria-label")).toBe("en:action.backToConfiguration")
      expect(actionButton(inspector, "retry")).toBeNull()
      expect(inspector.element.textContent).not.toContain("en:action.retry")
    }

    const unavailable: readonly ExecutionInspectorSnapshot[] = [
      snapshot("running"),
      snapshot("idle"),
      snapshot("idle", { terminal: true }),
    ]
    for (const current of unavailable) {
      inspector.render(current)
      expect(inspector.element.querySelector("[data-apc-back-to-configuration]")).toBeNull()
    }

    inspector.render(snapshot("completed", {
      terminal: true,
      outcome: { class: "success" },
      traces: [{ key: "retained-trace", status: "completed", eventCount: 1 }],
    }))
    const back = inspector.element.querySelector<HTMLButtonElement>("[data-apc-back-to-configuration]")
    expect(back).not.toBeNull()
    expect(inspector.element.querySelectorAll(".apc-inspector-trace")).toHaveLength(1)

    back?.click()
    expect(returns).toBe(1)
    expect(stops).toBe(0)
    expect(inspector.element.dataset.status).toBe("completed")
    expect(inspector.element.querySelectorAll(".apc-inspector-trace")).toHaveLength(1)

    back?.focus()
    expect(testDocument.activeElement).toBe(back)
    back?.dispatchEvent(new browser.window.MouseEvent("click", {
      bubbles: true,
      detail: 0,
    }))
    expect(returns).toBe(2)
    expect(stops).toBe(0)

    inspector.destroy()
    back?.click()
    expect(returns).toBe(2)

    const noCallback = mountInspector()
    noCallback.render(snapshot("completed", { terminal: true, outcome: { class: "success" } }))
    expect(noCallback.element.querySelector("[data-apc-back-to-configuration]")).toBeNull()
    noCallback.destroy()
  })

  test("renders one localized title in every view and rerenders visible and aria text for the current locale", () => {
    const inspector = mountInspector()
    const views = [
      ["idle", snapshot("idle", { view: "idle" })],
      ["selected-thread", snapshot("idle", {
        view: "selected-thread",
        selection: { kind: "thread", threadLabel: "Writer", workspaceSource: "main-context" },
      })],
      ["selected-run", snapshot("idle", {
        view: "selected-run",
        selection: {
          kind: "run",
          threadLabel: "Writer",
          run: { status: "pending", label: "Writer run" },
        },
      })],
      ["execution", snapshot("running", {
        progress: { stageIndex: 1, stageCount: 2 },
        stages: [{ status: "running", runs: [{ status: "running", label: "Writer" }] }],
      })],
    ] as const

    for (const [view, current] of views) {
      inspector.render(current)
      expect(inspector.element.dataset.inspectorView).toBe(view)
      const headings = inspector.element.querySelectorAll("h2.apc-inspector-title")
      expect(headings).toHaveLength(1)
      expect(headings[0]?.textContent).toBe("en:inspector.title")
      expect(inspector.element.getAttribute("aria-label")).toBe("en:inspector.title")
    }

    testLocale = "fr"
    for (const [view, current] of views) {
      inspector.render(current)
      expect(inspector.element.dataset.inspectorView).toBe(view)
      const headings = inspector.element.querySelectorAll("h2.apc-inspector-title")
      expect(headings).toHaveLength(1)
      expect(headings[0]?.textContent).toBe("fr:inspector.title")
      expect(inspector.element.textContent).not.toContain("en:inspector.title")
      expect(inspector.element.getAttribute("aria-label")).toBe("fr:inspector.title")
    }
    inspector.destroy()
  })

  test("announces live and terminal transitions and focuses the terminal outcome", () => {
    const announced: string[] = []
    const focused: HTMLElement[] = []
    const inspector = mountInspector({
      announce: message => announced.push(message),
      focus: element => focused.push(element),
    })
    inspector.render(snapshot("running", { progress: { stageIndex: 1, stageCount: 2 } }))
    inspector.render(snapshot("running", { progress: { stageIndex: 2, stageCount: 2 } }))
    inspector.render(snapshot("completed", { terminal: true, outcome: { class: "success" } }))

    expect(announced.filter(message => message.includes("en:execution.running"))).toHaveLength(1)
    expect(announced.some(message => message.includes("en:inspector.fieldValue"))).toBe(true)
    expect(announced.some(message => message.includes("en:a11y.outcomeAnnouncement"))).toBe(true)
    expect(focused).toHaveLength(1)
    expect(focused[0].dataset.inspectorOutcome).toBe("true")
    inspector.destroy()
  })

  test("tears down listeners, live region, focus work, and stale async settlement deterministically", async () => {
    let resolveStop: (() => void) | undefined
    const pending = new Promise<void>(resolve => {
      resolveStop = resolve
    })
    let cancellations = 0
    const inspector = mountInspector({
      onStop: () => {
        cancellations += 1
        return pending
      },
    })
    inspector.render(snapshot("running", { stoppable: true }))
    actionButton(inspector, "stop")?.click()
    expect(cancellations).toBe(1)

    inspector.destroy()
    resolveStop?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(inspector.element.isConnected).toBe(false)
    expect(inspector.element.childElementCount).toBe(0)

    const forged = testDocument.createElement("button")
    forged.dataset.inspectorAction = "stop"
    inspector.element.append(forged)
    forged.click()
    expect(cancellations).toBe(1)
    inspector.destroy()
  })
})
