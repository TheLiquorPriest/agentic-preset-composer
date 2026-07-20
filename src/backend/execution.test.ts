// @ts-ignore Bun provides the test module at runtime; extension bundles exclude tests.
import { describe, expect, test } from "bun:test"
import type {
  BoundAssemblyOutcomeDTO,
  ConnectionDispatchDescriptorDTO,
  InterceptorContextDTO,
  LlmMessageDTO,
  PromptBlockDTO,
  QuietDispatchReceiptDTO,
  QuietTrackedResultDTO,
} from "lumiverse-spindle-types"
import {
  executeAuxiliaryRun,
  type AuxiliaryExecutionDeps,
  type AuxiliaryExecutionInput,
} from "./execution"
import {
  MAX_BLOCKS_PER_THREAD,
  MAX_PROVIDER_RAW_BYTES,
  MAX_THREAD_OUTPUT_BYTES,
  MAX_TOOL_SIGNATURE_BYTES,
} from "../config/limits"

const DESCRIPTOR: ConnectionDispatchDescriptorDTO = Object.freeze({
  connectionId: "11111111-1111-4111-8111-111111111111",
  connectionName: "Main",
  provider: "test-provider",
  model: "test-model",
  endpointOrigin: "https://provider.invalid",
  dispatchKind: "concrete",
  connectionDispatchRevision: "dispatch-1",
})

const SLOT_DESCRIPTOR: ConnectionDispatchDescriptorDTO = Object.freeze({
  connectionId: "33333333-3333-4333-8333-333333333333",
  connectionName: "Slot",
  provider: "test-provider",
  model: "slot-model",
  endpointOrigin: "https://provider.invalid",
  dispatchKind: "concrete",
  connectionDispatchRevision: "slot-1",
})

const BLOCK = Object.freeze({
  id: "22222222-2222-4222-8222-222222222222",
  name: "Instructions",
  role: "system",
  content: "Follow the graph role.",
  position: "relative",
  depth: 0,
  enabled: true,
  injectionDepth: 0,
  injectionTrigger: "none",
  marker: "none",
  group: null,
  categoryMode: null,
  sealed: false,
  characterTagTrigger: [],
  variables: [],
}) as unknown as PromptBlockDTO

const ASSEMBLED: readonly LlmMessageDTO[] = Object.freeze([
  Object.freeze({ role: "system", content: "assembled" }),
])

const INPUT_BINDINGS: readonly LlmMessageDTO[] = Object.freeze([
  Object.freeze({ role: "user", content: "bound input" }),
])

const RESPONSE = Object.freeze({
  content: "provider response",
  reasoning: "provider reasoning",
  finish_reason: "stop",
})

const RECEIPT: QuietDispatchReceiptDTO = Object.freeze({
  providerInvoked: true,
  terminalResponse: true,
  source: "main",
  connectionId: DESCRIPTOR.connectionId,
  connectionDispatchRevision: "dispatch-1",
  usage: Object.freeze({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }),
})

function receipt(overrides: Partial<QuietDispatchReceiptDTO> = {}): QuietDispatchReceiptDTO {
  return { ...RECEIPT, ...overrides }
}

function context(
  signal: AbortSignal = new AbortController().signal,
  overrides: Partial<InterceptorContextDTO> = {},
): InterceptorContextDTO {
  return {
    userId: "user-1",
    chatId: "chat-1",
    generationId: "generation-1",
    generationType: "normal",
    isDryRun: false,
    presetId: "preset-1",
    presetMetadata: null,
    personaId: null,
    characterId: "character-1",
    personaAddonStates: {},
    mainDispatch: {
      source: "main",
      descriptor: DESCRIPTOR,
      connectionDispatchRevision: "dispatch-1",
      dispatchKind: "concrete",
    },
    prefillCarrier: { id: "prefill-1", state: "available" },
    interceptorDeadlineAt: 100_000,
    boundWorkDeadlineAt: 100_000,
    signal,
    ...overrides,
  }
}

