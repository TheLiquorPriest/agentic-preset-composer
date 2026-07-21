import type {
  ApcIssue,
  ApcMode,
  ApcPresetConfigV1,
} from "./schema"
import {
  GRAPH_DEADLINE_MS,
  MAX_BINDINGS_PER_RUN,
  MAX_BLOCKS_PER_THREAD,
  MAX_BLOCK_CONTENT_BYTES,
  MAX_CONFIG_BYTES,
  MAX_CONNECTION_SLOTS,
  MAX_DESCRIPTION_BYTES,
  MAX_FINAL_INPUTS,
  MAX_GUIDANCE_BYTES,
  MAX_LITERAL_BYTES,
  MAX_NAME_CHARS,
  MAX_PARALLEL_WIDTH,
  MAX_RUNS_PER_PIPELINE,
  MAX_STAGES_PER_PIPELINE,
  MAX_THREADS,
  MAX_WORKSPACE_BYTES,
  MAX_RUN_TIMEOUT_MS,
  MIN_RUN_TIMEOUT_MS,
  characterCount,
  utf8Bytes,
} from "./limits"
import { serializedUtf8Bytes } from "./plain-json"

const MODES = ["single", "sequential", "parallel"] as const
const ROLES = ["system", "user", "assistant"] as const
const MISSING_POLICIES = ["fail-graph", "skip-run", "omit-binding"] as const
const FINAL_MISSING_POLICIES = ["fail-graph", "omit-binding"] as const
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const INVALID_LABEL_CHARACTERS = /[\u0000-\u001f\u007f\n\r]/u
const MISSING = Symbol("missing")

type PathPart = string | number
type Path = readonly PathPart[]
type ModeIssue = ApcMode | undefined

interface RunInfo {
  readonly id: string
  readonly path: Path
  readonly stageIndex: number
  readonly required: boolean
}

interface OutputReference {
  readonly sourceRunId: string
  readonly path: Path
  readonly policy: string | undefined
  readonly fromRunId: string | undefined
  readonly stageIndex: number | undefined
  readonly isFinal: boolean
}

interface PipelineValidation {
  readonly reachableRunIds: ReadonlySet<string>
}

export interface ApcValidationResult {
  valid: boolean
  issues: ApcIssue[]
  reachableRunIds: ReadonlySet<string>
}

export interface ApcModeAvailability {
  supported: boolean
  valid: boolean
  disabledReason?: string
}

export type ApcModeAvailabilityMap = Readonly<Record<ApcMode, ApcModeAvailability>>

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false
  }
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

function isPlainArray(value: unknown): value is readonly unknown[] {
  if (!Array.isArray(value)) {
    return false
  }
  try {
    return Object.getPrototypeOf(value) === Array.prototype
  } catch {
    return false
  }
}

function ownValue(record: Record<string, unknown>, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key)
    if (!descriptor || !("value" in descriptor)) {
      return MISSING
    }
    return descriptor.value
  } catch {
    return MISSING
  }
}

function arrayValue(values: readonly unknown[], index: number): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(values, String(index))
    if (!descriptor || !("value" in descriptor)) {
      return MISSING
    }
    return descriptor.value
  } catch {
    return MISSING
  }
}

function addIssue(
  issues: ApcIssue[],
  path: Path,
  code: string,
  message: string,
  mode?: ModeIssue,
): void {
  const issue: ApcIssue = { path: [...path], code, message }
  if (mode !== undefined) {
    issue.mode = mode
  }
  issues.push(issue)
}

function encodedPath(path: Path): string {
  return path
    .map((part) => (typeof part === "number" ? `[${part}]` : `.${part.replaceAll(".", "..")}`))
    .join("")
}

function compareIssues(left: ApcIssue, right: ApcIssue): number {
  const leftPath = encodedPath(left.path)
  const rightPath = encodedPath(right.path)
  if (leftPath < rightPath) return -1
  if (leftPath > rightPath) return 1
  if (left.code < right.code) return -1
  if (left.code > right.code) return 1
  const leftMode = left.mode ?? ""
  const rightMode = right.mode ?? ""
  if (leftMode < rightMode) return -1
  if (leftMode > rightMode) return 1
  return left.message < right.message ? -1 : left.message > right.message ? 1 : 0
}

function finish(issues: ApcIssue[], reachableRunIds: ReadonlySet<string>): ApcValidationResult {
  const sorted = [...issues].sort(compareIssues)
  const unique: ApcIssue[] = []
  let previous: ApcIssue | undefined
  for (const issue of sorted) {
    if (
      previous &&
      encodedPath(previous.path) === encodedPath(issue.path) &&
      previous.code === issue.code &&
      previous.mode === issue.mode &&
      previous.message === issue.message
    ) {
      continue
    }
    const copy: ApcIssue = {
      path: [...issue.path],
      code: issue.code,
      message: issue.message,
    }
    if (issue.mode !== undefined) copy.mode = issue.mode
    unique.push(copy)
    previous = issue
  }
  return { valid: unique.length === 0, issues: unique, reachableRunIds }
}

function checkLabel(
  value: unknown,
  path: Path,
  issues: ApcIssue[],
  mode?: ModeIssue,
): value is string {
  if (typeof value !== "string") {
    addIssue(issues, path, "TEXT_TYPE", "Expected text.", mode)
    return false
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    addIssue(issues, path, "TEXT_EMPTY", "Text must not be empty.", mode)
  }
  if (characterCount(trimmed) > MAX_NAME_CHARS) {
    addIssue(issues, path, "NAME_LIMIT", `Text exceeds ${MAX_NAME_CHARS} characters.`, mode)
  }
  if (INVALID_LABEL_CHARACTERS.test(value)) {
    addIssue(issues, path, "TEXT_CONTROL", "Text contains a control character or newline.", mode)
  }
  return true
}

