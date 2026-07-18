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

The merged Gate B host capability is complete as a generic, inert surface:
generic toolbar placement and registration roots, generic preset-editor
tab/helper lifecycle and mount roots, activation of the built-in preset editor through the generic `blocks` API ID,
namespace-scoped mutation and serialization, permission-revocation teardown,
save coordination, and generation flushing. Core ships no APC-specific toolbar
item or default UI.

The APC frontend later registers its toolbar item and Agent Graph tab through
those generic roots, rendering the **Single | Sequential | Parallel** radiogroup
and Agent Graph content with APC-owned labels, disabled reasons, accessibility
behavior, and catalogs.

The surviving controlled native Loom editor and its generic frontend
bridge/placement surface remain current staging foundations for Gate C. The
broader historical Gate C hardening is not current capability or release
authority. Gates D–F still need parent-bound assembly/retrieval/dispatch/prefill
snapshots, invocation-bound identity and cancellation, non-commit containment,
tracked revision-bound receipts, terminal guidance placement, thread-final
finalization, live host locale, and an enforced shared host descriptor.

The portable graph has one wire location:
`metadata.agentic_preset_composer`. The clean cutover has no dual key, dual
read, or `extensionsMeta` model: the Gate 0 audit found no persisted APC rows at
either prior path and no installed APC extension. Generic passthrough must
preserve every unrelated metadata sibling.

## Cross-gate baseline invariant

Across every gate, absent an APC extension registration or use of a new generic
mount/API, steady-state baseline Lumiverse controls, layout, DOM, and baseline
strings remain unchanged apart from generic conditional diagnostics. Any new host
diagnostic string is added to all six Lumiverse core locales.
Core exposes only generic, inert placement, lifecycle, bridge, compatibility,
locale, and finalization roots; it never adds APC-specific visuals, literals, or
catalogs. The APC frontend registers the toolbar item and Agent Graph tab
through those generic roots, then renders the **Single | Sequential |
Parallel** radiogroup, Agent Graph content, APC labels, disabled reasons,
accessibility behavior, and its six locale catalogs. No APC-specific locale
catalog belongs in core.

No APC runtime work begins until one consolidated APC-only host PR carrying
internal Gates D→E→F lands in `staging` and upstream has merged PR #32. Its
author must publish exact `0.6.5` before the host candidate exact-pins it or
opens its draft/publication. Final D–F evidence and the independent red-team
review must pass before exact pinning or draft/public host publication. PR 0 and
Gates A/B are historical; the controlled Loom foundation relevant to Gate C
survives in current staging. The existing PR #32 aggregate contract is
unpublished, and this extension cannot publish it. Committed dependency metadata
remains pinned to published `0.5.31`; local checks against the unpublished
`0.6.5` candidate use an uncommitted local link only. The publication hold
remains active: update the package dependency and `bun.lock` together to exact
`0.6.5` only after upstream publishes that version.
APC compatibility source/manifest alignment targets Lumiverse `1.0.8`; the
capability validator still rejects any `1.0.8` host lacking the required Gate
D–F capabilities. The candidate `0.6.5` types release also remains
unpublished, and the consolidated host PR remains blocked.

The `src/` entrypoints synchronously validate only the immutable public host
descriptor (`spindle.host` or `ctx.host`) before any registration, UI mount,
storage, network, or APC API work; valid descriptors leave the backend inert and
return a frontend cleanup no-op, while invalid descriptors throw. The manifest
records exactly the four contract permissions; it does not claim or enable APC
runtime behavior.

The schema-required `github` and `homepage` values are local release metadata
for a future extension repository. They neither configure a Git remote nor
install, access, or publish APC; no APC remote exists before user-directed
publication.

## Local review bundle

The user has authorized local consolidated D–F implementation/evidence and one
APC-only host PR. Gate C contributes only its surviving controlled Loom
foundation; D, then E, then F are internally ordered, separately testable
slices of the one host PR, with full feature scope preserved. The separately
claimed consolidated feature worktree composes them sequentially for cross-gate
verification and becomes the one external host PR source only after all
evidence and publication blockers clear. The preserved no-remote prototype
clone remains read-only evidence and never supplies external PR commits. One
independent cross-gate red-team wave runs after all
three slices pass verification. There is no requirement for three external
D/E/F host PRs.

