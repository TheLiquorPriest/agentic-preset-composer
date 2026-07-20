import { MAX_CONFIG_BYTES, MAX_CONNECTION_SLOTS } from "../config/limits"
import { MAX_CONSENT_VIEWS } from "../protocol/messages"
import { serializedUtf8Bytes } from "../config/plain-json"

const SCHEMA_VERSION = 1 as const

/** The only storage namespace used by the APC local-state adapter. */
export const APC_STORAGE_NAMESPACE = "agentic-preset-composer" as const
export const INSTALL_RECORD_FILENAME = "install-record.json" as const

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const INSTALL_NONCE_PATTERN = /^[0-9a-f]{32}$/
const OPAQUE_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/
export const PATH_SEGMENT_MAX_CHARS = 256
const MAX_CONSENTS_PER_DOCUMENT = MAX_CONSENT_VIEWS
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"])
const WORKSPACE_SOURCES = new Set(["native-blocks", "main-context"])

export type CanonicalIdentifier = string

export type InstallRecord = Readonly<{
  schemaVersion: typeof SCHEMA_VERSION
  extensionInstallationId: string
  installNonce: string
}>

/** A concrete explicit connection binding for one preset slot. */
export type BindingRecord = Readonly<{
  presetId: CanonicalIdentifier
  slotId: CanonicalIdentifier
  connectionSourceKey: string
  connectionId: string
  dispatchRevision: string
}>

/** The exact descriptor a thread disclosed to the user before dispatch. */
export type ConsentRecord = Readonly<{
  installId: string
  nonce: string
  presetId: CanonicalIdentifier
  threadId: CanonicalIdentifier
  workspaceSource: "native-blocks" | "main-context"
  connectionSourceKey: "main" | `slot:${string}`
  connectionId: string | null
  dispatchRevision: string
  disclosureVersion: number
}>

export type BindingMap = Readonly<Record<string, BindingRecord>>
export type ConsentMap = Readonly<Record<string, ConsentRecord>>

export type BindingConsentDocument = Readonly<{
  schemaVersion: typeof SCHEMA_VERSION
  documentRevision: number
  bindings: BindingMap
  consents: ConsentMap
}>

export type InstallPair = Readonly<{
  extensionInstallationId: string
  installNonce: string
}>

export type DocumentWriteExpectation = Readonly<{
  documentRevision: number
  extensionInstallationId: string
  installNonce: string
}>

export type BindingIntent =
  | Readonly<{
      type: "bind" | "set"
      binding: BindingRecord
    }>
  | Readonly<{
      type: "bind" | "set"
      presetId: string
      slotId: string
      connectionSourceKey: string
      connectionId: string
      dispatchRevision: string
    }>
  | Readonly<{
      type: "unbind" | "remove"
      presetId: string
      slotId: string
    }>

export type ConsentIntent =
  | Readonly<{
      type: "grant" | "set"
      consent: ConsentRecord
    }>
  | Readonly<{
      type: "grant" | "set"
      installId: string
      nonce: string
      presetId: string
      threadId: string
      workspaceSource: "native-blocks" | "main-context"
      connectionSourceKey: "main" | `slot:${string}`
      connectionId: string | null
      dispatchRevision: string
      disclosureVersion: number
    }>
  | Readonly<{
      type: "revoke" | "remove"
      key: string
    }>
  | Readonly<{
      type: "revoke" | "remove"
      consent: ConsentRecord
    }>

export class DocumentValidationError extends Error {
  readonly code = "APC_DOCUMENT_INVALID" as const

  constructor(message: string) {
    super(message)
    this.name = "DocumentValidationError"
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

function assertDocumentByteLimit(value: unknown): void {
  const serialized = serializedUtf8Bytes(value)
  if (!serialized.ok) {
    return fail(`Binding/consent document is not safe JSON (${serialized.error.code})`)
  }
  if (serialized.bytes > MAX_CONFIG_BYTES) {
    return fail(`Binding/consent document exceeds ${MAX_CONFIG_BYTES} UTF-8 bytes`)
  }
}

function fail(message: string): never {
  throw new DocumentValidationError(message)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false

  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return false
    if (Object.getOwnPropertySymbols(value).length !== 0) return false
    return true
  } catch {
    return false
  }
}

function assertNoDangerousOwnKeys(record: Record<string, unknown>, label: string): void {
  let names: string[]
  try {
    names = Object.getOwnPropertyNames(record)
  } catch {
    fail(`${label} must be a plain JSON object`)
  }

  for (const name of names) {
    if (DANGEROUS_KEYS.has(name)) fail(`${label} contains a dangerous key: ${name}`)
    const descriptor = Object.getOwnPropertyDescriptor(record, name)
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      fail(`${label}.${name} must be an enumerable data property`)
    }
  }
}

function assertExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  assertNoDangerousOwnKeys(record, label)
  const actual = Object.getOwnPropertyNames(record)
  if (actual.length !== expected.length || expected.some((key) => !actual.includes(key))) {
    fail(`${label} has an invalid property set`)
  }
}

function property(record: Record<string, unknown>, key: string, label: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
    fail(`${label}.${key} must be an enumerable data property`)
  }
  return descriptor.value
}

function assertNoCycles(value: unknown, seen: WeakSet<object>, label: string): void {
  if (value === null || typeof value !== "object") return
  if (seen.has(value)) fail(`${label} contains a cycle or aliased object`)
  seen.add(value)
}

function assertCanonicalUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    fail(`${label} must be a canonical lowercase UUID`)
  }
  return value
}

function assertMatchingPresetId(actual: string, expected: string, label: string): void {
  if (actual !== expected) fail(`${label} presetId does not match canonical presetId`)
}


function assertThreadId(value: unknown, label: string): string {
  if (value === "main") return "main"
  return assertCanonicalUuid(value, label)
}

function assertInstallNonce(value: unknown, label: string): string {
  if (typeof value !== "string" || !INSTALL_NONCE_PATTERN.test(value)) {
    fail(`${label} must be a 128-bit lowercase hexadecimal nonce`)
  }
  return value
}

function assertOpaqueToken(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    !OPAQUE_TOKEN_PATTERN.test(value)
  ) {
    fail(`${label} must be a bounded opaque token`)
  }
  return value
}

function assertPathSegment(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > PATH_SEGMENT_MAX_CHARS) {
    fail(`${label} must be a non-empty path segment`)
  }
  if (value === "." || value === ".." || /[\\/\u0000]/u.test(value)) {
    fail(`${label} must not contain path separators`)
  }
  return value
}

function assertRevision(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(`${label} must be a non-negative safe integer`)
  }
  return value
}

function assertDisclosureVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    fail("Consent disclosureVersion must be a positive safe integer")
  }
  return value
}

function assertWorkspaceSource(value: unknown): "native-blocks" | "main-context" {
  if (typeof value !== "string" || !WORKSPACE_SOURCES.has(value)) {
    fail("Consent workspaceSource is invalid")
  }
  return value as "native-blocks" | "main-context"
}

function assertConnectionSourceKey(value: unknown, label: string): "main" | `slot:${string}` {
  if (value === "main") return value
  if (typeof value !== "string" || !value.startsWith("slot:")) {
    fail(`${label} must be main or slot:<canonical UUID>`)
  }
  const slotId = value.slice("slot:".length)
  assertCanonicalUuid(slotId, `${label} slot ID`)
  return value as `slot:${string}`
}

function assertConnectionId(
  value: unknown,
  sourceKey: "main" | `slot:${string}`,
  label: string,
  allowMain: boolean,
): string | null {
  if (sourceKey === "main") {
    if (!allowMain) fail(`${label} cannot use the main source in a slot binding`)
    if (value !== null) fail(`${label} must be null for the main source`)
    return null
  }
  return assertCanonicalUuid(value, label)
}

function freezeBinding(value: BindingRecord): BindingRecord {
  return Object.freeze({
    presetId: value.presetId,
    slotId: value.slotId,
    connectionSourceKey: value.connectionSourceKey,
    connectionId: value.connectionId,
    dispatchRevision: value.dispatchRevision,
  })
}

