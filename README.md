# Agentic Preset Composer

Agentic Preset Composer (APC) is a design-only Spindle extension concept for
Lumiverse: presets that run as a distributed agent graph, composing multiple
role-specialized generations at generation time instead of relying on one
monolithic prompt.

## Status

**Design-only, inert scaffold — APC cannot run today.**

Current staging now supplies reusable Spindle primitives: generic top-level
`LoomPreset.passthroughMetadata`; native preset-editor tabs and draft helpers;
`spindle.assemble`; nonrecursive `spindle.generate.quiet`; a 300-second
interceptor budget; richer pre-assembly generation context; and post-assembly
message, parameter, and Breakdown mutation. APC will reuse those primitives,
not recreate their generic surfaces.

They are not the canonical APC contract. They do not provide the persistent
mode toolbar and built-in Blocks activation, controlled native thread editor,
parent-bound assembly/retrieval/dispatch/prefill snapshots, invocation-bound
identity and cancellation, non-commit containment, tracked revision-bound
dispatch receipts, terminal guidance placement, thread-final finalization,
live host locale, or an enforced shared host descriptor.

The portable graph has one wire location:
`metadata.agentic_preset_composer`. The clean cutover has no dual key, dual
read, or `extensionsMeta` model: the Gate 0 audit found no persisted APC rows at
either prior path and no installed APC extension. Generic passthrough must
preserve every unrelated metadata sibling.

No APC runtime work begins until all six complementary, serial-unstacked host
gates merge into `staging` and the matching `lumiverse-spindle-types` releases
publish. The current work prepares the discrete lock-alignment **PR 0** and all
six capability deltas privately before any external submission. Root and frontend
manifests declare `0.6.2`, while both frozen locks resolve `0.6.1`; PR 0 must
resolve that upstream baseline mismatch before frozen-install parity claims.

The `src/` entrypoints deliberately make no API calls, registrations, UI mounts,
storage accesses, or APC work. The manifest retains only current permissions;
it does not request the future privileged `final_response` permission or enable
any future runtime setting.

The schema-required `github` and `homepage` values are local release metadata
for a future extension repository. They neither configure a Git remote nor
install, access, or publish APC; no APC remote exists before user-directed
publication.

## Local review bundle

The user has authorized local-only preparation. The lock-alignment PR 0 and six
capability deltas are recorded as separately testable patchsets, then composed
only in a separate disposable local integration clone for combined verification.
The clone has no configured remote or upstream and a clone-local `pre-push`
guard that rejects every destination; the local workflow forbids guard bypass,
remote/push URL changes, and `--no-verify`. It never supplies an external PR
commit. The future PRs remain ordinary upstream review work; each will be
reconstructed from current `origin/staging` after its predecessor merges. A
rejection or material reshape reopens the affected contract boundary rather than
creating an APC fallback.

1. **Generic metadata passthrough and LumiHub integrity.** Reuse upstream
   passthrough metadata, preserve every sibling key, and fix LumiHub
   create/update preservation. This gate is not an `extensionsMeta` rewrite.
2. **Preset-editor surfaces and persistence.** Reuse the upstream tab and draft
   helper; add the persistent `Single | Sequential | Parallel` toolbar,
   built-in Blocks activation, namespace-scoped mutation with read-only Main
   fields, permission-revocation teardown, one global per-preset save
   coordinator, and generation-flush gating.
3. **Controlled native Loom editor.** Extract one shared controlled native Loom
   editor for Main and extension-owned thread values.
4. **Parent-bound assembly and dispatch substrate.** Reuse assembly and quiet
   internals while adding host-internal parent route/retrieval/dispatch/prefill
   snapshots, invocation-token enforcement, a non-commit lease and fatal
   channel, and typed tracked dispatch with immutable revisions and receipts.
   This gate does not activate APC callbacks.
5. **Authoritative interceptor lifecycle and terminal placement.** Use the PR 4
   substrate to bind callbacks, aborts, effective context, matching, and
   disposal authoritatively, then defer terminal guidance and revalidate it
   before every provider route.
6. **Finalization, compatibility, and locale.** Add thread-final finalization,
   an enforced shared backend/frontend descriptor with minimum compatibility,
   host locale/live switching, and all six catalogs.

These are the post-gate canonical requirements; **none of this APC behavior
exists or runs while the host gates and matching types releases remain pending.**
After they land, the persistent toolbar and Agent Graph flow must retain native
Blocks activation; native-block threads must reuse the frozen parent retrieval
snapshot with no new retrieval effects; final routing must remain Main-or-thread;
and dispatch must remain bound to immutable source revisions and receipts.
Callback-bound user and cancellation, fail-closed containment, and terminal
guidance immediately before every provider call remain required.

Council remains enabled in that future runtime. Sidecar provider/tool effects and
completed history/cache writes that already occurred before APC interception are
explicit nonrollbackable effects; later provider routes remain subject to APC's
terminal guidance, carrier, budget, and provenance validation.

## Where to read

- `DESIGN.md` — the canonical APC product and security contract, including the
  upstream primitives it reuses and the six complementary gates.
- `AUTHOR_BRIEF.md` — the authoritative local core-PR review and release
  protocol, including the private integration-clone controls.

Together these documents define the canonical local set. No external Gist,
prior plan, or unlisted local artifact may amend either document.

## Development

This independent extension repository remains inert while the core gates are
pending. Local design and no-op scaffold maintenance are permitted; do not add
runtime behavior, future permissions, package versions, lockfile changes, or
build output to this extension until all six core gates and matching type
releases land.

Before preparing the local PR 1 patchset, verify the local-only Lumiverse WIP
snapshot `45acd748`, rename the old local branch to an archive name, unset its
upstream and `pushRemote`, and verify no remote ref contains it. Then derive the
patchset from the latest `origin/staging`. Create a fresh external
`feat/preset-extension-metadata` branch only after publication is authorized and
PR 0 has merged. The prior APC design snapshot `e4bbe6c` is historical
reference, not authorization to transplant its implementation.
