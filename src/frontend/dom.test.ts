// @ts-ignore Bun provides the test module at runtime; the extension bundle excludes this file.
import { describe, expect, test } from "bun:test"
import {
  createDomScope,
  createOwnedMount,
  listen,
  setAttributes,
  setText,
} from "./dom"

class FakeElement extends EventTarget {
  readonly ownerDocument: FakeDocument
  readonly children: FakeElement[] = []
  parentNode: FakeElement | null = null
  textContent: string | null = ""
  id = ""
  className = ""
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

  remove(): void {
    this.parentNode?.removeChild(this)
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

describe("APC DOM ownership helpers", () => {
  test("mount cleanup is idempotent and removes only the owned node", () => {
    const document = new FakeDocument()
    const sibling = document.body.appendChild(new FakeElement(document))
    const mount = createOwnedMount(document.body as unknown as Element, {
      ownerDocument: document as unknown as Document,
    })

    expect(document.body.children).toHaveLength(2)
    mount.cleanup()
    mount.cleanup()
    expect(document.body.children).toEqual([sibling])
  })

  test("scope tracks listeners and child nodes until one idempotent cleanup", () => {
    const document = new FakeDocument()
    const scope = createDomScope({
      parent: document.body as unknown as Element,
      ownerDocument: document as unknown as Document,
    })
    const child = scope.createElement("button", { type: "button" })
    let clicks = 0
    scope.listen(child, "click", () => {
      clicks += 1
    })

    child.dispatchEvent(new Event("click"))
    expect(clicks).toBe(1)
    expect(child.getAttribute("type")).toBe("button")
    scope.cleanup()
    scope.cleanup()
    child.dispatchEvent(new Event("click"))
    expect(clicks).toBe(1)
    expect(document.body.children).toHaveLength(0)
  })

  test("text and attributes never interpret markup", () => {
    const document = new FakeDocument()
    const element = document.createElement("div")
    setText(element as unknown as Node, "<b>not markup</b>")
    setAttributes(element as unknown as Element, { "aria-label": "label", title: null })
    expect(element.textContent).toBe("<b>not markup</b>")
    expect(element.getAttribute("aria-label")).toBe("label")
    expect(element.getAttribute("title")).toBeNull()
  })

  test("standalone listener cleanup can be called repeatedly", () => {
    const target = new EventTarget()
    let calls = 0
    const cleanup = listen(target, "event", () => {
      calls += 1
    })
    target.dispatchEvent(new Event("event"))
    cleanup()
    cleanup()
    target.dispatchEvent(new Event("event"))
    expect(calls).toBe(1)
  })
})
