# APC UI conformance gaps

This ledger tracks the Agentic Preset Composer UI against the supplied final targets in this directory.

## Authority and status rules

- All 18 supplied PNG mockups are final visual targets: nine desktop targets in this directory and nine corresponding portrait-mobile targets under [`mobile/`](./mobile/).
- [`../../DESIGN.md`](../../DESIGN.md) is the functional and behavioral contract.
- [`../../UI.md`](../../UI.md) provides the UI requirements associated with each target.
- A visual mismatch, behavior mismatch, missing user journey, or missing evidence remains open until it is repaired and observed.
- A user-visible view or state without a supplied mockup is listed under **Mockups needed**.
- An unmocked state may receive an interim design so functionality can be completed and tested. That design remains provisional until a target mockup replaces it.
- Automated DOM/state tests are behavior evidence, not visual conformance evidence. Visual conformance requires the rendered host UI at the target state.

Status vocabulary:

- **Open** — implementation or evidence does not meet the contract.
- **In progress** — source repair exists but final verification is incomplete.
- **Provisional** — functional interim UI exists without a final target.
- **Verified** — implementation and observed evidence meet the target.

## Target conformance matrix

| Target | Current status | Confirmed gaps | Evidence still required |
|---|---|---|---|
| `01-parallel-graph-overview.png` | Open | Graph run cards do not show each binding's configured role and missing-output policy. Exact target layout, copy, selected state, and visual styling have not been demonstrated. | Build the target topology in the host; compare all three panes, stage flow, bindings, final route, Council warning, and saved state. |
| `02-thread-workspace.png` | Open | The center workspace omits the target's visible `THREAD WORKSPACE`, thread identity, workspace source, and connection context. The right pane lacks the target Workspace Status summary, Duplicate action, and target placement of Remove. The current controlled host surface does not reproduce all target workspace chrome. | Open a native-block thread from the graph; prove identity/navigation, add/edit/remove/variables, save, reload, and Back to graph. |
| `03-controlled-block-editor.png` | Open | APC mounts the host-controlled block editor but supplies no target block-specific surrounding context (`THREAD CONTEXT`, `BLOCK LOCATION`, and target navigation). The complete target path is not represented by APC-owned state. | Open an existing block, exercise validation/macros/variables/triggers/locking/save, return to the same workspace and selection, then visually compare the host surface and APC context. |
| `04-run-configuration.png` | Open | No run-thread reassignment control exists even though the target has a Thread dropdown. Header/copy differs: no `RUN n · STAGE n`, `Uses <thread>`, or `VALID`; no `Dispatch Main · inherited from thread`; no target output help; Saved status is elsewhere. | Select the target run and exercise thread assignment, requiredness, timeout, every input role/source/missing policy, binding add/remove, and output. |
| `05-connection-consent.png` | Open | Current modal lacks target step indicator, source segmented control, destination availability and Change action, `NEW APPROVAL REQUIRED`, explicit shared-item rows, destination purpose, scoped disclosure, account-local note, and Back action. Protocol data does not currently carry all target fields. | Resolve a real slot, show stale/new approval, prove background lock and disabled approval, approve, revoke, rebind, and visually compare the modal. |
| `06-live-graph-execution.png` | Open | Core running-state projection exists, but actual host evidence has not covered every target inspector field. No visual comparison exists. | Run a real graph and observe progress, current run, provider/model dispatch, remaining budget, usage, bounded activity, topology status, mutation lock, and Stop. |
| `07-required-failure-main-fallback.png` | Open | Runtime messages omit required-run error category, canonical fallback cause, and final delivery/Main-response evidence. The center graph also keeps configured Thread output while the inspector projects Main. The pictured Retry actions are deliberately excluded by the V1 contract. `View response` is absent even though the existing authenticated backend UI automation can close the Loom drawer after delivered settlement without exposing response content. | After the producer/projection repairs, trigger a real required failure; verify the localized failed run/cause, amber Main route, delivered result, View response, no Retry, and dismissal. |
| `08-sequential-mode.png` | Open | Fresh Sequential creation works, but there is no run-thread reassignment control; added stages default to the first thread, so the target multi-thread causal chain cannot be built through the current UI. Exact visual conformance is unproven. | Build the target ordered multi-thread chain through UI controls, verify Main dispatch and causal inputs, save, reload, and compare all panes. |
| `09-first-use-empty-state.png` | Open | Empty state is functional, but creation actions render Parallel before Sequential rather than the target order. Empty navigation/right-pane companion states and exact target styling are unverified. | Open a truly fresh preset and compare copy, action order, disabled reasons, panel composition, focus, creation result, and saved draft. |

