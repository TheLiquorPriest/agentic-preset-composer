import type {
  LlmMessageDTO,
  PromptBlockDTO,
  PromptVariableValueDTO,
  PromptVariableValuesDTO,
} from "lumiverse-spindle-types"
import type { ApcThreadV1, ApcWorkspaceSource } from "../config/schema"

/** A recursively readonly view used by every invocation-local workspace. */
export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T

export type WorkspaceBlocks = readonly DeepReadonly<PromptBlockDTO>[]
export type WorkspacePromptVariableValues = DeepReadonly<PromptVariableValuesDTO>
export type WorkspaceMainMessages = readonly DeepReadonly<LlmMessageDTO>[]

export interface WorkspaceBase {
  readonly threadId: string
  readonly source: ApcWorkspaceSource
  readonly blocks: WorkspaceBlocks
  readonly promptVariableValues: WorkspacePromptVariableValues
  /** The assembled Main snapshot used by `main-context` threads. */
  readonly mainMessages?: WorkspaceMainMessages
}

export interface WorkspaceSnapshot extends WorkspaceBase {
  readonly runId?: string
}

export interface WorkspaceChanges {
  readonly blocks?: readonly DeepReadonly<PromptBlockDTO>[]
  readonly promptVariableValues?: DeepReadonly<PromptVariableValuesDTO>
  readonly mainMessages?: WorkspaceMainMessages
}

/** Optional seed data for a workspace. */
export type WorkspaceSeed =
  | Readonly<{ readonly mainMessages?: WorkspaceMainMessages }>
  | WorkspaceMainMessages

export type RunWorkspace = WorkspaceSnapshot

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key)

function cloneValue<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (typeof value !== "object" || value === null) return value
  const existing = seen.get(value)
  if (existing !== undefined) return existing as T

  if (Array.isArray(value)) {
    const copy: unknown[] = []
    seen.set(value, copy)
    for (const entry of value) copy.push(cloneValue(entry, seen))
    return copy as T
  }

  const source = value as Record<string, unknown>
  const copy: Record<string, unknown> = {}
  seen.set(value, copy)
  for (const key of Object.keys(source)) {
    Object.defineProperty(copy, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: cloneValue(source[key], seen),
    })
  }
  return copy as T
}

function freezeValue<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null) return value
  if (seen.has(value)) return value
  seen.add(value)
  if (Array.isArray(value)) {
    for (const entry of value) freezeValue(entry, seen)
  } else {
    for (const entry of Object.values(value as Record<string, unknown>)) freezeValue(entry, seen)
  }
  return Object.freeze(value)
}

function cloneAndFreeze<T>(value: T): T {
  return freezeValue(cloneValue(value))
}

function seedMainMessages(seed: WorkspaceSeed | undefined): WorkspaceMainMessages | undefined {
  if (seed === undefined) return undefined
  return Array.isArray(seed)
    ? seed as WorkspaceMainMessages
    : (seed as { readonly mainMessages?: WorkspaceMainMessages }).mainMessages
}

/**
 * Creates the immutable workspace owned by one thread. The input descriptor is
 * cloned before freezing so later editor/config mutations cannot affect a run.
 * Main-context threads must receive the callback's assembled Main snapshot.
 */
export function createBaseWorkspace(
  thread: ApcThreadV1,
  seed?: WorkspaceSeed,
): WorkspaceBase {
  const mainMessages = seedMainMessages(seed)
  if (thread.workspaceSource === "main-context" && mainMessages === undefined) {
    throw new TypeError("Main-context workspace requires an assembled Main snapshot")
  }

  return cloneAndFreeze({
    threadId: thread.id,
    source: thread.workspaceSource,
    blocks: thread.blocks,
    promptVariableValues: thread.promptVariableValues,
    ...(mainMessages === undefined ? {} : { mainMessages }),
  })
}

/** Materializes an immutable snapshot with copy-on-write changed fields. */
export function snapshotWorkspace(
  base: WorkspaceBase | WorkspaceSnapshot,
  changes: WorkspaceChanges = {},
): WorkspaceSnapshot {
  const snapshot: {
    threadId: string
    source: ApcWorkspaceSource
    blocks: WorkspaceBlocks
    promptVariableValues: WorkspacePromptVariableValues
    mainMessages?: WorkspaceMainMessages
    runId?: string
  } = {
    threadId: base.threadId,
    source: base.source,
    blocks: hasOwn(changes, "blocks") && changes.blocks !== undefined
      ? cloneAndFreeze(changes.blocks)
      : base.blocks,
    promptVariableValues:
      hasOwn(changes, "promptVariableValues") && changes.promptVariableValues !== undefined
        ? cloneAndFreeze(changes.promptVariableValues)
        : base.promptVariableValues,
  }

  if (hasOwn(base, "mainMessages")) {
    snapshot.mainMessages = hasOwn(changes, "mainMessages") && changes.mainMessages !== undefined
      ? cloneAndFreeze(changes.mainMessages)
      : base.mainMessages
  } else if (hasOwn(changes, "mainMessages") && changes.mainMessages !== undefined) {
    snapshot.mainMessages = cloneAndFreeze(changes.mainMessages)
  }

  if (hasOwn(base, "runId")) snapshot.runId = (base as WorkspaceSnapshot).runId
  return freezeValue(snapshot)
}

/** Creates an invocation-local copy-on-write workspace for one run. */
export function forkWorkspace(
  base: WorkspaceBase | WorkspaceSnapshot,
  runId?: string,
  changes: WorkspaceChanges = {},
): RunWorkspace {
  const snapshot = snapshotWorkspace(base, changes)
  if (runId === undefined && snapshot.runId === undefined) return snapshot
  if (runId === undefined || runId === snapshot.runId) return snapshot
  return freezeValue({
    ...snapshot,
    runId,
  })
}

/** Creates a detached run workspace directly from a thread descriptor. */
export function createRunWorkspace(
  thread: ApcThreadV1,
  runId: string,
  seed?: WorkspaceSeed,
  changes: WorkspaceChanges = {},
): RunWorkspace {
  if (typeof runId !== "string" || runId.length === 0) {
    throw new TypeError("Run workspace requires a non-empty run ID")
  }
  return forkWorkspace(createBaseWorkspace(thread, seed), runId, changes)
}

/**
 * Converts an immutable snapshot to a detached plain DTO for host assembly.
 * The returned value may be mutated by a host-owned adapter without changing
 * APC state.
 */
export function materializeWorkspace(snapshot: WorkspaceSnapshot): {
  threadId: string
  source: ApcWorkspaceSource
  blocks: PromptBlockDTO[]
  promptVariableValues: PromptVariableValuesDTO
  mainMessages?: LlmMessageDTO[]
  runId?: string
} {
  const result: {
    threadId: string
    source: ApcWorkspaceSource
    blocks: PromptBlockDTO[]
    promptVariableValues: PromptVariableValuesDTO
    mainMessages?: LlmMessageDTO[]
    runId?: string
  } = {
    threadId: snapshot.threadId,
    source: snapshot.source,
    blocks: cloneValue(snapshot.blocks) as PromptBlockDTO[],
    promptVariableValues: cloneValue(snapshot.promptVariableValues) as PromptVariableValuesDTO,
  }
  if (snapshot.mainMessages !== undefined) {
    result.mainMessages = cloneValue(snapshot.mainMessages) as LlmMessageDTO[]
  }
  if (snapshot.runId !== undefined) result.runId = snapshot.runId
  return result
}

export type WorkspaceValue = PromptVariableValueDTO
