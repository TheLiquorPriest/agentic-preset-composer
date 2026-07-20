// @ts-ignore Bun provides the test module at runtime; the extension bundle excludes this file.
import { describe, expect, test } from "bun:test"
import {
  createFocusTrap,
  createLiveRegion,
  createRovingTabIndex,
  createStatusRegion,
  getFocusableElements,
  observeReducedMotion,
  prefersReducedMotion,
  setStatus,
  setVisibleFocus,
} from "./accessibility"

class FakeClassList {
  constructor(private readonly element: FakeElement) {}

  add(name: string): void {
    const values = new Set(this.element.className.split(/\s+/).filter(Boolean))
    values.add(name)
    this.element.className = [...values].join(" ")
  }

  remove(name: string): void {
    this.element.className = this.element.className
      .split(/\s+/)
      .filter((value) => value !== name && value.length > 0)
      .join(" ")
  }
}

class FakeElement extends EventTarget {
  readonly ownerDocument: FakeDocument
  readonly children: FakeElement[] = []
  readonly classList = new FakeClassList(this)
  parentNode: FakeElement | null = null
  textContent: string | null = ""
  className = ""
  private readonly attributes = new Map<string, string>()

  constructor(ownerDocument: FakeDocument) {
    super()
    this.ownerDocument = ownerDocument
  }

  get parentElement(): FakeElement | null {
    return this.parentNode
  }

  get isConnected(): boolean {
    return this.parentNode !== null
  }

