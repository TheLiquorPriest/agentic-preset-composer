// @ts-ignore Bun provides the test module at runtime; the extension bundle excludes this file.
import { describe, expect, test } from "bun:test"
import type {
  InterceptorContextDTO,
  InterceptorHandler,
  InterceptorRegistrationOptions,
  LlmMessageDTO,
} from "lumiverse-spindle-types"
import { createDefaultApcConfig, type ApcPresetConfigV1 } from "../config/schema"
import {
  APC_INTERCEPTOR_MATCH,
  InterceptorRegistrationRegistry,
  type ApcInterceptorRegistrar,
} from "./interceptor-registration"

const USER_PERMISSIONS = ["interceptor", "generation"] as const

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`
}

function sequentialConfig(): ApcPresetConfigV1 {
  const config = createDefaultApcConfig()
  const threadId = uuid(1)
  const runId = uuid(2)
  config.supportedModes = ["single", "sequential"]
  config.activeMode = "sequential"
  config.threads = [{
    id: threadId,
    name: "Worker",
    description: "",
    workspaceSource: "native-blocks",
    blocks: [],
    promptVariableValues: {},
    output: { id: "final", name: "Final Response" },
  }]
  config.pipelines = {
    sequential: {
      id: uuid(3),
      stages: [{
        id: uuid(4),
        name: "Stage",
        runs: [{ id: runId, threadId, required: true, timeoutMs: 60_000, inputs: [] }],
      }],
      finalResponse: {
        source: "main",
        inputs: [{ source: "output", runId, onMissing: "omit-binding" }],
      },
    },
  }
  return config
}

function singleConfig(): ApcPresetConfigV1 {
  return createDefaultApcConfig()
}

interface RegistrarCall {
  readonly handler: InterceptorHandler
  readonly options: InterceptorRegistrationOptions
  disposed: number
  active: boolean
}

function registrarSeam(): { registrar: ApcInterceptorRegistrar; calls: RegistrarCall[] } {
  const calls: RegistrarCall[] = []
  const registrar: ApcInterceptorRegistrar = {
    registerInterceptor(handler, options) {
      const call: RegistrarCall = { handler, options, disposed: 0, active: true }
      calls.push(call)
      return () => {
        if (!call.active) return
        call.active = false
        call.disposed += 1
      }
    },
  }
  return { registrar, calls }
}

function contextFor(
  userId: string,
  presetId: string,
  presetMetadata: unknown = sequentialConfig(),
  generationType: "normal" | "continue" = "normal",
  isDryRun = false,
): InterceptorContextDTO {
  return {
    userId,
    chatId: "chat",
    generationId: "generation",
    generationType,
    isDryRun,
    presetId,
    presetMetadata,
    personaId: null,
    characterId: null,
    personaAddonStates: {},
    mainDispatch: {
      source: "main",
      descriptor: null,
      connectionDispatchRevision: null,
      dispatchKind: null,
    },
    prefillCarrier: { id: "prefill", state: "available" },
    interceptorDeadlineAt: Date.now() + 300_000,
    boundWorkDeadlineAt: Date.now() + 285_000,
    signal: new AbortController().signal,
  }
}

const messages: LlmMessageDTO[] = [{ role: "user", content: "hello" }]

describe("APC interceptor registration", () => {
  test("registers exactly once with the host-supported match options", () => {
    const { registrar, calls } = registrarSeam()
    const registry = new InterceptorRegistrationRegistry(registrar)
    const handler: InterceptorHandler = async (input) => input

    expect(registry.ensureRegistered({ permissions: USER_PERMISSIONS, handler })).toBe(true)
    expect(registry.ensureRegistered({ permissions: USER_PERMISSIONS, handler })).toBe(true)
    expect(registry.has()).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.options).toEqual({ match: APC_INTERCEPTOR_MATCH })
  })

  test("replaces the handler pointer without adding an overlapping host registration", async () => {
    const { registrar, calls } = registrarSeam()
    const registry = new InterceptorRegistrationRegistry(registrar)
    const invoked: string[] = []
    const first: InterceptorHandler = async (input) => {
      invoked.push("first")
      return input
    }
    const second: InterceptorHandler = async (input) => {
      invoked.push("second")
      return input
    }

    expect(registry.ensureRegistered({ permissions: USER_PERMISSIONS, handler: first })).toBe(true)
    expect(registry.ensureRegistered({ permissions: USER_PERMISSIONS, handler: second })).toBe(true)
    await calls[0]?.handler(messages, contextFor("user-a", "preset-a"))

    expect(invoked).toEqual(["second"])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.disposed).toBe(0)
  })

  test("runs one registration across authenticated users and presets without cross-scope state", async () => {
    const { registrar, calls } = registrarSeam()
    const registry = new InterceptorRegistrationRegistry(registrar)
    const seen: Array<{ userId: string; presetId: string }> = []
    const handler: InterceptorHandler = async (input, context) => {
      seen.push({ userId: context.userId, presetId: context.presetId ?? "" })
      return input
    }

    expect(registry.ensureRegistered({ permissions: USER_PERMISSIONS, handler })).toBe(true)
    await calls[0]?.handler(messages, contextFor("user-a", "preset-a"))
    await calls[0]?.handler(messages, contextFor("user-a", "preset-b"))
    await calls[0]?.handler(messages, contextFor("user-b", "preset-a"))

    expect(seen).toEqual([
      { userId: "user-a", presetId: "preset-a" },
      { userId: "user-a", presetId: "preset-b" },
      { userId: "user-b", presetId: "preset-a" },
    ])
    expect(calls).toHaveLength(1)
  })

  test("permission revoke removes the registration and regrant creates only one replacement", () => {
    const { registrar, calls } = registrarSeam()
    const registry = new InterceptorRegistrationRegistry(registrar)
    const handler: InterceptorHandler = async (input) => input

    expect(registry.ensureRegistered({ permissions: USER_PERMISSIONS, handler })).toBe(true)
    expect(registry.ensureRegistered({ permissions: ["interceptor"], handler })).toBe(false)
    expect(registry.has()).toBe(false)
    expect(calls[0]?.disposed).toBe(1)

    expect(registry.ensureRegistered({ permissions: USER_PERMISSIONS, handler })).toBe(true)
    expect(registry.ensureRegistered({ permissions: USER_PERMISSIONS, handler })).toBe(true)
    expect(registry.has()).toBe(true)
    expect(calls).toHaveLength(2)
    expect(calls[1]?.disposed).toBe(0)
  })

  test("fails closed when a permission decision throws", () => {
    const { registrar, calls } = registrarSeam()
    const registry = new InterceptorRegistrationRegistry(registrar)
    const handler: InterceptorHandler = async (input) => input
    const throwingPermissions = {
      has: () => {
        throw new Error("permission probe failed")
      },
    }

    expect(registry.ensureRegistered({ permissions: throwingPermissions, handler })).toBe(false)
    expect(registry.has()).toBe(false)
    expect(calls).toHaveLength(0)
  })

  test("invalid or Single preset metadata fails open to native messages", async () => {
    const { registrar, calls } = registrarSeam()
    const registry = new InterceptorRegistrationRegistry(registrar)
    let invoked = 0
    const handler: InterceptorHandler = async (input) => {
      invoked += 1
      return input
    }
    expect(registry.ensureRegistered({ permissions: USER_PERMISSIONS, handler })).toBe(true)

    const invalidMessages = await calls[0]?.handler(messages, contextFor("user-a", "preset-a", null))
    const singleMessages = await calls[0]?.handler(messages, contextFor("user-a", "preset-b", singleConfig()))

    expect(invalidMessages).toBe(messages)
    expect(singleMessages).toBe(messages)
    expect(invoked).toBe(0)
  })

  test("passes the authenticated context and messages unchanged to the current handler", async () => {
    const { registrar, calls } = registrarSeam()
    const registry = new InterceptorRegistrationRegistry(registrar)
    let receivedMessages: LlmMessageDTO[] | undefined
    let receivedContext: InterceptorContextDTO | undefined
    const handler: InterceptorHandler = async (input, context) => {
      receivedMessages = input
      receivedContext = context
      return input
    }
    expect(registry.ensureRegistered({ permissions: USER_PERMISSIONS, handler })).toBe(true)

    const context = contextFor("user-a", "preset-a", sequentialConfig(), "continue")
    const result = await calls[0]?.handler(messages, context)

    expect(result).toBe(messages)
    expect(receivedMessages).toBe(messages)
    expect(receivedContext).toBe(context)
  })

  test("teardown and repeated teardown are idempotent and final", () => {
    const { registrar, calls } = registrarSeam()
    const registry = new InterceptorRegistrationRegistry(registrar)
    const handler: InterceptorHandler = async (input) => input
    expect(registry.ensureRegistered({ permissions: USER_PERMISSIONS, handler })).toBe(true)

    registry.teardown()
    registry.teardown()

    expect(registry.has()).toBe(false)
    expect(calls[0]?.disposed).toBe(1)
    expect(registry.ensureRegistered({ permissions: USER_PERMISSIONS, handler })).toBe(false)
    expect(calls).toHaveLength(1)
  })
})
