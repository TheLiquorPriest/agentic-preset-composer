# Agentic Preset Composer (APC) — Canonical Design

> Source of truth for the settled product model — self-contained for the
> architecture it presents. `AUTHOR_BRIEF.md` is the concise upstream handoff.
> The complete Gate 0 contract also includes the approved plan at
> https://gist.github.com/TheLiquorPriest/7e34429d87d0d0b72f7db36ee6dfa253
> (SHA-256
> `5cfa7cfb7461ceaa6aaacb31c68b8c582f647c84e7c8e8ecdddb1f8c62695877`)
> and its factual current-API erratum at
> https://gist.github.com/TheLiquorPriest/0d83d47a449e73d580edb572be817970
> (SHA-256
> `0f86ed540a04d21a31cac2017e5ea88d0b4eef66b085879a29eb69e19a71674c`).
> The erratum governs the plan's identified line-11 conflict; a content or
> checksum change to either artifact reopens Gate 0.

## Product model

APC is an opt-in Spindle extension that lets a user run a preset as a
**distributed agent graph** instead of a single monolithic prompt. A preset
declares one of three execution modes; for non-Single modes a registered
**post-assembly interceptor** orchestrates role-specialized sub-generations,
composes their outputs, and routes a final result before the main turn. It is a
generalization of Council — Council is one fixed multi-member pattern; APC is a
user-configurable, arbitrary agent graph.

Opt-in and non-breaking: a preset is APC-enabled only if the user configures a
non-Single graph with valid mode support. Legacy presets and presets with no APC
bag normalize to `supportedModes:['single']`, `activeMode:'single'`, and
generation is untouched.

APC executes **only** from a post-assembly interceptor. It does not duplicate
prompt assembly, insert blocks into the flat Main Thread `prompt_order`, or
bypass the native generation lifecycle.

## Execution modes

The dedicated `presets`-gated toolbar item renders **Single | Sequential |
Parallel** above LoomBuilder's list/edit branch, as an accessible radiogroup.
A preset declares unique `supportedModes`; `single` is mandatory.

- **Single** — today's behavior. Bypasses APC entirely; the native assembly and
  provider call proceed unchanged. Selecting Single activates the built-in
  **Blocks** tab.
- **Sequential** — runs one thread per ordered stage; every call uses the
  authoritative Main connection. Each stage feeds the next in configured order.
- **Parallel** — runs ordered stages whose distinct threads may overlap within a
  stage; each thread may optionally resolve a locally bound connection slot,
  otherwise it inherits Main. Honors a hard width of four concurrent runs per
  stage and drains with `allSettled`; output order is configured, not completion.

All three choices remain visible; unsupported, invalid, unresolved, or
permission-blocked choices are disabled with associated reasons. Selecting a
valid non-Single mode activates APC's registered **Agent Graph** tab.

## Threads, outputs, and pipelines

Portable graph data lives at `metadata.extensions.agentic_preset_composer`.
Core preserves this as an opaque versioned bag; APC alone decodes and validates
it losslessly under a two-phase rule (envelope/global caps/shared records, then
path-local objects). Connection UUIDs are never stored in portable metadata.

- **Main Thread** — fixed; always present; keeps live top-level Loom
  blocks/variables.
- **Threads** — each added thread is one invocation-local workspace.
  `native-blocks` uses shared Loom editing/assembly; `main-context` clones the
  assembled Main messages. A repeated thread reuses one workspace across later
  stages and cannot run twice in one stage.
- **Outputs** — each thread exposes one `final` output. Synthesis or voting is
  an ordinary downstream thread, not a special construct or implicit operation.
- **Pipelines** — Sequential has exactly one run per stage; Parallel has 1–4
  runs per stage with distinct threads. References target earlier stages only.
  The final route is either **Main** (resolved prior outputs composed into Main
  guidance, inserted immediately before the last exact assistant prefill
  carrier) or a designated **thread** run.

V1 actions are closed: execute a thread run, bind literals or prior-thread
outputs, and route one final. There are no arbitrary scripts, branches, loops,
parsers, or implicit votes. Missing-output bindings resolve before
workspace/deadline: `fail-graph` wins, else `skip-run`, else omit and append
survivors. Each survivor becomes its own configured-role message with a display
delimiter wrapper that is **not** a security boundary — output remains untrusted
model-authored text and is never parsed or treated as provenance.

