// @ts-ignore Bun provides the test module at runtime; the extension bundle excludes this file.
import { describe, expect, test } from "bun:test"

import {
  characterCount,
  DEFAULT_RUN_TIMEOUT_MS,
  FINALIZATION_RESERVE_MS,
  GRAPH_DEADLINE_MS,
  HOST_INTERCEPTOR_WALL_MS,
  MAX_ACTIVE_GLOBAL,
  MAX_ACTIVE_PER_USER_PRESET,
  MAX_BINDINGS_PER_RUN,
  MAX_BLOCK_CONTENT_BYTES,
  MAX_BLOCKS_PER_THREAD,
  MAX_CONFIG_BYTES,
  MAX_PLAIN_JSON_DEPTH,
  MAX_PLAIN_JSON_NODES,
  MAX_PLAIN_JSON_PATH_CHARS,
  MAX_CONNECTION_SLOTS,
  MAX_DESCRIPTION_BYTES,
  MAX_FINAL_INPUTS,
  MAX_GUIDANCE_BYTES,
  MAX_LITERAL_BYTES,
  MAX_NAME_CHARS,
  MAX_PARALLEL_WIDTH,
  MAX_PROVIDER_RAW_BYTES,
  MAX_RETRIEVAL_SNAPSHOT_BYTES,
  MAX_RETAINED_TRACES_GLOBAL,
  MAX_RETAINED_TRACES_PER_USER_PRESET,
  MAX_RUNS_PER_PIPELINE,
  MAX_STAGES_PER_PIPELINE,
  MAX_THREADS,
  MAX_THREAD_OUTPUT_BYTES,
  MAX_TOOL_SIGNATURE_BYTES,
  MAX_TRACE_BYTES,
  MAX_TRACE_TOTAL_BYTES,
  MAX_WORKSPACE_BYTES,
  MIN_RUN_TIMEOUT_MS,
  MAX_RUN_TIMEOUT_MS,
  TRACE_PREVIEW_BYTES,
  truncateUtf8,
  utf8Bytes,
} from "./limits"
import {
  serializedUtf8Bytes,
  scanPlainJson,
  type PlainJsonError,
  type PlainJsonScanResult,
} from "./plain-json"

function failureOf(result: PlainJsonScanResult): PlainJsonError {
  if (result.ok) {
    throw new Error("Expected plain JSON validation to fail")
  }
  return result.error
}

function expectRejected(value: unknown, code: PlainJsonError["code"]): PlainJsonError {
  const error = failureOf(scanPlainJson(value))
  expect(error.code).toBe(code)
  expect(error.path.length).toBeGreaterThan(0)
  expect(error.message.length).toBeGreaterThan(0)
  return error
}

