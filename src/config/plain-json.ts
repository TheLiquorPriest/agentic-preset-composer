import {
  MAX_CONFIG_BYTES,
  MAX_PLAIN_JSON_DEPTH,
  MAX_PLAIN_JSON_NODES,
  MAX_PLAIN_JSON_PATH_CHARS,
  utf8Bytes,
} from "./limits"

const DANGEROUS_KEYS: Record<string, true> = Object.create(null) as Record<string, true>
for (const key of ["__proto__", "prototype", "constructor"]) DANGEROUS_KEYS[key] = true
const ARRAY_INDEX_LIMIT = 2 ** 32 - 1

export type PlainJsonErrorCode =
  | "unsupported-type"
  | "non-finite-number"
  | "cycle"
  | "custom-prototype"
  | "accessor"
  | "own-to-json"
  | "dangerous-key"
  | "symbol-key"
  | "sparse-array"
  | "non-enumerable-key"
  | "array-property"
  | "depth-limit"
  | "node-limit"
  | "path-limit"
  | "inspection-failed"
  | "serialization-failed"

export interface PlainJsonError {
  readonly path: string
  readonly code: PlainJsonErrorCode
  readonly message: string
}

export type PlainJsonScanResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: PlainJsonError }

export type SerializedUtf8BytesResult =
  | { readonly ok: true; readonly bytes: number }
  | { readonly ok: false; readonly error: PlainJsonError }

export type SanitizedPlainJsonResult =
  | { readonly ok: true; readonly value: unknown; readonly bytes: number }
  | { readonly ok: false; readonly error: PlainJsonError }

type PathPart = string | number

interface PathNode {
  readonly parent: PathNode | null
  readonly part?: PathPart
  readonly chars: number
}

interface ChildEntry {
  readonly key: string
  readonly index?: number
  readonly descriptor: PropertyDescriptor
  readonly path: PathNode
}

type CanonicalContainer = Record<string, unknown> | unknown[]

interface Frame {
  readonly value: object
  readonly path: PathNode
  readonly depth: number
  readonly entries: readonly ChildEntry[]
  readonly canonical: CanonicalContainer | undefined
  next: number
}

interface InspectionSuccess {
  readonly ok: true
  readonly canonical?: unknown
  readonly serializedBytes: number
}

type InspectionResult = InspectionSuccess | { readonly ok: false; readonly error: PlainJsonError }


function pathForKey(path: string, key: string): string {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) {
    return `${path}.${key}`
  }
  return `${path}[${JSON.stringify(key)}]`
}

function boundedPathForKey(path: PathNode, key: string): string | undefined {
  const minimumChars = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key.length + 1 : key.length + 2
  if (path.chars + minimumChars > MAX_PLAIN_JSON_PATH_CHARS) return undefined
  const parentText = pathText(path)
  const propertyPath = pathForKey(parentText, key)
  return propertyPath.length > MAX_PLAIN_JSON_PATH_CHARS ? undefined : propertyPath
}

function pathForIndex(path: string, index: number): string {
  return `${path}[${index}]`
}

function arrayIndex(key: string): number | undefined {
  if (!/^(?:0|[1-9][0-9]*)$/.test(key)) {
    return undefined
  }
  const index = Number(key)
  if (!Number.isSafeInteger(index) || index >= ARRAY_INDEX_LIMIT) {
    return undefined
  }
  return index
}

function isAccessor(descriptor: PropertyDescriptor): boolean {
  return "get" in descriptor || "set" in descriptor
}

function inspectionFailure(path: string, subject: string): InspectionResult {
  return {
    ok: false,
    error: {
      path,
      code: "inspection-failed",
      message: `Unable to inspect ${subject} without invoking user code`,
    },
  }
}

function pathText(path: PathNode): string {
  const parts: PathPart[] = []
  let current: PathNode | null = path
  while (current.parent !== null) {
    parts.push(current.part as PathPart)
    current = current.parent
  }
  parts.reverse()
  const segments: string[] = []
  for (const part of parts) {
    if (typeof part === "number") {
      segments.push(`[${part}]`)
    } else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(part)) {
      segments.push(`.${part}`)
    } else {
      segments.push(`[${JSON.stringify(part)}]`)
    }
  }
  return `$${segments.join("")}`
}

