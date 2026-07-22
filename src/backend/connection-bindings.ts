import type {
  ConnectionDispatchDescriptorDTO,
  ConnectionProfileDTO,
  SpindleAPI,
} from "lumiverse-spindle-types"
import {
  AtomicJsonStore,
  AtomicJsonStoreError,
} from "../state/atomic-json-store"
import { MAX_CONNECTION_SLOTS, utf8Bytes } from "../config/limits"
import {
  buildBindingKey,
  type BindingConsentDocument,
  type BindingRecord,
  type DocumentWriteExpectation,
  type InstallPair,
} from "../state/documents"

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const REVISION_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u
const SOURCE_KEY_PREFIX = "slot:"
const DOCUMENT_MUTATION_QUEUES = new WeakMap<AtomicJsonStore, Map<string, Promise<void>>>()


/** The only descriptor shape APC may retain or expose. */
export type HostDispatchDescriptor = Readonly<{
  connectionId: string
  connectionName: string
  provider: string
  model: string
  endpointOrigin: string
  dispatchKind: "concrete"
  connectionDispatchRevision: string
}>

/** A binding with all identity and dispatch provenance required for execution. */
export type ResolvedDispatchBinding = Readonly<{
  userId: string
  presetId: string
  slotId: string
  installId: string
  installNonce: string
  connectionSourceKey: `slot:${string}`
  connectionId: string
  dispatchRevision: string
  descriptor: HostDispatchDescriptor
}>

export type BindingSnapshot = Readonly<{
  userId: string
  presetId: string
  installId: string
  installNonce: string
  documentRevision: number
  bindings: readonly BindingRecord[]
  /** Host-validated, credential-free descriptor carried from the pre-commit lookup. */
  descriptor?: HostDispatchDescriptor
}>

export type BindingErrorCode =
  | "INVALID_IDENTITY"
  | "INVALID_SLOT"
  | "INVALID_CONNECTION"
  | "MISSING_BINDING"
  | "CONNECTION_NOT_FOUND"
  | "WRONG_USER"
  | "DUPLICATE_BINDING"
  | "STALE_BINDING"
  | "STALE_DOCUMENT"
  | "INSTALL_MISMATCH"
  | "DESCRIPTOR_INVALID"
  | "REVISION_REQUIRED"
  | "HOST_BINDING_REQUIRED"
  | "SLOT_LIMIT"
  | "STORAGE_FAILURE"

export class ConnectionBindingError extends Error {
  readonly code: BindingErrorCode
  readonly causeValue: unknown

  constructor(code: BindingErrorCode, message: string, causeValue?: unknown) {
    super(message)
    this.name = "ConnectionBindingError"
    this.code = code
    this.causeValue = causeValue
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export type BindingOperationInput = Readonly<{
  userId: string
  presetId: string
  slotId: string
  connectionId: string
  expectedDocumentRevision?: number
  /** Untrusted compatibility input; binding always resolves an authoritative host descriptor. */
  descriptor?: ConnectionDispatchDescriptorDTO
}>
export type UnbindOperationInput = Readonly<{
  userId: string
  presetId: string
  slotId: string
  expectedDocumentRevision?: number
}>

export type ResolveBindingInput = Readonly<{
  userId: string
  presetId: string
  slotId: string
}>

/** Authenticated backend input after the frontend RPC has been decoded. */
export type BindingRpcRequest = Readonly<
  | {
      type: "bind_slot"
      presetId: string
      slotId: string
      connectionId: string
      expectedDocumentRevision?: number
    }
  | {
      type: "unbind_slot"
      presetId: string
      slotId: string
      expectedDocumentRevision?: number
    }
>

export type BindingRpcResponse = BindingSnapshot

export type ConnectionBindingDependencies = Readonly<{
  store: AtomicJsonStore
  connections: Pick<SpindleAPI["connections"], "get" | "list" | "resolveDispatch">
  /**
   * The active callback's host resolver. Supplying it explicitly makes the
   * callback boundary visible in tests and prevents an extension-side
   * revision derivation.
   */
  descriptorResolver?: (connectionId: string) => Promise<ConnectionDispatchDescriptorDTO | null>
}>

function fail(code: BindingErrorCode, message: string, causeValue?: unknown): never {
  throw new ConnectionBindingError(code, message, causeValue)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function assertText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
    return fail("INVALID_IDENTITY", `${label} must be a bounded non-empty string`)
  }
  return value
}

function assertUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    return fail("INVALID_IDENTITY", `${label} must be a canonical lowercase UUID`)
  }
  return value
}

