import type {
  BackendBindingResponse,
  BackendCancellationResponse,
  BackendConnectionListResponse,
  BackendConsentResponse,
  BackendErrorResponse,
  BackendHydrationResponse,
  BackendMessage,
  BackendTraceDetailResponse,
  BackendTraceListResponse,
  BackendViewResponseResponse,
  ConsentSelector,
  FrontendApproveConsentIntent,
  FrontendBindSlotIntent,
  FrontendCancelExecutionIntent,
  FrontendGetTraceIntent,
  FrontendHydratePresetIntent,
  FrontendListConnectionsIntent,
  FrontendListTracesIntent,
  FrontendRevokeConsentIntent,
  FrontendViewResponseIntent,
  FrontendResolveConsentIntent,
  FrontendUnbindSlotIntent,
} from "../protocol/messages"
import { PROTOCOL_VERSION } from "../protocol/messages"

/**
 * The scoped draft surface that the integrator adapts from
 * `ctx.ui.presetEditor.extension`. It exposes only the APC metadata bag;
 * whole-preset writers remain owned by the host save coordinator.
 */
export interface ApcPresetEditorDraftState {
  readonly presetId: string | null
  readonly metadata: unknown
}

export interface ApcPresetEditorDraftAdapter {
  getState(): ApcPresetEditorDraftState
  onChange(listener: (state: ApcPresetEditorDraftState) => void): () => void
  updateMetadata(mutator: (metadata: unknown) => unknown): void
  flush(): Promise<void>
}

export type ApcDomainIntent =
  | FrontendListConnectionsIntent
  | FrontendHydratePresetIntent
  | FrontendBindSlotIntent
  | FrontendUnbindSlotIntent
  | FrontendApproveConsentIntent
  | FrontendRevokeConsentIntent
  | FrontendResolveConsentIntent
  | FrontendListTracesIntent
  | FrontendGetTraceIntent
  | FrontendCancelExecutionIntent
  | FrontendViewResponseIntent

export type ApcDomainResponse = Extract<
  BackendMessage,
  { type: "error" | "connections" | "hydration" | "binding" | "consent" | "trace" | "cancellation" | "activity" | "view_response" }
>

/** Backend authority for connection discovery, binding, consent, traces, and cancellation only. */
export interface ApcDomainTransport {
  send(message: ApcDomainIntent): void | Promise<void>
  onMessage(listener: (message: ApcDomainResponse) => void): () => void
}

export type ApcPersistenceOptions = Readonly<{
  editor: ApcPresetEditorDraftAdapter
  transport?: ApcDomainTransport
  correlationId?: () => string
  requestTimeoutMs?: number
}>


export type ApcConfigPayload = Readonly<{
  presetId: string
  raw: unknown
}>

export type ApcSaveResult = ApcConfigPayload

export type ApcDraftEvent = Readonly<{
  state: ApcPresetEditorDraftState
  owned: boolean
}>

export class ApcPersistenceError extends Error {
  readonly code:
    | "DISPOSED"
    | "BACKEND_ERROR"
    | "APC_BACKEND_PROTOCOL_ERROR"
    | "UNEXPECTED_RESPONSE"
    | "NO_PRESET"
    | "TIMEOUT"