function checkDescription(
  value: unknown,
  path: Path,
  issues: ApcIssue[],
  mode?: ModeIssue,
): value is string {
  if (typeof value !== "string") {
    addIssue(issues, path, "DESCRIPTION_TYPE", "Expected a description string.", mode)
    return false
  }
  if (utf8Bytes(value) > MAX_DESCRIPTION_BYTES) {
    addIssue(issues, path, "DESCRIPTION_LIMIT", `Description exceeds ${MAX_DESCRIPTION_BYTES} UTF-8 bytes.`, mode)
  }
  return true
}

function checkGeneratedId(
  value: unknown,
  path: Path,
  issues: ApcIssue[],
  mode?: ModeIssue,
): value is string {
  if (typeof value !== "string") {
    addIssue(issues, path, "ID_CANONICAL", "Expected a lowercase canonical UUID.", mode)
    return false
  }
  if (value === "main" || value === "final" || value === "__proto__" || value === "prototype" || value === "constructor") {
    addIssue(issues, path, "ID_RESERVED", "Reserved or dangerous IDs are not allowed.", mode)
    return false
  }
  if (!UUID_PATTERN.test(value)) {
    addIssue(issues, path, "ID_CANONICAL", "Expected a lowercase canonical UUID.", mode)
    return false
  }
  return true
}

function checkReservedId(
  value: unknown,
  expected: string,
  path: Path,
  issues: ApcIssue[],
  mode?: ModeIssue,
): value is string {
  if (value !== expected) {
    addIssue(issues, path, "ID_RESERVED", `Expected reserved ID ${expected}.`, mode)
    return false
  }
  return true
}

function checkRole(value: unknown, path: Path, issues: ApcIssue[], mode?: ModeIssue): boolean {
  if (typeof value !== "string" || !ROLES.some((role) => role === value)) {
    addIssue(issues, path, "ROLE_INVALID", "Expected system, user, or assistant.", mode)
    return false
  }
  return true
}

function checkMode(value: unknown, path: Path, issues: ApcIssue[]): value is ApcMode {
  if (typeof value !== "string" || !MODES.some((candidate) => candidate === value)) {
    addIssue(issues, path, "MODE_INVALID", "Expected a supported APC mode.")
    return false
  }
  return true
}

function checkSerializedLimit(
  value: unknown,
  path: Path,
  maxBytes: number,
  code: string,
  message: string,
  issues: ApcIssue[],
  mode?: ModeIssue,
): boolean {
  const serialized = serializedUtf8Bytes(value)
  if (!serialized.ok) {
    addIssue(issues, path, serialized.error.code, serialized.error.message, mode)
    return false
  }
  if (serialized.bytes > maxBytes) {
    addIssue(issues, path, code, message, mode)
    return false
  }
  return true
}

function checkArray(
  value: unknown,
  path: Path,
  max: number,
  limitCode: string,
  issues: ApcIssue[],
  mode?: ModeIssue,
): readonly unknown[] | null {
  if (!isPlainArray(value)) {
    addIssue(issues, path, "COLLECTION_TYPE", "Expected a plain array.", mode)
    return null
  }
  if (value.length > max) {
    addIssue(issues, path, limitCode, `Collection exceeds its limit of ${max}.`, mode)
  }
  return value
}
function checkLiteral(
  value: unknown,
  path: Path,
  issues: ApcIssue[],
  mode?: ModeIssue,
): value is string {
  if (typeof value !== "string") {
    addIssue(issues, path, "LITERAL_TYPE", "Expected literal text.", mode)
    return false
  }
  if (utf8Bytes(value) > MAX_LITERAL_BYTES) {
    addIssue(issues, path, "LITERAL_LIMIT", `Literal exceeds ${MAX_LITERAL_BYTES} UTF-8 bytes.`, mode)
  }
  return true
}

function validatePromptStringArray(
  value: unknown,
  path: Path,
  issues: ApcIssue[],
  mode?: ModeIssue,
): void {
  const values = checkArray(value, path, MAX_BLOCKS_PER_THREAD, "PROMPT_ARRAY_LIMIT", issues, mode)
  if (!values || values.length > MAX_BLOCKS_PER_THREAD) return
  for (let index = 0; index < values.length; index += 1) {
    checkLiteral(arrayValue(values, index), [...path, index], issues, mode)
  }
}

function validatePromptVariableDefinition(
  value: unknown,
  path: Path,
  issues: ApcIssue[],
  mode?: ModeIssue,
): void {
  if (!isPlainRecord(value)) {
    addIssue(issues, path, "VARIABLE_TYPE", "Expected a plain prompt variable definition.", mode)
    return
  }
  checkLabel(ownValue(value, "id"), [...path, "id"], issues, mode)
  checkLabel(ownValue(value, "name"), [...path, "name"], issues, mode)
  checkLabel(ownValue(value, "label"), [...path, "label"], issues, mode)
  const description = ownValue(value, "description")
  if (description !== MISSING && description !== undefined) checkDescription(description, [...path, "description"], issues, mode)
  const type = ownValue(value, "type")
  if (type === "text" || type === "textarea") {
    checkLiteral(ownValue(value, "defaultValue"), [...path, "defaultValue"], issues, mode)
    return
  }
  if (type === "number") {
    const defaultValue = ownValue(value, "defaultValue")
    if (typeof defaultValue !== "number" || !Number.isFinite(defaultValue)) {
      addIssue(issues, [...path, "defaultValue"], "FINITE_NUMBER_REQUIRED", "Expected a finite number.", mode)
    }
    return
  }
  if (type === "slider") {
    for (const key of ["defaultValue", "min", "max"] as const) {
      const field = ownValue(value, key)
      if (typeof field !== "number" || !Number.isFinite(field)) {
        addIssue(issues, [...path, key], "FINITE_NUMBER_REQUIRED", "Expected a finite number.", mode)
      }
    }
    return
  }
  if (type === "select" || type === "multiselect") {
    const options = checkArray(
      ownValue(value, "options"),
      [...path, "options"],
      MAX_BLOCKS_PER_THREAD,
      "PROMPT_OPTIONS_LIMIT",
      issues,
      mode,
    )
    if (options) {
      if (options.length > MAX_BLOCKS_PER_THREAD) {
        return
      }
      for (let index = 0; index < options.length; index += 1) {
        const optionPath: Path = [...path, "options", index]
        const option = arrayValue(options, index)
        if (!isPlainRecord(option)) {
          addIssue(issues, optionPath, "OPTION_TYPE", "Expected a plain prompt option.", mode)
          continue
        }
        checkLabel(ownValue(option, "id"), [...optionPath, "id"], issues, mode)
        checkLabel(ownValue(option, "label"), [...optionPath, "label"], issues, mode)
        checkLiteral(ownValue(option, "value"), [...optionPath, "value"], issues, mode)
      }
    }
    if (type === "select") {
      checkLiteral(ownValue(value, "defaultValue"), [...path, "defaultValue"], issues, mode)
    } else {
      validatePromptStringArray(ownValue(value, "defaultValue"), [...path, "defaultValue"], issues, mode)
    }
    const separator = ownValue(value, "separator")
    if (separator !== MISSING && separator !== undefined) checkLiteral(separator, [...path, "separator"], issues, mode)
    return
  }
  if (type === "switch") {
    const defaultValue = ownValue(value, "defaultValue")
    if (defaultValue !== 0 && defaultValue !== 1) {
      addIssue(issues, [...path, "defaultValue"], "SWITCH_VALUE_REQUIRED", "switch defaultValue must be 0 or 1", mode)
    }
    return
  }
  addIssue(issues, [...path, "type"], "VARIABLE_TYPE", "Expected a supported prompt variable type.", mode)
}