function assertSlotId(value: unknown): string {
  return assertUuid(value, "slotId")
}

function assertConnectionId(value: unknown): string {
  return assertUuid(value, "connectionId")
}

function assertRevision(value: unknown, label = "dispatchRevision"): string {
  if (typeof value !== "string" || !REVISION_PATTERN.test(value)) {
    return fail("REVISION_REQUIRED", `${label} must be a bounded opaque revision`)
  }
  return value
}

function isLikelySecretKey(key: string): boolean {
  const normalized = key.replace(/[-_]/gu, "").toLowerCase()
  return normalized.includes("apikey") || normalized.includes("token") || normalized.includes("secret") || normalized.includes("password")
}

function assertDescriptorLabel(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    utf8Bytes(value) > 320 ||
    /[\u0000-\u001f\u007f\r\n]/u.test(value)
  ) {
    return fail("DESCRIPTOR_INVALID", `descriptor.${label} is invalid`)
  }
  return value
}


/**
 * Clone only the six host-owned safe descriptor fields. Unknown fields are
 * intentionally discarded, so a provider secret attached by a buggy host can
 * never enter APC state or frontend RPC.
 */
export function cloneDispatchDescriptor(value: ConnectionDispatchDescriptorDTO): HostDispatchDescriptor {
  if (!isRecord(value)) return fail("DESCRIPTOR_INVALID", "Dispatch descriptor must be a plain object")
  for (const key of Object.keys(value)) {
    if (isLikelySecretKey(key)) return fail("DESCRIPTOR_INVALID", "Dispatch descriptor contains a secret-shaped field")
  }
  const connectionId = assertConnectionId(value.connectionId)
  const connectionName = assertDescriptorLabel(value.connectionName, "connectionName")
  const provider = assertDescriptorLabel(value.provider, "provider")
  const model = assertDescriptorLabel(value.model, "model")
  if (
    typeof value.endpointOrigin !== "string" ||
    value.endpointOrigin.length === 0 ||
    utf8Bytes(value.endpointOrigin) > 2_048 ||
    /[\u0000-\u001f\u007f\r\n]/u.test(value.endpointOrigin)
  ) {
    return fail("DESCRIPTOR_INVALID", "descriptor.endpointOrigin is invalid")
  }
  if (value.dispatchKind !== "concrete") {
    return fail("DESCRIPTOR_INVALID", "Roulette dispatch cannot be bound to an APC slot")
  }
  const connectionDispatchRevision = assertRevision(value.connectionDispatchRevision, "descriptor.connectionDispatchRevision")
  return Object.freeze({
    connectionId,
    connectionName,
    provider,
    model,
    endpointOrigin: value.endpointOrigin,
    dispatchKind: "concrete" as const,
    connectionDispatchRevision,
  })
}

function assertInstallPair(pair: InstallPair): InstallPair {
  if (!isRecord(pair)) return fail("INSTALL_MISMATCH", "Install pair must be a plain object")
  return Object.freeze({
    extensionInstallationId: assertUuid(pair.extensionInstallationId, "extensionInstallationId"),
    installNonce:
      typeof pair.installNonce === "string" && /^[0-9a-f]{32}$/u.test(pair.installNonce)
        ? pair.installNonce
        : fail("INSTALL_MISMATCH", "installNonce must be a canonical install nonce"),
  })
}

function assertSourceKey(value: unknown, slotId: string): `slot:${string}` {
  const sourceKey = assertText(value, "connectionSourceKey")
  if (sourceKey !== `${SOURCE_KEY_PREFIX}${slotId}`) {
    return fail("DESCRIPTOR_INVALID", "connectionSourceKey must match the bound slot")
  }
  return sourceKey as `slot:${string}`
}