function freezeConsent(value: ConsentRecord): ConsentRecord {
  return Object.freeze({
    installId: value.installId,
    nonce: value.nonce,
    presetId: value.presetId,
    threadId: value.threadId,
    workspaceSource: value.workspaceSource,
    connectionSourceKey: value.connectionSourceKey,
    connectionId: value.connectionId,
    dispatchRevision: value.dispatchRevision,
    disclosureVersion: value.disclosureVersion,
  })
}

function freezeMap<T extends object>(value: Record<string, T>): Readonly<Record<string, T>> {
  return Object.freeze(value)
}

function freezeDocument(
  documentRevision: number,
  bindings: Record<string, BindingRecord>,
  consents: Record<string, ConsentRecord>,
): BindingConsentDocument {
  if (Object.keys(consents).length > MAX_CONSENTS_PER_DOCUMENT) {
    return fail(
      `Binding/consent document contains more than ${MAX_CONSENTS_PER_DOCUMENT} consents`,
    )
  }
  const document = Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    documentRevision,
    bindings: freezeMap(bindings),
    consents: freezeMap(consents),
  })
  assertDocumentByteLimit(document)
  return document
}

export function createEmptyBindingConsentDocument(): BindingConsentDocument {
  return freezeDocument(0, {}, {})
}

export function decodeInstallRecord(value: unknown): InstallRecord {
  if (!isPlainRecord(value)) return fail("Install record must be a plain JSON object")
  assertExactKeys(value, ["schemaVersion", "extensionInstallationId", "installNonce"], "Install record")
  if (property(value, "schemaVersion", "Install record") !== SCHEMA_VERSION) {
    return fail("Install record schemaVersion must be 1")
  }

  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    extensionInstallationId: assertCanonicalUuid(
      property(value, "extensionInstallationId", "Install record"),
      "Install record extensionInstallationId",
    ),
    installNonce: assertInstallNonce(
      property(value, "installNonce", "Install record"),
      "Install record installNonce",
    ),
  })
}

export function decodeBindingRecord(value: unknown): BindingRecord {
  if (!isPlainRecord(value)) return fail("Binding must be a plain JSON object")
  assertExactKeys(
    value,
    ["presetId", "slotId", "connectionSourceKey", "connectionId", "dispatchRevision"],
    "Binding",
  )
  const presetId = assertCanonicalUuid(property(value, "presetId", "Binding"), "Binding presetId")
  const slotId = assertCanonicalUuid(property(value, "slotId", "Binding"), "Binding slotId")
  const sourceKey = assertConnectionSourceKey(
    property(value, "connectionSourceKey", "Binding"),
    "Binding connectionSourceKey",
  )
  if (sourceKey !== `slot:${slotId}`) fail("Binding connectionSourceKey must match slotId")
  const connectionId = assertConnectionId(
    property(value, "connectionId", "Binding"),
    sourceKey,
    "Binding connectionId",
    false,
  )
  if (connectionId === null) return fail("Binding connectionId must be concrete")

  return freezeBinding({
    presetId,
    slotId,
    connectionSourceKey: sourceKey,
    connectionId,
    dispatchRevision: assertOpaqueToken(
      property(value, "dispatchRevision", "Binding"),
      "Binding dispatchRevision",
    ),
  })
}

export function decodeConsentRecord(value: unknown): ConsentRecord {
  if (!isPlainRecord(value)) return fail("Consent must be a plain JSON object")
  assertExactKeys(
    value,
    [
      "installId",
      "nonce",
      "presetId",
      "threadId",
      "workspaceSource",
      "connectionSourceKey",
      "connectionId",
      "dispatchRevision",
      "disclosureVersion",
    ],
    "Consent",
  )
  const sourceKey = assertConnectionSourceKey(
    property(value, "connectionSourceKey", "Consent"),
    "Consent connectionSourceKey",
  )
  const connectionId = assertConnectionId(
    property(value, "connectionId", "Consent"),
    sourceKey,
    "Consent connectionId",
    true,
  )

  return freezeConsent({
    installId: assertCanonicalUuid(property(value, "installId", "Consent"), "Consent installId"),
    nonce: assertInstallNonce(property(value, "nonce", "Consent"), "Consent nonce"),
    presetId: assertCanonicalUuid(property(value, "presetId", "Consent"), "Consent presetId"),
    threadId: assertThreadId(property(value, "threadId", "Consent"), "Consent threadId"),
    workspaceSource: assertWorkspaceSource(property(value, "workspaceSource", "Consent")),
    connectionSourceKey: sourceKey,
    connectionId,
    dispatchRevision: assertOpaqueToken(
      property(value, "dispatchRevision", "Consent"),
      "Consent dispatchRevision",
    ),
    disclosureVersion: assertDisclosureVersion(property(value, "disclosureVersion", "Consent")),
  })
}

