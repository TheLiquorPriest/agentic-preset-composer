# Agentic Preset Composer (APC) — Canonical Design

> **Gate 0 decision recorded; local consolidated D–F implementation/evidence and one host PR are authorized.** This is
> the canonical APC contract, not permission to make APC runtime behavior, publish
> a type package, or make a remote/release externally available. PR 0 and host
> Gates A/B are historical records; current staging retains only the surviving
> controlled Loom foundation relevant to Gate C. The broader historical Gate C
> hardening is not current staging capability.
> Gates D–F are internal, separately testable slices of one APC-only host PR;
> they must remain strictly ordered D→E→F and retain their full scope. Existing
> aggregate types PR #32 is the cumulative D–F contract targeted at exactly
> `0.6.5`; package publication is owned by its upstream author, not this
> extension. The host candidate may exact-pin it only after upstream merges PR
> #32 and the author publishes `0.6.5`; no host draft/publication is authorized
> before that dependency and final evidence/red-team review.
>
> The earlier blanket publication hold is superseded for this authorized local
> path; it is not an active hold on local implementation/evidence. The upstream
> publication dependency remains.
> APC compatibility source/manifest alignment targets Lumiverse `1.0.8`; the
> capability validator still rejects any `1.0.8` host lacking the required Gate
> D–F capabilities. The candidate `0.6.5` types release also remains
> unpublished, and the consolidated host PR remains blocked.
>
> **Current basis.** Public `origin/staging` authority is
> `ab64f1601592ec95707ea79e68da8f537089bf3e`. It retains generic Spindle
> foundations and the controlled Loom editor/frontend/type surface only; local
> D–F prototypes and tests are evidence inputs, not current host capabilities.
>
> This document is the canonical APC product and security contract.
> `AUTHOR_BRIEF.md` is the authoritative consolidated host-PR review and release
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
   `ctx.ui.presetEditor.{getState,onChange,updatePreset,flush}` provide a
   generic tab root and draft lifecycle. APC later registers and renders its
   Agent Graph view through that root.
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
terminal placement. The remaining three gates add only the complementary host
behavior that those foundations do not provide.

## Core/extension presentation boundary

Across every gate, absent an APC extension registration or use of a new generic
mount/API, steady-state baseline Lumiverse controls, layout, DOM, and baseline
strings remain unchanged apart from generic conditional diagnostics. Any new host
diagnostic string is added to all six Lumiverse core locales.
Core exposes generic, inert placement, lifecycle, bridge, compatibility, locale,
and finalization roots only; it never adds APC-specific visuals, literals, or
catalogs. The APC frontend later registers the toolbar item and Agent Graph tab
through the generic host roots, then renders the **Single | Sequential |
Parallel** radiogroup, Agent Graph content, labels, disabled reasons, and
accessibility behavior there. No APC-specific locale catalog belongs in core.

## Execution modes

The APC frontend registers a mode-toolbar item through the generic host toolbar
root and renders **Single | Sequential | Parallel** above LoomBuilder's list/edit
branch as an accessible radiogroup. A preset declares unique `supportedModes`;
`single` is mandatory.

- **Single** — today's behavior. APC is bypassed; native assembly and provider
  dispatch proceed unchanged. Selecting Single asks the generic host API to
  activate the built-in preset editor (`blocks` API ID; current visible label **Preset**).
- **Sequential** — runs one thread per ordered stage. Every call uses the
  authoritative Main connection. Each stage feeds the next in configured order.
- **Parallel** — runs ordered stages whose distinct threads may overlap within a
  stage. A thread may resolve a locally bound connection slot or inherit Main.
  The hard width is four concurrent runs per stage; APC drains with
  `allSettled`, and output order remains configured order rather than completion
  order.

APC keeps all three choices visible. Unsupported, invalid, unresolved, or
permission-blocked choices are disabled by the APC frontend with APC-rendered
reasons. A valid non-Single selection asks the generic host tab root to mount
APC's registered **Agent Graph** view, whose content and accessibility behavior
remain APC-owned. Mode activation is a namespace-scoped draft update followed by
the shared save coordinator's generation flush; a failed flush restores the last
persisted mode and announces the failure without touching either pipeline.

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
settings. The Gate D assembly and tracked-dispatch paths check it atomically.
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
`AbortSignal`. Gate E binds each authoritative callback to a host-created
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

Later provider routes remain subject to APC's terminal validation. Gate E must
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

## Prerequisite host capabilities — surviving foundations and three ordered D–F gates