function cloneBinding(value: BindingRecord): BindingRecord {
  const presetId = assertUuid(value.presetId, "binding.presetId")
  const slotId = assertSlotId(value.slotId)
  const connectionId = assertConnectionId(value.connectionId)
  return Object.freeze({
    presetId,
    slotId,
    connectionSourceKey: assertSourceKey(value.connectionSourceKey, slotId),
    connectionId,
    dispatchRevision: assertRevision(value.dispatchRevision),
  })
}

function snapshotFromDocument(
  userId: string,
  presetId: string,
  pair: InstallPair,
  document: BindingConsentDocument,
  descriptor?: HostDispatchDescriptor,
): BindingSnapshot {
  const bindings = Object.values(document.bindings)
    .map(cloneBinding)
    .sort((left, right) => left.slotId.localeCompare(right.slotId))
  return Object.freeze({
    userId,
    presetId,
    installId: pair.extensionInstallationId,
    installNonce: pair.installNonce,
    documentRevision: document.documentRevision,
    bindings: Object.freeze(bindings),
    ...(descriptor === undefined ? {} : { descriptor }),
  })
}

/** Validate and immutably clone an execution binding received from APC code. */
export function freezeResolvedDispatchBinding(value: ResolvedDispatchBinding): ResolvedDispatchBinding {
  if (!isRecord(value)) return fail("DESCRIPTOR_INVALID", "Resolved binding must be a plain object")
  const userId = assertText(value.userId, "resolved.userId")
  const presetId = assertUuid(value.presetId, "resolved.presetId")
  const slotId = assertSlotId(value.slotId)
  const connectionId = assertConnectionId(value.connectionId)
  const connectionSourceKey = assertSourceKey(value.connectionSourceKey, slotId)
  const dispatchRevision = assertRevision(value.dispatchRevision)
  const descriptor = cloneDispatchDescriptor(value.descriptor)
  if (descriptor.connectionId !== connectionId || descriptor.connectionDispatchRevision !== dispatchRevision) {
    return fail("STALE_BINDING", "Resolved descriptor does not match the binding")
  }
  const installId = assertUuid(value.installId, "resolved.installId")
  if (typeof value.installNonce !== "string" || !/^[0-9a-f]{32}$/u.test(value.installNonce)) {
    return fail("INSTALL_MISMATCH", "resolved.installNonce is invalid")
  }
  return Object.freeze({
    userId,
    presetId,
    slotId,
    installId,
    installNonce: value.installNonce,
    connectionSourceKey,
    connectionId,
    dispatchRevision,
    descriptor,
  })
}

export function assertResolvedDispatchBinding(value: unknown): asserts value is ResolvedDispatchBinding {
  freezeResolvedDispatchBinding(value as ResolvedDispatchBinding)
}

function mapStoreError(error: unknown): never {
  if (error instanceof ConnectionBindingError) throw error
  if (error instanceof AtomicJsonStoreError) {
    if (error.code === "REVISION_MISMATCH") return fail("STALE_DOCUMENT", error.message, error)
    if (error.code === "INSTALL_MISMATCH") return fail("INSTALL_MISMATCH", error.message, error)
    if (error.code === "STORAGE_FAILURE") return fail("STORAGE_FAILURE", error.message, error)
  }
  throw error
}

function expectation(store: AtomicJsonStore, revision: number | undefined): DocumentWriteExpectation | undefined {
  if (revision === undefined) return undefined
  if (!Number.isSafeInteger(revision) || revision < 0) return fail("STALE_DOCUMENT", "expectedDocumentRevision is invalid")
  const pair = assertInstallPair(store.getInstallPair())
  return Object.freeze({
    documentRevision: revision,
    extensionInstallationId: pair.extensionInstallationId,
    installNonce: pair.installNonce,
  })
}

function profileBelongsToUser(profile: ConnectionProfileDTO, userId: string): boolean {
  const record = profile as unknown as Record<string, unknown>
  const metadata = isRecord(record.metadata) ? record.metadata : undefined
  const ownerCandidates = [
    record.userId,
    record.user_id,
    record.ownerUserId,
    record.owner_user_id,
    metadata?.userId,
    metadata?.user_id,
    metadata?.ownerUserId,
    metadata?.owner_user_id,
  ]
  return ownerCandidates.every((owner) => owner === undefined || owner === userId)
}

