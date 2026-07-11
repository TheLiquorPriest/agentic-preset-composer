# Agentic Preset Composer — Gate 0 upstream handoff

This document is the concise Gate 0 upstream handoff required before any code, branch, package, or PR work on the **Agentic Preset Composer (APC)** Spindle extension. It supersedes the earlier four-gap brief entirely. Nothing in the old brief — the "buildable-today MVP," the four optional gaps, the Council mutual-exclusion claim, or the drawer-tab fallback — is current. The complete specification is the approved plan at <https://gist.github.com/TheLiquorPriest/7e34429d87d0d0b72f7db36ee6dfa253> (raw SHA-256 `5cfa7cfb7461ceaa6aaacb31c68b8c582f647c84e7c8e8ecdddb1f8c62695877`) together with its factual current-API erratum at <https://gist.github.com/TheLiquorPriest/0d83d47a449e73d580edb572be817970> (raw SHA-256 `0f86ed540a04d21a31cac2017e5ea88d0b4eef66b085879a29eb69e19a71674c`). **Gate 0 acknowledgment binds this handoff, that exact checksummed plan, and that exact checksummed erratum together; the erratum governs its identified line-11 conflict.** No artifact alone supersedes details defined by the other two.

The earlier brief assumed APC could ship a working engine on the API as it stands today, then layer editor and native-block features on top. After a full design pass against the actual host constraints, that is not viable: the execution model APC needs (interceptor-authored dispatch on frozen host snapshots, non-commit assembly from inside a hook, per-thread connection slots with revision-checked consent) cannot be built on the current API without either unsafe metadata writes, duplicated prompt assembly, event-only cancellation, or compatibility shims — all of which I will not ship. So APC is specified here as it must be, and the host capabilities it requires are enumerated as six ordered, dependency-locked core PRs. APC itself stays blocked until all six merge into `staging` and their matching types patches are published.

The decisions I need from you, the upstream author, are at the bottom: for each of the six PRs, choose whether **you implement it** or **authorize me to author the diff**, and name who merges it on GitHub and who publishes the matching types patch to npm, plus the coordinated publication window. **Each row's written acknowledgment must cover this handoff's scope, the corresponding detail in the full plan, and the factual correction in the erratum — a row is not decided unless all three are accepted.** Nothing below changes until you sign off in writing.

---

## What APC is

**Agentic Preset Composer** is an opt-in Spindle extension that lets a user run a preset as a small, user-configured agent graph instead of one monolithic prompt. A generation today is one assembled prompt → one model call. APC lets the user define a bounded graph of additional LLM generation runs that execute from a post-assembly interceptor, compose their outputs, and either inject coordinated guidance into the Main prompt or author the Final Response directly — all before the normal user-facing turn completes. It is **opt-in and non-breaking**: a preset is APC-active only when the user configures and selects a non-Single mode; otherwise generation is byte-for-byte identical to today.

### Three execution modes

A single accessible toolbar radiogroup rendered above LoomBuilder's list/edit branch offers three choices. Every preset declares a unique `supportedModes`; `single` is mandatory. Legacy presets and presets without an APC bag normalize to `['single']` and `activeMode: 'single'`, preserving current behavior exactly.

- **Single** — bypasses APC entirely. Normal native generation, unchanged.
- **Sequential** — runs one thread per ordered stage. Every call uses the authoritative Main connection. Stage *N*'s output may be bound as an input to stage *N+1*.
- **Parallel** — runs ordered stages whose distinct threads may overlap within a stage (hard width cap of 4). Each thread may optionally resolve a locally bound connection slot; otherwise it inherits Main.

Unsupported, invalid, unresolved, or permission-blocked choices are disabled with an associated reason. All three choices stay visible. Mode activation is one scoped draft update followed by an awaited `flush()`; failure restores the last persisted mode and announces an error without touching either pipeline. Selecting a valid non-Single mode activates APC's **Agent Graph** tab; selecting Single activates the built-in **Blocks** tab. Either tab stays manually selectable.

### Threads, outputs, pipelines

Conceptually the user configures three things:

- **Threads** — a context + agent workspace. The **Main Thread** is fixed and always carries the live top-level Loom blocks/variables. Each *additional* thread is one invocation-local workspace: it either uses **native-blocks** (shared Loom editing/assembly, reusing Main's host-owned retrieval snapshot) or **main-context** (clones the assembled Main messages). A repeated thread reuses one workspace across later stages and cannot run twice in one stage. Each additional thread exposes exactly one `final` output.
- **Outputs** — what a thread produces. The Main Thread's output is the Final Response. Synthesis/voting is just an ordinary downstream thread that binds prior outputs as inputs. There is no implicit vote and no arbitrary code.
- **Pipelines** — the routing/sequencing glue. Each pipeline (Sequential and/or Parallel, independently editable) is an ordered list of **stages**, each stage a list of **runs**, each run binding one thread with literal and/or prior-output inputs, a required flag, a timeout, and a missing-output policy (`fail-graph`/`skip-run`/`omit-binding`). The pipeline's final route is either **Main** (inject composed guidance into the Main prompt) or **thread** (one designated run's output becomes the Final Response).

V1 actions are closed: execute a thread run, bind literals or prior outputs, route one final. No scripts, branches, loops, parsers, or implicit votes.

### Where the graph lives

The portable graph data lives at `metadata.extensions.agentic_preset_composer` — an opaque, versioned bag that core preserves losslessly and APC alone decodes/validates. It travels with the preset through internal export/import and duplication; legacy SillyTavern export intentionally omits it. Backend-only per-user storage holds atomic connection-slot bindings and consent records; regular extension storage holds an install nonce. Connection UUIDs never enter portable metadata — runtime derives a closed source key (`main` or `slot:<canonical UUID>`).

### Council coexistence

APC never suppresses or blocks Council. Council remains user-controlled and may already run — and spend latency/tokens — before APC's interceptor. Whether APC threads actually see Council deliberation depends on whether the generation-resolved Main prompt contains the Council macro; the editor cannot know resolved profile/Council state, so every non-Single graph shows a conservative route warning. This is a deliberate change from the earlier brief, which claimed mutual exclusion.

---

## Why APC cannot ship on the API as it stands

The host constraints below are not feature requests — they are the reasons the current API either cannot express what APC needs, or cannot express it safely. This is why the six PRs are prerequisites, not nice-to-haves.

1. **Native Loom presets keep a flat Main Thread in top-level `prompt_order`.** APC's additional thread blocks cannot be inserted into that flat array, because normal Main Thread assembly would leak them into the final prompt. APC must execute from a post-assembly interceptor that operates on already-assembled messages and builds its own per-thread workspaces.

2. **The current `generate.quiet` accepts prebuilt messages/connections but does not assemble native blocks; PR 4 adds receipt-bearing `generate.quietTracked` over that prebuilt-message path, while the prerequisite `generate.assemble` adds native additional-thread assembly without message interceptors.** APC's `native-blocks` threads need real Loom assembly (macro/marker/WI resolution) from inside an interceptor. Today the only assembly path is `dryRun`, which re-runs the full interceptor pipeline — i.e. APC would recurse into itself — and only works against a saved preset, not arbitrary blocks.

3. **Assembly must be non-committing.** `commit:false` alone is not enough: cold additional-thread assembly must not issue embedding requests or mutate retrieval caches/DB state. It must reuse the host-owned parent Main retrieval snapshot exactly. That requires a host read-only lease that blocks every mutating/reentrant WorkerToHost operation while any nested assembly hook is live — a worker-set flag cannot prove non-commit.

4. **Dispatch must be revision-checked, not list-then-call.** Every generation call needs a required discriminated dispatch source (`main` or `slot`) carrying the exact expected `connectionDispatchRevision`, checked atomically inside assemble/quietTracked. Without it, a list-then-call fingerprint or a roulette parent could authorize a stale destination. That revision must cover every mutable DB input to the call (connection columns, encrypted secret tuple, preset parameters, reasoning settings) and rotate atomically in the same transaction as any dispatch-affecting mutation.

5. **Cancellation must cross the worker boundary.** `intercept_request` crosses `postMessage`, so an `AbortSignal` cannot be serialized. Cancellation is an explicit `intercept_abort` protocol plus a worker-local signal the host owns — not a serialized host `AbortSignal`, and not an event the extension polls.

6. **Containment must be host-attested, not worker-attested.** If a non-commit assembly goes wrong, a worker-authored flag, payload, or forged message must never be able to claim "host-validated" or veto the Main generation. Only a contradiction among host-owned maps/leases/scope facts can latch a host-fatal channel; everything worker-controlled fails open to an ordinary Graph-fallback.

