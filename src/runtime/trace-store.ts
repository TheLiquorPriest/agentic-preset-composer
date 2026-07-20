import {
  MAX_RETAINED_TRACES_GLOBAL,
  MAX_RETAINED_TRACES_PER_USER_PRESET,
  MAX_TRACE_BYTES,
  MAX_TRACE_TOTAL_BYTES,
  TRACE_PREVIEW_BYTES,
  truncateUtf8,
  utf8Bytes,
} from "../config/limits"
import { AdmissionLease, AdmissionRegistry, AdmissionResult } from "./admission"

export type TraceStatus = "active" | "completed" | "cancelled"
export type TraceMetadataValue = string | number | boolean | null
export type TraceMetadata = Readonly<Record<string, TraceMetadataValue>>

export interface TraceEventInput {
  readonly sequence: number
  readonly kind?: string
  readonly type?: string
  readonly metadata?: TraceMetadata
  readonly preview?: string
}

export interface TraceFinalizeInput {
  readonly sequence?: number
  readonly status?: "completed" | "cancelled"
  readonly kind?: string
  readonly type?: string
  readonly metadata?: TraceMetadata
  readonly preview?: string
}

export interface TraceEntry {
  readonly sequence: number
  readonly kind: string
  readonly metadata: TraceMetadata
  readonly preview: string
  readonly previewTruncated: boolean
}

export interface TraceSnapshot {
  readonly userId: string
  readonly presetId: string
  readonly executionId: string
  readonly status: TraceStatus
  readonly active: boolean
  readonly metadata: TraceMetadata
  readonly entries: readonly TraceEntry[]
  readonly lastSequence: number
  readonly entryCount: number
  readonly bytes: number
}

export type TraceRejectionReason =
  | "invalid-key"
  | "invalid-metadata"
  | "invalid-event"
  | "not-found"
  | "not-active"
  | "late-sequence"
  | "trace-capacity"
  | "global-capacity"
  | "admission-capacity"
  | "duplicate-execution"

export type TraceAcquireResult =
  | Readonly<{ accepted: true; trace: TraceSnapshot }>
  | Readonly<{ accepted: false; reason: TraceRejectionReason }>

export type TraceMutationResult =
  | Readonly<{ accepted: true; trace: TraceSnapshot }>
  | Readonly<{ accepted: false; reason: TraceRejectionReason }>

export type TraceFinalizeResult =
  | Readonly<{ accepted: true; retained: true; trace: TraceSnapshot }>
  | Readonly<{ accepted: true; retained: false }>
  | Readonly<{ accepted: false; reason: TraceRejectionReason }>

interface StoredTrace {
  readonly userId: string
  readonly presetId: string
  readonly executionId: string
  readonly admission: AdmissionLease
  readonly order: number
  readonly metadata: TraceMetadata
  readonly entries: TraceEntry[]
  status: TraceStatus
  lastSequence: number
  bytes: number
}

interface RecordRead {
  readonly valid: boolean
  readonly values: ReadonlyMap<string, unknown>
}
interface RecordReadOptions {
  readonly maxKeys?: number
  readonly maxKeyBytes?: number
}

interface NormalizedEvent {
  readonly sequence: number
  readonly kind: string
  readonly metadata: TraceMetadata
  readonly sourcePreview: string
  readonly preview: string
}

interface EventFit {
  readonly accepted: boolean
  readonly event?: TraceEntry
}

const MAX_RECORD_KEYS = 16
const MAX_METADATA_KEYS = 64
const MAX_METADATA_KEY_BYTES = 256
const MAX_METADATA_VALUE_BYTES = MAX_TRACE_BYTES - 1_024

const DANGEROUS_KEYS: ReadonlySet<string> = new Set(["prototype", "constructor"])
const FORBIDDEN_METADATA_KEYS: Readonly<Record<string, true>> = {
  output: true,
  outputs: true,
  fulloutput: true,
  rawoutput: true,
  modeloutput: true,
  response: true,
  responses: true,
  message: true,
  messages: true,
  content: true,
  raw: true,
  apikey: true,
  api_key: true,
  "api-key": true,
  authorization: true,
  auth: true,
  token: true,
  accesstoken: true,
  access_token: true,
  refreshtoken: true,
  refresh_token: true,
  secret: true,
  clientsecret: true,
  client_secret: true,
  password: true,
  passphrase: true,
  credential: true,
  credentials: true,
  privatekey: true,
  private_key: true,
  "private-key": true,
  cookie: true,
  "set-cookie": true,
  userid: true,
  user_id: true,
  ownerid: true,
  owner_id: true,
  owneruserid: true,
  owner_user_id: true,
  presetid: true,
  preset_id: true,
  executionid: true,
  execution_id: true,
}
const EVENT_KEYS = {
  sequence: true,
  kind: true,
  type: true,
  metadata: true,
  preview: true,
} as const
const FINALIZE_KEYS = {
  sequence: true,
  status: true,
  kind: true,
  type: true,
  metadata: true,
  preview: true,
} as const