function assertExpectedRevision(
  latestRevision: number,
  expectedRevision: number | undefined,
): number {
  if (expectedRevision === undefined) return latestRevision
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    return fail("STALE_DOCUMENT", "expectedDocumentRevision is invalid")
  }
  if (expectedRevision !== latestRevision) {
    return fail("STALE_DOCUMENT", "Binding was derived from a stale document revision")
  }
  return expectedRevision
}

function safeConnectionProfile(profile: ConnectionProfileDTO): ConnectionProfileDTO {
  const safe = Object.freeze({
    id: profile.id,
    name: profile.name,
    provider: profile.provider,
    api_url: profile.api_url,
    model: profile.model,
    preset_id: profile.preset_id,
    is_default: profile.is_default,
    has_api_key: profile.has_api_key,
    // Provider metadata is intentionally discarded; it is not needed by APC
    // and may contain provider-specific values outside the safe DTO surface.
    metadata: Object.freeze({}),
    reasoning_bindings: profile.reasoning_bindings,
    created_at: profile.created_at,
    updated_at: profile.updated_at,
  }) satisfies ConnectionProfileDTO
  return safe
}

export class ConnectionBindings {
  private readonly store: AtomicJsonStore
  private readonly connections: ConnectionBindingDependencies["connections"]
  private readonly descriptorResolver: (connectionId: string) => Promise<ConnectionDispatchDescriptorDTO | null>
  private readonly documentMutationQueues: Map<string, Promise<void>>

  constructor(dependencies: ConnectionBindingDependencies) {
    if (!dependencies || !dependencies.store || !dependencies.connections) {
      throw new TypeError("ConnectionBindings dependencies are incomplete")
    }
    this.store = dependencies.store
    this.connections = dependencies.connections
    this.descriptorResolver = dependencies.descriptorResolver ?? dependencies.connections.resolveDispatch.bind(dependencies.connections)
    const queues = DOCUMENT_MUTATION_QUEUES.get(this.store)
    if (queues === undefined) {
      this.documentMutationQueues = new Map<string, Promise<void>>()
      DOCUMENT_MUTATION_QUEUES.set(this.store, this.documentMutationQueues)
    } else {
      this.documentMutationQueues = queues
    }
  }

  private assertOperationIdentity(userId: unknown, presetId: unknown): { userId: string; presetId: string } {
    return {
      userId: assertText(userId, "userId"),
      presetId: assertUuid(presetId, "presetId"),
    }
  }

  private async assertOwnedConnection(userId: string, connectionId: string): Promise<void> {
    // Operator-scoped hosts require the authenticated callback user ID.
    // The host applies that scope before returning the profile.
    const profile = await this.connections.get(connectionId, userId)
    if (profile === null) return fail("CONNECTION_NOT_FOUND", "Connection is missing or inaccessible to this user")
    if (profile.id !== connectionId) return fail("CONNECTION_NOT_FOUND", "Connection profile identity mismatch")
    if (!profileBelongsToUser(profile, userId)) return fail("WRONG_USER", "Connection belongs to another user")
  }

  private async resolveDescriptor(connectionId: string): Promise<HostDispatchDescriptor> {
    let raw: ConnectionDispatchDescriptorDTO | null
    try {
      // This await must remain inside the authenticated backend request/callback
      // so the host's request-local resolver scope cannot outlive the lookup.
      raw = await this.descriptorResolver(connectionId)
    } catch (error) {
      const message = error instanceof Error ? error.message : ""
      if (
        message.includes("BOUND_BINDING_REQUIRED") ||
        message.includes("CONNECTION_DISPATCH_SCOPE_REQUIRED") ||
        message.includes("active authenticated interceptor") ||
        message.includes("frontend-message callback")
      ) {
        return fail("HOST_BINDING_REQUIRED", "Dispatch resolution requires an active authenticated callback", error)
      }
      throw error
    }
    if (raw === null) return fail("CONNECTION_NOT_FOUND", "Host could not resolve the concrete connection")
    const descriptor = cloneDispatchDescriptor(raw)
    if (descriptor.connectionId !== connectionId) return fail("WRONG_USER", "Host descriptor connection identity mismatch")
    return descriptor
  }
  private enqueueDocumentMutation<T>(
    userId: string,
    presetId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = JSON.stringify([userId, presetId])
    const prior = this.documentMutationQueues.get(key) ?? Promise.resolve()
    const next = prior.then(operation, operation)
    const settledTail = next.then(
      () => undefined,
      () => undefined,
    )
    this.documentMutationQueues.set(key, settledTail)
    void settledTail.then(() => {
      if (this.documentMutationQueues.get(key) === settledTail) {
        this.documentMutationQueues.delete(key)
      }
    })
    return next
  }