function validateHint(
  value: unknown,
  path: Path,
  issues: ApcIssue[],
  mode?: ModeIssue,
): void {
  if (!isPlainRecord(value)) {
    addIssue(issues, path, "HINT_TYPE", "Expected a plain hint object.", mode)
    return
  }
  for (const key of ["profileName", "provider", "model"] as const) {
    const field = ownValue(value, key)
    if (field !== MISSING) checkLabel(field, [...path, key], issues, mode)
  }
}

function validateBlock(
  value: unknown,
  path: Path,
  issues: ApcIssue[],
  mode?: ModeIssue,
): void {
  if (!isPlainRecord(value)) {
    addIssue(issues, path, "BLOCK_TYPE", "Expected a plain prompt block.", mode)
    return
  }
  checkLabel(ownValue(value, "id"), [...path, "id"], issues, mode)
  checkLabel(ownValue(value, "name"), [...path, "name"], issues, mode)
  const content = ownValue(value, "content")
  if (typeof content !== "string") {
    addIssue(issues, [...path, "content"], "BLOCK_CONTENT_TYPE", "Expected block content text.", mode)
  } else if (utf8Bytes(content) > MAX_BLOCK_CONTENT_BYTES) {
    addIssue(
      issues,
      [...path, "content"],
      "BLOCK_CONTENT_LIMIT",
      `Block content exceeds ${MAX_BLOCK_CONTENT_BYTES} UTF-8 bytes.`,
      mode,
    )
  }
  for (const key of ["marker", "color", "group"] as const) {
    const field = ownValue(value, key)
    if (field !== MISSING && field !== undefined && field !== null) checkLabel(field, [...path, key], issues, mode)
  }
  validatePromptStringArray(ownValue(value, "injectionTrigger"), [...path, "injectionTrigger"], issues, mode)
  const characterTagTrigger = ownValue(value, "characterTagTrigger")
  if (characterTagTrigger !== MISSING && characterTagTrigger !== undefined) {
    validatePromptStringArray(characterTagTrigger, [...path, "characterTagTrigger"], issues, mode)
  }
  const variablesValue = ownValue(value, "variables")
  if (variablesValue !== MISSING && variablesValue !== undefined) {
    const variables = checkArray(
      variablesValue,
      [...path, "variables"],
      MAX_BLOCKS_PER_THREAD,
      "PROMPT_VARIABLES_LIMIT",
      issues,
      mode,
    )
    if (variables) {
      if (variables.length > MAX_BLOCKS_PER_THREAD) return
      for (let index = 0; index < variables.length; index += 1) {
        validatePromptVariableDefinition(arrayValue(variables, index), [...path, "variables", index], issues, mode)
      }
    }
  }
}
function validatePromptVariableValues(
  value: unknown,
  path: Path,
  issues: ApcIssue[],
  mode?: ModeIssue,
): void {
  if (!isPlainRecord(value)) {
    addIssue(issues, path, "PROMPT_VALUES_TYPE", "Expected a plain prompt-variable values object.", mode)
    return
  }
  let blockIds: string[]
  try {
    blockIds = Object.keys(value)
  } catch {
    addIssue(issues, path, "PROMPT_VALUES_TYPE", "Prompt-variable values could not be inspected.", mode)
    return
  }
  if (blockIds.length > MAX_BLOCKS_PER_THREAD) {
    addIssue(issues, path, "PROMPT_VALUES_LIMIT", `Prompt-variable blocks exceed ${MAX_BLOCKS_PER_THREAD} entries.`, mode)
    return
  }
  for (const blockId of blockIds) {
    const blockPath: Path = [...path, blockId]
    if (characterCount(blockId) > MAX_NAME_CHARS) {
      addIssue(issues, blockPath, "NAME_LIMIT", `Block ID exceeds ${MAX_NAME_CHARS} characters.`, mode)
      continue
    }
    const block = ownValue(value, blockId)
    if (!isPlainRecord(block)) {
      addIssue(issues, blockPath, "PROMPT_VALUES_TYPE", "Expected a plain block values object.", mode)
      continue
    }
    let names: string[]
    try {
      names = Object.keys(block)
    } catch {
      addIssue(issues, blockPath, "PROMPT_VALUES_TYPE", "Block values could not be inspected.", mode)
      continue
    }
    if (names.length > MAX_BLOCKS_PER_THREAD) {
      addIssue(issues, blockPath, "PROMPT_VALUES_LIMIT", `Prompt-variable values exceed ${MAX_BLOCKS_PER_THREAD} entries.`, mode)
      continue
    }
    for (const name of names) {
      const valuePath: Path = [...blockPath, name]
      if (characterCount(name) > MAX_NAME_CHARS) {
        addIssue(issues, valuePath, "NAME_LIMIT", `Variable name exceeds ${MAX_NAME_CHARS} characters.`, mode)
        continue
      }
      const item = ownValue(block, name)
      if (typeof item === "string") {
        checkLiteral(item, valuePath, issues, mode)
      } else if (typeof item === "number") {
        if (!Number.isFinite(item)) addIssue(issues, valuePath, "FINITE_NUMBER_REQUIRED", "Expected a finite number.", mode)
      } else if (Array.isArray(item)) {
        validatePromptStringArray(item, valuePath, issues, mode)
      } else {
        addIssue(issues, valuePath, "PROMPT_VALUE_REQUIRED", "Prompt variable values must be strings, finite numbers, or string arrays", mode)
      }
    }
  }
}

