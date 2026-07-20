import {
  MAX_TRACE_BYTES,
  TRACE_PREVIEW_BYTES,
  truncateUtf8,
  utf8Bytes,
} from "../config/limits"
import { serializedUtf8Bytes } from "../config/plain-json"
import {
  createBackendActivityResponse,
  decodeFrontendIntent,
  MAX_CONNECTIONS,
  MAX_BINDING_VIEWS,
  MAX_CONSENT_VIEWS,
  MAX_CURSOR_BYTES,
  MAX_ERROR_DETAILS,
  MAX_TRACE_EVENTS,
  MAX_TRACE_LIST_ITEMS,
  ProtocolDecodeError,
  type BackendActivityInput,
  type BackendActivityResponse,
  type BackendBindingResponse,
  type BackendCancellationResponse,
  type BackendConsentResponse,
  type BackendConnectionListResponse,
  type BackendErrorResponse,
  type BackendHydrationResponse,
  type BackendResponse,
  type BackendTraceDetailResponse,
  type BackendTraceListResponse,
  type ConnectionSummary,
  type ConsentSelector as ProtocolConsentSelector,
  type ConsentDisclosureCategory,
  type FrontendIntent,
  type SafeBindingView,
  type SafeConsentDisclosure,
  type SafeConsentView,
  type SafeDestination,
  type TraceEvent,
  type TraceSummary,
} from "../protocol/messages"
import type { BindingSnapshot, ConnectionBindings, HostDispatchDescriptor, ResolvedDispatchBinding } from "./connection-bindings"
import type { ConsentDisclosure, ConsentService, ConsentSnapshot } from "./consent"
import type { AdmissionRegistry } from "../runtime/admission"
import type { TraceSnapshot, TraceStore } from "../runtime/trace-store"
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const CURSOR_PATTERN = /^(?:0|[1-9][0-9]*)$/
const DEFAULT_ERROR_MESSAGE = "APC backend request failed"
const DEFAULT_TRACE_LIMIT = 20
const FALLBACK_CORRELATION_ID = "00000000-0000-4000-8000-000000000000"
const OPAQUE_TOKEN_PATTERN = /^[0-9a-f]{32}$/u
const CONSENT_REVISION_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u
const CONSENT_SLOT_SOURCE_PATTERN = /^slot:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const MAX_CONSENT_THREAD_BYTES = 128
const MAX_CONSENT_DISCLOSURE_VERSION = 1_000_000

export interface BackendEndpointScope {
  readonly userId: string
}

export interface BackendInstallPair {
  readonly extensionInstallationId: string
  readonly installNonce: string
}

/** The host-scoped state boundary used to verify the active installation. */
export interface BackendInstallState {
  getInstallPair(): BackendInstallPair
}

export type BackendBindingService = Pick<
  ConnectionBindings,
  "bindSlot" | "unbindSlot" | "listConnections" | "listBindings"
> & Readonly<{
  resolveSlot?: ConnectionBindings["resolveSlot"]
}>

export type BackendConsentService = Pick<
  ConsentService,
  "approveBySelector" | "revoke" | "listConsents" | "resolveDisclosure" | "rememberDisclosure"
>


export interface BackendCancellationRequest {
  readonly userId: string
  readonly presetId: string
  readonly executionId: string
  readonly reason: "user" | "stop" | "replacement"
  readonly install: BackendInstallPair
}

export interface BackendCancellationResult {
  readonly accepted: boolean
  readonly presetId?: string
  readonly executionId?: string
  readonly traceId?: string
  readonly kind?: string
  readonly preview?: string
  readonly reason?: string
}

export interface BackendExecutionService {
  cancel(request: BackendCancellationRequest): Promise<BackendCancellationResult>
  currentExecution(userId: string, presetId: string): BackendActivityResponse["payload"] | undefined
}

export interface BackendEndpointDependencies {
  readonly state: BackendInstallState
  readonly bindings: BackendBindingService
  readonly consent: BackendConsentService
  readonly traces: TraceStore
  readonly admission: AdmissionRegistry
  readonly execution: BackendExecutionService
  readonly sendToFrontend?: (response: BackendResponse, userId: string) => void
  readonly onAuthorizedMutation?: (userId: string, presetId: string) => void
}

export type BackendActivityEmissionInput = Omit<BackendActivityInput, "sequence">
export interface BackendEndpointRouter {
  handle(scope: BackendEndpointScope, intent: unknown): Promise<BackendResponse>
  dispatchAndSend(scope: BackendEndpointScope, intent: unknown): Promise<BackendResponse>
  emitActivity(userId: string, input: BackendActivityEmissionInput): BackendActivityResponse["payload"] | undefined
  dispose(): void
}

class EndpointFailure extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly details?: readonly Readonly<{ path: string; reason: string }>[]

  constructor(
    code: string,
    message: string,
    retryable = false,
    details?: readonly Readonly<{ path: string; reason: string }>[],
  ) {
    super(message)
    this.name = "EndpointFailure"
    this.code = code
    this.retryable = retryable
    this.details = details
    Object.setPrototypeOf(this, new.target.prototype)
  }
}


function safeCorrelation(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return FALLBACK_CORRELATION_ID
  try {
    const candidate = (value as Record<string, unknown>).correlationId
    return typeof candidate === "string" && UUID_PATTERN.test(candidate) ? candidate : FALLBACK_CORRELATION_ID
  } catch {
    return FALLBACK_CORRELATION_ID
  }
}

function safeUserId(scope: BackendEndpointScope): string {
  if (
    scope === null ||
    typeof scope !== "object" ||
    Array.isArray(scope) ||
    typeof scope.userId !== "string" ||
    scope.userId.length === 0 ||
    scope.userId.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(scope.userId)
  ) {
    throw new EndpointFailure("APC_SCOPE_INVALID", "Authenticated user scope is invalid")
  }
  return scope.userId
}




function boundedPreview(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string") return undefined
  return truncateUtf8(value, TRACE_PREVIEW_BYTES)
}


function detailsFromProtocolError(error: ProtocolDecodeError): readonly Readonly<{ path: string; reason: string }>[] {
  const path = truncateUtf8(error.path, 512)
  const reason = truncateUtf8(error.message, 1_024)
  return Object.freeze([{ path, reason }])
}