## Privacy, dispatch, and connection invariants

Every generation call carries a required **discriminated dispatch source**:
`main` (contains no connection ID; binds only to the active callback's
`MainDispatchSnapshot`) or `slot` (contains the explicit connection ID). Both
carry the exact expected `connectionDispatchRevision`. Equal IDs or revisions
never alias sources; resolved assembly, trusted receipts, consent, and traces
all echo the source.

Privacy requires an opaque **effective dispatch revision** — a
`base64url(SHA-256(…))` digest over every mutable DB input to the call
(connection base token, dispatch-affecting columns, the distinct
missing/present encrypted-secret tuple, preset parameters, reasoning
settings) — atomically checked inside assemble and quietTracked.
List-then-call fingerprints and roulette parents cannot authorize
a destination; every run requires a concrete, nonnull dispatch revision or it
fails before assembly or provider work.

Runtime derives a closed source key from portable metadata: reserved `main` for
inherited Main, or `slot:<canonical UUID>` for an explicit slot. Per-user state
binds only `(presetId, slotId)` slots; consent keys
`(installId, nonce, presetId, threadId, workspaceSource,
connectionSourceKey, connectionId, dispatchRevision, DISCLOSURE_VERSION)`.
`main` resolves only authoritative Main — never a slot binding or hint.
Explicit slots are bound and consented through backend `resolveDispatch`;
frontend payloads never assert revision. Inherited Main is runtime-dynamic:
when its exact descriptor lacks consent, APC performs zero subcalls, emits one
bounded `consent_required` trace, and Graph-fallbacks to Main.

Backend is the sole local-state writer. Binding/consent intents are serialized
under `(authoritativeCallbackUserId, presetId)` queues, read-latest/derive/
temp+move, and a volatile monotonic `mutationEpoch` aborts only matching
executions. Frontend sends neither user ID nor whole documents.

## Cancellation and non-commit invariants

`intercept_request` crosses `postMessage`, so cancellation is an explicit
**`intercept_abort` protocol** — never a serialized host `AbortSignal`. The
host interceptor bridge delivers authoritative resolved generation context and
cooperative cancellation through a worker-local signal. Each run composes
`AbortSignal.any([interceptorSignal, graphSignal, runDeadline])` for clone,
assembly, and quietTracked. Stop, replacement, host/graph/run timeout, required
failure, permission loss, and disable/update abort controllers; the graph drains
with `allSettled`, rolls back, and settles once.

`generate.assemble` performs native additional-thread assembly with
`runMessageInterceptors:false` and `commit:false`, and fails closed on requested
hook errors. A **host-owned read-only lease** acquired before every commit-false
context/world-info/macro hook blocks all mutating and reentrant worker
operations for the lease's lifetime, while still permitting authenticated
cancellation and manager teardown that only reduce pre-existing work. A
contradiction among host-owned binding/scope/lease/provenance maps latches a
branded `HostFatalInterceptorError` (`NONCOMMIT_CONTAINMENT_FAILED` and related
codes) that bypasses interceptor fail-open, aborts siblings, and yields **no
Main provider call and no persistence**. Worker-authored names, payloads, IDs,
dispatch sources, and revisions can never forge this channel — they are ordinary
fail-open faults.

## Parent retrieval snapshot

Native-block threads always reuse Main's host-owned **parent retrieval
snapshot**: the exact resolved vector world-info, chat-memory/Cortex, and
databank inputs/results/settings from the parent assembly, deep-frozen and bound
to `(userId, chatId, generationId)`. Cold additional assembly may **not** issue
embedding requests or mutate retrieval caches or DB state. APC adds no retrieval
embedding request or cache write. Connection overrides change only LLM dispatch,
never retrieval policy.

## Observable failure outcomes

A single monotonic latch chooses the observable outcome per execution:
**integrity-fatal > parent-cancel > selected-final failure > Graph-fallback >
optional-local > success.** Within Graph-fallback, a fixed cause rank orders
host gates, retrieval/dispatch/consent, capacity/config/graph/prefill,
assembly/setup/storage, timeout, and required typed run failure. Required typed
run failure (hook/macro/provider/tool/blank/oversize) projects to Graph-fallback;
optional typed failure follows the run's omit/skip policy and continues. Final
settlement rechecks host signal, live permissions/revisions, receipt
containment, and selected-final state. The full class/cause/transaction table
lives in the execution plan.