  private async applyBinding(
    input: BindingOperationInput,
  ): Promise<BindingSnapshot> {
    const { userId, presetId } = this.assertOperationIdentity(input.userId, input.presetId)
    const slotId = assertSlotId(input.slotId)
    const connectionId = assertConnectionId(input.connectionId)

    return this.enqueueDocumentMutation(userId, presetId, async () => {
      await this.assertOwnedConnection(userId, connectionId)
      const descriptor = await this.resolveDescriptor(connectionId)
      const latest = await this.store.readLatest(userId, presetId)
      const expectedRevision = assertExpectedRevision(latest.documentRevision, input.expectedDocumentRevision)
      const key = buildBindingKey(presetId, slotId)
      const existing = latest.bindings[key]
      if (existing && existing.connectionId === connectionId && existing.dispatchRevision === descriptor.connectionDispatchRevision) {
        return fail("DUPLICATE_BINDING", "Slot already has this concrete binding")
      }
      if (existing === undefined && Object.keys(latest.bindings).length >= MAX_CONNECTION_SLOTS) {
        return fail("SLOT_LIMIT", "Connection slot capacity is full")
      }
      for (const candidate of Object.values(latest.bindings)) {
        if (candidate.slotId !== slotId && candidate.connectionId === connectionId) {
          return fail("DUPLICATE_BINDING", "A connection may be bound to only one slot")
        }
      }
      const pair = assertInstallPair(this.store.getInstallPair())
      const next = await this.store.applyBindingIntent(
        userId,
        presetId,
        {
          type: "bind",
          presetId,
          slotId,
          connectionSourceKey: `${SOURCE_KEY_PREFIX}${slotId}`,
          connectionId,
          dispatchRevision: descriptor.connectionDispatchRevision,
        },
        expectation(this.store, expectedRevision),
      ).catch(mapStoreError)
      return snapshotFromDocument(userId, presetId, pair, next, descriptor)
    })
  }

  async bindSlot(input: BindingOperationInput): Promise<BindingSnapshot> {
    return this.applyBinding(input)
  }
  async saveBinding(input: BindingOperationInput): Promise<BindingSnapshot> {
    return this.bindSlot(input)
  }

  async updateBinding(input: BindingOperationInput): Promise<BindingSnapshot> {
    return this.rebindSlot(input)
  }

  async removeBinding(input: UnbindOperationInput): Promise<BindingSnapshot> {
    return this.unbindSlot(input)
  }

  async getBindings(userId: string, presetId: string): Promise<BindingSnapshot> {
    return this.listBindings(userId, presetId)
  }

  async rebindSlot(input: BindingOperationInput): Promise<BindingSnapshot> {
    return this.applyBinding(input)
  }

  async unbindSlot(input: UnbindOperationInput): Promise<BindingSnapshot> {
    const { userId, presetId } = this.assertOperationIdentity(input.userId, input.presetId)
    const slotId = assertSlotId(input.slotId)

    return this.enqueueDocumentMutation(userId, presetId, async () => {
      const latest = await this.store.readLatest(userId, presetId)
      const expectedRevision = assertExpectedRevision(latest.documentRevision, input.expectedDocumentRevision)
      if (!latest.bindings[buildBindingKey(presetId, slotId)]) {
        return fail("MISSING_BINDING", "Slot is not bound")
      }
      const pair = assertInstallPair(this.store.getInstallPair())
      const next = await this.store.applyBindingIntent(
        userId,
        presetId,
        { type: "unbind", presetId, slotId },
        expectation(this.store, expectedRevision),
      ).catch(mapStoreError)
      return snapshotFromDocument(userId, presetId, pair, next)
    })
  }