function decodeMap<T>(
  value: unknown,
  label: string,
  decodeValue: (value: unknown) => T,
  expectedKey: (value: T) => string,
  seen: WeakSet<object>,
  maxEntries?: number,
): Readonly<Record<string, T>> {
  if (!isPlainRecord(value)) return fail(`${label} must be a plain JSON object`)
  assertNoDangerousOwnKeys(value, label)
  const names = Object.getOwnPropertyNames(value)
  if (maxEntries !== undefined && names.length > maxEntries) {
    return fail(`${label} contains more than ${maxEntries} entries`)
  }
  assertNoCycles(value, seen, label)
  const output: Record<string, T> = {}

  for (const key of names) {
    if (DANGEROUS_KEYS.has(key)) fail(`${label} contains a dangerous key: ${key}`)
    const decoded = decodeValue(property(value, key, label))
    if (key !== expectedKey(decoded)) fail(`${label} key does not match its value`)
    output[key] = decoded
  }

  Object.freeze(output)
  return output
}

function decodeBindingConsentDocumentInternal(
  value: unknown,
  canonicalPresetId?: string,
): BindingConsentDocument {
  if (!isPlainRecord(value)) return fail("Binding/consent document must be a plain JSON object")
  assertExactKeys(value, ["schemaVersion", "documentRevision", "bindings", "consents"], "Binding/consent document")
  if (property(value, "schemaVersion", "Binding/consent document") !== SCHEMA_VERSION) {
    return fail("Binding/consent document schemaVersion must be 1")
  }
  assertDocumentByteLimit(value)
  const expectedPresetId =
    canonicalPresetId === undefined
      ? undefined
      : assertCanonicalUuid(canonicalPresetId, "Binding/consent document canonical presetId")

  const seen = new WeakSet<object>()
  assertNoCycles(value, seen, "Binding/consent document")
  const documentRevision = assertRevision(
    property(value, "documentRevision", "Binding/consent document"),
    "Binding/consent document documentRevision",
  )
  const bindings = decodeMap(
    property(value, "bindings", "Binding/consent document"),
    "Binding/consent document bindings",
    (entry) => {
      const decoded = decodeBindingRecord(entry)
      assertNoCycles(entry, seen, "Binding")
      return decoded
    },
    (entry) => buildBindingKey(entry.presetId, entry.slotId),
    seen,
  )
  if (Object.keys(bindings).length > MAX_CONNECTION_SLOTS) {
    return fail(
      `Binding/consent document contains more than ${MAX_CONNECTION_SLOTS} bindings`,
    )
  }
  const consents = decodeMap(
    property(value, "consents", "Binding/consent document"),
    "Binding/consent document consents",
    (entry) => {
      const decoded = decodeConsentRecord(entry)
      assertNoCycles(entry, seen, "Consent")
      return decoded
    },
    (entry) => buildConsentKey(entry),
    seen,
    MAX_CONSENTS_PER_DOCUMENT,
  )
  if (expectedPresetId !== undefined) {
    for (const binding of Object.values(bindings)) {
      assertMatchingPresetId(binding.presetId, expectedPresetId, "Binding/consent document binding")
    }
    for (const consent of Object.values(consents)) {
      assertMatchingPresetId(consent.presetId, expectedPresetId, "Binding/consent document consent")
    }
  }

  return freezeDocument(documentRevision, { ...bindings }, { ...consents })
}

export function decodeBindingConsentDocument(
  value: unknown,
  canonicalPresetId: string,
): BindingConsentDocument {
  const expectedPresetId = assertCanonicalUuid(
    canonicalPresetId,
    "Binding/consent document canonical presetId",
  )
  return decodeBindingConsentDocumentInternal(value, expectedPresetId)
}

