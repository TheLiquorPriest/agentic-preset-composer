// @ts-ignore Bun provides the test module at runtime; the extension bundle excludes this file.
import { describe, expect, test } from "bun:test"

import {
  APC_CATALOG_KEYS,
  APC_CATALOGS,
  APC_LOCALES,
  createApcTranslator,
  formatCatalogText,
  getCatalog,
  interpolate,
  normalizeLocale,
  type ApcCatalog,
} from "./catalogs"

const PLACEHOLDER_PATTERN = /\{\{([A-Za-z][A-Za-z0-9_.-]*)\}\}/g

function keysOf(catalog: ApcCatalog): string[] {
  return Object.keys(catalog).sort()
}

function placeholdersOf(value: string): string[] {
  return [...value.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1]).sort()
}

describe("APC locale catalogs", () => {
  test("provide the same complete key set in every locale", () => {
    const expected = [...APC_CATALOG_KEYS].sort()
    expect(new Set(APC_CATALOG_KEYS).size).toBe(APC_CATALOG_KEYS.length)
    expect(Object.keys(APC_CATALOGS).sort()).toEqual([...APC_LOCALES].sort())

    for (const [locale, catalog] of Object.entries(APC_CATALOGS)) {
      expect(APC_LOCALES).toContain(locale as (typeof APC_LOCALES)[number])
      expect(keysOf(catalog)).toEqual(expected)
    }
  })

  test("contain nonblank translations for every key", () => {
    for (const [locale, catalog] of Object.entries(APC_CATALOGS)) {
      expect(APC_LOCALES).toContain(locale as (typeof APC_LOCALES)[number])
      for (const key of APC_CATALOG_KEYS) {
        expect(typeof catalog[key]).toBe("string")
        expect(catalog[key].trim().length).toBeGreaterThan(0)
      }
    }
  })

  test("keep placeholder names identical across translations", () => {
    const english = getCatalog("en")

    for (const locale of APC_LOCALES) {
      const catalog = getCatalog(locale)
      for (const key of APC_CATALOG_KEYS) {
        expect(placeholdersOf(catalog[key])).toEqual(placeholdersOf(english[key]))
      }
    }
  })

  test("keep consent status, acknowledgement, and disclosure copy distinct", () => {
    for (const locale of APC_LOCALES) {
      const catalog = getCatalog(locale)
      expect(catalog["consent.required"]).not.toBe(catalog["consent.acknowledgeDisclosure"])
      expect(catalog["consent.required"]).not.toBe(catalog["consent.disclosureSummary"])
      expect(placeholdersOf(catalog["consent.required"])).toEqual([])
      expect(placeholdersOf(catalog["consent.acknowledgeDisclosure"])).toEqual([])
      expect(placeholdersOf(catalog["consent.disclosureSummary"])).toEqual(["destination", "workspace"])
    }
  })

  test("escape hostile interpolation values as text", () => {
    const hostile = `<img src="x" onerror='alert(1)'>&`

    expect(interpolate("Value: {{value}}", { value: hostile })).toBe(
      "Value: &lt;img src=&quot;x&quot; onerror=&#39;alert(1)&#39;&gt;&amp;",
    )
    expect(interpolate("Missing {{value}}", {})).toBe("Missing {{value}}")
    expect(interpolate("{{value}}", { value: { toString: () => "<unsafe>" } })).toBe(
      "&lt;unsafe&gt;",
    )
    const throwingValues: Record<string, unknown> = {}
    Object.defineProperty(throwingValues, "value", {
      enumerable: true,
      get() {
        throw new Error("unreadable")
      },
    })
    expect(interpolate("{{value}}", throwingValues)).toBe("{{value}}")
  })

  test("normalize all host locale codes and useful locale variants", () => {
    expect(APC_LOCALES).toEqual(["en", "zh", "zh-TW", "ja", "fr", "it"])
    expect(APC_LOCALES.every((locale) => getCatalog(locale) === APC_CATALOGS[locale])).toBe(true)
    expect(normalizeLocale("en-US")).toBe("en")
    expect(normalizeLocale("ZH_tw")).toBe("zh-TW")
    expect(normalizeLocale("zh-Hant")).toBe("zh-TW")
    expect(normalizeLocale("zh-TW-u-nu-hanidec")).toBe("zh-TW")
    expect(normalizeLocale("fr-CA")).toBe("fr")
    expect(normalizeLocale("ja-JP")).toBe("ja")
    expect(normalizeLocale("it-IT")).toBe("it")
  })

  test("fall back to English for unknown or invalid locales", () => {
    const english = getCatalog("en")

    expect(normalizeLocale("de-DE")).toBe("en")
    expect(normalizeLocale(undefined)).toBe("en")
    expect(normalizeLocale({})).toBe("en")
    expect(getCatalog("de-DE")).toBe(english)
    expect(getCatalog(null)).toBe(english)
  })
  test("formats text without HTML escaping and preserves missing placeholders", () => {
    const hostile = `<img src="x">&`

    expect(formatCatalogText("en", "graph.modeTitle", { mode: hostile })).toBe(
      "Execution mode: <img src=\"x\">&",
    )
    expect(formatCatalogText("en", "graph.runTitle", { thread: "Thread" })).toBe(
      "Thread · Run {{index}}",
    )
    expect(formatCatalogText("en", "graph.runTitle")).toBe("{{thread}} · Run {{index}}")
  })

  test("reads the locale getter for every translation call", () => {
    let locale: string = "en"
    const translate = createApcTranslator(() => locale)

    expect(translate("graph.modeTitle", { mode: "Single" })).toBe("Execution mode: Single")
    locale = "ja"
    expect(translate("graph.modeTitle", { mode: "単一" })).toBe("実行モード：単一")
  })

  test("keeps text translation resilient to hostile values and locale getters", () => {
    const throwingValues = new Proxy(
      {},
      {
        get() {
          throw new Error("unreadable")
        },
        has() {
          throw new Error("unreadable")
        },
      },
    ) as Readonly<Record<string, unknown>>

    expect(formatCatalogText("en", "graph.modeTitle", throwingValues)).toBe(
      "Execution mode: {{mode}}",
    )

    let getterCalls = 0
    const translate = createApcTranslator(() => {
      getterCalls += 1
      throw new Error("locale unavailable")
    })
    expect(translate("graph.threads")).toBe("Threads")
    expect(getterCalls).toBe(1)
  })
})
