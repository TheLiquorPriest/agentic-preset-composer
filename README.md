# Agentic Preset Composer

Agentic Preset Composer is a Spindle extension concept for Lumiverse: presets that run as a distributed agent graph, composing multiple role-specialized generations at generation time instead of relying on one monolithic prompt.

## Status

Scaffold — not yet functional; orchestration lands after the design brainstorm.

## Development

This repo lives under the Lumiverse fork at `extensions/agentic-preset-composer/` as an independent Spindle extension repo. Read `DESIGN.md` for the brainstorm capture, and follow the Lumiverse fork's extension-development docs/rules before implementing behavior.

Useful local checks:

```bash
bun install
bun run build
bun run typecheck
```
