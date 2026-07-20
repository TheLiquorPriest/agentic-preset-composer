import type { Cleanup } from "./dom"

/** Extension-owned editor rules. Every selector is rooted through :scope. */
export const APC_EDITOR_STYLE = `
:scope {
  display: grid;
  grid-template-columns:
    minmax(12rem, 1fr)
    minmax(20rem, 2fr)
    minmax(14rem, 1fr);
  grid-template-areas: "threads graph inspector";
  gap: 0.75rem;
  min-width: 0;
  color: var(--lumiverse-text, CanvasText);
  background: var(--lumiverse-bg, Canvas);
  font: inherit;
}
:scope > [data-apc-panel="threads"] {
  grid-area: threads;
}
:scope > [data-apc-panel="graph"] {
  grid-area: graph;
}
:scope > [data-apc-panel="inspector"] {
  grid-area: inspector;
}
:scope [data-apc-panel],
:scope .apc-graph-editor,
:scope [data-apc-thread-editor] {
  display: grid;
  gap: 0.75rem;
  min-width: 0;
}
:scope [data-apc-panel] > h2,
:scope [data-apc-panel] > h3,
:scope .apc-graph-editor h2,
:scope .apc-graph-editor h3,
:scope .apc-graph-editor h4,
:scope .apc-graph-editor h5,
:scope .apc-graph-editor h6,
:scope [data-apc-thread-editor] h2 {
  margin: 0;
}
:scope .apc-mode-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: flex-start;
}
:scope .apc-mode-toolbar button,
:scope .apc-card-actions button,
:scope .apc-graph-editor button,
:scope [data-apc-thread-editor] button {
  color: inherit;
  background: var(--lumiverse-fill-subtle, transparent);
  border: 0.0625rem solid var(--lumiverse-border, currentColor);
  border-radius: 0.25rem;
  padding: 0.35rem 0.65rem;
}
:scope .apc-mode-toolbar button[aria-checked="true"] {
  color: var(--lumiverse-accent-fg, var(--lumiverse-text, CanvasText));
  background: var(--lumiverse-accent, var(--lumiverse-primary, Highlight));
}
:scope .apc-mode-toolbar button:disabled,
:scope .apc-graph-editor button:disabled,
:scope [data-apc-thread-editor] button:disabled {
  cursor: not-allowed;
  opacity: 0.65;
}
:scope .apc-graph-content,
:scope .apc-thread-list,
:scope .apc-stage-list,
:scope .apc-stage-runs,
:scope .apc-final-response,
:scope [data-apc-thread-id],
:scope [data-apc-workspace],
:scope .apc-bindings {
  display: grid;
  gap: 0.75rem;
  min-width: 0;
}
:scope .apc-thread-card,
:scope .apc-stage-card,
:scope .apc-run-card,
:scope [data-apc-connection],
:scope [data-apc-workspace] {
  min-width: 0;
  padding: 0.75rem;
  color: inherit;
  background: var(--lumiverse-fill-subtle, transparent);
  border: 0.0625rem solid var(--lumiverse-border, currentColor);
  border-radius: 0.35rem;
}
:scope .apc-card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
:scope .apc-field,
:scope [data-apc-thread-editor] label {
  display: grid;
  gap: 0.25rem;
  min-width: 0;
}
:scope .apc-field-label {
  font-weight: 600;
}
:scope .apc-field input,
:scope .apc-field textarea,
:scope .apc-field select,
:scope [data-apc-thread-editor] input,
:scope [data-apc-thread-editor] textarea,
:scope [data-apc-thread-editor] select {
  box-sizing: border-box;
  width: 100%;
  max-width: 100%;
  color: inherit;
  background: var(--lumiverse-bg, Canvas);
  border: 0.0625rem solid var(--lumiverse-border, currentColor);
}
:scope .apc-checkbox-field,
:scope .apc-radio-field {
  display: inline-flex;
  gap: 0.4rem;
  align-items: center;
}
:scope .apc-disabled-reason,
:scope .apc-blocked-status,
:scope .apc-validation-errors {
  color: var(--lumiverse-danger, currentColor);
}
:scope .apc-inspector-badge {
  display: inline-flex;
  align-items: center;
  width: fit-content;
  padding: 0.15rem 0.45rem;
  color: var(--lumiverse-text-muted);
  background: var(--lumiverse-fill-subtle);
  border: 0.0625rem solid var(--lumiverse-border);
  border-radius: var(--lumiverse-radius);
  font-weight: 600;
}
:scope [data-outcome-class],
:scope [data-activity-status],
:scope [data-current-run-status] {
  padding-inline-start: 0.75rem;
  border-inline-start: 0.25rem solid var(--lumiverse-border);
}
:scope [data-badge-kind="completed"],
:scope [data-inspector-status="completed"],
:scope [data-activity-status="completed"],
:scope [data-current-run-status="completed"],
:scope [data-outcome-class="success"] {
  color: var(--lumiverse-success);
  background: var(--lumiverse-success-015);
  border-color: var(--lumiverse-success-050);
}
:scope [data-badge-kind="running"],
:scope [data-inspector-status="running"],
:scope [data-activity-status="running"],
:scope [data-current-run-status="running"],
:scope [data-badge-kind="required"] {
  color: var(--lumiverse-primary);
  background: var(--lumiverse-primary-010);
  border-color: var(--lumiverse-primary-050);
}
:scope [data-badge-kind="pending"],
:scope [data-badge-kind="skipped"],
:scope [data-badge-kind="optional"],
:scope [data-badge-kind="cancelled"],
:scope [data-inspector-status="cancelled"],
:scope [data-activity-status="pending"],
:scope [data-activity-status="skipped"],
:scope [data-activity-status="cancelled"],
:scope [data-current-run-status="pending"],
:scope [data-current-run-status="skipped"],
:scope [data-current-run-status="cancelled"],
:scope [data-outcome-class="parent-cancel"] {
  color: var(--lumiverse-text-muted);
  background: var(--lumiverse-fill-subtle);
  border-color: var(--lumiverse-border);
}
:scope [data-outcome-class="graph-fallback"] {
  color: var(--lumiverse-warning);
  background: var(--lumiverse-warning-015);
  border-color: var(--lumiverse-warning-050);
}
:scope [data-badge-kind="failed"],
:scope [data-badge-kind="timed-out"],
:scope [data-inspector-status="failed"],
:scope [data-inspector-status="timed-out"],
:scope [data-activity-status="failed"],
:scope [data-activity-status="timed-out"],
:scope [data-current-run-status="failed"],
:scope [data-current-run-status="timed-out"],
:scope [data-outcome-class="optional-local"],
:scope [data-outcome-class="selected-final-failure"],
:scope [data-outcome-class="integrity-fatal"] {
  color: var(--lumiverse-danger);
  background: var(--lumiverse-danger-015);
  border-color: var(--lumiverse-danger-050);
}
:scope [data-apc-live-region],
:scope [data-apc-thread-live-region] {
  position: absolute;
  width: 0.0625rem;
  height: 0.0625rem;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
}
:scope button:focus-visible,
:scope input:focus-visible,
:scope select:focus-visible,
:scope textarea:focus-visible {
  outline: 0.125rem solid var(--lumiverse-accent, var(--lumiverse-primary, Highlight));
  outline-offset: 0.125rem;
}
@media (max-width: 48rem) {
  :scope {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas:
      "threads"
      "graph"
      "inspector";
  }
  :scope .apc-thread-card,
  :scope .apc-stage-card,
  :scope .apc-run-card,
  :scope [data-apc-connection],
  :scope [data-apc-workspace] {
    padding: 0.6rem;
  }
  :scope .apc-card-actions button {
    flex: 1 1 10rem;
  }
}
@media (forced-colors: active) {
  :scope .apc-thread-card,
  :scope .apc-stage-card,
  :scope .apc-run-card,
  :scope [data-apc-connection],
  :scope [data-apc-workspace],
  :scope .apc-graph-editor button,
  :scope [data-apc-thread-editor] button {
    border-color: CanvasText;
  }
  :scope .apc-inspector-badge,
  :scope [data-inspector-status],
  :scope [data-outcome-class],
  :scope [data-activity-status],
  :scope [data-current-run-status] {
    color: CanvasText;
    background: Canvas;
    border-color: CanvasText;
    forced-color-adjust: auto;
  }
}
`