## Mobile target conformance matrix

The mobile targets define dedicated portrait interaction patterns. The current responsive implementation only stacks the desktop `threads`, `graph`, and `inspector` panes at narrow widths. It does not yet implement the target's pane selectors, docked context sheets, full-screen block route, or fixed mobile action/status bars.

| Target | Current status | Confirmed gaps | Evidence still required |
|---|---|---|---|
| `mobile/01-parallel-graph-overview.png` | Open | No target `Threads 3` / `Details` mobile pane controls, selected-thread docked sheet, or fixed Add stage/Add run/Graph settings bar. Current narrow layout vertically emits all desktop panes. | Build and inspect the target topology at 725px portrait width. |
| `mobile/02-thread-workspace.png` | Open | No target mobile workspace header/context strip, Threads selector, docked Thread settings summary, or fixed Add prompt/Category actions. | Exercise the real controlled workspace at the target viewport and compare categories, rows, status, sheets, and actions. |
| `mobile/03-controlled-block-editor.png` | Open | No APC route matching the target full-screen Edit block page, breadcrumb/progress, thread card, or Cancel/Save changes footer. The host controlled editor currently remains embedded in the stacked workspace. | Open and save a block at the target viewport; compare every field and navigation transition. |
| `mobile/04-run-configuration.png` | Open | No target near-full-width run-details bottom sheet, drag handle, close/Done footer, or Thread card. Desktop configuration is stacked inline and still lacks run-thread reassignment. | Select and edit the target run at the target viewport. |
| `mobile/05-connection-consent.png` | Open | Current responsive consent dialog is a narrow fixed modal, not the target bottom sheet, and it lacks the same disclosure/navigation data as desktop target `05`. | Resolve and approve a real connection at the target viewport. |
| `mobile/06-live-graph-execution.png` | Open | No target mobile Execution summary card or fixed Stage/current-run/Stop bar. Existing inspector content is emitted as the stacked desktop inspector. | Execute a real graph at the target viewport and compare progress, graph, activity, and Stop. |
| `mobile/07-required-failure-main-fallback.png` | Open | Missing producer data blocks the target cause/delivery copy; no target fixed delivered-status bar or mobile fallback projection exists. The pictured Retry action is deliberately absent because `UI-Mobile.md` prohibits manual retry in V1; this is an authorized target exception, not a gap. | Trigger a real required timeout/failure at the target viewport and verify the canonical no-Retry settlement controls. |
| `mobile/08-sequential-mode.png` | Open | No target Runs/Details controls, selected-run docked sheet, or fixed Add run/Reorder/Flow settings bar. Missing run-thread reassignment also prevents building the depicted chain. | Build the target sequence at the target viewport. |
| `mobile/09-first-use-empty-state.png` | Open | Current empty state lacks the target progress checklist, explainer rows, `Threads 0`, and fixed Graph settings bar. The pictured generic `Create first thread` action is deliberately replaced by separate Sequential and Parallel creation actions under the canonical contract; only their visual order and composition must be reconciled. | Open a truly fresh preset at the target viewport and compare the full state while preserving both canonical creation actions. |

### Authorized target exceptions

- `mobile/07-required-failure-main-fallback.png`: do not implement the pictured Retry action. Manual retry is outside the closed V1 runtime contract.
- `mobile/09-first-use-empty-state.png`: do not collapse first use into the pictured generic action. Separate **Create Sequential graph** and **Create Parallel graph** actions are required.
- Example names, providers, models, timings, outputs, and prompt content in every target remain illustrative rather than shipped defaults.

The source/test audit for these rows is in progress. Rows will be refined with exact selectors and observed screenshots.

## Confirmed functional and behavioral gaps

### UI-001 — Native thread selection did not open its workspace