function normalizeFailure(error: unknown, fallbackCode: string, fallbackMessage = DEFAULT_ERROR_MESSAGE): EndpointFailure {
  if (error instanceof EndpointFailure) return error
  if (error instanceof ProtocolDecodeError) {
    return new EndpointFailure(error.code, "Malformed frontend message", false, detailsFromProtocolError(error))
  }
  if (error !== null && typeof error === "object") {
    const candidate = error as Record<string, unknown>
    const rawCode = candidate.code
    const code = typeof rawCode === "string" && /^[A-Za-z][A-Za-z0-9_:-]{0,127}$/.test(rawCode)
      ? rawCode.toUpperCase()
      : fallbackCode
    if (code === "HOST_BINDING_REQUIRED" || code === "CONNECTION_DISPATCH_SCOPE_REQUIRED") {
      return new EndpointFailure("APC_HOST_BINDING_REQUIRED", "The host dispatch scope is unavailable", true)
    }
    if (code === "DESCRIPTOR_INVALID" || code === "INVALID_CONNECTION") {
      return new EndpointFailure("APC_CONNECTION_INVALID", "The requested connection cannot be used")
    }
    if (code === "PRESET_NOT_FOUND" || code === "PRESET_MISSING") {
      return new EndpointFailure("APC_PRESET_NOT_FOUND", "The requested preset was not found")
    }
    if (code === "INVALID_PRESET" || code.includes("METADATA")) {
      return new EndpointFailure("APC_CONFIG_INVALID", "The APC preset metadata is malformed")
    }
    if (code === "MISSING_BINDING") {
      return new EndpointFailure("APC_BINDING_REQUIRED", "The requested APC slot is not bound")
    }
    if (code === "REVOKED_CONSENT" || code === "MISSING_CONSENT") {
      return new EndpointFailure("APC_CONSENT_REQUIRED", "Consent is required for this dispatch")
    }
    if (
      code === "REVISION_MISMATCH" ||
      code.includes("REVISION") ||
      code === "STALE_DOCUMENT" ||
      code === "STALE_BINDING" ||
      code === "STALE_CONSENT"
    ) {
      return new EndpointFailure("APC_STALE_REVISION", "The APC document changed; reload before saving", true)
    }
    if (code === "SLOT_LIMIT") {
      return new EndpointFailure("APC_ADMISSION_CONFLICT", "Connection slot capacity is full")
    }
    if (
      code.includes("ADMISSION") ||
      code === "ALREADY_ACTIVE" ||
      code === "USER_PRESET_CAPACITY" ||
      code === "GLOBAL_CAPACITY" ||
      code === "DUPLICATE_BINDING" ||
      code === "DUPLICATE_CONSENT"
    ) {
      return new EndpointFailure("APC_ADMISSION_CONFLICT", "The APC execution is already active or at capacity", true)
    }
    if (code === "WRONG_USER") {
      return new EndpointFailure("APC_SCOPE_MISMATCH", "The requested APC resource is outside this user scope")
    }
    if (code === "MISSING_DISCLOSURE") {
      return new EndpointFailure("APC_CONSENT_REQUIRED", "Consent must be approved from a current disclosure")
    }
    if (code === "CONNECTION_NOT_FOUND") {
      return new EndpointFailure("APC_CONNECTION_NOT_FOUND", "The requested connection is unavailable")
    }
    if (code === "NOT_FOUND" || code.includes("TRACE_NOT_FOUND")) {
      return new EndpointFailure("APC_TRACE_NOT_FOUND", "The requested APC trace was not found")
    }
    if (code.includes("INSTALL") || code.includes("SCOPE") || code === "NOT_INITIALIZED") {
      return new EndpointFailure("APC_INSTALL_SCOPE", "The APC installation scope is unavailable")
    }
  }
  return new EndpointFailure(fallbackCode, fallbackMessage)
}