function pathSegmentChars(part: PathPart): number {
  if (typeof part === "number") return String(part).length + 2
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(part)) return part.length + 1
  return JSON.stringify(part).length + 2
}

function childPath(parent: PathNode, part: PathPart): PathNode | undefined {
  if (typeof part === "string") {
    const minimumChars = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(part) ? part.length + 1 : part.length + 2
    if (parent.chars + minimumChars > MAX_PLAIN_JSON_PATH_CHARS) return undefined
  }
  const chars = parent.chars + pathSegmentChars(part)
  if (chars > MAX_PLAIN_JSON_PATH_CHARS) return undefined
  return { parent, part, chars }
}

function nodeLimit(path: PathNode): InspectionResult {
  return {
    ok: false,
    error: {
      path: pathText(path),
      code: "node-limit",
      message: `Plain JSON exceeds ${MAX_PLAIN_JSON_NODES} nodes`,
    },
  }
}

function depthLimit(path: PathNode): InspectionResult {
  return {
    ok: false,
    error: {
      path: pathText(path),
      code: "depth-limit",
      message: `Plain JSON exceeds ${MAX_PLAIN_JSON_DEPTH} levels`,
    },
  }
}

function pathLimit(path: PathNode): InspectionResult {
  return {
    ok: false,
    error: {
      path: pathText(path),
      code: "path-limit",
      message: `Plain JSON path exceeds ${MAX_PLAIN_JSON_PATH_CHARS} characters`,
    },
  }
}

function assignCanonical(
  parent: CanonicalContainer | undefined,
  key: string,
  index: number | undefined,
  value: unknown,
): void {
  if (parent === undefined) return
  if (Array.isArray(parent)) {
    parent[index as number] = value
  } else {
    parent[key] = value
  }
}
const SERIALIZED_BYTE_OVERFLOW = MAX_CONFIG_BYTES + 1

function boundedJsonStringUtf8Bytes(value: string): number {
  if (value.length > MAX_CONFIG_BYTES - 2) return SERIALIZED_BYTE_OVERFLOW
  let bytes = 2
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    let addition: number
    if (codeUnit === 0x08 || codeUnit === 0x09 || codeUnit === 0x0a || codeUnit === 0x0c || codeUnit === 0x0d) {
      addition = 2
    } else if (codeUnit <= 0x1f || codeUnit === 0x22 || codeUnit === 0x5c) {
      addition = codeUnit <= 0x1f ? 6 : 2
    } else if (codeUnit <= 0x7f) {
      addition = 1
    } else if (codeUnit <= 0x7ff) {
      addition = 2
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        addition = 4
        index += 1
      } else {
        addition = 6
      }
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      addition = 6
    } else {
      addition = 3
    }
    if (bytes > MAX_CONFIG_BYTES - addition) return SERIALIZED_BYTE_OVERFLOW
    bytes += addition
  }
  return bytes
}

function serializedNumberUtf8Bytes(value: number): number {
  return String(value).length
}

function serializationLimit(path: PathNode): InspectionResult {
  const text = pathText(path)
  return {
    ok: false,
    error: {
      path: text,
      code: "serialization-failed",
      message: `Plain JSON exceeds ${MAX_CONFIG_BYTES} UTF-8 bytes`,
    },
  }
}

