# Agentic Preset Composer (APC) — Canonical Design

> APC is the implemented Gate G Spindle extension for Lumiverse. This document
> is the product, authority, privacy, failure, and security contract for the
> checked-in source. `package.json` and `bun.lock` pin
> `lumiverse-spindle-types` to exact `0.6.6`.

APC is an opt-in extension. It activates only for a valid non-Single graph and
an explicitly selected non-Single mode. A legacy preset or a preset without an
APC bag normalizes to `supportedModes: ['single']` and
`activeMode: 'single'`; its native generation path is unchanged.

## Product model

APC lets a user run a preset as a bounded distributed agent graph rather than
one monolithic prompt. A graph uses reusable thread workspaces, ordered stages,
typed `final` outputs, explicit input bindings, and one final route. APC
generalizes Council: Council is a fixed multi-member pattern, while APC is a
user-configurable graph with explicit limits and failure policies.

APC executes from the post-assembly interception point. It does not duplicate
native prompt assembly, put additional-thread blocks in Main's flat
`prompt_order`, or bypass the native generation lifecycle. Sidecar provider and
tool work that occurs before APC interception remains outside APC's rollback
boundary.

## Host contract and registration

The immutable host descriptor contains exactly:
`descriptorVersion`, `lumiverseVersion`, `capabilities`, and
`extensionInstallationId`. APC requires descriptor schema version `1`, Lumiverse
`1.0.8` or newer, and these seven host capabilities at version `1`:

- `preset-extension-data-v1`
- `preset-editor-v1`
- `loom-block-editor-v1`
- `generation-assembly-v1`
- `interceptor-context-v1`
- `interceptor-final-response-v1`
- `connection-dispatch-resolution-v1`

Both entrypoints validate this descriptor synchronously before extension
registration, UI mounting, storage, network, generation, or interceptor work.
An incompatible descriptor fails closed.

The manifest permissions are `interceptor`, `generation`, `presets`, and
`final_response`. Backend execution requires the first two. Loss of required
`interceptor` or `generation` permission revokes the registration and disarms
active APC work. Thread-final response routing additionally requires
`final_response`; if it is absent or revoked, APC disables only that route and
preserves the safe native Main fallback with a bounded reason/activity.

### Backend startup

The backend validates `spindle.host`, initializes user-scoped atomic storage,
connection bindings, consent, traces, admission, and the endpoint router, then
subscribes to frontend messages, permission changes, and extension lifecycle
events. When `interceptor` and `generation` are granted it owns one
host-registered interceptor for the APC runtime. The registration match is
limited to non-dry-run `normal` and `continue` generations whose authenticated
APC mode is `sequential` or `parallel`; the wrapper revalidates the context and
returns native messages on an ineligible or failed callback.

Registration is replaced in place rather than duplicated across users or
presets. Loss of required permission revokes the registration and aborts active
graphs; loss of `final_response` only aborts Thread-final executions and
updates route availability. Disable, update, unload, and explicit teardown
dispose the router, listeners, registrations, active executions, and trace
finalization exactly once.

### Frontend startup

The frontend validates the host descriptor and required UI, permission, locale,
message, draft, and controlled Loom-editor APIs before mounting. It registers
one APC mode-toolbar contribution and one **Agent Graph** preset-editor tab
through host-owned roots, then mounts APC-owned graph, thread, inspector,
consent, activity, and accessibility surfaces. The host's built-in `blocks` tab
remains the Single surface.

APC writes only its namespace through the preset-editor draft helper. The host
save coordinator supplies the generation-flush barrier. Locale changes update
APC's own catalogs for `en`, `zh`, `zh-TW`, `ja`, `fr`, and `it`. Loss of
required permission disarms APC subscriptions, DOM contributions, state,
pending requests, and view work; loss of `final_response` updates only
Thread-final availability and active final-route work. Disable, update, unload,
and teardown dispose the remaining APC lifecycle without touching host-owned
siblings.

## Execution modes and creation

The toolbar always presents **Single | Sequential | Parallel**. Unsupported,
invalid, unresolved, or permission-blocked choices remain visible and disabled
with an APC-owned reason.