function responseError(
  correlationId: string,
  code: string,
  _message: string,
  retryable: boolean,
  sequence?: number,
  details?: readonly Readonly<{ path: string; reason: string }>[],
): BackendErrorResponse {
  const boundedDetails = details === undefined
    ? undefined
    : Object.freeze(details.slice(0, MAX_ERROR_DETAILS).map(detail => Object.freeze({
        path: truncateUtf8(detail.path, 512),
        reason: truncateUtf8(detail.reason, 1_024),
      })))
  const safeCode = /^[A-Z][A-Z0-9_:-]{0,63}$/.test(code) ? code : "APC_INTERNAL_ERROR"
  const payload = {
    code: safeCode,
    messageKey: safeCode,
    retryable: Boolean(retryable),
    ...(boundedDetails === undefined ? {} : { details: boundedDetails }),
  }
  return Object.freeze({
    version: 1 as const,
    type: "error" as const,
    correlationId,
    ...(sequence === undefined ? {} : { sequence }),
    payload: Object.freeze(payload),
  })
}
function traceEntryMetadataString(entry: TraceSnapshot["entries"][number], key: string): string | undefined {
  const value = entry.metadata[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function traceEntryMetadataNumber(entry: TraceSnapshot["entries"][number], key: string): number | undefined {
  const value = entry.metadata[key]
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function terminalTraceEntry(trace: TraceSnapshot): TraceSnapshot["entries"][number] | undefined {
  return [...trace.entries].reverse().find(entry =>
    traceEntryMetadataString(entry, "outcome") !== undefined ||
    traceEntryMetadataString(entry, "status") === "completed" ||
    traceEntryMetadataString(entry, "status") === "cancelled" ||
    traceEntryMetadataString(entry, "status") === "failed"
  )
}

function mapTraceStatus(trace: TraceSnapshot): "running" | "completed" | "failed" | "cancelled" {
  const terminal = terminalTraceEntry(trace)
  const outcome = terminal === undefined ? undefined : traceEntryMetadataString(terminal, "outcome")
  if (outcome === "integrity-fatal" || outcome === "selected-final-failure" || outcome === "graph-fallback") return "failed"
  if (outcome === "parent-cancel" || trace.status === "cancelled") return "cancelled"
  if (outcome === "success" || outcome === "optional-local" || trace.status === "completed") return "completed"
  return "running"
}

function traceIdFor(trace: TraceSnapshot): string {
  const candidate = trace.metadata.traceId
  return typeof candidate === "string" && UUID_PATTERN.test(candidate) ? candidate : trace.executionId
}

function traceSummary(trace: TraceSnapshot): TraceSummary {
  const first = trace.entries[0]
  const terminal = terminalTraceEntry(trace)
  const startedAt = first === undefined ? 0 : traceEntryMetadataNumber(first, "timestamp") ?? 0
  const finishedAt = terminal === undefined ? undefined : traceEntryMetadataNumber(terminal, "finishedAt") ?? traceEntryMetadataNumber(terminal, "timestamp")
  const preview = boundedPreview(first?.preview)
  const truncated = trace.entryCount > MAX_TRACE_EVENTS || trace.entries.some(entry => entry.previewTruncated) || trace.bytes >= MAX_TRACE_BYTES
  return Object.freeze({
    traceId: traceIdFor(trace),
    executionId: trace.executionId,
    presetId: trace.presetId,
    status: mapTraceStatus(trace),
    startedAt,
    ...(finishedAt === undefined ? {} : { finishedAt }),
    eventCount: Math.min(MAX_TRACE_EVENTS, trace.entryCount),
    ...(preview === undefined ? {} : { preview }),
    ...(truncated ? { truncated: true } : {}),
  })
}

function traceEvent(trace: TraceSnapshot, index: number): TraceEvent {
  const entry = trace.entries[index]
  const timestamp = traceEntryMetadataNumber(entry, "timestamp") ?? 0
  const runId = traceEntryMetadataString(entry, "runId")
  const stageId = traceEntryMetadataString(entry, "stageId")
  const status = traceEntryMetadataString(entry, "status")
  return Object.freeze({
    kind: entry.kind,
    sequence: entry.sequence,
    timestamp,
    ...(status === undefined ? {} : { status: truncateUtf8(status, 128) }),
    ...(runId !== undefined && UUID_PATTERN.test(runId) ? { runId } : {}),
    ...(stageId !== undefined && UUID_PATTERN.test(stageId) ? { stageId } : {}),
    ...(entry.preview.length === 0 ? {} : { preview: boundedPreview(entry.preview) }),
  })
}

function traceDetail(trace: TraceSnapshot): BackendTraceDetailResponse["payload"]["trace"] {
  const summary = traceSummary(trace)
  let events = trace.entries
    .slice(0, MAX_TRACE_EVENTS)
    .map((_, index) => traceEvent(trace, index))
  let detail: BackendTraceDetailResponse["payload"]["trace"] = Object.freeze({ ...summary, events: Object.freeze(events) })
  while (events.length > 0) {
    const size = serializedUtf8Bytes({ trace: detail })
    if (size.ok && size.bytes <= MAX_TRACE_BYTES) break
    events = events.slice(0, -1)
    detail = Object.freeze({ ...summary, truncated: true, events: Object.freeze(events) })
  }
  if (events.length === 0) {
    detail = Object.freeze({ ...summary, truncated: true, events: Object.freeze([]) })
  }
  return detail
}

function validTraceResponse(value: BackendTraceListResponse | BackendTraceDetailResponse): BackendTraceListResponse | BackendTraceDetailResponse {
  const size = serializedUtf8Bytes(value.payload)
  if (!size.ok || size.bytes > MAX_TRACE_BYTES) {
    throw new EndpointFailure("APC_TRACE_BOUNDS", "Trace response exceeds the size limit")
  }
  return value
}

function nextSequence(ledgers: Map<string, { lastSequence: number; accept(sequence: number): boolean }>, userId: string): number {
  let ledger = ledgers.get(userId)
  if (ledger === undefined) {
    ledger = {
      lastSequence: 0,
      accept(sequence: number): boolean {
        if (!Number.isSafeInteger(sequence) || sequence <= this.lastSequence) return false
        this.lastSequence = sequence
        return true
      },
    }
    ledgers.set(userId, ledger)
  }
  const next = ledger.lastSequence + 1
  if (!ledger.accept(next)) throw new EndpointFailure("APC_SEQUENCE_EXHAUSTED", "Response sequence is exhausted")
  return next
}


function ensureInstallScope(state: BackendInstallState): BackendInstallPair {
  let pair: BackendInstallPair
  try {
    pair = state.getInstallPair()
  } catch (error) {
    throw normalizeFailure(error, "APC_INSTALL_SCOPE", "The APC installation scope is unavailable")
  }
  if (
    pair === null ||
    typeof pair !== "object" ||
    typeof pair.extensionInstallationId !== "string" ||
    typeof pair.installNonce !== "string" ||
    !UUID_PATTERN.test(pair.extensionInstallationId) ||
    !OPAQUE_TOKEN_PATTERN.test(pair.installNonce)
  ) {
    throw new EndpointFailure("APC_INSTALL_SCOPE", "The APC installation scope is unavailable")
  }
  return Object.freeze({
    extensionInstallationId: pair.extensionInstallationId,
    installNonce: pair.installNonce,
  })
}


function connectionLabel(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    utf8Bytes(value) > 320 ||
    /[\u0000-\u001f\u007f\r\n]/u.test(value)
  ) {
    throw new EndpointFailure("APC_CONNECTIONS_INVALID", `Host connection ${field} is invalid`)
  }
  return value
}

function connectionResponse(
  correlationId: string,
  sequence: number,
  profiles: unknown,
): BackendConnectionListResponse {
  if (!Array.isArray(profiles) || profiles.length > MAX_CONNECTIONS) {
    throw new EndpointFailure("APC_CONNECTIONS_INVALID", "Host connections are invalid")
  }
  const seen = new Set<string>()
  const connections: ConnectionSummary[] = []
  for (const profile of profiles) {
    if (profile === null || typeof profile !== "object" || Array.isArray(profile)) {
      throw new EndpointFailure("APC_CONNECTIONS_INVALID", "Host connection is invalid")
    }
    const record = profile as Record<string, unknown>
    if (typeof record.id !== "string" || !UUID_PATTERN.test(record.id)) {
      throw new EndpointFailure("APC_CONNECTIONS_INVALID", "Host connection ID is invalid")
    }
    if (seen.has(record.id)) continue
    seen.add(record.id)
    connections.push(Object.freeze({
      id: record.id,
      name: connectionLabel(record.name, "name"),
      provider: connectionLabel(record.provider, "provider"),
      model: connectionLabel(record.model, "model"),
    }))
  }
  return Object.freeze({
    version: 1 as const,
    type: "connections" as const,
    correlationId,
    sequence,
    payload: Object.freeze({ connections: Object.freeze(connections) }),
  })
}

function connectionSummaries(profiles: unknown): readonly ConnectionSummary[] {
  return connectionResponse(FALLBACK_CORRELATION_ID, 1, profiles).payload.connections
}
function ensureSameIdentity(expected: string, actual: unknown, label: string): void {
  if (actual !== expected) throw new EndpointFailure("APC_SCOPE_MISMATCH", `${label} scope mismatch`)
}

function validateConsentRecord(
  record: ConsentSnapshot["consents"][number],
  install: BackendInstallPair,
  presetId: string,
): void {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new EndpointFailure("APC_CONSENT_INVALID", "Host consent record is invalid")
  }
  ensureSameIdentity(install.extensionInstallationId, record.installId, "consent installation")
  ensureSameIdentity(install.installNonce, record.nonce, "consent nonce")
  ensureSameIdentity(presetId, record.presetId, "consent preset")
  if (
    typeof record.threadId !== "string" ||
    utf8Bytes(record.threadId) > MAX_CONSENT_THREAD_BYTES ||
    (record.threadId !== "main" && !UUID_PATTERN.test(record.threadId))
  ) {
    throw new EndpointFailure("APC_CONSENT_INVALID", "Host consent thread is invalid")
  }
  if (record.workspaceSource !== "native-blocks" && record.workspaceSource !== "main-context") {
    throw new EndpointFailure("APC_CONSENT_INVALID", "Host consent workspace is invalid")
  }
  if (
    record.connectionSourceKey !== "main" &&
    (typeof record.connectionSourceKey !== "string" || !CONSENT_SLOT_SOURCE_PATTERN.test(record.connectionSourceKey))
  ) {
    throw new EndpointFailure("APC_CONSENT_INVALID", "Host consent source is invalid")
  }
  if (record.connectionSourceKey === "main") {
    if (record.connectionId !== null) {
      throw new EndpointFailure("APC_CONSENT_INVALID", "Main consent has a connection ID")
    }
  } else if (typeof record.connectionId !== "string" || !UUID_PATTERN.test(record.connectionId)) {
    throw new EndpointFailure("APC_CONSENT_INVALID", "Slot consent connection is invalid")
  }
  if (typeof record.dispatchRevision !== "string" || !CONSENT_REVISION_PATTERN.test(record.dispatchRevision)) {
    throw new EndpointFailure("APC_CONSENT_INVALID", "Host consent revision is invalid")
  }
  if (
    !Number.isSafeInteger(record.disclosureVersion) ||
    record.disclosureVersion <= 0 ||
    record.disclosureVersion > MAX_CONSENT_DISCLOSURE_VERSION
  ) {
    throw new EndpointFailure("APC_CONSENT_INVALID", "Host consent version is invalid")
  }
}

function validateConsentSnapshot(
  snapshot: ConsentSnapshot,
  install: BackendInstallPair,
  presetId: string,
): void {
  if (
    snapshot === null ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot) ||
    !Number.isSafeInteger(snapshot.documentRevision) ||
    snapshot.documentRevision < 0 ||
    !Array.isArray(snapshot.consents) ||
    snapshot.consents.length > MAX_CONSENT_VIEWS
  ) {
    throw new EndpointFailure("APC_CONSENT_INVALID", "Host consent snapshot is invalid")
  }
  ensureSameIdentity(presetId, snapshot.presetId, "consent preset")
  ensureSameIdentity(install.extensionInstallationId, snapshot.installId, "consent installation")
  ensureSameIdentity(install.installNonce, snapshot.installNonce, "consent nonce")
  for (const record of snapshot.consents) validateConsentRecord(record, install, presetId)
}