function encodePathSegment(value: string): string {
  // Keep ordinary host IDs readable while escaping path syntax and controls.
  return /^[A-Za-z0-9._~-]+$/.test(value) ? value : encodeURIComponent(value)
}

export function buildInstallRecordKey(): string {
  return `${APC_STORAGE_NAMESPACE}/${INSTALL_RECORD_FILENAME}`
}

export function buildBindingDocumentKey(userId: string, presetId: string): string {
  const user = assertPathSegment(userId, "authoritative callback userId")
  const preset = assertCanonicalUuid(presetId, "presetId")
  return `${encodePathSegment(user)}/${APC_STORAGE_NAMESPACE}/presets/${encodePathSegment(preset)}/bindings.json`
}

export function buildBindingKey(presetId: string, slotId: string): string {
  const preset = assertCanonicalUuid(presetId, "presetId")
  const slot = assertCanonicalUuid(slotId, "slotId")
  return `${encodePathSegment(preset)}:${encodePathSegment(slot)}`
}

export type ConsentKeyInput = ConsentRecord | Readonly<{
  installId: string
  nonce: string
  presetId: string
  threadId: string
  workspaceSource: "native-blocks" | "main-context"
  connectionSourceKey: "main" | `slot:${string}`
  connectionId: string | null
  dispatchRevision: string
  disclosureVersion: number
}>

export function buildConsentKey(consent: ConsentKeyInput): string
export function buildConsentKey(
  installId: string,
  nonce: string,
  presetId: string,
  threadId: string,
  workspaceSource: "native-blocks" | "main-context",
  connectionSourceKey: "main" | `slot:${string}`,
  connectionId: string | null,
  dispatchRevision: string,
  disclosureVersion: number,
): string
export function buildConsentKey(
  first: ConsentKeyInput | string,
  nonce?: string,
  presetId?: string,
  threadId?: string,
  workspaceSource?: "native-blocks" | "main-context",
  connectionSourceKey?: "main" | `slot:${string}`,
  connectionId?: string | null,
  dispatchRevision?: string,
  disclosureVersion?: number,
): string {
  const candidate: ConsentKeyInput =
    typeof first === "string"
      ? {
          installId: first,
          nonce: nonce as string,
          presetId: presetId as string,
          threadId: threadId as string,
          workspaceSource: workspaceSource as "native-blocks" | "main-context",
          connectionSourceKey: connectionSourceKey as "main" | `slot:${string}`,
          connectionId: connectionId ?? null,
          dispatchRevision: dispatchRevision as string,
          disclosureVersion: disclosureVersion as number,
        }
      : first
  const installId = assertCanonicalUuid(candidate.installId, "Consent installId")
  const installNonce = assertInstallNonce(candidate.nonce, "Consent nonce")
  const normalizedPresetId = assertCanonicalUuid(candidate.presetId, "Consent presetId")
  const normalizedThreadId = assertThreadId(candidate.threadId, "Consent threadId")
  const source = assertWorkspaceSource(candidate.workspaceSource)
  const sourceKey = assertConnectionSourceKey(candidate.connectionSourceKey, "Consent connectionSourceKey")
  const normalizedConnectionId = assertConnectionId(
    candidate.connectionId,
    sourceKey,
    "Consent connectionId",
    true,
  )
  const revision = assertOpaqueToken(candidate.dispatchRevision, "Consent dispatchRevision")
  const version = assertDisclosureVersion(candidate.disclosureVersion)

  return [
    encodePathSegment(installId),
    encodePathSegment(installNonce),
    encodePathSegment(normalizedPresetId),
    encodePathSegment(normalizedThreadId),
    encodePathSegment(source),
    encodePathSegment(sourceKey),
    encodePathSegment(normalizedConnectionId ?? "none"),
    encodePathSegment(revision),
    String(version),
  ].join("|")
}