  get tabIndex(): number {
    const value = this.attributes.get("tabindex")
    return value === undefined ? -1 : Number(value)
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

  focus(): void {
    this.ownerDocument.activeElement = this
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

  removeAttribute(name: string): void {
    this.attributes.delete(name)
  }

  contains(node: FakeElement): boolean {
    let current: FakeElement | null = node
    while (current !== null) {
      if (current === this) return true
      current = current.parentNode
    }
    return false
  }

  querySelectorAll<T extends FakeElement>(_selector: string): T[] {
    return this.children as T[]
  }

  closest(_selector: string): FakeElement | null {
    return this
  }

  remove(): void {
    this.parentNode?.removeChild(this)
  }
}

class FakeDocument extends EventTarget {
  readonly body = new FakeElement(this)
  readonly head = new FakeElement(this)
  readonly documentElement = new FakeElement(this)
  activeElement: FakeElement | null = null

  createElement(_tag: string): FakeElement {
    return new FakeElement(this)
  }
}

class KeyEvent extends Event {
  readonly key: string
  readonly shiftKey: boolean

  constructor(key: string, shiftKey = false) {
    super("keydown", { cancelable: true })
    this.key = key
    this.shiftKey = shiftKey
  }
}

class FakeMediaQueryList extends EventTarget {
  matches: boolean

  constructor(matches: boolean) {
    super()
    this.matches = matches
  }

  addListener(listener: EventListener): void {
    this.addEventListener("change", listener)
  }

  removeListener(listener: EventListener): void {
    this.removeEventListener("change", listener)
  }

  change(matches: boolean): void {
    this.matches = matches
    this.dispatchEvent(new Event("change"))
  }
}

describe("APC accessibility helpers", () => {
  test("focus trap wraps Tab, reports Escape, and restores prior focus once", () => {
    const document = new FakeDocument()
    const outside = document.body.appendChild(new FakeElement(document))
    const modal = document.body.appendChild(new FakeElement(document))
    const first = modal.appendChild(new FakeElement(document))
    const last = modal.appendChild(new FakeElement(document))
    first.setAttribute("tabindex", "0")
    last.setAttribute("tabindex", "0")
    outside.setAttribute("tabindex", "0")
    outside.focus()
    let escapes = 0
    const trap = createFocusTrap(modal as unknown as HTMLElement, {
      document: document as unknown as Document,
      onEscape: () => {
        escapes += 1
      },
    })

    trap.activate()
    expect(document.activeElement).toBe(first)
    document.activeElement = last
    const tab = new KeyEvent("Tab")
    modal.dispatchEvent(tab)
    expect(tab.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(first)
    modal.dispatchEvent(new KeyEvent("Escape"))
    expect(escapes).toBe(1)
    trap.cleanup()
    trap.cleanup()
    expect(document.activeElement).toBe(outside)
    expect(trap.active).toBe(false)
  })

  test("roving tabindex traverses controls and restores original attributes", () => {
    const document = new FakeDocument()
    const root = document.body.appendChild(new FakeElement(document))
    const first = root.appendChild(new FakeElement(document))
    const second = root.appendChild(new FakeElement(document))
    const third = root.appendChild(new FakeElement(document))
    for (const item of [first, second, third]) item.setAttribute("role", "tab")
    second.setAttribute("tabindex", "0")
    const roving = createRovingTabIndex(root as unknown as HTMLElement, {
      orientation: "horizontal",
    })

    expect(roving.getIndex()).toBe(1)
    expect(first.getAttribute("tabindex")).toBe("-1")
    expect(second.getAttribute("tabindex")).toBe("0")
    root.dispatchEvent(new KeyEvent("ArrowRight"))
    expect(roving.getIndex()).toBe(2)
    expect(document.activeElement).toBe(third)
    root.dispatchEvent(new KeyEvent("Home"))
    expect(roving.getIndex()).toBe(0)
    roving.cleanup()
    roving.cleanup()
    expect(first.getAttribute("tabindex")).toBeNull()
    expect(second.getAttribute("tabindex")).toBe("0")
    expect(third.getAttribute("tabindex")).toBeNull()
  })

  test("live regions update polite/assertive announcements and clean up", () => {
    const document = new FakeDocument()
    const root = document.body.appendChild(new FakeElement(document))
    const polite = createStatusRegion(root as unknown as HTMLElement, {
      document: document as unknown as Document,
      label: "Status",
    })
    polite.announce("Saved")
    expect(polite.element.getAttribute("role")).toBe("status")
    expect(polite.element.getAttribute("aria-live")).toBe("polite")
    expect(polite.element.textContent).toBe("Saved")
    polite.cleanup()
    polite.cleanup()

    const assertive = createLiveRegion(root as unknown as HTMLElement, {
      document: document as unknown as Document,
      priority: "assertive",
    })
    assertive.announce("Error")
    expect(assertive.element.getAttribute("role")).toBe("alert")
    expect(assertive.element.textContent).toBe("Error")
    assertive.remove()
    expect(root.children).toHaveLength(0)
  })

  test("status and visible-focus semantics stay on the supplied node", () => {
    const document = new FakeDocument()
    const element = document.body.appendChild(new FakeElement(document))
    setStatus(element as unknown as HTMLElement, "Ready")
    expect(element.getAttribute("role")).toBe("status")
    expect(element.textContent).toBe("Ready")
    setVisibleFocus(element as unknown as Element)
    expect(element.getAttribute("data-apc-focus-visible")).toBe("")
    expect(element.className).toContain("apc-focus-visible")
    setVisibleFocus(element as unknown as Element, false)
    expect(element.getAttribute("data-apc-focus-visible")).toBeNull()
  })

  test("reduced-motion preference can be read and observed through a minimal media seam", () => {
    const media = new FakeMediaQueryList(true)
    const source = { matchMedia: (_query: string): MediaQueryList => media as unknown as MediaQueryList }
    expect(prefersReducedMotion(source)).toBe(true)
    const values: boolean[] = []
    const cleanup = observeReducedMotion((reduced) => values.push(reduced), source)
    media.change(false)
    cleanup()
    media.change(true)
    expect(values).toEqual([true, false])
  })

  test("focusable descendants are returned in DOM order", () => {
    const document = new FakeDocument()
    const root = document.body.appendChild(new FakeElement(document))
    const disabled = root.appendChild(new FakeElement(document))
    const first = root.appendChild(new FakeElement(document))
    const second = root.appendChild(new FakeElement(document))
    disabled.setAttribute("tabindex", "0")
    disabled.setAttribute("aria-disabled", "true")
    first.setAttribute("tabindex", "0")
    second.setAttribute("tabindex", "1")
    expect(getFocusableElements(root as unknown as Element)).toEqual([first, second])
  })
})
