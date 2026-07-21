// @ts-ignore Bun provides the test module at runtime; the extension bundle excludes this file.
import { describe, expect, test } from "bun:test"
import {
  MAX_BLOCK_CONTENT_BYTES,
  MAX_BLOCKS_PER_THREAD,
  MAX_DESCRIPTION_BYTES,
  MAX_LITERAL_BYTES,
  MAX_NAME_CHARS,
} from "./limits"
import {
  APC_METADATA_KEY,
  type ApcPresetConfigV1,
  createDefaultApcConfig,
  decodeApcPresetConfig,
} from "./schema"

const SLOT_ID = "550e8400-e29b-41d4-a716-446655440000"
const THREAD_ID = "550e8400-e29b-41d4-a716-446655440001"
const SEQUENTIAL_PIPELINE_ID = "550e8400-e29b-41d4-a716-446655440002"
const PARALLEL_PIPELINE_ID = "550e8400-e29b-41d4-a716-446655440003"
const SEQUENTIAL_STAGE_ID = "550e8400-e29b-41d4-a716-446655440004"
const PARALLEL_STAGE_ID = "550e8400-e29b-41d4-a716-446655440005"
const SEQUENTIAL_RUN_ID = "550e8400-e29b-41d4-a716-446655440006"
const PARALLEL_RUN_ID = "550e8400-e29b-41d4-a716-446655440007"

function block(): ApcPresetConfigV1["threads"][number]["blocks"][number] {
  return {
    id: "instruction",
    name: "Instruction",
    content: "Be concise.",
    role: "system",
    enabled: true,
    position: "pre_history",
    depth: 0,
    marker: null,
    isLocked: false,
    color: null,
    injectionTrigger: [],
    group: null,
  }
}

function validConfig(): ApcPresetConfigV1 {
  return {
    schemaVersion: 1,
    supportedModes: ["single", "sequential", "parallel"],
    activeMode: "sequential",
    mainThread: {
      id: "main",
      name: "Main Thread",
      output: { id: "final", name: "Final Response" },
    },
    connectionSlots: [
      {
        id: SLOT_ID,
        label: "Writing profile",
        hint: { profileName: "Writer", provider: "openai", model: "gpt-5" },
      },
    ],
    threads: [
      {
        id: THREAD_ID,
        name: "Writer",
        description: "Writes a draft.",
        workspaceSource: "native-blocks",
        connectionSlotId: SLOT_ID,
        blocks: [block()],
        promptVariableValues: {},
        output: { id: "final", name: "Final Response" },
      },
    ],
    pipelines: {
      sequential: {
        id: SEQUENTIAL_PIPELINE_ID,
        stages: [
          {
            id: SEQUENTIAL_STAGE_ID,
            name: "Draft",
            runs: [
              {
                id: SEQUENTIAL_RUN_ID,
                threadId: THREAD_ID,
                required: true,
                timeoutMs: 60_000,
                inputs: [
                  { source: "literal", role: "user", content: "Draft the answer." },
                ],
              },
            ],
          },
        ],
        finalResponse: {
          source: "main",
          inputs: [{ source: "output", runId: SEQUENTIAL_RUN_ID, onMissing: "omit-binding" }],
        },
      },
      parallel: {
        id: PARALLEL_PIPELINE_ID,
        stages: [
          {
            id: PARALLEL_STAGE_ID,
            name: "Parallel draft",
            runs: [
              {
                id: PARALLEL_RUN_ID,
                threadId: THREAD_ID,
                required: false,
                timeoutMs: 60_000,
                inputs: [
                  {
                    source: "output",
                    runId: SEQUENTIAL_RUN_ID,
                    role: "assistant",
                    onMissing: "skip-run",
                  },
                ],
              },
            ],
          },
        ],
        finalResponse: { source: "thread", runId: PARALLEL_RUN_ID },
      },
    },
  }
}

