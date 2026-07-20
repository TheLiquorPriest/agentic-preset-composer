// @ts-ignore Bun provides the test module at runtime; the extension bundle excludes this file.
import { describe, expect, test } from "bun:test"
import type { ApcThreadV1 } from "../config/schema"
import {
  createBaseWorkspace,
  forkWorkspace,
  materializeWorkspace,
  snapshotWorkspace,
} from "./workspaces"

function block(content: string) {
  return {
    id: "block-1",
    name: "Block",
    content,
    role: "user" as const,
    enabled: true,
    position: "in_history" as const,
    depth: 0,
    marker: null,
    isLocked: false,
    color: null,
    injectionTrigger: [],
    group: null,
  }
}

function thread(): ApcThreadV1 {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    name: "Thread",
    description: "",
    workspaceSource: "native-blocks",
    blocks: [block("base")],
    promptVariableValues: { "block-1": { tone: "plain" } },
    output: { id: "final", name: "Final Response" },
  }
}

describe("APC immutable workspaces", () => {
  test("clones and freezes the configured base workspace", () => {
    const descriptor = thread()
    const base = createBaseWorkspace(descriptor)
    descriptor.blocks[0].content = "mutated after base"
    descriptor.promptVariableValues["block-1"].tone = "changed"

    expect(base.threadId).toBe(descriptor.id)
    expect(base.blocks[0].content).toBe("base")
    expect(base.promptVariableValues["block-1"].tone).toBe("plain")
    expect(Object.isFrozen(base)).toBe(true)
    expect(Object.isFrozen(base.blocks)).toBe(true)
    expect(Object.isFrozen(base.blocks[0])).toBe(true)
    expect(Object.isFrozen(base.promptVariableValues["block-1"])).toBe(true)
  })

  test("forks per-run snapshots without cross-run or base mutation", () => {
    const base = createBaseWorkspace(thread())
    const left = forkWorkspace(base, "run-left")
    const right = forkWorkspace(base, "run-right")
    const leftChanged = snapshotWorkspace(left, {
      blocks: [block("left")],
      promptVariableValues: { "block-1": { tone: "left" } },
    })

    expect(left.runId).toBe("run-left")
    expect(right.runId).toBe("run-right")
    expect(left.blocks[0].content).toBe("base")
    expect(right.blocks[0].content).toBe("base")
    expect(leftChanged.blocks[0].content).toBe("left")
    expect(leftChanged.promptVariableValues["block-1"].tone).toBe("left")
    expect(base.blocks[0].content).toBe("base")
    expect(base.promptVariableValues["block-1"].tone).toBe("plain")
    expect(Object.isFrozen(leftChanged)).toBe(true)
  })

  test("materialization is a detached mutable DTO", () => {
    const base = createBaseWorkspace(thread())
    const run = forkWorkspace(base, "run-materialized")
    const dto = materializeWorkspace(run)
    dto.blocks[0].content = "host-local mutation"
    dto.promptVariableValues["block-1"].tone = "host-local"

    expect(run.blocks[0].content).toBe("base")
    expect(run.promptVariableValues["block-1"].tone).toBe("plain")
    expect(dto.runId).toBe("run-materialized")
  })
})