1. **Generic metadata passthrough and LumiHub integrity (Gate A — complete).**
   The completed gate reuses upstream passthrough metadata, preserves every
   sibling key, and records LumiHub create/update preservation. This gate is not
   an `extensionsMeta` rewrite.
2. **Generic preset-editor surfaces and persistence (Gate B host capability — complete).**
   The completed host capability provides generic toolbar placement/registration
   roots, tab/helper lifecycle, activation of the built-in preset editor through the generic `blocks` API ID,
   namespace-scoped mutation/serialization, permission teardown, save coordination, and
   generation-flush gating. It is inert by default and adds no APC-specific UI.
   The APC frontend later registers its toolbar item through the generic toolbar
   root and renders the **Single | Sequential | Parallel** radiogroup and
   **Agent Graph** view through the generic roots.
3. **Controlled native Loom editor (Gate C — surviving foundation).** One shared
   controlled editor keeps default output visually identical to Lumiverse's
   editor; its bridge stays visually inert until an extension explicitly
   requests a mount. APC later mounts it for extension-owned thread values and
   owns the surrounding thread UI; the bridge seals host-only fields. This is
   the surviving generic foundation only, not current APC runtime capability.
4. **Parent-bound assembly and dispatch substrate (Gate D).** Reuse assembly and quiet
   internals while adding host-internal parent route/retrieval/dispatch/prefill
   snapshots, invocation-token enforcement, a non-commit lease and fatal
   channel, and typed tracked dispatch with immutable revisions and receipts.
   This gate does not activate APC callbacks.
5. **Authoritative interceptor lifecycle and terminal placement (Gate E).** Use
   the Gate D substrate to bind callbacks, aborts, effective context, matching,
   and disposal authoritatively, then defer terminal guidance and revalidate it
   before every provider route.
6. **Finalization, compatibility, and locale (Gate F).** Core exposes privileged
   thread-final finalization, an enforced shared backend/frontend descriptor
   with minimum compatibility, and a host locale getter/change subscription.
   APC ships and renders its own complete catalogs for `en`, `zh`, `zh-TW`,
   `ja`, `fr`, and `it` through its registered views. Generic conditional
   permission/compatibility/error diagnostics may appear when applicable; any
   new host diagnostic string is added to all six Lumiverse core locales. No
   APC-specific labels, views, literals, or catalogs belong in core.

These are the post-gate canonical requirements; **none of this APC behavior
exists or runs while the consolidated host PR and the author-published,
exact-pinned `0.6.5` types contract remain pending.** After those prerequisites
land, the APC frontend registers the persistent toolbar item and Agent Graph
tab through the generic roots, then renders the **Single | Sequential |
Parallel** radiogroup and Agent Graph content. That extension-owned flow
retains native **Blocks** activation; native-block threads must reuse the frozen
parent retrieval snapshot with no new retrieval effects; final routing must
remain Main-or-thread; and dispatch must remain bound to immutable source
revisions and receipts.
Callback-bound user and cancellation, fail-closed containment, and terminal
guidance immediately before every provider call remain required.
Council remains enabled in that future runtime. Sidecar provider/tool effects
and completed history/cache writes that already occurred before APC interception
are explicit nonrollbackable effects; later provider routes remain subject to
APC's terminal guidance, carrier, budget, and provenance validation.

## Where to read

- `DESIGN.md` — the canonical APC product and security contract, including the
  upstream primitives, surviving foundations, and three ordered D–F gates.
- `AUTHOR_BRIEF.md` — the authoritative consolidated host-PR review, evidence,
  and release protocol.

Together these documents define the canonical local set. No external Gist,
prior plan, or unlisted local artifact may amend either document.

## Development

This independent extension repository remains inert while the consolidated
APC-only host PR and the author-published, exact-pinned `0.6.5` types contract
remain pending. Committed dependency metadata remains pinned to published
`0.5.31`; local candidate checks may use an uncommitted local link only. Local
design and no-op scaffold maintenance are permitted; do not commit that local
link or add runtime behavior, future permissions, package versions, lockfile
changes, or build output to this extension. Update the package dependency and
`bun.lock` together to exact `0.6.5` only after upstream publishes it. This
project cannot publish the types package.

The authorized D–F candidate is reconstructed in the separately claimed
consolidated feature worktree. Preserve unrelated work and treat the stopped
no-remote prototype clone, local prototype tests, and snapshots `45acd748` and
`e4bbe6c` as historical evidence only, never as current staging capability or
an implementation base.
