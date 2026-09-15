#!/usr/bin/env node
// lead-capture-canary.mjs — alert when form-lead notifications fall to ZERO (or below the
// normal cadence) in a rolling window. Born from the 2026-07 incident: the allsafeit.com
// contact/HRIS/ebook/asset-tag forms broke and leads dropped to zero for 8 DAYS with nothing
// watching for the ABSENCE. This watches the absence.
//
// This file is the signal-AGNOSTIC MECHANISM (pure, tested). The SIGNAL SOURCE (which lead
// store to count) is a separate adapter and is an OPEN QUESTION — see the morning writeup.
// Candidate signals (all confirmed to carry the leads; picking one is a Bones/solo call):
//   - Resend notification emails FROM "AllSafe IT <form@allsafeit.com>" TO bijeoma@allsafeit.com
//     (subjects: "New contact form:", "HRIS whitepaper lead:", "Ebook lead:", "Asset tag report:").
//     NOTE: these are NOT in bijeoma@ Inbox by subject/sender and the mailbox rejects filtered
//     Graph queries ("restriction too complex") — so counting via Graph needs the real leads
//     folder + a working query, or app-level Mail.Read.
//   - The CRM webhook (WEBHOOK_CRM_URL) / SearchLeads API — a purpose-built lead store, likely
//     the CLEANEST source to count by date.
// The BASELINE (normal cadence -> the safe window) is derived from history via baselineStats
// once the signal source is confirmed. NO threshold is hardcoded blind.
//
// Branch-only. NOT wired to any signal fetch, cron, or alert-send yet.

const SAFETY = 2 // window = maxNormalGap * SAFETY, so a normal quiet stretch never false-alarms

// ---- pure core (unit-tested) ----------------------------------------------

/**
 * Decide whether to alert: fewer than `minLeads` lead-events landed in the rolling window
 * (now - windowMs, now]. `windowMs` MUST be a positive number — a zero/absent window is a
 * config error, not a silent pass (a canary that can't define its window is useless).
 * @param leadTimestamps  number[] epoch-ms of lead events (any order)
 * @param nowMs           number epoch-ms "now"
 * @param cfg             { windowMs:number, minLeads?:number }
 */
export function evaluateCanary(leadTimestamps, nowMs, cfg) {
  const windowMs = cfg?.windowMs
  if (typeof windowMs !== "number" || !(windowMs > 0)) {
    throw new Error("evaluateCanary: windowMs must be a positive number (baseline-derived or Bones-set) — never blank.")
  }
  const minLeads = cfg?.minLeads ?? 1
  const cutoff = nowMs - windowMs
  const inWindow = leadTimestamps.filter((t) => t > cutoff && t <= nowMs)
  const alert = inWindow.length < minLeads
  const mostRecent = leadTimestamps.length ? Math.max(...leadTimestamps) : null
  return {
    alert,
    count: inWindow.length,
    minLeads,
    windowMs,
    cutoff,
    mostRecent,
    reason: alert
      ? `only ${inWindow.length} lead(s) in the last ${(windowMs / 3_600_000).toFixed(1)}h (expected >= ${minLeads})`
      : "ok",
  }
}

/**
 * Derive the normal lead cadence from history, and a SAFE alert window (above the largest
 * normal gap). Returns recommendedWindowMs = null when there is not enough history to derive
 * a gap (<2 leads) — the caller must then flag it for Bones, never guess a threshold.
 * @param leadTimestamps number[] epoch-ms (any order)
 */
export function baselineStats(leadTimestamps) {
  const ts = [...leadTimestamps].sort((a, b) => a - b)
  const n = ts.length
  const gaps = []
  for (let i = 1; i < n; i++) gaps.push(ts[i] - ts[i - 1])
  const maxGapMs = gaps.length ? Math.max(...gaps) : 0
  const spanMs = n >= 2 ? ts[n - 1] - ts[0] : 0
  const perDay = spanMs > 0 ? n / (spanMs / 86_400_000) : null
  const pct = (p) => {
    if (!gaps.length) return null
    const s = [...gaps].sort((a, b) => a - b)
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
  }
  return {
    count: n,
    spanMs,
    perDay,
    maxGapMs,
    p50GapMs: pct(50),
    p95GapMs: pct(95),
    // A window that a normal quiet stretch will not trip. Null until we can measure a gap.
    recommendedWindowMs: gaps.length ? maxGapMs * SAFETY : null,
  }
}

// ---- runner (NOT wired to a live signal or alert tonight — branch-only) ----
async function main() {
  console.error(
    "lead-capture-canary: mechanism only. No signal source is wired yet — see the morning writeup.\n" +
      "  Confirm the signal (CRM/SearchLeads lead log, the leads mail folder + a working Graph query,\n" +
      "  or a Resend account with list access), then: baselineStats(history) -> recommendedWindowMs,\n" +
      "  Bones confirms the window/minLeads, and the fetch + evaluateCanary + bus/Telegram alert wire up.",
  )
  process.exit(2)
}

if (process.argv[1] && process.argv[1].endsWith("lead-capture-canary.mjs")) {
  main().catch((e) => {
    console.error(`lead-capture-canary ERROR: ${e.message}`)
    process.exit(2)
  })
}