function inspectPlainJson(value: unknown, buildCanonical: boolean, rejectSerializedLimit: boolean): InspectionResult {
  const rootPath: PathNode = { parent: null, chars: 1 }
  const visiting = new WeakSet<object>()
  const stack: Frame[] = []
  let nodeCount = 0
  let canonicalRoot: unknown
  let serializedBytes = 0
  const addSerializedBytes = (bytes: number, path: PathNode): InspectionResult | undefined => {
    if (serializedBytes > MAX_CONFIG_BYTES) {
      return rejectSerializedLimit ? serializationLimit(path) : undefined
    }
    if (bytes > MAX_CONFIG_BYTES - serializedBytes) {
      serializedBytes = SERIALIZED_BYTE_OVERFLOW
      return rejectSerializedLimit ? serializationLimit(path) : undefined
    }
    serializedBytes += bytes
    return undefined
  }

  const enter = (
    current: unknown,
    path: PathNode,
    depth: number,
    parent: CanonicalContainer | undefined,
    key: string,
    index: number | undefined,
  ): InspectionResult | undefined => {
    if (depth > MAX_PLAIN_JSON_DEPTH) return depthLimit(path)
    if (nodeCount >= MAX_PLAIN_JSON_NODES) return nodeLimit(path)
    nodeCount += 1

    if (current === null || typeof current === "string" || typeof current === "boolean") {
      if (serializedBytes <= MAX_CONFIG_BYTES) {
        const bytes =
          current === null
            ? 4
            : typeof current === "string"
              ? boundedJsonStringUtf8Bytes(current)
              : current
                ? 4
                : 5
        const budgetFailure = addSerializedBytes(bytes, path)
        if (budgetFailure !== undefined) return budgetFailure
      }
      assignCanonical(parent, key, index, current)
      if (parent === undefined) canonicalRoot = current
      return undefined
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        return {
          ok: false,
          error: {
            path: pathText(path),
            code: "non-finite-number",
            message: `Non-finite number at ${pathText(path)}`,
          },
        }
      }
      if (serializedBytes <= MAX_CONFIG_BYTES) {
        const budgetFailure = addSerializedBytes(serializedNumberUtf8Bytes(current), path)
        if (budgetFailure !== undefined) return budgetFailure
      }
      assignCanonical(parent, key, index, current)
      if (parent === undefined) canonicalRoot = current
      return undefined
    }
    if (typeof current !== "object") {
      return {
        ok: false,
        error: {
          path: pathText(path),
          code: "unsupported-type",
          message: `Unsupported JSON value at ${pathText(path)}`,
        },
      }
    }
    if (visiting.has(current)) {
      return {
        ok: false,
        error: {
          path: pathText(path),
          code: "cycle",
          message: `Cyclic reference at ${pathText(path)}`,
        },
      }
    }
    visiting.add(current)

    let prototype: object | null
    let keys: readonly (string | symbol)[]
    try {
      try {
        prototype = Object.getPrototypeOf(current)
      } catch {
        return inspectionFailure(pathText(path), "the value")
      }

      const isArray = Array.isArray(current)
      const expectedPrototype = isArray ? Array.prototype : Object.prototype
      if (prototype !== null && prototype !== expectedPrototype) {
        return {
          ok: false,
          error: {
            path: pathText(path),
            code: "custom-prototype",
            message: `Custom prototype at ${pathText(path)}`,
          },
        }
      }

      try {
        keys = Reflect.ownKeys(current)
      } catch {
        return inspectionFailure(pathText(path), "own properties")
      }
      const childCount = isArray ? Math.max(0, keys.length - 1) : keys.length
      if (childCount > MAX_PLAIN_JSON_NODES - nodeCount) return nodeLimit(path)

      let entries: ChildEntry[]
      let canonical: CanonicalContainer | undefined
      if (isArray) {
        let lengthDescriptor: PropertyDescriptor | undefined
        const arrayEntries: ChildEntry[] = []
        for (const rawKey of keys) {
          if (typeof rawKey === "symbol") {
            return {
              ok: false,
              error: {
                path: pathText(path),
                code: "symbol-key",
                message: `Symbol property at ${pathText(path)}`,
              },
            }
          }
          let descriptor: PropertyDescriptor | undefined
          try {
            descriptor = Object.getOwnPropertyDescriptor(current, rawKey)
          } catch {
            const propertyPath = boundedPathForKey(path, rawKey)
            if (propertyPath === undefined) return pathLimit(path)
            return inspectionFailure(propertyPath, "an array property")
          }
          if (descriptor === undefined) {
            const propertyPath = boundedPathForKey(path, rawKey)
            if (propertyPath === undefined) return pathLimit(path)
            return inspectionFailure(propertyPath, "an array property")
          }
          if (rawKey === "length") {
            lengthDescriptor = descriptor
            continue
          }
          if (DANGEROUS_KEYS[rawKey] === true) {
            const propertyPath = boundedPathForKey(path, rawKey)
            if (propertyPath === undefined) return pathLimit(path)
            return {
              ok: false,
              error: {
                path: propertyPath,
                code: "dangerous-key",
                message: `Dangerous property key ${JSON.stringify(rawKey)}`,
              },
            }
          }
          if (rawKey === "toJSON") {
            const propertyPath = boundedPathForKey(path, rawKey)
            if (propertyPath === undefined) return pathLimit(path)
            return {
              ok: false,
              error: {
                path: propertyPath,
                code: "own-to-json",
                message: `Own toJSON property at ${propertyPath}`,
              },
            }
          }
          if (isAccessor(descriptor)) {
            const propertyPath = boundedPathForKey(path, rawKey)
            if (propertyPath === undefined) return pathLimit(path)
            return {
              ok: false,
              error: {
                path: propertyPath,
                code: "accessor",
                message: `Accessor property at ${propertyPath}`,
              },
            }
          }
          if (!descriptor.enumerable) {
            const propertyPath = boundedPathForKey(path, rawKey)
            if (propertyPath === undefined) return pathLimit(path)
            return {
              ok: false,
              error: {
                path: propertyPath,
                code: "non-enumerable-key",
                message: `Non-enumerable property at ${propertyPath}`,
              },
            }
          }
          const indexValue = arrayIndex(rawKey)
          if (indexValue === undefined) {
            const propertyPath = boundedPathForKey(path, rawKey)
            if (propertyPath === undefined) return pathLimit(path)
            return {
              ok: false,
              error: {
                path: propertyPath,
                code: "array-property",
                message: `Non-index array property at ${propertyPath}`,
              },
            }
          }
          const entryPath = childPath(path, indexValue)
          if (entryPath === undefined) return pathLimit(path)
          arrayEntries.push({ key: rawKey, index: indexValue, descriptor, path: entryPath })
        }

        if (lengthDescriptor === undefined || isAccessor(lengthDescriptor) || !("value" in lengthDescriptor)) {
          return inspectionFailure(pathText(path), "array length")
        }
        const length = lengthDescriptor.value
        if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length >= ARRAY_INDEX_LIMIT) {
          return inspectionFailure(pathText(path), "array length")
        }
        if (length > MAX_PLAIN_JSON_NODES - nodeCount) return nodeLimit(path)
        if (arrayEntries.length !== length) {
          return {
            ok: false,
            error: {
              path: pathText(path),
              code: "sparse-array",
              message: `Sparse array at ${pathText(path)}`,
            },
          }
        }
        arrayEntries.sort((left, right) => (left.index as number) - (right.index as number))
        entries = arrayEntries
        if (buildCanonical) {
          canonical = new Array<unknown>(length)
          Object.setPrototypeOf(canonical, null)
        }
      } else {
        const objectEntries: ChildEntry[] = []
        for (const rawKey of keys) {
          if (typeof rawKey === "symbol") {
            return {
              ok: false,
              error: {
                path: pathText(path),
                code: "symbol-key",
                message: `Symbol property at ${pathText(path)}`,
              },
            }
          }
          const entryPath = childPath(path, rawKey)
          if (entryPath === undefined) return pathLimit(path)
          let descriptor: PropertyDescriptor | undefined
          try {
            descriptor = Object.getOwnPropertyDescriptor(current, rawKey)
          } catch {
            const propertyPath = boundedPathForKey(path, rawKey)
            if (propertyPath === undefined) return pathLimit(path)
            return inspectionFailure(propertyPath, "an object property")
          }
          if (descriptor === undefined) {
            const propertyPath = boundedPathForKey(path, rawKey)
            if (propertyPath === undefined) return pathLimit(path)
            return inspectionFailure(propertyPath, "an object property")
          }
          if (DANGEROUS_KEYS[rawKey] === true) {
            const propertyPath = pathText(entryPath)
            return {
              ok: false,
              error: {
                path: propertyPath,
                code: "dangerous-key",
                message: `Dangerous property key ${JSON.stringify(rawKey)}`,
              },
            }
          }
          if (rawKey === "toJSON") {
            const propertyPath = pathText(entryPath)
            return {
              ok: false,
              error: {
                path: propertyPath,
                code: "own-to-json",
                message: `Own toJSON property at ${propertyPath}`,
              },
            }
          }
          if (isAccessor(descriptor)) {
            const propertyPath = pathText(entryPath)
            return {
              ok: false,
              error: {
                path: propertyPath,
                code: "accessor",
                message: `Accessor property at ${propertyPath}`,
              },
            }
          }
          if (!descriptor.enumerable) {
            const propertyPath = pathText(entryPath)
            return {
              ok: false,
              error: {
                path: propertyPath,
                code: "non-enumerable-key",
                message: `Non-enumerable property at ${propertyPath}`,
              },
            }
          }
          objectEntries.push({ key: rawKey, descriptor, path: entryPath })
        }
        entries = objectEntries
        if (buildCanonical) canonical = Object.create(null) as Record<string, unknown>
      }
      if (serializedBytes <= MAX_CONFIG_BYTES) {
        let containerBytes = 2
        for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
          if (entryIndex > 0) containerBytes += 1
          if (!isArray) {
            const entry = entries[entryIndex] as ChildEntry
            containerBytes += boundedJsonStringUtf8Bytes(entry.key) + 1
          }
        }
        const budgetFailure = addSerializedBytes(containerBytes, path)
        if (budgetFailure !== undefined) return budgetFailure
      }
      if (buildCanonical) {
        assignCanonical(parent, key, index, canonical)
        if (parent === undefined) canonicalRoot = canonical
      }
      stack.push({ value: current, path, depth, entries, canonical, next: 0 })
      return undefined
    } catch (error) {
      if (error instanceof RangeError) {
        return inspectionFailure(pathText(path), "the value")
      }
      return inspectionFailure(pathText(path), "the value")
    }
  }

  const entered = enter(value, rootPath, 0, undefined, "", undefined)
  if (entered !== undefined) {
    return entered
  }

  while (stack.length > 0) {
    const frame = stack[stack.length - 1] as Frame
    if (frame.next >= frame.entries.length) {
      visiting.delete(frame.value)
      stack.pop()
      continue
    }
    const entry = frame.entries[frame.next] as ChildEntry
    frame.next += 1
    const enteredChild = enter(
      entry.descriptor.value,
      entry.path,
      frame.depth + 1,
      frame.canonical,
      entry.key,
      entry.index,
    )
    if (enteredChild !== undefined) {
      return enteredChild
    }
  }
  return buildCanonical ? { ok: true, canonical: canonicalRoot, serializedBytes } : { ok: true, serializedBytes }
}