The surviving A/B/C foundations remain independently testable and available in
staging; the three remaining capabilities retain strict internal dependency
order D→E→F. Current staging retains only the surviving controlled Loom
editor/frontend/type foundation relevant to Gate C; the broader historical
hardening is not current capability. APC remains runtime-inert until the single
APC-only host PR carrying Gates D, E, and F lands in staging with the exact
author-published aggregate types contract. The local D→E→F slices preserve
full scope and separate evidence; consolidating them into one external host PR
is administrative, not a collapse or reorder. Existing types PR #32 is that
aggregate D–F contract and must be exactly `0.6.5`. Its upstream author owns
merge and package publication; this project cannot publish it. The host
candidate exact-pins only that author-published artifact after final evidence
and red-team review pass.

### PR 1 — passthrough integrity and LumiHub (complete in staging; Gate A)

**Branch:** `feat/preset-extension-metadata`  
**Depends on:** nothing

The merged Gate A preserves `LoomPreset.passthroughMetadata` losslessly through
normal Loom persistence, duplication, and internal import/export, and makes
LumiHub create/update preserve those fields rather than rebuilding fixed
metadata. It validates the clean top-level APC shape. This gate is generic
passthrough integrity and LumiHub only; no second metadata container is added.

### PR 2 — preset-editor integration and safe persistence (complete in staging; Gate B host capability)

**Branch:** `feat/spindle-preset-editor-surface`  
**Depends on:** PR 1

Reuse the native preset-editor tab and draft helper. The merged Gate B host
capability is complete as a generic, inert surface. Core owns only:

- generic toolbar placement and a registration root, with no APC-specific item
  or default mode UI;
- generic preset-editor tab/helper lifecycle and mount roots;
- activation of the host's built-in preset editor through the generic `blocks` API ID;
- namespace-scoped extension mutation and cloned read-only Main fields;
- synchronous permission-revocation teardown of mounted tabs and draft
  subscriptions;
- one module-global, per-preset save coordinator shared by every preset writer;
- serialization and a generation-flush barrier that prevents dispatch against an
  unpersisted graph revision.

APC later registers its toolbar item through the generic toolbar root and renders
the **Single | Sequential | Parallel** radiogroup and **Agent Graph** view
through the generic roots. APC owns those controls' labels, disabled reasons,
accessibility behavior, and all APC-specific view content; core does not ship or
render them.

### Gate C — surviving controlled native Loom editor foundation

The controlled native Loom block editor and its generic frontend bridge/placement
surface survive in current staging as an extension-requested, visually inert
foundation. Default output remains visually identical to Lumiverse's existing
editor; the bridge operates on cloned controlled values and seals host-only
fields. APC-specific thread UI and runtime mounting remain future work after the
implementation halt lifts. Core adds no APC-specific editor markup.

### Gate D — host-internal parent-bound assembly and dispatch substrate

**Internal slice:** `feat/spindle-generate-assemble`  
**Depends on:** Gate C foundation

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

Gate D defines and tests the substrate, including the no-fresh-retrieval
invariant. It does **not** bind ordinary interceptor callbacks, issue APC
callback tokens, register APC runtime behavior, or claim that callback lifecycle
is solved. It is the prerequisite internal substrate for Gate E within the
consolidated host PR, not an extension-only APC engine.

### Gate E — authoritative callback lifecycle and terminal placement

**Internal slice:** `feat/spindle-interceptor-context`  
**Depends on:** Gate D

For every authoritative callback, the host creates the Gate D
`WorkerInvocationBinding` and host-only `TerminalFinalizationLease`, installs the
worker binding, and exposes only the bound effective context, work deadline, and
worker-local signal. User/chat/generation scope derives exclusively from that
binding. Host-side preset/mode/route matching avoids irrelevant worker work, and
an idempotent registration disposer owns teardown.

Handler settlement ends worker RPC authority. Accepted directive/final
provenance moves to the host-only terminal lease, which survives only until
parent completion, cancellation, permission loss, unload, disable/update, or a
confirmed containment fatal. Using Gate D's snapshots, tracked outcome, parent
attestation, and containment channel, Gate E implements deferred host-owned
guidance placement.
Immediately before every provider dispatch it mints and consumes a fresh purpose/request-
bound terminal child, authenticates or restores the prefill carrier,
rebuilds/reclips budget and Breakdown, and revalidates terminal provenance.
Existing post-assembly message, parameter, and Breakdown mutation remains the
foundation; Gate E adds terminal enforcement rather than recreating that surface.

