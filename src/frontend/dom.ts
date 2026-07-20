export type Cleanup = () => void

export type MountParent = Element | DocumentFragment | Document

export interface OwnedMountOptions {
  readonly tag?: keyof HTMLElementTagNameMap
  readonly id?: string
  readonly className?: string
  readonly attributes?: Readonly<Record<string, string>>
  readonly ownerDocument?: Document
}

export interface OwnedMount {
  readonly element: HTMLElement
  readonly root: HTMLElement
  cleanup(): void
  remove(): void
}

export interface DomScope extends OwnedMount {
  createElement<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    attributes?: Readonly<Record<string, string>>,
  ): HTMLElementTagNameMap[K]
  append<T extends Node>(node: T): T
  listen<E extends Event = Event>(
    target: EventTarget,
    type: string,
    handler: (event: E) => void,
    options?: AddEventListenerOptions | boolean,
  ): Cleanup
  addCleanup(cleanup: Cleanup): Cleanup
}

interface GlobalDocument {
  document?: Document
}

function currentDocument(): Document | undefined {
  return (globalThis as typeof globalThis & GlobalDocument).document
}

function documentFor(parent: MountParent | undefined, options: OwnedMountOptions): Document {
  if (options.ownerDocument !== undefined) return options.ownerDocument
  if (parent !== undefined && typeof (parent as Document).createElement === "function") {
    return parent as Document
  }
  if (parent !== undefined && "ownerDocument" in parent && parent.ownerDocument !== null) {
    return parent.ownerDocument
  }
  const document = currentDocument()
  if (document !== undefined) return document
  throw new Error("An owner document is required to create an APC mount")
}

function parentFor(document: Document, parent: MountParent | undefined): MountParent {
  if (parent !== undefined) return parent
  const candidate = document.body ?? document.documentElement
  if (candidate === null || candidate === undefined) {
    throw new Error("An APC mount parent is unavailable")
  }
  return candidate
}

function appendTo(parent: MountParent, element: HTMLElement): void {
  parent.appendChild(element)
}

function removeFromParent(element: HTMLElement): void {
  if (typeof element.remove === "function") {
    element.remove()
    return
  }
  element.parentNode?.removeChild(element)
}

/** Set only extension-owned attributes; callers never need innerHTML for UI text. */
export function setAttributes<T extends Element>(
  element: T,
  attributes: Readonly<Record<string, string | null | undefined>>,
): T {
  for (const [name, value] of Object.entries(attributes)) {
    if (value === null || value === undefined) {
      element.removeAttribute(name === "className" ? "class" : name)
      continue
    }
    element.setAttribute(name === "className" ? "class" : name, value)
  }
  return element
}

/** Replace an extension-owned node's text without interpreting markup. */
export function setText<T extends Node>(node: T, text: string): T {
  node.textContent = text
  return node
}

/** Remove a node without throwing when it has already been detached. */
export function removeNode(node: Node | null | undefined): void {
  if (node === null || node === undefined) return
  const removable = node as Node & { remove?: () => void }
  if (typeof removable.remove === "function") {
    removable.remove()
    return
  }
  node.parentNode?.removeChild(node)
}

/** Register one event listener and return an idempotent disposer. */
export function listen<E extends Event = Event>(
  target: EventTarget,
  type: string,
  handler: (event: E) => void,
  options?: AddEventListenerOptions | boolean,
): Cleanup {
  let active = true
  const listener = handler as EventListener
  target.addEventListener(type, listener, options)
  return () => {
    if (!active) return
    active = false
    target.removeEventListener(type, listener, options)
  }
}

function applyMountOptions(element: HTMLElement, options: OwnedMountOptions): void {
  if (options.id !== undefined) element.id = options.id
  if (options.className !== undefined) element.className = options.className
  if (options.attributes !== undefined) setAttributes(element, options.attributes)
  element.setAttribute("data-apc-owned-mount", "")
}

function isMountParent(value: MountParent | OwnedMountOptions): value is MountParent {
  return "appendChild" in value
}

/**
 * Create one extension-owned mount node. Cleanup removes only this node and is
 * safe to call repeatedly, including after a host has detached the node.
 */
export function createOwnedMount(options?: OwnedMountOptions): OwnedMount
export function createOwnedMount(parent: MountParent, options?: OwnedMountOptions): OwnedMount
export function createOwnedMount(
  parentOrOptions?: MountParent | OwnedMountOptions,
  suppliedOptions?: OwnedMountOptions,
): OwnedMount {
  const parent = parentOrOptions !== undefined && isMountParent(parentOrOptions)
    ? parentOrOptions
    : undefined
  const options = parent === undefined && parentOrOptions !== undefined
    ? parentOrOptions as OwnedMountOptions
    : suppliedOptions ?? {}
  const document = documentFor(parent, options)
  const mountParent = parentFor(document, parent)
  const tag = options.tag ?? "div"
  const element = document.createElement(tag)
  applyMountOptions(element, options)
  appendTo(mountParent, element)

  let cleaned = false
  const cleanup = (): void => {
    if (cleaned) return
    cleaned = true
    removeFromParent(element)
  }
  return {
    element,
    root: element,
    cleanup,
    remove: cleanup,
  }
}

export interface DomScopeOptions extends OwnedMountOptions {
  readonly parent?: MountParent
}

/** Create a mount plus tracked child/listener cleanup for one UI surface. */
export function createDomScope(options: DomScopeOptions = {}): DomScope {
  const mount = options.parent !== undefined
    ? createOwnedMount(options.parent, options)
    : createOwnedMount(options)
  const cleanups = new Set<Cleanup>()
  let cleaned = false

  const addCleanup = (cleanup: Cleanup): Cleanup => {
    if (cleaned) {
      try {
        cleanup()
      } catch {
        // Late registrations cannot make an already-destroyed scope fail.
      }
      return () => {}
    }
    let active = true
    const ownedCleanup = (): void => {
      if (!active) return
      active = false
      cleanups.delete(ownedCleanup)
      try {
        cleanup()
      } catch {
        // One hostile disposer must not prevent the remaining scope cleanup.
      }
    }
    cleanups.add(ownedCleanup)
    return ownedCleanup
  }

  const scopeCleanup = (): void => {
    if (cleaned) return
    cleaned = true
    for (const cleanup of [...cleanups]) cleanup()
    cleanups.clear()
    try {
      mount.cleanup()
    } catch {
      // The scope owns the mount; teardown remains idempotent if a host DOM seam throws.
    }
  }

  return {
    element: mount.element,
    root: mount.root,
    createElement<K extends keyof HTMLElementTagNameMap>(
      tag: K,
      attributes?: Readonly<Record<string, string>>,
    ): HTMLElementTagNameMap[K] {
      const element = mount.element.ownerDocument.createElement(tag)
      if (attributes !== undefined) setAttributes(element, attributes)
      mount.element.appendChild(element)
      return element
    },
    append<T extends Node>(node: T): T {
      mount.element.appendChild(node)
      return node
    },
    listen<E extends Event = Event>(
      target: EventTarget,
      type: string,
      handler: (event: E) => void,
      options?: AddEventListenerOptions | boolean,
    ): Cleanup {
      return addCleanup(listen(target, type, handler, options))
    },
    addCleanup,
    cleanup: scopeCleanup,
    remove: scopeCleanup,
  }
}