- **Single** activates the host's built-in preset editor through the `blocks`
  API ID. APC does not alter native assembly or provider dispatch.
- **Sequential** contains exactly one run per ordered stage. Every call uses
  authoritative Main dispatch and each stage feeds the next in configured
  order. The Sequential UI exposes no connection-slot picker and runtime
  ignores stored per-thread slot metadata in this mode; switching back to
  Parallel preserves those bindings.
- **Parallel** contains one to four distinct runs per stage. Runs may overlap
  inside a stage, the scheduler drains with `allSettled`, and result order stays
  in configured order. A thread may inherit Main or resolve an explicit
  connection slot.

An empty graph has two explicit creation actions: **Create Sequential graph**
and **Create Parallel graph**. Each action creates one default reusable thread,
one stage, and one run for its selected mode, selects that mode, and emits a
namespace-scoped dirty draft. It does not create sample data, bind a
connection, or grant consent. A later mode switch preserves both pipeline
definitions rather than deleting the unselected mode.

The portable graph is bounded by 16 threads, 32 stages, 64 runs, four parallel
runs per stage, one sequential run per stage, and a 240-second run timeout.
References target earlier stages only. Cycles, same-stage references,
unreachable runs, invalid required/failure-policy closure, and an invalid
final route make the affected non-Single mode unavailable.

## Portable graph data and persistence

The portable graph has one top-level key:
`metadata.agentic_preset_composer`. Host passthrough carries this opaque,
versioned bag with every unrelated passthrough sibling. APC alone decodes and
validates it in two phases: envelope/global caps/shared records first, then
path-local objects and references.

Connection UUIDs, dispatch revisions, receipts, nonces, user IDs, credentials,
and other private authority data never enter portable metadata or user-facing
copy. There is no second APC metadata key, compatibility write path, or
speculative dual-read path.

Native Loom persistence preserves the APC bag and unrelated passthrough
siblings. Legacy SillyTavern conversion intentionally does not preserve
arbitrary passthrough metadata.

Mode changes and graph edits update only the APC namespace. The shared save
coordinator flushes the draft before generation. A failed ordinary graph save
keeps the draft visibly dirty with its failure so it can be corrected and
resaved. A failed mode transition restores the last persisted active mode and
leaves both native and APC pipelines untouched.
The backend is the sole writer of local binding, consent, execution, and trace
state.

## Threads, runs, and pipelines

- **Main Thread** is fixed and always present. It owns live top-level Loom
  blocks, variables, authoritative Main dispatch, and the normal user-facing
  generation path.
- **Thread** is a reusable invocation-local workspace. `native-blocks` uses
  controlled Loom editing and native assembly; `main-context` clones the
  immutable assembled Main messages. A repeated thread reuses one workspace
  across later stages and cannot run twice in one stage.
- **Run** is one scheduled use of a thread in one stage. It has requiredness,
  timeout, ordered input bindings, and one `final` output.
- **Output** is a run's single `final` value. Synthesis and voting are ordinary
  downstream runs, never implicit operations.
- **Final route** is Main or one designated thread run. Both are first-class
  routes when the required host capability and permission are available.

V1 actions are closed: execute a run, bind literals or earlier-thread outputs,
and choose one final route. There are no arbitrary scripts, branches, loops,
parsers, transforms, or implicit votes. Missing-output bindings resolve before
workspace/deadline: `fail-graph` wins, then `skip-run`, then omit the binding
and append survivors. Each survivor becomes its own configured-role message
with a display-delimiter wrapper. The wrapper is not a security boundary:
model-authored output is untrusted text and is never parsed as provenance.

## Dispatch, revisions, and connection privacy

Every auxiliary generation call carries a required discriminated dispatch source:

- `main` contains no connection ID and binds only to the active callback's
  immutable `MainDispatchSnapshot`;
- `slot` contains the explicit connection ID resolved by the authenticated host.

Both sources carry the exact expected `connectionDispatchRevision`. Equal IDs
or revisions never alias sources; resolved assembly, trusted receipts, and
consent enforce the source provenance. Bounded traces expose only run, status,
and timestamp metadata; they do not echo connection or revision provenance.

