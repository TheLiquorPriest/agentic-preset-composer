// @ts-ignore Bun provides the test module at runtime; the extension bundle excludes this file.
import { describe, expect, test } from "bun:test"
import {
  APC_EDITOR_REDUCED_MOTION_STYLE,
  APC_EDITOR_STYLE,
  installScopedStyles,
  removeScopedStyles,
} from "./styles"

class FakeElement extends EventTarget {
  readonly ownerDocument: FakeDocument
  readonly children: FakeElement[] = []
  parentNode: FakeElement | null = null
  textContent: string | null = ""
  private readonly attributes = new Map<string, string>()

  constructor(ownerDocument: FakeDocument) {
    super()
    this.ownerDocument = ownerDocument
  }

  appendChild<T extends FakeElement>(child: T): T {
    child.parentNode = this
    this.children.push(child)
    return child
  }

  removeChild<T extends FakeElement>(child: T): T {
    const index = this.children.indexOf(child)
    if (index >= 0) this.children.splice(index, 1)
    child.parentNode = null
    return child
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name)
  }
}

class FakeDocument extends EventTarget {
  readonly body = new FakeElement(this)
  readonly head = new FakeElement(this)
  readonly documentElement = new FakeElement(this)
  createElement(_tag: string): FakeElement {
    return new FakeElement(this)
  }
}

function cssBlock(source: string, marker: string): string {
  const markerIndex = source.indexOf(marker)
  if (markerIndex < 0) throw new Error(`Missing CSS block: ${marker}`)
  const open = source.indexOf("{", markerIndex + marker.length)
  if (open < 0) throw new Error(`Missing opening brace: ${marker}`)
  let depth = 1
  for (let index = open + 1; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1
    if (source[index] === "}") depth -= 1
    if (depth === 0) return source.slice(open + 1, index)
  }
  throw new Error(`Missing closing brace: ${marker}`)
}

