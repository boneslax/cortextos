import { describe, it, expect } from "vitest"
import { baselineStats, evaluateCanary } from "../../bin/lead-capture-canary.mjs"

const H = 3_600_000
// The 2026-07 incident: allsafeit.com form leads dropped to ZERO for 8 days and nothing
// watched for the ABSENCE. This canary alerts when leads fall below the normal cadence.

describe("lead-canary: evaluateCanary — alert on absence of leads in a rolling window", () => {
  const now = 100 * H

  it("ALERTS when zero leads landed in the window (the 8-day-silent-breakage case)", () => {
    const r = evaluateCanary([50 * H], now, { windowMs: 24 * H, minLeads: 1 })
    expect(r.alert).toBe(true)
    expect(r.count).toBe(0)
  })

  it("does NOT alert when a lead landed within the window", () => {
    const r = evaluateCanary([50 * H, 90 * H], now, { windowMs: 24 * H, minLeads: 1 })
    expect(r.alert).toBe(false)
    expect(r.count).toBe(1)
  })

  it("supports a below-floor threshold (minLeads > 1), not just zero", () => {
    const r = evaluateCanary([85 * H, 95 * H], now, { windowMs: 24 * H, minLeads: 3 })
    expect(r.alert).toBe(true)
    expect(r.count).toBe(2)
  })

  it("counts only leads strictly within (now - window, now]", () => {
    // 76h is exactly the cutoff (100-24) -> excluded; 100h == now -> included
    const r = evaluateCanary([76 * H, 100 * H], now, { windowMs: 24 * H, minLeads: 1 })
    expect(r.count).toBe(1)
  })

  it("refuses to evaluate without a window (never a blind/zero-window pass)", () => {
    expect(() => evaluateCanary([50 * H], now, { windowMs: 0, minLeads: 1 })).toThrow()
    expect(() => evaluateCanary([50 * H], now, { windowMs: null, minLeads: 1 })).toThrow()
  })
})

describe("lead-canary: baselineStats — derive normal cadence + a safe window from history", () => {
  it("computes gaps, the max normal gap, and a window ABOVE it (safety x2)", () => {
    const ts = [0, 6 * H, 24 * H, 72 * H] // consecutive gaps 6h, 18h, 48h
    const s = baselineStats(ts)
    expect(s.count).toBe(4)
    expect(s.maxGapMs).toBe(48 * H)
    expect(s.recommendedWindowMs).toBe(96 * H) // maxGap * 2 -> a normal quiet stretch won't trip
  })

  it("returns a null window with <2 leads (insufficient baseline -> flag, never guess)", () => {
    expect(baselineStats([42 * H]).recommendedWindowMs).toBeNull()
    expect(baselineStats([]).recommendedWindowMs).toBeNull()
    expect(baselineStats([]).count).toBe(0)
  })
})
