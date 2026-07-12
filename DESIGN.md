# Agentic Preset Composer (APC) — Canonical Design

> **Gate 0 decision recorded; local-only preparation authorized.** This is the
> canonical APC contract, not permission to make a core change, type package,
> branch, PR, remote, or release externally available. The full companion set
> remains private until it is review-ready and the user directs publication.
> Each eventual core PR receives ordinary upstream review; no preauthorization
> or written acknowledgment matrix is required.
>
> **Current basis.** The capability assessment was made against
> `origin/staging` `737b9995f994dbc60d5e130c2314e85fca864365`, including
> upstream commit `390be052410e57405f5ac813da02d9d019e6298e` and the later
> relevant PR #231 changes. A bounded revalidation through current
> `origin/staging` `5c23a259efe902f86303599585e0e46c9511d471` found changes
> only in disk-health, Operator-panel, and install documentation/scripts; it
> changed no Spindle, preset, Loom, generation, or types surface. The capability
> verdict below is therefore unchanged.
>
> This document is the canonical APC product and security contract.
> `AUTHOR_BRIEF.md` is the authoritative local core-PR review and release
> protocol; `README.md` records the scaffold status. Neither may weaken this
> contract, and this contract may not weaken the release protocol.

## Product model

APC is an opt-in Spindle extension that lets a user run a preset as a
**distributed agent graph** rather than one monolithic prompt. A preset declares
one of three execution modes. For non-Single modes, APC's registered
post-assembly interceptor orchestrates role-specialized sub-generations,
composes their outputs, and routes a final result before the user-facing turn
settles. It generalizes Council: Council is one fixed multi-member pattern;
APC is a user-configurable, bounded agent graph.

APC is opt-in and non-breaking. A preset is APC-enabled only when it contains a
valid non-Single graph and the user selects a supported non-Single mode. Legacy
presets and presets without an APC bag normalize to
`supportedModes: ['single']` and `activeMode: 'single'`; their generation path
is unchanged.

APC executes only from the post-assembly interception point. It does not
duplicate native prompt assembly, put additional-thread blocks in the flat Main
Thread `prompt_order`, or bypass the native generation lifecycle.

## Current upstream foundations

Current staging provides valuable generic Spindle foundations. APC must reuse
them rather than recreate parallel generic surfaces:

1. **Top-level metadata passthrough.**
   `LoomPreset.passthroughMetadata` preserves metadata entries that are neither
   Loom-owned nor `_lumiverse_*`; the upstream regression includes the top-level
   APC shape. This is the persistence foundation for APC's portable bag.
2. **Native preset-editor tab and draft helper.**
   `ctx.ui.registerPresetEditorTab` and
   `ctx.ui.presetEditor.{getState,onChange,updatePreset,flush}` provide the
   Agent Graph tab's native editor integration and draft lifecycle.
3. **Native arbitrary-block assembly.**
   `spindle.assemble({ blocks, chatId, connectionId?, personaId?,
   generationType?, promptVariables?, signal? })` creates a transient Loom
   preset, performs native assembly, returns messages and Breakdown, invokes no
   LLM, does not recurse through the ordinary context/message-interceptor
   pipeline, and uses `macroCommit: false`.
4. **Nonrecursive quiet generation.**
   `spindle.generate.quiet` accepts prebuilt messages, optional connection,
   reasoning/parameters/tools, and a caller-owned signal. It is the direct
   provider foundation for APC subcalls.
5. **A 300-second interceptor ceiling.** Per-invocation interceptor time is
   clamped to 1–300 seconds, sufficient for APC's graph wall-clock budget.
6. **Richer pre-assembly generation context.**
   `spindle.contracts.preAssemblyGenerationContext = 1` supplies `userId` and
   `dryRun`; `cancelGeneration: true` stops before prompt assembly and Main
   dispatch.
7. **Post-assembly mutation.** Interceptors can replace messages, return
   permitted parameters, and contribute Breakdown attribution.