function validateConsentDisclosure(
  disclosure: ConsentDisclosure,
  userId: string,
  selector: ProtocolConsentSelector,
): void {
  if (disclosure === null || typeof disclosure !== "object" || Array.isArray(disclosure)) {
    throw new EndpointFailure("APC_CONSENT_INVALID", "Host consent disclosure is invalid")
  }
  ensureSameIdentity(userId, disclosure.userId, "disclosure user")
  ensureSameIdentity(selector.presetId, disclosure.presetId, "disclosure preset")
  ensureSameIdentity(selector.threadId, disclosure.threadId, "disclosure thread")
  ensureSameIdentity(selector.workspaceSource, disclosure.workspaceSource, "disclosure workspace")
  ensureSameIdentity(selector.connectionSourceKey, disclosure.connectionSourceKey, "disclosure source")
  if (
    typeof disclosure.threadId !== "string" ||
    utf8Bytes(disclosure.threadId) > MAX_CONSENT_THREAD_BYTES ||
    (disclosure.threadId !== "main" && !UUID_PATTERN.test(disclosure.threadId))
  ) {
    throw new EndpointFailure("APC_CONSENT_INVALID", "Host consent thread is invalid")
  }
  if (disclosure.connectionSourceKey === "main") {
    if (disclosure.connectionId !== null) {
      throw new EndpointFailure("APC_CONSENT_INVALID", "Main disclosure has a connection ID")
    }
  } else if (typeof disclosure.connectionId !== "string" || !UUID_PATTERN.test(disclosure.connectionId)) {
    throw new EndpointFailure("APC_CONSENT_INVALID", "Slot disclosure connection is invalid")
  }
  const descriptor = disclosure.descriptor
  if (descriptor === null || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    throw new EndpointFailure("APC_CONSENT_INVALID", "Host consent descriptor is invalid")
  }
  if (typeof descriptor.connectionId !== "string" || !UUID_PATTERN.test(descriptor.connectionId)) {
    throw new EndpointFailure("APC_CONSENT_INVALID", "Host consent descriptor connection is invalid")
  }
  if (disclosure.connectionSourceKey !== "main") {
    ensureSameIdentity(disclosure.connectionId as string, descriptor.connectionId, "disclosure connection")
  }
  if (
    typeof descriptor.connectionDispatchRevision !== "string" ||
    !CONSENT_REVISION_PATTERN.test(descriptor.connectionDispatchRevision)
  ) {
    throw new EndpointFailure("APC_CONSENT_INVALID", "Host consent descriptor revision is invalid")
  }
  const disclosureVersion = disclosure.disclosureVersion
  if (
    typeof disclosureVersion !== "number" ||
    !Number.isSafeInteger(disclosureVersion) ||
    disclosureVersion <= 0 ||
    disclosureVersion > MAX_CONSENT_DISCLOSURE_VERSION
  ) {
    throw new EndpointFailure("APC_CONSENT_INVALID", "Host consent disclosure version is invalid")
  }
  connectionLabel(descriptor.connectionName, "name")
  connectionLabel(descriptor.provider, "provider")
  connectionLabel(descriptor.model, "model")
}

async function rememberSlotDisclosure(
  userId: string,
  selector: ProtocolConsentSelector,
  install: BackendInstallPair,
  bindings: BackendBindingService,
  consent: BackendConsentService,
): Promise<ConsentDisclosure | undefined> {
  if (selector.connectionSourceKey === "main") {
    return consent.resolveDisclosure(userId, selector)
  }
  const resolveSlot = bindings.resolveSlot
  if (resolveSlot === undefined) return undefined
  const slotId = selector.connectionSourceKey.slice(5)
  let resolved: unknown
  try {
    resolved = await resolveSlot({ userId, presetId: selector.presetId, slotId })
  } catch (error) {
    const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined
    if (code === "MISSING_BINDING" || code === "STALE_BINDING" || code === "CONNECTION_NOT_FOUND") return undefined
    throw error
  }
  if (resolved === null || typeof resolved !== "object" || Array.isArray(resolved)) return undefined
  const binding = resolved as ResolvedDispatchBinding
  ensureSameIdentity(userId, binding.userId, "resolved user")
  ensureSameIdentity(selector.presetId, binding.presetId, "resolved preset")
  ensureSameIdentity(slotId, binding.slotId, "resolved slot")
  ensureSameIdentity(selector.connectionSourceKey, binding.connectionSourceKey, "resolved source")
  ensureSameIdentity(install.extensionInstallationId, binding.installId, "resolved installation")
  ensureSameIdentity(install.installNonce, binding.installNonce, "resolved installation nonce")
  ensureSameIdentity(binding.connectionId, binding.descriptor.connectionId, "descriptor connection")
  ensureSameIdentity(binding.dispatchRevision, binding.descriptor.connectionDispatchRevision, "descriptor revision")
  return consent.rememberDisclosure({
    userId,
    presetId: selector.presetId,
    threadId: selector.threadId,
    workspaceSource: selector.workspaceSource,
    connectionSourceKey: selector.connectionSourceKey,
    connectionId: binding.connectionId,
    descriptor: binding.descriptor,
    disclosureVersion: 1,
  })
}

function destinationForConnection(
  connections: readonly ConnectionSummary[],
  connectionId: string | null | undefined,
): SafeDestination | undefined {
  if (connectionId === undefined || connectionId === null) return undefined
  const connection = connections.find(candidate => candidate.id === connectionId)
  if (connection === undefined) return undefined
  return Object.freeze({
    label: connection.name,
    provider: connection.provider,
    model: connection.model,
  })
}

function destinationForDisclosure(disclosure: ConsentDisclosure): SafeDestination {
  const descriptor = disclosure.descriptor
  return Object.freeze({
    label: connectionLabel(descriptor.connectionName, "name"),
    provider: connectionLabel(descriptor.provider, "provider"),
    model: connectionLabel(descriptor.model, "model"),
  })
}

