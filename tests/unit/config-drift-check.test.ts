import { describe, it, expect } from "vitest"
import { extractSitekeys, findSitekeyDrift } from "../../bin/config-drift-check.mjs"

// The 2026-07 incident: HRIS/ebook/asset-tag forms hardcoded a Turnstile sitekey that
// did NOT exist in the CF account (a 404 ghost), so the widget silently failed and form
// leads dropped for a week with nothing watching. This checker prevents recurrence:
// flag any sitekey in source that is not a real widget in the provider account.
const REAL = "0x4AAAAAADcqmhIiEFkI_rGB" // the live "allsafeit-form" widget
const GHOST = "0x4AAAAAAAQTptj2So4dx43e" // the 404 ghost from the incident

describe("config-drift: Turnstile sitekey extraction (pure)", () => {
  it("extracts a sitekey with its 1-based line", () => {
    const text = 'const a = 1\ndata-sitekey="0x4AAAAAADcqmhIiEFkI_rGB"\n'
    expect(extractSitekeys(text)).toEqual([{ sitekey: REAL, line: 2 }])
  })

  it("finds multiple sitekeys in document order", () => {
    const text = `${GHOST}\nfiller\n${REAL}`
    expect(extractSitekeys(text).map((s) => s.sitekey)).toEqual([GHOST, REAL])
  })

  it("ignores text that is not a Turnstile sitekey", () => {
    expect(extractSitekeys("no keys here, 0xabc, 0x4AAAAA is too short-ish? no")).toEqual([
      // "0x4AAAAA " has a trailing space so the token ends; but it needs 1+ trailing char.
    ])
  })
})

describe("config-drift: drift detection — a source sitekey absent from the account (pure)", () => {
  const account = [REAL]

  it("FLAGS the ghost sitekey (the incident) — not in the account", () => {
    const src = [{ sitekey: GHOST, file: "src/pages/hris.astro", line: 22 }]
    expect(findSitekeyDrift(src, account)).toEqual(src)
  })

  it("PASSES a sitekey that exists as a real widget in the account", () => {
    const src = [{ sitekey: REAL, file: "src/components/ContactForm.astro", line: 13 }]
    expect(findSitekeyDrift(src, account)).toEqual([])
  })

  it("flags only the drifted key in a mixed set, keeping EVERY file:line using it", () => {
    const src = [
      { sitekey: REAL, file: "a.astro", line: 1 },
      { sitekey: GHOST, file: "b.astro", line: 2 },
      { sitekey: GHOST, file: "c.astro", line: 3 },
    ]
    expect(findSitekeyDrift(src, account)).toEqual([
      { sitekey: GHOST, file: "b.astro", line: 2 },
      { sitekey: GHOST, file: "c.astro", line: 3 },
    ])
  })

  it("fails LOUD when the account list is empty — never a vacuous all-clear", () => {
    const src = [{ sitekey: REAL, file: "a", line: 1 }]
    expect(findSitekeyDrift(src, [])).toEqual(src)
  })
})
