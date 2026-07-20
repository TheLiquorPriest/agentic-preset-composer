import type {
  PromptBlockDTO,
  PromptVariableDefDTO,
  PromptVariableValueDTO,
  PromptVariableValuesDTO,
} from "lumiverse-spindle-types"
import { MAX_CONFIG_BYTES } from "./limits"
import {
  serializedUtf8Bytes,
  type PlainJsonErrorCode,
} from "./plain-json"

export const APC_METADATA_KEY = "agentic_preset_composer" as const

export type ApcMode = "single" | "sequential" | "parallel"
export type ApcRole = "system" | "user" | "assistant"
export type ApcMissingPolicy = "fail-graph" | "skip-run" | "omit-binding"
export type ApcWorkspaceSource = "native-blocks" | "main-context"

export interface ApcOutputV1 {
  id: "final"
  name: "Final Response"
}

export interface ApcMainThreadV1 {
  id: "main"
  name: "Main Thread"
  output: ApcOutputV1
}

export interface ApcConnectionSlotHintV1 {
  profileName?: string
  provider?: string
  model?: string
}

export interface ApcConnectionSlotV1 {
  id: string
  label: string
  hint?: ApcConnectionSlotHintV1
}

export interface ApcThreadV1 {
  id: string
  name: string
  description: string
  workspaceSource: ApcWorkspaceSource
  connectionSlotId?: string
  blocks: PromptBlockDTO[]
  promptVariableValues: PromptVariableValuesDTO
  output: ApcOutputV1
}

export interface ApcLiteralInputV1 {
  source: "literal"
  role: ApcRole
  content: string
}

export interface ApcOutputInputV1 {
  source: "output"
  runId: string
  role: ApcRole
  onMissing: ApcMissingPolicy
}

export type ApcInputBindingV1 = ApcLiteralInputV1 | ApcOutputInputV1

export interface ApcRunV1 {
  id: string
  threadId: string
  required: boolean
  timeoutMs: number
  inputs: ApcInputBindingV1[]
}

export interface ApcStageV1 {
  id: string
  name: string
  runs: ApcRunV1[]
}

export interface ApcFinalMainInputV1 {
  source: "output"
  runId: string
  onMissing: "fail-graph" | "omit-binding"
}

export interface ApcFinalMainResponseV1 {
  source: "main"
  inputs: ApcFinalMainInputV1[]
}

export interface ApcFinalThreadResponseV1 {
  source: "thread"
  runId: string
}

export type ApcFinalResponseV1 = ApcFinalMainResponseV1 | ApcFinalThreadResponseV1

export interface ApcPipelineV1 {
  id: string
  stages: ApcStageV1[]
  finalResponse: ApcFinalResponseV1
}

export interface ApcPipelinesV1 {
  sequential?: ApcPipelineV1
  parallel?: ApcPipelineV1
}

export interface ApcPresetConfigV1 {
  schemaVersion: 1
  supportedModes: ApcMode[]
  activeMode: ApcMode
  mainThread: ApcMainThreadV1
  connectionSlots: ApcConnectionSlotV1[]
  threads: ApcThreadV1[]
  pipelines: ApcPipelinesV1
}

export interface ApcIssue {
  path: (string | number)[]
  code: string
  message: string
  mode?: ApcMode
}

export type ApcDecodeStatus = "legacy" | "valid" | "invalid" | "future"