- **Contract:** `UI.md` says selecting a native-block thread opens its reusable Loom workspace.
- **Observed:** selecting a graph thread previously changed only the right configuration pane; the user had to discover a second unlabeled-by-purpose workspace action.
- **Status:** Verified. Source projects a native thread selection directly into the Loom workspace and returns non-thread/main-context selections to topology. The integration regression passes, and rebuilt-host evidence confirmed first click → `data-apc-center-surface="loom"` with the real controlled host editor mounted.

### UI-002 — Controlled block edits appeared saved but reverted

- **Observed live:** adding a Blank Prompt persisted, but the first edited name/content displayed as Saved without reaching preset metadata and reverted on reload.
- **Repair:** dirty-write authority now survives equivalent controlled-editor renders and drops only genuinely stale thread/preset contexts.
- **Status:** Verified. Focused regressions pass. In the rebuilt host, editing the block name/content cleared Unsaved changes, `GET /api/v1/presets/:id` returned the edited block payload, and a full reload retained it.

### UI-003 — A scheduled run cannot be assigned to another reusable thread

- **Contract:** runs are scheduled uses of reusable threads; target `04` exposes a Thread selector and target `08` shows distinct threads in sequential stages.
- **Observed:** adding a Sequential stage always uses `threads[0]`. Parallel `Add run` picks the first thread not already in the stage. No run-thread change callback or control exists.
- **Status:** Open.

### UI-004 — Thread workspace context is visually incomplete

- **Contract:** target `02` keeps thread identity and graph navigation obvious while the controlled Loom surface is open.
- **Observed:** workspace rendering provides Back to graph and the opaque host surface, but deliberately omits the target heading/identity/context. Right-side status and actions also differ.
- **Status:** Open.

### UI-005 — Run configuration information architecture differs from target

- **Observed:** functional controls exist for position, requiredness, timeout, earlier-output bindings, roles, and missing-output policies. Target status/header/dispatch/thread-selection/output guidance does not.
- **Status:** Open.

### UI-006 — Consent review data and flow are incomplete

- **Observed:** the current blocking dialog and acknowledgement gate work. Target destination availability, purpose, explicit disclosure rows, source-selection step, scoping copy, and navigation are missing; some fields do not exist in the safe protocol DTO.
- **Status:** Open. Protocol and UI must be repaired together without exposing connection IDs or credentials.

### UI-007 — Required-failure and final-delivery evidence is missing at the producer

- **Contract:** target `07` and `DESIGN.md` require a fixed fallback cause, localized failed run/reason, and whether Main delivered.
- **Observed:** runtime `run-settled` omits failed-run `errorCategory`; terminal Graph-fallback omits canonical cause and final delivery. The frontend cannot infer these safely.
- **Status:** Open.

### UI-008 — Graph and inspector disagree during Main Graph-fallback

- **Observed:** the graph marks fallback amber but retains configured Thread route controls/output; the inspector presents Main fallback.
- **Status:** Open. Both panes must project the accepted terminal outcome rather than configured intent.

### UI-009 — Graph binding summaries omit required target details

- **Contract:** target `01`/`04` and `UI.md` require source run, `final` output, message role, and missing-output policy.
- **Observed:** topology binding labels show only `<thread> · Final Response`.
- **Status:** Open.

### UI-010 — First-use action order differs

- **Observed:** current DOM order is Create Parallel graph, then Create Sequential graph; target `09` and the written contract introduce Sequential first.
- **Status:** Open.

### UI-011 — Final-response viewing is not wired

- **Contract:** target `07` and `UI-Mobile.md` place response viewing adjacent to the authoritative delivered Main Graph-fallback.
- **Observed:** APC has no View response action. The activity protocol correctly excludes response bodies, but the existing authenticated `spindle.ui.closeDrawer({ userId })` automation can return the user from Loom to the current chat after delivery without duplicating response data.
- **Status:** Open. Add a scoped frontend intent and backend action gated on the accepted delivered execution; never scrape host state or persist response content in APC.

## Live journey evidence

Evidence gathered in the registered isolated macOS host at `http://127.0.0.1:7881`:

- A fresh Sequential preset exposed the explicit empty state and created one thread, one stage, and one run.
- The Sequential graph was extended through the UI to three threads and three stages. Every stage used Thread 1, confirming UI-003.
- A fresh Parallel preset created one thread/stage/run and was extended through the UI to three threads, three runs in Stage 1, and two runs in Stage 2.
- A native Thread 1 workspace opened the real host-controlled Loom editor. Add Prompt → Blank Prompt worked.
- Edit Block exposed native Name, Role, Position, Content, Insert Macro, locking, injection triggers, character tags, Prompt Variables, and Save controls.
- A repaired controlled edit changed the block name/content, cleared Unsaved changes, appeared in the preset API payload, and survived a full page reload, verifying UI-002.

Temporary evidence presets must be removed after the repaired journeys are re-run.

## Mockups needed

The 18 supplied targets cover baseline wide-desktop and portrait-mobile states. The following user-visible variants still have no final mockup.

### Global shell and responsive behavior

- Intermediate-width compact two-pane layout between the supplied desktop and portrait-mobile compositions.
- Mobile landscape and tablet-width adaptations not represented by the portrait targets.
- Forced-colors/high-contrast rendering.
- Keyboard focus and focus-restoration states.
- Reduced-motion state where movement/status still remains understandable.
- Configuration not hydrated / setup placeholder.

### First use, validation, and persistence

- Invalid or unavailable APC configuration.
- Invalid active mode.
- Unsupported, permission-blocked, or unresolved mode with its disabled reason.
- Dirty/saving/saved/save-failed/stale/execution-locked status.
- Mode-transition save failure and rollback.
- Empty navigation/right-pane companions around target `09`.

### Graph construction and capacity

- Add/remove/reorder thread, stage, and run states.
- Destructive confirmation for a referenced thread, stage, run, or connection slot.
- Thread, stage, run, parallel-width, binding, and final-input capacity limits.
- Connection slots: none configured, loading/unavailable, bound, stale, referenced, and at capacity.
- Final Thread route unavailable because `final_response` permission/capability is missing.
- No valid final-run candidate / selected final-run state.
- Invalid graph validation list and repair state.

### Thread and controlled workspace

- No thread selected.
- `main-context` read-only explanation and run configuration.
- Native workspace loading/mount failure.
- Empty controlled workspace.
- Category creation, marker creation, collapsed category, block disabled, block locked, sealed block, block validation failure, and delete confirmation.
- Prompt-variable empty/configured/invalid states.
- Unsaved controlled edit, save pending, save failure, and stale edit.
- Thread duplication and destructive removal impact.
- Workspace status variants: saved, dirty, invalid, and unavailable.

### Run configuration

- No earlier output available.
- Add binding disabled or at capacity.
- Invalid/stale binding source.
- `fail-graph`, `skip-run`, and omit/append-survivors states.
- Required run locked by final-route closure.
- Run position restricted by dependency ordering.
- Run configuration locked during execution.

### Connection and consent

- Main-inherited connection review in Sequential mode.
- `main-context` disclosure.
- No connections, connection list loading/failure, slot unbound, destination unavailable, stale destination, and successful rebind.
- Consent resolution pending/failure.
- Missing, approved, stale, revoked, approval-pending, and revoke-pending consent.
- Required, optional, mixed, and unscheduled consequences after consent dismissal.
- Consent review in compact/stacked layouts.

### Execution, outcomes, and traces

- Terminal success for Main and Thread final routes.
- Optional-local failure with omit/skip reason.
- Selected-final failure.
- User Stop / parent-cancel settled state.
- Deadline timeout and child-timeout.
- Integrity-fatal outcome.
- Final-response permission loss during execution.
- Runtime/trace admission fallback.
- Permission revocation while active.
- Active execution hydration/reconnect.
- Sequential live execution variant.
- Parallel live execution variant beyond target `06`.
- Main fallback delivered, not delivered, and unavailable/unknown.
- Trace list empty/loading/error/truncated states.
- Trace detail view and repeated trace actions.
- Terminal outcome dismissed / return-to-configuration state.

### Nonvisual lifecycle states

These require behavioral evidence but normally do not need mockups:

- Extension disable/update/unload teardown.
- Revoked host helper handles.
- Stale callbacks and detached controls ignored.
- Worker/runtime disposal and cancellation races.
- Secret/opaque identifier containment.
