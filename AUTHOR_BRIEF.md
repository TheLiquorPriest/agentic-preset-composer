# Agentic Preset Composer — consolidated host-PR review guide

> **Status: user-authorized local consolidated D–F implementation/evidence and one APC-only host PR; APC runtime remains nonoperative.**
> Gates A/B are historical records. Current staging retains only the surviving
> controlled Loom foundation relevant to Gate C; the broader historical Gate C
> hardening is not current capability. Gates D–F are internal, separately
> testable slices of one host PR and must remain strictly ordered D→E→F with
> full scope.
> Existing aggregate types PR #32 is the cumulative D–F contract and must be
> exactly `0.6.5`. Its upstream author owns merging PR #32 and publishing the
> package; this project cannot publish it. The host candidate may exact-pin the
> author-published package only after that merge/publication and the final
> D–F evidence/red-team review. This guide is not a package release request or
> permission to implement APC runtime behavior.
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
> foundations and the controlled Loom editor/frontend/type surface only. Local
> D–F prototypes and tests are evidence inputs, not current host capabilities.

Staging already provides these useful generic primitives:

- `LoomPreset.passthroughMetadata`, which losslessly preserves non-Loom,
  non-`_lumiverse_*` top-level metadata through the normal Loom path;
- the merged Gate B generic, inert editor-surface capability: generic toolbar
  placement and registration roots; generic preset-editor tab/helper lifecycle;
  activation of the built-in preset editor through the generic `blocks` API ID;
  namespace-scoped mutation and serialization; and teardown/flush barriers. It contributes no APC-specific default UI;
- the native preset-editor tab and draft helper (`registerPresetEditorTab`,
  `presetEditor.getState`, `onChange`, `updatePreset`, and `flush`);
- `spindle.assemble` for native arbitrary-block assembly and
  `spindle.generate.quiet` for nonrecursive provider generation;
- a 300-second interceptor budget, richer pre-assembly generation context, and
  post-assembly message, parameter, and Breakdown mutation.

Those are the foundation for APC. The generic roots remain inert until an
extension registers against them; the remaining gates below add only the
complementary host behavior they do **not** yet provide. This guide does not ask
for a second tab system, another generic metadata model, duplicate assembly, or
a replacement quiet provider API.

## Gate 0 invariants

The six-gate product contract retains internal dependency order D→E→F among
the three remaining slices and remains independently testable. PR 0 and host
Gates A/B are historical records. Current staging retains only the surviving
foundation relevant to Gate C; the broader historical hardening is not current
capability. Private preparation records distinct Gate D, E, and F slices. The
preserved no-remote integration clone is reference evidence only and never an
implementation base or external PR source. Authorized reconstruction occurs in
the separately claimed feature worktree under the normal fork PR controls.

Implement and focused-verify D, then E, then F. Per the user-approved
orchestration, run one independent cross-gate red-team wave only after all three
slices pass verification; repair all material findings and rerun affected
checks. The single external artifact is one APC-only host PR carrying all three
gates in D→E→F order, not three D/E/F host PRs and not a scope reduction.
Existing aggregate types PR #32 is the cumulative D–F contract and must be
exactly `0.6.5`. Its upstream author owns merging and publishing that package;
this project cannot publish it. The host candidate exact-pins only the
author-published package after the final evidence/red-team review passes.

**No APC runtime may mount, register, read/write APC storage, or make APC API
calls until the consolidated host PR has landed in `staging` and the upstream
author has merged PR #32 and published exactly `0.6.5`, which the host contract
exact-pins.** Final D–F evidence and the independent red-team review must pass
before exact pinning or draft/public host publication. A declined or materially
reshaped host PR reopens the affected contract boundary; there is no
compatibility shim or reduced runtime hidden behind this guide.

After those prerequisites lift the implementation halt, APC's only
pre-readiness operation is an immutable synchronous `spindle.host` /
`ctx.host` descriptor read. The host owns the generic pre-bundle nonce/digest
handshake; the extension installs no transport hello, listener, or digest
exchange. Mount, storage, preset, interceptor, generation, and other domain
APIs remain blocked until future APC readiness is authorized.

