/**
 * CLEAN-ROOM TEST ENVIRONMENT — strips every CTX_* var before any test module loads.
 *
 * WHY THIS EXISTS (a design trap, not an operator mistake):
 * cortextos agents run this suite from inside a LIVE agent shell, which exports a
 * whole CTX_* environment (CTX_AGENT_DIR, CTX_FRAMEWORK_ROOT, CTX_PROJECT_ROOT,
 * CTX_ORCHESTRATOR_AGENT, CTX_INSTANCE_ID, … — 19 of them today). Those point at the
 * live agent's directories. `src/utils/env.ts` correctly detects the mismatch and
 * refuses ("sandbox/live environment leak — Refusing to proceed"), which turns a
 * perfectly green repo into a large, plausible, self-consistent, and entirely WRONG
 * red suite.
 *
 * On 2026-07-13 two different agents independently walked into this and both
 * mis-diagnosed a GREEN main as rotten — one of them one hour after writing the rule
 * warning about it. A PARTIAL unset is the worst outcome of all: it yields a
 * believable wrong answer (unsetting 4 of the vars left 34 "failures"; stripping all
 * of them left 1).
 *
 * So the harness strips them ITSELF. Nobody should have to remember nineteen variable
 * names, and no one should be able to produce a fake red by forgetting one. This runs
 * as a vitest `setupFiles` entry, i.e. in EVERY worker, BEFORE any test module is
 * imported — so module-level env reads see the cleaned environment.
 *
 * A test that legitimately needs a CTX_* value must set it itself (hermetic), which
 * still works: this only removes INHERITED leakage from the parent shell.
 */
const stripped: string[] = [];

for (const key of Object.keys(process.env)) {
  if (key.startsWith('CTX_')) {
    delete process.env[key];
    stripped.push(key);
  }
}

if (stripped.length > 0) {
  // Loud on purpose: if you see this, your shell was leaking a live agent env into
  // the tests. The suite is now clean — but this is why you must never diagnose a
  // "red repo" from a dirty shell.
  console.warn(
    `[clean-room] stripped ${stripped.length} leaked CTX_* var(s) from the test env: ` +
      `${stripped.sort().join(', ')}`,
  );
}

export {};
