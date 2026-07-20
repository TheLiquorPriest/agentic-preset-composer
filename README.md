# Agentic Preset Composer

Agentic Preset Composer (APC) is an opt-in Spindle extension for Lumiverse.
It turns a preset into a bounded agent graph with reusable thread workspaces,
ordered stages, explicit connection review, and a controlled final response.
Single mode continues to use the native preset-generation path.

## Implementation status

Gate G is implemented on `master`. Both extension entrypoints are live:

- The backend validates the immutable host descriptor before creating APC
  state, then starts the storage, endpoint router, frontend-message bridge,
  permission watcher, lifecycle watchers, and interceptor registration.
- The frontend validates the descriptor and required host surface, checks the
  manifest permissions, registers the APC mode toolbar item and **Agent Graph**
  preset-editor tab, and owns the graph, thread workspace, inspector, consent
  review, locale subscription, and teardown lifecycle.
- `package.json` and `bun.lock` pin `lumiverse-spindle-types` to exact `0.6.6`.
  The checked-in source pin is the dependency record for this extension.
This is source implementation status, not a production-readiness or publication
claim. Isolated host testing requires the authenticated containment-fatal
propagation contract described in `DESIGN.md`. The current test authority is
Lumiverse PR #249 commit `90a7fdafec3fdc46d03f0764d30d9282f89ec649`;
ordinary `staging` remains ineligible until that correction merges.

The descriptor must contain `descriptorVersion`, `lumiverseVersion`,
`capabilities`, and `extensionInstallationId`. APC requires Lumiverse `1.0.8`
or newer and these seven host capabilities at version `1`:

1. `preset-extension-data-v1`
2. `preset-editor-v1`
3. `loom-block-editor-v1`
4. `generation-assembly-v1`
5. `interceptor-context-v1`
6. `interceptor-final-response-v1`
7. `connection-dispatch-resolution-v1`

An incompatible descriptor fails before APC registration or other domain work.
The manifest declares `interceptor`, `generation`, `presets`, and
`final_response`. Loss of required `interceptor` or `generation` permission
revokes the backend registration and disarms active APC work; loss of
`final_response` disables only Thread-final routing and leaves safe native Main
fallback available.

## Runtime contract

### Modes and first use

The registered toolbar exposes **Single**, **Sequential**, and **Parallel**:

- **Single** activates the host's built-in `blocks` preset editor and leaves
  native assembly and dispatch unchanged.
- **Sequential** runs exactly one run per ordered stage, using authoritative
  Main dispatch for every call. The Sequential UI exposes no connection-slot
  picker and runtime ignores stored per-thread slot metadata in this mode;
  switching back to Parallel preserves those bindings.
- **Parallel** runs one to four distinct runs in a stage, drains with
  `allSettled`, and preserves configured output order. A thread can inherit
  Main or use an explicitly bound connection slot.

An empty graph offers two explicit creation actions: **Create Sequential
graph** and **Create Parallel graph**. Either action creates the selected mode's
first reusable thread, stage, and run, then leaves the draft for the shared
save coordinator. It does not create a sample graph, bind a connection, or
grant consent. Single remains available throughout.

### Graph and persistence

The portable graph is stored only at
`metadata.agentic_preset_composer`. Host metadata passthrough preserves that
bag and unrelated siblings. Connection UUIDs, dispatch revisions, receipts,
nonces, user IDs, and other private authority data never enter portable
metadata or user-facing APC copy.

Threads use either a native-block workspace or a read-only snapshot of Main
context. Each run has one `final` output. References target earlier stages
only; invalid closure, limits, or final routing disables the affected mode.
The schema limits are 16 threads, 32 stages, 64 runs, four parallel runs per
stage, one sequential run per stage, and a 240-second run timeout.

Mode and graph edits use the namespace-scoped preset-editor draft helper and
the host save coordinator's generation-flush barrier. A failed ordinary graph
save keeps the draft visibly dirty with its failure so it can be corrected and
resaved. A failed mode transition restores the last persisted active mode;
native and APC pipelines remain untouched.

### Dispatch, consent, and authority