function disclosureProjection(
  workspaceSource: "native-blocks" | "main-context",
  connectionSourceKey: "main" | `slot:${string}`,
  destination: SafeDestination | undefined,
  version: number,
): SafeConsentDisclosure {
  const extraCategories: readonly ConsentDisclosureCategory[] = workspaceSource === "main-context"
    ? ["main-context", "input-bindings", "prior-stage-outputs"]
    : ["input-bindings", "prior-stage-outputs"]
  const categories: ConsentDisclosureCategory[] = [
    "thread",
    "workspace",
    "source",
    "destination",
    "provider",
    "model",
    ...extraCategories,
  ]
  const destinationLabel = destination?.label ?? "the resolved destination"
  const sourceLabel = connectionSourceKey === "main" ? "authoritative Main" : "the selected connection slot"
  return Object.freeze({
    version,
    summary: `This thread's ${workspaceSource} content and configured inputs will be sent through ${sourceLabel} to ${destinationLabel}.`,
    categories: Object.freeze(categories),
  })
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function invalidBindingSnapshot(message: string): never {
  throw new EndpointFailure("APC_BINDING_INVALID", message)
}

function validateBindingRecords(value: unknown, presetId: string): BindingSnapshot["bindings"] {
  if (!Array.isArray(value) || value.length > MAX_BINDING_VIEWS) {
    return invalidBindingSnapshot("Host binding snapshot is invalid")
  }
  const seenSlots = new Set<string>()
  const seenConnections = new Set<string>()
  for (const candidate of value) {
    if (!isObjectRecord(candidate)) return invalidBindingSnapshot("Host binding record is invalid")
    const candidatePresetId = candidate.presetId
    const candidateSlotId = candidate.slotId
    const candidateSource = candidate.connectionSourceKey
    const candidateConnectionId = candidate.connectionId
    const candidateRevision = candidate.dispatchRevision
    if (
      typeof candidatePresetId !== "string" ||
      typeof candidateSlotId !== "string" ||
      typeof candidateSource !== "string" ||
      typeof candidateConnectionId !== "string" ||
      typeof candidateRevision !== "string" ||
      !UUID_PATTERN.test(candidatePresetId) ||
      !UUID_PATTERN.test(candidateSlotId) ||
      !UUID_PATTERN.test(candidateConnectionId) ||
      !CONSENT_REVISION_PATTERN.test(candidateRevision) ||
      candidateSource !== `slot:${candidateSlotId}`
    ) {
      return invalidBindingSnapshot("Host binding record identity is invalid")
    }
    ensureSameIdentity(presetId, candidatePresetId, "binding preset")
    if (seenSlots.has(candidateSlotId) || seenConnections.has(candidateConnectionId)) {
      return invalidBindingSnapshot("Host binding snapshot contains duplicate identities")
    }
    seenSlots.add(candidateSlotId)
    seenConnections.add(candidateConnectionId)
  }
  return value as BindingSnapshot["bindings"]
}


function validateMutationBindingSnapshot(
  value: unknown,
  userId: string,
  presetId: string,
  install: BackendInstallPair,
  slotId: string,
  expectedBound: boolean,
  expectedConnectionId?: string,
): {
  binding: BindingSnapshot["bindings"][number] | undefined
  descriptor?: HostDispatchDescriptor
} {
  if (!isObjectRecord(value)) return invalidBindingSnapshot("Host binding snapshot is invalid")
  if (
    typeof value.userId !== "string" ||
    typeof value.presetId !== "string" ||
    typeof value.installId !== "string" ||
    typeof value.installNonce !== "string" ||
    !UUID_PATTERN.test(value.presetId) ||
    !UUID_PATTERN.test(value.installId) ||
    !OPAQUE_TOKEN_PATTERN.test(value.installNonce) ||
    !Number.isSafeInteger(value.documentRevision) ||
    (value.documentRevision as number) < 0
  ) {
    return invalidBindingSnapshot("Host binding snapshot identity is invalid")
  }
  ensureSameIdentity(userId, value.userId, "binding user")
  ensureSameIdentity(presetId, value.presetId, "binding preset")
  ensureSameIdentity(install.extensionInstallationId, value.installId, "binding installation")
  ensureSameIdentity(install.installNonce, value.installNonce, "binding installation nonce")

  const bindings = validateBindingRecords(value.bindings, presetId)

  const binding = bindings.find(candidate => candidate.slotId === slotId)
  if (expectedBound && binding === undefined) {
    return invalidBindingSnapshot("Host bind snapshot does not contain the bound slot")
  }
  if (!expectedBound && binding !== undefined) {
    return invalidBindingSnapshot("Host unbind snapshot still contains the unbound slot")
  }
  if (!expectedBound) {
    if (value.descriptor !== undefined) {
      return invalidBindingSnapshot("Host unbind snapshot unexpectedly contains a descriptor")
    }
    return { binding: undefined }
  }

  const rawDescriptor = value.descriptor
  if (!isObjectRecord(rawDescriptor)) {
    return invalidBindingSnapshot("Host bind snapshot descriptor is missing")
  }
  if (
    rawDescriptor.dispatchKind !== "concrete" ||
    typeof rawDescriptor.connectionId !== "string" ||
    !UUID_PATTERN.test(rawDescriptor.connectionId) ||
    typeof rawDescriptor.connectionName !== "string" ||
    typeof rawDescriptor.provider !== "string" ||
    typeof rawDescriptor.model !== "string" ||
    typeof rawDescriptor.endpointOrigin !== "string" ||
    rawDescriptor.endpointOrigin.length === 0 ||
    utf8Bytes(rawDescriptor.endpointOrigin) > 2_048 ||
    /[\u0000-\u001f\u007f\r\n]/u.test(rawDescriptor.endpointOrigin) ||
    typeof rawDescriptor.connectionDispatchRevision !== "string" ||
    !CONSENT_REVISION_PATTERN.test(rawDescriptor.connectionDispatchRevision)
  ) {
    return invalidBindingSnapshot("Host bind snapshot descriptor is invalid")
  }
  if (binding === undefined) return invalidBindingSnapshot("Host bind snapshot is missing its target")
  if (expectedConnectionId !== undefined && binding.connectionId !== expectedConnectionId) {
    return invalidBindingSnapshot("Host bind snapshot connection does not match the requested connection")
  }
  if (binding.connectionId !== rawDescriptor.connectionId) {
    return invalidBindingSnapshot("Host bind snapshot descriptor connection does not match the binding")
  }
  if (binding.dispatchRevision !== rawDescriptor.connectionDispatchRevision) {
    return invalidBindingSnapshot("Host bind snapshot descriptor revision does not match the binding")
  }
  return { binding, descriptor: rawDescriptor as unknown as HostDispatchDescriptor }
}

function bindingViewFromDescriptor(
  binding: BindingSnapshot["bindings"][number],
  descriptor: HostDispatchDescriptor,
): SafeBindingView {
  return Object.freeze({
    slotId: binding.slotId,
    bound: true,
    status: "bound" as const,
    descriptor: Object.freeze({
      label: connectionLabel(descriptor.connectionName, "name"),
      provider: connectionLabel(descriptor.provider, "provider"),
      model: connectionLabel(descriptor.model, "model"),
    }),
  })
}

function normalizeBinding(
  snapshot: unknown,
  userId: string,
  presetId: string,
  slotId: string,
  install: BackendInstallPair,
  expectedBound: boolean,
  expectedConnectionId?: string,
): BackendBindingResponse["payload"] {
  const validated = validateMutationBindingSnapshot(
    snapshot,
    userId,
    presetId,
    install,
    slotId,
    expectedBound,
    expectedConnectionId,
  )
  if (!expectedBound) {
    return Object.freeze({ presetId, slotId, bound: false, status: "missing" as const })
  }
  if (validated.binding === undefined || validated.descriptor === undefined) {
    return invalidBindingSnapshot("Host bind snapshot is missing its projection data")
  }
  return Object.freeze({
    presetId,
    ...bindingViewFromDescriptor(validated.binding, validated.descriptor),
  })
}

async function normalizeBindingViews(
  snapshot: BindingSnapshot,
  userId: string,
  presetId: string,
  install: BackendInstallPair,
  bindings: BackendBindingService,
  connections: readonly ConnectionSummary[],
): Promise<readonly SafeBindingView[]> {
  if (
    !isObjectRecord(snapshot) ||
    !Number.isSafeInteger(snapshot.documentRevision) ||
    snapshot.documentRevision < 0
  ) {
    throw new EndpointFailure("APC_BINDING_INVALID", "Host binding snapshot is invalid")
  }
  ensureSameIdentity(userId, snapshot.userId, "binding user")
  ensureSameIdentity(presetId, snapshot.presetId, "binding preset")
  ensureSameIdentity(install.extensionInstallationId, snapshot.installId, "binding installation")
  ensureSameIdentity(install.installNonce, snapshot.installNonce, "binding installation nonce")
  const bindingRecords = validateBindingRecords(snapshot.bindings, presetId)
  const resolveSlot = bindings.resolveSlot
  return Object.freeze(await Promise.all(bindingRecords.map(async binding => {
    ensureSameIdentity(presetId, binding.presetId, "binding preset")
    ensureSameIdentity(`slot:${binding.slotId}`, binding.connectionSourceKey, "binding source")
    if (resolveSlot === undefined) {
      const destination = destinationForConnection(connections, binding.connectionId)
      return destination === undefined
        ? Object.freeze({ slotId: binding.slotId, bound: true, status: "stale" as const })
        : Object.freeze({ slotId: binding.slotId, bound: true, status: "bound" as const, descriptor: destination })
    }
    try {
      const resolved = await resolveSlot({ userId, presetId, slotId: binding.slotId })
      ensureSameIdentity(userId, resolved.userId, "resolved user")
      ensureSameIdentity(presetId, resolved.presetId, "resolved preset")
      ensureSameIdentity(binding.slotId, resolved.slotId, "resolved slot")
      ensureSameIdentity(`slot:${binding.slotId}`, resolved.connectionSourceKey, "resolved source")
      ensureSameIdentity(binding.connectionId, resolved.connectionId, "resolved connection")
      ensureSameIdentity(binding.dispatchRevision, resolved.dispatchRevision, "resolved revision")
      ensureSameIdentity(resolved.connectionId, resolved.descriptor.connectionId, "descriptor connection")
      ensureSameIdentity(resolved.dispatchRevision, resolved.descriptor.connectionDispatchRevision, "descriptor revision")
      return Object.freeze({
        slotId: binding.slotId,
        bound: true,
        status: "bound" as const,
        descriptor: Object.freeze({
          label: connectionLabel(resolved.descriptor.connectionName, "name"),
          provider: connectionLabel(resolved.descriptor.provider, "provider"),
          model: connectionLabel(resolved.descriptor.model, "model"),
        }),
      })
    } catch (error) {
      const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
        ? error.code
        : undefined
      if (code === "MISSING_BINDING") {
        return Object.freeze({ slotId: binding.slotId, bound: false, status: "missing" as const })
      }
      if (code === "STALE_BINDING" || code === "CONNECTION_NOT_FOUND") {
        return Object.freeze({ slotId: binding.slotId, bound: true, status: "stale" as const })
      }
      throw error
    }
  })))
}

function normalizeConsent(
  snapshot: ConsentSnapshot,
  selector: ProtocolConsentSelector,
  install: BackendInstallPair,
  status: "approved" | "revoked" | "required",
  _connections: readonly ConnectionSummary[],
  disclosure: ConsentDisclosure | undefined,
): BackendConsentResponse["payload"] {
  validateConsentSnapshot(snapshot, install, selector.presetId)
  if (disclosure !== undefined) validateConsentDisclosure(disclosure, snapshot.userId, selector)
  ensureSameIdentity(selector.presetId, snapshot.presetId, "preset")
  ensureSameIdentity(install.extensionInstallationId, snapshot.installId, "installation")
  ensureSameIdentity(install.installNonce, snapshot.installNonce, "installation nonce")
  const record = snapshot.consents.find(candidate =>
    candidate.presetId === selector.presetId &&
    candidate.threadId === selector.threadId &&
    candidate.workspaceSource === selector.workspaceSource &&
    candidate.connectionSourceKey === selector.connectionSourceKey
  )
  if (status === "approved" && (
    record === undefined ||
    disclosure === undefined ||
    record.threadId !== disclosure.threadId ||
    record.workspaceSource !== disclosure.workspaceSource ||
    record.connectionSourceKey !== disclosure.connectionSourceKey ||
    record.connectionId !== disclosure.connectionId ||
    record.dispatchRevision !== disclosure.descriptor.connectionDispatchRevision ||
    record.disclosureVersion !== disclosure.disclosureVersion
  )) {
    throw new EndpointFailure("APC_CONSENT_REQUIRED", "Consent requires the current disclosure")
  }
  const destination = disclosure === undefined ? undefined : destinationForDisclosure(disclosure)
  let disclosureView: SafeConsentDisclosure | undefined
  if (disclosure !== undefined) {
    const version = disclosure.disclosureVersion
    if (version === undefined) throw new EndpointFailure("APC_CONSENT_REQUIRED", "Consent disclosure version is unavailable")
    disclosureView = disclosureProjection(selector.workspaceSource, selector.connectionSourceKey, destination, version)
  }
  return Object.freeze({
    presetId: selector.presetId,
    threadId: selector.threadId,
    workspaceSource: selector.workspaceSource,
    connectionSourceKey: selector.connectionSourceKey,
    status,
    ...(destination === undefined ? {} : { destination }),
    ...(disclosureView === undefined ? {} : { disclosure: disclosureView }),
  })
}

function normalizeConsentViews(
  snapshot: ConsentSnapshot,
  presetId: string,
  install: BackendInstallPair,
  connections: readonly ConnectionSummary[],
  resolveDisclosure: (selector: ProtocolConsentSelector) => ConsentDisclosure | undefined,
): readonly SafeConsentView[] {
  validateConsentSnapshot(snapshot, install, presetId)
  return Object.freeze(snapshot.consents.map(record => {
    const selector: ProtocolConsentSelector = {
      presetId,
      threadId: record.threadId,
      workspaceSource: record.workspaceSource,
      connectionSourceKey: record.connectionSourceKey,
    }
    const disclosure = resolveDisclosure(selector)
    if (disclosure !== undefined) validateConsentDisclosure(disclosure, snapshot.userId, selector)
    const current = disclosure !== undefined &&
      record.connectionId === disclosure.connectionId &&
      record.dispatchRevision === disclosure.descriptor.connectionDispatchRevision &&
      record.disclosureVersion === disclosure.disclosureVersion
    return normalizeConsent(snapshot, selector, install, current ? "approved" : "required", connections, disclosure)
  }))
}

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0
  if (utf8Bytes(cursor) > MAX_CURSOR_BYTES || !CURSOR_PATTERN.test(cursor)) {
    throw new EndpointFailure("APC_CURSOR_INVALID", "Trace cursor is invalid")
  }
  const offset = Number(cursor)
  if (!Number.isSafeInteger(offset) || offset < 0) throw new EndpointFailure("APC_CURSOR_INVALID", "Trace cursor is invalid")
  return offset
}

