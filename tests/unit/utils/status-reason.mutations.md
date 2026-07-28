# Mutation log — `status-reason.test.ts`

A test that has never been observed failing is not evidence that it can fail. Hub shipped a
feature with **zero** holiday banners for its entire life because its only check was
`expect(count()).toBeGreaterThanOrEqual(0)` — non-negative by definition, green forever.

So every assertion here was run against a deliberately broken implementation and observed
red before being allowed to go green. Each entry records the mutation, the command, and the
verbatim failure.

Restore between runs with `cp /tmp/sr-orig.ts src/utils/status-reason.ts`.
Command for all three: `npx vitest run tests/unit/utils/status-reason.test.ts`

---

## M1 — revert to the v6 design (compare `status`, not `rev`)

```diff
-  const isCurrent =
-    typeof sr.rev === 'number' &&
-    typeof task.rev === 'number' &&
-    sr.rev === task.rev;
+  const isCurrent = sr.status === task.status;
```

**Result: 5 failed | 5 passed.** KILLED.

```
× does NOT resurrect a reason when the same status is entered again
× treats a stamp with no rev as historical, never current
× treats a task with no rev as historical, never current
× renders every status label from the stamp, not from the task
× agrees with the rendered form in every case
```

This is the mutation that matters. It is not a synthetic defect — it is the design that was
written into plan v6 and survived four gate rounds before two independent reviewers found it
in the same pass. The first failure above is the exact sequence:
`blocked(reason) → in_progress → blocked`, where the statuses agree again and a
status-comparison renders a closed-episode reason as the current explanation.

## M2 — drop the `typeof` guards (treat absence as evidence)

```diff
-  const isCurrent =
-    typeof sr.rev === 'number' &&
-    typeof task.rev === 'number' &&
-    sr.rev === task.rev;
+  const isCurrent = sr.rev === task.rev;
```

**First run: 10 passed. SURVIVED.**

The suite did not constrain the behaviour. Both existing absence tests pin *one* side absent
and the other present (`undefined === 7` → false, `7 === undefined` → false), so both pass
under the mutation. Only the **both-absent** case distinguishes them, because
`undefined === undefined` is `true` — and that is the state **every task file in the store is
in today**, since none carries a `rev`. On the day this ships, every pre-existing stamp takes
exactly that path and would have rendered as *current*.

Added `treats BOTH revs absent as historical — undefined must not equal undefined`.

**Second run: 1 failed | 10 passed.** KILLED.

```
× treats BOTH revs absent as historical — undefined must not equal undefined
```

The surviving mutant found a real gap that writing more tests by intuition had not. Worth
recording as the argument for mutation over "I wrote a test for that."

## M3 — strip our own prefix out of operator text

```diff
-  const text = sr.reason.trim() === '' ? '(no reason given)' : sr.reason;
+  const stripped = sr.reason.replace(/^\[(was )?[a-z_]+\]\s*/i, '');
+  const text = stripped.trim() === '' ? '(no reason given)' : stripped;
```

**Result: 1 failed | 9 passed.** KILLED.

```
× never rewrites operator text that looks like our own prefix
```

The tidier-looking behaviour is the wrong one: silently editing what an operator typed is the
same class of defect this whole record exists to fix.

---

## Not yet mutation-covered

Named rather than left implicit, because an unstated gap reads as coverage:

- **`at` is never asserted for currency**, only carried. If a future change starts comparing
  timestamps, no test here would catch the second-granularity trap (`updated_at` has its
  milliseconds stripped, so two transitions inside one second compare equal).
- **No test pins the module's dependency-free property.** Adding `import { readFileSync }` to
  `status-reason.ts` would break the dashboard consumer and every test here would still pass.
  That wants a contract test, not a unit test.
