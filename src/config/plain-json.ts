import { utf8Bytes } from "./limits"

const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"])
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

function fail(path: string, code: PlainJsonErrorCode, message: string): PlainJsonScanResult {
  return { ok: false, error: { path, code, message } }
}

function pathForKey(path: string, key: string): string {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) {
    return `${path}.${key}`
  }
  return `${path}[${JSON.stringify(key)}]`
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

function inspectionFailure(path: string, subject: string): PlainJsonScanResult {
  return fail(path, "inspection-failed", `Unable to inspect ${subject} without invoking user code`)
}

export function scanPlainJson(value: unknown): PlainJsonScanResult {
  const visiting = new Set<object>()

  const walk = (current: unknown, path: string): PlainJsonScanResult => {
    if (current === null || typeof current === "string" || typeof current === "boolean") {
      return { ok: true }
    }

    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        return fail(path, "non-finite-number", `Non-finite number at ${path}`)
      }
      return { ok: true }
    }

    if (typeof current !== "object") {
      return fail(path, "unsupported-type", `Unsupported JSON value at ${path}`)
    }

    if (visiting.has(current)) {
      return fail(path, "cycle", `Cyclic reference at ${path}`)
    }
    visiting.add(current)

    let result: PlainJsonScanResult
    try {
      let prototype: object | null
      try {
        prototype = Object.getPrototypeOf(current)
      } catch {
        result = inspectionFailure(path, "the value")
        return result
      }

      const isArray = Array.isArray(current)
      const expectedPrototype = isArray ? Array.prototype : Object.prototype
      if (prototype !== null && prototype !== expectedPrototype) {
        result = fail(path, "custom-prototype", `Custom prototype at ${path}`)
        return result
      }

      let keys: readonly (string | symbol)[]
      try {
        keys = Reflect.ownKeys(current)
      } catch {
        result = inspectionFailure(path, "own properties")
        return result
      }

      if (isArray) {
        let lengthDescriptor: PropertyDescriptor | undefined
        const entries: Array<{ index: number; descriptor: PropertyDescriptor }> = []

        for (const key of keys) {
          if (typeof key === "symbol") {
            result = fail(path, "symbol-key", `Symbol property at ${path}`)
            return result
          }

          let descriptor: PropertyDescriptor | undefined
          try {
            descriptor = Object.getOwnPropertyDescriptor(current, key)
          } catch {
            result = inspectionFailure(pathForKey(path, key), "an array property")
            return result
          }
          if (descriptor === undefined) {
            result = inspectionFailure(pathForKey(path, key), "an array property")
            return result
          }
          if (key === "length") {
            lengthDescriptor = descriptor
            continue
          }
          if (DANGEROUS_KEYS.has(key)) {
            result = fail(pathForKey(path, key), "dangerous-key", `Dangerous property key ${JSON.stringify(key)}`)
            return result
          }
          if (key === "toJSON") {
            result = fail(pathForKey(path, key), "own-to-json", `Own toJSON property at ${pathForKey(path, key)}`)
            return result
          }
          if (isAccessor(descriptor)) {
            result = fail(pathForKey(path, key), "accessor", `Accessor property at ${pathForKey(path, key)}`)
            return result
          }
          if (!descriptor.enumerable) {
            result = fail(
              pathForKey(path, key),
              "non-enumerable-key",
              `Non-enumerable property at ${pathForKey(path, key)}`,
            )
            return result
          }

          const index = arrayIndex(key)
          if (index === undefined) {
            result = fail(pathForKey(path, key), "array-property", `Non-index array property at ${pathForKey(path, key)}`)
            return result
          }
          entries.push({ index, descriptor })
        }

        if (lengthDescriptor === undefined || isAccessor(lengthDescriptor) || !('value' in lengthDescriptor)) {
          result = inspectionFailure(path, "array length")
          return result
        }
        const length = lengthDescriptor.value
        if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length >= ARRAY_INDEX_LIMIT) {
          result = inspectionFailure(path, "array length")
          return result
        }
        if (entries.length !== length) {
          result = fail(path, "sparse-array", `Sparse array at ${path}`)
          return result
        }

        entries.sort((left, right) => left.index - right.index)
        for (const entry of entries) {
          result = walk(entry.descriptor.value, pathForIndex(path, entry.index))
          if (!result.ok) {
            return result
          }
        }
        result = { ok: true }
        return result
      }

      for (const key of keys) {
        if (typeof key === "symbol") {
          result = fail(path, "symbol-key", `Symbol property at ${path}`)
          return result
        }

        let descriptor: PropertyDescriptor | undefined
        try {
          descriptor = Object.getOwnPropertyDescriptor(current, key)
        } catch {
          result = inspectionFailure(pathForKey(path, key), "an object property")
          return result
        }
        if (descriptor === undefined) {
          result = inspectionFailure(pathForKey(path, key), "an object property")
          return result
        }
        const propertyPath = pathForKey(path, key)
        if (DANGEROUS_KEYS.has(key)) {
          result = fail(propertyPath, "dangerous-key", `Dangerous property key ${JSON.stringify(key)}`)
          return result
        }
        if (key === "toJSON") {
          result = fail(propertyPath, "own-to-json", `Own toJSON property at ${propertyPath}`)
          return result
        }
        if (isAccessor(descriptor)) {
          result = fail(propertyPath, "accessor", `Accessor property at ${propertyPath}`)
          return result
        }
        if (!descriptor.enumerable) {
          result = fail(propertyPath, "non-enumerable-key", `Non-enumerable property at ${propertyPath}`)
          return result
        }
        result = walk(descriptor.value, propertyPath)
        if (!result.ok) {
          return result
        }
      }

      result = { ok: true }
      return result
    } finally {
      visiting.delete(current)
    }
  }

  return walk(value, "$")
}

export function serializedUtf8Bytes(value: unknown): SerializedUtf8BytesResult {
  const scanned = scanPlainJson(value)
  if (!scanned.ok) {
    return scanned
  }

  let serialized: string | undefined
  try {
    serialized = JSON.stringify(value)
  } catch {
    return {
      ok: false,
      error: {
        path: "$",
        code: "serialization-failed",
        message: "Unable to serialize the scanned plain JSON value",
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
  return { ok: true, bytes: utf8Bytes(serialized) }
}