function validateThread(
  value: unknown,
  path: Path,
  issues: ApcIssue[],
  mode?: ModeIssue,
  slotIds?: ReadonlySet<string>,
  threadIds?: Set<string>,
  allIds?: Set<string>,
): void {
  if (!isPlainRecord(value)) {
    addIssue(issues, path, "THREAD_TYPE", "Expected a plain thread.", mode)
    return
  }
  const id = ownValue(value, "id")
  if (checkGeneratedId(id, [...path, "id"], issues, mode)) {
    if (allIds?.has(id)) addIssue(issues, [...path, "id"], "ID_DUPLICATE", "Generated ID is not unique.", mode)
    allIds?.add(id)
    threadIds?.add(id)
  }
  checkLabel(ownValue(value, "name"), [...path, "name"], issues, mode)
  checkDescription(ownValue(value, "description"), [...path, "description"], issues, mode)
  const workspace = ownValue(value, "workspaceSource")
  if (workspace !== "native-blocks" && workspace !== "main-context") {
    addIssue(issues, [...path, "workspaceSource"], "WORKSPACE_SOURCE", "Expected native-blocks or main-context.", mode)
  }
  const slot = ownValue(value, "connectionSlotId")
  if (slot !== MISSING && slot !== undefined) {
    if (checkGeneratedId(slot, [...path, "connectionSlotId"], issues, mode) && slotIds && !slotIds.has(slot)) {
      addIssue(issues, [...path, "connectionSlotId"], "SLOT_REFERENCE", "Connection slot does not exist.", mode)
    }
  }
  const blocks = checkArray(
    ownValue(value, "blocks"),
    [...path, "blocks"],
    MAX_BLOCKS_PER_THREAD,
    "BLOCKS_LIMIT",
    issues,
    mode,
  )
  if (blocks) {
    for (let index = 0; index < blocks.length; index += 1) {
      validateBlock(arrayValue(blocks, index), [...path, "blocks", index], issues, mode)
    }
  }
  const variables = ownValue(value, "promptVariableValues")
  validatePromptVariableValues(variables, [...path, "promptVariableValues"], issues, mode)
  if (!checkSerializedLimit(
    variables,
    [...path, "promptVariableValues"],
    MAX_WORKSPACE_BYTES,
    "WORKSPACE_LIMIT",
    `Prompt-variable workspace exceeds ${MAX_WORKSPACE_BYTES} UTF-8 bytes.`,
    issues,
    mode,
  )) {
    // The structural/size issue is already recorded.
  }
  const workspaceValue = { blocks: blocks ?? [], promptVariableValues: variables }
  checkSerializedLimit(
    workspaceValue,
    [...path, "workspace"],
    MAX_WORKSPACE_BYTES,
    "WORKSPACE_LIMIT",
    `Thread workspace exceeds ${MAX_WORKSPACE_BYTES} UTF-8 bytes.`,
    issues,
    mode,
  )
  const output = ownValue(value, "output")
  if (!isPlainRecord(output)) {
    addIssue(issues, [...path, "output"], "OUTPUT_TYPE", "Expected a plain output descriptor.", mode)
  } else {
    checkReservedId(ownValue(output, "id"), "final", [...path, "output", "id"], issues, mode)
    checkLabel(ownValue(output, "name"), [...path, "output", "name"], issues, mode)
    const outputName = ownValue(output, "name")
    if (outputName !== "Final Response") {
      addIssue(issues, [...path, "output", "name"], "OUTPUT_NAME", "Thread output name must be Final Response.", mode)
    }
  }
}

function validateBinding(
  value: unknown,
  path: Path,
  issues: ApcIssue[],
  mode?: ModeIssue,
  runId?: string,
  stageIndex?: number,
  references?: OutputReference[],
): void {
  if (!isPlainRecord(value)) {
    addIssue(issues, path, "BINDING_TYPE", "Expected a plain input binding.", mode)
    return
  }
  const source = ownValue(value, "source")
  if (source === "literal") {
    checkRole(ownValue(value, "role"), [...path, "role"], issues, mode)
    const content = ownValue(value, "content")
    if (typeof content !== "string") {
      addIssue(issues, [...path, "content"], "LITERAL_TYPE", "Expected literal text.", mode)
    } else if (utf8Bytes(content) > MAX_LITERAL_BYTES) {
      addIssue(
        issues,
        [...path, "content"],
        "LITERAL_LIMIT",
        `Literal exceeds ${MAX_LITERAL_BYTES} UTF-8 bytes.`,
        mode,
      )
    }
    return
  }
  if (source !== "output") {
    addIssue(issues, [...path, "source"], "BINDING_SOURCE", "Expected literal or output binding.", mode)
    return
  }
  const sourceRunId = ownValue(value, "runId")
  if (typeof sourceRunId !== "string") {
    addIssue(issues, [...path, "runId"], "REFERENCE_TYPE", "Expected a source run ID.", mode)
  }
  const canonicalSourceRunId = typeof sourceRunId === "string"
    && checkGeneratedId(sourceRunId, [...path, "runId"], issues, mode)
  checkRole(ownValue(value, "role"), [...path, "role"], issues, mode)
  const policy = ownValue(value, "onMissing")
  if (typeof policy !== "string" || !MISSING_POLICIES.some((candidate) => candidate === policy)) {
    addIssue(issues, [...path, "onMissing"], "MISSING_POLICY", "Expected fail-graph, skip-run, or omit-binding.", mode)
  }
  if (canonicalSourceRunId && typeof sourceRunId === "string") {
    references?.push({
      sourceRunId,
      path: [...path, "runId"],
      policy: typeof policy === "string" ? policy : undefined,
      fromRunId: runId,
      stageIndex,
      isFinal: false,
    })
  }
}