/** Reduced motion is supplied separately so callers can use the installer wrapper. */
export const APC_EDITOR_REDUCED_MOTION_STYLE = `
:scope *,
:scope *::before,
:scope *::after {
  animation-duration: 0.001ms !important;
  animation-iteration-count: 1 !important;
  scroll-behavior: auto !important;
  transition-duration: 0.001ms !important;
}
`

export interface ScopedStylesOptions {
  readonly root?: HTMLElement
  readonly document?: Document
  readonly id?: string
  readonly scope?: string
  readonly reducedMotionCss?: string
}

export interface ScopedStylesheet {
  readonly element: HTMLStyleElement
  readonly scope: string
  readonly selector: string
  remove(): void
  cleanup(): void
}

let nextScopeId = 0

interface GlobalDocument {
  document?: Document
}

function currentDocument(): Document | undefined {
  return (globalThis as typeof globalThis & GlobalDocument).document
}

function resolveDocument(options: ScopedStylesOptions): Document {
  if (options.document !== undefined) return options.document
  if (options.root?.ownerDocument !== null && options.root?.ownerDocument !== undefined) {
    return options.root.ownerDocument
  }
  const document = currentDocument()
  if (document !== undefined) return document
  throw new Error("An owner document is required to install APC styles")
}

function escapeAttributeValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')
}

