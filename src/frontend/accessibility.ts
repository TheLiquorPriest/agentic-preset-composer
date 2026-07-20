import { listen, setAttributes, setText, type Cleanup } from "./dom"

const DEFAULT_FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  "[contenteditable=\"true\"]",
  "[tabindex]:not([tabindex=\"-1\"])",
].join(",")

const DEFAULT_ROVING_SELECTOR = [
  "[data-roving-item]",
  "[role=tab]",
  "[role=radio]",
  "[role=option]",
  "button:not([disabled])",
].join(",")

export interface FocusTrapOptions {
  readonly initialFocus?: Element | (() => Element | null)
  readonly restoreFocus?: boolean
  readonly onEscape?: (event: KeyboardEvent) => void
  readonly document?: Document
}

export interface FocusTrap {
  readonly active: boolean
  activate(): void
  deactivate(): void
  cleanup(): void
}

export interface RovingTabIndexOptions {
  readonly orientation?: "horizontal" | "vertical" | "both"
  readonly selector?: string
  readonly initialIndex?: number
  readonly wrap?: boolean
  readonly onChange?: (element: HTMLElement, index: number) => void
}

export interface RovingTabIndex {
  readonly index: number
  getIndex(): number
  setIndex(index: number, focus?: boolean): void
  refresh(): void
  cleanup(): void
}

export type LivePriority = "polite" | "assertive"

export interface LiveRegionOptions {
  readonly priority?: LivePriority
  readonly label?: string
  readonly className?: string
  readonly document?: Document
}

export interface LiveRegion {
  readonly element: HTMLElement
  announce(message: string): void
  clear(): void
  cleanup(): void
  remove(): void
}

export interface VisibleFocusOptions {
  readonly className?: string
  readonly attribute?: string
}

export interface ReducedMotionSource {
  matchMedia(query: string): MediaQueryList
}

interface GlobalWindow {
  matchMedia?: (query: string) => MediaQueryList
}

function ownerDocumentFor(container: Element, supplied?: Document): Document {
  if (supplied !== undefined) return supplied
  if (container.ownerDocument !== null && container.ownerDocument !== undefined) {
    return container.ownerDocument
  }
  const globalDocument = (globalThis as typeof globalThis & { document?: Document }).document
  if (globalDocument !== undefined) return globalDocument
  throw new Error("An owner document is required for APC accessibility helpers")
}

function focusMethod(element: Element): ((options?: FocusOptions) => void) | undefined {
  const candidate = element as Element & { focus?: (options?: FocusOptions) => void }
  return typeof candidate.focus === "function" ? candidate.focus.bind(candidate) : undefined
}

/** Focus an element when the host/browser exposes the normal focus seam. */
export function focusElement(element: Element | null | undefined): boolean {
  if (element === null || element === undefined) return false
  const focus = focusMethod(element)
  if (focus === undefined) return false
  try {
    focus({ preventScroll: true })
  } catch {
    try {
      focus()
    } catch {
      return false
    }
  }
  return true
}

function isHiddenOrDisabled(element: HTMLElement): boolean {
  if (element.getAttribute("aria-hidden") === "true") return true
  if (element.hasAttribute("hidden")) return true
  if ((element as HTMLElement & { hidden?: boolean }).hidden === true) return true
  if ((element as HTMLElement & { disabled?: boolean }).disabled === true) return true
  if (element.getAttribute("aria-disabled") === "true") return true
  if (element.getAttribute("data-disabled") === "true") return true
  return false
}

/** Return currently tabbable descendants in DOM order. */
export function getFocusableElements(
  container: Element,
  selector: string = DEFAULT_FOCUSABLE_SELECTOR,
): HTMLElement[] {
  let candidates: HTMLElement[]
  try {
    candidates = [...container.querySelectorAll<HTMLElement>(selector)]
  } catch {
    return []
  }
  return candidates.filter((element) => {
    if (isHiddenOrDisabled(element)) return false
    if (element.isConnected === false) return false
    return element.tabIndex >= 0
  })
}

function elementIsInside(container: Element, element: Element): boolean {
  if (element === container) return true
  const contains = (container as Element & { contains?: (node: Node) => boolean }).contains
  if (typeof contains === "function") return contains.call(container, element)
  let current: Element | null = element.parentElement
  while (current !== null) {
    if (current === container) return true
    current = current.parentElement
  }
  return false
}