function buildTraceList(
  traces: readonly TraceSnapshot[],
  limit: number,
  cursor: string | undefined,
  executionId: string | undefined,
): BackendTraceListResponse["payload"] {
  const filtered = executionId === undefined
    ? traces
    : traces.filter(trace => trace.executionId === executionId)
  const offset = parseCursor(cursor)
  const selected: TraceSummary[] = []
  let index = offset
  while (index < filtered.length && selected.length < Math.min(limit, MAX_TRACE_LIST_ITEMS)) {
    selected.push(traceSummary(filtered[index]))
    index += 1
  }
  let payload: BackendTraceListResponse["payload"] = Object.freeze({
    traces: Object.freeze(selected),
    ...(index < filtered.length ? { nextCursor: String(index) } : {}),
  })
  while (selected.length > 0) {
    const size = serializedUtf8Bytes(payload)
    if (size.ok && size.bytes <= MAX_TRACE_BYTES) break
    selected.pop()
    payload = Object.freeze({
      traces: Object.freeze(selected),
      ...(index < filtered.length ? { nextCursor: String(offset + selected.length) } : {}),
    })
  }
  const size = serializedUtf8Bytes(payload)
  if (!size.ok || size.bytes > MAX_TRACE_BYTES) {
    throw new EndpointFailure("APC_TRACE_BOUNDS", "Trace list exceeds the size limit")
  }
  return payload
}