function input(overrides: Partial<AuxiliaryExecutionInput> = {}): AuxiliaryExecutionInput {
  return {
    context: context(),
    resolvedHostDescriptor: DESCRIPTOR,
    run: { id: "run-1", timeoutMs: 1_000 },
    workspace: {
      source: "native-blocks",
      blocks: Object.freeze([BLOCK]),
      promptVariableValues: Object.freeze({}),
    },
    mainMessages: undefined,
    inputBindings: INPUT_BINDINGS,
    parentSignal: new AbortController().signal,
    deadlineAt: 100_000,
    expectedDispatchRevision: "dispatch-1",
    dispatchSource: "main",
    ...overrides,
  }
}

function successfulAssembly(
  source: "main" | "slot" = "main",
  descriptor: ConnectionDispatchDescriptorDTO = DESCRIPTOR,
  connectionDispatchRevision = descriptor.connectionDispatchRevision ?? "dispatch-1",
): BoundAssemblyOutcomeDTO {
  return {
    ok: true,
    result: {
      messages: ASSEMBLED.map((message) => ({ ...message })),
      breakdown: [],
      resolved: {
        source,
        connectionId: descriptor.connectionId,
        connectionDispatchRevision,
        dispatchKind: "concrete",
      },
    },
  }
}

function successfulQuiet(dispatchReceipt: QuietDispatchReceiptDTO = RECEIPT): QuietTrackedResultDTO {
  return { ok: true, response: RESPONSE, receipt: dispatchReceipt }
}

function deps(overrides: Partial<AuxiliaryExecutionDeps> = {}): AuxiliaryExecutionDeps {
  return {
    assemble: async () => successfulAssembly(),
    quietTracked: async () => successfulQuiet(),
    isExecutionCurrent: () => true,
    now: () => 0,
    ...overrides,
  }
}

type TrackedSignal = AbortSignal & {
  readonly listenerCount: () => number
  readonly abort: (reason?: unknown) => void
}

function trackedSignal(): TrackedSignal {
  let aborted = false
  let reason: unknown
  const listeners = new Set<() => void>()
  return {
    get aborted() {
      return aborted
    },
    get reason() {
      return reason
    },
    addEventListener(_type: string, listener: unknown) {
      if (typeof listener === "function") listeners.add(listener as () => void)
    },
    removeEventListener(_type: string, listener: unknown) {
      if (typeof listener === "function") listeners.delete(listener as () => void)
    },
    listenerCount: () => listeners.size,
    abort(nextReason = "host-abort") {
      if (aborted) return
      aborted = true
      reason = nextReason
      for (const listener of [...listeners]) listener()
    },
  } as unknown as TrackedSignal
}

function controlledClock(startAt = 0) {
  let current = startAt
  let nextHandle = 0
  let clearCount = 0
  const callbacks = new Map<number, () => void>()
  const delays: number[] = []
  return {
    now: () => current,
    setTimeout: (callback: () => void, timeoutMs: number) => {
      const handle = ++nextHandle
      callbacks.set(handle, callback)
      delays.push(timeoutMs)
      return handle
    },
    clearTimeout: (handle: unknown) => {
      clearCount += 1
      callbacks.delete(handle as number)
    },
    advanceTo: (value: number) => {
      current = value
    },
    fireAll: () => {
      for (const [handle, callback] of [...callbacks.entries()]) {
        if (!callbacks.delete(handle)) continue
        callback()
      }
    },
    pending: () => callbacks.size,
    clearCount: () => clearCount,
    delays: () => delays,
  }
}