function resolveInitialFocus(
  container: HTMLElement,
  option: Element | (() => Element | null) | undefined,
): Element | null {
  let selected: Element | null | undefined
  try {
    selected = typeof option === "function" ? option() : option
  } catch {
    selected = null
  }
  if (selected !== undefined && selected !== null && elementIsInside(container, selected)) {
    return selected
  }
  return getFocusableElements(container)[0] ?? null
}

/**
 * Trap Tab navigation inside a modal-like extension surface. Escape is
 * reported to the owner; owner cleanup then restores the prior focus target.
 */
export function createFocusTrap(
  container: HTMLElement,
  options: FocusTrapOptions = {},
): FocusTrap {
  const document = ownerDocumentFor(container, options.document)
  const restoreFocus = options.restoreFocus !== false
  let previousFocus: Element | null = null
  let capturedFocus = false
  let active = false
  let cleaned = false
  let keydownCleanup: Cleanup | undefined
  let containerTabIndex: string | null = null
  let addedContainerTabIndex = false

  const ensureContainerFocusable = (): void => {
    if (container.hasAttribute("tabindex")) return
    containerTabIndex = null
    container.setAttribute("tabindex", "-1")
    addedContainerTabIndex = true
  }

  const restoreContainerTabIndex = (): void => {
    if (!addedContainerTabIndex) return
    if (containerTabIndex === null) container.removeAttribute("tabindex")
    else container.setAttribute("tabindex", containerTabIndex)
    addedContainerTabIndex = false
  }

  const handleKeydown = (event: Event): void => {
    const keyboardEvent = event as KeyboardEvent
    if (keyboardEvent.key === "Escape" || keyboardEvent.key === "Esc") {
      keyboardEvent.preventDefault()
      try {
        options.onEscape?.(keyboardEvent)
      } catch {
        // Host escape handlers must not break the focus trap.
      }
      return
    }
    if (keyboardEvent.key !== "Tab") return

    const focusable = getFocusableElements(container)
    if (focusable.length === 0) {
      keyboardEvent.preventDefault()
      ensureContainerFocusable()
      focusElement(container)
      return
    }

    const current = document.activeElement
    const currentIndex = current === null ? -1 : focusable.indexOf(current as HTMLElement)
    if (keyboardEvent.shiftKey) {
      if (currentIndex <= 0) {
        keyboardEvent.preventDefault()
        focusElement(focusable[focusable.length - 1])
      }
      return
    }
    if (currentIndex === focusable.length - 1) {
      keyboardEvent.preventDefault()
      focusElement(focusable[0])
    }
  }

  const activate = (): void => {
    if (cleaned || active) return
    if (!capturedFocus) {
      previousFocus = document.activeElement
      capturedFocus = true
    }
    active = true
    keydownCleanup = listen(container, "keydown", handleKeydown, true)
    const target = resolveInitialFocus(container, options.initialFocus)
    if (target !== null && focusElement(target)) return
    ensureContainerFocusable()
    focusElement(container)
  }

  const deactivate = (): void => {
    if (!active) return
    active = false
    keydownCleanup?.()
    keydownCleanup = undefined
  }

  const cleanup = (): void => {
    if (cleaned) return
    cleaned = true
    deactivate()
    restoreContainerTabIndex()
    if (restoreFocus && previousFocus !== null && previousFocus.isConnected !== false) {
      focusElement(previousFocus)
    }
  }

  return {
    get active(): boolean {
      return active
    },
    activate,
    deactivate,
    cleanup,
  }
}

function eventElement(target: EventTarget | null): Element | null {
  if (target === null) return null
  const candidate = target as Element & { closest?: (selector: string) => Element | null }
  if (typeof candidate.closest === "function") return candidate.closest("[data-roving-item], [role=tab], [role=radio], [role=option], button")
  return target as Element
}

function rovingItems(container: Element, selector: string): HTMLElement[] {
  try {
    return [...container.querySelectorAll<HTMLElement>(selector)].filter((element) => {
      return !isHiddenOrDisabled(element) && element.isConnected !== false
    })
  } catch {
    return []
  }
}

/**
 * Apply the roving-tabindex pattern to tabs, radios, options, or explicitly
 * marked controls. Original tabindex attributes are restored by cleanup.
 */
