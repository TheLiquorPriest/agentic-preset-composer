import type {
  InterceptorContextDTO,
  InterceptorDisposer,
  InterceptorHandler,
  InterceptorMatchDTO,
  InterceptorRegistrationOptions,
} from "lumiverse-spindle-types"
import { decodeApcPresetConfig, type ApcMode, type ApcPresetConfigV1 } from "../config/schema"
import { validateConfigForMode } from "../config/validate"

/** Permission input accepted from the host or from a deterministic test seam. */
export interface ApcPermissionView {
  has(permission: string): boolean
}

export type ApcPermissionSource =
  | readonly string[]
  | ReadonlySet<string>
  | ApcPermissionView
  | ((permission: string) => boolean)

/** The exact host registration method needed by the registry. */
export interface ApcInterceptorRegistrar {
  registerInterceptor(handler: InterceptorHandler, options: InterceptorRegistrationOptions): InterceptorDisposer
}

export interface ApcEnsureRegistrationRequest {
  readonly permissions: ApcPermissionSource
  readonly handler: InterceptorHandler
}

export type ApcRegistrationSkipReason =
  | "closed"
  | "invalid-handler"
  | "missing-permission"
  | "registrar-failed"

export interface ApcEnsureRegistrationAttempt {
  readonly registered: boolean
  readonly reason?: ApcRegistrationSkipReason
}

/**
 * Host match fields are deliberately limited to live terminal routes. Preset
 * identity is authenticated by the host callback context; the APC namespace is
 * decoded again by the wrapper before an extension handler can run.
 */
export const APC_INTERCEPTOR_MATCH: InterceptorMatchDTO = Object.freeze({
  generationTypes: ["normal", "continue"],
  isDryRun: false,
  presetField: {
    path: ["activeMode"],
    exists: true,
    notIn: ["single", 0, false, null],
    oneOf: ["sequential", "parallel"],
  },
} as InterceptorMatchDTO)

const REQUIRED_PERMISSIONS = ["interceptor", "generation"] as const

type ActiveApcConfig = {
  readonly config: ApcPresetConfigV1
  readonly mode: Exclude<ApcMode, "single">
}

interface RegistrationState {
  handler: InterceptorHandler | null
  disposer: InterceptorDisposer | null
  active: boolean
}

function hasPermission(source: unknown, permission: string): boolean {
  try {
    if (typeof source === "function") return source(permission) === true
    if (Array.isArray(source)) return source.includes(permission)
    if (source instanceof Set) return source.has(permission)
    if (typeof source === "object" && source !== null && "has" in source && typeof source.has === "function") {
      return source.has(permission) === true
    }
  } catch {
    // An indeterminate permission decision must never keep the registration live.
  }
  return false
}

function isAuthenticatedContext(context: unknown): context is InterceptorContextDTO {
  if (typeof context !== "object" || context === null || Array.isArray(context)) return false
  if (!("userId" in context) || typeof context.userId !== "string" || context.userId.length === 0) return false
  if (!("presetId" in context) || typeof context.presetId !== "string" || context.presetId.length === 0) return false
  if (!("generationType" in context) || (context.generationType !== "normal" && context.generationType !== "continue")) return false
  if (!("isDryRun" in context) || context.isDryRun !== false) return false
  return true
}

function decodeActiveContextConfig(raw: unknown): ActiveApcConfig | null {
  try {
    const decoded = decodeApcPresetConfig(raw)
    if (decoded.status !== "valid" || decoded.config === null) return null
    const config = decoded.config
    if (config.activeMode !== "sequential" && config.activeMode !== "parallel") return null
    if (!validateConfigForMode(config, config.activeMode).valid) return null
    return { config, mode: config.activeMode }
  } catch {
    return null
  }
}

function isEligibleContext(context: InterceptorContextDTO): boolean {
  try {
    if (!isAuthenticatedContext(context)) return false
    return decodeActiveContextConfig(context.presetMetadata) !== null
  } catch {
    return false
  }
}

function createMatch(): InterceptorMatchDTO {
  return {
    generationTypes: ["normal", "continue"],
    isDryRun: false,
    presetField: {
      path: ["activeMode"],
      exists: true,
      notIn: ["single", 0, false, null],
      oneOf: ["sequential", "parallel"],
    },
  }
}
/**
 * Owns one host interceptor for the whole authenticated APC runtime. The
 * handler pointer changes in place so replacement never creates overlapping
 * host registrations for different presets or users.
 */
export class InterceptorRegistrationRegistry {
  private registration: RegistrationState | null = null
  private closed = false

  public constructor(private readonly registrar: ApcInterceptorRegistrar) {}

  ensureRegistered(request: ApcEnsureRegistrationRequest): boolean {
    const attempt = this.ensureRegisteredAttempt(request)
    return attempt.registered
  }

  ensureRegisteredAttempt(request: ApcEnsureRegistrationRequest): ApcEnsureRegistrationAttempt {
    if (this.closed) return { registered: false, reason: "closed" }
    if (typeof request !== "object" || request === null || typeof request.handler !== "function") {
      this.revoke()
      return { registered: false, reason: "invalid-handler" }
    }
    if (!REQUIRED_PERMISSIONS.every((permission) => hasPermission(request.permissions, permission))) {
      this.revoke()
      return { registered: false, reason: "missing-permission" }
    }

    if (this.registration?.active) {
      this.registration.handler = request.handler
      return { registered: true }
    }

    const state: RegistrationState = {
      handler: request.handler,
      disposer: null,
      active: true,
    }
    const wrappedHandler: InterceptorHandler = async (messages, context) => {
      if (!state.active || state.handler === null || !isEligibleContext(context)) return messages
      try {
        return await state.handler(messages, context)
      } catch {
        return messages
      }
    }

    let disposer: InterceptorDisposer
    try {
      disposer = this.registrar.registerInterceptor(wrappedHandler, { match: createMatch() })
    } catch {
      state.active = false
      state.handler = null
      return { registered: false, reason: "registrar-failed" }
    }
    if (typeof disposer !== "function") {
      state.active = false
      state.handler = null
      return { registered: false, reason: "registrar-failed" }
    }
    state.disposer = disposer
    if (this.closed) {
      this.disposeState(state)
      return { registered: false, reason: "closed" }
    }
    this.registration = state
    return { registered: true }
  }

  revoke(): boolean {
    const state = this.registration
    if (state === null) return false
    this.registration = null
    this.disposeState(state)
    return true
  }

  has(): boolean {
    return this.registration?.active === true && this.closed === false
  }

  teardown(): void {
    if (this.closed) return
    this.closed = true
    const state = this.registration
    this.registration = null
    if (state !== null) this.disposeState(state)
  }

  private disposeState(state: RegistrationState): void {
    if (!state.active) return
    state.active = false
    state.handler = null
    const disposer = state.disposer
    state.disposer = null
    if (disposer === null) return
    try {
      disposer()
    } catch {
      // Cleanup is fail-closed: state is cleared even if the host handle throws.
    }
  }
}

export function createInterceptorRegistrationRegistry(
  registrar: ApcInterceptorRegistrar,
): InterceptorRegistrationRegistry {
  return new InterceptorRegistrationRegistry(registrar)
}
