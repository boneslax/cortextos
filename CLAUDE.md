# Contributing to cortextOS

## Development Setup

```bash
git clone https://github.com/grandamenium/cortextos.git
cd cortextos
npm install
npm run build
npm test
```

## Before Submitting Changes

1. `npm run build` — TypeScript must compile cleanly
2. `npm test` — all tests must pass
3. Match existing patterns in `src/` for new features
4. Add unit tests in `tests/` for any new code

## Running the tests — read this BEFORE you believe a red suite

`npm test` is a **clean room**: it strips every `CTX_*` variable from the environment
before any test loads (`tests/setup/clean-room.ts`, wired in `vitest.config.ts`). You do
not need to unset anything by hand.

**Why that exists.** Agents run this suite from inside a live agent shell, which exports
~19 `CTX_*` vars pointing at the live agent's directories. `src/utils/env.ts` correctly
refuses on the mismatch ("sandbox/live environment leak"), turning a green repo into a
big, believable, **wrong** red suite. On 2026-07-13 two agents independently hit this and
both mis-diagnosed a green `main` as rotten. A *partial* unset is the worst case: it
produces a self-consistent wrong answer (4 vars unset → 34 "failures"; all → 1).

**If you run the suite from a git worktree**, two more traps — both produce a phantom red:

1. **Symlink BOTH dependency trees.** `dashboard/` is a Next.js sub-project with its own
   `node_modules`; the root tree alone is not enough:
   ```bash
   ln -s <repo>/node_modules           <worktree>/node_modules
   ln -s <repo>/dashboard/node_modules <worktree>/dashboard/node_modules
   ```
   Miss the dashboard one and 10 files fail to **load** (`Cannot find package
   'next/server'` / `'better-sqlite3'`). They report as *failing files with zero failing
   assertions* — the tell that they never ran at all.
2. **`npm run build` FIRST.** Suites guarded by `describe.skipIf(!existsSync(DIST_CLI))`
   silently **skip** on an unbuilt tree. Comparing a built branch against an unbuilt one
   manufactures a regression that does not exist.

**Count passed / failed / SKIPPED separately.** A skip is not a pass, and a file that
never loaded is not a file that passed. A suite that mostly skips looks green.

## Project Structure

- `src/` — TypeScript source (bus, cli, daemon, hooks, types, utils)
- `bus/` — Shell wrapper scripts (delegate to `dist/cli.js bus`)
- `dashboard/` — Next.js 14 web dashboard
- `templates/` — Agent templates (agent, orchestrator, analyst)
- `community/` — Community skills and agent catalog
- `tests/` — Unit, integration, and E2E tests

## Code Style

- TypeScript strict mode
- No external runtime dependencies beyond what's in `package.json`
- File operations use atomic writes (see `src/utils/atomic.ts`)
- All bus operations go through `src/bus/` modules