export interface ApcDecodedConfig {
  readonly raw: unknown
  readonly status: ApcDecodeStatus
  readonly config: ApcPresetConfigV1 | null
  readonly issues: readonly ApcIssue[]
  readonly modeIssues: Readonly<Record<ApcMode, readonly ApcIssue[]>>
  readonly future: boolean
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const MODES: readonly ApcMode[] = ["single", "sequential", "parallel"]
const ROLES: readonly ApcRole[] = ["system", "user", "assistant"]
const MISSING_POLICIES: readonly ApcMissingPolicy[] = ["fail-graph", "skip-run", "omit-binding"]
const WORKSPACE_SOURCES: readonly ApcWorkspaceSource[] = ["native-blocks", "main-context"]
const BLOCK_ROLES: readonly PromptBlockDTO["role"][] = [
  "system",
  "user",
  "assistant",
  "user_append",
  "assistant_append",
]
const BLOCK_POSITIONS: readonly PromptBlockDTO["position"][] = [
  "pre_history",
  "post_history",
  "in_history",
]
const VARIABLE_TYPES: readonly PromptVariableDefDTO["type"][] = [
  "text",
  "textarea",
  "number",
  "slider",
  "select",
  "switch",
  "multiselect",
]
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"])

interface DecodeContext {
  issues: ApcIssue[]
  modeIssues: Record<ApcMode, ApcIssue[]>
}

function newModeIssues(): Record<ApcMode, ApcIssue[]> {
  return {
    single: [],
    sequential: [],
    parallel: [],
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value
  seen.add(value)
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen)
  return Object.freeze(value)
}

function decodePath(path: string): (string | number)[] {
  if (path === "$") return []
  const result: (string | number)[] = []
  let offset = 1
  while (offset < path.length) {
    if (path[offset] === ".") {
      const start = offset + 1
      offset = start
      while (offset < path.length && /[A-Za-z0-9_$]/u.test(path[offset] ?? "")) offset += 1
      result.push(path.slice(start, offset))
      continue
    }
    if (path[offset] === "[") {
      const end = path.indexOf("]", offset + 1)
      if (end < 0) return []
      const token = path.slice(offset + 1, end)
      if (/^[0-9]+$/u.test(token)) result.push(Number(token))
      else {
        try {
          const parsed: unknown = JSON.parse(token)
          if (typeof parsed === "string") result.push(parsed)
          else return []
        } catch {
          return []
        }
      }
      offset = end + 1
      continue
    }
    return []
  }
  return result
}

function plainJsonCode(code: PlainJsonErrorCode): string {
  switch (code) {
    case "dangerous-key": return "DANGEROUS_KEY"
    case "cycle": return "CYCLE"
    case "non-finite-number": return "NON_FINITE_NUMBER"
    case "unsupported-type": return "UNSUPPORTED_VALUE"
    case "custom-prototype": return "PLAIN_OBJECT_REQUIRED"
    case "accessor": return "ACCESSOR_PROPERTY"
    case "own-to-json": return "CUSTOM_TO_JSON"
    case "symbol-key": return "UNSAFE_KEY"
    case "sparse-array": return "SPARSE_ARRAY"
    case "non-enumerable-key": return "NON_ENUMERABLE_PROPERTY"
    case "array-property": return "ARRAY_PROPERTY"
    default: return "UNSAFE_OBJECT"
  }
}

function freezeIssue(issue: ApcIssue): ApcIssue {
  return Object.freeze({ ...issue, path: Object.freeze([...issue.path]) }) as unknown as ApcIssue
}

function decoded(
  raw: unknown,
  status: ApcDecodeStatus,
  config: ApcPresetConfigV1 | null,
  context: DecodeContext,
  future: boolean,
): ApcDecodedConfig {
  const modeIssues = {
    single: Object.freeze(context.modeIssues.single.map(freezeIssue)),
    sequential: Object.freeze(context.modeIssues.sequential.map(freezeIssue)),
    parallel: Object.freeze(context.modeIssues.parallel.map(freezeIssue)),
  }
  return Object.freeze({
    raw,
    status,
    config: config === null ? null : deepFreeze(config),
    issues: Object.freeze(context.issues.map(freezeIssue)),
    modeIssues: Object.freeze(modeIssues),
    future,
  })
}

function addIssue(
  context: DecodeContext,
  path: readonly (string | number)[],
  code: string,
  message: string,
  mode?: ApcMode,
): void {
  const issue: ApcIssue = mode === undefined
    ? { path: [...path], code, message }
    : { path: [...path], code, message, mode }
  context.issues.push(issue)
  if (mode !== undefined) context.modeIssues[mode].push(issue)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

function own(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

function scanJsonValue(
  value: unknown,
  path: readonly (string | number)[],
  ancestors: WeakSet<object>,
  context: DecodeContext,
): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") {
    if (Number.isFinite(value)) return true
    addIssue(context, path, "NON_FINITE_NUMBER", "Numbers must be finite")
    return false
  }
  if (value === undefined) {
    addIssue(context, path, "UNSUPPORTED_VALUE", "Undefined is not JSON data")
    return false
  }
  if (typeof value !== "object") {
    addIssue(context, path, "UNSUPPORTED_VALUE", "Only JSON-safe values are accepted")
    return false
  }

  let prototype: object | null
  let keys: (string | symbol)[]
  try {
    prototype = Object.getPrototypeOf(value)
    keys = Reflect.ownKeys(value)
  } catch {
    addIssue(context, path, "UNSAFE_OBJECT", "Object inspection failed")
    return false
  }

  const isArray = Array.isArray(value)
  if (isArray) {
    if (prototype !== Array.prototype) {
      addIssue(context, path, "PLAIN_ARRAY_REQUIRED", "Arrays must use the ordinary Array prototype")
      return false
    }
  } else if (prototype !== Object.prototype && prototype !== null) {
    addIssue(context, path, "PLAIN_OBJECT_REQUIRED", "Objects must be plain records")
    return false
  }

  if (ancestors.has(value)) {
    addIssue(context, path, "CYCLE", "Cyclic values are not executable configuration")
    return false
  }
  ancestors.add(value)
  let valid = true
  try {
    for (const key of keys) {
      if (typeof key !== "string") {
        addIssue(context, path, "UNSAFE_KEY", "Symbol keys are not JSON data")
        valid = false
        continue
      }
      if (isArray && key === "length") continue
      if (DANGEROUS_KEYS.has(key)) {
        addIssue(context, [...path, key], "DANGEROUS_KEY", `Key ${key} is not allowed`)
        valid = false
        continue
      }
      if (key === "toJSON") {
        addIssue(context, [...path, key], "CUSTOM_TO_JSON", "Custom toJSON properties are not allowed")
        valid = false
        continue
      }
      let descriptor: PropertyDescriptor | undefined
      try {
        descriptor = Object.getOwnPropertyDescriptor(value, key)
      } catch {
        addIssue(context, [...path, key], "UNSAFE_PROPERTY", "Property inspection failed")
        valid = false
        continue
      }
      if (descriptor === undefined) {
        addIssue(context, [...path, key], "UNSAFE_PROPERTY", "Property inspection failed")
        valid = false
        continue
      }
      if (descriptor.get !== undefined || descriptor.set !== undefined) {
        addIssue(context, [...path, key], "ACCESSOR_PROPERTY", "Accessor properties are not allowed")
        valid = false
        continue
      }
      if (!descriptor.enumerable) {
        addIssue(context, [...path, key], "NON_ENUMERABLE_PROPERTY", "Only enumerable own properties are accepted")
        valid = false
        continue
      }
      if (!scanJsonValue(descriptor.value, [...path, key], ancestors, context)) valid = false
    }
  } finally {
    ancestors.delete(value)
  }
  return valid
}

function requiredRecord(
  value: unknown,
  path: readonly (string | number)[],
  context: DecodeContext,
  mode?: ApcMode,
): Record<string, unknown> | null {
  if (!isPlainRecord(value)) {
    addIssue(context, path, "OBJECT_REQUIRED", "Expected a plain object", mode)
    return null
  }
  return value
}

function requiredArray(
  value: unknown,
  path: readonly (string | number)[],
  context: DecodeContext,
  mode?: ApcMode,
): unknown[] | null {
  if (!Array.isArray(value)) {
    addIssue(context, path, "ARRAY_REQUIRED", "Expected an array", mode)
    return null
  }
  return value
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
  path: readonly (string | number)[],
  context: DecodeContext,
  mode?: ApcMode,
): string | null {
  if (!own(record, key)) {
    addIssue(context, [...path, key], "MISSING_FIELD", `Missing ${key}`, mode)
    return null
  }
  const value = record[key]
  if (typeof value !== "string") {
    addIssue(context, [...path, key], "STRING_REQUIRED", `${key} must be a string`, mode)
    return null
  }
  return value
}

function requiredNumber(
  record: Record<string, unknown>,
  key: string,
  path: readonly (string | number)[],
  context: DecodeContext,
  mode?: ApcMode,
): number | null {
  if (!own(record, key)) {
    addIssue(context, [...path, key], "MISSING_FIELD", `Missing ${key}`, mode)
    return null
  }
  const value = record[key]
  if (typeof value !== "number" || !Number.isFinite(value)) {
    addIssue(context, [...path, key], "FINITE_NUMBER_REQUIRED", `${key} must be a finite number`, mode)
    return null
  }
  return value
}

function requiredBoolean(
  record: Record<string, unknown>,
  key: string,
  path: readonly (string | number)[],
  context: DecodeContext,
  mode?: ApcMode,
): boolean | null {
  if (!own(record, key)) {
    addIssue(context, [...path, key], "MISSING_FIELD", `Missing ${key}`, mode)
    return null
  }
  const value = record[key]
  if (typeof value !== "boolean") {
    addIssue(context, [...path, key], "BOOLEAN_REQUIRED", `${key} must be a boolean`, mode)
    return null
  }
  return value
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  path: readonly (string | number)[],
  context: DecodeContext,
  mode?: ApcMode,
): string | undefined | null {
  if (!own(record, key)) return undefined
  const value = record[key]
  if (typeof value !== "string") {
    addIssue(context, [...path, key], "STRING_REQUIRED", `${key} must be a string`, mode)
    return null
  }
  return value
}

function requiredStringOrNull(
  record: Record<string, unknown>,
  key: string,
  path: readonly (string | number)[],
  context: DecodeContext,
  mode?: ApcMode,
): string | null | undefined {
  if (!own(record, key)) {
    addIssue(context, [...path, key], "MISSING_FIELD", `Missing ${key}`, mode)
    return undefined
  }
  const value = record[key]
  if (value !== null && typeof value !== "string") {
    addIssue(context, [...path, key], "STRING_OR_NULL_REQUIRED", `${key} must be a string or null`, mode)
    return undefined
  }
  return value
}

function enumValue<T extends string>(
  value: unknown,
  values: readonly T[],
  path: readonly (string | number)[],
  context: DecodeContext,
  mode?: ApcMode,
): T | null {
  if (typeof value === "string" && values.includes(value as T)) return value as T
  addIssue(context, path, "INVALID_ENUM", "Value is not in the supported set", mode)
  return null
}

function requiredEnum<T extends string>(
  record: Record<string, unknown>,
  key: string,
  values: readonly T[],
  path: readonly (string | number)[],
  context: DecodeContext,
  mode?: ApcMode,
): T | null {
  if (!own(record, key)) {
    addIssue(context, [...path, key], "MISSING_FIELD", `Missing ${key}`, mode)
    return null
  }
  return enumValue(record[key], values, [...path, key], context, mode)
}

function generatedId(
  value: unknown,
  path: readonly (string | number)[],
  context: DecodeContext,
  mode?: ApcMode,
): string | null {
  if (typeof value !== "string") {
    addIssue(context, path, "UUID_REQUIRED", "Expected a canonical lowercase UUID", mode)
    return null
  }
  if (value === "main" || value === "final") {
    addIssue(context, path, "RESERVED_ID", `${value} is reserved`, mode)
    return null
  }
  if (!UUID.test(value)) {
    addIssue(context, path, "INVALID_UUID", "Expected a canonical lowercase UUID", mode)
    return null
  }
  return value
}

function fixedString(
  record: Record<string, unknown>,
  key: string,
  expected: string,
  path: readonly (string | number)[],
  context: DecodeContext,
  mode?: ApcMode,
): boolean {
  const value = requiredString(record, key, path, context, mode)
  if (value === null) return false
  if (value !== expected) {
    addIssue(context, [...path, key], "INVALID_FIXED_VALUE", `${key} must be ${expected}`, mode)
    return false
  }
  return true
}

function stringArray(
  value: unknown,
  path: readonly (string | number)[],
  context: DecodeContext,
  mode?: ApcMode,
): string[] | null {
  const values = requiredArray(value, path, context, mode)
  if (values === null) return null
  const result: string[] = []
  let valid = true
  for (let index = 0; index < values.length; index += 1) {
    const item = values[index]
    if (typeof item !== "string") {
      addIssue(context, [...path, index], "STRING_REQUIRED", "Array entries must be strings", mode)
      valid = false
    } else {
      result.push(item)
    }
  }
  return valid ? result : null
}

function promptVariableOption(
  value: unknown,
  path: readonly (string | number)[],
  context: DecodeContext,
): { id: string; label: string; value: string } | null {
  const record = requiredRecord(value, path, context)
  if (record === null) return null
  const id = requiredString(record, "id", path, context)
  const label = requiredString(record, "label", path, context)
  const optionValue = requiredString(record, "value", path, context)
  if (id === null || label === null || optionValue === null) return null
  return { id, label, value: optionValue }
}

function finiteOptionalNumber(
  record: Record<string, unknown>,
  key: string,
  path: readonly (string | number)[],
  context: DecodeContext,
): number | undefined | null {
  if (!own(record, key)) return undefined
  const value = record[key]
  if (typeof value !== "number" || !Number.isFinite(value)) {
    addIssue(context, [...path, key], "FINITE_NUMBER_REQUIRED", `${key} must be a finite number`)
    return null
  }
  return value
}

function promptVariableDefinition(
  value: unknown,
  path: readonly (string | number)[],
  context: DecodeContext,
): PromptVariableDefDTO | null {
  const record = requiredRecord(value, path, context)
  if (record === null) return null
  const id = requiredString(record, "id", path, context)
  const name = requiredString(record, "name", path, context)
  const label = requiredString(record, "label", path, context)
  const type = requiredEnum(record, "type", VARIABLE_TYPES, path, context)
  if (id === null || name === null || label === null || type === null) return null
  const description = optionalString(record, "description", path, context)
  if (description === null) return null

  if (type === "text") {
    const defaultValue = requiredString(record, "defaultValue", path, context)
    if (defaultValue === null) return null
    return description === undefined
      ? { id, name, label, type, defaultValue }
      : { id, name, label, type, defaultValue, description }
  }
  if (type === "textarea") {
    const defaultValue = requiredString(record, "defaultValue", path, context)
    const rows = finiteOptionalNumber(record, "rows", path, context)
    if (defaultValue === null || rows === null) return null
    const result: Extract<PromptVariableDefDTO, { type: "textarea" }> = {
      id,
      name,
      label,
      type,
      defaultValue,
    }
    if (rows !== undefined) result.rows = rows
    if (description !== undefined) result.description = description
    return result
  }
  if (type === "number") {
    const defaultValue = requiredNumber(record, "defaultValue", path, context)
    const min = finiteOptionalNumber(record, "min", path, context)
    const max = finiteOptionalNumber(record, "max", path, context)
    const step = finiteOptionalNumber(record, "step", path, context)
    if (defaultValue === null || min === null || max === null || step === null) return null
    const result: Extract<PromptVariableDefDTO, { type: "number" }> = {
      id,
      name,
      label,
      type,
      defaultValue,
    }
    if (min !== undefined) result.min = min
    if (max !== undefined) result.max = max
    if (step !== undefined) result.step = step
    if (description !== undefined) result.description = description
    return result
  }
  if (type === "slider") {
    const defaultValue = requiredNumber(record, "defaultValue", path, context)
    const min = requiredNumber(record, "min", path, context)
    const max = requiredNumber(record, "max", path, context)
    const step = finiteOptionalNumber(record, "step", path, context)
    if (defaultValue === null || min === null || max === null || step === null) return null
    const result: Extract<PromptVariableDefDTO, { type: "slider" }> = {
      id,
      name,
      label,
      type,
      defaultValue,
      min,
      max,
    }
    if (step !== undefined) result.step = step
    if (description !== undefined) result.description = description
    return result
  }
  if (type === "select" || type === "multiselect") {
    const optionsValue = requiredArray(record["options"], [...path, "options"], context)
    const options: { id: string; label: string; value: string }[] = []
    let valid = optionsValue !== null
    if (optionsValue !== null) {
      for (let index = 0; index < optionsValue.length; index += 1) {
        const option = promptVariableOption(optionsValue[index], [...path, "options", index], context)
        if (option === null) valid = false
        else options.push(option)
      }
    }
    if (!valid) return null
    if (type === "select") {
      const defaultValue = requiredString(record, "defaultValue", path, context)
      if (defaultValue === null) return null
      return description === undefined
        ? { id, name, label, type, defaultValue, options }
        : { id, name, label, type, defaultValue, options, description }
    }
    const defaultValueValue = record["defaultValue"]
    const defaultValue = stringArray(defaultValueValue, [...path, "defaultValue"], context)
    const separator = optionalString(record, "separator", path, context)
    if (defaultValue === null || separator === null) return null
    const result: Extract<PromptVariableDefDTO, { type: "multiselect" }> = {
      id,
      name,
      label,
      type,
      defaultValue,
      options,
    }
    if (separator !== undefined) result.separator = separator
    if (description !== undefined) result.description = description
    return result
  }

  const defaultValue = record["defaultValue"]
  if (defaultValue !== 0 && defaultValue !== 1) {
    addIssue(context, [...path, "defaultValue"], "SWITCH_VALUE_REQUIRED", "switch defaultValue must be 0 or 1")
    return null
  }
  return description === undefined
    ? { id, name, label, type, defaultValue }
    : { id, name, label, type, defaultValue, description }
}

function promptBlock(
  value: unknown,
  path: readonly (string | number)[],
  context: DecodeContext,
): PromptBlockDTO | null {
  const record = requiredRecord(value, path, context)
  if (record === null) return null
  const id = requiredString(record, "id", path, context)
  const name = requiredString(record, "name", path, context)
  const content = requiredString(record, "content", path, context)
  const role = requiredEnum(record, "role", BLOCK_ROLES, path, context)
  const enabled = requiredBoolean(record, "enabled", path, context)
  const position = requiredEnum(record, "position", BLOCK_POSITIONS, path, context)
  const depth = requiredNumber(record, "depth", path, context)
  const marker = requiredStringOrNull(record, "marker", path, context)
  const isLocked = requiredBoolean(record, "isLocked", path, context)
  const color = requiredStringOrNull(record, "color", path, context)
  const injectionTrigger = stringArray(record["injectionTrigger"], [...path, "injectionTrigger"], context)
  const group = requiredStringOrNull(record, "group", path, context)
  if (
    id === null ||
    name === null ||
    content === null ||
    role === null ||
    enabled === null ||
    position === null ||
    depth === null ||
    marker === undefined ||
    isLocked === null ||
    color === undefined ||
    injectionTrigger === null ||
    group === undefined
  ) return null

  const result: PromptBlockDTO = {
    id,
    name,
    content,
    role,
    enabled,
    position,
    depth,
    marker,
    isLocked,
    color,
    injectionTrigger,
    group,
  }
  if (own(record, "characterTagTrigger")) {
    const characterTagTrigger = stringArray(record["characterTagTrigger"], [...path, "characterTagTrigger"], context)
    if (characterTagTrigger === null) return null
    result.characterTagTrigger = characterTagTrigger
  }
  if (own(record, "categoryMode")) {
    const categoryMode = record["categoryMode"]
    if (categoryMode !== null && categoryMode !== "radio" && categoryMode !== "checkbox") {
      addIssue(context, [...path, "categoryMode"], "INVALID_ENUM", "categoryMode must be radio, checkbox, or null")
      return null
    }
    result.categoryMode = categoryMode
  }
  if (own(record, "variables")) {
    const values = requiredArray(record["variables"], [...path, "variables"], context)
    if (values === null) return null
    const variables: PromptVariableDefDTO[] = []
    let valid = true
    for (let index = 0; index < values.length; index += 1) {
      const variable = promptVariableDefinition(values[index], [...path, "variables", index], context)
      if (variable === null) valid = false
      else variables.push(variable)
    }
    if (!valid) return null
    result.variables = variables
  }
  return result
}

function promptVariableValues(
  value: unknown,
  path: readonly (string | number)[],
  context: DecodeContext,
): PromptVariableValuesDTO | null {
  const record = requiredRecord(value, path, context)
  if (record === null) return null
  const result: PromptVariableValuesDTO = {}
  for (const [blockId, blockValue] of Object.entries(record)) {
    const blockRecord = requiredRecord(blockValue, [...path, blockId], context)
    if (blockRecord === null) return null
    const values: Record<string, PromptVariableValueDTO> = {}
    for (const [name, item] of Object.entries(blockRecord)) {
      if (typeof item === "string") {
        values[name] = item
      } else if (typeof item === "number" && Number.isFinite(item)) {
        values[name] = item
      } else if (Array.isArray(item)) {
        const strings = stringArray(item, [...path, blockId, name], context)
        if (strings === null) return null
        values[name] = strings
      } else {
        addIssue(context, [...path, blockId, name], "PROMPT_VALUE_REQUIRED", "Prompt variable values must be strings, finite numbers, or string arrays")
        return null
      }
    }
    result[blockId] = values
  }
  return result
}

function output(value: unknown, path: readonly (string | number)[], context: DecodeContext, mode?: ApcMode): ApcOutputV1 | null {
  const record = requiredRecord(value, path, context, mode)
  if (record === null) return null
  const id = fixedString(record, "id", "final", path, context, mode)
  const name = fixedString(record, "name", "Final Response", path, context, mode)
  return id && name ? { id: "final", name: "Final Response" } : null
}

function mainThread(value: unknown, path: readonly (string | number)[], context: DecodeContext): ApcMainThreadV1 | null {
  const record = requiredRecord(value, path, context)
  if (record === null) return null
  const id = fixedString(record, "id", "main", path, context)
  const name = fixedString(record, "name", "Main Thread", path, context)
  const threadOutput = output(record["output"], [...path, "output"], context)
  return id && name && threadOutput !== null
    ? { id: "main", name: "Main Thread", output: threadOutput }
    : null
}

function connectionSlot(value: unknown, path: readonly (string | number)[], context: DecodeContext): ApcConnectionSlotV1 | null {
  const record = requiredRecord(value, path, context)
  if (record === null) return null
  const id = generatedId(record["id"], [...path, "id"], context)
  const label = requiredString(record, "label", path, context)
  if (id === null || label === null) return null
  const result: ApcConnectionSlotV1 = { id, label }
  if (own(record, "hint")) {
    const hintRecord = requiredRecord(record["hint"], [...path, "hint"], context)
    if (hintRecord === null) return null
    const profileName = optionalString(hintRecord, "profileName", [...path, "hint"], context)
    const provider = optionalString(hintRecord, "provider", [...path, "hint"], context)
    const model = optionalString(hintRecord, "model", [...path, "hint"], context)
    if (profileName === null || provider === null || model === null) return null
    const hint: ApcConnectionSlotHintV1 = {}
    if (profileName !== undefined) hint.profileName = profileName
    if (provider !== undefined) hint.provider = provider
    if (model !== undefined) hint.model = model
    result.hint = hint
  }
  return result
}

function thread(value: unknown, path: readonly (string | number)[], context: DecodeContext): ApcThreadV1 | null {
  const record = requiredRecord(value, path, context)
  if (record === null) return null
  const id = generatedId(record["id"], [...path, "id"], context)
  const name = requiredString(record, "name", path, context)
  const description = requiredString(record, "description", path, context)
  const workspaceSource = requiredEnum(record, "workspaceSource", WORKSPACE_SOURCES, path, context)
  const blocksValue = requiredArray(record["blocks"], [...path, "blocks"], context)
  const promptValues = promptVariableValues(record["promptVariableValues"], [...path, "promptVariableValues"], context)
  const threadOutput = output(record["output"], [...path, "output"], context)
  if (id === null || name === null || description === null || workspaceSource === null || blocksValue === null || promptValues === null || threadOutput === null) return null

  const blocks: PromptBlockDTO[] = []
  let valid = true
  for (let index = 0; index < blocksValue.length; index += 1) {
    const block = promptBlock(blocksValue[index], [...path, "blocks", index], context)
    if (block === null) valid = false
    else blocks.push(block)
  }
  if (!valid) return null

  const result: ApcThreadV1 = {
    id,
    name,
    description,
    workspaceSource,
    blocks,
    promptVariableValues: promptValues,
    output: threadOutput,
  }
  if (own(record, "connectionSlotId")) {
    const connectionSlotId = generatedId(record["connectionSlotId"], [...path, "connectionSlotId"], context)
    if (connectionSlotId === null) return null
    result.connectionSlotId = connectionSlotId
  }
  return result
}

function role(value: unknown, path: readonly (string | number)[], context: DecodeContext, mode: ApcMode): ApcRole | null {
  return enumValue(value, ROLES, path, context, mode)
}

function missingPolicy(value: unknown, path: readonly (string | number)[], context: DecodeContext, mode: ApcMode): ApcMissingPolicy | null {
  return enumValue(value, MISSING_POLICIES, path, context, mode)
}

function inputBinding(value: unknown, path: readonly (string | number)[], context: DecodeContext, mode: ApcMode): ApcInputBindingV1 | null {
  const record = requiredRecord(value, path, context, mode)
  if (record === null) return null
  const source = requiredString(record, "source", path, context, mode)
  if (source === null) return null
  if (source === "literal") {
    const inputRole = role(record["role"], [...path, "role"], context, mode)
    const content = requiredString(record, "content", path, context, mode)
    return inputRole === null || content === null ? null : { source: "literal", role: inputRole, content }
  }
  if (source === "output") {
    const runId = generatedId(record["runId"], [...path, "runId"], context, mode)
    const inputRole = role(record["role"], [...path, "role"], context, mode)
    const onMissing = missingPolicy(record["onMissing"], [...path, "onMissing"], context, mode)
    return runId === null || inputRole === null || onMissing === null
      ? null
      : { source: "output", runId, role: inputRole, onMissing }
  }
  addIssue(context, [...path, "source"], "INVALID_ENUM", "source must be literal or output", mode)
  return null
}

function run(value: unknown, path: readonly (string | number)[], context: DecodeContext, mode: ApcMode): ApcRunV1 | null {
  const record = requiredRecord(value, path, context, mode)
  if (record === null) return null
  const id = generatedId(record["id"], [...path, "id"], context, mode)
  const threadId = generatedId(record["threadId"], [...path, "threadId"], context, mode)
  const required = requiredBoolean(record, "required", path, context, mode)
  const timeoutMs = requiredNumber(record, "timeoutMs", path, context, mode)
  const inputsValue = requiredArray(record["inputs"], [...path, "inputs"], context, mode)
  if (id === null || threadId === null || required === null || timeoutMs === null || inputsValue === null) return null
  const inputs: ApcInputBindingV1[] = []
  let valid = true
  for (let index = 0; index < inputsValue.length; index += 1) {
    const input = inputBinding(inputsValue[index], [...path, "inputs", index], context, mode)
    if (input === null) valid = false
    else inputs.push(input)
  }
  return valid ? { id, threadId, required, timeoutMs, inputs } : null
}

function stage(value: unknown, path: readonly (string | number)[], context: DecodeContext, mode: ApcMode): ApcStageV1 | null {
  const record = requiredRecord(value, path, context, mode)
  if (record === null) return null
  const id = generatedId(record["id"], [...path, "id"], context, mode)
  const name = requiredString(record, "name", path, context, mode)
  const runsValue = requiredArray(record["runs"], [...path, "runs"], context, mode)
  if (id === null || name === null || runsValue === null) return null
  const runs: ApcRunV1[] = []
  let valid = true
  for (let index = 0; index < runsValue.length; index += 1) {
    const parsed = run(runsValue[index], [...path, "runs", index], context, mode)
    if (parsed === null) valid = false
    else runs.push(parsed)
  }
  return valid ? { id, name, runs } : null
}

function finalMainInput(value: unknown, path: readonly (string | number)[], context: DecodeContext, mode: ApcMode): ApcFinalMainInputV1 | null {
  const record = requiredRecord(value, path, context, mode)
  if (record === null) return null
  const source = requiredString(record, "source", path, context, mode)
  const runId = generatedId(record["runId"], [...path, "runId"], context, mode)
  const onMissingValue = requiredString(record, "onMissing", path, context, mode)
  if (source === null || runId === null || onMissingValue === null) return null
  if (source !== "output") {
    addIssue(context, [...path, "source"], "INVALID_ENUM", "source must be output", mode)
    return null
  }
  if (onMissingValue !== "fail-graph" && onMissingValue !== "omit-binding") {
    addIssue(context, [...path, "onMissing"], "INVALID_ENUM", "Final main input onMissing must be fail-graph or omit-binding", mode)
    return null
  }
  return { source: "output", runId, onMissing: onMissingValue }
}

function finalResponse(value: unknown, path: readonly (string | number)[], context: DecodeContext, mode: ApcMode): ApcFinalResponseV1 | null {
  const record = requiredRecord(value, path, context, mode)
  if (record === null) return null
  const source = requiredString(record, "source", path, context, mode)
  if (source === null) return null
  if (source === "main") {
    const values = requiredArray(record["inputs"], [...path, "inputs"], context, mode)
    if (values === null) return null
    const inputs: ApcFinalMainInputV1[] = []
    let valid = true
    for (let index = 0; index < values.length; index += 1) {
      const input = finalMainInput(values[index], [...path, "inputs", index], context, mode)
      if (input === null) valid = false
      else inputs.push(input)
    }
    return valid ? { source: "main", inputs } : null
  }
  if (source === "thread") {
    const runId = generatedId(record["runId"], [...path, "runId"], context, mode)
    return runId === null ? null : { source: "thread", runId }
  }
  addIssue(context, [...path, "source"], "INVALID_ENUM", "source must be main or thread", mode)
  return null
}

function pipeline(value: unknown, path: readonly (string | number)[], context: DecodeContext, mode: ApcMode): ApcPipelineV1 | null {
  const record = requiredRecord(value, path, context, mode)
  if (record === null) return null
  const id = generatedId(record["id"], [...path, "id"], context, mode)
  const stagesValue = requiredArray(record["stages"], [...path, "stages"], context, mode)
  const final = finalResponse(record["finalResponse"], [...path, "finalResponse"], context, mode)
  if (id === null || stagesValue === null || final === null) return null
  const stages: ApcStageV1[] = []
  let valid = true
  for (let index = 0; index < stagesValue.length; index += 1) {
    const parsed = stage(stagesValue[index], [...path, "stages", index], context, mode)
    if (parsed === null) valid = false
    else stages.push(parsed)
  }
  return valid ? { id, stages, finalResponse: final } : null
}

function parseConfig(raw: Record<string, unknown>, context: DecodeContext): { config: ApcPresetConfigV1 | null; activeValid: boolean; sharedValid: boolean } {
  let sharedValid = true
  const supportedModesValue = requiredArray(raw["supportedModes"], ["supportedModes"], context)
  const supportedModes: ApcMode[] = []
  if (supportedModesValue === null) {
    sharedValid = false
  } else {
    for (let index = 0; index < supportedModesValue.length; index += 1) {
      const mode = enumValue(supportedModesValue[index], MODES, ["supportedModes", index], context)
      if (mode === null) sharedValid = false
      else supportedModes.push(mode)
    }
  }
  const activeMode = own(raw, "activeMode")
    ? enumValue(raw["activeMode"], MODES, ["activeMode"], context)
    : (addIssue(context, ["activeMode"], "MISSING_FIELD", "Missing activeMode"), null)
  if (activeMode === null) sharedValid = false

  const parsedMainThread = mainThread(raw["mainThread"], ["mainThread"], context)
  if (parsedMainThread === null) sharedValid = false

  const slotsValue = requiredArray(raw["connectionSlots"], ["connectionSlots"], context)
  const connectionSlots: ApcConnectionSlotV1[] = []
  if (slotsValue === null) {
    sharedValid = false
  } else {
    for (let index = 0; index < slotsValue.length; index += 1) {
      const slot = connectionSlot(slotsValue[index], ["connectionSlots", index], context)
      if (slot === null) sharedValid = false
      else connectionSlots.push(slot)
    }
  }

  const threadsValue = requiredArray(raw["threads"], ["threads"], context)
  const threads: ApcThreadV1[] = []
  if (threadsValue === null) {
    sharedValid = false
  } else {
    for (let index = 0; index < threadsValue.length; index += 1) {
      const parsed = thread(threadsValue[index], ["threads", index], context)
      if (parsed === null) sharedValid = false
      else threads.push(parsed)
    }
  }

  const pipelinesRecord = requiredRecord(raw["pipelines"], ["pipelines"], context)
  if (pipelinesRecord === null) sharedValid = false
  const pipelines: ApcPipelinesV1 = {}
  let activeValid = activeMode !== null
  if (pipelinesRecord !== null) {
    for (const mode of ["sequential", "parallel"] as const) {
      if (!own(pipelinesRecord, mode)) continue
      const parsed = pipeline(pipelinesRecord[mode], ["pipelines", mode], context, mode)
      if (parsed === null) {
        if (activeMode === mode) activeValid = false
      } else {
        pipelines[mode] = parsed
      }
    }
    if (activeMode === "sequential" && !own(pipelines, "sequential")) {
      addIssue(context, ["pipelines", "sequential"], "ACTIVE_PIPELINE_REQUIRED", "The active sequential mode requires a valid pipeline", activeMode)
      activeValid = false
    }
    if (activeMode === "parallel" && !own(pipelines, "parallel")) {
      addIssue(context, ["pipelines", "parallel"], "ACTIVE_PIPELINE_REQUIRED", "The active parallel mode requires a valid pipeline", activeMode)
      activeValid = false
    }
  } else if (activeMode === "sequential" || activeMode === "parallel") {
    addIssue(context, ["pipelines"], "ACTIVE_PIPELINE_REQUIRED", "The active mode requires pipelines", activeMode)
    activeValid = false
  }

  if (!sharedValid || !activeValid || parsedMainThread === null || activeMode === null) {
    return { config: null, activeValid, sharedValid }
  }
  return {
    config: {
      schemaVersion: 1,
      supportedModes,
      activeMode,
      mainThread: parsedMainThread,
      connectionSlots,
      threads,
      pipelines,
    },
    activeValid,
    sharedValid,
  }
}

export function createDefaultApcConfig(): ApcPresetConfigV1 {
  return {
    schemaVersion: 1,
    supportedModes: ["single"],
    activeMode: "single",
    mainThread: {
      id: "main",
      name: "Main Thread",
      output: { id: "final", name: "Final Response" },
    },
    connectionSlots: [],
    threads: [],
    pipelines: {},
  }
}

export function decodeApcPresetConfig(raw: unknown): ApcDecodedConfig {
  const context: DecodeContext = { issues: [], modeIssues: newModeIssues() }
  if (raw === undefined || raw === null) {
    return decoded(raw, "legacy", createDefaultApcConfig(), context, false)
  }

  const serialized = serializedUtf8Bytes(raw)
  if (!serialized.ok) {
    addIssue(
      context,
      decodePath(serialized.error.path),
      plainJsonCode(serialized.error.code),
      serialized.error.message,
    )
    return decoded(raw, "invalid", null, context, false)
  }
  if (serialized.bytes > MAX_CONFIG_BYTES) {
    addIssue(context, [], "CONFIG_LIMIT", `Configuration exceeds ${MAX_CONFIG_BYTES} UTF-8 bytes.`)
    return decoded(raw, "invalid", null, context, false)
  }

  const envelope = requiredRecord(raw, [], context)
  if (envelope === null) return decoded(raw, "invalid", null, context, false)

  if (!own(envelope, "schemaVersion")) {
    addIssue(context, ["schemaVersion"], "SCHEMA_VERSION_REQUIRED", "schemaVersion 1 is required")
    return decoded(raw, "invalid", null, context, false)
  }
  const schemaVersion = envelope["schemaVersion"]
  if (typeof schemaVersion !== "number" || !Number.isFinite(schemaVersion)) {
    addIssue(context, ["schemaVersion"], "SCHEMA_VERSION_TYPE", "schemaVersion must be a finite number")
    return decoded(raw, "invalid", null, context, false)
  }
  if (schemaVersion !== 1) return decoded(raw, "future", null, context, true)

  const parsed = parseConfig(envelope, context)
  return decoded(raw, parsed.config === null ? "invalid" : "valid", parsed.config, context, false)
}