These are foundations, not reduced substitutes for the canonical contract.
`spindle.assemble` is not parent-bound APC assembly; quiet generation is not
revision-bound tracked dispatch; the context contract is not callback-bound
nested cancellation; and ordinary post-assembly mutation is not authenticated
terminal placement. The six gates below add only the complementary host behavior
that those foundations do not provide.

## Execution modes

The `presets`-gated toolbar renders **Single | Sequential | Parallel** above
LoomBuilder's list/edit branch as an accessible radiogroup. A preset declares
unique `supportedModes`; `single` is mandatory.

- **Single** — today's behavior. APC is bypassed; native assembly and provider
  dispatch proceed unchanged. Selecting Single activates the built-in
  **Blocks** tab.
- **Sequential** — runs one thread per ordered stage. Every call uses the
  authoritative Main connection. Each stage feeds the next in configured order.
- **Parallel** — runs ordered stages whose distinct threads may overlap within a
  stage. A thread may resolve a locally bound connection slot or inherit Main.
  The hard width is four concurrent runs per stage; APC drains with
  `allSettled`, and output order remains configured order rather than completion
  order.

All three choices remain visible. Unsupported, invalid, unresolved, or
permission-blocked choices are disabled with associated reasons. A valid
non-Single selection activates APC's registered **Agent Graph** tab. Mode
activation is a namespace-scoped draft update followed by the shared save
coordinator's generation flush; a failed flush restores the last persisted mode
and announces the failure without touching either pipeline.

## Portable graph data

The portable graph lives at the single top-level key
`metadata.agentic_preset_composer`. `LoomPreset.passthroughMetadata` carries
that opaque, versioned bag alongside every unrelated passthrough sibling; APC
alone decodes and validates its contents under a two-phase rule:

1. validate the envelope, global caps, and shared records; then
2. validate path-local objects and references.

Connection UUIDs never enter portable metadata. There is one APC wire shape and
one source of truth. The persisted-data audit found no installed APC extension
and no local preset rows using any earlier APC layout, so the clean cutover needs
neither speculative dual reads nor a compatibility write path. If real
previously persisted data is later identified, migration is reassessed before it
is deployed.

Loom-native persistence paths must preserve the bag and every unrelated
passthrough sibling. Legacy SillyTavern conversion intentionally does not
preserve arbitrary passthrough metadata.

## Threads, outputs, and pipelines

- **Main Thread** — fixed and always present; it owns the live top-level Loom
  blocks and variables.
- **Threads** — each added thread is one invocation-local workspace.
  `native-blocks` uses shared Loom editing and native assembly;
  `main-context` clones assembled Main messages. A repeated thread reuses one
  workspace across later stages and cannot run twice in one stage.
- **Outputs** — every thread exposes one `final` output. Synthesis or voting is
  an ordinary downstream thread, never an implicit operation.
- **Pipelines** — Sequential has exactly one run per stage. Parallel has one to
  four runs per stage with distinct threads. References target earlier stages
  only. The final route is either **Main** or one designated **thread** run.

For a Main final route, resolved outputs are composed into Main guidance. The
host places that guidance immediately before the exact authenticated assistant
prefill carrier at the terminal dispatch boundary, not merely at an earlier
interceptor pass. For a thread final route, the designated run supplies the
user-facing assistant response through the privileged host finalization path.
Both routes are canonical; a missing privileged capability or permission makes
the thread-final choice unavailable with an explicit reason rather than silently
redefining the graph.

V1 actions are closed: execute a thread run, bind literals or prior-thread
outputs, and route one final. There are no arbitrary scripts, branches, loops,
parsers, or implicit votes. Missing-output bindings resolve before
workspace/deadline: `fail-graph` wins, then `skip-run`, then omit the binding
and append survivors. Each survivor becomes its own configured-role message with
a display-delimiter wrapper. The wrapper is not a security boundary: output is
untrusted model-authored text and is never parsed or treated as provenance.

## Privacy, dispatch, and connection invariants

Every generation call carries a required discriminated dispatch source:

- `main` contains no connection ID and binds only to the active callback's
  `MainDispatchSnapshot`;
- `slot` contains the explicit connection ID.

Both carry the exact expected `connectionDispatchRevision`. Equal IDs or
revisions never alias sources; resolved assembly, trusted receipts, consent, and
traces all echo the source.

Privacy requires an opaque effective dispatch revision:
`base64url(SHA-256(...))` over every mutable database input to the call:
connection base token, dispatch-affecting columns, the distinct
missing/present encrypted-secret tuple, preset parameters, and reasoning
settings. The PR 4 assembly and tracked-dispatch paths check it atomically.
List-then-call fingerprints and roulette parents cannot authorize a destination:
every run requires a concrete, nonnull dispatch revision or fails before assembly
or provider work.

Runtime derives a closed source key from portable metadata: reserved `main` for
inherited Main, or `slot:<canonical UUID>` for an explicit slot. Per-user state
binds only `(presetId, slotId)` slots. Consent keys are
`(installId, nonce, presetId, threadId, workspaceSource, connectionSourceKey,
connectionId, dispatchRevision, DISCLOSURE_VERSION)`. `main` resolves only
authoritative Main, never a slot binding or hint.

Explicit slots are bound and consented through backend `resolveDispatch`;
frontend payloads never assert a revision. Inherited Main is runtime-dynamic:
when its exact descriptor lacks consent, APC makes zero subcalls, emits one
bounded `consent_required` trace, and Graph-fallbacks to Main.

The backend is the sole local-state writer. Binding and consent intents serialize
under `(authoritativeCallbackUserId, presetId)` queues, read-latest/derive/
temp-and-move, and a volatile monotonic `mutationEpoch` aborts only matching
executions. The frontend sends neither a user ID nor whole documents.

## Invocation, cancellation, and non-commit invariants

An interceptor request crosses `postMessage`; cancellation is therefore an
explicit **`intercept_abort` protocol**, never a serialized host
`AbortSignal`. PR 5 binds each authoritative callback to a host-created
invocation identity and worker-local signal. Each run composes
`AbortSignal.any([interceptorSignal, graphSignal, runDeadline])` for cloning,
assembly, and tracked quiet dispatch.

Stop, replacement, host/graph/run timeout, required failure, permission loss,
and disable/update abort controllers. The graph drains with `allSettled`, rolls
back identifiable provisional state, and settles once. The 300-second
interceptor budget supports the graph deadline but never replaces
callback-bound cancellation propagation.

At matched callback entry, the host resolves the existing manifest-controlled
interceptor timeout into an absolute `interceptorDeadlineAt`, then computes
`boundWorkDeadlineAt = min(entry + 285000 ms, interceptorDeadlineAt - 15000
ms)`. APC subcalls stop at the work deadline; the reserve is for host terminal
transition and drain only. The fixed containment grace is teardown-only and
cannot admit new APC work or extend either deadline.

The host retains one private `ParentPrefillAttestation` and derives only
purpose/request-scoped child uses from it. First-run branch continuations receive
distinct one-use worker children; retries are replay, not a second use. The
worker-callable `WorkerInvocationBinding` ends when the handler settles. A
separate host-only `TerminalFinalizationLease` retains accepted directive/final
provenance until parent terminal settlement and mints a fresh one-use terminal
child immediately before every initial, retry, continuation, inline-tool, or
fallback provider dispatch. No worker receives a carrier index, parent
attestation, terminal child, or post-settlement authority.

Current transient native assembly is a useful foundation, but APC requires
host-attested non-commit containment. Before every non-committing
context/world-info/macro hook, the host acquires a read-only lease. During that
lease it blocks mutating and reentrant worker operations while still permitting
authenticated cancellation and manager teardown that only reduce pre-existing
work.