function validateFinalInput(
  value: unknown,
  path: Path,
  issues: ApcIssue[],
  mode: ApcMode,
  references: OutputReference[],
): void {
  if (!isPlainRecord(value)) {
    addIssue(issues, path, "FINAL_INPUT_TYPE", "Expected a plain final input.", mode)
    return
  }
  if (ownValue(value, "source") !== "output") {
    addIssue(issues, [...path, "source"], "FINAL_INPUT_SOURCE", "Final input source must be output.", mode)
  }
  const sourceRunId = ownValue(value, "runId")
  if (typeof sourceRunId !== "string") {
    addIssue(issues, [...path, "runId"], "REFERENCE_TYPE", "Expected a source run ID.", mode)
  }
  const canonicalSourceRunId = typeof sourceRunId === "string"
    && checkGeneratedId(sourceRunId, [...path, "runId"], issues, mode)
  const policy = ownValue(value, "onMissing")
  if (typeof policy !== "string" || !FINAL_MISSING_POLICIES.some((candidate) => candidate === policy)) {
    addIssue(issues, [...path, "onMissing"], "FINAL_MISSING_POLICY", "Final input policy must be fail-graph or omit-binding.", mode)
  }
  if (canonicalSourceRunId && typeof sourceRunId === "string") {
    references.push({
      sourceRunId,
      path: [...path, "runId"],
      policy: typeof policy === "string" ? policy : undefined,
      fromRunId: undefined,
      stageIndex: undefined,
      isFinal: true,
    })
  }
}

