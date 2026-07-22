import type { Cleanup } from "./dom"

const APC_EDITOR_COMPACT_MAX_INLINE_SIZE = "72rem"
export const APC_EDITOR_STACK_MAX_INLINE_REM = 48
const APC_EDITOR_STACK_MAX_INLINE_SIZE = `${APC_EDITOR_STACK_MAX_INLINE_REM}rem`
const APC_EDITOR_RUN_STACK_MAX_INLINE_SIZE = "24rem"
const APC_EDITOR_CONTAINER_NAME = "apc-editor"

const APC_EDITOR_MOBILE_STYLE = `
  :scope > [data-apc-layout] {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas:
      "mobile-navigation"
      "workspace";
    gap: .5rem;
    position: relative;
    max-inline-size: 100%;
    overflow-x: clip;
  }
  :scope > [data-apc-layout][data-apc-mobile-pane="navigation"]::after,
  :scope > [data-apc-layout][data-apc-mobile-pane="configuration"]::after {
    content: "";
    position: fixed;
    inset: 0;
    z-index: var(--apc-layer-mobile-scrim);
    background: var(--lumiverse-modal-backdrop, var(--lumiverse-fill-heavy, GrayText));
    pointer-events: none;
  }
  :scope > [data-apc-layout] > [data-apc-mobile-navigation] {
    grid-area: mobile-navigation;
    position: sticky;
    inset-block-start: 0;
    z-index: 3;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: .25rem;
    min-inline-size: 0;
    padding: .25rem;
    background: var(--apc-surface-raised);
    border: .0625rem solid var(--apc-border);
    border-radius: var(--apc-radius);
  }
  :scope > [data-apc-layout] > [data-apc-mobile-navigation] > button {
    min-block-size: var(--apc-touch-target);
    text-align: center;
  }
  :scope > [data-apc-layout] > [data-apc-panel="threads"],
  :scope > [data-apc-layout] > [data-apc-panel="inspector"] {
    display: none;
  }
  :scope > [data-apc-layout] > [data-apc-panel="graph"] {
    grid-area: workspace;
    grid-column: 1 / -1;
    inline-size: 100%;
    max-block-size: var(--apc-mobile-workspace-block-size);
    padding-block-end: var(--apc-mobile-action-space);
    overflow: auto;
    overscroll-behavior: contain;
    scroll-padding-block-end: var(--apc-mobile-action-space);
  }
  :scope > [data-apc-layout][data-apc-mobile-pane="navigation"] > [data-apc-mobile-layer="drawer"],
  :scope > [data-apc-layout][data-apc-mobile-pane="configuration"] > [data-apc-mobile-layer="sheet"] {
    position: fixed;
    z-index: var(--apc-layer-mobile-surface);
    display: grid;
    max-inline-size: 100%;
    overflow: auto;
    overscroll-behavior: contain;
    color: var(--apc-text);
    background: var(--apc-surface-raised);
    box-shadow: var(--apc-shadow);
  }
  :scope > [data-apc-layout][data-apc-mobile-pane="navigation"] > [data-apc-mobile-layer="drawer"] {
    inset-block: 0;
    inset-inline-start: 0;
    inline-size: min(88vw, 22rem);
    max-block-size: 100dvh;
    padding-block-start: max(.75rem, env(safe-area-inset-top));
    padding-block-end: max(.75rem, env(safe-area-inset-bottom));
    padding-inline-start: max(.75rem, env(safe-area-inset-left));
    padding-inline-end: max(.75rem, env(safe-area-inset-right));
    border-block: 0;
    border-inline-start: 0;
    border-radius: 0 var(--apc-radius) var(--apc-radius) 0;
  }
  :scope > [data-apc-layout][data-apc-mobile-pane="configuration"] > [data-apc-mobile-layer="sheet"] {
    inset-inline: 0;
    inset-block-end: 0;
    block-size: var(--apc-mobile-sheet-block-size);
    max-block-size: 100dvh;
    padding-block-start: 1rem;
    padding-block-end: max(.75rem, env(safe-area-inset-bottom));
    padding-inline-start: max(.75rem, env(safe-area-inset-left));
    padding-inline-end: max(.75rem, env(safe-area-inset-right));
    border-inline: 0;
    border-block-end: 0;
    border-radius: var(--apc-radius) var(--apc-radius) 0 0;
  }
  :scope > [data-apc-layout] > [data-apc-panel] > [data-apc-mobile-close] {
    position: sticky;
    inset-block-start: 0;
    z-index: var(--apc-layer-mobile-control);
    display: grid;
    place-items: center;
    justify-self: end;
    inline-size: var(--apc-touch-target);
    min-block-size: var(--apc-touch-target);
    padding: 0;
    border-radius: 50%;
  }
  :scope > [data-apc-layout] > [data-apc-mobile-runtime-bar][hidden] {
    display: none;
  }
  :scope > [data-apc-layout] > [data-apc-mobile-runtime-bar]:not([hidden]) {
    position: fixed;
    inset-inline: 0;
    inset-block-end: 0;
    block-size: var(--apc-mobile-action-space);
    box-sizing: border-box;
    z-index: var(--apc-layer-mobile-control);
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: nowrap;
    gap: .625rem;
    padding-block-start: .625rem;
    padding-block-end: max(.625rem, env(safe-area-inset-bottom));
    padding-inline-start: max(.75rem, env(safe-area-inset-left));
    padding-inline-end: max(.75rem, env(safe-area-inset-right));
    color: var(--apc-text);
    background: var(--apc-surface-raised);
    border-block-start: .0625rem solid var(--apc-border);
    box-shadow: var(--apc-shadow);
    pointer-events: none;
  }
  :scope > [data-apc-layout] > [data-apc-mobile-runtime-bar] > [data-apc-mobile-runtime-status] {
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--apc-text-muted);
    font-size: calc(.75rem * var(--lumiverse-font-scale, 1));
    font-weight: 700;
  }
  :scope > [data-apc-layout] > [data-apc-mobile-runtime-bar] > button {
    min-block-size: var(--apc-touch-target);
    color: var(--apc-danger);
    background: var(--apc-surface-raised);
    border-color: var(--apc-danger-border);
    pointer-events: auto;
  }
  :scope .apc-stage-runs {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  :scope .apc-stage-list > .apc-card-actions {
    position: sticky;
    inset-block-end: 0;
    z-index: 3;
    padding-block-end: max(.625rem, env(safe-area-inset-bottom));
    background: var(--apc-surface-raised);
  }
  :scope .apc-inspector-stop-control {
    display: none;
  }
  :scope .apc-mode-toolbar-shell,
  :scope .apc-mode-toolbar {
    align-items: stretch;
  }
  :scope .apc-mode-toolbar {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    inline-size: 100%;
  }
  :scope .apc-mode-toolbar button {
    inline-size: 100%;
    text-align: center;
  }
  :scope .apc-graph-empty {
    min-block-size: 0;
    padding: 1rem;
  }
  :scope .apc-graph-empty > ol,
  :scope .apc-graph-empty > .apc-card-actions:not([data-apc-unavailable-graph-actions]) {
    grid-template-columns: minmax(0, 1fr);
  }
  :scope .apc-card-actions > button {
    flex: 1 1 10rem;
  }
  :scope .apc-consent-review {
    inset-block-start: auto;
    inset-block-end: 0;
    inset-inline-start: 0;
    grid-template-rows: auto minmax(0, 1fr) auto;
    inline-size: 100%;
    min-block-size: min(40rem, calc(100dvh - .25rem));
    max-block-size: calc(100dvh - .25rem);
    padding: 0;
    border-inline: 0;
    border-block-end: 0;
    border-radius: var(--apc-radius) var(--apc-radius) 0 0;
    transform: none;
  }
  :scope .apc-consent-review-header {
    padding-block: .875rem .625rem;
    padding-inline-start: max(1rem, env(safe-area-inset-left));
    padding-inline-end: max(1rem, env(safe-area-inset-right));
  }
  :scope .apc-consent-review-body {
    padding-block: .75rem;
    padding-inline-start: max(1rem, env(safe-area-inset-left));
    padding-inline-end: max(1rem, env(safe-area-inset-right));
    overscroll-behavior-y: contain;
  }
  :scope .apc-consent-review-footer {
    padding-inline-start: max(1rem, env(safe-area-inset-left));
    padding-inline-end: max(1rem, env(safe-area-inset-right));
    padding-block-end: max(.75rem, env(safe-area-inset-bottom));
  }
  :scope .apc-consent-details,
  :scope .apc-consent-destination dl {
    grid-template-columns: minmax(0, 1fr);
  }
  :scope [data-apc-pane="workspace"] .apc-thread-workspace-pane,
  :scope [data-apc-pane="workspace"] .apc-thread-workspace,
  :scope [data-apc-pane="workspace"] .apc-host-loom-editor {
    min-block-size: 24rem;
  }
`