describe("APC V1 schema decoder", () => {
  test("normalizes an absent legacy bag to a fresh Single-only default", () => {
    const first = decodeApcPresetConfig(undefined)
    const second = decodeApcPresetConfig(undefined)

    expect(first.status).toBe("legacy")
    expect(first.future).toBe(false)
    expect(first.issues).toEqual([])
    expect(first.config).toEqual(createDefaultApcConfig())
    expect(first.config).not.toBe(second.config)
    expect(first.modeIssues).toEqual({ single: [], sequential: [], parallel: [] })
  })

  test("decodes a complete V1 config without changing its portable values", () => {
    const raw = validConfig()
    const decoded = decodeApcPresetConfig(raw)

    expect(decoded.status).toBe("valid")
    expect(decoded.future).toBe(false)
    expect(decoded.raw).toBe(raw)
    expect(decoded.config).toEqual(raw)
    expect(decoded.config?.threads[0]?.blocks[0]).toMatchObject({
      marker: null,
      color: null,
      group: null,
    })
    expect(decoded.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: ["threads", 0, "blocks", 0, "marker"],
        code: "STRING_OR_NULL_REQUIRED",
      }),
    ]))
    expect(decoded.issues).toEqual([])
    expect(decoded.modeIssues).toEqual({ single: [], sequential: [], parallel: [] })
  })

  test("accepts an ordinary structuredClone of the default config", () => {
    const cloned = structuredClone(createDefaultApcConfig())
    const decoded = decodeApcPresetConfig(cloned)

    expect(decoded.status).toBe("valid")
    expect(decoded.config).toEqual(cloned)
    expect(decoded.issues).toEqual([])
  })

  test("rejects non-null values for nullable block fields", () => {
    const raw = validConfig()
    const blockValue = raw.threads[0].blocks[0] as unknown as Record<string, unknown>
    blockValue.marker = 42
    const decoded = decodeApcPresetConfig(raw)

    expect(decoded.status).toBe("invalid")
    expect(decoded.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: ["threads", 0, "blocks", 0, "marker"],
        code: "STRING_OR_NULL_REQUIRED",
      }),
    ]))
  })

  test("reports malformed envelopes and does not invent a config", () => {
    const raw = 42
    const decoded = decodeApcPresetConfig(raw)

    expect(decoded.status).toBe("invalid")
    expect(decoded.raw).toBe(raw)
    expect(decoded.config).toBeNull()
    expect(decoded.issues[0]).toMatchObject({ path: [], code: "OBJECT_REQUIRED" })
  })

  test("marks unknown versions future while preserving the exact raw object", () => {
    const raw = { schemaVersion: 2, opaque: { retained: true } }
    const decoded = decodeApcPresetConfig(raw)

    expect(decoded.status).toBe("future")
    expect(decoded.future).toBe(true)
    expect(decoded.raw).toBe(raw)
    expect(decoded.config).toBeNull()
    expect(decoded.issues).toEqual([])
  })

  test("keeps an inactive malformed pipeline local to that mode", () => {
    const raw = validConfig()
    raw.activeMode = "sequential"
    raw.pipelines.parallel = {
      id: "not-a-uuid",
      stages: [],
      finalResponse: { source: "main", inputs: [] },
    }
    const decoded = decodeApcPresetConfig(raw)

    expect(decoded.status).toBe("valid")
    expect(decoded.config?.pipelines.parallel).toBeUndefined()
    expect(decoded.config?.pipelines.sequential).toEqual(raw.pipelines.sequential)
    expect(decoded.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ mode: "parallel", code: "INVALID_UUID" }),
    ]))
    expect(decoded.modeIssues.parallel).toEqual(expect.arrayContaining([
      expect.objectContaining({ mode: "parallel", path: ["pipelines", "parallel", "id"] }),
    ]))
    expect(decoded.modeIssues.sequential).toEqual([])
  })

  test("does not mutate imported input while cloning the executable config", () => {
    const raw = validConfig()
    const before = JSON.stringify(raw)
    const decoded = decodeApcPresetConfig(raw)

    expect(JSON.stringify(raw)).toBe(before)
    expect(decoded.config).not.toBe(raw)
    expect(decoded.raw).toBe(raw)
  })

  test("rejects reserved and noncanonical generated IDs", () => {
    const raw = validConfig()
    raw.connectionSlots[0].id = "main"
    raw.threads[0].id = "550E8400-E29B-41D4-A716-446655440001"
    const decoded = decodeApcPresetConfig(raw)

    expect(decoded.status).toBe("invalid")
    expect(decoded.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ["connectionSlots", 0, "id"], code: "RESERVED_ID" }),
      expect.objectContaining({ path: ["threads", 0, "id"], code: "INVALID_UUID" }),
    ]))
  })

  test("does not read an alternate metadata container", () => {
    const raw = { metadata: { [APC_METADATA_KEY]: validConfig() } }
    const decoded = decodeApcPresetConfig(raw)

    expect(decoded.status).toBe("invalid")
    expect(decoded.config).toBeNull()
    expect(decoded.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ["schemaVersion"], code: "SCHEMA_VERSION_REQUIRED" }),
    ]))
  })

  test("bounds prompt DTO fields and collections at canonical caps", () => {
    const textVariable = (index: number) => ({
      id: `variable-${index}`,
      name: `variable-${index}`,
      label: `Variable ${index}`,
      type: "text" as const,
      defaultValue: "value",
    })
    const decode = (raw: ApcPresetConfigV1) => decodeApcPresetConfig(raw)

    const exactTrigger = validConfig()
    exactTrigger.threads[0].blocks[0].injectionTrigger = Array.from({ length: MAX_BLOCKS_PER_THREAD }, () => "trigger")
    expect(decode(exactTrigger).status).toBe("valid")
    const overTrigger = structuredClone(exactTrigger)
    overTrigger.threads[0].blocks[0].injectionTrigger.push("overflow")
    expect(decode(overTrigger).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "COLLECTION_LIMIT" }),
    ]))

    const exactVariables = validConfig()
    exactVariables.threads[0].blocks[0].variables = Array.from({ length: MAX_BLOCKS_PER_THREAD }, (_, index) => textVariable(index))
    expect(decode(exactVariables).status).toBe("valid")
    const overVariables = structuredClone(exactVariables)
    overVariables.threads[0].blocks[0].variables?.push(textVariable(MAX_BLOCKS_PER_THREAD))
    expect(decode(overVariables).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "COLLECTION_LIMIT" }),
    ]))

    const exactOptions = validConfig()
    exactOptions.threads[0].blocks[0].variables = [{
      id: "select-variable",
      name: "select-variable",
      label: "Select variable",
      type: "select",
      defaultValue: "option-0",
      options: Array.from({ length: MAX_BLOCKS_PER_THREAD }, (_, index) => ({
        id: `option-${index}`,
        label: `Option ${index}`,
        value: `value-${index}`,
      })),
    }]
    expect(decode(exactOptions).status).toBe("valid")
    const overOptions = structuredClone(exactOptions)
    const select = overOptions.threads[0].blocks[0].variables?.[0]
    if (!select || select.type !== "select") throw new Error("select fixture missing")
    select.options.push({ id: "overflow", label: "Overflow", value: "overflow" })
    expect(decode(overOptions).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "COLLECTION_LIMIT" }),
    ]))

    const exactValues = validConfig()
    exactValues.threads[0].promptVariableValues = {
      instruction: Object.fromEntries(Array.from({ length: MAX_BLOCKS_PER_THREAD }, (_, index) => [`variable-${index}`, "value"])),
    }
    expect(decode(exactValues).status).toBe("valid")
    const overValues = structuredClone(exactValues)
    overValues.threads[0].promptVariableValues.instruction[`variable-${MAX_BLOCKS_PER_THREAD}`] = "overflow"
    expect(decode(overValues).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "COLLECTION_LIMIT" }),
    ]))

    const exactValueArray = validConfig()
    exactValueArray.threads[0].blocks[0].variables = [{
      id: "multi-variable",
      name: "multi-variable",
      label: "Multi variable",
      type: "multiselect",
      defaultValue: Array.from({ length: MAX_BLOCKS_PER_THREAD }, (_, index) => `option-${index}`),
      options: [],
    }]
    expect(decode(exactValueArray).status).toBe("valid")
    const overValueArray = structuredClone(exactValueArray)
    const multi = overValueArray.threads[0].blocks[0].variables?.[0]
    if (!multi || multi.type !== "multiselect") throw new Error("multiselect fixture missing")
    multi.defaultValue.push("overflow")
    expect(decode(overValueArray).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "COLLECTION_LIMIT" }),
    ]))

    const exactFields = validConfig()
    exactFields.threads[0].blocks[0].content = "x".repeat(MAX_BLOCK_CONTENT_BYTES)
    exactFields.threads[0].blocks[0].name = "x".repeat(MAX_NAME_CHARS)
    exactFields.threads[0].description = "x".repeat(MAX_DESCRIPTION_BYTES)
    exactFields.threads[0].blocks[0].variables = [{
      ...textVariable(0),
      description: "x".repeat(MAX_DESCRIPTION_BYTES),
      defaultValue: "x".repeat(MAX_LITERAL_BYTES),
    }]
    expect(decode(exactFields).status).toBe("valid")
    const overFields = structuredClone(exactFields)
    overFields.threads[0].blocks[0].content += "x"
    expect(decode(overFields).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "BLOCK_CONTENT_LIMIT" }),
    ]))
    const overName = structuredClone(exactFields)
    overName.threads[0].blocks[0].name += "x"
    expect(decode(overName).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "NAME_LIMIT" }),
    ]))
    const overDescription = structuredClone(exactFields)
    const overDescriptionVariable = overDescription.threads[0].blocks[0].variables?.[0]
    if (!overDescriptionVariable) throw new Error("description fixture missing")
    overDescriptionVariable.description = "x".repeat(MAX_DESCRIPTION_BYTES + 1)
    expect(decode(overDescription).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "DESCRIPTION_LIMIT" }),
    ]))
    const overLiteral = structuredClone(exactFields)
    const overText = overLiteral.threads[0].blocks[0].variables?.[0]
    if (!overText || overText.type !== "text") throw new Error("text fixture missing")
    overText.defaultValue += "x"
    expect(decode(overLiteral).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "LITERAL_LIMIT" }),
    ]))
  })
})