**Council effect boundary.** APC never suppresses or silently reorders Council.
Provider/tool effects and history/cache writes already issued by Sidecar Council
before APC reaches its interception point are explicit, traceable,
nonrollbackable effects. A later containment fatal prevents Main/APC persistence
and compensates only identifiable host-owned provisional state. Gate E owns the
terminal APC validation that still applies to every later provider route; this
boundary must not be represented as universal transaction rollback.

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

Current Sidecar ordering remains intact: Sidecar completes first, authoritative
pre-assembly context settles next, and the host captures one immutable
`MainDispatchSnapshot` before ordinary prompt assembly. It captures the parent
retrieval snapshot after Main retrieval and before post-assembly interception.
Subsequent Main/APC/retry/inline routes use those snapshots; earlier Sidecar
calls receive no retroactive APC receipt, attestation, or rollback promise.

## Core gate record and remaining complementary work

Each requirement below has one owner. The listed upstream primitive is reused,
not recreated.

### PR 1 — `feat/preset-extension-metadata`: passthrough integrity and LumiHub (complete in staging; Gate A)

The merged Gate A preserves `LoomPreset.passthroughMetadata` losslessly through
normal Loom persistence, duplication, and internal import/export, and makes
LumiHub create/update preserve those fields rather than rebuilding fixed
metadata. It validates the clean top-level APC shape. This gate is generic
passthrough integrity and LumiHub only; no second metadata container is added.

The persisted-data audit found zero rows at either prior APC path and zero
installed APC extensions. This remains a clean cutover: do **not** add
`extensionsMeta`, reserve `metadata.extensions`, create dual truth, or add a
speculative migration. Reassess migration only if real prior nested data is
identified. The completed gate has no separate matching public types change.

### PR 2 — `feat/spindle-preset-editor-surface`: generic editor integration (complete in staging; Gate B host capability)

Reuse the shipped preset-editor tab and draft helper. The merged Gate B host
capability is complete as a generic, inert surface. Core owns only generic
toolbar placement and registration roots, generic tab/helper lifecycle and
mount roots, activation of the built-in preset editor through the generic `blocks` API ID,
namespace-scoped extension mutation with cloned read-only Main fields, synchronous permission-revocation
teardown, serialization, one global per-preset save coordinator, and
generation-flush gating.

The APC frontend later registers its toolbar item through the generic toolbar
root and renders the **Single | Sequential | Parallel** radiogroup and
**Agent Graph** view through the generic roots. APC owns those controls'
labels, disabled reasons, accessibility behavior, and all APC-specific view
content; core does not ship or render them. Audit and route every whole-preset
writer—including the extension helper, recovery, lifecycle, rename, duplicate,
prompt-variable, and generation-flush paths—through that coordinator.

Frontend extensions are trusted same-origin code. The scoped helper is
cooperative least authority for well-behaved extensions, not hostile-code
isolation; its contract must say so. This PR owns the matching additive types
surface.

### Gate C — surviving controlled native Loom editor foundation

The controlled native Loom block editor and its generic frontend bridge/placement
surface survive in current staging as an extension-requested, visually inert
foundation. Default output remains visually identical to Lumiverse's existing
editor; the bridge operates on deep-cloned controlled values and seals
host-only/contextual fields. APC-specific thread UI and runtime mounting remain
future work after the implementation halt lifts. Core adds no APC-specific
editor markup.

### Gate D — `feat/spindle-generate-assemble`: parent-bound substrate

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
Gate E binds its substrate to an actual interceptor callback. Gate D contributes
its complete slice to cumulative types PR #32; it is not a separate external
package or host PR.

### Gate E — `feat/spindle-interceptor-context`: callback authority and terminal placement

Using Gate D, the host creates a worker-callable invocation binding and a
separate host-only terminal/finalization lease for each authoritative callback.
The worker binding derives all user/chat/generation scope, nested-RPC authority,
work deadline, and cancellation from the host callback; host-side matching and
an idempotent disposer keep irrelevant routes dormant.