  constructor(code: ApcPersistenceError["code"], message: string) {
    super(message)
    this.name = "ApcPersistenceError"
    this.code = code
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export interface ApcPersistence {
  readonly disposed: boolean
  loadConfig(presetId: string): Promise<ApcConfigPayload>
  hydratePreset(presetId: string): Promise<BackendHydrationResponse["payload"]>
  listConnections(): Promise<BackendConnectionListResponse["payload"]>
  saveConfig(presetId: string, raw: unknown): Promise<ApcSaveResult>
  stageConfig(presetId: string, raw: unknown): void
  bindSlot(
    presetId: string,
    slotId: string,
    connectionId: string,
  ): Promise<BackendBindingResponse["payload"]>
  unbindSlot(presetId: string, slotId: string): Promise<BackendBindingResponse["payload"]>
  approveConsent(selector: ConsentSelector): Promise<BackendConsentResponse["payload"]>
  revokeConsent(selector: ConsentSelector): Promise<BackendConsentResponse["payload"]>
  resolveConsent(selector: ConsentSelector): Promise<BackendConsentResponse["payload"]>
  listTraces(options: Readonly<{
    presetId: string
    executionId?: string
    limit?: number
    cursor?: string
  }>): Promise<BackendTraceListResponse["payload"]>
  getTrace(presetId: string, executionId: string, traceId: string): Promise<BackendTraceDetailResponse["payload"]>
  cancelExecution(presetId: string, executionId: string, reason?: "user" | "stop" | "replacement"): Promise<BackendCancellationResponse["payload"]>
  viewResponse(presetId: string, executionId: string): Promise<BackendViewResponseResponse["payload"]>
  /**
   * Rejects one pending correlated request after transport decoding fails.
   * Implementations must inspect only a bounded correlationId/requestId string.
   */
  handleInvalidMessage(raw: unknown): void
  subscribe(listener: (message: ApcDomainResponse) => void): () => void
  subscribeDraft(listener: (event: ApcDraftEvent) => void): () => void
  flush(): Promise<void>
  dispose(): void
}

type PendingRequest = Readonly<{
  correlationId: string
  accept: (message: ApcDomainResponse) => boolean
  resolve: (message: ApcDomainResponse) => void
  reject: (error: unknown) => void
  timer: ApcRequestTimer
}>


type SaveWaiter = Readonly<{
  resolve: (result: ApcSaveResult) => void
  reject: (error: unknown) => void
}>

type SaveBatch = {
  presetId: string
  raw: unknown
  waiters: SaveWaiter[]
}

type OwnedDraftExpectation = Readonly<{
  lifecycle: number
  presetId: string
  metadata: string
}>

const MAX_OWNED_DRAFT_EXPECTATIONS = 64


const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
type ApcRequestTimer = ReturnType<typeof setTimeout>
let fallbackCorrelationCounter = 0

function newCorrelationId(): string {
  const randomUuid = globalThis.crypto?.randomUUID
  if (typeof randomUuid === "function") return randomUuid.call(globalThis.crypto)
  fallbackCorrelationCounter += 1
  return `00000000-0000-4000-8000-${fallbackCorrelationCounter.toString(16).padStart(12, "0")}`
}

function cloneRollbackValue(value: unknown): { available: boolean; value: unknown } {
  try {
    return { available: true, value: structuredClone(value) }
  } catch {
    return { available: false, value: undefined }
  }
}

function serializeJsonMetadata(value: unknown): string | null {
  const active = new Set<object>()
  const serialize = (candidate: unknown): string | null => {
    if (candidate === null) return "null"
    if (typeof candidate === "string") {
      const serialized = JSON.stringify(candidate)
      return typeof serialized === "string" ? serialized : null
    }
    if (typeof candidate === "boolean") return candidate ? "true" : "false"
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) return null
      const serialized = JSON.stringify(candidate)
      return typeof serialized === "string" ? serialized : null
    }
    if (typeof candidate !== "object" || active.has(candidate)) return null
    active.add(candidate)
    try {
      if (Object.getOwnPropertySymbols(candidate).length > 0) return null
      if (Array.isArray(candidate)) {
        const array = candidate as readonly unknown[]
        for (const key of Object.getOwnPropertyNames(array)) {
          if (key !== "length" && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= array.length || !Object.prototype.propertyIsEnumerable.call(array, key))) return null
        }
        const items: string[] = []
        for (let index = 0; index < array.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(array, String(index))
          if (descriptor === undefined || !("value" in descriptor)) return null
          const serialized = serialize(descriptor.value)
          if (serialized === null) return null
          items.push(serialized)
        }
        return `[${items.join(",")}]`
      }
      const prototype = Object.getPrototypeOf(candidate)
      if (prototype !== Object.prototype && prototype !== null) return null
      const ownNames = Object.getOwnPropertyNames(candidate)
      const keys = Object.keys(candidate)
      if (ownNames.length !== keys.length) return null
      keys.sort()
      const entries: string[] = []
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key)
        if (descriptor === undefined || !("value" in descriptor)) return null
        const serialized = serialize(descriptor.value)
        if (serialized === null) return null
        entries.push(`${JSON.stringify(key)}:${serialized}`)
      }
      return `{${entries.join(",")}}`
    } finally {
      active.delete(candidate)
    }
  }
  try {
    return serialize(value)
  } catch {
    return null
  }
}