A contradiction among host-owned binding, scope, lease, retrieval, or provenance
maps latches a branded, non-exported `HostFatalInterceptorError` with a closed
code set, including `NONCOMMIT_CONTAINMENT_FAILED`. It bypasses ordinary
interceptor fail-open behavior, aborts siblings, and yields no Main provider call
and no APC/Main persistence. Worker-authored names, payloads, IDs, dispatch
sources, and revisions cannot forge that channel; they remain ordinary
Graph-fallback faults.

## Parent retrieval snapshot

Native-block threads always reuse Main's host-owned **parent retrieval
snapshot**: the exact resolved vector world-info, chat-memory/Cortex, and
databank inputs, results, and settings from parent assembly. It is deep-frozen
and bound to `(userId, chatId, generationId)`.

Cold additional assembly may not issue embeddings, perform fresh retrieval, or
mutate retrieval caches or database state. APC adds no retrieval embedding
request or cache write. Connection overrides change only LLM dispatch, never
retrieval policy. A missing, expired, unavailable, or oversize parent snapshot
fails closed; it never falls back to fresh retrieval.

## Council coexistence and effect boundary

Council remains enabled. APC never suppresses or silently reorders it.

Sidecar Council can execute before APC's prompt-pipeline interception and may
already have issued provider/tool calls and completed history/cache writes. Those
external and persisted effects are explicit, traceable, **nonrollbackable**
effects. A later APC containment fatal prevents Main/APC persistence and
compensates only identifiable host-owned provisional state; it cannot promise a
universal transaction rollback over Sidecar.

The ordering is deliberate and testable. Existing Sidecar work completes first;
authoritative pre-assembly context then settles; the host captures one immutable
`MainDispatchSnapshot` before ordinary prompt assembly. After Main retrieval and
before post-assembly interception, it captures the bound
`ParentRetrievalSnapshot` and parent prefill attestation. Subsequent Main
assembly/dispatch, APC-bound calls, retries, continuations, and later inline
rounds use those snapshots. Earlier Sidecar calls receive no retroactive APC
attestation, receipt, or rollback promise.

Later provider routes remain subject to APC's terminal validation. PR 5 must
enumerate and protect the initial Main dispatch, retries, continuations, inline
Council/tool rounds, and any other provider path: each must revalidate the
host-owned guidance carrier, provenance, budget, Breakdown, dispatch revision,
and receipt immediately before provider work. The editor cannot know whether a
generation-resolved prompt includes Council material, so every non-Single graph
shows a conservative route warning.

## Frontend trust and cooperative authority

Frontend extensions run as trusted same-origin code in the authenticated host
page. Namespace-scoped APC mutation and cloned read-only Main fields are
cooperative least-authority APIs: they reduce accidental cross-extension and
host-state writes, but they are not a hostile-code sandbox or isolation boundary.
The backend's authoritative callback binding, permissions, dispatch checks, and
host-owned fatal channel remain the security boundaries.

## Observable failure outcomes

A single monotonic latch chooses one observable outcome per execution:

**integrity-fatal > parent-cancel > selected-final failure > Graph-fallback >
optional-local > success.**

Within Graph-fallback, a fixed cause rank orders host gates,
retrieval/dispatch/consent, capacity/config/graph/prefill,
assembly/setup/storage, timeout, and required typed run failure. A required
typed failure (hook, macro, provider, tool, blank, or oversize) projects to
Graph-fallback. An optional typed failure follows the run's omit/skip policy and
continues. Final settlement rechecks host signal, live permissions/revisions,
receipt containment, and selected-final state.

## Prerequisite host capabilities — six ordered core PRs

APC remains design-only until six **independently testable, serial-unstacked**
host capability gates land. They are first prepared as a private local review
bundle, with the separate lock-alignment baseline change before the six gates.
That local sequence may exercise combined behavior, but it is never an external
stack of PRs. Upstream's foundations reduce the work inside these gates; they do
not collapse, reorder, or replace any gate. PRs 2–6 publish the matching additive
`lumiverse-spindle-types` release required by their public surface only when the
user later authorizes the external review sequence.

### PR 1 — passthrough integrity and LumiHub