export function createRovingTabIndex(
  container: HTMLElement,
  options: RovingTabIndexOptions = {},
): RovingTabIndex {
  const selector = options.selector ?? DEFAULT_ROVING_SELECTOR
  const orientation = options.orientation ?? "horizontal"
  const wrap = options.wrap !== false
  const originals = new Map<HTMLElement, string | null>()
  let currentIndex = 0
  let cleaned = false

  const items = (): HTMLElement[] => rovingItems(container, selector)
  const capture = (elements: readonly HTMLElement[]): void => {
    for (const element of elements) {
      if (!originals.has(element)) originals.set(element, element.getAttribute("tabindex"))
    }
  }

  const apply = (requestedIndex: number, shouldFocus: boolean): void => {
    if (cleaned) return
    const controls = items()
    if (controls.length === 0) {
      currentIndex = 0
      return
    }
    capture(controls)
    const max = controls.length - 1
    const index = Number.isSafeInteger(requestedIndex) ? requestedIndex : 0
    currentIndex = Math.min(max, Math.max(0, index))
    controls.forEach((control, index) => {
      control.setAttribute("tabindex", index === currentIndex ? "0" : "-1")
    })
    const selected = controls[currentIndex]
    if (shouldFocus) focusElement(selected)
    options.onChange?.(selected, currentIndex)
  }

  const initialControls = items()
  capture(initialControls)
  const existingIndex = initialControls.findIndex((control) => control.getAttribute("tabindex") === "0")
  apply(existingIndex >= 0 ? existingIndex : options.initialIndex ?? 0, false)

  const handleKeydown = (event: Event): void => {
    if (cleaned) return
    const keyboardEvent = event as KeyboardEvent
    const controls = items()
    if (controls.length === 0) return
    const target = eventElement(keyboardEvent.target)
    const targetIndex = target === null ? -1 : controls.indexOf(target as HTMLElement)
    if (targetIndex >= 0) currentIndex = targetIndex

    let delta = 0
    if (keyboardEvent.key === "ArrowRight" && (orientation === "horizontal" || orientation === "both")) delta = 1
    if (keyboardEvent.key === "ArrowLeft" && (orientation === "horizontal" || orientation === "both")) delta = -1
    if (keyboardEvent.key === "ArrowDown" && (orientation === "vertical" || orientation === "both")) delta = 1
    if (keyboardEvent.key === "ArrowUp" && (orientation === "vertical" || orientation === "both")) delta = -1

    let nextIndex: number | undefined
    if (keyboardEvent.key === "Home") nextIndex = 0
    else if (keyboardEvent.key === "End") nextIndex = controls.length - 1
    else if (delta !== 0) {
      nextIndex = currentIndex + delta
      if (wrap) nextIndex = (nextIndex + controls.length) % controls.length
      else nextIndex = Math.min(controls.length - 1, Math.max(0, nextIndex))
    }
    if (nextIndex === undefined || nextIndex === currentIndex) return
    keyboardEvent.preventDefault()
    apply(nextIndex, true)
  }

  const handleFocusin = (event: Event): void => {
    const controls = items()
    const target = eventElement(event.target)
    const index = target === null ? -1 : controls.indexOf(target as HTMLElement)
    if (index >= 0) apply(index, false)
  }

  const keydownCleanup = listen(container, "keydown", handleKeydown, true)
  const focusCleanup = listen(container, "focusin", handleFocusin, true)

  return {
    get index(): number {
      return currentIndex
    },
    getIndex(): number {
      return currentIndex
    },
    setIndex(index: number, focus = true): void {
      apply(index, focus)
    },
    refresh(): void {
      apply(currentIndex, false)
    },
    cleanup(): void {
      if (cleaned) return
      cleaned = true
      keydownCleanup()
      focusCleanup()
      for (const [element, original] of originals) {
        if (original === null) element.removeAttribute("tabindex")
        else element.setAttribute("tabindex", original)
      }
      originals.clear()
    },
  }
}

function liveRegionStyle(): string {
  return "position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0"
}

/** Create a DOM-owned live region with status/alert semantics. */
export function createLiveRegion(
  root: HTMLElement,
  options: LiveRegionOptions = {},
): LiveRegion {
  const document = ownerDocumentFor(root, options.document)
  const priority = options.priority ?? "polite"
  const region = document.createElement("div")
  setAttributes(region, {
    "data-apc-live-region": "",
    "data-apc-live-priority": priority,
    role: priority === "assertive" ? "alert" : "status",
    "aria-live": priority,
    "aria-atomic": "true",
    "aria-label": options.label,
    className: options.className,
  })
  region.setAttribute("style", liveRegionStyle())
  root.appendChild(region)

  let cleaned = false
  const clear = (): void => {
    if (!cleaned) setText(region, "")
  }
  const announce = (message: string): void => {
    if (!cleaned) setText(region, message)
  }
  const cleanup = (): void => {
    if (cleaned) return
    cleaned = true
    region.parentNode?.removeChild(region)
  }
  return {
    element: region,
    announce,
    clear,
    cleanup,
    remove: cleanup,
  }
}