function nextScope(): string {
  nextScopeId += 1
  return `apc-${nextScopeId.toString(36)}`
}

/** Replace the explicit :scope token without guessing at CSS selector grammar. */
export function scopeCss(css: string, selector: string): string {
  return css.replaceAll(":scope", selector)
}

function styleText(
  css: string,
  selector: string,
  reducedMotionCss: string | undefined,
): string {
  const base = scopeCss(css, selector)
  if (reducedMotionCss === undefined || reducedMotionCss.trim() === "") return base
  const reduced = scopeCss(reducedMotionCss, selector)
  return `${base}\n@media (prefers-reduced-motion: reduce) {\n${reduced}\n}`
}

function appendTarget(document: Document, root: HTMLElement | undefined): Element {
  const target = document.head ?? root ?? document.body ?? document.documentElement
  if (target === null || target === undefined) {
    throw new Error("A stylesheet target is unavailable")
  }
  return target
}

/**
 * Install one extension-owned stylesheet. The style node and optional root
 * scope marker are removed/restored together, and cleanup is idempotent.
 * Selectors can use :scope to target the supplied root without global rules.
 */
export function installScopedStyles(
  css: string,
  options: ScopedStylesOptions = {},
): ScopedStylesheet {
  const document = resolveDocument(options)
  const rootScope = options.root?.getAttribute("data-apc-scope")
  const scope = rootScope ?? options.scope ?? nextScope()
  const selector = `[data-apc-scope="${escapeAttributeValue(scope)}"]`
  let ownsRootScope = false
  if (options.root !== undefined && rootScope === null) {
    options.root.setAttribute("data-apc-scope", scope)
    ownsRootScope = true
  }

  const style = document.createElement("style")
  style.setAttribute("data-apc-owned-style", "")
  style.setAttribute("data-apc-style-scope", scope)
  if (options.id !== undefined) style.setAttribute("data-apc-style-id", options.id)
  style.textContent = styleText(css, selector, options.reducedMotionCss)
  appendTarget(document, options.root).appendChild(style)

  let removed = false
  const remove = (): void => {
    if (removed) return
    removed = true
    style.parentNode?.removeChild(style)
    if (ownsRootScope && options.root?.getAttribute("data-apc-scope") === scope) {
      options.root.removeAttribute("data-apc-scope")
    }
  }
  return {
    element: style,
    scope,
    selector,
    remove,
    cleanup: remove,
  }
}

/** Remove only a style node created by installScopedStyles. */
export function removeScopedStyles(styles: ScopedStylesheet | HTMLStyleElement | null | undefined): void {
  if (styles === null || styles === undefined) return
  if ("element" in styles) {
    styles.remove()
    return
  }
  if (styles.getAttribute("data-apc-owned-style") !== null) {
    styles.parentNode?.removeChild(styles)
  }
}

export type StylesCleanup = Cleanup