function sameJsonMetadata(left: unknown, right: unknown): boolean {
  const leftSerialized = serializeJsonMetadata(left)
  const rightSerialized = serializeJsonMetadata(right)
  return leftSerialized !== null && rightSerialized !== null && leftSerialized === rightSerialized
}

function assertNotDisposed(disposed: boolean): void {
  if (disposed) throw new ApcPersistenceError("DISPOSED", "APC persistence has been disposed")
}

function safeErrorCode(response: BackendErrorResponse): string {
  const candidate = response.payload.code
  return typeof candidate === "string" && /^[A-Z][A-Z0-9_.-]{0,63}$/.test(candidate) ? candidate : "BACKEND_ERROR"
}

function backendError(response: BackendErrorResponse): ApcPersistenceError {
  return new ApcPersistenceError("BACKEND_ERROR", `APC backend request failed (${safeErrorCode(response)})`)
}

function domainResponseType<T extends ApcDomainResponse["type"]>(
  type: T,
): (message: ApcDomainResponse) => message is Extract<ApcDomainResponse, { type: T }> {
  return (message): message is Extract<ApcDomainResponse, { type: T }> => message.type === type
}

export class ApcPersistenceImpl implements ApcPersistence {
  readonly #editor: ApcPresetEditorDraftAdapter
  readonly #transport: ApcDomainTransport | undefined
  readonly #correlationId: () => string
  readonly #retiredCorrelations = new Set<string>()
  readonly #pendingRequests = new Map<string, PendingRequest>()
  readonly #listeners = new Set<(message: ApcDomainResponse) => void>()
  readonly #requestTimeoutMs: number
  #lastSequence = 0
  readonly #draftListeners = new Set<(event: ApcDraftEvent) => void>()
  readonly #saveQueue: SaveBatch[] = []
  #saveDrainPromise: Promise<void> | null = null
  #saveScheduled = false
  #lifecycleGeneration = 0
  #activeSaveBatch: SaveBatch | null = null
  #disposed = false
  readonly #flushLifecycleRejectors = new Set<(error: ApcPersistenceError) => void>()
  readonly #ownedExpectations: OwnedDraftExpectation[] = []
  #unsubscribeEditor: (() => void) | null
  #unsubscribeTransport: (() => void) | null = null

