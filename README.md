# Agentic Preset Composer

Agentic Preset Composer (APC) is a design-only Spindle extension concept for
Lumiverse: presets that run as a distributed agent graph, composing multiple
role-specialized generations at generation time instead of relying on one
monolithic prompt.

## Status

**Design-only scaffold — implementation is deliberately blocked.**

APC cannot ship through the current Spindle `generate.raw` / `quiet` /
`interceptor` API. The intended in-editor, native-block, dispatch-safe experience
requires six prerequisite host capabilities, each delivered as a serial core
feature PR; PRs 2–6 each publish a matching additive `lumiverse-spindle-types`
release. No APC runtime work begins until all six merge into `staging` and their
type patches publish. If any gap is declined or reshaped, the contract reopens —
there are no fallback paths.

The `src/` entrypoints are scaffold stubs: both perform no API or APC work and
will be replaced when the halt lifts.

The current scaffold manifest deliberately omits the future `final_response`
permission. PR 6 first defines it as privileged and non-auto-granted; the
manifest adds it only against that merged host and matching types release so
today's permission synchronizer cannot reject an unknown permission.

## Where to read

- `DESIGN.md` — the settled canonical design: product model, execution modes,
  threads/outputs/pipelines, privacy/cancellation/snapshot/non-commit
  invariants, the six ordered prerequisite capabilities, and the halt condition.
- `AUTHOR_BRIEF.md` — the concise upstream maintainer handoff and per-PR
  acknowledgment (Gate 0). This is the document upstream inspects and
  acknowledges.
- The approved execution plan (Path C — final) is published at
  https://gist.github.com/TheLiquorPriest/7e34429d87d0d0b72f7db36ee6dfa253
  (SHA-256 `5cfa7cfb7461ceaa6aaacb31c68b8c582f647c84e7c8e8ecdddb1f8c62695877`).
- Its factual current-API erratum is published at
  https://gist.github.com/TheLiquorPriest/0d83d47a449e73d580edb572be817970
  (SHA-256 `0f86ed540a04d21a31cac2017e5ea88d0b4eef66b085879a29eb69e19a71674c`).
  The erratum governs the plan's identified line-11 conflict. A content or
  checksum change to either artifact reopens Gate 0.

## Development

This repo lives under the Lumiverse fork at `extensions/agentic-preset-composer/`
as an independent Spindle extension repo. Follow the Lumiverse fork's
extension-development rules before implementing any behavior. No package, build,
or typecheck operations should run until the Gate 0 acknowledgment is recorded;
the checks below apply only after the halt lifts:

```bash
bun install
bun run build
bun run typecheck
```
