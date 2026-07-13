import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      // Matches the dashboard's tsconfig path alias so tests under
      // dashboard/src/**/__tests__ can import dashboard source via "@/…".
      '@': path.resolve(__dirname, 'dashboard/src'),
      // Dashboard tests need to resolve `next/server` and other Next deps
      // from dashboard/node_modules, because root's package.json does not
      // depend on Next.js.
      'next/server': path.resolve(__dirname, 'dashboard/node_modules/next/server.js'),
    },
  },
  test: {
    globals: true,
    testTimeout: 10000,
    // CLEAN ROOM, ON BY DEFAULT. Strips every CTX_* var before any test module
    // loads. This is deliberately NOT an opt-in `test:clean` script: an opt-in
    // clean room still lets someone run plain `npm test` from a live agent shell
    // and get a large, believable, WRONG red suite (it happened twice on
    // 2026-07-13). Making it the default means the trap cannot fire.
    // See tests/setup/clean-room.ts for the full why.
    setupFiles: ['./tests/setup/clean-room.ts'],
    include: [
      'tests/**/*.test.ts',
      'dashboard/src/**/__tests__/**/*.test.ts',
    ],
  },
});

/**
 * RUNNING THE SUITE FROM A GIT WORKTREE — read this before you believe a red suite.
 *
 *   1. Symlink BOTH dependency trees. `dashboard/` is a Next.js sub-project with its
 *      OWN node_modules; the root tree alone is not enough:
 *        ln -s <repo>/node_modules            <worktree>/node_modules
 *        ln -s <repo>/dashboard/node_modules  <worktree>/dashboard/node_modules
 *      Miss the dashboard one and 10 files fail to LOAD ("Cannot find package
 *      'next/server'" / "'better-sqlite3'"). They report as FAILING FILES with ZERO
 *      failing assertions — the tell that they never ran at all.
 *   2. `npm run build` FIRST. Suites guarded by describe.skipIf(!existsSync(DIST_CLI))
 *      silently SKIP on an unbuilt tree — a skip is NOT a pass, and comparing a built
 *      branch against an unbuilt one manufactures a phantom regression.
 *   3. Then `npm test`. The clean room above handles the CTX_* leak for you.
 *
 * Count passed / failed / SKIPPED separately. A suite that mostly skips, or whose
 * files fail to load, looks green.
 */