7. **Editor integration needs real preset-editor surfaces.** The composer must live inside the native preset editor (LoomBuilder), not an exiled drawer tab. There is no preset-editor toolbar/tab/state API today — only a character-editor equivalent. And all whole-preset writers (Loom debounce, InputArea variables, rename, duplicate, profile selection) must funnel through one serialized save coordinator, or a rename or a duplicate can replace newer fields.

8. **Compatibility must be enforced, not assumed.** APC needs every prerequisite capability present at known versions before it does any work. That requires a synchronous host descriptor (version, API version, capability map, installation ID) that APC validates up front — with no code load, storage, or subcall on mismatch.

---

## The six ordered core PRs

These are dependency-locked and merged **serially, unstacked**: each branches fresh from the newest `origin/staging` after its prerequisite merges — never stacked on an unmerged feature branch. Base branch is `prolix-oc/Lumiverse:staging`, head is `TheLiquorPriest:<branch>`. Each ships complete in all six locales (`en`, `zh`, `zh-TW`, `ja`, `fr`, `it`).

PRs 2–6 each require a matching **additive** patch to `lumiverse-spindle-types`, published under the nondefault `lumiverse-pr` tag before draft and pinned at its exact registry version in both manifest and lock. Default `latest` stays at the prior version during review; promotion to `latest` happens inside a bounded window (at most 30 minutes before merge). Each PR also fixes the surviving `0.5.31` manifest / `0.5.30` lock drift where it applies.

### PR 1 — portable preset extension data
**Branch:** `feat/preset-extension-metadata`
**Depends on:** nothing (foundation)
**Scope:** Add `extensionsMeta: Record<string, unknown>` to `LoomPreset`; initialize to `{}` in `migratePreset` and `createNewLoomPreset`. `unmarshalPreset` reads `metadata.extensions` into `extensionsMeta`; `marshalPreset` and `marshalUpdate` write it back as the single reserved `metadata.extensions` bag. Preserve `_lumiverse_*` provenance unchanged; bare unknown top-level metadata stays intentionally dropped. Duplication awaits the source preset's pending-save flush (aborts on dirty failure), refetches the persisted row, and deep-copies `extensionsMeta` with every Loom field. Internal Loom export/import carries the bag; legacy SillyTavern export omits it. The LumiHub installer reads a valid incoming bag, stores it as `metadata.extensions` on create, and namespace-merges on update so absent namespaces survive while a shipped one updates authoritatively.
**Unlocks:** the opaque bag that APC's portable graph lives in. Without this, any graph a user builds is stripped the next time they save the preset in the editor.

### PR 2 — preset-editor extension surfaces, save coordinator, locale
**Branch:** `feat/spindle-preset-editor-surface`
**Depends on:** PR 1
**Scope:** Add `presets`-gated toolbar/tab registration and a scoped preset helper to `SpindleFrontendContext.ui`, mirroring the character-editor patterns (deep snapshots, unsubscribe, caps: 2 toolbar/extension and 4 global, 4/8 tabs, visibility/activation/title/destroy, closed sentinel, cleanup). The helper exposes cloned read-only Main blocks/variables but can mutate only the calling extension's own namespace; setters replace only that namespace with a record. Add a permission-free `SpindleLocaleHelper` (`en|zh|zh-TW|ja|fr|it`) driven by host i18next resolved language/events, not DOM/localStorage. Create one module-level **per-preset serialized save coordinator** and route *every* preset-content writer through its sole draft/revision — Loom debounce/immediate/structure/profile/load reconciliation, extension data, InputArea variables, rename **and** duplicate. One whole-preset request at a time; queue coalesces newest; immediate cancels debounce then follows in-flight. Export `flushPendingLoomPresetsNow()` and await it (besides settings) before start/regenerate/continue/dry-run; failure blocks generation. Render registered toolbar roots above list/edit; render built-in Blocks plus extension tabs only when registered.
**Unlocks:** the in-editor Agent Mode radiogroup and Agent Graph tab. The save coordinator is what makes "configure a graph, then Duplicate or rename the preset" safe — without it, concurrent writers corrupt each other.