function isDangerousKey(key: string): boolean {
  return key === "__proto__" || DANGEROUS_KEYS.has(key)
}

function isIdentity(userId: unknown, presetId: unknown, executionId: unknown): boolean {
  return (
    typeof userId === "string" && userId.length > 0 &&
    typeof presetId === "string" && presetId.length > 0 &&
    typeof executionId === "string" && executionId.length > 0
  )
}

function readRecord(
  value: unknown,
  allowed?: Readonly<Record<string, true>>,
  options: RecordReadOptions = {},
): RecordRead {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, values: new Map() }
  }
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      return { valid: false, values: new Map() }
    }
    const properties = Reflect.ownKeys(value)
    if (properties.length > (options.maxKeys ?? MAX_RECORD_KEYS)) {
      return { valid: false, values: new Map() }
    }
    const values = new Map<string, unknown>()
    for (const property of properties) {
      if (typeof property !== "string") return { valid: false, values: new Map() }
      if (
        options.maxKeyBytes !== undefined &&
        (property.length > options.maxKeyBytes || utf8Bytes(property) > options.maxKeyBytes)
      ) {
        return { valid: false, values: new Map() }
      }
      if (
        isDangerousKey(property) ||
        property === "toJSON" ||
        (allowed !== undefined && allowed[property] !== true)
      ) {
        return { valid: false, values: new Map() }
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, property)
      if (
        !descriptor ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        descriptor.enumerable !== true ||
        !("value" in descriptor)
      ) {
        return { valid: false, values: new Map() }
      }
      values.set(property, descriptor.value)
    }
    return { valid: true, values }
  } catch {
    return { valid: false, values: new Map() }
  }
}

function normalizeMetadata(value: unknown): TraceMetadata | undefined {
  const record = readRecord(value === undefined ? {} : value, undefined, {
    maxKeys: MAX_METADATA_KEYS,
    maxKeyBytes: MAX_METADATA_KEY_BYTES,
  })
  if (!record.valid) return undefined
  const result: Record<string, TraceMetadataValue> = {}
  for (const [key, item] of record.values) {
    if (isDangerousKey(key) || FORBIDDEN_METADATA_KEYS[key.toLowerCase()] === true) {
      return undefined
    }
    if (
      item !== null &&
      typeof item !== "string" &&
      typeof item !== "boolean" &&
      typeof item !== "number"
    ) {
      return undefined
    }
    if (typeof item === "number" && !Number.isFinite(item)) return undefined
    if (
      typeof item === "string" &&
      (item.length > MAX_METADATA_VALUE_BYTES || utf8Bytes(item) > MAX_METADATA_VALUE_BYTES)
    ) {
      return undefined
    }
    result[key] = item
  }
  return Object.freeze(result)
}

function valueAt(values: ReadonlyMap<string, unknown>, key: string): unknown {
  return values.get(key)
}

function normalizeEvent(value: unknown): NormalizedEvent | undefined {
  const record = readRecord(value, EVENT_KEYS)
  if (!record.valid) return undefined
  const sequence = valueAt(record.values, "sequence")
  if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 0) {
    return undefined
  }
  const rawKind = valueAt(record.values, "kind")
  const rawType = valueAt(record.values, "type")
  const kindValue = rawKind !== undefined ? rawKind : rawType !== undefined ? rawType : "event"
  if (
    typeof kindValue !== "string" ||
    kindValue.length === 0 ||
    (rawKind !== undefined && rawType !== undefined && rawKind !== rawType)
  ) {
    return undefined
  }
  const metadata = normalizeMetadata(valueAt(record.values, "metadata"))
  if (!metadata) return undefined
  const rawPreview = valueAt(record.values, "preview")
  if (rawPreview !== undefined && typeof rawPreview !== "string") return undefined
  const sourcePreview = rawPreview ?? ""
  return Object.freeze({
    sequence,
    kind: kindValue,
    metadata,
    sourcePreview,
    preview: truncateUtf8(sourcePreview, TRACE_PREVIEW_BYTES),
  })
}

