# Agentic Preset Composer Design Brainstorm

This document captures the brainstorm for Agentic Preset Composer. It does not implement orchestration yet.

## Concept

A preset executes as a graph of subagent nodes. Each node is an LLM generation optimized for a role, such as narrative direction, tone/style, memory/lore recall, or constraint enforcement. Those role-specialized generations are composed before the main turn, so the user-facing generation receives coordinated guidance rather than one monolithic prompt.

## Primary mechanism candidate

Use a pre-generation interceptor as the composition point:

1. Read the active preset's Agentic Preset Composer graph configuration.
2. Fire N `spindle.generate.quiet()` calls for the configured subagent nodes, in parallel via `Promise.all`.
3. Compose the node outputs according to the selected strategy.
4. Inject the composed guidance as a system message.
5. Add a Prompt Breakdown entry so users can inspect what was injected.

Alternative: use a `context_handler` to enrich pre-assembly instead of intercepting the assembled prompt.

## Config storage

Store the graph definition in preset `metadata` under a namespaced key:

```json
{
  "metadata": {
    "agentic_preset_composer": {
      "enabled": true,
      "nodes": [],
      "rolePrompts": {},
      "compositionStrategy": "concatenate"
    }
  }
}
```

The configuration contains nodes, role prompts, composition strategy, and an enable flag. A frontend composer UI edits this metadata; the backend reads it in the interceptor. The namespaced key follows the presets doc's metadata namespacing rule.

## Open questions

- Composition strategy: concatenate, synthesize-by-final-agent, voting, layered injection, or another model.
- Latency versus the interceptor timeout budget, including the maximum 5 minute budget and pre-token silence.
- Cost/token controls, including per-preset and per-chat opt-in.
- Where composed output lands: system message, replacement prompt blocks, or another insertion point.
- Relationship/overlap with the existing Council multi-member pre-generation analysis.
- Failure/degradation behavior when a node times out.

## Intended permissions

- `interceptor`
- `generation`
- `presets`

Add `generation_parameters` only if the extension needs to inject provider parameters.

## Non-goals (scaffold)

No orchestration code yet.
