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

function descriptor(overrides: DescriptorInput = {}): DescriptorInput {
  return {
    descriptorVersion: 1,
    lumiverseVersion: MIN_LUMIVERSE_VERSION,
    capabilities: { ...REQUIRED_HOST_CAPABILITIES },
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

describe("APC host compatibility scaffold", () => {
  test("accepts the exact descriptor and freezes the normalized result", () => {
    const result = validateSpindleHostDescriptor(descriptor())

    expect(result).toEqual({
      descriptorVersion: 1,
      lumiverseVersion: MIN_LUMIVERSE_VERSION,
      capabilities: REQUIRED_HOST_CAPABILITIES,
      extensionInstallationId: INSTALLATION_ID,
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.capabilities)).toBe(true)
  })

  test("accepts valid unknown capabilities without using them as requirements", () => {
    const result = validateSpindleHostDescriptor(
      descriptor({
        capabilities: {
          ...REQUIRED_HOST_CAPABILITIES,
          "future-host-feature-v2": 3,
        },
      }),
    )

    expect(result.capabilities["future-host-feature-v2"]).toBe(3)
  })

  test("rejects missing and wrong required capabilities", () => {
    const missing: Record<string, number> = { ...REQUIRED_HOST_CAPABILITIES }
    delete missing["preset-editor-v1"]
    expectCompatibilityError(
      descriptor({ capabilities: missing }),
      "preset-editor-v1",
    )
    expectCompatibilityError(
      descriptor({
        capabilities: {
          ...REQUIRED_HOST_CAPABILITIES,
          "preset-editor-v1": 2,
        },
      }),
      "preset-editor-v1",
    )
  })

  test("rejects malformed capability names and values", () => {
    for (const name of ["", "Bad-Key", "bad_key", "bad--key", "bad key"]) {
      expectCompatibilityError(
        descriptor({
          capabilities: { ...REQUIRED_HOST_CAPABILITIES, [name]: 1 },
        }),
        "Invalid Spindle host capability name",
      )
    }

    for (const value of [
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
            ...REQUIRED_HOST_CAPABILITIES,
            "future-host-feature-v2": value,
          },
        }),
        "Invalid Spindle host capability version",
      )
    }
  })

  test("rejects malformed descriptors and too-old Lumiverse hosts", () => {
    for (const input of [null, [], "descriptor", descriptor({ descriptorVersion: 2 })]) {
      expectCompatibilityError(input, "Spindle host descriptor")
    }
    expectCompatibilityError(
      descriptor({ lumiverseVersion: "1.0.7" }),
      "too old",
    )
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

  test("rejects noncanonical semantic versions and UUIDs", () => {
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
        ...REQUIRED_HOST_CAPABILITIES,
        "future-host-feature-v2": 3,
      },
    })
    const result = validateSpindleHostDescriptor(input)

    ;(input.capabilities as Record<string, unknown>)["preset-editor-v1"] = 99
    delete (input.capabilities as Record<string, unknown>)["future-host-feature-v2"]

    expect(result.capabilities["preset-editor-v1"]).toBe(1)
    expect(result.capabilities["future-host-feature-v2"]).toBe(3)
    expect(REQUIRED_HOST_CAPABILITIES["preset-editor-v1"]).toBe(1)
    expect(Object.isFrozen(REQUIRED_HOST_CAPABILITIES)).toBe(true)
  })
})