  constructor(options: ApcPersistenceOptions) {
    this.#editor = options.editor
    this.#transport = options.transport
    this.#correlationId = options.correlationId ?? newCorrelationId
    const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new RangeError("APC persistence requestTimeoutMs must be a positive finite number")
    }
    this.#requestTimeoutMs = requestTimeoutMs
    this.#unsubscribeEditor = options.editor.onChange((state) => {
      const event: ApcDraftEvent = { state, owned: this.#ownedDraftEvent(state) }
      for (const listener of [...this.#draftListeners]) {
        try {
          listener(event)
        } catch {
          // Draft listeners cannot break host editor delivery.
        }
      }
    })
    if (options.transport !== undefined) {
      this.#unsubscribeTransport = options.transport.onMessage((message) => this.#handleDomainMessage(message))
    }
  }

  #beginOwnedExpectation(presetId: string, metadata: unknown): OwnedDraftExpectation | null {
    if (this.#ownedExpectations.some((expectation) =>
      expectation.lifecycle !== this.#lifecycleGeneration || expectation.presetId !== presetId)) {
      this.#ownedExpectations.length = 0
    }
    const serialized = serializeJsonMetadata(metadata)
    if (serialized === null) return null
    for (let index = this.#ownedExpectations.length - 1; index >= 0; index -= 1) {
      if (this.#ownedExpectations[index]?.metadata === serialized) this.#ownedExpectations.splice(index, 1)
    }
    const expectation: OwnedDraftExpectation = {
      lifecycle: this.#lifecycleGeneration,
      presetId,
      metadata: serialized,
    }
    this.#ownedExpectations.push(expectation)
    const excess = this.#ownedExpectations.length - MAX_OWNED_DRAFT_EXPECTATIONS
    if (excess > 0) this.#ownedExpectations.splice(0, excess)
    return expectation
  }
  #endOwnedExpectation(expectation: OwnedDraftExpectation | null): void {
    if (expectation === null) return
    const index = this.#ownedExpectations.indexOf(expectation)
    if (index < 0) return
    this.#ownedExpectations.splice(index, 1)
  }

  #ownedDraftEvent(state: ApcPresetEditorDraftState): boolean {
    const current = this.#editor.getState()
    const activePresetId = current.presetId
    if (
      this.#ownedExpectations.some((expectation) =>
        expectation.lifecycle !== this.#lifecycleGeneration || expectation.presetId !== activePresetId)
    ) {
      this.#ownedExpectations.length = 0
      return false
    }
    if (state.presetId !== activePresetId) return false
    const serialized = serializeJsonMetadata(state.metadata)
    const currentSerialized = serializeJsonMetadata(current.metadata)
    const index = serialized === null
      ? -1
      : this.#ownedExpectations.findIndex((expectation) => expectation.metadata === serialized)
    const matchesCurrent = serialized !== null && currentSerialized !== null && serialized === currentSerialized
    if (!matchesCurrent) {
      if (index < 0) return false
      if (index > 0) this.#ownedExpectations.splice(0, index)
      return true
    }
    if (index < 0 || index !== this.#ownedExpectations.length - 1) {
      this.#ownedExpectations.length = 0
      return false
    }
    if (index > 0) this.#ownedExpectations.splice(0, index)
    return true
  }
  handleInvalidMessage(raw: unknown): void {
    if (this.#disposed || raw === null || typeof raw !== "object") return
    const candidate = raw as Record<string, unknown>
    const value = candidate.correlationId ?? candidate.requestId
    if (typeof value !== "string" || value.length === 0 || value.length > 128 || !/^[A-Za-z0-9_.:-]+$/.test(value)) return
    const pending = this.#pendingRequests.get(value)
    if (pending === undefined) return
    clearTimeout(pending.timer)
    this.#pendingRequests.delete(value)
    this.#retireCorrelation(value)
    pending.reject(new ApcPersistenceError("APC_BACKEND_PROTOCOL_ERROR", "APC backend response could not be decoded"))
  }

  #retireCorrelation(correlationId: string): void {
    this.#retiredCorrelations.add(correlationId)
    while (this.#retiredCorrelations.size > 512) {
      const oldest = this.#retiredCorrelations.values().next().value
      if (typeof oldest !== "string") break
      this.#retiredCorrelations.delete(oldest)
    }
  }

  get disposed(): boolean {
    return this.#disposed
  }

  loadConfig(presetId: string): Promise<ApcConfigPayload> {
    assertNotDisposed(this.#disposed)
    const state = this.#editor.getState()
    if (state.presetId !== presetId) {
      return Promise.reject(new ApcPersistenceError("NO_PRESET", "The requested preset is not the active editor draft"))
    }
    return Promise.resolve({ presetId, raw: state.metadata })
  }
  hydratePreset(presetId: string): Promise<BackendHydrationResponse["payload"]> {
    return this.#request(
      {
        version: PROTOCOL_VERSION,
        type: "hydrate_preset",
        correlationId: this.#correlationId(),
        payload: { presetId },
      },
      (message): message is BackendHydrationResponse => message.type === "hydration" && message.payload.presetId === presetId,
    ).then((message) => (message as BackendHydrationResponse).payload)
  }


  listConnections(): Promise<BackendConnectionListResponse["payload"]> {
    return this.#request(
      {
        version: PROTOCOL_VERSION,
        type: "list_connections",
        correlationId: this.#correlationId(),
        payload: {},
      },
      domainResponseType("connections"),
    ).then((message) => (message as BackendConnectionListResponse).payload)
  }

  saveConfig(presetId: string, raw: unknown): Promise<ApcSaveResult> {
    assertNotDisposed(this.#disposed)
    return new Promise<ApcSaveResult>((resolve, reject) => {
      const previous = this.#saveQueue[this.#saveQueue.length - 1]
      if (previous?.presetId === presetId) {
        previous.raw = raw
        previous.waiters.push({ resolve, reject })
      } else {
        this.#saveQueue.push({
          presetId,
          raw,
          waiters: [{ resolve, reject }],
        })
      }
      this.#scheduleSaveDrain()
    })
  }

  stageConfig(presetId: string, raw: unknown): void {
    assertNotDisposed(this.#disposed)
    const state = this.#editor.getState()
    if (state.presetId !== presetId) {
      throw new ApcPersistenceError("NO_PRESET", "Preset editor changed before APC config staging")
    }
    const snapshot = cloneRollbackValue(raw)
    if (!snapshot.available) throw new TypeError("APC preset metadata must be cloneable")
    const expectation = this.#beginOwnedExpectation(presetId, snapshot.value)
    if (expectation === null) throw new TypeError("APC preset metadata must be JSON")
    try {
      this.#editor.updateMetadata(() => snapshot.value)
    } catch (error) {
      this.#endOwnedExpectation(expectation)
      throw error
    }
  }

  bindSlot(presetId: string, slotId: string, connectionId: string): Promise<BackendBindingResponse["payload"]> {
    return this.#request(
      {
        version: PROTOCOL_VERSION,
        type: "bind_slot",
        correlationId: this.#correlationId(),
        payload: { presetId, slotId, patch: { connectionId } },
      },
      (message): message is BackendBindingResponse => message.type === "binding" && message.payload.presetId === presetId && message.payload.slotId === slotId,
    ).then((message) => (message as BackendBindingResponse).payload)
  }

  unbindSlot(presetId: string, slotId: string): Promise<BackendBindingResponse["payload"]> {
    return this.#request(
      {
        version: PROTOCOL_VERSION,
        type: "unbind_slot",
        correlationId: this.#correlationId(),
        payload: { presetId, slotId },
      },
      (message): message is BackendBindingResponse => message.type === "binding" && message.payload.presetId === presetId && message.payload.slotId === slotId,
    ).then((message) => (message as BackendBindingResponse).payload)
  }

  approveConsent(selector: ConsentSelector): Promise<BackendConsentResponse["payload"]> {
    return this.#consentRequest("approve_consent", selector)
  }

  revokeConsent(selector: ConsentSelector): Promise<BackendConsentResponse["payload"]> {
    return this.#consentRequest("revoke_consent", selector)
  }
  resolveConsent(selector: ConsentSelector): Promise<BackendConsentResponse["payload"]> {
    return this.#consentRequest("resolve_consent", selector)
  }


  listTraces(options: Readonly<{
    presetId: string
    executionId?: string
    limit?: number
    cursor?: string
  }>): Promise<BackendTraceListResponse["payload"]> {
    return this.#request(
      {
        version: PROTOCOL_VERSION,
        type: "list_traces",
        correlationId: this.#correlationId(),
        payload: { ...options },
      },
      (message): message is BackendTraceListResponse =>
        message.type === "trace" &&
        "traces" in message.payload &&
        message.payload.traces.every((trace) =>
          trace.presetId === options.presetId &&
          (options.executionId === undefined || trace.executionId === options.executionId)),
    ).then((message) => {
      if ("traces" in message.payload) return message.payload as BackendTraceListResponse["payload"]
      throw new ApcPersistenceError("UNEXPECTED_RESPONSE", "Backend returned trace detail for a trace-list request")
    })
  }

  getTrace(presetId: string, executionId: string, traceId: string): Promise<BackendTraceDetailResponse["payload"]> {
    return this.#request(
      {
        version: PROTOCOL_VERSION,
        type: "get_trace",
        correlationId: this.#correlationId(),
        payload: { presetId, executionId, traceId },
      },
      (message): message is BackendTraceDetailResponse =>
        message.type === "trace" &&
        "trace" in message.payload &&
        message.payload.trace.presetId === presetId &&
        message.payload.trace.executionId === executionId &&
        message.payload.trace.traceId === traceId,
    ).then((message) => {
      if ("trace" in message.payload) return message.payload as BackendTraceDetailResponse["payload"]
      throw new ApcPersistenceError("UNEXPECTED_RESPONSE", "Backend returned a trace list for a trace-detail request")
    })
  }

  cancelExecution(presetId: string, executionId: string, reason?: "user" | "stop" | "replacement"): Promise<BackendCancellationResponse["payload"]> {
    return this.#request(
      {
        version: PROTOCOL_VERSION,
        type: "cancel_execution",
        correlationId: this.#correlationId(),
        payload: reason === undefined ? { presetId, executionId } : { presetId, executionId, reason },
      },
      (message): message is BackendCancellationResponse =>
        message.type === "cancellation" &&
        message.payload.presetId === presetId &&
        message.payload.executionId === executionId,
    ).then((message) => (message as BackendCancellationResponse).payload)
  }
  viewResponse(presetId: string, executionId: string): Promise<BackendViewResponseResponse["payload"]> {
    return this.#request(
      {
        version: PROTOCOL_VERSION,
        type: "view_response",
        correlationId: this.#correlationId(),
        payload: { presetId, executionId },
      },
      (message): message is BackendViewResponseResponse =>
        message.type === "view_response" &&
        message.payload.presetId === presetId &&
        message.payload.executionId === executionId,
    ).then((message) => (message as BackendViewResponseResponse).payload)
  }

  subscribe(listener: (message: ApcDomainResponse) => void): () => void {
    assertNotDisposed(this.#disposed)
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  subscribeDraft(listener: (event: ApcDraftEvent) => void): () => void {
    assertNotDisposed(this.#disposed)
    this.#draftListeners.add(listener)
    return () => this.#draftListeners.delete(listener)
  }

  async flush(): Promise<void> {
    assertNotDisposed(this.#disposed)
    const lifecycle = this.#lifecycleGeneration
    this.#saveScheduled = false
    let drainedSave = false
    while (true) {
      const hasSaveWork = this.#saveQueue.length > 0 || this.#activeSaveBatch !== null
      if (hasSaveWork) {
        drainedSave = true
        await this.#awaitLifecycle(this.#drainSaves(), lifecycle)
        continue
      }
      const drain = this.#saveDrainPromise
      if (drain !== null) {
        await this.#awaitLifecycle(drain, lifecycle)
        continue
      }
      break
    }
    if (!drainedSave) await this.#awaitLifecycle(this.#editor.flush(), lifecycle)
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#lifecycleGeneration += 1
    this.#lastSequence = 0
    this.#retiredCorrelations.clear()
    this.#ownedExpectations.length = 0
    this.#saveScheduled = false
    this.#unsubscribeEditor?.()
    this.#unsubscribeEditor = null
    this.#unsubscribeTransport?.()
    this.#unsubscribeTransport = null
    const error = new ApcPersistenceError("DISPOSED", "APC persistence has been disposed")
    for (const reject of this.#flushLifecycleRejectors) reject(error)
    this.#flushLifecycleRejectors.clear()
    for (const [correlationId, pending] of this.#pendingRequests) {
      clearTimeout(pending.timer)
      this.#retireCorrelation(correlationId)
      pending.reject(error)
    }
    this.#pendingRequests.clear()
    const activeBatch = this.#activeSaveBatch
    if (activeBatch !== null) {
      for (const waiter of activeBatch.waiters) waiter.reject(error)
      this.#activeSaveBatch = null
    }
    for (const batch of this.#saveQueue.splice(0)) for (const waiter of batch.waiters) waiter.reject(error)
    this.#listeners.clear()
    this.#draftListeners.clear()
  }

  #consentRequest(type: "approve_consent" | "revoke_consent" | "resolve_consent", selector: ConsentSelector): Promise<BackendConsentResponse["payload"]> {
    return this.#request(
      {
        version: PROTOCOL_VERSION,
        type,
        correlationId: this.#correlationId(),
        payload: selector,
      },
      (message): message is BackendConsentResponse =>
        message.type === "consent" &&
        message.payload.presetId === selector.presetId &&
        message.payload.threadId === selector.threadId &&
        message.payload.workspaceSource === selector.workspaceSource &&
        message.payload.connectionSourceKey === selector.connectionSourceKey,
    ).then((message) => (message as BackendConsentResponse).payload)
  }

  #request(message: ApcDomainIntent, accept: (message: ApcDomainResponse) => boolean): Promise<ApcDomainResponse> {
    assertNotDisposed(this.#disposed)
    const transport = this.#transport
    if (transport === undefined) return Promise.reject(new ApcPersistenceError("BACKEND_ERROR", "No backend domain transport is available"))
    return new Promise<ApcDomainResponse>((resolve, reject) => {
      const correlationId = message.correlationId
      if (this.#pendingRequests.has(correlationId) || this.#retiredCorrelations.has(correlationId)) {
        reject(new ApcPersistenceError("UNEXPECTED_RESPONSE", "APC request correlation is unavailable"))
        return
      }
      const timer = setTimeout(() => {
        const pending = this.#pendingRequests.get(correlationId)
        if (pending === undefined) return
        this.#pendingRequests.delete(correlationId)
        this.#retireCorrelation(correlationId)
        pending.reject(new ApcPersistenceError("TIMEOUT", "APC backend request timed out"))
      }, this.#requestTimeoutMs)
      this.#pendingRequests.set(correlationId, { correlationId, accept, resolve, reject, timer })
      try {
        const sent = transport.send(message)
        if (sent && typeof (sent as Promise<void>).then === "function") void (sent as Promise<void>).catch(() => {
          const pending = this.#pendingRequests.get(correlationId)
          if (pending === undefined) return
          this.#pendingRequests.delete(correlationId)
          clearTimeout(pending.timer)
          this.#retireCorrelation(correlationId)
          pending.reject(new ApcPersistenceError("BACKEND_ERROR", "APC backend transport failed"))
        })
      } catch {
        const pending = this.#pendingRequests.get(correlationId)
        if (pending === undefined) return
        this.#pendingRequests.delete(correlationId)
        clearTimeout(pending.timer)
        this.#retireCorrelation(correlationId)
        pending.reject(new ApcPersistenceError("BACKEND_ERROR", "APC backend transport failed"))
      }
    })
  }
  #acceptSequence(message: ApcDomainResponse): boolean {
    if (!("sequence" in message) || message.sequence === undefined) return true
    if (!Number.isSafeInteger(message.sequence) || message.sequence < 1 || message.sequence <= this.#lastSequence) return false
    this.#lastSequence = message.sequence
    return true
  }

  #rejectPending(correlationId: string, error: ApcPersistenceError): void {
    const pending = this.#pendingRequests.get(correlationId)
    if (pending === undefined) return
    this.#pendingRequests.delete(correlationId)
    clearTimeout(pending.timer)
    this.#retireCorrelation(correlationId)
    pending.reject(error)
  }

  #handleDomainMessage(message: ApcDomainResponse): void {
    if (this.#disposed) return
    const pending = this.#pendingRequests.get(message.correlationId)
    if (message.version !== PROTOCOL_VERSION) {
      if (pending !== undefined) this.#rejectPending(message.correlationId, new ApcPersistenceError("APC_BACKEND_PROTOCOL_ERROR", "APC backend response used an unsupported protocol version"))
      return
    }
    if (!this.#acceptSequence(message)) {
      if (pending !== undefined) this.#rejectPending(message.correlationId, new ApcPersistenceError("UNEXPECTED_RESPONSE", "APC backend response sequence was stale"))
      return
    }
    if (pending !== undefined) {
      if (message.type === "error") {
        this.#pendingRequests.delete(message.correlationId)
        clearTimeout(pending.timer)
        this.#retireCorrelation(message.correlationId)
        pending.reject(backendError(message))
        return
      }
      if (!pending.accept(message)) {
        this.#rejectPending(message.correlationId, new ApcPersistenceError("UNEXPECTED_RESPONSE", "APC backend response did not match its request"))
        return
      }
      this.#pendingRequests.delete(message.correlationId)
      clearTimeout(pending.timer)
      this.#retireCorrelation(message.correlationId)
      pending.resolve(message)
      return
    }
    if (this.#retiredCorrelations.has(message.correlationId) || message.type !== "activity") return
    for (const listener of [...this.#listeners]) {
      try {
        listener(message)
      } catch {
        // Domain listeners are observational and cannot block request settlement.
      }
    }
  }

  async #awaitLifecycle<T>(promise: Promise<T>, lifecycle: number): Promise<T> {
    if (this.#disposed || lifecycle !== this.#lifecycleGeneration) {
      throw new ApcPersistenceError("DISPOSED", "APC persistence has been disposed")
    }
    let rejectLifecycle!: (error: ApcPersistenceError) => void
    const disposed = new Promise<never>((_, reject) => {
      rejectLifecycle = reject
      this.#flushLifecycleRejectors.add(rejectLifecycle)
    })
    try {
      return await Promise.race([promise, disposed])
    } finally {
      this.#flushLifecycleRejectors.delete(rejectLifecycle)
    }
  }

  #scheduleSaveDrain(): void {
    if (this.#saveScheduled || this.#saveDrainPromise !== null) return
    this.#saveScheduled = true
    queueMicrotask(() => {
      this.#saveScheduled = false
      void this.#drainSaves()
    })
  }

  #drainSaves(): Promise<void> {
    if (this.#saveDrainPromise !== null) return this.#saveDrainPromise
    const lifecycle = this.#lifecycleGeneration
    this.#saveDrainPromise = (async () => {
      while (!this.#disposed && lifecycle === this.#lifecycleGeneration && this.#saveQueue.length > 0) {
        const batch = this.#saveQueue.shift() as SaveBatch
        this.#activeSaveBatch = batch
        let before: ApcPresetEditorDraftState | null = null
        let mutated = false
        let failedBatchRaw: unknown = undefined
        let failedBatchRawAvailable = false
        let expectation: OwnedDraftExpectation | null = null
        try {
          before = this.#editor.getState()
          if (before.presetId !== batch.presetId) throw new ApcPersistenceError("NO_PRESET", "Preset editor changed before APC save")
          const snapshot = cloneRollbackValue(batch.raw)
          expectation = snapshot.available ? this.#beginOwnedExpectation(batch.presetId, snapshot.value) : null
          try {
            this.#editor.updateMetadata(() => snapshot.available ? snapshot.value : batch.raw)
            mutated = true
          } catch (error) {
            this.#endOwnedExpectation(expectation)
            throw error
          }
          failedBatchRaw = snapshot.value
          failedBatchRawAvailable = snapshot.available
          await this.#editor.flush()
          if (this.#disposed || lifecycle !== this.#lifecycleGeneration) throw new ApcPersistenceError("DISPOSED", "APC persistence has been disposed")
          const latest = this.#editor.getState()
          if (latest.presetId !== batch.presetId) throw new ApcPersistenceError("NO_PRESET", "Preset editor changed during APC save")
          const result: ApcSaveResult = { presetId: batch.presetId, raw: latest.metadata }
          for (const waiter of batch.waiters) waiter.resolve(result)
        } catch (error) {
          if (
            !this.#disposed &&
            lifecycle === this.#lifecycleGeneration &&
            mutated &&
            before !== null &&
            failedBatchRawAvailable &&
            expectation !== null &&
            this.#ownedExpectations.at(-1) === expectation
          ) {
            try {
              const current = this.#editor.getState()
              if (current.presetId === batch.presetId && sameJsonMetadata(current.metadata, failedBatchRaw)) {
                expectation = this.#beginOwnedExpectation(batch.presetId, before.metadata)
                if (expectation !== null) {
                  try {
                    this.#editor.updateMetadata(() => before?.metadata)
                  } catch (rollbackError) {
                    this.#endOwnedExpectation(expectation)
                    throw rollbackError
                  }
                  await this.#editor.flush()
                }
              }
            } catch {
              // Preserve the host editor state when rollback itself is unavailable.
            }
          }
          if (!this.#disposed && lifecycle === this.#lifecycleGeneration) {
            for (const waiter of batch.waiters) waiter.reject(error)
          }
        } finally {
          if (this.#activeSaveBatch === batch) this.#activeSaveBatch = null
        }
      }
    })().finally(() => {
      this.#saveDrainPromise = null
      if (this.#saveQueue.length > 0 && !this.#disposed && lifecycle === this.#lifecycleGeneration) this.#scheduleSaveDrain()
    })
    return this.#saveDrainPromise
  }
}

export function createApcPersistence(options: ApcPersistenceOptions): ApcPersistence {
  return new ApcPersistenceImpl(options)
}