### PR 3 — shared Loom block editor
**Branch:** `feat/spindle-loom-block-editor`
**Depends on:** PR 2 (release after)
**Scope:** Extract BlockEditor, sortable rows, marker menu, prompt-variable editing, and category/DnD state from `LoomBuilder.tsx` into one controlled `frontend/src/components/shared/LoomBlockEditor.tsx`; Main consumes the extraction (no copy). Publish an additive contract: `ctx.components.mountLoomBlockEditor(target, options)` as a **pure value editor** (`SpindleLoomBlockEditorHandle` with `getValue()`/`refreshMacros()`). It never reads active chat/character/persona/connection/preset stores, never calls contextual macro resolution, never renders host user data into the extension root, and never exposes arbitrary third-party macro metadata. `refreshMacros()` supplies only a sanitized built-in/public catalog plus the caller's own definitions. Bridge mount/edit/catalog is permission-free, in-memory, deep-cloned, category-normalized, malformed-update-rejecting, auto-cleaned; persistence stays in PR 2. Extend `PromptBlockDTO` with existing `characterTagTrigger?`; sealed provenance/control fields stay host-only — the bridge accepts/emits the DTO subset and cannot mint or change sealed fields. Main retains a private trusted preview resolver/context absent from the public DTO.
**Unlocks:** native, macro-aware, WI-scoped block editing inside each APC thread's workspace — instead of hand-written message snippets.

### PR 4 — assembly-only generation, dispatch snapshots, tracked receipts, non-commit containment, host-fatal channel
**Branch:** `feat/spindle-generate-assemble`
**Depends on:** PR 3 (release after)
**Scope:** This is the largest and most load-bearing PR.
- **`generate.assemble(input: AssemblyRequestDTO): Promise<AssemblyOutcomeDTO>`** — raw native assembly without message interceptors, `runMessageInterceptors:false`, `commit:false`. Carries an absolute `deadlineAt` (host clamps to the parent interceptor wall) and an optional `signal`. Returns messages, breakdown, `assistantPrefill`, and a resolved context; fails closed with typed hook/macro/retrieval/abort/precondition/security/internal failures. `hookFailureMode`/`macroFailureMode` default to native `degrade`; APC requests `reject`.
- **`connections.resolveDispatch(connectionId): Promise<ConnectionDispatchDescriptorDTO|null>`** — safe, credential-free descriptor (name/provider/model, resolved endpoint origin, dispatch kind, revision) read in one SQLite snapshot.
- **`generate.quietTracked(input: QuietTrackedRequestDTO): Promise<QuietTrackedResultDTO>`** — combined `{response, receipt}` transport. Response owns every non-usage field (content, reasoning, thinking blocks, reasoning details, tool calls with `thought_signature`); receipt owns full optional usage including bounded JSON-safe `provider_raw`, plus provider-invoked/terminal/revision facts. A `preflight` failure branch exists only before a valid `main|slot` dispatch source is established (`providerInvoked:false`, `receipt:null`); every terminal after that carries a truthful receipt.
- **Dispatch source** is a required discriminated union: `{source:'main', expectedConnectionRevision}` or `{source:'slot', connectionId, expectedConnectionRevision}`. Equal IDs/revisions never alias sources.
- **`connection_profiles.dispatch_revision`** — a new internal, non-public lifecycle/base token. `baseline.sql` declares it `TEXT NOT NULL`; the upgrade transactionally rebuilds the table and assigns every legacy row a distinct non-null 128-bit CSPRNG token. Official create/duplicate and every dispatch-affecting connection/secret mutation rotate that token in the same `BEGIN IMMEDIATE` transaction; rollback preserves the prior row, secret, and token.
- **`connectionDispatchRevision`** — the separate public revision exposed in safe descriptors: base64url SHA-256, domain/version separated over a length-delimited tuple containing the internal base token; exact dispatch-affecting connection columns; distinct missing/present encrypted-secret tuple; distinct no-preset/missing-preset/present-owned-preset ID plus exact persisted `presets.parameters` bytes; and distinct missing/present exact persisted user `reasoningSettings` bytes. Exact bytes make whitespace, key-order, and direct-SQL changes invalidate; malformed JSON fails closed.
- **`MainDispatchSnapshot`** — refactor native generation to run context handlers once, validate effective IDs, then build one immutable snapshot before Council and prompt assembly. Main assembly, interceptor context, native dispatch, retry/tool rounds, and APC `main` calls all use the same snapshot without DB re-read. Explicit-slot calls independently snapshot/check inside their transaction.
- **Parent retrieval snapshot** — at completion of ordinary Main retrieval, deep-freeze one bounded host-only snapshot bound to `(userId,chatId,generationId)`. Nested assemble calls share it read-only (reference-counted cleanup); cold additional-thread assembly bypasses every embedding/search/cache-write path. Missing/expired/unavailable/oversize snapshot is `ASSEMBLY_RETRIEVAL_SNAPSHOT_UNAVAILABLE`; never cold fallback.
- **Non-commit read-only lease** — WorkerHost acquires a per-worker lease before every `commit:false` hook and, while any lease is live, rejects *all* mutating WorkerToHost operations regardless of payload tags, plus `generate_assemble`, dry-run, and every prompt-assembly-entering RPC (`ASSEMBLY_REENTRANCY`). It default-denies everything except enumerated side-effect-free reads/local computation **and host-authenticated cancellation/teardown that only reduces existing work**. Abort or timeout latches cancellation but never releases the lease. Only acknowledged hook settlement or confirmed worker termination releases lease/pending state exactly once; no acknowledgment by the full fixed 1,000 ms host grace triggers termination. If termination cannot be confirmed, retain the logical lease, quarantine the worker/extension, and reject `NONCOMMIT_CONTAINMENT_FAILED` until manager-confirmed teardown.
- **Host-fatal channel** — a non-exported `HostFatalInterceptorError` branded by a module-private symbol, carrying a host-owned request ID and a closed code (`NONCOMMIT_CONTAINMENT_FAILED|HOST_USER_SCOPE_MISMATCH|HOST_CALLBACK_BINDING_MISMATCH|HOST_REQUEST_PROVENANCE_MISMATCH|HOST_RETRIEVAL_SCOPE_MISMATCH|HOST_IMPOSSIBLE_STATE`). Only WorkerHost/manager contradictions among host-owned maps/leases may latch it; worker error names, payloads, IDs, sources, revisions, and forged messages cannot. It survives a worker catching the nested rejection or returning a normal result, and propagates before provider dispatch/persistence.
**Unlocks:** the entire APC execution engine — revision-checked, non-committing, snapshot-isolated thread assembly and dispatch, with a containment boundary a worker cannot forge.

