# Agentic Preset Composer — core PR review guide

> **Status: local-only preparation authorized; nonoperative.** APC's six core
> capability changes are being prepared privately as a complete review bundle.
> They will receive ordinary upstream review when later published. This document
> is the authoritative local review and release protocol; it is not a
> preauthorization request, ownership matrix, package release request, or
> permission to implement APC runtime behavior.

## Current basis and thanks

Thank you for the Spindle work already in staging. The capability assessment was
made at `737b9995f994dbc60d5e130c2314e85fca864365`, including
`390be052410e57405f5ac813da02d9d019e6298e` and the relevant changes through
PR #231, then bounded-revalidated through current `origin/staging`
`5c23a259efe902f86303599585e0e46c9511d471`. The later range changes only
unrelated disk-health, Operator-panel, install-documentation, and script
surfaces; it does not change Spindle, Loom/preset, generation, or types
capabilities.

Staging already provides these useful generic primitives:

- `LoomPreset.passthroughMetadata`, which losslessly preserves non-Loom,
  non-`_lumiverse_*` top-level metadata through the normal Loom path;
- the native preset-editor tab and draft helper (`registerPresetEditorTab`,
  `presetEditor.getState`, `onChange`, `updatePreset`, and `flush`);
- `spindle.assemble` for native arbitrary-block assembly and
  `spindle.generate.quiet` for nonrecursive provider generation;
- a 300-second interceptor budget, richer pre-assembly generation context, and
  post-assembly message, parameter, and Breakdown mutation.

Those are the foundation for APC. The request below is deliberately limited to
what they do **not** yet provide; it does not ask for a second tab system,
another generic metadata model, duplicate assembly, or a replacement quiet
provider API.

## Gate 0 invariants

The six gates retain their order and external unstacked merge discipline. During
private preparation, record separate PR 0 and PR 1–6 patchsets, then compose
only those immutable patchsets in a separate disposable local integration clone.
Remove every remote from that clone, leave its integration branch without an
upstream, and install a clone-local `pre-push` guard that rejects every
destination. The local workflow forbids bypassing or replacing that guard,
adding a remote/push URL, or using `--no-verify`; the integration clone never
supplies an external PR commit. When the user authorizes publication,
reconstruct each PR from the then-current `origin/staging` after its predecessor
merges. PRs 2–6 need a matching additive `lumiverse-spindle-types` publication,
coordinated during their normal upstream review and release process.

**No APC runtime may mount, register, read/write APC storage, or make APC API
calls until all six PRs have merged into `staging` and their matching types
releases are published.** A declined or materially reshaped PR reopens the
affected contract boundary; there is no compatibility shim or reduced runtime
hidden behind this guide.

After the six gates lift that implementation halt, APC's only pre-readiness
bootstrap operations are immutable synchronous `spindle.host` / `ctx.host`
descriptor reads and one bounded nonce/digest backend/frontend handshake
message. They perform no storage or domain action; mismatch or timeout removes
their listeners and leaves APC inert. Mount, storage, preset, interceptor,
generation, and other domain APIs remain blocked until bootstrap succeeds.

**Council effect boundary.** APC never suppresses or silently reorders Council.
Provider/tool effects and history/cache writes already issued by Sidecar Council
before APC reaches its interception point are explicit, traceable,
nonrollbackable effects. A later containment fatal prevents Main/APC persistence
and compensates only identifiable host-owned provisional state. PR 5 owns the
terminal APC validation that still applies to every later provider route; this
boundary must not be represented as universal transaction rollback.

Current Sidecar ordering remains intact: Sidecar completes first, authoritative
pre-assembly context settles next, and the host captures one immutable
`MainDispatchSnapshot` before ordinary prompt assembly. It captures the parent
retrieval snapshot after Main retrieval and before post-assembly interception.
Subsequent Main/APC/retry/inline routes use those snapshots; earlier Sidecar
calls receive no retroactive APC receipt, attestation, or rollback promise.

## Remaining complementary core work

Each requirement below has one owner. The listed upstream primitive is reused,
not recreated.

### PR 1 — `feat/preset-extension-metadata`: passthrough integrity and LumiHub

Reuse `LoomPreset.passthroughMetadata`. Close only remaining generic
passthrough-integrity and LumiHub create/update preservation gaps, preserving
all sibling passthrough keys. APC has one wire key:
`metadata.agentic_preset_composer` (that is,
`passthroughMetadata.agentic_preset_composer`).

The persisted-data audit found zero rows at either prior APC path and zero
installed APC extensions. This is a clean cutover: do **not** add
`extensionsMeta`, reserve `metadata.extensions`, create dual truth, or add a
speculative migration. Reassess migration only if real prior nested data is
identified. This PR has no matching public types publication.

### PR 2 — `feat/spindle-preset-editor-surface`: persistent editor integration

Reuse the shipped preset-editor tab and draft helper. Add the persistent
**Single | Sequential | Parallel** toolbar above LoomBuilder, activation of the
built-in **Blocks** tab, namespace-scoped APC metadata mutation with read-only
Main fields, synchronous permission-revocation teardown, one global per-preset
save coordinator, and generation-flush gating. Audit and route every
whole-preset writer—including the extension helper, recovery, lifecycle, rename,
duplicate, prompt-variable, and generation-flush paths—through that coordinator.

Frontend extensions are trusted same-origin code. The scoped helper is
cooperative least authority for well-behaved extensions, not hostile-code
isolation; its contract must say so. This PR owns the matching additive types
surface.