function validatePipeline(
  value: unknown,
  path: Path,
  mode: ApcMode,
  issues: ApcIssue[],
  threadIds: ReadonlySet<string>,
  allIds: Set<string>,
  reachableRunIds: Set<string>,
): PipelineValidation {
  if (!isPlainRecord(value)) {
    addIssue(issues, path, "PIPELINE_TYPE", "Expected a plain pipeline.", mode)
    return { reachableRunIds }
  }
  const pipelineId = ownValue(value, "id")
  if (checkGeneratedId(pipelineId, [...path, "id"], issues, mode)) {
    if (allIds.has(pipelineId)) addIssue(issues, [...path, "id"], "ID_DUPLICATE", "Generated ID is not unique.", mode)
    allIds.add(pipelineId)
  }
  const stages = checkArray(
    ownValue(value, "stages"),
    [...path, "stages"],
    MAX_STAGES_PER_PIPELINE,
    "STAGES_LIMIT",
    issues,
    mode,
  )
  if (!stages) return { reachableRunIds }
  if (stages.length === 0) {
    addIssue(issues, [...path, "stages"], "STAGES_EMPTY", "Pipeline must contain at least one stage.", mode)
    return { reachableRunIds }
  }

  const stageIds = new Set<string>()
  const runIds = new Map<string, RunInfo>()
  const stageRunIds: string[][] = []
  const references: OutputReference[] = []
  let runCount = 0
  let stageTimeoutSum = 0

  for (let stageIndex = 0; stageIndex < stages.length; stageIndex += 1) {
    const stagePath: Path = [...path, "stages", stageIndex]
    const stageValue = arrayValue(stages, stageIndex)
    if (!isPlainRecord(stageValue)) {
      addIssue(issues, stagePath, "STAGE_TYPE", "Expected a plain stage.", mode)
      stageRunIds.push([])
      continue
    }
    const stageId = ownValue(stageValue, "id")
    if (checkGeneratedId(stageId, [...stagePath, "id"], issues, mode)) {
      if (stageIds.has(stageId) || allIds.has(stageId)) addIssue(issues, [...stagePath, "id"], "ID_DUPLICATE", "Stage ID is not unique.", mode)
      stageIds.add(stageId)
      allIds.add(stageId)
    }
    checkLabel(ownValue(stageValue, "name"), [...stagePath, "name"], issues, mode)
    const runs = checkArray(
      ownValue(stageValue, "runs"),
      [...stagePath, "runs"],
      mode === "parallel" ? MAX_PARALLEL_WIDTH : 1,
      mode === "parallel" ? "PARALLEL_WIDTH" : "SEQUENTIAL_RUN_COUNT",
      issues,
      mode,
    )
    stageRunIds.push([])
    if (!runs) continue
    if (runs.length === 0) {
      addIssue(issues, [...stagePath, "runs"], "RUNS_EMPTY", "Stage must contain at least one run.", mode)
      continue
    }
    if (mode === "sequential" && runs.length !== 1) {
      addIssue(issues, [...stagePath, "runs"], "SEQUENTIAL_RUN_COUNT", "Sequential stages must contain exactly one run.", mode)
    }
    if (mode === "parallel" && runs.length > MAX_PARALLEL_WIDTH) {
      // checkArray already emitted the bounded-width issue; this branch documents the invariant.
    }
    const stageThreads = new Set<string>()
    let stageMaxTimeout = 0
    for (let runIndex = 0; runIndex < runs.length; runIndex += 1) {
      const runPath: Path = [...stagePath, "runs", runIndex]
      const runValue = arrayValue(runs, runIndex)
      if (!isPlainRecord(runValue)) {
        addIssue(issues, runPath, "RUN_TYPE", "Expected a plain run.", mode)
        continue
      }
      runCount += 1
      const runId = ownValue(runValue, "id")
      const validRunId = checkGeneratedId(runId, [...runPath, "id"], issues, mode)
      if (validRunId) {
        if (runIds.has(runId) || allIds.has(runId)) {
          addIssue(issues, [...runPath, "id"], "ID_DUPLICATE", "Run ID is not unique.", mode)
        } else {
          runIds.set(runId, {
            id: runId,
            path: runPath,
            stageIndex,
            required: ownValue(runValue, "required") === true,
          })
        }
        allIds.add(runId)
        stageRunIds[stageIndex].push(runId)
      }
      const threadId = ownValue(runValue, "threadId")
      if (typeof threadId !== "string") {
        addIssue(issues, [...runPath, "threadId"], "THREAD_REFERENCE", "Expected a thread ID.", mode)
      } else if (checkGeneratedId(threadId, [...runPath, "threadId"], issues, mode)) {
        if (!threadIds.has(threadId)) addIssue(issues, [...runPath, "threadId"], "THREAD_REFERENCE", "Thread does not exist.", mode)
        if (stageThreads.has(threadId)) addIssue(issues, [...runPath, "threadId"], "THREAD_DUPLICATE_STAGE", "A thread may run only once per stage.", mode)
        stageThreads.add(threadId)
      }
      const required = ownValue(runValue, "required")
      if (typeof required !== "boolean") {
        addIssue(issues, [...runPath, "required"], "REQUIRED_TYPE", "Expected a boolean required flag.", mode)
      }
      const timeout = ownValue(runValue, "timeoutMs")
      if (typeof timeout !== "number" || !Number.isFinite(timeout) || !Number.isInteger(timeout)) {
        addIssue(issues, [...runPath, "timeoutMs"], "TIMEOUT_INVALID", "Run timeout must be a finite integer.", mode)
      } else {
        if (timeout < MIN_RUN_TIMEOUT_MS || timeout > MAX_RUN_TIMEOUT_MS) {
          addIssue(issues, [...runPath, "timeoutMs"], "TIMEOUT_LIMIT", `Run timeout must be between ${MIN_RUN_TIMEOUT_MS} and ${MAX_RUN_TIMEOUT_MS} ms.`, mode)
        }
        stageMaxTimeout = Math.max(stageMaxTimeout, timeout)
      }
      const inputs = checkArray(
        ownValue(runValue, "inputs"),
        [...runPath, "inputs"],
        MAX_BINDINGS_PER_RUN,
        "BINDINGS_LIMIT",
        issues,
        mode,
      )
      if (inputs) {
        for (let inputIndex = 0; inputIndex < inputs.length; inputIndex += 1) {
          validateBinding(
            arrayValue(inputs, inputIndex),
            [...runPath, "inputs", inputIndex],
            issues,
            mode,
            validRunId ? runId : undefined,
            stageIndex,
            references,
          )
        }
      }
      if (validRunId && runIds.has(runId)) {
        // Preserve the first definition's required flag; duplicate definitions are already invalid.
      }
    }
    stageTimeoutSum += stageMaxTimeout
  }

  if (runCount > MAX_RUNS_PER_PIPELINE) {
    addIssue(issues, [...path, "stages"], "RUNS_LIMIT", `Pipeline exceeds ${MAX_RUNS_PER_PIPELINE} runs.`, mode)
  }
  if (stageTimeoutSum > GRAPH_DEADLINE_MS) {
    addIssue(issues, [...path, "stages"], "GRAPH_DEADLINE", `Stage timeout budget exceeds ${GRAPH_DEADLINE_MS} ms.`, mode)
  }

  const finalPath: Path = [...path, "finalResponse"]
  const finalResponse = ownValue(value, "finalResponse")
  let finalThreadReference: OutputReference | undefined
  if (!isPlainRecord(finalResponse)) {
    addIssue(issues, finalPath, "FINAL_ROUTE_TYPE", "Expected a plain final route.", mode)
  } else {
    const source = ownValue(finalResponse, "source")
    if (source === "main") {
      const inputs = checkArray(
        ownValue(finalResponse, "inputs"),
        [...finalPath, "inputs"],
        MAX_FINAL_INPUTS,
        "FINAL_INPUTS_LIMIT",
        issues,
        mode,
      )
      if (inputs) {
        for (let index = 0; index < inputs.length; index += 1) {
          validateFinalInput(arrayValue(inputs, index), [...finalPath, "inputs", index], issues, mode, references)
        }
      }
      checkSerializedLimit(
        inputs ?? [],
        [...finalPath, "guidance"],
        MAX_GUIDANCE_BYTES,
        "GUIDANCE_LIMIT",
        `Final guidance inputs exceed ${MAX_GUIDANCE_BYTES} UTF-8 bytes.`,
        issues,
        mode,
      )
    } else if (source === "thread") {
      const runId = ownValue(finalResponse, "runId")
      if (typeof runId !== "string") {
        addIssue(issues, [...finalPath, "runId"], "REFERENCE_TYPE", "Expected a final thread run ID.", mode)
      } else if (checkGeneratedId(runId, [...finalPath, "runId"], issues, mode)) {
        finalThreadReference = {
          sourceRunId: runId,
          path: [...finalPath, "runId"],
          policy: "fail-graph",
          fromRunId: undefined,
          stageIndex: undefined,
          isFinal: true,
        }
        references.push(finalThreadReference)
      }
    } else {
      addIssue(issues, [...finalPath, "source"], "FINAL_ROUTE_SOURCE", "Final route must target Main or a thread.", mode)
    }
  }

  const required = new Set<string>()
  for (const reference of references) {
    const target = runIds.get(reference.sourceRunId)
    if (!target) {
      addIssue(issues, reference.path, "RUN_REFERENCE", "Referenced run does not exist in this pipeline.", mode)
      continue
    }
    if (!reference.isFinal && reference.stageIndex !== undefined && target.stageIndex >= reference.stageIndex) {
      addIssue(issues, reference.path, "RUN_REFERENCE_ORDER", "Output references must target an earlier stage.", mode)
    }
    if (reference.isFinal && reference.fromRunId === undefined && reference.policy === "fail-graph") {
      required.add(target.id)
    } else if (reference.policy === "fail-graph") {
      required.add(target.id)
    }
  }
  for (const info of runIds.values()) {
    if (info.required) {
      if (info.required) required.add(info.id)
    }
  }

  let changed = true
  while (changed) {
    changed = false
    for (const reference of references) {
      if (reference.policy !== "fail-graph" || reference.fromRunId === undefined) continue
      if (!required.has(reference.fromRunId)) continue
      const target = runIds.get(reference.sourceRunId)
      if (target && !required.has(target.id)) {
        required.add(target.id)
        changed = true
      }
    }
  }
  for (const reference of references) {
    const target = runIds.get(reference.sourceRunId)
    if (!target) continue
    if (reference.fromRunId !== undefined && reference.policy === "skip-run") {
      const from = runIds.get(reference.fromRunId)
      if (from?.required) {
        addIssue(issues, reference.path, "SKIP_REQUIRED", "A required run cannot use skip-run.", mode)
      }
    }
    if (reference.policy === "fail-graph" && !target.required) {
      addIssue(issues, reference.path, "REQUIRED_CLOSURE", "Fail-graph dependencies must be required.", mode)
    }
  }
  for (const reference of references) {
    if (!reference.isFinal || reference.policy !== "fail-graph") continue
    const target = runIds.get(reference.sourceRunId)
    if (target && !target.required) {
      addIssue(issues, reference.path, "REQUIRED_CLOSURE", "Final fail-graph dependencies must be required.", mode)
    }
  }
  if (finalThreadReference) {
    const target = runIds.get(finalThreadReference.sourceRunId)
    if (target) {
      required.add(target.id)
      if (!target.required) {
        addIssue(issues, finalThreadReference.path, "FINAL_RUN_REQUIRED", "Thread-final route must target a required run.", mode)
      }
    }
  }

  const dependencies = new Map<string, string[]>()
  for (const reference of references) {
    if (reference.fromRunId === undefined) continue
    const target = runIds.get(reference.sourceRunId)
    const from = runIds.get(reference.fromRunId)
    if (!target || !from || target.stageIndex >= from.stageIndex) continue
    const existing = dependencies.get(from.id)
    if (existing) existing.push(target.id)
    else dependencies.set(from.id, [target.id])
  }
  const roots = references.filter((reference) => reference.isFinal)
  const visit = (runId: string): void => {
    if (reachableRunIds.has(runId)) return
    const run = runIds.get(runId)
    if (!run) return
    reachableRunIds.add(runId)
    for (const dependency of dependencies.get(runId) ?? []) visit(dependency)
  }
  for (const root of roots) visit(root.sourceRunId)
  for (const info of runIds.values()) {
    if (!reachableRunIds.has(info.id)) {
      addIssue(issues, info.path, "RUN_UNREACHABLE", "Run is not reachable from the final route.", mode)
    }
  }
  return { reachableRunIds }
}

