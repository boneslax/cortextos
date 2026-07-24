#!/usr/bin/env node
// config-drift-check.mjs — verify external IDs hardcoded in source actually exist in the
// provider account. Born from the 2026-07 incident: the allsafeit.com HRIS/ebook/asset-tag
// forms hardcoded a Turnstile sitekey (0x4AAAAAAAQTptj2So4dx43e) that did NOT exist in the
// Cloudflare account (a 404 ghost), so the widget silently failed and form leads dropped for
// a WEEK with nothing watching. This flags any sitekey in source that is not a real widget in
// the account.
//
// v1: Turnstile sitekeys (allsafeit-astro-website) vs the CF Turnstile widgets API.
// READ-ONLY (a GET against the CF API + a filesystem scan) — never writes, deploys, or sends.
// Exit 1 on drift (cron/CI-friendly), 0 when clean. Not wired to any alert/cron yet (branch-only).
//
// Config (env, all optional — sensible defaults for the astro/Turnstile case):
//   DRIFT_ASTRO_REPO   source repo to scan   (default /home/bones/allsafeit-astro-website)
//   DRIFT_CF_ACCOUNT   CF account id         (default 0fa898c2c746288646885a30e7afe085)
//   CF_API_TOKEN       Cloudflare API token with Turnstile read (REQUIRED for the live check;
//                      retrieve from 1Password "Cloudflare Org" -> credential field).
//
// Generalization path (later, not v1): a `providers` table of {name, extractIdsFromSource,
// fetchAccountIds} so GBP location ids / other hardcoded external ids get the same check.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, extname } from "node:path"

// A Turnstile sitekey: `0x` + a fixed base62/_- body. The observed form is `0x4AAAAA…`.
const SITEKEY_RE = /0x4AAAAA[A-Za-z0-9_-]+/g

// ---- pure core (unit-tested) ----------------------------------------------

/** Extract every Turnstile sitekey from a file's text, with its 1-based line number. */
export function extractSitekeys(text) {
  const out = []
  text.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(SITEKEY_RE)) out.push({ sitekey: m[0], line: i + 1 })
  })
  return out
}

/**
 * Drift = every source sitekey that is NOT present in the provider account.
 * @param sourceKeys  [{sitekey, file, line}]
 * @param accountSitekeys  string[] of real sitekeys in the account
 * @returns the drifted subset (every file:line preserved) — the thing to alert on.
 */
export function findSitekeyDrift(sourceKeys, accountSitekeys) {
  const account = new Set(accountSitekeys)
  return sourceKeys.filter((k) => !account.has(k.sitekey))
}

// ---- I/O -------------------------------------------------------------------

const SCAN_EXT = new Set([
  ".astro", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".toml", ".yaml", ".yml", ".html", ".env",
])
const SKIP_DIR = new Set(["node_modules", ".git", "dist", ".astro", "build", ".vercel", ".netlify"])

/** Walk a repo and return every {sitekey, file, line} found in scannable source/config files. */
export function scanRepoForSitekeys(dir) {
  const found = []
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIR.has(entry.name)) walk(p)
      } else if (SCAN_EXT.has(extname(entry.name)) || entry.name.startsWith(".env")) {
        let text
        try {
          if (statSync(p).size > 2_000_000) continue // skip huge files
          text = readFileSync(p, "utf-8")
        } catch {
          continue
        }
        for (const k of extractSitekeys(text)) found.push({ sitekey: k.sitekey, file: p, line: k.line })
      }
    }
  }
  walk(dir)
  return found
}

/** List the account's REAL Turnstile widget sitekeys (read-only CF API GET). */
export async function fetchAccountSitekeys(accountId, token) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/challenges/widgets`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  const body = await res.json()
  if (!body.success) {
    throw new Error(`CF Turnstile widgets API failed (HTTP ${res.status}): ${JSON.stringify(body.errors)}`)
  }
  return (body.result || []).map((w) => w.sitekey)
}

async function main() {
  const repo = process.env.DRIFT_ASTRO_REPO || "/home/bones/allsafeit-astro-website"
  const accountId = process.env.DRIFT_CF_ACCOUNT || "0fa898c2c746288646885a30e7afe085"
  const token = process.env.CF_API_TOKEN
  if (!token) {
    console.error("CF_API_TOKEN is required (1Password 'Cloudflare Org' -> credential). Aborting — a missing token must FAIL, never silently pass.")
    process.exit(2)
  }

  const source = scanRepoForSitekeys(repo)
  const account = await fetchAccountSitekeys(accountId, token)
  if (account.length === 0) {
    console.error("CF account returned ZERO Turnstile widgets — refusing to evaluate (would flag every source key as a false positive, or mask a real one). Check the token/account.")
    process.exit(2)
  }
  const drift = findSitekeyDrift(source, account)

  const uniqSource = [...new Set(source.map((s) => s.sitekey))]
  console.log(`config-drift-check (Turnstile) — repo ${repo}`)
  console.log(`  source sitekeys: ${uniqSource.length} unique across ${source.length} occurrence(s)`)
  console.log(`  account widgets: ${account.length} (${account.join(", ")})`)

  if (drift.length === 0) {
    console.log("  RESULT: OK — every source sitekey is a real widget in the account.")
    process.exit(0)
  }
  console.error(`  RESULT: DRIFT — ${drift.length} source sitekey occurrence(s) are NOT real widgets in the account:`)
  for (const d of drift) console.error(`    GHOST ${d.sitekey}  ${d.file}:${d.line}`)
  console.error("  These widgets 404 at Cloudflare — the form silently fails and leads are lost. Fix the sitekey or create the widget.")
  process.exit(1)
}

// Only run when invoked directly (not when imported by tests).
if (process.argv[1] && process.argv[1].endsWith("config-drift-check.mjs")) {
  main().catch((e) => {
    console.error(`config-drift-check ERROR: ${e.message}`)
    process.exit(2)
  })
}