export function createStatusRegion(
  root: HTMLElement,
  options: Omit<LiveRegionOptions, "priority"> = {},
): LiveRegion {
  return createLiveRegion(root, { ...options, priority: "polite" })
}

/** Apply status semantics to an existing extension-owned node. */
export function setStatus(
  element: HTMLElement,
  message: string,
  priority: LivePriority = "polite",
): HTMLElement {
  setAttributes(element, {
    role: priority === "assertive" ? "alert" : "status",
    "aria-live": priority,
    "aria-atomic": "true",
  })
  return setText(element, message)
}

function updateVisibleFocusClass(element: Element, className: string, visible: boolean): void {
  if (element.classList !== undefined) {
    if (visible) element.classList.add(className)
    else element.classList.remove(className)
  }
}

/** Toggle a visible-focus marker without changing focus or global styles. */
export function setVisibleFocus(
  element: Element,
  visible = true,
  options: VisibleFocusOptions = {},
): void {
  const attribute = options.attribute ?? "data-apc-focus-visible"
  const className = options.className ?? "apc-focus-visible"
  if (visible) {
    element.setAttribute(attribute, "")
    updateVisibleFocusClass(element, className, true)
  } else {
    element.removeAttribute(attribute)
    updateVisibleFocusClass(element, className, false)
  }
}

/** Track keyboard modality inside one extension-owned root. */
export function installVisibleFocus(
  root: HTMLElement,
  options: VisibleFocusOptions = {},
): Cleanup {
  const className = options.className ?? "apc-focus-visible"
  let keyboardModality = false
  let current: Element | null = null
  let cleaned = false

  const markKeyboard = (): void => {
    keyboardModality = true
  }
  const markPointer = (): void => {
    keyboardModality = false
    if (current !== null) {
      setVisibleFocus(current, false, { ...options, className })
      current = null
    }
  }
  const handleFocusin = (event: Event): void => {
    if (current !== null && current !== event.target) setVisibleFocus(current, false, { ...options, className })
    current = event.target as Element
    if (keyboardModality && current !== null) setVisibleFocus(current, true, { ...options, className })
  }
  const handleFocusout = (event: Event): void => {
    const focused = current
    if (focused !== null && event.target === focused) {
      setVisibleFocus(focused, false, { ...options, className })
      current = null
    }
  }

  const cleanups = [
    listen(root, "keydown", markKeyboard, true),
    listen(root, "pointerdown", markPointer, true),
    listen(root, "mousedown", markPointer, true),
    listen(root, "touchstart", markPointer, true),
    listen(root, "focusin", handleFocusin, true),
    listen(root, "focusout", handleFocusout, true),
  ]
  return () => {
    if (cleaned) return
    cleaned = true
    for (const cleanup of cleanups) cleanup()
    if (current !== null) setVisibleFocus(current, false, { ...options, className })
    current = null
  }
}

function reducedMotionList(source?: ReducedMotionSource | MediaQueryList): MediaQueryList | null {
  try {
    if (source !== undefined && "matches" in source) return source
    if (source !== undefined) return source.matchMedia("(prefers-reduced-motion: reduce)")
    const globalWindow = globalThis as typeof globalThis & GlobalWindow
    if (typeof globalWindow.matchMedia !== "function") return null
    return globalWindow.matchMedia("(prefers-reduced-motion: reduce)")
  } catch {
    return null
  }
}

/** Read the current OS/browser reduced-motion preference. */
export function prefersReducedMotion(source?: ReducedMotionSource | MediaQueryList): boolean {
  return reducedMotionList(source)?.matches ?? false
}

/** Observe reduced-motion changes and return an idempotent disposer. */
export function observeReducedMotion(
  listener: (reduced: boolean) => void,
  source?: ReducedMotionSource | MediaQueryList,
): Cleanup {
  const media = reducedMotionList(source)
  if (media === null) return () => {}
  const notify = (): void => {
    try {
      listener(media.matches)
    } catch {
      // Accessibility observers must not break media-query delivery.
    }
  }
  notify()
  const callback = (): void => notify()
  if (typeof media.addEventListener === "function") media.addEventListener("change", callback)
  else if (typeof media.addListener === "function") media.addListener(callback)
  let active = true
  return () => {
    if (!active) return
    active = false
    if (typeof media.removeEventListener === "function") media.removeEventListener("change", callback)
    else if (typeof media.removeListener === "function") media.removeListener(callback)
  }
}