  async listBindings(userIdInput: string, presetIdInput: string): Promise<BindingSnapshot> {
    const { userId, presetId } = this.assertOperationIdentity(userIdInput, presetIdInput)
    const pair = assertInstallPair(this.store.getInstallPair())
    const document = await this.store.readLatest(userId, presetId)
    return snapshotFromDocument(userId, presetId, pair, document)
  }

  async resolveSlot(input: ResolveBindingInput): Promise<ResolvedDispatchBinding> {
    const { userId, presetId } = this.assertOperationIdentity(input.userId, input.presetId)
    const slotId = assertSlotId(input.slotId)
    const document = await this.store.readLatest(userId, presetId)
    const binding = document.bindings[buildBindingKey(presetId, slotId)]
    if (!binding) return fail("MISSING_BINDING", "Slot is not bound")

    if (binding.presetId !== presetId || binding.slotId !== slotId || binding.connectionSourceKey !== `${SOURCE_KEY_PREFIX}${slotId}`) {
      return fail("STALE_BINDING", "Persisted binding identity does not match the requested slot")
    }
    await this.assertOwnedConnection(userId, binding.connectionId)
    const descriptor = await this.resolveDescriptor(binding.connectionId)
    if (descriptor.connectionDispatchRevision !== binding.dispatchRevision) {
      return fail("STALE_BINDING", "Connection dispatch revision changed since binding")
    }
    const pair = assertInstallPair(this.store.getInstallPair())
    return freezeResolvedDispatchBinding({
      userId,
      presetId,
      slotId,
      installId: pair.extensionInstallationId,
      installNonce: pair.installNonce,
      connectionSourceKey: `${SOURCE_KEY_PREFIX}${slotId}`,
      connectionId: binding.connectionId,
      dispatchRevision: binding.dispatchRevision,
      descriptor,
    })
  }
  async applyRpc(userId: string, request: BindingRpcRequest): Promise<BindingRpcResponse> {
    if (request.type === "bind_slot") {
      return this.bindSlot({
        userId,
        presetId: request.presetId,
        slotId: request.slotId,
        connectionId: request.connectionId,
        expectedDocumentRevision: request.expectedDocumentRevision,
      })
    }
    return this.unbindSlot({
      userId,
      presetId: request.presetId,
      slotId: request.slotId,
      expectedDocumentRevision: request.expectedDocumentRevision,
    })
  }

  async listConnections(userIdInput: string): Promise<readonly ConnectionProfileDTO[]> {
    const userId = assertText(userIdInput, "userId")
    // Operator-scoped hosts require the authenticated callback user ID.
    // Keep the local identity check for hosts that expose an owner hint.
    const profiles = await this.connections.list(userId)
    const safe = profiles
      .filter((profile) => profileBelongsToUser(profile, userId))
      .map((profile) => safeConnectionProfile(profile))
    return Object.freeze(safe)
  }
}

export const ConnectionBindingService = ConnectionBindings
export const ConnectionBindingManager = ConnectionBindings

export function createConnectionBindings(dependencies: ConnectionBindingDependencies): ConnectionBindings {
  return new ConnectionBindings(dependencies)
}

export async function bindSlot(
  service: ConnectionBindings,
  input: BindingOperationInput,
): Promise<BindingSnapshot> {
  return service.bindSlot(input)
}

export async function rebindSlot(
  service: ConnectionBindings,
  input: BindingOperationInput,
): Promise<BindingSnapshot> {
  return service.rebindSlot(input)
}

export async function unbindSlot(
  service: ConnectionBindings,
  input: UnbindOperationInput,
): Promise<BindingSnapshot> {
  return service.unbindSlot(input)
}

export async function resolveSlot(
  service: ConnectionBindings,
  input: ResolveBindingInput,
): Promise<ResolvedDispatchBinding> {
  return service.resolveSlot(input)
}

export async function listBindings(
  service: ConnectionBindings,
  userId: string,
  presetId: string,
): Promise<BindingSnapshot> {
  return service.listBindings(userId, presetId)
}