export function scanPlainJson(value: unknown): PlainJsonScanResult {
  const inspected = inspectPlainJson(value, false, true)
  return inspected.ok ? { ok: true } : inspected
}

export function sanitizedPlainJson(value: unknown): SanitizedPlainJsonResult {
  const inspected = inspectPlainJson(value, true, false)
  if (!inspected.ok) return inspected
  if (inspected.serializedBytes > MAX_CONFIG_BYTES) {
    return { ok: true, value: inspected.canonical, bytes: inspected.serializedBytes }
  }

  let serialized: string | undefined
  try {
    serialized = JSON.stringify(inspected.canonical)
  } catch {
    return {
      ok: false,
      error: {
        path: "$",
        code: "serialization-failed",
        message: "Unable to serialize the sanitized plain JSON value",
      },
    }
  }
  if (serialized === undefined) {
    return {
      ok: false,
      error: {
        path: "$",
        code: "serialization-failed",
        message: "The scanned value did not produce JSON text",
      },
    }
  }
  return { ok: true, value: inspected.canonical, bytes: utf8Bytes(serialized) }
}

export function serializedUtf8Bytes(value: unknown): SerializedUtf8BytesResult {
  const sanitized = sanitizedPlainJson(value)
  if (!sanitized.ok) return sanitized
  return { ok: true, bytes: sanitized.bytes }
}