describe("APC limits and UTF-8 helpers", () => {
  test("exports the shared graph budgets exactly", () => {
    expect({
      HOST_INTERCEPTOR_WALL_MS,
      FINALIZATION_RESERVE_MS,
      GRAPH_DEADLINE_MS,
      DEFAULT_RUN_TIMEOUT_MS,
      MIN_RUN_TIMEOUT_MS,
      MAX_RUN_TIMEOUT_MS,
      MAX_CONFIG_BYTES,
      MAX_PLAIN_JSON_DEPTH,
      MAX_PLAIN_JSON_NODES,
      MAX_PLAIN_JSON_PATH_CHARS,
      MAX_CONNECTION_SLOTS,
      MAX_THREADS,
      MAX_STAGES_PER_PIPELINE,
      MAX_RUNS_PER_PIPELINE,
      MAX_PARALLEL_WIDTH,
      MAX_BLOCKS_PER_THREAD,
      MAX_BINDINGS_PER_RUN,
      MAX_FINAL_INPUTS,
      MAX_ACTIVE_PER_USER_PRESET,
      MAX_ACTIVE_GLOBAL,
      MAX_NAME_CHARS,
      MAX_DESCRIPTION_BYTES,
      MAX_LITERAL_BYTES,
      MAX_BLOCK_CONTENT_BYTES,
      MAX_THREAD_OUTPUT_BYTES,
      MAX_WORKSPACE_BYTES,
      MAX_GUIDANCE_BYTES,
      MAX_TRACE_BYTES,
      MAX_TRACE_TOTAL_BYTES,
      TRACE_PREVIEW_BYTES,
      MAX_RETAINED_TRACES_PER_USER_PRESET,
      MAX_RETAINED_TRACES_GLOBAL,
      MAX_RETRIEVAL_SNAPSHOT_BYTES,
      MAX_PROVIDER_RAW_BYTES,
      MAX_TOOL_SIGNATURE_BYTES,
    }).toEqual({
      HOST_INTERCEPTOR_WALL_MS: 300_000,
      FINALIZATION_RESERVE_MS: 15_000,
      GRAPH_DEADLINE_MS: 285_000,
      DEFAULT_RUN_TIMEOUT_MS: 60_000,
      MIN_RUN_TIMEOUT_MS: 1_000,
      MAX_RUN_TIMEOUT_MS: 240_000,
      MAX_CONFIG_BYTES: 1_048_576,
      MAX_PLAIN_JSON_DEPTH: 128,
      MAX_PLAIN_JSON_NODES: 65_536,
      MAX_PLAIN_JSON_PATH_CHARS: 4_096,
      MAX_CONNECTION_SLOTS: 16,
      MAX_THREADS: 16,
      MAX_STAGES_PER_PIPELINE: 32,
      MAX_RUNS_PER_PIPELINE: 64,
      MAX_PARALLEL_WIDTH: 4,
      MAX_BLOCKS_PER_THREAD: 128,
      MAX_BINDINGS_PER_RUN: 32,
      MAX_FINAL_INPUTS: 32,
      MAX_ACTIVE_PER_USER_PRESET: 8,
      MAX_ACTIVE_GLOBAL: 32,
      MAX_NAME_CHARS: 80,
      MAX_DESCRIPTION_BYTES: 2_048,
      MAX_LITERAL_BYTES: 32_768,
      MAX_BLOCK_CONTENT_BYTES: 131_072,
      MAX_THREAD_OUTPUT_BYTES: 262_144,
      MAX_WORKSPACE_BYTES: 4_194_304,
      MAX_GUIDANCE_BYTES: 1_048_576,
      TRACE_PREVIEW_BYTES: 4_096,
      MAX_TRACE_BYTES: 131_072,
      MAX_TRACE_TOTAL_BYTES: 8_388_608,
      MAX_RETAINED_TRACES_PER_USER_PRESET: 20,
      MAX_RETAINED_TRACES_GLOBAL: 100,
      MAX_RETRIEVAL_SNAPSHOT_BYTES: 4_194_304,
      MAX_PROVIDER_RAW_BYTES: 131_072,
      MAX_TOOL_SIGNATURE_BYTES: 131_072,
    })
  })

  test("counts UTF-8 bytes and Unicode code points", () => {
    expect(utf8Bytes("ASCII")).toBe(5)
    expect(utf8Bytes("é")).toBe(2)
    expect(utf8Bytes("漢")).toBe(3)
    expect(utf8Bytes("😀")).toBe(4)
    expect(characterCount("Aé漢😀")).toBe(4)
    expect(characterCount("e\u0301")).toBe(2)
  })

  test("truncates only at complete code points and accepts exact limits", () => {
    const value = "Aé漢😀Z"
    expect(truncateUtf8(value, 0)).toBe("")
    expect(truncateUtf8(value, 1)).toBe("A")
    expect(truncateUtf8(value, 2)).toBe("A")
    expect(truncateUtf8(value, 3)).toBe("Aé")
    expect(truncateUtf8(value, 6)).toBe("Aé漢")
    expect(truncateUtf8(value, 10)).toBe("Aé漢😀")
    expect(truncateUtf8(value, utf8Bytes(value))).toBe(value)
    expect(truncateUtf8(value, utf8Bytes(value) + 1)).toBe(value)
  })
})