### PR 5 — authoritative, abort-aware interceptor context, matching, lifecycle
**Branch:** `feat/spindle-interceptor-context`
**Depends on:** PR 4 (release after)
**Scope:** Export and type `registerInterceptor` with the additive `InterceptorContextDTO` (host-reserved, never caller-overridable `userId` and `interceptorDeadlineAt`; exact safe `connectionDispatchDescriptor` plus matching ID/revision/kind; typed identities/options/dry-run/prefill/activated WI; calling extension's own preset namespace, deep-cloned and present only with live `presets`; worker-local `signal`). Add the `intercept_abort` protocol plus registration lifecycle: runtime generates a `registrationId`, posts it on register, returns an idempotent disposer that posts `unregister_interceptor`; WorkerHost maps the exact ID to the pipeline disposer so stale disposal cannot remove a newer registration. Permission revoke/unload auto-disposes; restore explicitly registers once. Serialized requests omit signals; the worker injects its controller. Validate/compile the serializable `InterceptorMatchDTO` at registration (safe own-namespace keys, bounded arrays/depth, no accessors/prototypes); evaluate it against frozen effective context immediately before timeout/activity/worker-post. APC matches non-dry `normal|continue|regenerate|swipe` plus `presetField:{path:['activeMode'],exists:true,notIn:['single']}` — absent/Single/dry-run/impersonate/quiet therefore cause **zero worker post, timeout, activity, or extension API work**.
**Unlocks:** the composition point APC registers at (priority 900), with authoritative identity, cooperative cancellation, and a match rule that keeps APC completely dormant for every generation it should not touch.

### PR 6 — interceptor-authored final response + compatibility descriptor
**Branch:** `feat/spindle-interceptor-final-response`
**Depends on:** PR 5 (release after)
**Scope:** Add privileged, **non-auto-granted** `final_response` permission everywhere, with six locale strings. Add `FinalResponseDTO` (`content`/`reasoning`, each capped independently at 1 MiB, plus `fallbackMessageIndex`) and extend `InterceptorResultDTO` with optional `finalResponse`. WorkerHost validates fallback provenance: the target must be one nonempty text-only system message newly inserted by that result; removing it must make the returned messages deep-equal the input; exactly one same-result breakdown entry must reference it; an inherited Main/user message cannot be pinned; with nonempty authoritative prefill, insertion must be immediately before the one exact assistant carrier. Full chain carries winner + fallback: omission retains; invalid/unauthorized warns and cannot erase; a valid later result replaces both and names supersession; usable winner shortcuts with no insertion; if a previously authorized winner becomes unusable, reinsert its snapshot exactly once before the last exact prefill carrier (zero/multiple carrier is `PREFILL_CARRIER_MISMATCH`). A thread candidate enters the sole `runGeneration` caller, skips provider/tool and prefill duplication, sets nonstreaming, emits one content/reasoning segment, then uses native regex/CoT/create/regenerate/swipe/continue/staged/pool/breakdown/expression/event finalization with no fabricated metrics. Add the immutable synchronous **`SpindleHostDescriptorV1`** to backend `spindle.host` and frontend `ctx.host`: `descriptorVersion:1`, `lumiverseVersion`, `spindleApiVersion`, `capabilities` map, `extensionInstallationId`. PR 6 seeds exactly six required entries at value `1`: `preset-extension-data-v1`, `preset-editor-v1`, `loom-block-editor-v1`, `generation-assembly-v1`, `interceptor-context-v1`, `interceptor-final-response-v1`. Manager enforces a manifest minimum on install/import/update/enable/worker/frontend load; missing minimum stays backward-compatible.
**Unlocks:** the thread-authored Final Response route *and* the compatibility gate every later capability (including APC) validates against before doing any work.

---

## Cross-cutting constraints

These apply across all six PRs and to the extension.

**Permissions.** APC requires `presets | interceptor | generation`; loss/unload of any required permission disposes the interceptor and aborts/drains pending work before any subcall. `final_response` is **optional, privileged, and never auto-granted**: absence degrades to Main guidance (no abort); late revoke restores the protected fallback. Required-permission loss at any phase aborts/drains/rolls back with exact ledgers and reason.

**Cancellation.** `intercept_abort` protocol + worker-local signal, forwarded to every nested generation call. Fixed `HOST_NONCOMMIT_CANCEL_GRACE_MS=1000` host-owned containment time after abort — caller/interceptor/run/graph deadlines latch the outcome but never shorten this grace. Stop, replacement, host `AbortSignal`, host shutdown, timeout, required failure, and disable/update all abort controllers; drain with `allSettled`, roll back, settle once. No in-flight authorization prompt or implicit grant.

**Six locales.** Host-owned labels/errors ship complete `en | zh | zh-TW | ja | fr | it`. APC owns an extension-local keyed catalog for the same six; all visible labels, validation, disclosures, and Council warnings use escaped interpolation. Accessibility never depends on icons or missing translation. Catalog completeness is release-gated.

**Types package.** Each of PRs 2–6 publishes a matching **additive** patch to `lumiverse-spindle-types` under the nondefault `lumiverse-pr` tag, pinned at its exact registry version in both manifest and lock, before draft. A clean consumer installs the frozen pin and reruns focused tests/typechecks/build/smoke with proven asset equivalence. Default `latest` stays at the prior version during review; promotion to `latest` is the bounded 30-minute merge window. Timeout/abort/reject restores the prior tag, deprecates the candidate with a missing-host warning, removes the PR tag, and blocks successors. PR 2 also reconciles the surviving `0.5.31`/`0.5.30` drift.

**Serial-unstacked merge.** Host PRs are serial but unstacked. After a prerequisite merges: record its merge SHA, fetch/sync, branch fresh from newest `origin/staging`. Never merge or cherry-pick feature predecessors. Revalidate merge-base and upstream state immediately before draft and before ready; material upstream drift requires rebase/reverification.

**Extension-after-merge.** APC runtime implementation begins **only after all six host PRs merge into `staging` and every matching types patch is published**. Before registration, mount, storage, or any API call, both APC entrypoints synchronously validate the exact descriptor, release constants, and six `{name:1}` requirements; missing/old/out-of-range/mixed/malformed host logs one actionable error and performs no APC work. Readiness is idempotent request/response (session-nonce hello, bounded retry/deadline), never one-shot. If you decline or reshape any gap, I halt and revise this contract — no DOM hacks, duplicated assembly, event-only cancellation, unsafe metadata writes, or compatibility shims.

---

## APC after the prerequisites land (summary)

Once all six PRs are in `staging` and published, APC: pins final types and sets its manifest minimum to the first release containing PR 6; requests `interceptor|generation|presets` with optional `final_response`; registers one priority-900 interceptor with the match rule above; builds the PR 2 toolbar/tab and PR 3 pure editor; decodes the opaque bag in two lossless phases; owns backend local state keyed by `(authoritativeCallbackUserId, ...)` with atomic temp+move writes and a volatile `mutationEpoch`; executes the graph under one computed deadline with copy-on-write workspaces and the observable failure-outcome table; implements focus/live-region/reduced-motion accessibility, six live-switch catalogs, trace previews, and clean teardown. This is documented here so the prerequisite contracts read in context — it is not part of what you are deciding now.

---

## Decisions required

For each of the six PRs below, I need a written decision in every applicable column; PR 1's two types-publication cells are explicitly non-applicable because the first types patch belongs to PR 2. **No branch, package, or PR work begins until I have written acknowledgment of all six rows, and each row must accept this handoff, the exact versioned/checksummed plan, and the exact versioned/checksummed erratum**: plan <https://gist.github.com/TheLiquorPriest/7e34429d87d0d0b72f7db36ee6dfa253> (SHA-256 `5cfa7cfb7461ceaa6aaacb31c68b8c582f647c84e7c8e8ecdddb1f8c62695877`); erratum <https://gist.github.com/TheLiquorPriest/0d83d47a449e73d580edb572be817970> (SHA-256 `0f86ed540a04d21a31cac2017e5ea88d0b4eef66b085879a29eb69e19a71674c`). The erratum governs the plan's identified line-11 current-API conflict. Any revision, changed checksum, or changed/rejected scope reopens Gate 0 before work proceeds.

| # | Branch / scope | Author choice *(upstream implements / authorize TheLiquorPriest diff)* | Implementer | GitHub merger *(who runs the merge on `prolix-oc/Lumiverse`)* | npm publisher *(who publishes the matching `lumiverse-spindle-types` patch)* | Candidate publication window *(when the `lumiverse-pr` patch ships, before draft)* | Notes / contract changes |
|---|---|---|---|---|---|---|---|
| 1 | `feat/preset-extension-metadata` — portable preset extension data | | | | N/A — first types patch is owned in row 2 | N/A — first types patch is scheduled in row 2 | |
| 2 | `feat/spindle-preset-editor-surface` — preset-editor surfaces, save coordinator, locale | | | | | | also reconciles 0.5.31/0.5.30 drift |
| 3 | `feat/spindle-loom-block-editor` — shared Loom block editor | | | | | | |
| 4 | `feat/spindle-generate-assemble` — assembly-only generation, dispatch snapshots, tracked receipts, non-commit containment, host-fatal channel | | | | | | largest PR; load-bearing containment boundary |
| 5 | `feat/spindle-interceptor-context` — authoritative abort-aware interceptor context, matching, lifecycle | | | | | | |
| 6 | `feat/spindle-interceptor-final-response` — interceptor-authored final response + compatibility descriptor | | | | | | seeds the six capability entries APC gates on |

### How to respond

- **Decide every applicable cell in writing.** PR 1's npm-publisher and candidate-window cells are prefilled `N/A`; every other decision cell needs a concrete answer. A blank applicable cell is not a decision, and partial acknowledgment blocks the whole sequence.
- **Changed or rejected scope — or any revision to the plan or erratum — reopens this contract.** If you want a gap shaped differently (a different dispatch model, a weaker containment boundary, a compatibility shortcut), or if either linked artifact or checksum changes, say so per row and I revise the handoff before any work starts. I will not silently adapt, and an acknowledgment against either stale checksum is invalid.
- **No branch or package work before acknowledgment.** No `feat/*` branches, no `gh pr create`, no `npm publish`, no types pin, until all six rows are decided. Identity, remotes, merge-base, and publication windows are recorded in an immutable ledger per PR once work is authorized.

— TheLiquorPriest