function entryFrom(event: NormalizedEvent, preview: string): TraceEntry {
  return Object.freeze({
    sequence: event.sequence,
    kind: event.kind,
    metadata: event.metadata,
    preview,
    previewTruncated: preview !== event.sourcePreview,
  })
}

function wireTrace(
  trace: StoredTrace,
  status: TraceStatus = trace.status,
  entries: readonly TraceEntry[] = trace.entries,
): Readonly<{
  userId: string
  presetId: string
  executionId: string
  status: TraceStatus
  metadata: TraceMetadata
  entries: readonly TraceEntry[]
}> {
  return {
    userId: trace.userId,
    presetId: trace.presetId,
    executionId: trace.executionId,
    status,
    metadata: trace.metadata,
    entries,
  }
}

function encodedBytes(value: unknown): number {
  try {
    const encoded = JSON.stringify(value)
    return typeof encoded === "string" ? utf8Bytes(encoded) : Number.POSITIVE_INFINITY
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function snapshot(trace: StoredTrace): TraceSnapshot {
  return Object.freeze({
    userId: trace.userId,
    presetId: trace.presetId,
    executionId: trace.executionId,
    status: trace.status,
    active: trace.status === "active",
    metadata: trace.metadata,
    entries: Object.freeze(trace.entries.slice()),
    lastSequence: trace.lastSequence,
    entryCount: trace.entries.length,
    bytes: trace.bytes,
  })
}

function rejected(reason: TraceRejectionReason): Readonly<{ accepted: false; reason: TraceRejectionReason }> {
  return Object.freeze({ accepted: false as const, reason })
}

function admissionReason(result: AdmissionResult): TraceRejectionReason {
  if (result.accepted || result.reason === "invalid-key") return result.accepted ? "admission-capacity" : "invalid-key"
  return "admission-capacity"
}

function fitEvent(trace: StoredTrace, event: NormalizedEvent, maxBytes: number): EventFit {
  const initial = entryFrom(event, event.preview)
  if (encodedBytes(wireTrace(trace, trace.status, trace.entries.concat(initial))) <= maxBytes) {
    return { accepted: true, event: initial }
  }

  let low = 0
  let high = utf8Bytes(event.preview)
  let best: TraceEntry | undefined
  while (low <= high) {
    const byteLimit = Math.floor((low + high) / 2)
    const candidate = entryFrom(event, truncateUtf8(event.sourcePreview, byteLimit))
    const size = encodedBytes(wireTrace(trace, trace.status, trace.entries.concat(candidate)))
    if (size <= maxBytes) {
      best = candidate
      low = byteLimit + 1
    } else {
      high = byteLimit - 1
    }
  }
  return best ? { accepted: true, event: best } : { accepted: false }
}

/** Bounded metadata/preview traces with user-first lookup and own-user eviction. */
export class TraceStore {
  readonly admission: AdmissionRegistry
  private readonly byUser = new Map<string, Map<string, Map<string, StoredTrace>>>()
  private totalCount = 0
  private totalBytes = 0
  private nextOrder = 1

  constructor(admission: AdmissionRegistry = new AdmissionRegistry()) {
    this.admission = admission
  }

  acquire(userId: string, presetId: string, executionId: string, metadata: TraceMetadata = {}): TraceAcquireResult {
    if (!isIdentity(userId, presetId, executionId)) return rejected("invalid-key")
    const normalizedMetadata = normalizeMetadata(metadata)
    if (!normalizedMetadata) return rejected("invalid-metadata")
    const existing = this.find(userId, presetId, executionId)
    if (existing?.status === "active") return rejected("duplicate-execution")
    const admission = this.admission.acquire(userId, presetId, executionId)
    if (!admission.accepted) return rejected(admissionReason(admission))

    const trace: StoredTrace = {
      userId,
      presetId,
      executionId,
      admission: admission.admission,
      order: this.nextOrder,
      metadata: normalizedMetadata,
      entries: [],
      status: "active",
      lastSequence: -1,
      bytes: 0,
    }
    this.nextOrder += 1
    trace.bytes = encodedBytes(wireTrace(trace))
    const extraBytes = existing === undefined ? trace.bytes : Math.max(0, trace.bytes - existing.bytes)
    const extraCount = existing === undefined ? 1 : 0
    if (trace.bytes > MAX_TRACE_BYTES || !this.makeRoom(userId, presetId, extraBytes, extraCount, existing)) {
      this.admission.releaseLease(trace.admission)
      return rejected(trace.bytes > MAX_TRACE_BYTES ? "trace-capacity" : "global-capacity")
    }
    if (existing !== undefined) this.remove(existing)
    this.insert(trace)
    return Object.freeze({ accepted: true as const, trace: snapshot(trace) })
  }

  release(userId: string, presetId: string, executionId: string): boolean {
    const trace = this.find(userId, presetId, executionId)
    if (!trace || trace.status !== "active") return false
    this.remove(trace)
    this.admission.releaseLease(trace.admission)
    return true
  }

  cancel(userId: string, presetId: string, executionId: string): TraceMutationResult {
    const trace = this.find(userId, presetId, executionId)
    if (!trace) return rejected("not-found")
    if (trace.status !== "active") return rejected("not-active")
    const oldBytes = trace.bytes
    const cancelledBytes = encodedBytes(wireTrace(trace, "cancelled"))
    if (
      cancelledBytes > MAX_TRACE_BYTES ||
      !this.makeRoom(userId, presetId, Math.max(0, cancelledBytes - oldBytes), 0)
    ) {
      return rejected(cancelledBytes > MAX_TRACE_BYTES ? "trace-capacity" : "global-capacity")
    }
    trace.status = "cancelled"
    trace.bytes = cancelledBytes
    this.totalBytes += cancelledBytes - oldBytes
    this.admission.releaseLease(trace.admission)
    this.retainCompleted(trace)
    return Object.freeze({ accepted: true as const, trace: snapshot(trace) })
  }

  get(userId: string, presetId: string, executionId: string): TraceSnapshot | undefined {
    const trace = this.find(userId, presetId, executionId)
    return trace ? snapshot(trace) : undefined
  }

  list(userId: string, presetId?: string): readonly TraceSnapshot[] {
    if (typeof userId !== "string" || userId.length === 0) return Object.freeze([])
    const byPreset = this.byUser.get(userId)
    if (!byPreset) return Object.freeze([])
    const traces: StoredTrace[] = []
    if (presetId !== undefined) {
      if (typeof presetId !== "string" || presetId.length === 0) return Object.freeze([])
      const byExecution = byPreset.get(presetId)
      if (byExecution) traces.push(...byExecution.values())
    } else {
      for (const byExecution of byPreset.values()) traces.push(...byExecution.values())
    }
    traces.sort((left, right) => left.order - right.order)
    return Object.freeze(traces.map(trace => snapshot(trace)))
  }

  append(userId: string, presetId: string, executionId: string, input: TraceEventInput): TraceMutationResult {
    const trace = this.find(userId, presetId, executionId)
    if (!trace) return rejected("not-found")
    if (trace.status !== "active") return rejected("not-active")
    const event = normalizeEvent(input)
    if (!event) return rejected("invalid-event")
    if (event.sequence <= trace.lastSequence) return rejected("late-sequence")

    let maxBytes = MAX_TRACE_BYTES
    let fitted = fitEvent(trace, event, maxBytes)
    if (!fitted.accepted || !fitted.event) return rejected("trace-capacity")
    let entries = trace.entries.concat(fitted.event)
    let bytes = encodedBytes(wireTrace(trace, trace.status, entries))
    if (!this.makeRoom(userId, presetId, Math.max(0, bytes - trace.bytes), 0)) {
      const available = MAX_TRACE_TOTAL_BYTES - (this.totalBytes - trace.bytes)
      maxBytes = Math.min(MAX_TRACE_BYTES, trace.bytes + Math.max(0, available))
      fitted = fitEvent(trace, event, maxBytes)
      if (!fitted.accepted || !fitted.event) return rejected("global-capacity")
      entries = trace.entries.concat(fitted.event)
      bytes = encodedBytes(wireTrace(trace, trace.status, entries))
      if (!this.makeRoom(userId, presetId, Math.max(0, bytes - trace.bytes), 0)) {
        return rejected("global-capacity")
      }
    }
    trace.entries.push(fitted.event)
    trace.lastSequence = event.sequence
    this.totalBytes += bytes - trace.bytes
    trace.bytes = bytes
    return Object.freeze({ accepted: true as const, trace: snapshot(trace) })
  }

  finalize(
    userId: string,
    presetId: string,
    executionId: string,
    input?: TraceFinalizeInput | number,
  ): TraceFinalizeResult {
    const trace = this.find(userId, presetId, executionId)
    if (!trace) return rejected("not-found")
    if (trace.status !== "active") return rejected("not-active")
    const normalized = this.normalizeFinalize(input)
    if (!normalized.valid) return rejected(normalized.reason)
    const oldBytes = trace.bytes
    let bytes: number

    if (normalized.event) {
      if (normalized.event.sequence <= trace.lastSequence) return rejected("late-sequence")
      const fitted = fitEvent(trace, normalized.event, MAX_TRACE_BYTES)
      if (!fitted.accepted || !fitted.event) {
        this.discardActive(trace)
        return rejected("trace-capacity")
      }
      bytes = encodedBytes(wireTrace(trace, normalized.status, trace.entries.concat(fitted.event)))
      if (bytes > MAX_TRACE_BYTES) {
        this.discardActive(trace)
        return rejected("trace-capacity")
      }
      if (!this.makeRoom(userId, presetId, Math.max(0, bytes - oldBytes), 0)) {
        this.discardActive(trace)
        return rejected("global-capacity")
      }
      trace.entries.push(fitted.event)
      trace.lastSequence = normalized.event.sequence
    } else {
      bytes = encodedBytes(wireTrace(trace, normalized.status))
      if (bytes > MAX_TRACE_BYTES) {
        this.discardActive(trace)
        return rejected("trace-capacity")
      }
      if (!this.makeRoom(userId, presetId, Math.max(0, bytes - oldBytes), 0)) {
        this.discardActive(trace)
        return rejected("global-capacity")
      }
    }

    trace.status = normalized.status
    trace.bytes = bytes
    this.totalBytes += bytes - oldBytes
    this.admission.releaseLease(trace.admission)
    const retained = this.retainCompleted(trace)
    return retained
      ? Object.freeze({ accepted: true as const, retained: true as const, trace: snapshot(trace) })
      : Object.freeze({ accepted: true as const, retained: false as const })
  }

  private normalizeFinalize(
    input: TraceFinalizeInput | number | undefined,
  ): Readonly<
    | { valid: true; status: "completed" | "cancelled"; event?: NormalizedEvent }
    | { valid: false; reason: TraceRejectionReason }
  > {
    if (input === undefined) return Object.freeze({ valid: true as const, status: "completed" as const })
    if (typeof input === "number") {
      const event = normalizeEvent({ sequence: input })
      return event
        ? Object.freeze({ valid: true as const, status: "completed" as const, event })
        : Object.freeze({ valid: false as const, reason: "invalid-event" as const })
    }
    const record = readRecord(input, FINALIZE_KEYS)
    if (!record.valid) return Object.freeze({ valid: false as const, reason: "invalid-event" as const })
    const rawStatus = valueAt(record.values, "status")
    if (rawStatus !== undefined && rawStatus !== "completed" && rawStatus !== "cancelled") {
      return Object.freeze({ valid: false as const, reason: "invalid-event" as const })
    }
    const eventInput: Record<string, unknown> = {}
    for (const key of ["sequence", "kind", "type", "metadata", "preview"]) {
      if (record.values.has(key)) eventInput[key] = record.values.get(key)
    }
    const event = Object.keys(eventInput).length > 0 ? normalizeEvent(eventInput) : undefined
    if (Object.keys(eventInput).length > 0 && !event) {
      return Object.freeze({ valid: false as const, reason: "invalid-event" as const })
    }
    return Object.freeze({
      valid: true as const,
      status: (rawStatus ?? "completed") as "completed" | "cancelled",
      ...(event ? { event } : {}),
    })
  }

  private find(userId: string, presetId: string, executionId: string): StoredTrace | undefined {
    if (!isIdentity(userId, presetId, executionId)) return undefined
    return this.byUser.get(userId)?.get(presetId)?.get(executionId)
  }

  private insert(trace: StoredTrace): void {
    let byPreset = this.byUser.get(trace.userId)
    let byExecution = byPreset?.get(trace.presetId)
    if (!byPreset) {
      byPreset = new Map()
      this.byUser.set(trace.userId, byPreset)
    }
    if (!byExecution) {
      byExecution = new Map()
      byPreset.set(trace.presetId, byExecution)
    }
    byExecution.set(trace.executionId, trace)
    this.totalCount += 1
    this.totalBytes += trace.bytes
  }

  private remove(trace: StoredTrace): void {
    const byPreset = this.byUser.get(trace.userId)
    const byExecution = byPreset?.get(trace.presetId)
    if (!byExecution?.delete(trace.executionId)) return
    if (byExecution.size === 0) byPreset?.delete(trace.presetId)
    if (byPreset && byPreset.size === 0) this.byUser.delete(trace.userId)
    this.totalCount -= 1
    this.totalBytes -= trace.bytes
  }

  private discardActive(trace: StoredTrace): void {
    this.remove(trace)
    this.admission.releaseLease(trace.admission)
  }

  private oldestCompleted(
    userId: string,
    presetId: string,
    excluded?: StoredTrace,
    includeOtherPresets = false,
  ): StoredTrace | undefined {
    const byPreset = this.byUser.get(userId)
    if (!byPreset) return undefined
    let oldest: StoredTrace | undefined
    const byExecution = byPreset.get(presetId)
    if (byExecution) {
      for (const trace of byExecution.values()) {
        if (trace === excluded || trace.status === "active") continue
        if (!oldest || trace.order < oldest.order) oldest = trace
      }
    }
    if (oldest || !includeOtherPresets) return oldest
    for (const [candidatePreset, candidateExecutions] of byPreset) {
      if (candidatePreset === presetId) continue
      for (const trace of candidateExecutions.values()) {
        if (trace === excluded || trace.status === "active") continue
        if (!oldest || trace.order < oldest.order) oldest = trace
      }
    }
    return oldest
  }

  private makeRoom(
    userId: string,
    presetId: string,
    extraBytes: number,
    extraCount: number,
    excluded?: StoredTrace,
  ): boolean {
    while (
      this.totalCount + extraCount > MAX_RETAINED_TRACES_GLOBAL ||
      this.totalBytes + extraBytes > MAX_TRACE_TOTAL_BYTES
    ) {
      const oldest = this.oldestCompleted(userId, presetId, excluded, true)
      if (!oldest) return false
      this.remove(oldest)
    }
    return true
  }

  private retainCompleted(trace: StoredTrace): boolean {
    const byExecution = this.byUser.get(trace.userId)?.get(trace.presetId)
    if (!byExecution) return false
    const completed = [...byExecution.values()]
      .filter(candidate => candidate.status !== "active")
      .sort((left, right) => left.order - right.order)
    while (completed.length > MAX_RETAINED_TRACES_PER_USER_PRESET) {
      const oldest = completed.shift()
      if (!oldest) break
      this.remove(oldest)
    }
    while (this.totalBytes > MAX_TRACE_TOTAL_BYTES) {
      const oldest = this.oldestCompleted(trace.userId, trace.presetId, undefined, true)
      if (!oldest) break
      this.remove(oldest)
    }
    return this.byUser.get(trace.userId)?.get(trace.presetId)?.get(trace.executionId) === trace
  }
}

export function createTraceStore(admission?: AdmissionRegistry): TraceStore {
  return new TraceStore(admission)
}

export function acquireTrace(
  store: TraceStore,
  userId: string,
  presetId: string,
  executionId: string,
  metadata: TraceMetadata = {},
): TraceAcquireResult {
  return store.acquire(userId, presetId, executionId, metadata)
}

export function releaseTrace(store: TraceStore, userId: string, presetId: string, executionId: string): boolean {
  return store.release(userId, presetId, executionId)
}

export function cancelTrace(
  store: TraceStore,
  userId: string,
  presetId: string,
  executionId: string,
): TraceMutationResult {
  return store.cancel(userId, presetId, executionId)
}

export function listTraces(store: TraceStore, userId: string, presetId?: string): readonly TraceSnapshot[] {
  return store.list(userId, presetId)
}

export function getTrace(
  store: TraceStore,
  userId: string,
  presetId: string,
  executionId: string,
): TraceSnapshot | undefined {
  return store.get(userId, presetId, executionId)
}

export function appendTrace(
  store: TraceStore,
  userId: string,
  presetId: string,
  executionId: string,
  input: TraceEventInput,
): TraceMutationResult {
  return store.append(userId, presetId, executionId, input)
}

export function finalizeTrace(
  store: TraceStore,
  userId: string,
  presetId: string,
  executionId: string,
  input?: TraceFinalizeInput | number,
): TraceFinalizeResult {
  return store.finalize(userId, presetId, executionId, input)
}

export const acquire = acquireTrace
export const release = releaseTrace
export const cancel = cancelTrace
export const list = listTraces
export const get = getTrace
export const append = appendTrace
export const finalize = finalizeTrace