Handler settlement ends worker RPC authority. Accepted directive/final
provenance survives only in the host terminal lease until parent settlement,
cancellation, permission loss, unload, disable/update, or a confirmed
containment fatal. Reuse the existing post-assembly mutation point, but add
deferred host-owned terminal guidance after all pre-provider transforms.
Before every initial, retry, continuation, inline-tool, fallback, and later
Council provider dispatch, mint and consume a fresh host-only child attachment,
restore the authenticated carrier, and rebuild/revalidate budget, Breakdown,
permission, cancellation, and provenance. Gate E contributes its complete slice
to cumulative types PR #32; it is not a separate external package or host PR.

### Gate F — `feat/spindle-interceptor-final-response`: finalization, compatibility, and locale

Add privileged, non-auto-granted thread-final finalization so the canonical
final route remains **Main or a designated thread**. Deliver one immutable,
shared backend/frontend descriptor and enforce generic manifest
minimum/capability requirements before incompatible source loads. The host
performs the generic pre-bundle nonce/digest handshake; the extension installs
no transport hello/listener and performs no digest exchange. On a compatible
host, allow only immutable descriptor reads until future APC readiness succeeds.
Add the host locale getter/change subscription so extensions can live-switch
their own catalogs. APC ships and renders its own complete catalogs for `en`,
`zh`, `zh-TW`, `ja`, `fr`, and `it` through its registered views. Core may show
only generic conditional permission/compatibility/error diagnostics when
applicable; any new host diagnostic string is added to all six Lumiverse core
locales. No APC-specific labels, views, literals, or catalogs belong in core.
Gate F contributes its complete slice to cumulative types PR #32; it is not a
separate external package or host PR.

## Historical baseline alignment

PR 0 is complete and remains outside the six host capability gates. The
published `lumiverse-spindle-types@0.6.4` remains the current staging type
foundation. Existing aggregate PR #32 is the cumulative D–F contract targeted
at exactly `0.6.5`; it is unpublished and has no release authority until its
upstream author merges and publishes it. Historical version arithmetic and
older staging assessments do not establish current capability or release
authority.

## Local preparation for Gates D–F

PR 0 and host Gates A/B are historical. Current staging retains the surviving
controlled Loom editor/frontend/type foundation relevant to Gate C; no
ready-PR or current-hardening claim is made. Reconstruct and verify D, then E,
then F in the separately claimed consolidated feature worktree. Local prototype
commits and tests are evidence inputs, not current host capabilities. Snapshots
`45acd748` and `e4bbe6c` remain historical reference only, not an implementation
base.

## Local review-bundle protocol

The local bundle retains the historical generic foundations and the surviving
controlled Loom surface. It records separately testable D–F capability slices
with focused tests, generic core documentation, six Lumiverse core locale
updates only when generic host strings are added, and cumulative types source
for PR #32. APC's six locale catalogs belong to the post-host extension
implementation.

The separately claimed consolidated feature worktree composes D, E, and F
sequentially for full cross-gate verification and is the eventual source for
the one APC-only host PR after every external blocker clears. Its path-stable
and branch-specific claims remain held through implementation, verification,
platform smoke testing, and publication. The preserved disposable no-remote
integration clone, its guard, and its commits remain read-only evidence inputs;
they never supply external PR commits or override the current staging base.

Each gate receives its full focused verification before the next starts. One
fresh independent red-team wave reviews the complete D–F bundle only after Gate
F verification. Local prototype commits and tests are not current staging
capabilities, release authority, or proof that the consolidated host PR has
landed. Nothing in the bundle is submitted, published to npm, or represented as
upstream-approved while it remains local.

After the D→E→F evidence and final independent cross-gate red-team review pass,
the one consolidated APC-only host PR carries all three internal gates in that
order. This is one external host PR, not three D/E/F host PRs and not a scope
reduction. Existing aggregate types PR #32 must be merged upstream and its
author must publish exactly `0.6.5` before the host candidate exact-pins it or
opens its draft/publication. This project cannot publish the package. The
earlier blanket publication hold is superseded for this authorized local path;
it is not an active hold, but the upstream publication dependency remains.

— TheLiquorPriest