The effective dispatch revision is an opaque value supplied by the
authenticated host. APC binds the value to the resolved connection descriptor
and validates exact equality at assembly, tracked dispatch, receipt, consent,
and settlement boundaries. APC does not derive, fingerprint, or reconstruct
that revision from database inputs.
List-then-call fingerprints and roulette parents cannot authorize a destination:
every run requires a concrete non-null host-provided dispatch revision or fails
before assembly or provider work.

Runtime derives a closed source key from portable metadata: reserved `main` for
inherited Main or a canonical slot key for an explicit binding. Per-user state
binds only `(presetId, slotId)`. Consent is bound to installation, nonce,
preset, thread, workspace source, connection source key, resolved connection,
dispatch revision, and disclosure version.

Explicit slots are bound and consented through backend resolution. Frontend
payloads never assert a revision. Inherited Main is runtime-dynamic: when its
exact descriptor lacks consent, APC makes zero assembly/provider subcalls.
A required run then drives the required-failure Graph-fallback outcome; an
optional run follows its configured optional-local policy. APC emits one bounded
`consent_required` trace event per denied run/approval attempt.

Binding and consent intents serialize under the authoritative callback user and
preset. The backend reads the latest state, derives the next record, writes via
temporary-file-and-move, and advances a volatile monotonic `mutationEpoch`.
Only executions matching the current epoch may commit.

## Assembly, tracked dispatch, and authority

APC reuses the host's authenticated generation surfaces:

1. `spindle.generate.assemble` receives controlled native-blocks, a dispatch
   source and revision, a deadline, and a worker-local signal. It returns
   assembled messages, Breakdown attribution, and resolved source provenance.
2. APC appends validated input bindings and calls
   `spindle.generate.quietTracked` with the same source/revision, deadline,
   cancellation signal, and any authorized parent-prefill continuation.
3. APC accepts only a structurally valid tracked result whose receipt preserves
   source, destination, and dispatch revision. A stale, malformed, or
   mismatched result is rejected before run commit.

Provider routing, credentials, endpoints, and provider parameters are host
authority. APC supplies only run/workspace data, validated messages, and the
host-resolved dispatch binding. It never accepts a destination override nested
in portable graph data.

## Invocation, cancellation, and non-commit containment

Frontend Stop and replacement use the `cancel_execution` intent. Callback-bound
cancellation is propagated internally through host-owned signals; APC does
not serialize an `AbortSignal` as a frontend/backend payload. The host binds
each authoritative callback to an invocation identity and worker-local signal.
Each run uses APC's custom composed cancellation tree and signal, combining the
interceptor root, graph/stage/run deadlines, parent signal, and child
controllers for cloning, assembly, and tracked dispatch.

Stop, replacement, host/graph/run timeout, required failure, permission loss,
disable, update, unload, and teardown abort controllers. Parallel work drains
with `allSettled`, rolls back identifiable APC-owned provisional state, and
settles once. The host's 300-second interceptor ceiling supports the graph
deadline but does not replace callback-bound cancellation.

At callback entry, the host resolves the configured interceptor timeout into an
absolute `interceptorDeadlineAt`, then APC computes
`boundWorkDeadlineAt = min(entry + 285000 ms, interceptorDeadlineAt - 15000 ms)`.
Subcalls stop at the work deadline; the reserve is only for host terminal
transition and drain. The fixed containment grace is teardown-only: it cannot
admit work or extend a deadline.

The host retains one private `ParentPrefillAttestation` and derives only
purpose/request-scoped child uses. First-run branch continuations receive
distinct one-use worker children; retries are replay, not a second use. The
worker-callable binding ends when the handler settles. A separate host-only
`TerminalFinalizationLease` retains accepted directive/final provenance until
parent terminal settlement and mints a fresh one-use terminal child immediately
before every initial, retry, continuation, inline-tool, or fallback provider
dispatch. No worker receives a carrier index, parent attestation, terminal
child, or post-settlement authority.

Before every non-committing context, world-info, or macro hook, the host
acquires a read-only lease. During that lease, mutating and reentrant worker
operations are blocked while authenticated cancellation and manager teardown
remain able to reduce pre-existing work.