function validateShared(config: unknown, issues: ApcIssue[]): {
  readonly root: Record<string, unknown> | null
  readonly supportedModes: readonly ApcMode[]
  readonly threadIds: ReadonlySet<string>
  readonly slotIds: ReadonlySet<string>
  readonly allIds: Set<string>
} {
  if (!isPlainRecord(config)) {
    addIssue(issues, [], "CONFIG_TYPE", "Expected a plain APC configuration object.")
    return { root: null, supportedModes: [], threadIds: new Set(), slotIds: new Set(), allIds: new Set() }
  }
  const serialized = serializedUtf8Bytes(config)
  if (!serialized.ok) {
    addIssue(issues, ["config"], serialized.error.code, serialized.error.message)
  } else if (serialized.bytes > MAX_CONFIG_BYTES) {
    addIssue(issues, ["config"], "CONFIG_LIMIT", `Configuration exceeds ${MAX_CONFIG_BYTES} UTF-8 bytes.`)
  }
  if (ownValue(config, "schemaVersion") !== 1) {
    addIssue(issues, ["schemaVersion"], "SCHEMA_VERSION", "Only schema version 1 is executable.")
  }

  const supportedModes: ApcMode[] = []
  const supported = checkArray(ownValue(config, "supportedModes"), ["supportedModes"], MODES.length, "SUPPORTED_MODES_LIMIT", issues)
  if (supported) {
    if (supported.length === 0) addIssue(issues, ["supportedModes"], "SUPPORTED_MODES_EMPTY", "Single must be supported.")
    const seen = new Set<ApcMode>()
    for (let index = 0; index < supported.length; index += 1) {
      const value = arrayValue(supported, index)
      const modePath: Path = ["supportedModes", index]
      if (!checkMode(value, modePath, issues)) continue
      if (seen.has(value)) addIssue(issues, modePath, "MODE_DUPLICATE", "Supported modes must be unique.")
      seen.add(value)
      supportedModes.push(value)
    }
    if (!seen.has("single")) addIssue(issues, ["supportedModes"], "SINGLE_REQUIRED", "Single must always be supported.")
  }

  const active = ownValue(config, "activeMode")
  let activeMode: ApcMode | undefined
  if (checkMode(active, ["activeMode"], issues)) activeMode = active
  if (activeMode !== undefined && !supportedModes.includes(activeMode)) {
    addIssue(issues, ["activeMode"], "ACTIVE_MODE_UNSUPPORTED", "Active mode must be listed in supportedModes.")
  }

  const main = ownValue(config, "mainThread")
  if (!isPlainRecord(main)) {
    addIssue(issues, ["mainThread"], "MAIN_THREAD_TYPE", "Expected the Main Thread descriptor.")
  } else {
    checkReservedId(ownValue(main, "id"), "main", ["mainThread", "id"], issues)
    const mainName = ownValue(main, "name")
    checkLabel(mainName, ["mainThread", "name"], issues)
    if (mainName !== "Main Thread") {
      addIssue(issues, ["mainThread", "name"], "MAIN_THREAD_NAME", "Main thread name must be Main Thread.")
    }
    const output = ownValue(main, "output")
    if (!isPlainRecord(output)) {
      addIssue(issues, ["mainThread", "output"], "OUTPUT_TYPE", "Expected a Main output descriptor.")
    } else {
      checkReservedId(ownValue(output, "id"), "final", ["mainThread", "output", "id"], issues)
      const outputName = ownValue(output, "name")
      checkLabel(outputName, ["mainThread", "output", "name"], issues)
      if (outputName !== "Final Response") {
        addIssue(issues, ["mainThread", "output", "name"], "OUTPUT_NAME", "Main output name must be Final Response.")
      }
    }
  }

  const allIds = new Set<string>()
  const slotIds = new Set<string>()
  const slots = checkArray(
    ownValue(config, "connectionSlots"),
    ["connectionSlots"],
    MAX_CONNECTION_SLOTS,
    "SLOTS_LIMIT",
    issues,
  )
  if (slots) {
    for (let index = 0; index < slots.length; index += 1) {
      const path: Path = ["connectionSlots", index]
      const slot = arrayValue(slots, index)
      if (!isPlainRecord(slot)) {
        addIssue(issues, path, "SLOT_TYPE", "Expected a plain connection slot.")
        continue
      }
      const id = ownValue(slot, "id")
      if (checkGeneratedId(id, [...path, "id"], issues)) {
        if (slotIds.has(id) || allIds.has(id)) {
          addIssue(issues, [...path, "id"], "ID_DUPLICATE", "Generated ID is not unique.")
        }
        slotIds.add(id)
        allIds.add(id)
      }
      checkLabel(ownValue(slot, "label"), [...path, "label"], issues)
      const hint = ownValue(slot, "hint")
      if (hint !== MISSING && hint !== undefined) validateHint(hint, [...path, "hint"], issues)
    }
  }

  const threadIds = new Set<string>()
  const threads = checkArray(
    ownValue(config, "threads"),
    ["threads"],
    MAX_THREADS,
    "THREADS_LIMIT",
    issues,
  )
  if (threads) {
    for (let index = 0; index < threads.length; index += 1) {
      validateThread(arrayValue(threads, index), ["threads", index], issues, undefined, slotIds, threadIds, allIds)
    }
  }

  const pipelines = ownValue(config, "pipelines")
  if (!isPlainRecord(pipelines)) {
    addIssue(issues, ["pipelines"], "PIPELINES_TYPE", "Expected a plain pipelines object.")
  }
  return { root: config, supportedModes, threadIds, slotIds, allIds }
}