### PR 3 — `feat/spindle-loom-block-editor`: controlled native thread editor

Extract and share one controlled native Loom block editor, used by Lumiverse
and exposed through a deep-cloned controlled-value extension bridge for APC
thread values. It must retain host-only/contextual fields sealed from the
extension, rather than be a copied editor or a hand-written APC substitute. This
PR owns the matching additive types surface.

### PR 4 — `feat/spindle-generate-assemble`: parent-bound substrate

Reuse the upstream assembly and quiet-generation internals. Add only the
host-internal substrate that binds native thread work to the parent generation:

- frozen, host-held effective-parent route and preset/APC metadata, retrieval,
  dispatch/revision, and prefill snapshots; native work consumes only those
  snapshots, reuses retrieval, and issues no fresh embedding/cache/DB effects;
- a private parent-prefill attestation that mints purpose/request-scoped one-use
  branch or host-terminal attachments without exposing carrier content/index;
- invocation-token enforcement for nested-RPC identity and cancellation plus a
  host-computed work deadline inside the existing interceptor wall/reserve;
- separate worker-invocation and host-only terminal/finalization lifetimes;
- a fail-closed noncommit lease and host-fatal containment channel; and
- typed tracked dispatch outcomes with immutable source revisions and receipts.

This gate does **not** create callback authority or activate APC callbacks.
PR 5 binds its substrate to an actual interceptor callback. This PR owns the
matching additive types surface.

### PR 5 — `feat/spindle-interceptor-context`: callback authority and terminal placement

Using PR 4, the host creates a worker-callable invocation binding and a separate
host-only terminal/finalization lease for each authoritative callback. The
worker binding derives all user/chat/generation scope, nested-RPC authority,
work deadline, and cancellation from the host callback; host-side matching and
an idempotent disposer keep irrelevant routes dormant.

Handler settlement ends worker RPC authority. Accepted directive/final
provenance survives only in the host terminal lease until parent settlement,
cancellation, permission loss, unload, disable/update, or a confirmed
containment fatal. Reuse the existing post-assembly mutation point, but add
deferred host-owned terminal guidance after all pre-provider transforms.
Before every initial, retry, continuation, inline-tool, fallback, and later
Council provider
dispatch, mint and consume a fresh host-only child attachment, restore the
authenticated carrier, and rebuild/revalidate budget, Breakdown, permission,
cancellation, and provenance. This PR owns the matching additive types surface.

### PR 6 — `feat/spindle-interceptor-final-response`: finalization, compatibility, and locale

Add privileged, non-auto-granted thread-final finalization so the canonical
final route remains **Main or a designated thread**. Deliver one immutable,
shared backend/frontend descriptor and enforce generic manifest
minimum/capability requirements before incompatible source loads. On a
compatible host, allow only the immutable descriptor reads and bounded
nonce/digest handshake described above until APC readiness succeeds. Add the
host locale getter/change subscription and complete live-switching `en`, `zh`,
`zh-TW`, `ja`, `fr`, and `it` catalogs. This PR owns the matching additive types
surface.

## Separate upstream baseline action

This is not one of the six APC capability gates. On the assessed staging base,
both root and frontend manifests declare `lumiverse-spindle-types` `0.6.2`,
while both lockfiles resolve `0.6.1`. Include a separate local **PR 0** that
reconciles this frozen-install baseline before any parity claim. Do not fold it
into a capability gate or treat a manifest declaration as proof that a frozen
install has the 0.6.2 contracts.

## Local preparation for PR 0 and PR 1

The current Lumiverse WIP is preserved in local-only commit `45acd748`; the
prior APC design is preserved in extension-repository commit `e4bbe6c`. Before
preparing the local PR 1 delta, verify that `45acd748` includes its tracked and
formerly untracked WIP and that restoration succeeds in a disposable worktree
or equivalent. Then rename the old local branch to an archive name, unset its
upstream and `pushRemote`, and verify no remote ref contains it. Record the PR 1
patchset from verified `origin/staging` and compose it only in the disposable
private integration clone. The archived WIP is reference material, not a branch
base or authorization to transplant its old metadata model.

## Local review-bundle protocol

The local bundle contains a discrete PR 0 lock-alignment patchset and separately
testable PR 1–6 capability patchsets, with their focused tests, documentation,
six-locale updates where visible UI changes exist, candidate type-package source,
and red-team records. A separate disposable integration clone composes those
immutable patchsets for full cross-gate verification. It must be non-shared with
a distinct object database; remove every remote, leave its integration branch
without an upstream, set its clone-local credential helper to empty, and install
an executable clone-local `core.hooksPath` `pre-push` guard that rejects every
remote, explicit URL, and refspec. Verify that no remote or upstream resolves,
the guard is active, and a local dry-run push is rejected. The workflow forbids
`--no-verify`, guard/config overrides, remote or push-URL additions, and
writable credentials. Record the integration tip only for audit, then delete the
clone or quarantine it without remotes before external work. This operational
guard is not hostile-operator containment; a user with direct filesystem and
credential authority can override it, but this workflow never does. The clone is
never an external PR source. Nothing in the bundle is submitted as a PR,
published to npm, or represented as upstream-approved while it remains local.

When the bundle is complete and the user directs publication, reconstruct and
submit PR 0 and then PR 1–6 serially from fresh `origin/staging` bases. The
upstream author reviews each submission through the normal contribution process.
A type-bearing PR publishes its matching candidate package only when its external
review sequence is ready; names, publishers, and release windows are determined
then, not preallocated in this local guide.

— TheLiquorPriest