/** Extension-owned editor rules. Every selector is rooted through :scope. */
export const APC_EDITOR_STYLE = `
:scope {
  --apc-surface-root: var(--lumiverse-bg-deep, Canvas);
  --apc-surface-pane: var(--lumiverse-bg, Canvas);
  --apc-surface-raised: var(--lumiverse-bg-elevated, Canvas);
  --apc-surface-card: var(--lumiverse-fill-subtle, ButtonFace);
  --apc-surface-hover: var(--lumiverse-fill-hover, ButtonFace);
  --apc-border: var(--lumiverse-border, GrayText);
  --apc-border-strong: var(--lumiverse-border-hover, GrayText);
  --apc-text: var(--lumiverse-text, CanvasText);
  --apc-text-muted: var(--lumiverse-text-muted, GrayText);
  --apc-text-dim: var(--lumiverse-text-dim, GrayText);
  --apc-accent: var(--lumiverse-primary, Highlight);
  --apc-accent-text: var(--lumiverse-primary-text, LinkText);
  --apc-accent-soft: var(--lumiverse-primary-010, ButtonFace);
  --apc-accent-border: var(--lumiverse-primary-050, Highlight);
  --apc-success: var(--lumiverse-success, LinkText);
  --apc-success-soft: var(--lumiverse-success-015, ButtonFace);
  --apc-success-border: var(--lumiverse-success-050, LinkText);
  --apc-warning: var(--lumiverse-warning, MarkText);
  --apc-warning-soft: var(--lumiverse-warning-015, Mark);
  --apc-warning-border: var(--lumiverse-warning-050, MarkText);
  --apc-danger: var(--lumiverse-danger, CanvasText);
  --apc-danger-soft: var(--lumiverse-danger-015, ButtonFace);
  --apc-danger-border: var(--lumiverse-danger-050, CanvasText);
  --apc-radius-compact: var(--lumiverse-radius-sm, .3125rem);
  --apc-radius: var(--lumiverse-radius, .5rem);
  --apc-shadow: var(--lumiverse-shadow-md, 0 1rem 3rem var(--lumiverse-fill-heavy, GrayText));
  --apc-layer-scrim: 20;
  --apc-layer-dialog: 21;
  --apc-layer-mobile-scrim: 10;
  --apc-layer-mobile-surface: 11;
  --apc-layer-mobile-control: 12;
  --apc-touch-target: 2.75rem;
  --apc-mobile-navigation-size: 3.5rem;
  --apc-mobile-sheet-block-size: min(82dvh, 48rem);
  --apc-mobile-workspace-block-size: calc(100dvh - var(--apc-mobile-navigation-size));
  --apc-mobile-action-space: calc(4rem + env(safe-area-inset-bottom));
  container-name: ${APC_EDITOR_CONTAINER_NAME};
  container-type: inline-size;
  min-inline-size: 0;
  color: var(--apc-text);
  background: var(--apc-surface-root);
  font-family: var(--lumiverse-font-family, inherit);
  font-size: calc(.8125rem * var(--lumiverse-font-scale, 1));
  line-height: 1.45;
  isolation: isolate;
}
:scope > [data-apc-layout] {
  display: grid;
  grid-template-columns:
    minmax(0, 15rem)
    minmax(0, 1fr)
    minmax(0, 21rem);
  grid-template-areas: "threads graph inspector";
  gap: .75rem;
  align-items: start;
  min-inline-size: 0;
  max-inline-size: 100%;
}
:scope > [data-apc-layout] > [data-apc-mobile-navigation],
:scope > [data-apc-layout] > [data-apc-mobile-runtime-bar],
:scope > [data-apc-layout] > [data-apc-panel] > [data-apc-mobile-close] {
  display: none;
}
:scope > [data-apc-layout] > [data-apc-panel="threads"] {
  grid-area: threads;
}
:scope > [data-apc-layout] > [data-apc-panel="graph"] {
  grid-area: graph;
}
:scope > [data-apc-layout] > [data-apc-panel="inspector"] {
  grid-area: inspector;
}
:scope > [data-apc-layout] > [data-apc-panel] {
  box-sizing: border-box;
  display: grid;
  gap: .75rem;
  align-content: start;
  min-inline-size: 0;
  max-inline-size: 100%;
  padding: .75rem;
  overflow: auto;
  color: var(--apc-text);
  background: var(--apc-surface-pane);
  border: .0625rem solid var(--apc-border);
  border-radius: var(--apc-radius);
}
:scope [data-apc-panel],
:scope [data-apc-panel] *,
:scope .apc-graph-toolbar-contribution,
:scope .apc-graph-toolbar-contribution * {
  box-sizing: border-box;
}
:scope [data-apc-panel] :where(h1, h2, h3, h4, h5, h6, p),
:scope .apc-graph-toolbar-contribution :where(h1, h2, h3, h4, h5, h6, p) {
  min-inline-size: 0;
  max-inline-size: 100%;
  margin: 0;
  overflow-wrap: anywhere;
}
:scope [data-apc-panel] :where(h2, h3),
:scope .apc-module-heading,
:scope .apc-inspector-section-title {
  color: var(--apc-text-muted);
  font-size: calc(.6875rem * var(--lumiverse-font-scale, 1));
  font-weight: 700;
  letter-spacing: .09em;
  line-height: 1.3;
  text-transform: uppercase;
}
:scope [data-apc-panel] :where(h4, h5, h6) {
  color: var(--apc-text);
  font-size: calc(.75rem * var(--lumiverse-font-scale, 1));
  font-weight: 650;
}
:scope .apc-graph-editor,
:scope .apc-graph-content,
:scope .apc-graph-workspace,
:scope .apc-thread-workspace-pane,
:scope .apc-thread-workspace,
:scope .apc-stage-list,
:scope .apc-topology-stages,
:scope .apc-stage-runs,
:scope .apc-final-response,
:scope .apc-bindings,
:scope .apc-inspector,
:scope .apc-inspector-content,
:scope .apc-inspector-execution {
  display: grid;
  gap: .75rem;
  align-content: start;
  min-inline-size: 0;
  max-inline-size: 100%;
}
:scope .apc-mode-toolbar-shell {
  display: flex;
  flex-wrap: wrap;
  gap: .5rem 1rem;
  align-items: center;
  min-inline-size: 0;
}
:scope .apc-mode-toolbar {
  display: inline-flex;
  flex-wrap: wrap;
  gap: .25rem;
  align-items: center;
  min-inline-size: 0;
  padding: .25rem;
  background: var(--apc-surface-card);
  border: .0625rem solid var(--apc-border);
  border-radius: var(--apc-radius);
}
:scope .apc-mode-toolbar .apc-disabled-reason {
  flex: 1 0 100%;
  padding-inline: .25rem;
}
:scope button,
:scope input,
:scope select,
:scope textarea {
  font: inherit;
}
:scope button {
  min-inline-size: 0;
  max-inline-size: 100%;
  min-block-size: 2rem;
  padding: .375rem .625rem;
  overflow-wrap: anywhere;
  color: var(--apc-text);
  background: var(--apc-surface-card);
  border: .0625rem solid var(--apc-border);
  border-radius: var(--apc-radius-compact);
  line-height: 1.25;
  text-align: start;
  white-space: normal;
}
:scope button[data-action="add-stage"],
:scope button[data-action="create-graph"],
:scope button[data-apc-approve-consent],
:scope .apc-mode-toolbar button[aria-checked="true"] {
  color: var(--lumiverse-primary-contrast, HighlightText);
  background: var(--apc-accent);
  border-color: var(--apc-accent-border);
  font-weight: 700;
}
:scope button[data-selected="true"],
:scope button[aria-pressed="true"] {
  color: var(--apc-accent-text);
  background: var(--apc-accent-soft);
  border-color: var(--apc-accent-border);
}
:scope [data-selected="true"] {
  border-color: var(--apc-accent-border);
  box-shadow: inset .25rem 0 0 var(--apc-accent);
}
:scope button[data-inspector-action="stop"],
:scope button[data-apc-revoke-consent] {
  color: var(--apc-danger);
  background: var(--apc-danger-soft);
  border-color: var(--apc-danger-border);
  font-weight: 700;
}
:scope button:disabled,
:scope button[aria-disabled="true"],
:scope input:disabled,
:scope select:disabled,
:scope textarea:disabled {
  cursor: not-allowed;
  opacity: .52;
  filter: saturate(.4);
}
:scope input[readonly],
:scope textarea[readonly],
:scope [aria-readonly="true"] {
  color: var(--apc-text-muted);
  background: var(--apc-surface-card);
  border-style: dashed;
}
:scope button:focus-visible,
:scope input:focus-visible,
:scope select:focus-visible,
:scope textarea:focus-visible,
:scope [tabindex]:focus-visible,
:scope summary:focus-visible {
  outline: .1875rem solid var(--apc-accent);
  outline-offset: .125rem;
  box-shadow: 0 0 0 .125rem var(--apc-surface-root);
}
:scope .apc-card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: .5rem;
  align-items: center;
  min-inline-size: 0;
}
:scope .apc-card-actions > button {
  flex: 0 1 auto;
}
:scope .apc-field,
:scope [data-apc-thread-editor] label,
:scope [data-apc-connection-slot-list] label {
  display: grid;
  gap: .25rem;
  min-inline-size: 0;
  max-inline-size: 100%;
}
:scope .apc-field-label,
:scope [data-apc-thread-editor] label > span:first-child,
:scope [data-apc-connection-slot-list] label > span:first-child {
  color: var(--apc-text-muted);
  font-size: calc(.6875rem * var(--lumiverse-font-scale, 1));
  font-weight: 700;
  letter-spacing: .04em;
  text-transform: uppercase;
}
:scope .apc-field input,
:scope .apc-field textarea,
:scope .apc-field select,
:scope [data-apc-thread-editor] input:not([type="checkbox"]):not([type="radio"]),
:scope [data-apc-thread-editor] textarea,
:scope [data-apc-thread-editor] select,
:scope [data-apc-connection-slot-label] {
  inline-size: 100%;
  min-inline-size: 0;
  max-inline-size: 100%;
  padding: .5rem .625rem;
  color: var(--apc-text);
  background: var(--apc-surface-root);
  border: .0625rem solid var(--apc-border);
  border-radius: var(--apc-radius-compact);
}
:scope textarea {
  min-block-size: 5rem;
  resize: vertical;
}
:scope fieldset,
:scope legend,
:scope dl,
:scope dd,
:scope dt {
  min-inline-size: 0;
  max-inline-size: 100%;
}
:scope fieldset {
  margin: 0;
}
:scope legend {
  padding-inline: .25rem;
  overflow-wrap: anywhere;
  color: var(--apc-text-muted);
  font-weight: 700;
}
:scope .apc-checkbox-field,
:scope .apc-radio-field {
  display: inline-flex;
  gap: .5rem;
  align-items: flex-start;
  inline-size: fit-content;
  max-inline-size: 100%;
}
:scope .apc-checkbox-field input,
:scope .apc-radio-field input {
  flex: 0 0 auto;
  margin-block-start: .125rem;
  accent-color: var(--apc-accent);
}
:scope .apc-disabled-reason {
  display: block;
  color: var(--apc-text-muted);
  font-size: calc(.6875rem * var(--lumiverse-font-scale, 1));
  line-height: 1.4;
}
:scope .apc-blocked-status,
:scope .apc-validation-errors,
:scope [data-apc-blocked] {
  padding: .625rem .75rem;
  color: var(--apc-danger);
  background: var(--apc-danger-soft);
  border: .0625rem solid var(--apc-danger-border);
  border-radius: var(--apc-radius-compact);
}
:scope .apc-thread-list > ul,
:scope [data-apc-run-navigation],
:scope [data-apc-connection-slot-list],
:scope .apc-run-inputs,
:scope .apc-inspector-source-list,
:scope .apc-inspector-stage-list,
:scope .apc-inspector-run-list,
:scope .apc-inspector-activity,
:scope .apc-inspector-traces,
:scope .apc-inspector-trace-events {
  display: grid;
  gap: .5rem;
  min-inline-size: 0;
  margin: 0;
  padding: 0;
  list-style: none;
}
:scope .apc-thread-list {
  display: grid;
  gap: .625rem;
  min-inline-size: 0;
}
:scope .apc-thread-list > ul > li,
:scope [data-apc-run-navigation] > li,
:scope [data-apc-connection-slot-list] > li {
  display: grid;
  gap: .375rem;
  min-inline-size: 0;
  padding: .5rem;
  background: var(--apc-surface-card);
  border: .0625rem solid var(--apc-border);
  border-radius: var(--apc-radius-compact);
}
:scope .apc-thread-list [data-apc-thread-select],
:scope [data-apc-run-navigation] [data-apc-run-select] {
  inline-size: 100%;
  padding: .25rem;
  background: transparent;
  border-color: transparent;
  font-weight: 700;
}
:scope .apc-thread-source,
:scope .apc-run-meta,
:scope .apc-run-flags {
  color: var(--apc-text-muted);
  font-size: calc(.6875rem * var(--lumiverse-font-scale, 1));
}
:scope .apc-thread-list .apc-card-actions {
  gap: .25rem;
}
:scope .apc-thread-list .apc-card-actions button,
:scope .apc-stage-card > .apc-card-actions button,
:scope .apc-run-card > .apc-card-actions button {
  min-block-size: 1.75rem;
  padding: .25rem .5rem;
  font-size: calc(.6875rem * var(--lumiverse-font-scale, 1));
}
:scope .apc-stage-list {
  position: relative;
  padding: .75rem;
  background: var(--apc-surface-root);
  border: .0625rem solid var(--apc-border);
  border-radius: var(--apc-radius);
}
:scope .apc-council-warning {
  padding: .625rem .75rem;
  color: var(--apc-warning);
  background: var(--apc-warning-soft);
  border: .0625rem solid var(--apc-warning-border);
  border-radius: var(--apc-radius-compact);
}
:scope .apc-topology-stages {
  gap: 1.5rem;
}
:scope .apc-stage-card,
:scope .apc-run-card,
:scope .apc-final-response,
:scope .apc-selection-detail,
:scope .apc-connection-slots,
:scope .apc-missing-graph-actions,
:scope .apc-inline-confirmation {
  position: relative;
  min-inline-size: 0;
  padding: .625rem;
  background: var(--apc-surface-card);
  border: .0625rem solid var(--apc-border);
  border-radius: var(--apc-radius-compact);
}
:scope .apc-stage-card {
  display: grid;
  gap: .625rem;
}
:scope .apc-stage-card > h3 {
  padding-block-end: .5rem;
  border-block-end: .0625rem solid var(--apc-border);
}
:scope .apc-stage-runs {
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 11rem), 1fr));
  gap: .75rem;
}
:scope .apc-run-card {
  display: grid;
  gap: .375rem;
  align-content: start;
}
:scope .apc-run-card > h4 button {
  inline-size: 100%;
  padding: .25rem;
  background: transparent;
  border-color: transparent;
  font-size: calc(.8125rem * var(--lumiverse-font-scale, 1));
}
:scope .apc-run-inputs {
  gap: .25rem;
}
:scope .apc-run-inputs > li {
  padding: .25rem .5rem;
  overflow-wrap: anywhere;
  color: var(--apc-accent-text);
  background: var(--apc-accent-soft);
  border: .0625rem solid var(--apc-accent-border);
  border-radius: var(--apc-radius-compact);
  font-size: calc(.6875rem * var(--lumiverse-font-scale, 1));
}
:scope [data-apc-topology="parallel"] .apc-stage-runs {
  position: relative;
  padding-block-end: 1rem;
}
:scope [data-apc-topology="parallel"] .apc-stage-runs::after {
  content: "";
  position: absolute;
  inset-inline: 12.5%;
  inset-block-end: .25rem;
  border-block-end: .125rem solid var(--apc-accent-border);
}
:scope [data-apc-topology="parallel"] .apc-stage-runs::before {
  content: "";
  position: absolute;
  inset-inline-start: 50%;
  inset-block-end: -.75rem;
  block-size: 1rem;
  border-inline-start: .125rem solid var(--apc-accent-border);
}
:scope [data-apc-topology="parallel"] .apc-run-card::after {
  content: "";
  position: absolute;
  inset-inline-start: 50%;
  inset-block-end: -.875rem;
  block-size: .875rem;
  border-inline-start: .125rem solid var(--apc-accent-border);
}
:scope [data-apc-causal-chain] > .apc-stage-card:not(:last-child)::after {
  content: "↓";
  position: absolute;
  inset-inline-start: 50%;
  inset-block-end: -1.375rem;
  color: var(--apc-accent);
  font-size: 1rem;
  font-weight: 800;
  line-height: 1;
}
:scope .apc-final-response {
  order: 10;
  padding: .75rem;
  border-style: dashed;
  border-color: var(--apc-accent-border);
}
:scope .apc-stage-list > .apc-card-actions {
  position: sticky;
  inset-block-end: 0;
  z-index: 2;
  order: 20;
  margin: 0 -.75rem -.75rem;
  padding: .625rem .75rem;
  background: var(--apc-surface-raised);
  border-block-start: .0625rem solid var(--apc-border-strong);
  border-radius: 0 0 var(--apc-radius) var(--apc-radius);
}
:scope .apc-missing-graph-actions {
  order: 15;
}
:scope .apc-graph-empty {
  display: grid;
  gap: 1rem;
  align-content: center;
  min-block-size: min(62dvh, 36rem);
  min-inline-size: 0;
  padding: clamp(1rem, 4vw, 3rem);
  background: var(--apc-accent-soft);
  border: .125rem dashed var(--apc-accent-border);
  border-radius: var(--apc-radius);
}
:scope .apc-graph-empty > h2 {
  color: var(--apc-text);
  font-size: calc(1.25rem * var(--lumiverse-font-scale, 1));
  letter-spacing: normal;
  text-transform: none;
}
:scope .apc-graph-empty > ol {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: .75rem;
  margin: 0;
  padding: 0;
  list-style: none;
  counter-reset: apc-onboarding;
}
:scope .apc-graph-empty > ol > li {
  display: grid;
  grid-template-columns: 1.5rem minmax(0, 1fr);
  gap: .5rem;
  align-items: start;
  min-inline-size: 0;
  counter-increment: apc-onboarding;
}
:scope .apc-graph-empty > ol > li::before {
  content: counter(apc-onboarding);
  display: grid;
  place-items: center;
  inline-size: 1.5rem;
  block-size: 1.5rem;
  color: var(--lumiverse-primary-contrast, HighlightText);
  background: var(--apc-accent);
  border-radius: 50%;
  font-weight: 800;
}
:scope .apc-graph-empty > .apc-card-actions:not([data-apc-unavailable-graph-actions]) {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
:scope .apc-graph-empty button[data-action="create-graph"] {
  min-block-size: 3rem;
  justify-content: center;
  text-align: center;
}
:scope [data-apc-unavailable-graph-actions] {
  padding: .625rem;
  background: var(--apc-surface-card);
  border: .0625rem dashed var(--apc-border-strong);
  border-radius: var(--apc-radius-compact);
}
:scope [data-apc-unavailable-graph-action] {
  border-style: dashed;
}
:scope [data-apc-unavailable-graph-actions] + .apc-disabled-reason {
  padding-inline-start: .625rem;
  border-inline-start: .1875rem solid var(--apc-border-strong);
}
:scope .apc-connection-slots {
  display: grid;
  gap: .625rem;
}
:scope [data-apc-connection-slot-list] > li {
  padding: .625rem;
}
:scope .apc-thread-workspace-pane {
  gap: .75rem;
}
:scope .apc-thread-workspace-header {
  display: grid;
  gap: .375rem;
  min-inline-size: 0;
  padding-block-end: .625rem;
  border-block-end: .0625rem solid var(--apc-border);
}
:scope [data-apc-pane="workspace"] .apc-thread-workspace-pane {
  min-block-size: min(70dvh, 46rem);
}
:scope [data-apc-pane="workspace"] .apc-thread-workspace,
:scope [data-apc-pane="workspace"] .apc-host-loom-editor {
  min-block-size: min(62dvh, 40rem);
  min-inline-size: 0;
  background: var(--apc-surface-root);
  border: .0625rem solid var(--apc-border);
  border-radius: var(--apc-radius-compact);
}
:scope .apc-thread-identity,
:scope .apc-thread-connection,
:scope .apc-workspace-source,
:scope .apc-run-configuration,
:scope .apc-binding {
  display: grid;
  gap: .625rem;
  min-inline-size: 0;
  max-inline-size: 100%;
  margin: 0;
  padding: .625rem;
  background: var(--apc-surface-card);
  border: .0625rem solid var(--apc-border);
  border-radius: var(--apc-radius-compact);
}
:scope .apc-bindings {
  gap: .625rem;
}
:scope .apc-binding {
  background: var(--apc-surface-root);
}
:scope [data-apc-thread-output],
:scope [data-apc-bound-connection],
:scope [data-apc-main-context],
:scope [data-apc-run-position-impact],
:scope [data-apc-run-required-reason] {
  display: block;
  min-inline-size: 0;
  max-inline-size: 100%;
  padding: .5rem .625rem;
  overflow-wrap: anywhere;
  color: var(--apc-text-muted);
  background: var(--apc-surface-root);
  border-inline-start: .1875rem solid var(--apc-border-strong);
}
:scope:has(.apc-consent-review)::before {
  content: "";
  position: fixed;
  inset: 0;
  z-index: var(--apc-layer-scrim);
  background: var(--lumiverse-modal-backdrop, var(--lumiverse-fill-heavy, GrayText));
  pointer-events: auto;
}
:scope:has(.apc-consent-review) > [data-apc-layout] > [data-apc-panel] {
  pointer-events: none;
  user-select: none;
}
:scope .apc-consent-review {
  position: fixed;
  inset-block-start: 50%;
  inset-inline-start: 50%;
  z-index: var(--apc-layer-dialog);
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  inline-size: min(calc(100vw - 2rem), 42rem);
  max-block-size: calc(100dvh - 2rem);
  min-block-size: 0;
  overflow: hidden;
  color: var(--apc-text);
  background: var(--apc-surface-raised);
  border: .0625rem solid var(--apc-accent-border);
  border-radius: var(--apc-radius);
  box-shadow: var(--apc-shadow);
  pointer-events: auto;
  transform: translate(-50%, -50%);
}
:scope .apc-consent-review-header {
  display: grid;
  gap: .375rem;
  padding: 1rem 1rem .75rem;
  border-block-end: .0625rem solid var(--apc-border);
}
:scope .apc-consent-review-header h3 {
  margin: 0;
  color: var(--apc-text);
  font-size: calc(1.125rem * var(--lumiverse-font-scale, 1));
  letter-spacing: normal;
  text-transform: none;
}
:scope .apc-consent-review-header p {
  margin: 0;
  color: var(--apc-text-muted);
}
:scope .apc-consent-review-progress {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: .5rem;
  margin: .375rem 0 0;
  padding: 0;
  color: var(--apc-text-muted);
  list-style: none;
}
:scope .apc-consent-review-progress > li {
  padding-block-start: .375rem;
  border-block-start: .125rem solid var(--apc-border);
  font-size: calc(.75rem * var(--lumiverse-font-scale, 1));
  font-weight: 700;
}
:scope .apc-consent-review-progress > li[aria-current="step"] {
  color: var(--apc-accent-text);
  border-block-start-color: var(--apc-accent);
}
:scope .apc-consent-review-body {
  display: grid;
  gap: .75rem;
  min-block-size: 0;
  padding: .875rem 1rem;
  overflow: auto;
  overscroll-behavior: contain;
}
:scope .apc-consent-review-footer {
  display: flex;
  flex-wrap: wrap;
  gap: .5rem;
  align-items: center;
  justify-content: flex-end;
  padding: .75rem 1rem;
  padding-block-end: max(.75rem, env(safe-area-inset-bottom));
  border-block-start: .0625rem solid var(--apc-border);
  background: var(--apc-surface-raised);
}
:scope .apc-consent-review-footer > button {
  flex: 1 1 8rem;
  min-inline-size: 0;
}
:scope .apc-consent-source,
:scope .apc-consent-destination {
  display: grid;
  gap: .5rem;
  min-inline-size: 0;
  margin: 0;
  padding: .75rem;
  background: var(--apc-surface-root);
  border: .0625rem solid var(--apc-border);
  border-radius: var(--apc-radius-compact);
}
:scope .apc-consent-source legend,
:scope .apc-consent-destination h4 {
  color: var(--apc-text-muted);
  font-size: calc(.6875rem * var(--lumiverse-font-scale, 1));
  font-weight: 700;
  letter-spacing: .04em;
  text-transform: uppercase;
}
:scope .apc-consent-destination h4 {
  margin: 0;
}
:scope [data-apc-consent-destination-availability="available"] {
  color: var(--apc-success);
}
:scope [data-apc-consent-destination-availability="unavailable"] {
  color: var(--apc-warning);
}
:scope .apc-consent-destination dl {
  display: grid;
  grid-template-columns: minmax(7rem, auto) minmax(0, 1fr);
  gap: .375rem .75rem;
  margin: 0;
}
:scope .apc-consent-destination dt {
  color: var(--apc-text-muted);
  font-weight: 700;
}
:scope .apc-consent-destination dd {
  min-inline-size: 0;
  margin: 0;
  overflow-wrap: anywhere;
}
:scope .apc-consent-details {
  display: grid;
  grid-template-columns: minmax(7rem, auto) minmax(0, 1fr);
  gap: .375rem .75rem;
  margin: 0;
  padding: .75rem;
  background: var(--apc-surface-root);
  border: .0625rem solid var(--apc-border);
  border-radius: var(--apc-radius-compact);
}
:scope .apc-consent-details dt {
  color: var(--apc-text-muted);
  font-weight: 700;
}
:scope .apc-consent-details dd {
  margin: 0;
  overflow-wrap: anywhere;
}
:scope .apc-consent-review [data-apc-consent-resolution="stale"],
:scope .apc-consent-review [data-apc-consent-resolution="missing"] {
  padding: .625rem;
  color: var(--apc-warning);
  background: var(--apc-warning-soft);
  border: .0625rem solid var(--apc-warning-border);
  border-radius: var(--apc-radius-compact);
}
:scope .apc-inspector-content {
  gap: .625rem;
}
:scope .apc-inspector-header {
  display: flex;
  flex-wrap: wrap;
  gap: .5rem;
  align-items: center;
  justify-content: space-between;
  min-inline-size: 0;
  padding-block-end: .625rem;
  border-block-end: .0625rem solid var(--apc-border);
}
:scope .apc-inspector-title {
  color: var(--apc-text);
  font-size: calc(.875rem * var(--lumiverse-font-scale, 1));
  letter-spacing: normal;
  text-transform: none;
}
:scope .apc-inspector-section {
  display: grid;
  gap: .5rem;
  min-inline-size: 0;
  padding: .625rem;
  background: var(--apc-surface-card);
  border: .0625rem solid var(--apc-border);
  border-radius: var(--apc-radius-compact);
}
:scope .apc-inspector-question {
  gap: .625rem;
  padding: 0 0 .625rem;
  background: transparent;
  border-width: 0 0 .0625rem;
  border-radius: 0;
}
:scope .apc-inspector-question:last-child {
  border-block-end: 0;
}
:scope .apc-inspector-field {
  display: grid;
  grid-template-columns: minmax(5.5rem, auto) minmax(0, 1fr);
  gap: .5rem;
  align-items: start;
  min-inline-size: 0;
}
:scope .apc-inspector-field-label {
  color: var(--apc-text-muted);
  font-size: calc(.6875rem * var(--lumiverse-font-scale, 1));
  font-weight: 650;
}
:scope .apc-inspector-field-value {
  min-inline-size: 0;
  overflow-wrap: anywhere;
  text-align: end;
}
:scope .apc-inspector-badge {
  display: inline-flex;
  gap: .375rem;
  align-items: center;
  inline-size: fit-content;
  max-inline-size: 100%;
  padding: .1875rem .5rem;
  overflow-wrap: anywhere;
  color: var(--apc-text-muted);
  background: var(--apc-surface-card);
  border: .0625rem solid var(--apc-border);
  border-radius: 999rem;
  font-size: calc(.625rem * var(--lumiverse-font-scale, 1));
  font-weight: 800;
  letter-spacing: .04em;
  text-transform: uppercase;
}
:scope .apc-inspector-status-shape {
  display: inline-grid;
  flex: 0 0 auto;
  place-items: center;
  inline-size: 1rem;
  block-size: 1rem;
  border: .0625rem solid currentColor;
  border-radius: 50%;
  font-weight: 900;
  line-height: 1;
}
:scope [data-status-kind="graph-fallback"] .apc-inspector-status-shape,
:scope [data-badge-kind="graph-fallback"] .apc-inspector-status-shape {
  border-radius: var(--apc-radius-compact);
  transform: rotate(45deg);
}
:scope [data-status-kind="graph-fallback"] .apc-inspector-status-shape::first-letter,
:scope [data-badge-kind="graph-fallback"] .apc-inspector-status-shape::first-letter {
  transform: rotate(-45deg);
}
:scope .apc-inspector-run-identity,
:scope .apc-inspector-stage,
:scope .apc-inspector-run,
:scope .apc-inspector-source,
:scope .apc-inspector-activity-item,
:scope .apc-inspector-trace,
:scope .apc-inspector-trace-event {
  display: grid;
  gap: .375rem;
  min-inline-size: 0;
  padding: .5rem;
  background: var(--apc-surface-root);
  border: .0625rem solid var(--apc-border);
  border-radius: var(--apc-radius-compact);
}
:scope .apc-inspector-run-identity,
:scope .apc-inspector-stage,
:scope .apc-inspector-run,
:scope .apc-inspector-activity-item {
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
}
:scope .apc-inspector-activity-error,
:scope .apc-inspector-error-message,
:scope .apc-inspector-stop-warning {
  grid-column: 1 / -1;
  overflow-wrap: anywhere;
  color: var(--apc-danger);
}
:scope .apc-inspector-error {
  color: var(--apc-danger);
  background: var(--apc-danger-soft);
  border-color: var(--apc-danger-border);
}
:scope .apc-inspector-stop-control {
  display: grid;
  gap: .5rem;
  padding: .625rem;
  background: var(--apc-danger-soft);
  border: .0625rem solid var(--apc-danger-border);
  border-radius: var(--apc-radius-compact);
}
:scope .apc-inspector-progress {
  inline-size: 100%;
  max-inline-size: 100%;
  accent-color: var(--apc-accent);
}
:scope .apc-inspector-trace-details {
  min-inline-size: 0;
  overflow: hidden;
  border-block-start: .0625rem solid var(--apc-border);
}
:scope .apc-inspector-trace-details > summary {
  padding-block: .5rem;
  color: var(--apc-accent-text);
  cursor: pointer;
}
:scope [data-activity-status],
:scope [data-current-run-status],
:scope [data-stage-status],
:scope [data-run-status],
:scope [data-outcome-class] {
  border-inline-start-width: .25rem;
  border-inline-start-style: solid;
}
:scope [data-activity-status] > :where(.apc-run-status, .apc-stage-status, .apc-final-route-status)::before {
  display: inline-grid;
  place-items: center;
  inline-size: 1rem;
  block-size: 1rem;
  margin-inline-end: .375rem;
  border: .0625rem solid currentColor;
  border-radius: 50%;
  font-weight: 900;
  line-height: 1;
}
:scope [data-badge-kind="completed"],
:scope [data-inspector-status="completed"],
:scope [data-status-kind="completed"],
:scope [data-activity-status="completed"],
:scope [data-current-run-status="completed"],
:scope [data-stage-status="completed"],
:scope [data-run-status="completed"],
:scope [data-outcome-class="success"] {
  color: var(--apc-success);
  background: var(--apc-success-soft);
  border-color: var(--apc-success-border);
  border-style: solid;
}
:scope [data-activity-status="completed"] > :where(.apc-run-status, .apc-stage-status, .apc-final-route-status)::before {
  content: "✓";
}
:scope [data-badge-kind="running"],
:scope [data-inspector-status="running"],
:scope [data-status-kind="running"],
:scope [data-activity-status="running"],
:scope [data-current-run-status="running"],
:scope [data-stage-status="running"],
:scope [data-run-status="running"],
:scope [data-badge-kind="required"] {
  color: var(--apc-accent-text);
  background: var(--apc-accent-soft);
  border-color: var(--apc-accent-border);
  border-style: double;
}
:scope [data-activity-status="running"] > :where(.apc-run-status, .apc-stage-status, .apc-final-route-status)::before {
  content: "●";
  border-style: double;
}
:scope [data-badge-kind="pending"],
:scope [data-badge-kind="skipped"],
:scope [data-badge-kind="optional"],
:scope [data-badge-kind="cancelled"],
:scope [data-inspector-status="cancelled"],
:scope [data-status-kind="pending"],
:scope [data-status-kind="skipped"],
:scope [data-status-kind="cancelled"],
:scope [data-activity-status="pending"],
:scope [data-activity-status="skipped"],
:scope [data-activity-status="cancelled"],
:scope [data-current-run-status="pending"],
:scope [data-current-run-status="skipped"],
:scope [data-current-run-status="cancelled"],
:scope [data-stage-status="pending"],
:scope [data-stage-status="skipped"],
:scope [data-stage-status="cancelled"],
:scope [data-run-status="pending"],
:scope [data-run-status="skipped"],
:scope [data-run-status="cancelled"],
:scope [data-outcome-class="parent-cancel"] {
  color: var(--apc-text-muted);
  background: var(--apc-surface-card);
  border-color: var(--apc-border-strong);
  border-style: dashed;
}
:scope [data-activity-status="pending"] > :where(.apc-run-status, .apc-stage-status, .apc-final-route-status)::before {
  content: "○";
  border-style: dashed;
}
:scope [data-activity-status="skipped"] > :where(.apc-run-status, .apc-stage-status, .apc-final-route-status)::before,
:scope [data-activity-status="cancelled"] > :where(.apc-run-status, .apc-stage-status, .apc-final-route-status)::before {
  content: "—";
  border-style: dashed;
}
:scope [data-outcome-class="graph-fallback"],
:scope [data-outcome="graph-fallback"],
:scope [data-badge-kind="graph-fallback"],
:scope [data-inspector-status="graph-fallback"],
:scope [data-status-kind="graph-fallback"] {
  color: var(--apc-warning);
  background: var(--apc-warning-soft);
  border-color: var(--apc-warning-border);
  border-style: double;
}
:scope [data-activity-status="graph-fallback"] > :where(.apc-run-status, .apc-stage-status, .apc-final-route-status)::before {
  content: "◆";
  border-radius: var(--apc-radius-compact);
}
:scope [data-badge-kind="failed"],
:scope [data-badge-kind="timed-out"],
:scope [data-inspector-status="failed"],
:scope [data-inspector-status="timed-out"],
:scope [data-status-kind="failed"],
:scope [data-status-kind="timed-out"],
:scope [data-activity-status="failed"],
:scope [data-activity-status="timed-out"],
:scope [data-current-run-status="failed"],
:scope [data-current-run-status="timed-out"],
:scope [data-stage-status="failed"],
:scope [data-stage-status="timed-out"],
:scope [data-run-status="failed"],
:scope [data-run-status="timed-out"],
:scope [data-outcome-class="optional-local"],
:scope [data-outcome-class="selected-final-failure"],
:scope [data-outcome-class="integrity-fatal"] {
  color: var(--apc-danger);
  background: var(--apc-danger-soft);
  border-color: var(--apc-danger-border);
  border-style: solid;
}
:scope [data-activity-status="failed"] > :where(.apc-run-status, .apc-stage-status, .apc-final-route-status)::before,
:scope [data-activity-status="timed-out"] > :where(.apc-run-status, .apc-stage-status, .apc-final-route-status)::before {
  content: "×";
  border-radius: var(--apc-radius-compact);
}
:scope [data-activity-status="completed"] .apc-stage-runs::before,
:scope [data-activity-status="completed"] .apc-stage-runs::after,
:scope .apc-run-card[data-activity-status="completed"]::after {
  border-color: var(--apc-success-border);
}
:scope [data-activity-status="failed"] .apc-stage-runs::before,
:scope [data-activity-status="failed"] .apc-stage-runs::after,
:scope .apc-run-card[data-activity-status="failed"]::after {
  border-color: var(--apc-danger-border);
}
:scope [data-apc-live-region],
:scope [data-apc-thread-live-region],
:scope .apc-inspector-live-region {
  position: absolute;
  inline-size: .0625rem;
  block-size: .0625rem;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
}
@media (hover: hover) {
  :scope button:hover:not(:disabled):not([aria-disabled="true"]) {
    color: var(--apc-text);
    background: var(--apc-surface-hover);
    border-color: var(--apc-border-strong);
  }
  :scope button[data-action="add-stage"]:hover:not(:disabled),
  :scope button[data-action="create-graph"]:hover:not(:disabled),
  :scope button[data-apc-approve-consent]:hover:not(:disabled) {
    color: var(--lumiverse-primary-contrast, HighlightText);
    background: var(--lumiverse-primary-hover, var(--apc-accent));
    border-color: var(--apc-accent);
  }
}
@media (width <= ${APC_EDITOR_COMPACT_MAX_INLINE_SIZE}) {
  :scope > [data-apc-layout] {
    grid-template-columns:
      minmax(0, 12rem)
      minmax(0, 1fr)
      minmax(0, 16rem);
    gap: .5rem;
  }
  :scope > [data-apc-layout] > [data-apc-panel] {
    gap: .625rem;
    padding: .625rem;
  }
  :scope .apc-inspector-field {
    grid-template-columns: minmax(0, 1fr);
  }
  :scope .apc-inspector-field-value {
    text-align: start;
  }
}
@media (width < ${APC_EDITOR_STACK_MAX_INLINE_SIZE}) {
${APC_EDITOR_MOBILE_STYLE}
}
@media (width < ${APC_EDITOR_RUN_STACK_MAX_INLINE_SIZE}) {
  :scope .apc-stage-runs {
    grid-template-columns: minmax(0, 1fr);
  }
}
@container ${APC_EDITOR_CONTAINER_NAME} (width <= ${APC_EDITOR_COMPACT_MAX_INLINE_SIZE}) {
  :scope > [data-apc-layout] {
    grid-template-columns:
      minmax(0, 12rem)
      minmax(0, 1fr)
      minmax(0, 16rem);
    gap: .5rem;
  }
  :scope > [data-apc-layout] > [data-apc-panel] {
    gap: .625rem;
    padding: .625rem;
  }
  :scope .apc-inspector-field {
    grid-template-columns: minmax(0, 1fr);
  }
  :scope .apc-inspector-field-value {
    text-align: start;
  }
}
@container ${APC_EDITOR_CONTAINER_NAME} (width < ${APC_EDITOR_STACK_MAX_INLINE_SIZE}) {
${APC_EDITOR_MOBILE_STYLE}
}
@container ${APC_EDITOR_CONTAINER_NAME} (width < ${APC_EDITOR_RUN_STACK_MAX_INLINE_SIZE}) {
  :scope .apc-stage-runs {
    grid-template-columns: minmax(0, 1fr);
  }
}
@media (forced-colors: active) {
  :scope,
  :scope > [data-apc-layout] > [data-apc-panel],
  :scope button,
  :scope input,
  :scope select,
  :scope textarea,
  :scope fieldset,
  :scope .apc-stage-card,
  :scope .apc-run-card,
  :scope .apc-final-response,
  :scope .apc-consent-review,
  :scope .apc-inspector-section,
  :scope .apc-inspector-error,
  :scope .apc-inspector-stop-control,
  :scope .apc-inspector-activity-error,
  :scope .apc-inspector-error-message,
  :scope .apc-inspector-stop-warning,
  :scope [data-activity-status],
  :scope [data-current-run-status],
  :scope [data-stage-status],
  :scope [data-run-status],
  :scope [data-status-kind],
  :scope [data-badge-kind],
  :scope [data-inspector-status],
  :scope [data-outcome-class] {
    color: CanvasText;
    background: Canvas;
    border-color: CanvasText;
    forced-color-adjust: auto;
  }
  :scope [data-selected="true"],
  :scope button[aria-checked="true"],
  :scope button[aria-pressed="true"] {
    color: HighlightText;
    background: Highlight;
    border-color: Highlight;
  }
  :scope button:focus-visible,
  :scope input:focus-visible,
  :scope select:focus-visible,
  :scope textarea:focus-visible,
  :scope [tabindex]:focus-visible,
  :scope summary:focus-visible {
    outline-color: Highlight;
    box-shadow: none;
  }
  :scope [data-apc-unavailable-graph-actions],
  :scope [data-apc-unavailable-graph-action],
  :scope .apc-graph-empty {
    border-color: GrayText;
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