## Prerequisite host capabilities — six ordered core PRs

APC **cannot** ship through the current `generate.raw`/`quiet`/`interceptor`
API. The in-editor, native-block, dispatch-revision-safe experience requires
six prerequisite host capabilities, each delivered as a serial, unstacked
feature PR against `origin/staging`; PRs 2–6 each publish a matching additive
`lumiverse-spindle-types` release:

1. **Portable preset extension data** (`feat/preset-extension-metadata`) —
   `extensionsMeta` bag on `LoomPreset`; preserved through Loom
   save/duplicate/export-import and LumiHub install/update; survives owner
   absence.
2. **Preset-editor extension surfaces** (`feat/spindle-preset-editor-surface`,
   after PR 1) — `presets`-gated toolbar/tab registration, scoped preset helper
   with a single serialized save coordinator, and permission-free locale helper.
3. **Shared Loom block editor** (`feat/spindle-loom-block-editor`, after PR 2) —
   permission-free `mountLoomBlockEditor` as a pure value editor with a sanitized
   catalog; never reads active chat/character/persona/connection/preset stores.
4. **Assembly-only generation API** (`feat/spindle-generate-assemble`, after
   PR 3) — `generate.assemble` (native assembly, commit:false, parent-snapshot
   reuse, no reentry, typed outcomes), `generate.quietTracked` (response +
   trusted receipt), `connections.resolveDispatch`, the effective
   dispatch-revision digest and `MainDispatchSnapshot`, and the host read-only
   lease / non-commit containment channel.
5. **Authoritative, abort-aware interceptor context**
   (`feat/spindle-interceptor-context`, after PR 4) — typed `InterceptorContextDTO`
   with host-reserved immutable identities and `interceptorDeadlineAt`, a
   worker-local cancellation signal, serializable `match`, and the
   `intercept_abort` protocol.
6. **Interceptor-authored final response and host compatibility**
   (`feat/spindle-interceptor-final-response`, after PR 5) — privileged
   `final_response`, provenance-validated fallback, and the synchronous
   `SpindleHostDescriptorV1` capability descriptor that APC validates before any
   work.

## Release discipline

Host PRs are **serial but unstacked**: each branches fresh from the newest
`origin/staging` after the previous prerequisite merges; never merged or
cherry-picked onto feature predecessors. PRs 2–6 each pin an exact additive
`lumiverse-spindle-types` release published under the nondefault `lumiverse-pr`
tag **before** draft; default `latest` promotion is the bounded merge window.
The full per-PR gate sequence, immutable ledger, source-only build procedure,
and publication/merge protocol live in the execution plan.

## Halt condition

**No APC runtime implementation begins until all six core PRs merge into
`staging` and every matching type patch is published.** If the upstream author
declines or reshapes any gap, the contract reopens. There are no fallback paths:
no DOM hacks, no duplicated prompt assembly, no event-only cancellation, no
unsafe metadata writes, and no compatibility shims. The existing Spindle API
cannot deliver APC.

## References

- `AUTHOR_BRIEF.md` — the concise upstream maintainer handoff. Carries the
  product framing and the per-PR `upstream implements` /
  `authorize TheLiquorPriest diff` acknowledgment that gates all branch work
  (Gate 0). This is the document upstream inspects and acknowledges.
- Approved execution plan (Path C — final) —
  https://gist.github.com/TheLiquorPriest/7e34429d87d0d0b72f7db36ee6dfa253,
  SHA-256 `5cfa7cfb7461ceaa6aaacb31c68b8c582f647c84e7c8e8ecdddb1f8c62695877`.
  Elaborates the functional spec, six PR contracts, release discipline, and
  verification/test matrices.
- Current-API erratum —
  https://gist.github.com/TheLiquorPriest/0d83d47a449e73d580edb572be817970,
  SHA-256 `0f86ed540a04d21a31cac2017e5ea88d0b4eef66b085879a29eb69e19a71674c`.
  Corrects the plan's line-11 `quiet`/PR-4-`quietTracked` wording without changing
  PR 4 scope. Upstream verifies both checksummed artifacts; a change to either
  reopens Gate 0.