function rule(source: string, selectors: readonly string[]): string {
  const normalized = source.replace(/\n\s+(?=:scope)/g, "\n").trimStart()
  return cssBlock(normalized, selectors.join(",\n"))
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
function selectorList(prelude: string): string[] {
  const selectors: string[] = []
  let start = 0
  let depth = 0
  let quote: '"' | "'" | null = null
  for (let index = 0; index < prelude.length; index += 1) {
    const character = prelude[index]
    if (quote !== null) {
      if (character === quote && prelude[index - 1] !== "\\") quote = null
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === "(" || character === "[") depth += 1
    else if (character === ")" || character === "]") depth -= 1
    else if (character === "," && depth === 0) {
      selectors.push(prelude.slice(start, index))
      start = index + 1
    }
  }
  selectors.push(prelude.slice(start))
  return selectors
}


function expectDeclarations(
  body: string,
  declarations: Readonly<Record<string, string>>,
): void {
  for (const [property, value] of Object.entries(declarations)) {
    expect(body).toMatch(
      new RegExp(`(?:^|\\n)\\s*${escapeRegExp(property)}:\\s*${escapeRegExp(value)};`),
    )
  }
}

function selectorPreludes(source: string): string[] {
  const selectors: string[] = []
  let cursor = 0
  while (cursor < source.length) {
    while (/\s/.test(source[cursor] ?? "")) cursor += 1
    if (cursor >= source.length) break
    const open = source.indexOf("{", cursor)
    if (open < 0) break
    const prelude = source.slice(cursor, open).trim()
    const body = cssBlock(source.slice(cursor), prelude)
    const consumed = source.slice(cursor).indexOf(body) + body.length + 2
    if (prelude.startsWith("@")) {
      selectors.push(...selectorPreludes(body))
    } else {
      selectors.push(prelude)
    }
    cursor += consumed
  }
  return selectors
}

describe("APC scoped styles", () => {
  test("installs a marked style, scopes :scope, and removes it idempotently", () => {
    const document = new FakeDocument()
    const root = document.body.appendChild(new FakeElement(document))
    const styles = installScopedStyles(":scope .button { color: red; }", {
      root: root as unknown as HTMLElement,
      document: document as unknown as Document,
      reducedMotionCss: ":scope * { transition: none; }",
    })

    expect(document.head.children).toHaveLength(1)
    expect(root.getAttribute("data-apc-scope")).toBe(styles.scope)
    expect((document.head.children[0]?.textContent ?? "")).toContain(styles.selector)
    expect((document.head.children[0]?.textContent ?? "")).toContain("prefers-reduced-motion")

    styles.cleanup()
    styles.remove()
    expect(document.head.children).toHaveLength(0)
    expect(root.getAttribute("data-apc-scope")).toBeNull()
  })

  test("lays out navigation, workspace, and configuration in exact semantic order", () => {
    const rootRule = rule(APC_EDITOR_STYLE, [":scope"])
    expectDeclarations(rootRule, {
      display: "grid",
      "grid-template-areas": '"threads graph inspector"',
    })
    expectDeclarations(rule(APC_EDITOR_STYLE, [':scope > [data-apc-panel="threads"]']), {
      "grid-area": "threads",
    })
    expectDeclarations(rule(APC_EDITOR_STYLE, [':scope > [data-apc-panel="graph"]']), {
      "grid-area": "graph",
    })
    expectDeclarations(rule(APC_EDITOR_STYLE, [':scope > [data-apc-panel="inspector"]']), {
      "grid-area": "inspector",
    })

    const intermediate = cssBlock(APC_EDITOR_STYLE, "@media (max-width: 72rem)")
    expect(rule(intermediate, [":scope"]).replace(/\s+/g, " ")).toContain(
      "grid-template-columns: minmax(0, 12rem) minmax(0, 1fr) minmax(0, 16rem);",
    )

    const mobile = cssBlock(APC_EDITOR_STYLE, "@media (max-width: 48rem)")
    const mobileRoot = rule(mobile, [":scope"]).replace(/\s+/g, " ")
    expect(mobileRoot).toContain("grid-template-columns: minmax(0, 1fr);")
    expect(mobileRoot).toContain('grid-template-areas: "threads" "graph" "inspector";')
    expectDeclarations(rule(mobile, [":scope > [data-apc-panel]"]), {
      "inline-size": "100%",
      "max-block-size": "none",
      overflow: "visible",
    })
  })

  test("uses its host container to stack panes without fixed minimum track overflow", () => {
    const rootRule = rule(APC_EDITOR_STYLE, [":scope"])
    expectDeclarations(rootRule, {
      "container-name": "apc-editor",
      "container-type": "inline-size",
      "min-inline-size": "0",
    })
    const normalizedRoot = rootRule.replace(/\s+/g, " ")
    expect(normalizedRoot).toContain(
      "grid-template-columns: minmax(0, 15rem) minmax(0, 1fr) minmax(0, 21rem);",
    )
    expect(normalizedRoot).not.toMatch(/minmax\((?:11rem|24rem|16rem),/)

    const narrowContainer = cssBlock(
      APC_EDITOR_STYLE,
      "@container apc-editor (max-width: 48rem)",
    )
    expectDeclarations(rule(narrowContainer, [":scope > [data-apc-panel]"]), {
      "grid-area": "auto",
      "grid-column": "1 / -1",
      "inline-size": "100%",
      "max-block-size": "none",
      overflow: "visible",
    })
  })

  test("uses a fixed consent layer that blocks APC panes behind a dark scrim", () => {
    expectDeclarations(rule(APC_EDITOR_STYLE, [":scope:has(.apc-consent-review)::before"]), {
      content: '""',
      position: "fixed",
      inset: "0",
      "z-index": "var(--apc-layer-scrim)",
      background: "var(--lumiverse-modal-backdrop, var(--lumiverse-fill-heavy, GrayText))",
      "pointer-events": "auto",
    })
    expectDeclarations(
      rule(APC_EDITOR_STYLE, [":scope:has(.apc-consent-review) > [data-apc-panel]"]),
      {
        "pointer-events": "none",
        "user-select": "none",
      },
    )
    expectDeclarations(rule(APC_EDITOR_STYLE, [":scope .apc-consent-review"]), {
      position: "fixed",
      "inset-block-start": "50%",
      "inset-inline-start": "50%",
      "z-index": "var(--apc-layer-dialog)",
      "max-block-size": "calc(100dvh - 2rem)",
      overflow: "auto",
      "pointer-events": "auto",
      transform: "translate(-50%, -50%)",
    })
  })

  test("gives selected items and graph flow observable accent treatments", () => {
    expectDeclarations(rule(APC_EDITOR_STYLE, [':scope [data-selected="true"]']), {
      "border-color": "var(--apc-accent-border)",
      "box-shadow": "inset .25rem 0 0 var(--apc-accent)",
    })
    expectDeclarations(
      rule(APC_EDITOR_STYLE, [
        ':scope [data-apc-topology="parallel"] .apc-stage-runs::after',
      ]),
      {
        content: '""',
        position: "absolute",
        "border-block-end": ".125rem solid var(--apc-accent-border)",
      },
    )
    expectDeclarations(
      rule(APC_EDITOR_STYLE, [
        ":scope [data-apc-causal-chain] > .apc-stage-card:not(:last-child)::after",
      ]),
      {
        content: '"↓"',
        color: "var(--apc-accent)",
      },
    )
  })

  test("pairs every execution palette with a distinct border and shape", () => {
    const completed = [
      ':scope [data-badge-kind="completed"]',
      ':scope [data-inspector-status="completed"]',
      ':scope [data-status-kind="completed"]',
      ':scope [data-activity-status="completed"]',
      ':scope [data-current-run-status="completed"]',
      ':scope [data-stage-status="completed"]',
      ':scope [data-run-status="completed"]',
      ':scope [data-outcome-class="success"]',
    ]
    expectDeclarations(rule(APC_EDITOR_STYLE, completed), {
      color: "var(--apc-success)",
      background: "var(--apc-success-soft)",
      "border-color": "var(--apc-success-border)",
      "border-style": "solid",
    })
    expectDeclarations(
      rule(APC_EDITOR_STYLE, [':scope [data-activity-status="completed"] > :where(.apc-run-status, .apc-stage-status, .apc-final-route-status)::before']),
      { content: '"✓"' },
    )

    const running = [
      ':scope [data-badge-kind="running"]',
      ':scope [data-inspector-status="running"]',
      ':scope [data-status-kind="running"]',
      ':scope [data-activity-status="running"]',
      ':scope [data-current-run-status="running"]',
      ':scope [data-stage-status="running"]',
      ':scope [data-run-status="running"]',
      ':scope [data-badge-kind="required"]',
    ]
    expectDeclarations(rule(APC_EDITOR_STYLE, running), {
      color: "var(--apc-accent-text)",
      background: "var(--apc-accent-soft)",
      "border-color": "var(--apc-accent-border)",
      "border-style": "double",
    })
    expectDeclarations(
      rule(APC_EDITOR_STYLE, [':scope [data-activity-status="running"] > :where(.apc-run-status, .apc-stage-status, .apc-final-route-status)::before']),
      { content: '"●"', "border-style": "double" },
    )

    const pending = [
      ':scope [data-badge-kind="pending"]',
      ':scope [data-badge-kind="skipped"]',
      ':scope [data-badge-kind="optional"]',
      ':scope [data-badge-kind="cancelled"]',
      ':scope [data-inspector-status="cancelled"]',
      ':scope [data-status-kind="pending"]',
      ':scope [data-status-kind="skipped"]',
      ':scope [data-status-kind="cancelled"]',
      ':scope [data-activity-status="pending"]',
      ':scope [data-activity-status="skipped"]',
      ':scope [data-activity-status="cancelled"]',
      ':scope [data-current-run-status="pending"]',
      ':scope [data-current-run-status="skipped"]',
      ':scope [data-current-run-status="cancelled"]',
      ':scope [data-stage-status="pending"]',
      ':scope [data-stage-status="skipped"]',
      ':scope [data-stage-status="cancelled"]',
      ':scope [data-run-status="pending"]',
      ':scope [data-run-status="skipped"]',
      ':scope [data-run-status="cancelled"]',
      ':scope [data-outcome-class="parent-cancel"]',
    ]
    expectDeclarations(rule(APC_EDITOR_STYLE, pending), {
      color: "var(--apc-text-muted)",
      background: "var(--apc-surface-card)",
      "border-color": "var(--apc-border-strong)",
      "border-style": "dashed",
    })
    const failed = [
      ':scope [data-badge-kind="failed"]',
      ':scope [data-badge-kind="timed-out"]',
      ':scope [data-inspector-status="failed"]',
      ':scope [data-inspector-status="timed-out"]',
      ':scope [data-status-kind="failed"]',
      ':scope [data-status-kind="timed-out"]',
      ':scope [data-activity-status="failed"]',
      ':scope [data-activity-status="timed-out"]',
      ':scope [data-current-run-status="failed"]',
      ':scope [data-current-run-status="timed-out"]',
      ':scope [data-stage-status="failed"]',
      ':scope [data-stage-status="timed-out"]',
      ':scope [data-run-status="failed"]',
      ':scope [data-run-status="timed-out"]',
      ':scope [data-outcome-class="optional-local"]',
      ':scope [data-outcome-class="selected-final-failure"]',
      ':scope [data-outcome-class="integrity-fatal"]',
    ]
    expectDeclarations(rule(APC_EDITOR_STYLE, failed), {
      color: "var(--apc-danger)",
      background: "var(--apc-danger-soft)",
      "border-color": "var(--apc-danger-border)",
      "border-style": "solid",
    })

    expectDeclarations(
      rule(APC_EDITOR_STYLE, [':scope [data-activity-status="pending"] > :where(.apc-run-status, .apc-stage-status, .apc-final-route-status)::before']),
      { content: '"○"', "border-style": "dashed" },
    )
    expectDeclarations(
      rule(APC_EDITOR_STYLE, [':scope [data-activity-status="failed"] > :where(.apc-run-status, .apc-stage-status, .apc-final-route-status)::before', ':scope [data-activity-status="timed-out"] > :where(.apc-run-status, .apc-stage-status, .apc-final-route-status)::before']),
      { content: '"×"', "border-radius": "var(--apc-radius-compact)" },
    )

    const fallback = [
      ':scope [data-outcome-class="graph-fallback"]',
      ':scope [data-outcome="graph-fallback"]',
      ':scope [data-badge-kind="graph-fallback"]',
      ':scope [data-inspector-status="graph-fallback"]',
      ':scope [data-status-kind="graph-fallback"]',
    ]
    expectDeclarations(rule(APC_EDITOR_STYLE, fallback), {
      color: "var(--apc-warning)",
      background: "var(--apc-warning-soft)",
      "border-color": "var(--apc-warning-border)",
      "border-style": "double",
    })
    expectDeclarations(
      rule(APC_EDITOR_STYLE, [':scope [data-activity-status="graph-fallback"] > :where(.apc-run-status, .apc-stage-status, .apc-final-route-status)::before']),
      { content: '"◆"', "border-radius": "var(--apc-radius-compact)" },
    )
  })

  test("styles first-use actions, unavailable reasons, and bottom action rows", () => {
    expectDeclarations(
      rule(APC_EDITOR_STYLE, [
        ":scope .apc-graph-empty > .apc-card-actions:not([data-apc-unavailable-graph-actions])",
      ]),
      {
        display: "grid",
        "grid-template-columns": "repeat(2, minmax(0, 1fr))",
      },
    )
    expectDeclarations(rule(APC_EDITOR_STYLE, [":scope [data-apc-unavailable-graph-actions]"]), {
      padding: ".625rem",
      border: ".0625rem dashed var(--apc-border-strong)",
    })
    expectDeclarations(
      rule(APC_EDITOR_STYLE, [
        ":scope [data-apc-unavailable-graph-actions] + .apc-disabled-reason",
      ]),
      {
        "padding-inline-start": ".625rem",
        "border-inline-start": ".1875rem solid var(--apc-border-strong)",
      },
    )
    expectDeclarations(rule(APC_EDITOR_STYLE, [":scope .apc-stage-list > .apc-card-actions"]), {
      position: "sticky",
      "inset-block-end": "0",
      order: "20",
      "border-block-start": ".0625rem solid var(--apc-border-strong)",
    })
  })

  test("contains dense forms and hostile labels without clipping translations", () => {
    const controls = [
      ":scope .apc-field input",
      ":scope .apc-field textarea",
      ":scope .apc-field select",
      ':scope [data-apc-thread-editor] input:not([type="checkbox"]):not([type="radio"])',
      ":scope [data-apc-thread-editor] textarea",
      ":scope [data-apc-thread-editor] select",
      ":scope [data-apc-connection-slot-label]",
    ]
    expectDeclarations(rule(APC_EDITOR_STYLE, controls), {
      "inline-size": "100%",
      "min-inline-size": "0",
      "max-inline-size": "100%",
    })
    expectDeclarations(rule(APC_EDITOR_STYLE, [":scope .apc-inspector-field"]), {
      display: "grid",
      "grid-template-columns": "minmax(5.5rem, auto) minmax(0, 1fr)",
      "min-inline-size": "0",
    })
    expectDeclarations(rule(APC_EDITOR_STYLE, [":scope .apc-inspector-field-value"]), {
      "min-inline-size": "0",
      "overflow-wrap": "anywhere",
    })
  })

  test("keeps focus, forced colors, reduced motion, and selector scope explicit", () => {
    const focusSelectors = [
      ":scope button:focus-visible",
      ":scope input:focus-visible",
      ":scope select:focus-visible",
      ":scope textarea:focus-visible",
      ":scope [tabindex]:focus-visible",
      ":scope summary:focus-visible",
    ]
    expectDeclarations(rule(APC_EDITOR_STYLE, focusSelectors), {
      outline: ".1875rem solid var(--apc-accent)",
      "outline-offset": ".125rem",
      "box-shadow": "0 0 0 .125rem var(--apc-surface-root)",
    })

    const forced = cssBlock(APC_EDITOR_STYLE, "@media (forced-colors: active)")
    expectDeclarations(
      rule(forced, [
        ":scope",
        ":scope > [data-apc-panel]",
        ":scope button",
        ":scope input",
        ":scope select",
        ":scope textarea",
        ":scope fieldset",
        ":scope .apc-stage-card",
        ":scope .apc-run-card",
        ":scope .apc-final-response",
        ":scope .apc-consent-review",
        ":scope .apc-inspector-section",
        ":scope .apc-inspector-error",
        ":scope .apc-inspector-stop-control",
        ":scope .apc-inspector-activity-error",
        ":scope .apc-inspector-error-message",
        ":scope .apc-inspector-stop-warning",
        ":scope [data-activity-status]",
        ":scope [data-current-run-status]",
        ":scope [data-stage-status]",
        ":scope [data-run-status]",
        ":scope [data-status-kind]",
        ":scope [data-badge-kind]",
        ":scope [data-inspector-status]",
        ":scope [data-outcome-class]",
      ]),
      {
        color: "CanvasText",
        background: "Canvas",
        "border-color": "CanvasText",
        "forced-color-adjust": "auto",
      },
    )
    expect(APC_EDITOR_REDUCED_MOTION_STYLE).toContain("transition-duration: 0.001ms !important;")

    const preludes = selectorPreludes(APC_EDITOR_STYLE)
    expect(preludes.length).toBeGreaterThan(0)
    for (const prelude of preludes) {
      for (const selector of selectorList(prelude)) {
        expect(selector.trim().startsWith(":scope")).toBe(true)
      }
    }
    expect(APC_EDITOR_STYLE).not.toMatch(/#[\da-f]{3,8}\b/i)
    expect(APC_EDITOR_STYLE).not.toMatch(/\dpx\b/)
    expect((APC_EDITOR_STYLE.match(/{/g) ?? [])).toHaveLength(
      (APC_EDITOR_STYLE.match(/}/g) ?? []).length,
    )
  })

  test("raw removal is limited to extension-owned style nodes", () => {
    const document = new FakeDocument()
    const foreign = document.head.appendChild(new FakeElement(document))
    const owned = installScopedStyles("body { color: black; }", {
      document: document as unknown as Document,
    })

    removeScopedStyles(foreign as unknown as HTMLStyleElement)
    expect(document.head.children).toContain(foreign)
    removeScopedStyles(owned.element)
    expect(document.head.children).toEqual([foreign])
  })
})