### Gate F — thread-final finalization, compatibility, and locale

**Internal slice:** `feat/spindle-interceptor-final-response`  
**Depends on:** Gate E

Add privileged, provenance-validated thread-final finalization so a graph may
route its final response through Main or a designated thread. Define one
immutable shared backend/frontend host descriptor and enforce generic manifest
minimum/capability requirements before incompatible extension source loads.
After the host's generic pre-bundle nonce/digest handshake, the only
pre-readiness extension operation is an immutable synchronous descriptor read.
The extension installs no transport hello, listener, or digest exchange.
Mount, storage, registration, preset, interceptor, generation, and other domain
calls remain blocked until readiness.
Expose a host locale getter/change subscription so extensions can live-switch
their own catalogs. APC ships and renders its own complete catalogs for `en`,
`zh`, `zh-TW`, `ja`, `fr`, and `it` through its registered views. Core may show
only generic conditional permission/compatibility/error diagnostics when
applicable; any new host diagnostic string is added to all six Lumiverse core
locales. No APC-specific labels, views, literals, or catalogs belong in core.
The three internal D–F capabilities may be administratively grouped into the
one APC-only host PR only if their ordering, full scope, and independently
testable evidence remain equivalent. The consolidated host PR must retain strict
D→E→F dependency order; replacing the gates with reduced workstreams is a Gate
0 product-contract change.

## Local bundle and later release discipline

Current staging retains the surviving controlled Loom editor/frontend/type
foundation relevant to Gate C; no ready-PR or current-hardening claim is made.
The authorized local bundle records D, E, and F as separately testable
capability slices and composes them sequentially in the separately claimed
consolidated feature worktree. That worktree follows the normal fork PR controls
and becomes the one external host PR source only after every evidence and
publication blocker clears. The preserved no-remote prototype clone remains a
read-only evidence input, not an implementation base or PR source.
Each gate includes focused tests, generic host documentation, six Lumiverse
core locale updates only when generic host strings are added, and cumulative
types source for PR #32. Local prototype commits and tests are evidence inputs,
not current staging capabilities or release authority. One independent
cross-gate red-team review runs after all D–F verification passes. APC's six
locale catalogs remain post-host extension work.

After D→E→F evidence and the final independent cross-gate red-team review pass,
the one consolidated APC-only host PR carries all three internal gates in that
order. This is one external host PR, not three D/E/F host PRs and not a scope
reduction. Existing aggregate types PR #32 must be merged upstream and its
author must publish exactly `0.6.5` before the host candidate exact-pins it or
opens its draft/publication. This project cannot publish the package. The
earlier blanket publication stop is superseded only for this authorized
local implementation/evidence path; external publication blockers remain active.

For local D–F implementation/evidence, preserve unrelated work and use only the
separately claimed consolidated feature worktree. Do not treat preserved
prototype commits, tests, or historical Gate C hardening as current staging
capability. Snapshots `45acd748` and `e4bbe6c` remain historical reference, not
implementation bases.

The published `lumiverse-spindle-types@0.6.4` remains the current staging type
foundation. PR #32 is the unpublished cumulative D–F contract targeted at
exactly `0.6.5`; it has no release authority until its upstream author merges
and publishes it. No package publication occurs in this extension.

## Gate 0 decision and halt condition

The user has authorized local consolidated D–F implementation/evidence and one
APC-only host PR. The upstream author will review that single host PR normally
after its prerequisites; no separate D/E/F host PR sequence is required. A
review request, rejection, or material reshape reopens the affected contract
boundary before that host PR proceeds.

**No APC runtime implementation begins until the consolidated APC-only host PR
lands in `staging` and the upstream author has merged PR #32 and published
exactly `0.6.5`, which the host contract exact-pins.** Final D–F evidence and
the independent red-team review must pass before that exact pin or draft/public
host publication. Before those conditions the extension performs no APC
registration, mount, storage, or subcall work. There are no fallback paths: no
DOM hacks, duplicated prompt assembly, event-only cancellation, unsafe
metadata writes, or compatibility shims.

After those prerequisites lift the implementation halt, compatibility bootstrap
is the only exception to the pre-readiness no-work rule: the host owns any
generic pre-bundle nonce/digest handshake, while the extension performs only
immutable `spindle.host` / `ctx.host` descriptor reads. Everything else stays
inert until future APC runtime work is authorized.

## Companion documents

- `AUTHOR_BRIEF.md` — consolidated host-PR review guide for this Gate 0 contract.
- `README.md` — design-only scaffold status and implementation halt.