**Branch:** `feat/preset-extension-metadata`  
**Depends on:** nothing

Reuse `LoomPreset.passthroughMetadata`; do not invent a second metadata
container. Verify lossless preservation of every passthrough sibling through
normal Loom persistence, duplication, and internal import/export, and make
LumiHub create/update preserve those fields rather than rebuilding fixed
metadata. Validate the clean top-level APC shape. This gate is generic
passthrough integrity and LumiHub only.

### PR 2 — preset-editor integration and safe persistence

**Branch:** `feat/spindle-preset-editor-surface`  
**Depends on:** PR 1

Reuse the native preset-editor tab and draft helper. Add only the canonical
complement:

- the persistent **Single | Sequential | Parallel** toolbar;
- built-in **Blocks**-tab activation for Single;
- an APC-namespace-scoped mutator and cloned read-only Main fields;
- synchronous permission-revocation teardown of mounted tabs and draft
  subscriptions;
- one module-global, per-preset save coordinator shared by every preset writer;
- a generation-flush barrier that prevents dispatch against an unpersisted graph
  revision.

### PR 3 — shared controlled native Loom editor

**Branch:** `feat/spindle-loom-block-editor`  
**Depends on:** PR 2

Extract one controlled native Loom block editor that Main itself uses and that an
extension can mount for a thread workspace. The bridge operates on cloned values
and seals host-only fields; it must not expose active
chat/character/persona/connection/preset state or turn extension-controlled
values into host authority. APC uses this shared editor for native-block threads,
not a parallel hand-written editor.

### PR 4 — host-internal parent-bound assembly and dispatch substrate

**Branch:** `feat/spindle-generate-assemble`  
**Depends on:** PR 3

Reuse `spindle.assemble` and quiet-generation internals to build an independently
testable **host-internal** substrate:

- frozen parent route, retrieval, dispatch, and authenticated prefill snapshots;
- a private parent-prefill attestation plus purpose/request-scoped one-use child
  attachments for branch continuations and later host terminal dispatches;
- opaque invocation-token enforcement for nested RPC identity, user/chat/
  generation scope, cancellation authority, and host-computed work deadlines;
- separate worker-invocation and host-only terminal/finalization lifetimes;
- non-committing read-only leases and the host-fatal containment channel;
- typed tracked dispatch outcomes, immutable source revisions, and trustworthy
  receipts.

PR 4 defines and tests the substrate, including the no-fresh-retrieval
invariant. It does **not** bind ordinary interceptor callbacks, issue APC
callback tokens, register APC runtime behavior, or claim that callback lifecycle
is solved. It is the prerequisite internal substrate for PR 5, not an
extension-only APC engine.

### PR 5 — authoritative callback lifecycle and terminal placement

**Branch:** `feat/spindle-interceptor-context`  
**Depends on:** PR 4

For every authoritative callback, the host creates the PR 4
`WorkerInvocationBinding` and host-only `TerminalFinalizationLease`, installs the
worker binding, and exposes only the bound effective context, work deadline, and
worker-local signal. User/chat/generation scope derives exclusively from that
binding. Host-side preset/mode/route matching avoids irrelevant worker work, and
an idempotent registration disposer owns teardown.

Handler settlement ends worker RPC authority. Accepted directive/final
provenance moves to the host-only terminal lease, which survives only until
parent completion, cancellation, permission loss, unload, disable/update, or a
confirmed containment fatal. Using PR 4's snapshots, tracked outcome, parent
attestation, and containment channel, PR 5 implements deferred host-owned
guidance placement.
Immediately before every provider dispatch it mints and consumes a fresh purpose/request-
bound terminal child, authenticates or restores the prefill carrier,
rebuilds/reclips budget and Breakdown, and revalidates terminal provenance.
Existing post-assembly message, parameter, and Breakdown mutation remains the
foundation; PR 5 adds terminal enforcement rather than recreating that surface.

### PR 6 — thread-final finalization, compatibility, and locale