describe("executeAuxiliaryRun", () => {
  test("performs native assembly and a tracked quiet call with bound provenance", async () => {
    let assemblyInput: Record<string, unknown> | undefined
    let quietInput: Record<string, unknown> | undefined
    const callbackSignal = trackedSignal()
    const parentSignal = trackedSignal()
    const clock = controlledClock()
    const result = await executeAuxiliaryRun(
      input({ context: context(callbackSignal), parentSignal }),
      deps({
        assemble: async (request) => {
          assemblyInput = request as unknown as Record<string, unknown>
          return successfulAssembly()
        },
        quietTracked: async (request) => {
          quietInput = request as unknown as Record<string, unknown>
          return successfulQuiet()
        },
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
      }),
    )

    expect(result.kind).toBe("success")
    if (result.kind !== "success") return
    expect(assemblyInput).toBeDefined()
    expect(assemblyInput?.dispatch).toEqual({
      source: "main",
      expectedConnectionDispatchRevision: "dispatch-1",
    })
    expect(assemblyInput?.blocks).toEqual([BLOCK])
    expect(assemblyInput?.deadlineAt).toBe(1_000)
    expect(assemblyInput?.signal).toBeDefined()
    expect(quietInput?.dispatch).toEqual({
      source: "main",
      expectedConnectionDispatchRevision: "dispatch-1",
    })
    expect(quietInput?.messages).toEqual([
      { role: "system", content: "assembled" },
      { role: "user", content: "bound input" },
    ])
    expect(quietInput?.deadlineAt).toBe(1_000)
    expect(quietInput?.continuation).toEqual({
      parentPrefill: { id: "prefill-1", state: "available" },
      mode: "append-parent-carrier-last",
    })
    expect(result.messages).toEqual([
      { role: "system", content: "assembled" },
      { role: "user", content: "bound input" },
    ])
    expect(result.content).toBe("provider response")
    expect(result.receipt).toEqual(RECEIPT)
    expect(result.provenance).toEqual({
      userId: "user-1",
      chatId: "chat-1",
      generationId: "generation-1",
      presetId: "preset-1",
      runId: "run-1",
      source: "main",
      connectionId: DESCRIPTOR.connectionId,
      connectionDispatchRevision: "dispatch-1",
    })
    expect(Object.isFrozen(result.messages)).toBe(true)
    expect(Object.isFrozen(result.receipt)).toBe(true)
    expect(Object.isFrozen(result.provenance)).toBe(true)
    expect(quietInput).not.toHaveProperty("endpoint")
    expect(quietInput).not.toHaveProperty("provider")
    expect(quietInput).not.toHaveProperty("apiKey")
    expect(callbackSignal.listenerCount()).toBe(0)
    expect(parentSignal.listenerCount()).toBe(0)
    expect(clock.pending()).toBe(0)
    expect(clock.clearCount()).toBe(1)
    expect(clock.delays()).toEqual([1_000])
  })

  test("uses the immutable Main message snapshot without an assembly call", async () => {
    let assemblies = 0
    let quietInput: Record<string, unknown> | undefined
    const mainMessages: readonly LlmMessageDTO[] = Object.freeze([
      Object.freeze({ role: "system", content: "main snapshot" }),
    ])
    const result = await executeAuxiliaryRun(
      input({
        workspace: { source: "main-context", promptVariableValues: Object.freeze({}) },
        mainMessages,
      }),
      deps({
        assemble: async () => {
          assemblies += 1
          return successfulAssembly()
        },
        quietTracked: async (request) => {
          quietInput = request as unknown as Record<string, unknown>
          return successfulQuiet()
        },
      }),
    )

    expect(result.kind).toBe("success")
    expect(assemblies).toBe(0)
    expect(quietInput?.messages).toEqual([
      { role: "system", content: "main snapshot" },
      { role: "user", content: "bound input" },
    ])
    expect(quietInput?.dispatch).toEqual({
      source: "main",
      expectedConnectionDispatchRevision: "dispatch-1",
    })
  })

  test("rejects a stale callback dispatch revision before any host call", async () => {
    let calls = 0
    const result = await executeAuxiliaryRun(
      input({
        context: context(undefined, {
          mainDispatch: {
            source: "main",
            descriptor: DESCRIPTOR,
            connectionDispatchRevision: "dispatch-2",
            dispatchKind: "concrete",
          },
        }),
      }),
      deps({
        assemble: async () => {
          calls += 1
          return successfulAssembly()
        },
        quietTracked: async () => {
          calls += 1
          return successfulQuiet()
        },
      }),
    )

    expect(result).toEqual({
      kind: "failed",
      code: "STALE_DISPATCH_REVISION",
      phase: "revision",
      message: "Main dispatch descriptor is not bound to the expected revision",
    })
    expect(calls).toBe(0)
  })

  test("contains a stale execution scope after an awaited assembly", async () => {
    let checks = 0
    let quietCalls = 0
    const assemblyDeferred = Promise.withResolvers<BoundAssemblyOutcomeDTO>()
    const assemblyCalled = Promise.withResolvers<void>()
    const resultPromise = executeAuxiliaryRun(
      input(),
      deps({
        isExecutionCurrent: () => {
          checks += 1
          return checks < 2
        },
        assemble: () => {
          assemblyCalled.resolve()
          return assemblyDeferred.promise
        },
        quietTracked: async () => {
          quietCalls += 1
          return successfulQuiet()
        },
      }),
    )
    await assemblyCalled.promise
    assemblyDeferred.resolve(successfulAssembly())
    const result = await resultPromise

    expect(result).toEqual({
      kind: "failed",
      code: "STALE_EXECUTION_SCOPE",
      phase: "revision",
      message: "APC execution scope changed at after-assembly",
    })
    expect(checks).toBe(2)
    expect(quietCalls).toBe(0)
  })

  test("cancels a callback-bound assembly at its deadline and contains resources", async () => {
    const callbackSignal = trackedSignal()
    const parentSignal = trackedSignal()
    const clock = controlledClock()
    const assemblyDeferred = Promise.withResolvers<BoundAssemblyOutcomeDTO>()
    const assemblyCalled = Promise.withResolvers<void>()
    let assemblySignal: AbortSignal | undefined
    let quietCalls = 0
    const resultPromise = executeAuxiliaryRun(
      input({
        context: context(callbackSignal),
        parentSignal,
        deadlineAt: 1_000,
      }),
      deps({
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        assemble: (request) => {
          assemblySignal = request.signal
          assemblyCalled.resolve()
          return assemblyDeferred.promise
        },
        quietTracked: async () => {
          quietCalls += 1
          return successfulQuiet()
        },
      }),
    )
    await assemblyCalled.promise
    expect(clock.pending()).toBe(1)
    clock.advanceTo(1_001)
    clock.fireAll()
    assemblyDeferred.resolve(successfulAssembly())
    const result = await resultPromise

    expect(result).toEqual({
      kind: "timed-out",
      code: "DEADLINE_EXCEEDED",
      message: "Auxiliary run deadline exceeded",
      deadlineAt: 1_000,
      provenance: {
        userId: "user-1",
        chatId: "chat-1",
        generationId: "generation-1",
        presetId: "preset-1",
        runId: "run-1",
        source: "main",
        connectionId: DESCRIPTOR.connectionId,
        connectionDispatchRevision: "dispatch-1",
      },
    })
    expect(assemblySignal?.aborted).toBe(true)
    expect(quietCalls).toBe(0)
    expect(callbackSignal.listenerCount()).toBe(0)
    expect(parentSignal.listenerCount()).toBe(0)
    expect(clock.pending()).toBe(0)
    expect(clock.clearCount()).toBe(0)
  })

  test("propagates callback cancellation and ignores a late assembly value", async () => {
    const callbackSignal = trackedSignal()
    const parentSignal = trackedSignal()
    const clock = controlledClock()
    const assemblyDeferred = Promise.withResolvers<BoundAssemblyOutcomeDTO>()
    const assemblyCalled = Promise.withResolvers<void>()
    let assemblySignal: AbortSignal | undefined
    let quietCalls = 0
    const resultPromise = executeAuxiliaryRun(
      input({ context: context(callbackSignal), parentSignal }),
      deps({
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        assemble: (request) => {
          assemblySignal = request.signal
          assemblyCalled.resolve()
          return assemblyDeferred.promise
        },
        quietTracked: async () => {
          quietCalls += 1
          return successfulQuiet()
        },
      }),
    )
    await assemblyCalled.promise
    callbackSignal.abort("host-abort")
    assemblyDeferred.resolve(successfulAssembly())
    const result = await resultPromise

    expect(result.kind).toBe("cancelled")
    if (result.kind !== "cancelled") return
    expect(result.provenance).toEqual({
      userId: "user-1",
      chatId: "chat-1",
      generationId: "generation-1",
      presetId: "preset-1",
      runId: "run-1",
      source: "main",
      connectionId: DESCRIPTOR.connectionId,
      connectionDispatchRevision: "dispatch-1",
    })
    expect(assemblySignal?.aborted).toBe(true)
    expect(quietCalls).toBe(0)
    expect(callbackSignal.listenerCount()).toBe(0)
    expect(parentSignal.listenerCount()).toBe(0)
    expect(clock.pending()).toBe(0)
    expect(clock.clearCount()).toBe(1)
  })

  test("propagates parent cancellation and removes the parent listener", async () => {
    const callbackSignal = trackedSignal()
    const parentSignal = trackedSignal()
    const clock = controlledClock()
    const assemblyDeferred = Promise.withResolvers<BoundAssemblyOutcomeDTO>()
    const assemblyCalled = Promise.withResolvers<void>()
    let assemblySignal: AbortSignal | undefined
    const resultPromise = executeAuxiliaryRun(
      input({ context: context(callbackSignal), parentSignal }),
      deps({
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        assemble: (request) => {
          assemblySignal = request.signal
          assemblyCalled.resolve()
          return assemblyDeferred.promise
        },
      }),
    )
    await assemblyCalled.promise
    parentSignal.abort("stop")
    assemblyDeferred.resolve(successfulAssembly())
    const result = await resultPromise

    expect(result.kind).toBe("cancelled")
    expect(assemblySignal?.aborted).toBe(true)
    expect(callbackSignal.listenerCount()).toBe(0)
    expect(parentSignal.listenerCount()).toBe(0)
    expect(clock.pending()).toBe(0)
    expect(clock.clearCount()).toBe(1)
  })

  test("binds slot dispatches to the resolved connection and receipt", async () => {
    let assemblyInput: Record<string, unknown> | undefined
    let quietInput: Record<string, unknown> | undefined
    const slotReceipt = receipt({
      source: "slot",
      connectionId: SLOT_DESCRIPTOR.connectionId,
      connectionDispatchRevision: "slot-1",
    })
    const result = await executeAuxiliaryRun(
      input({
        resolvedHostDescriptor: SLOT_DESCRIPTOR,
        expectedDispatchRevision: "slot-1",
        dispatchSource: "slot",
      }),
      deps({
        assemble: async (request) => {
          assemblyInput = request as unknown as Record<string, unknown>
          return successfulAssembly("slot", SLOT_DESCRIPTOR, "slot-1")
        },
        quietTracked: async (request) => {
          quietInput = request as unknown as Record<string, unknown>
          return successfulQuiet(slotReceipt)
        },
      }),
    )

    expect(result.kind).toBe("success")
    if (result.kind !== "success") return
    expect(assemblyInput?.dispatch).toEqual({
      source: "slot",
      connectionId: SLOT_DESCRIPTOR.connectionId,
      expectedConnectionDispatchRevision: "slot-1",
    })
    expect(quietInput?.dispatch).toEqual({
      source: "slot",
      connectionId: SLOT_DESCRIPTOR.connectionId,
      expectedConnectionDispatchRevision: "slot-1",
    })
    expect(result.receipt).toMatchObject({
      source: "slot",
      connectionId: SLOT_DESCRIPTOR.connectionId,
      connectionDispatchRevision: "slot-1",
    })
    expect(result.provenance).toMatchObject({
      source: "slot",
      connectionId: SLOT_DESCRIPTOR.connectionId,
      connectionDispatchRevision: "slot-1",
    })
  })

  test("preserves a verified host receipt and provenance on provider error", async () => {
    const providerError: QuietTrackedResultDTO = {
      ok: false,
      phase: "resolved",
      receipt: RECEIPT,
      error: {
        kind: "provider",
        code: "PROVIDER_CALL_FAILED",
        name: "ProviderError",
        message: "provider unavailable",
      },
    }
    const result = await executeAuxiliaryRun(input(), deps({ quietTracked: async () => providerError }))

    expect(result).toMatchObject({
      kind: "failed",
      code: "PROVIDER_CALL_FAILED",
      phase: "provider",
      receipt: RECEIPT,
    })
    if (result.kind !== "failed") return
    expect(result.receipt).not.toBe(RECEIPT)
    expect(Object.isFrozen(result.receipt)).toBe(true)
    expect(result.provenance).toEqual({
      userId: "user-1",
      chatId: "chat-1",
      generationId: "generation-1",
      presetId: "preset-1",
      runId: "run-1",
      source: "main",
      connectionId: DESCRIPTOR.connectionId,
      connectionDispatchRevision: "dispatch-1",
    })
  })

  test("maps a thrown tracked generation request to a receipt-free terminal provider failure", async () => {
    const result = await executeAuxiliaryRun(
      input(),
      deps({
        quietTracked: async () => {
          throw new Error("provider transport unavailable")
        },
      }),
    )

    expect(result).toMatchObject({
      kind: "failed",
      code: "PROVIDER_CALL_FAILED",
      phase: "provider",
      message: "provider transport unavailable",
    })
    expect(result).not.toHaveProperty("receipt")
  })
  test("rejects resolved tracked failures with extra top-level fields or malformed receipts", async () => {
    const resolvedFailure: QuietTrackedResultDTO = {
      ok: false,
      phase: "resolved",
      receipt: RECEIPT,
      error: {
        kind: "provider",
        code: "PROVIDER_CALL_FAILED",
        name: "ProviderError",
        message: "provider unavailable",
      },
    }
    const invalidResults: readonly unknown[] = [
      { ...resolvedFailure, providerInvoked: true },
      { ...resolvedFailure, receipt: { ...RECEIPT, terminalResponse: "yes" } },
    ]

    for (const invalidResult of invalidResults) {
      const result = await executeAuxiliaryRun(
        input(),
        deps({ quietTracked: async () => invalidResult as QuietTrackedResultDTO }),
      )
      expect(result).toMatchObject({
        kind: "failed",
        code: "UNTRUSTED_RESULT",
        phase: "dispatch",
      })
      expect(result).not.toHaveProperty("receipt")
    }
  })


  test("rejects an untracked receipt from a different dispatch revision", async () => {
    const result = await executeAuxiliaryRun(
      input(),
      deps({
        quietTracked: async () =>
          successfulQuiet(receipt({ connectionDispatchRevision: "dispatch-2" })),
      }),
    )

    expect(result).toMatchObject({
      kind: "failed",
      code: "UNTRUSTED_RECEIPT",
      phase: "dispatch",
    })
    expect(result).not.toHaveProperty("receipt")
  })

  test("rejects endpoint, provider, and secret fields from APC payloads", async () => {
    let calls = 0
    const unsafe = input({
      workspace: {
        source: "native-blocks",
        blocks: Object.freeze([BLOCK]),
        promptVariableValues: Object.freeze({}),
        provider: "forged-provider",
        endpoint: "https://attacker.invalid",
        apiKey: "forged-secret",
      } as unknown as AuxiliaryExecutionInput["workspace"],
    })
    const result = await executeAuxiliaryRun(
      unsafe,
      deps({
        assemble: async () => {
          calls += 1
          return successfulAssembly()
        },
      }),
    )
    expect(result).toMatchObject({ kind: "failed", code: "UNTRUSTED_PAYLOAD" })
    expect(calls).toBe(0)
  })
  test("rejects oversized host assembly arrays before snapshot cloning", async () => {
    const base = successfulAssembly()
    if (!base.ok) throw new Error("assembly fixture must succeed")
    let quietCalls = 0
    const hostileAssembly: BoundAssemblyOutcomeDTO = {
      ok: true,
      result: {
        ...base.result,
        messages: Array.from(
          { length: MAX_BLOCKS_PER_THREAD * 4 + 1 },
          () => ({ role: "assistant", content: "oversized" }),
        ),
      },
    }
    const result = await executeAuxiliaryRun(
      input(),
      deps({
        assemble: async () => hostileAssembly,
        quietTracked: async () => {
          quietCalls += 1
          return successfulQuiet()
        },
      }),
    )

    expect(result).toMatchObject({
      kind: "failed",
      code: "UNTRUSTED_ASSEMBLY",
      phase: "assembly",
    })
    expect(quietCalls).toBe(0)
  })

  test("rejects oversized, deep, and private nested provider payloads before accepting a result", async () => {
    const base = successfulQuiet()
    if (!base.ok) throw new Error("quiet fixture must succeed")
    let deep: Record<string, unknown> = {}
    for (let depth = 0; depth < 40; depth += 1) deep = { next: deep }
    const privateRaw = JSON.parse('{"__proto__":"forged"}') as Record<string, unknown>
    const privateKeyRaw = JSON.parse('{"PRIVATE_KEY":"forged"}') as Record<string, unknown>
    let shared: Record<string, unknown> = { value: "shared" }
    for (let depth = 0; depth < 20; depth += 1) {
      shared = { left: shared, right: shared }
    }
    const hostileResults: readonly unknown[] = [
      {
        ok: true,
        response: { ...base.response, content: "x".repeat(MAX_THREAD_OUTPUT_BYTES + 1) },
        receipt: RECEIPT,
      },
      {
        ok: true,
        response: { ...base.response, reasoning_details: [deep] },
        receipt: RECEIPT,
      },
      {
        ok: true,
        response: {
          ...base.response,
          tool_calls: [{
            name: "lookup",
            args: { payload: "x".repeat(MAX_PROVIDER_RAW_BYTES + 1) },
            call_id: "call-oversized",
            thought_signature: "x".repeat(MAX_TOOL_SIGNATURE_BYTES + 1),
          }],
        },
        receipt: RECEIPT,
      },
      {
        ok: true,
        response: base.response,
        receipt: receipt({ usage: { provider_raw: privateRaw } }),
      },
      {
        ok: true,
        response: base.response,
        receipt: receipt({ usage: { provider_raw: privateKeyRaw } }),
      },
      {
        ok: true,
        response: { ...base.response, reasoning_details: [shared] },
        receipt: RECEIPT,
      },
      {
        ok: true,
        response: {
          ...base.response,
          reasoning_details: Array.from({ length: MAX_BLOCKS_PER_THREAD * 4 + 1 }, () => ({})),
        },
        receipt: RECEIPT,
      },
    ]

    for (const hostileResult of hostileResults) {
      const result = await executeAuxiliaryRun(
        input(),
        deps({ quietTracked: async () => hostileResult as QuietTrackedResultDTO }),
      )
      expect(result).toMatchObject({
        kind: "failed",
        code: "UNTRUSTED_RESULT",
        phase: "dispatch",
      })
      expect(result).not.toHaveProperty("response")
      expect(result).not.toHaveProperty("receipt")
    }
  })

  test("preserves bounded nested provider response payloads", async () => {
    const nestedResponse = {
      content: "nested provider response",
      reasoning: "bounded reasoning",
      finish_reason: "stop",
      tool_calls: [{
        name: "lookup",
        args: { query: "APC", options: { exact: true } },
        call_id: "call-1",
        thought_signature: "opaque-signature",
      }],
      thinking_blocks: [{ type: "thinking", thinking: "bounded thought", signature: "opaque-signature" }],
      reasoning_details: [{ provider: "test-provider", steps: [{ name: "lookup", ok: true }] }],
      usage: {
        prompt_tokens: 3,
        completion_tokens: 2,
        total_tokens: 5,
        provider_raw: { provider: "test-provider", nested: { accepted: true } },
      },
    }
    const result = await executeAuxiliaryRun(
      input(),
      deps({
        quietTracked: async () =>
          ({ ok: true, response: nestedResponse, receipt: RECEIPT }) as QuietTrackedResultDTO,
      }),
    )

    expect(result.kind).toBe("success")
    if (result.kind !== "success") return
    expect(result.response).toEqual(nestedResponse)
    expect(result.response.tool_calls).toEqual(nestedResponse.tool_calls)
    expect(result.response.reasoning_details).toEqual(nestedResponse.reasoning_details)
    expect(result.response.usage).toEqual(nestedResponse.usage)
    expect(Object.isFrozen(result.response)).toBe(true)
    expect(Object.isFrozen(result.response.tool_calls)).toBe(true)
  })

  test("requires complete receipt facts and exact dispatch provenance for success", async () => {
    const forgedReceipts: readonly QuietDispatchReceiptDTO[] = [
      receipt({ providerInvoked: false }),
      receipt({ terminalResponse: false }),
      receipt({ source: "slot" }),
      receipt({ connectionId: SLOT_DESCRIPTOR.connectionId }),
      receipt({ connectionDispatchRevision: "dispatch-2" }),
    ]

    for (const forgedReceipt of forgedReceipts) {
      const result = await executeAuxiliaryRun(
        input(),
        deps({ quietTracked: async () => successfulQuiet(forgedReceipt) }),
      )
      expect(result).toMatchObject({
        kind: "failed",
        code: "UNTRUSTED_RECEIPT",
        phase: "dispatch",
      })
      expect(result).not.toHaveProperty("receipt")
    }
  })

})