APC resolves every destination through the authenticated host connection API.
Each run carries a discriminated `main` or `slot` dispatch source and the exact
expected `connectionDispatchRevision`. Native-block assembly uses
`spindle.generate.assemble`; provider dispatch uses
`spindle.generate.quietTracked` with that same bound source and revision.
APC validates the returned tracked receipt and rejects stale, mismatched, or
untrusted results before committing a run.

Consent is bound to the installation, preset, thread, workspace source,
connection source, resolved destination, effective dispatch revision, and
disclosure version. The frontend sends intent only; it never asserts a
revision, user identity, destination, or whole document. Missing or stale
consent always makes zero assembly/provider subcalls. A required run then
drives the required-failure Graph-fallback outcome; an optional run follows
its configured optional-local policy.
The backend is the sole local-state writer and serializes binding, consent,
and execution-replacement mutations.

### Cancellation, outcomes, and final response

Frontend Stop and replacement use the `cancel_execution` intent. Callback-bound
cancellation is propagated internally through host-owned signals; APC does
not serialize an `AbortSignal` as a frontend/backend payload. Stop,
replacement, timeout, required failure, permission loss, disable, update, and
unload cannot revive an execution. The graph work deadline leaves a host
reserve for terminal transition and drain.

The monotonic outcome order is **integrity-fatal > parent-cancel >
selected-final failure > Graph-fallback > optional-local > success**. A
required failure falls back through Main; optional failures follow their
configured policy. The final route is either Main or a designated thread run.
Main guidance is placed immediately before the authenticated prefill carrier;
thread-final output uses the privileged host finalization path. If
`final_response` is unavailable or revoked, APC emits a bounded reason/activity
and preserves the safe native Main response instead. APC never promises rollback
of provider, tool, Council, history, or cache effects that already occurred.

## Build and isolated-host testing

From this extension repository, use Bun and the checked-in lockfile:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run build
```

`bun run build` invokes the package's `build:backend` and `build:frontend`
scripts and produces the manifest entrypoints `dist/backend.js` and
`dist/frontend.js`. Run focused tests with `bun test` when needed.
HOST TESTING GATE — provision, import, enable, restart, and browser-test APC
only in a registered isolated host pinned to Lumiverse PR #249 commit
`90a7fdafec3fdc46d03f0764d30d9282f89ec649` or a verified descendant that
preserves the same authenticated containment-fatal contract. Do not use an
ordinary `staging` host or production. Publication remains blocked pending the
isolated-host evidence and user acceptance.

### Isolated host workflow

For local host testing, first register a dedicated isolated Lumiverse host using
the shared environment guide. Use that host's registered `STATE.md`
`paths.data_dir` as `HOST_DATA_DIR`; never use the canonical checkout's data
directory. Link only the extension repository under the manifest identifier:

```sh
HOST_DATA_DIR='<registered isolated-host data directory>'
EXTENSION_ROOT='<absolute APC extension repository>'
mkdir -p "$HOST_DATA_DIR/extensions/agentic_preset_composer"
ln -s "$EXTENSION_ROOT" \
  "$HOST_DATA_DIR/extensions/agentic_preset_composer/repo"
```

As the host owner, call `POST /api/v1/spindle/import-local` on that registered
host. Read the import response (or `GET /api/v1/spindle`) to obtain the
extension's database UUID. The route placeholder is that database UUID, not
`agentic_preset_composer`: grant permissions with
`POST /api/v1/spindle/<DB_UUID>/permissions`, enable with
`POST /api/v1/spindle/<DB_UUID>/enable`, and after each `bun run build` reload
with `POST /api/v1/spindle/<DB_UUID>/restart`. Restart consumes the already
built `dist` entrypoints; it does not build them.

## Source map

- `spindle.json` — manifest, permissions, compatibility minimum, and
  `dist` entrypoints.
- `src/backend.ts` and `src/backend/` — registration, storage, dispatch,
  execution, cancellation, traces, endpoints, and final routing.
- `src/frontend.ts` and `src/frontend/` — host contributions, graph/thread
  editing, persistence, consent presentation, activity projection, and
  teardown.
- `DESIGN.md` — product, authority, privacy, dispatch, cancellation, and
  final-response contract.
- `UI.md` — current presentation and interaction guidance.