Non-commit containment fatal behavior is host-owned. APC does not invent a
worker-visible fatal channel or claim an extension-local way to authenticate,
bypass, or upgrade a host containment failure. An eligible Spindle host must
preserve the exact host-created containment-fatal identity across worker RPC,
reject the parent interceptor fail-closed, keep teardown grace non-authoritative,
and expose only a generic abort to the worker. APC must remain blocked on hosts
without that contract because they cannot support the stronger
zero-Main/no-persistence guarantee for a host contradiction. Ordinary
worker-authored names, payloads, IDs, dispatch sources, and revisions remain
untrusted Graph-fallback data.

## Parent retrieval and external effects

Native-block threads reuse Main's host-owned **Parent Retrieval Snapshot**:
the exact resolved world-info, chat-memory/Cortex, databank inputs, results, and
settings from parent assembly. It is deep-frozen and bound to `(userId, chatId,
generationId)`.

Cold additional assembly does not issue embeddings, perform fresh retrieval, or
mutate retrieval caches or database state. APC adds no retrieval request or
cache write. Connection overrides change only LLM dispatch, never retrieval
policy. A missing, expired, unavailable, or oversize parent snapshot fails
closed; it never falls back to fresh retrieval.

Council remains enabled. Sidecar Council may already have issued provider/tool
calls and completed history/cache writes before APC interception. Those
external and persisted effects are explicit, traceable, and nonrollbackable.
A later APC containment fatal compensates only identifiable APC/host-owned
provisional state; it cannot promise universal rollback over Sidecar or any
provider effect that already occurred. Every later provider route remains
subject to APC's terminal guidance, carrier, budget, Breakdown, receipt, and
provenance validation immediately before dispatch.

## Terminal routing and outcomes

For a Main final route, resolved outputs become Main guidance. The host places
that guidance immediately before the exact authenticated assistant-prefill
carrier at the terminal dispatch boundary, not merely at an earlier
interceptor pass. For a thread final route, the designated run supplies the
user-facing response through the privileged host finalization path.

Both routes are canonical. Missing final-response capability or permission
makes the Thread choice unavailable with an explicit reason rather than
silently redefining the graph. The safe native Main response remains the
fallback, with bounded reason/activity emitted at the terminal decision.
Settlement rechecks host signal, live permissions and revisions, receipt
containment, guidance carrier, and selected final state before accepting a
result.

A single monotonic latch chooses one visible outcome per execution:

**integrity-fatal > parent-cancel > selected-final failure > Graph-fallback >
optional-local > success.**

Within Graph-fallback, host gates, retrieval/dispatch/consent,
capacity/config/graph/prefill, assembly/setup/storage, timeout, and required
typed run failure have a fixed cause rank. A required typed failure projects to
Graph-fallback. An optional typed failure follows the run's omit/skip policy
and continues. Cancellation is never described as provider failure.

## Frontend trust and privacy

Frontend extensions run as trusted same-origin code in the authenticated host
page. Namespace-scoped mutation and cloned read-only Main fields reduce
accidental cross-extension and host-state writes, but they are cooperative
least-authority APIs, not a hostile-code sandbox. Backend callback binding,
permissions, dispatch resolution/revision checks, consent validation,
cancellation, and the host-owned fatal channel are the security boundaries.

The frontend sends neither a user ID nor whole portable/private state
documents. It renders safe labels and bounded activity summaries, never raw
invocation IDs, revision hashes, connection UUIDs, internal receipts, nonces,
carrier details, secrets, or opaque backend identifiers. Model-authored outputs,
trace payloads, wrappers, and prompt fragments are hostile text and are
rendered as text rather than parsed as provenance or executable markup.

## Verification and local operation

Use Bun with the checked-in lockfile:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run build
```

The build scripts produce the manifest's `dist/backend.js` and
`dist/frontend.js` entrypoints. For isolated host testing, follow the shared
registered-environment guide and the import-local/restart workflow in
`README.md`; use the returned database UUID for Spindle routes, not the
manifest identifier. Do not place credentials or private host data in this
document.

## Companion documents

- `README.md` — implementation status, runtime summary, build commands, and
  registered isolated-host workflow.
- `UI.md` — current presentation, interaction, accessibility, and localization
  guidance.