**Branch:** `feat/spindle-interceptor-final-response`  
**Depends on:** PR 5

Add privileged, provenance-validated thread-final finalization so a graph may
route its final response through Main or a designated thread. Define one
immutable shared backend/frontend host descriptor and enforce generic manifest
minimum/capability requirements before incompatible extension source loads.
After a compatible APC source load, the only pre-readiness operations are
immutable synchronous descriptor reads and one bounded nonce/digest
backend/frontend handshake; they perform no storage or domain work and remove
their listeners on mismatch or timeout. Mount, storage, registration, preset,
interceptor, generation, and other domain calls remain blocked until readiness.
Add a host locale getter/change subscription plus complete live-switching
catalogs for `en`, `zh`, `zh-TW`, `ja`, `fr`, and `it`.

The six PRs may be administratively renamed or reshaped only if their ordering,
scope, and independently testable capability gates remain equivalent. Replacing
them with reduced workstreams is a Gate 0 product-contract change.

## Local bundle and later release discipline

Prepare the upstream lock-alignment correction as private **PR 0**, then record
six separately testable capability patchsets. Compose those immutable patchsets
only in a separate disposable local integration clone. Remove every remote from
that clone, leave its integration branch without an upstream, and install a
clone-local `pre-push` guard that rejects every destination. The local workflow
forbids bypassing or replacing that guard, adding a remote/push URL, or using
`--no-verify`. The integration clone is never an external PR source. The local
bundle must contain each eventual PR's focused tests, documentation, locale
changes, types source where applicable, and independent review record before any
component is made externally available.

When the user authorizes publication, reconstruct and reverify the sequence as
serial, unstacked upstream PRs: merge PR 0 first; after every predecessor
merges, fetch current `origin/staging`, perform the bounded drift check, and
branch the next PR fresh from that base. Never push a stacked branch, transfer
an integration commit, or publish a type candidate before its matching external
PR is ready. The maintainer reviews each PR through the normal upstream process.

Before preparing the local PR 1 patchset, they must:

1. verify that local-only commit `45acd748` contains the preserved current WIP,
   including the formerly untracked material;
2. rename the old local branch to a clearly named archive branch, unset its
   upstream and `pushRemote`, and verify no remote ref contains it; and only then
3. derive the patchset from the latest `origin/staging`. Create the fresh
   `feat/preset-extension-metadata` branch only after external publication is
   authorized and PR 0 has merged.

The earlier APC design is preserved in extension-repository commit `e4bbe6c`.
Both commits are recovery history, not an implementation base: transplant only
changes independently justified by the approved gate scope.

There is a separate upstream baseline defect: the root and frontend manifests
declare `lumiverse-spindle-types` `0.6.2`, while both corresponding lockfiles
resolve `0.6.1`. Published `0.6.2` contains the upstream foundations described
above. Prepare a discrete local **PR 0** to synchronize those locks; it must merge
before any frozen-install/type-surface parity claim and is not folded into an APC
capability gate.

## Gate 0 decision and halt condition

The user has approved this contract for local-only preparation. The upstream
author will review each later core PR normally; no separate authorization,
ownership matrix, or external handoff blocks private work. A review request,
rejection, or material reshape of a later PR reopens the affected contract
boundary before that PR proceeds.

**No APC runtime implementation begins until all six core PRs merge into
`staging` and every matching type release is published.** Before that point the
extension performs no APC registration, mount, storage, or subcall work. There
are no fallback paths: no DOM hacks, duplicated prompt assembly, event-only
cancellation, unsafe metadata writes, or compatibility shims.

After the six gates lift the implementation halt, compatibility bootstrap is the
only exception to the pre-readiness no-work rule: immutable `spindle.host` /
`ctx.host` descriptor reads plus one bounded nonce/digest message exchange.
Everything else stays inert until that bootstrap succeeds.

## Companion documents

- `AUTHOR_BRIEF.md` — local core-PR review guide for this Gate 0 contract.
- `README.md` — design-only scaffold status and implementation halt.
