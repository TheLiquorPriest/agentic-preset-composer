import type { SpindleHostDescriptorV1 } from "lumiverse-spindle-types"

/** Stable machine-readable code for local host compatibility failures. */
export const SPINDLE_COMPATIBILITY_ERROR_CODE = "SPINDLE_COMPATIBILITY_ERROR" as const

/** Generic required host boundaries for the Spindle host descriptor. */
export const MIN_LUMIVERSE_VERSION = "1.0.8" as const

/**
 * APC's required generic host capabilities. This local copy is deliberately
 * independent of host runtime constants and is immutable at module load.
 */
export const REQUIRED_HOST_CAPABILITIES = Object.freeze({
  "preset-extension-data-v1": 1,
  "preset-editor-v1": 1,
  "loom-block-editor-v1": 1,
  "generation-assembly-v1": 1,
  "interceptor-context-v1": 1,
  "interceptor-final-response-v1": 1,
  "connection-dispatch-resolution-v1": 1,
} as const)

export type ParsedCanonicalSemver = Readonly<{
  source: string
  major: string
  minor: string
  patch: string
  prerelease: readonly string[]
  build: readonly string[]
}>

const CANONICAL_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const CAPABILITY_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

export class SpindleCompatibilityError extends Error {
  readonly code: typeof SPINDLE_COMPATIBILITY_ERROR_CODE = SPINDLE_COMPATIBILITY_ERROR_CODE

  constructor(message: string) {
    super(message)
    this.name = "SpindleCompatibilityError"
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

function fail(message: string): never {
  throw new SpindleCompatibilityError(message)
}

export function parseCanonicalSemver(value: unknown, label: string): ParsedCanonicalSemver {
  if (typeof value !== "string") {
    return fail(`${label} must be a canonical semantic version`)
  }

  const match = CANONICAL_SEMVER.exec(value)
  if (!match) {
    return fail(`${label} must be a canonical semantic version`)
  }

  return Object.freeze({
    source: value,
    major: match[1],
    minor: match[2],
    patch: match[3],
    prerelease: Object.freeze(match[4] ? match[4].split(".") : []),
    build: Object.freeze(match[5] ? match[5].split(".") : []),
  })
}

function compareNumericIdentifier(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1
  return left === right ? 0 : left < right ? -1 : 1
}

function comparePrerelease(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) {
    return left.length === right.length ? 0 : left.length === 0 ? 1 : -1
  }

  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const a = left[index]
    const b = right[index]
    if (a === undefined || b === undefined) {
      return a === b ? 0 : a === undefined ? -1 : 1
    }
    if (a === b) continue

    const aNumeric = /^\d+$/.test(a)
    const bNumeric = /^\d+$/.test(b)
    if (aNumeric && bNumeric) {
      const order = compareNumericIdentifier(a, b)
      if (order !== 0) return order
      continue
    }
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1
    return a < b ? -1 : 1
  }

  return 0
}

export function compareCanonicalSemver(left: string, right: string): number {
  const a = parseCanonicalSemver(left, "Version")
  const b = parseCanonicalSemver(right, "Version")

  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return compareNumericIdentifier(a[key], b[key])
  }

  return comparePrerelease(a.prerelease, b.prerelease)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function assertCanonicalUuid(value: unknown): asserts value is string {
  if (typeof value !== "string" || !CANONICAL_UUID.test(value)) {
    return fail("Extension installation ID must be a canonical lowercase UUID")
  }
}

function assertSupportedLumiverseVersion(lumiverseVersion: string): void {
  if (compareCanonicalSemver(lumiverseVersion, MIN_LUMIVERSE_VERSION) < 0) {
    fail(
      `Lumiverse version ${lumiverseVersion} is too old; APC requires ${MIN_LUMIVERSE_VERSION} or newer`,
    )
  }
}

/** Validate and freeze a host descriptor before any extension work begins. */
export function validateSpindleHostDescriptor(value: unknown): SpindleHostDescriptorV1 {
  if (!isRecord(value)) {
    return fail("Spindle host descriptor must be an object")
  }
  if (value.descriptorVersion !== 1) {
    return fail("Unsupported Spindle host descriptor version; expected descriptorVersion 1")
  }

  const lumiverseVersion = parseCanonicalSemver(
    value.lumiverseVersion,
    "Lumiverse version",
  ).source
  assertSupportedLumiverseVersion(lumiverseVersion)
  assertCanonicalUuid(value.extensionInstallationId)

  if (!isRecord(value.capabilities)) {
    return fail("Spindle host capabilities must be an object")
  }

  const capabilities: Record<string, number> = {}
  for (const [name, version] of Object.entries(value.capabilities)) {
    if (!CAPABILITY_NAME.test(name)) {
      return fail(`Invalid Spindle host capability name: ${name || "<empty>"}`)
    }
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version <= 0) {
      return fail(`Invalid Spindle host capability version: ${name}`)
    }
    capabilities[name] = version
  }

  for (const [name, version] of Object.entries(REQUIRED_HOST_CAPABILITIES)) {
    if (capabilities[name] !== version) {
      return fail(
        `Missing or incompatible Spindle host capability: ${name} (expected version ${version})`,
      )
    }
  }

  return Object.freeze({
    descriptorVersion: 1,
    lumiverseVersion,
    capabilities: Object.freeze(capabilities),
    extensionInstallationId: value.extensionInstallationId,
  })
}