function decodeBindingIntent(value: unknown, canonicalPresetId?: string): BindingIntent {
  if (!isPlainRecord(value)) return fail("Binding intent must be a plain JSON object")
  const type = property(value, "type", "Binding intent")
  if (type !== "bind" && type !== "set" && type !== "unbind" && type !== "remove") {
    return fail("Binding intent type is invalid")
  }
  const expectedPresetId =
    canonicalPresetId === undefined
      ? undefined
      : assertCanonicalUuid(canonicalPresetId, "Binding intent canonical presetId")

  if (type === "unbind" || type === "remove") {
    assertExactKeys(value, ["type", "presetId", "slotId"], "Binding intent")
    const presetId = assertCanonicalUuid(
      property(value, "presetId", "Binding intent"),
      "Binding intent presetId",
    )
    if (expectedPresetId !== undefined) {
      assertMatchingPresetId(presetId, expectedPresetId, "Binding intent")
    }
    return {
      type,
      presetId,
      slotId: assertCanonicalUuid(property(value, "slotId", "Binding intent"), "Binding intent slotId"),
    }
  }

  const names = Object.getOwnPropertyNames(value)
  if (names.length === 2 && names.includes("binding")) {
    assertExactKeys(value, ["type", "binding"], "Binding intent")
    const binding = decodeBindingRecord(property(value, "binding", "Binding intent"))
    if (expectedPresetId !== undefined) {
      assertMatchingPresetId(binding.presetId, expectedPresetId, "Binding intent binding")
    }
    return { type, binding }
  }
  assertExactKeys(
    value,
    ["type", "presetId", "slotId", "connectionSourceKey", "connectionId", "dispatchRevision"],
    "Binding intent",
  )
  const presetId = assertCanonicalUuid(property(value, "presetId", "Binding intent"), "Binding intent presetId")
  const slotId = assertCanonicalUuid(property(value, "slotId", "Binding intent"), "Binding intent slotId")
  if (expectedPresetId !== undefined) {
    assertMatchingPresetId(presetId, expectedPresetId, "Binding intent")
  }
  const connectionSourceKey = assertConnectionSourceKey(
    property(value, "connectionSourceKey", "Binding intent"),
    "Binding intent connectionSourceKey",
  )
  if (connectionSourceKey !== `slot:${slotId}`) fail("Binding intent connectionSourceKey must match slotId")
  return {
    type,
    presetId,
    slotId,
    connectionSourceKey,
    connectionId: assertCanonicalUuid(
      property(value, "connectionId", "Binding intent"),
      "Binding intent connectionId",
    ),
    dispatchRevision: assertOpaqueToken(
      property(value, "dispatchRevision", "Binding intent"),
      "Binding intent dispatchRevision",
    ),
  }
}

export function reduceBindingIntent(
  document: BindingConsentDocument,
  rawIntent: BindingIntent,
  canonicalPresetId?: string,
): BindingConsentDocument {
  const expectedPresetId =
    canonicalPresetId === undefined
      ? undefined
      : assertCanonicalUuid(canonicalPresetId, "Binding intent canonical presetId")
  const current = decodeBindingConsentDocumentInternal(document, expectedPresetId)
  const intent = decodeBindingIntent(rawIntent, expectedPresetId)
  const bindings: Record<string, BindingRecord> = { ...current.bindings }
  const consents: Record<string, ConsentRecord> = { ...current.consents }

  if (intent.type === "unbind" || intent.type === "remove") {
    delete bindings[buildBindingKey(intent.presetId, intent.slotId)]
    const sourceKey = `slot:${intent.slotId}`
    for (const [key, consent] of Object.entries(consents)) {
      if (consent.presetId === intent.presetId && consent.connectionSourceKey === sourceKey) {
        delete consents[key]
      }
    }
  } else {
    let binding: BindingRecord
    if ("binding" in intent) {
      binding = decodeBindingRecord(intent.binding)
    } else if ("connectionSourceKey" in intent) {
      binding = decodeBindingRecord({
        presetId: intent.presetId,
        slotId: intent.slotId,
        connectionSourceKey: intent.connectionSourceKey,
        connectionId: intent.connectionId,
        dispatchRevision: intent.dispatchRevision,
      })
    } else {
      return fail("Binding intent is missing binding fields")
    }
    const key = buildBindingKey(binding.presetId, binding.slotId)
    bindings[key] = binding
  }

  if (Object.keys(bindings).length > MAX_CONNECTION_SLOTS) {
    return fail(
      `Binding/consent document contains more than ${MAX_CONNECTION_SLOTS} bindings`,
    )
  }
  return freezeDocument(current.documentRevision, bindings, consents)
}

