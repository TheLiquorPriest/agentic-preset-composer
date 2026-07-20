// @ts-ignore Bun provides the test module at runtime; the extension bundle excludes this file.
import { describe, expect, test } from "bun:test"
import {
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

  test("lays out the stable panel mount as Threads, Graph, Inspector", () => {
    const document = new FakeDocument()
    const root = document.body.appendChild(new FakeElement(document))
    const graph = root.appendChild(new FakeElement(document))
    graph.setAttribute("data-apc-panel", "graph")
    const threads = root.appendChild(new FakeElement(document))
    threads.setAttribute("data-apc-panel", "threads")
    const inspector = root.appendChild(new FakeElement(document))
    inspector.setAttribute("data-apc-panel", "inspector")

    const styles = installScopedStyles(APC_EDITOR_STYLE, {
      root: root as unknown as HTMLElement,
      document: document as unknown as Document,
    })
    const css = styles.element.textContent ?? ""

    expect(root.children).toEqual([graph, threads, inspector])
    expect(css).toContain("grid-template-columns:")
    expect(css).toContain("minmax(12rem, 1fr)")
    expect(css).toContain("minmax(20rem, 2fr)")
    expect(css).toContain("minmax(14rem, 1fr)")
    expect(css).toContain('grid-template-areas: "threads graph inspector";')
    expect(css).toContain(`${styles.selector} > [data-apc-panel="threads"] {\n  grid-area: threads;`)
    expect(css).toContain(`${styles.selector} > [data-apc-panel="graph"] {\n  grid-area: graph;`)
    expect(css).toContain(`${styles.selector} > [data-apc-panel="inspector"] {\n  grid-area: inspector;`)
    expect(css).toContain("grid-template-columns: minmax(0, 1fr);")
    expect(css).toContain('grid-template-areas:\n      "threads"\n      "graph"\n      "inspector";')
    expect(css).not.toMatch(/\border\s*:/)
    const selectorLines = APC_EDITOR_STYLE
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.endsWith("{") && !line.startsWith("@"))
    expect(selectorLines.length).toBeGreaterThan(0)
    expect(selectorLines.every((line) => line.startsWith(":scope"))).toBe(true)
    expect(APC_EDITOR_STYLE).not.toMatch(/^\s*:\s*$/m)
    expect((APC_EDITOR_STYLE.match(/{/g) ?? [])).toHaveLength((APC_EDITOR_STYLE.match(/}/g) ?? []).length)

    styles.cleanup()
  })

  test("uses scoped host-token status language with forced-colors support", () => {
    expect(APC_EDITOR_STYLE).toContain("color: var(--lumiverse-text, CanvasText);")
    expect(APC_EDITOR_STYLE).toContain("background: var(--lumiverse-bg, Canvas);")
    expect(APC_EDITOR_STYLE).toContain("background: var(--lumiverse-fill-subtle, transparent);")
    expect(APC_EDITOR_STYLE).toContain("border: 0.0625rem solid var(--lumiverse-border, currentColor);")
    expect(APC_EDITOR_STYLE).toContain("var(--lumiverse-accent, var(--lumiverse-primary, Highlight))")
    expect(APC_EDITOR_STYLE).toContain(
      "color: var(--lumiverse-accent-fg, var(--lumiverse-text, CanvasText));",
    )
    expect(APC_EDITOR_STYLE).not.toMatch(
      /var\(--(?:text-primary|surface-primary|surface-secondary|border-subtle|text-on-accent|accent|text-danger|focus-ring)(?:,|\))/,
    )
    expect(APC_EDITOR_STYLE).not.toMatch(/\dpx\b/)
    expect(APC_EDITOR_STYLE).toContain(':scope [data-badge-kind="completed"]')
    expect(APC_EDITOR_STYLE).toContain(':scope [data-inspector-status="running"]')
    expect(APC_EDITOR_STYLE).toContain(':scope [data-outcome-class="integrity-fatal"]')
    expect(APC_EDITOR_STYLE).toContain(':scope [data-activity-status="failed"]')
    expect(APC_EDITOR_STYLE).toContain(':scope [data-current-run-status="timed-out"]')
    expect(APC_EDITOR_STYLE).toContain("color: var(--lumiverse-success);")
    expect(APC_EDITOR_STYLE).toContain("color: var(--lumiverse-primary);")
    expect(APC_EDITOR_STYLE).toContain("color: var(--lumiverse-warning);")
    expect(APC_EDITOR_STYLE).toContain("color: var(--lumiverse-danger);")
    expect(APC_EDITOR_STYLE).toMatch(
      /\[data-badge-kind="cancelled"\],[\s\S]*?\[data-outcome-class="parent-cancel"\] \{\n  color: var\(--lumiverse-text-muted\);/,
    )
    expect(APC_EDITOR_STYLE).toMatch(
      /\[data-outcome-class="graph-fallback"\] \{\n  color: var\(--lumiverse-warning\);/,
    )
    expect(APC_EDITOR_STYLE).toMatch(
      /\[data-outcome-class="optional-local"\],[\s\S]*?\{\n  color: var\(--lumiverse-danger\);/,
    )
    expect(APC_EDITOR_STYLE).toContain("@media (forced-colors: active)")
    expect(APC_EDITOR_STYLE).toContain("forced-color-adjust: auto;")
    expect(APC_EDITOR_STYLE).not.toMatch(/#[\da-f]{3,8}\b/i)
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