describe("plain JSON validation", () => {
  test("accepts JSON-safe records, arrays, null prototypes, and shared children", () => {
    const shared = { answer: 42 }
    const value: { left: object; right: object; empty: null; list: unknown[] } = Object.create(null)
    value.left = shared
    value.right = shared
    value.empty = null
    value.list = [true, "ok", -0, shared]

    expect(scanPlainJson(value)).toEqual({ ok: true })
    expect(serializedUtf8Bytes(value)).toEqual({
      ok: true,
      bytes: utf8Bytes(JSON.stringify(value)),
    })
  })

  test("does not mutate accepted input", () => {
    const value = { first: ["one", { second: 2 }], third: true }
    const before = JSON.stringify(value)
    expect(scanPlainJson(value)).toEqual({ ok: true })
    expect(JSON.stringify(value)).toBe(before)
  })

  test("rejects object and array cycles", () => {
    const object: Record<string, unknown> = {}
    object.self = object
    expectRejected(object, "cycle")

    const array: unknown[] = []
    array.push(array)
    expectRejected(array, "cycle")
  })

  test("rejects accessors without invoking getters", () => {
    let objectGetterCalls = 0
    const object: Record<string, unknown> = {}
    Object.defineProperty(object, "secret", {
      enumerable: true,
      get: () => {
        objectGetterCalls += 1
        throw new Error("getter must not run")
      },
    })
    expectRejected(object, "accessor")
    expect(objectGetterCalls).toBe(0)

    let arrayGetterCalls = 0
    const array: unknown[] = [1]
    Object.defineProperty(array, "0", {
      enumerable: true,
      get: () => {
        arrayGetterCalls += 1
        throw new Error("array getter must not run")
      },
    })
    expectRejected(array, "accessor")
    expect(arrayGetterCalls).toBe(0)
  })

  test("rejects custom prototypes and built-in instances", () => {
    const customRecord: object = Object.create({ inherited: true })
    expectRejected(customRecord, "custom-prototype")

    const customArray = [1]
    Object.setPrototypeOf(customArray, { custom: true })
    expectRejected(customArray, "custom-prototype")

    expectRejected(new Date(0), "custom-prototype")
    expectRejected(new Map([["key", "value"]]), "custom-prototype")
  })

  test("rejects own toJSON without invoking it", () => {
    let calls = 0
    const object: Record<string, unknown> = {}
    Object.defineProperty(object, "toJSON", {
      enumerable: true,
      value: () => {
        calls += 1
        return "unsafe"
      },
    })
    expectRejected(object, "own-to-json")
    expect(calls).toBe(0)

    const accessorObject: Record<string, unknown> = {}
    Object.defineProperty(accessorObject, "toJSON", {
      enumerable: true,
      get: () => {
        calls += 1
        throw new Error("toJSON getter must not run")
      },
    })
    expectRejected(accessorObject, "own-to-json")
    expect(calls).toBe(0)
  })

  test("rejects every dangerous dictionary key", () => {
    for (const key of ["__proto__", "prototype", "constructor"]) {
      const object: object = Object.create(null)
      Object.defineProperty(object, key, { enumerable: true, value: 1 })
      expectRejected(object, "dangerous-key")
    }
  })

  test("rejects symbol keys and symbol values", () => {
    const symbolKeyObject: Record<string, unknown> = { visible: true }
    Object.defineProperty(symbolKeyObject, Symbol("hidden"), { enumerable: true, value: true })
    expectRejected(symbolKeyObject, "symbol-key")

    expectRejected(Symbol("value"), "unsupported-type")
    expectRejected({ nested: Symbol("value") }, "unsupported-type")
  })

  test("rejects functions, bigints, and undefined", () => {
    expectRejected(() => "not JSON", "unsupported-type")
    expectRejected(1n, "unsupported-type")
    expectRejected(undefined, "unsupported-type")
    expectRejected({ fn: () => 1 }, "unsupported-type")
    expectRejected({ big: 1n }, "unsupported-type")
    expectRejected({ missing: undefined }, "unsupported-type")
  })

  test("rejects sparse and decorated arrays", () => {
    const sparse = new Array(2)
    sparse[1] = "present"
    expectRejected(sparse, "sparse-array")

    const decorated = ["ok"]
    Object.defineProperty(decorated, "extra", { enumerable: true, value: "ignored by JSON" })
    expectRejected(decorated, "array-property")

    const hidden = ["ok"]
    Object.defineProperty(hidden, "hidden", { enumerable: false, value: "not JSON" })
    expectRejected(hidden, "non-enumerable-key")
  })

  test("rejects non-enumerable record properties", () => {
    const object: Record<string, unknown> = { visible: true }
    Object.defineProperty(object, "hidden", { enumerable: false, value: true })
    expectRejected(object, "non-enumerable-key")
  })

  test("rejects non-finite numbers at the exact path", () => {
    expect(failureOf(scanPlainJson({ nested: [0, Number.NaN] }))).toMatchObject({
      path: "$.nested[1]",
      code: "non-finite-number",
    })
    expectRejected(Number.POSITIVE_INFINITY, "non-finite-number")
    expectRejected(Number.NEGATIVE_INFINITY, "non-finite-number")
  })

  test("serialized bytes never stringify a rejected value", () => {
    let getterCalls = 0
    const object: Record<string, unknown> = {}
    Object.defineProperty(object, "bad", {
      enumerable: true,
      get: () => {
        getterCalls += 1
        return "must not be read"
      },
    })
    const result = serializedUtf8Bytes(object)
    expect(result.ok).toBe(false)
    expect(getterCalls).toBe(0)
  })
  test("rejects oversized strings before JSON serialization and UTF-8 encoding", () => {
    const value = { payload: "x".repeat(MAX_CONFIG_BYTES) }
    const originalStringify = JSON.stringify
    const originalEncode = TextEncoder.prototype.encode
    let stringifyCalls = 0
    let encodeCalls = 0
    let result: PlainJsonScanResult | undefined
    try {
      JSON.stringify = (() => {
        stringifyCalls += 1
        throw new Error("JSON.stringify must not run for oversized input")
      }) as typeof JSON.stringify
      TextEncoder.prototype.encode = (() => {
        encodeCalls += 1
        throw new Error("TextEncoder.encode must not run for oversized input")
      }) as TextEncoder["encode"]
      result = scanPlainJson(value)
    } finally {
      JSON.stringify = originalStringify
      TextEncoder.prototype.encode = originalEncode
    }
    expect(result).toMatchObject({
      ok: false,
      error: {
        path: "$.payload",
        code: "serialization-failed",
      },
    })
    expect(stringifyCalls).toBe(0)
    expect(encodeCalls).toBe(0)
  })

  test("bounds depth, node, and path work before traversal", () => {
    const deep: Record<string, unknown> = {}
    let cursor = deep
    for (let index = 0; index <= MAX_PLAIN_JSON_DEPTH; index += 1) {
      const child: Record<string, unknown> = {}
      cursor.next = child
      cursor = child
    }
    expectRejected(deep, "depth-limit")

    const exact = Object.create(null) as Record<string, unknown>
    for (let index = 0; index < MAX_PLAIN_JSON_NODES - 1; index += 1) {
      exact[`k${index}`] = null
    }
    expect(scanPlainJson(exact)).toEqual({ ok: true })

    const overNodes = Object.create(null) as Record<string, unknown>
    for (let index = 0; index < MAX_PLAIN_JSON_NODES; index += 1) {
      overNodes[`k${index}`] = null
    }
    expectRejected(overNodes, "node-limit")

    const longKey = Object.create(null) as Record<string, unknown>
    longKey["x".repeat(MAX_PLAIN_JSON_PATH_CHARS)] = true
    expectRejected(longKey, "path-limit")
  })

  test("ignores inherited getters and toJSON while serializing own data", () => {
    let getterCalls = 0
    const priorGetter = Object.getOwnPropertyDescriptor(Object.prototype as Record<string, unknown>, "inheritedSecret")
    const priorToJson = Object.getOwnPropertyDescriptor(Object.prototype as Record<string, unknown>, "toJSON")
    Object.defineProperty(Object.prototype, "inheritedSecret", {
      configurable: true,
      enumerable: false,
      get: () => {
        getterCalls += 1
        throw new Error("inherited getter must not run")
      },
    })
    Object.defineProperty(Object.prototype, "toJSON", {
      configurable: true,
      enumerable: false,
      value: () => ({ unsafe: true }),
    })
    try {
      const value = { safe: "value" }
      expect(scanPlainJson(value)).toEqual({ ok: true })
      expect(serializedUtf8Bytes(value)).toEqual({
        ok: true,
        bytes: utf8Bytes('{"safe":"value"}'),
      })
      expect(getterCalls).toBe(0)
    } finally {
      if (priorGetter) Object.defineProperty(Object.prototype, "inheritedSecret", priorGetter)
      else delete (Object.prototype as Record<string, unknown>).inheritedSecret
      if (priorToJson) Object.defineProperty(Object.prototype, "toJSON", priorToJson)
      else delete (Object.prototype as Record<string, unknown>).toJSON
    }
  })
})