function decodeConsentIntent(value: unknown): ConsentIntent {
  if (!isPlainRecord(value)) return fail("Consent intent must be a plain JSON object")
  const type = property(value, "type", "Consent intent")
  if (type !== "grant" && type !== "set" && type !== "revoke" && type !== "remove") {
    return fail("Consent intent type is invalid")
  }

  if (type === "revoke" || type === "remove") {
    const names = Object.getOwnPropertyNames(value)
    if (names.length === 2 && names.includes("key")) {
      assertExactKeys(value, ["type", "key"], "Consent intent")
      const key = property(value, "key", "Consent intent")
      if (typeof key !== "string" || key.length === 0 || key.length > 1024) {
        return fail("Consent intent key is invalid")
      }
      return { type, key }
    }
    assertExactKeys(value, ["type", "consent"], "Consent intent")
    return { type, consent: decodeConsentRecord(property(value, "consent", "Consent intent")) }
  }

  const names = Object.getOwnPropertyNames(value)
  if (names.length === 2 && names.includes("consent")) {
    assertExactKeys(value, ["type", "consent"], "Consent intent")
    return { type, consent: decodeConsentRecord(property(value, "consent", "Consent intent")) }
  }
  assertExactKeys(
    value,
    [
      "type",
      "installId",
      "nonce",
      "presetId",
      "threadId",
      "workspaceSource",
      "connectionSourceKey",
      "connectionId",
      "dispatchRevision",
      "disclosureVersion",
    ],
    "Consent intent",
  )
  return {
    type,
    consent: decodeConsentRecord({
      installId: property(value, "installId", "Consent intent"),
      nonce: property(value, "nonce", "Consent intent"),
      presetId: property(value, "presetId", "Consent intent"),
      threadId: property(value, "threadId", "Consent intent"),
      workspaceSource: property(value, "workspaceSource", "Consent intent"),
      connectionSourceKey: property(value, "connectionSourceKey", "Consent intent"),
      connectionId: property(value, "connectionId", "Consent intent"),
      dispatchRevision: property(value, "dispatchRevision", "Consent intent"),
      disclosureVersion: property(value, "disclosureVersion", "Consent intent"),
    }),
  }
}

export function reduceConsentIntent(
  document: BindingConsentDocument,
  rawIntent: ConsentIntent,
  canonicalPresetId?: string,
): BindingConsentDocument {
  const expectedPresetId =
    canonicalPresetId === undefined
      ? undefined
      : assertCanonicalUuid(canonicalPresetId, "Consent intent canonical presetId")
  const current = decodeBindingConsentDocumentInternal(document, expectedPresetId)
  const intent = decodeConsentIntent(rawIntent)
  if (expectedPresetId !== undefined && "consent" in intent) {
    assertMatchingPresetId(intent.consent.presetId, expectedPresetId, "Consent intent")
  }
  const bindings: Record<string, BindingRecord> = { ...current.bindings }
  const consents: Record<string, ConsentRecord> = { ...current.consents }

  if (intent.type === "revoke" || intent.type === "remove") {
    const key = "key" in intent ? intent.key : buildConsentKey(intent.consent)
    delete consents[key]
  } else {
    if (!("consent" in intent)) return fail("Consent intent is missing consent fields")
    const consent = decodeConsentRecord(intent.consent)
    consents[buildConsentKey(consent)] = consent
  }

  return freezeDocument(current.documentRevision, bindings, consents)
}

export function generateInstallNonce(): string {
  const bytes = new Uint8Array(16)
  const source = globalThis.crypto
  if (!source || typeof source.getRandomValues !== "function") {
    throw new Error("CSPRNG unavailable for install nonce generation")
  }
  source.getRandomValues(bytes)
  let output = ""
  for (const byte of bytes) output += byte.toString(16).padStart(2, "0")
  if (!INSTALL_NONCE_PATTERN.test(output)) throw new Error("CSPRNG generated an invalid nonce")
  return output
}

export function validateInstallPair(record: InstallRecord): InstallPair {
  const decoded = decodeInstallRecord(record)
  return Object.freeze({
    extensionInstallationId: decoded.extensionInstallationId,
    installNonce: decoded.installNonce,
  })
}