export function validateConfigForMode(config: ApcPresetConfigV1, mode: ApcMode): ApcValidationResult {
  const issues: ApcIssue[] = []
  const rootValue: unknown = config
  const shared = validateShared(rootValue, issues)
  const reachableRunIds = new Set<string>()
  const modeValue: string = typeof mode === "string" ? mode : ""
  const selectedMode = MODES.find((candidate) => candidate === modeValue)
  if (selectedMode === undefined) {
    addIssue(issues, ["mode"], "MODE_INVALID", "Expected single, sequential, or parallel.")
    return finish(issues, reachableRunIds)
  }
  if (!shared.supportedModes.includes(selectedMode)) {
    addIssue(issues, ["supportedModes"], "MODE_UNSUPPORTED", "Selected mode is not supported.", selectedMode)
  }
  if (selectedMode === "single") {
    // Single intentionally bypasses all pipeline semantics. Shared shape and the
    // mandatory Single declaration remain required for a safe no-op path.
    return finish(issues, reachableRunIds)
  }
  if (!shared.root) return finish(issues, reachableRunIds)
  const pipelinesValue = ownValue(shared.root, "pipelines")
  if (!isPlainRecord(pipelinesValue)) {
    addIssue(issues, ["pipelines"], "PIPELINES_TYPE", "Expected pipeline descriptors.", selectedMode)
    return finish(issues, reachableRunIds)
  }
  const pipeline = ownValue(pipelinesValue, selectedMode)
  if (pipeline === MISSING || pipeline === undefined || pipeline === null) {
    addIssue(issues, ["pipelines", selectedMode], "PIPELINE_MISSING", "Supported mode must provide its pipeline.", selectedMode)
    return finish(issues, reachableRunIds)
  }
  validatePipeline(pipeline, ["pipelines", selectedMode], selectedMode, issues, shared.threadIds, shared.allIds, reachableRunIds)
  return finish(issues, reachableRunIds)
}

export function deriveModeAvailability(config: ApcPresetConfigV1): ApcModeAvailabilityMap {
  const root: unknown = config
  const supportedValue = isPlainRecord(root) ? ownValue(root, "supportedModes") : MISSING
  const supported = new Set<ApcMode>()
  if (isPlainArray(supportedValue)) {
    for (let index = 0; index < supportedValue.length; index += 1) {
      const value = arrayValue(supportedValue, index)
      const modeCandidate = MODES.find((candidate) => candidate === value)
      if (modeCandidate !== undefined) supported.add(modeCandidate)
    }
  }
  const result: Record<ApcMode, ApcModeAvailability> = {
    single: { supported: false, valid: false },
    sequential: { supported: false, valid: false },
    parallel: { supported: false, valid: false },
  }
  for (const mode of MODES) {
    const validation = validateConfigForMode(config, mode)
    if (!supported.has(mode)) {
      result[mode] = {
        supported: false,
        valid: validation.valid,
        disabledReason: "Mode is not listed in supportedModes.",
      }
    } else if (validation.valid) {
      result[mode] = { supported: true, valid: true }
    } else {
      const first = validation.issues[0]
      result[mode] = {
        supported: true,
        valid: false,
        disabledReason: first ? `${first.code}: ${first.message}` : "Mode configuration is invalid.",
      }
    }
  }
  return result
}
