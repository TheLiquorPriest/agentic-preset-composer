// @ts-ignore Bun provides the test module at runtime; the extension bundle excludes this file.
import { describe, expect, test } from "bun:test"
import {
  MIN_LUMIVERSE_VERSION,
  REQUIRED_HOST_CAPABILITIES,
  SPINDLE_COMPATIBILITY_ERROR_CODE,
  SpindleCompatibilityError,
  validateSpindleHostDescriptor,
} from "./compat"

type DescriptorInput = Record<string, unknown>

const INSTALLATION_ID = "550e8400-e29b-41d4-a716-446655440000"
const EXPECTED_HOST_CAPABILITIES = {
  "preset-extension-data-v1": 1,
  "preset-editor-v1": 1,
  "loom-block-editor-v1": 1,
  "generation-assembly-v1": 1,
  "interceptor-context-v1": 1,
  "interceptor-final-response-v1": 1,
  "connection-dispatch-resolution-v1": 1,
} as const

function descriptor(overrides: DescriptorInput = {}): DescriptorInput {
  return {
    descriptorVersion: 1,
    lumiverseVersion: MIN_LUMIVERSE_VERSION,
    capabilities: { ...EXPECTED_HOST_CAPABILITIES },
    extensionInstallationId: INSTALLATION_ID,
    ...overrides,
  }
}

function expectCompatibilityError(input: unknown, message: string): void {
  try {
    validateSpindleHostDescriptor(input)
    throw new Error("Expected host descriptor validation to fail")
  } catch (error) {
    expect(error).toBeInstanceOf(SpindleCompatibilityError)
    expect((error as SpindleCompatibilityError).code).toBe(SPINDLE_COMPATIBILITY_ERROR_CODE)
    expect((error as Error).message).toContain(message)
  }
}

describe("APC host compatibility descriptor", () => {
  test("accepts the exact descriptor shape and freezes the normalized result", () => {
    expect(REQUIRED_HOST_CAPABILITIES).toEqual(EXPECTED_HOST_CAPABILITIES)

    const result = validateSpindleHostDescriptor(descriptor())

    expect(result).toEqual({
      descriptorVersion: 1,
      lumiverseVersion: MIN_LUMIVERSE_VERSION,
      capabilities: EXPECTED_HOST_CAPABILITIES,
      extensionInstallationId: INSTALLATION_ID,
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.capabilities)).toBe(true)
  })

  test("requires every canonical capability, including connection dispatch resolution", () => {
    for (const [name, version] of Object.entries(EXPECTED_HOST_CAPABILITIES)) {
      const missing: Record<string, number> = { ...EXPECTED_HOST_CAPABILITIES }
      delete missing[name]
      expectCompatibilityError(descriptor({ capabilities: missing }), name)

      expectCompatibilityError(
        descriptor({
          capabilities: { ...EXPECTED_HOST_CAPABILITIES, [name]: version + 1 },
        }),
        name,
      )
    }
  })

  test("accepts valid unknown capabilities without making them requirements", () => {
    const result = validateSpindleHostDescriptor(
      descriptor({
        capabilities: {
          ...EXPECTED_HOST_CAPABILITIES,
          "future-host-feature-v2": 3,
        },
      }),
    )

    expect(result.capabilities["future-host-feature-v2"]).toBe(3)
  })

  test("rejects malformed capability names and versions", () => {
    for (const name of ["", "Bad-Key", "bad_key", "bad--key", "bad key"]) {
      expectCompatibilityError(
        descriptor({
          capabilities: { ...EXPECTED_HOST_CAPABILITIES, [name]: 1 },
        }),
        "Invalid Spindle host capability name",
      )
    }

    for (const version of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expectCompatibilityError(
        descriptor({
          capabilities: {
            ...EXPECTED_HOST_CAPABILITIES,
            "future-host-feature-v2": version,
          },
        }),
        "Invalid Spindle host capability version",
      )
    }
  })

  test("rejects malformed descriptors and hosts below the minimum version", () => {
    for (const input of [null, [], "descriptor", descriptor({ descriptorVersion: 2 })]) {
      expectCompatibilityError(input, "Spindle host descriptor")
    }
    expectCompatibilityError(descriptor({ capabilities: null }), "capabilities")
    expectCompatibilityError(descriptor({ extensionInstallationId: undefined }), "canonical lowercase UUID")
    expectCompatibilityError(descriptor({ lumiverseVersion: "1.0.7" }), "too old")
  })

  test("accepts the minimum and newer canonical Lumiverse versions", () => {
    for (const lumiverseVersion of [
      MIN_LUMIVERSE_VERSION,
      "1.0.9",
      "1.0.10",
      "1.1.0",
      "2.0.0",
    ]) {
      expect(
        validateSpindleHostDescriptor(descriptor({ lumiverseVersion })).lumiverseVersion,
      ).toBe(lumiverseVersion)
    }

    expectCompatibilityError(
      descriptor({ lumiverseVersion: "1.0.8-rc.1" }),
      "too old",
    )
  })

  test("rejects noncanonical semantic versions and installation UUIDs", () => {
    for (const value of ["v1.0.8", "1.0", "01.0.8", "1.0.8-alpha.01", "1.0.8+"]) {
      expectCompatibilityError(
        descriptor({ lumiverseVersion: value }),
        "canonical semantic version",
      )
    }
    for (const value of [
      "550E8400-E29B-41D4-A716-446655440000",
      "550e8400e29b41d4a716446655440000",
      "550e8400-e29b-61d4-a716-446655440000",
      "550e8400-e29b-41d4-c716-446655440000",
    ]) {
      expectCompatibilityError(
        descriptor({ extensionInstallationId: value }),
        "canonical lowercase UUID",
      )
    }
  })

  test("copies input capabilities so later mutation cannot alter frozen requirements", () => {
    const input = descriptor({
      capabilities: {
        ...EXPECTED_HOST_CAPABILITIES,
        "future-host-feature-v2": 3,
      },
    })
    const result = validateSpindleHostDescriptor(input)

    ;(input.capabilities as Record<string, unknown>)["preset-editor-v1"] = 99
    delete (input.capabilities as Record<string, unknown>)["future-host-feature-v2"]

    expect(result.capabilities["preset-editor-v1"]).toBe(1)
    expect(result.capabilities["future-host-feature-v2"]).toBe(3)
    expect(REQUIRED_HOST_CAPABILITIES["connection-dispatch-resolution-v1"]).toBe(1)
    expect(Object.isFrozen(REQUIRED_HOST_CAPABILITIES)).toBe(true)
  })
})