function traceForExecution(traces: TraceStore, userId: string, presetId: string, executionId: string): TraceSnapshot {
  const current = traces.get(userId, presetId, executionId)
  if (current === undefined) throw new EndpointFailure("APC_TRACE_NOT_FOUND", "The requested APC execution was not found")
  return current
}

export function createBackendEndpointRouter(deps: BackendEndpointDependencies): BackendEndpointRouter {
  const ledgers = new Map<string, { lastSequence: number; accept(sequence: number): boolean }>()
  let disposed = false

  const errorFor = (correlationId: string, userId: string | undefined, error: unknown): BackendErrorResponse => {
    const failure = normalizeFailure(error, "APC_INTERNAL_ERROR")
    let sequence: number | undefined
    if (userId !== undefined && userId.length > 0) {
      try {
        sequence = nextSequence(ledgers, userId)
      } catch {
        sequence = undefined
      }
    }
    return responseError(correlationId, failure.code, failure.message, failure.retryable, sequence, failure.details)
  }

  const dispatch = async (scope: BackendEndpointScope, intent: FrontendIntent): Promise<BackendResponse> => {
    const userId = safeUserId(scope)
    if (disposed) throw new EndpointFailure("APC_ROUTER_DISPOSED", "APC backend router is disposed")
    const sequence = () => nextSequence(ledgers, userId)
    switch (intent.type) {

      case "list_connections": {
        ensureInstallScope(deps.state)
        const profiles = await deps.bindings.listConnections(userId)
        return connectionResponse(intent.correlationId, sequence(), profiles)
      }
      case "hydrate_preset": {
        const install = ensureInstallScope(deps.state)
        const [bindingSnapshot, consentSnapshot, profiles] = await Promise.all([
          deps.bindings.listBindings(userId, intent.payload.presetId),
          deps.consent.listConsents(userId, intent.payload.presetId),
          deps.bindings.listConnections(userId),
        ])
        ensureSameIdentity(userId, bindingSnapshot.userId, "binding user")
        ensureSameIdentity(userId, consentSnapshot.userId, "consent user")
        validateConsentSnapshot(consentSnapshot, install, intent.payload.presetId)
        const connections = connectionSummaries(profiles)
        const execution = deps.execution.currentExecution(userId, intent.payload.presetId)
        if (execution !== undefined) ensureSameIdentity(intent.payload.presetId, execution.presetId, "execution preset")
        const payload: BackendHydrationResponse["payload"] = Object.freeze({
          presetId: intent.payload.presetId,
          bindings: await normalizeBindingViews(bindingSnapshot, userId, intent.payload.presetId, install, deps.bindings, connections),
          consents: normalizeConsentViews(
            consentSnapshot,
            intent.payload.presetId,
            install,
            connections,
            selector => deps.consent.resolveDisclosure(userId, selector),
          ),
          ...(execution === undefined ? {} : { execution }),
        })
        return Object.freeze({
          version: 1 as const,
          type: "hydration" as const,
          correlationId: intent.correlationId,
          sequence: sequence(),
          payload,
        })
      }
      case "bind_slot": {
        const install = ensureInstallScope(deps.state)
        deps.onAuthorizedMutation?.(userId, intent.payload.presetId)
        let snapshot: BindingSnapshot
        try {
          snapshot = await deps.bindings.bindSlot({
            userId,
            presetId: intent.payload.presetId,
            slotId: intent.payload.slotId,
            connectionId: intent.payload.patch.connectionId,
          })
        } finally {
          deps.onAuthorizedMutation?.(userId, intent.payload.presetId)
        }
        const payload = normalizeBinding(
          snapshot,
          userId,
          intent.payload.presetId,
          intent.payload.slotId,
          install,
          true,
          intent.payload.patch.connectionId,
        )
        return Object.freeze({ version: 1 as const, type: "binding" as const, correlationId: intent.correlationId, sequence: sequence(), payload })
      }
      case "unbind_slot": {
        const install = ensureInstallScope(deps.state)
        deps.onAuthorizedMutation?.(userId, intent.payload.presetId)
        let snapshot: BindingSnapshot
        try {
          snapshot = await deps.bindings.unbindSlot({
            userId,
            presetId: intent.payload.presetId,
            slotId: intent.payload.slotId,
          })
        } finally {
          deps.onAuthorizedMutation?.(userId, intent.payload.presetId)
        }
        const payload = normalizeBinding(
          snapshot,
          userId,
          intent.payload.presetId,
          intent.payload.slotId,
          install,
          false,
        )
        return Object.freeze({ version: 1 as const, type: "binding" as const, correlationId: intent.correlationId, sequence: sequence(), payload })
      }
      case "approve_consent": {
        const install = ensureInstallScope(deps.state)
        const disclosure = deps.consent.resolveDisclosure(userId, intent.payload)
        if (disclosure === undefined) throw new EndpointFailure("APC_CONSENT_REQUIRED", "Consent requires a current disclosure")
        validateConsentDisclosure(disclosure, userId, intent.payload)
        deps.onAuthorizedMutation?.(userId, intent.payload.presetId)
        let snapshot: ConsentSnapshot
        try {
          snapshot = await deps.consent.approveBySelector(userId, intent.payload)
        } finally {
          deps.onAuthorizedMutation?.(userId, intent.payload.presetId)
        }
        ensureSameIdentity(userId, snapshot.userId, "user")
        const profiles = await deps.bindings.listConnections(userId)
        const payload = normalizeConsent(
          snapshot,
          intent.payload,
          install,
          "approved",
          connectionSummaries(profiles),
          disclosure,
        )
        return Object.freeze({ version: 1 as const, type: "consent" as const, correlationId: intent.correlationId, sequence: sequence(), payload })
      }
      case "revoke_consent": {
        const install = ensureInstallScope(deps.state)
        let disclosure = deps.consent.resolveDisclosure(userId, intent.payload)
        if (disclosure !== undefined) validateConsentDisclosure(disclosure, userId, intent.payload)
        deps.onAuthorizedMutation?.(userId, intent.payload.presetId)
        let snapshot: ConsentSnapshot
        try {
          snapshot = await deps.consent.revoke({ userId, selector: intent.payload })
        } finally {
          deps.onAuthorizedMutation?.(userId, intent.payload.presetId)
        }
        disclosure = deps.consent.resolveDisclosure(userId, intent.payload)
        ensureSameIdentity(userId, snapshot.userId, "user")
        const profiles = await deps.bindings.listConnections(userId)
        const payload = normalizeConsent(
          snapshot,
          intent.payload,
          install,
          "revoked",
          connectionSummaries(profiles),
          disclosure,
        )
        return Object.freeze({ version: 1 as const, type: "consent" as const, correlationId: intent.correlationId, sequence: sequence(), payload })
      }
      case "resolve_consent": {
        const install = ensureInstallScope(deps.state)
        const snapshot = await deps.consent.listConsents(userId, intent.payload.presetId)
        ensureSameIdentity(userId, snapshot.userId, "user")
        validateConsentSnapshot(snapshot, install, intent.payload.presetId)
        const profiles = connectionSummaries(await deps.bindings.listConnections(userId))
        const disclosure = await rememberSlotDisclosure(userId, intent.payload, install, deps.bindings, deps.consent)
        if (disclosure !== undefined) validateConsentDisclosure(disclosure, userId, intent.payload)
        const approved = disclosure !== undefined && snapshot.consents.some(record =>
          record.threadId === intent.payload.threadId &&
          record.workspaceSource === intent.payload.workspaceSource &&
          record.connectionSourceKey === intent.payload.connectionSourceKey &&
          record.connectionId === disclosure.connectionId &&
          record.dispatchRevision === disclosure.descriptor.connectionDispatchRevision &&
          record.disclosureVersion === disclosure.disclosureVersion
        )
        const payload = normalizeConsent(
          snapshot,
          intent.payload,
          install,
          approved ? "approved" : "required",
          profiles,
          disclosure,
        )
        return Object.freeze({ version: 1 as const, type: "consent" as const, correlationId: intent.correlationId, sequence: sequence(), payload })
      }
      case "list_traces": {
        ensureInstallScope(deps.state)
        const traces = deps.traces.list(userId, intent.payload.presetId)
        const payload = buildTraceList(traces, intent.payload.limit ?? DEFAULT_TRACE_LIMIT, intent.payload.cursor, intent.payload.executionId)
        const response = Object.freeze({ version: 1 as const, type: "trace" as const, correlationId: intent.correlationId, sequence: sequence(), payload })
        return validTraceResponse(response)
      }
      case "get_trace": {
        ensureInstallScope(deps.state)
        const trace = traceForExecution(deps.traces, userId, intent.payload.presetId, intent.payload.executionId)
        ensureSameIdentity(intent.payload.traceId, traceIdFor(trace), "trace")
        const detail = traceDetail(trace)
        const response = Object.freeze({
          version: 1 as const,
          type: "trace" as const,
          correlationId: intent.correlationId,
          sequence: sequence(),
          payload: Object.freeze({ trace: detail }),
        })
        return validTraceResponse(response)
      }
      case "cancel_execution": {
        const install = ensureInstallScope(deps.state)
        const trace = traceForExecution(deps.traces, userId, intent.payload.presetId, intent.payload.executionId)
        const admission = deps.admission.get(userId, trace.presetId, intent.payload.executionId)
        const reason = intent.payload.reason ?? "user"
        if (admission === undefined) {
          const payload: BackendCancellationResponse["payload"] = Object.freeze({
            executionId: intent.payload.executionId,
            presetId: intent.payload.presetId,
            accepted: false,
            status: "already-terminal",
            cancellationSource: reason,
          })
          return Object.freeze({
            version: 1 as const,
            type: "cancellation" as const,
            correlationId: intent.correlationId,
            sequence: sequence(),
            payload,
          })
        }
        const result = await deps.execution.cancel({
          userId,
          presetId: trace.presetId,
          executionId: intent.payload.executionId,
          reason,
          install,
        })
        const executionId = result.executionId ?? intent.payload.executionId
        const presetId = result.presetId ?? trace.presetId
        ensureSameIdentity(trace.executionId, executionId, "execution")
        ensureSameIdentity(trace.presetId, presetId, "preset")
        const payload: BackendCancellationResponse["payload"] = Object.freeze({
          executionId,
          presetId,
          accepted: Boolean(result.accepted),
          status: result.accepted ? "accepted" : "already-terminal",
          cancellationSource: reason,
        })
        return Object.freeze({
          version: 1 as const,
          type: "cancellation" as const,
          correlationId: intent.correlationId,
          sequence: sequence(),
          payload,
        })
      }
      default:
        throw new EndpointFailure("APC_INTENT_UNSUPPORTED", "This APC frontend intent is not supported by the backend")
    }
  }

  return Object.freeze({
    handle: async (scope: BackendEndpointScope, input: unknown): Promise<BackendResponse> => {
      const correlationId = safeCorrelation(input)
      let userId: string | undefined
      try {
        userId = safeUserId(scope)
        const intent = decodeFrontendIntent(input)
        return await dispatch(scope, intent)
      } catch (error) {
        return errorFor(correlationId, userId, error)
      }
    },
    dispatchAndSend: async (scope: BackendEndpointScope, input: unknown): Promise<BackendResponse> => {
      const correlationId = safeCorrelation(input)
      let userId: string | undefined
      let response: BackendResponse
      try {
        userId = safeUserId(scope)
        const intent = decodeFrontendIntent(input)
        response = await dispatch(scope, intent)
      } catch (error) {
        response = errorFor(correlationId, userId, error)
      }
      if (!disposed && deps.sendToFrontend !== undefined && userId !== undefined) {
        deps.sendToFrontend(response, userId)
      }
      return response
    },
    emitActivity: (userId: string, input: BackendActivityEmissionInput): BackendActivityResponse["payload"] | undefined => {
      if (disposed) return undefined
      let sequence: number
      let response: BackendActivityResponse
      try {
        sequence = nextSequence(ledgers, userId)
        response = createBackendActivityResponse({ ...input, sequence })
      } catch {
        return undefined
      }
      if (deps.sendToFrontend !== undefined) {
        try {
          deps.sendToFrontend(response, userId)
        } catch {
          // Activity retention remains authoritative when delivery is unavailable.
        }
      }
      return response.payload
    },
    dispose: () => {
      disposed = true
      ledgers.clear()
    },
  })
}
