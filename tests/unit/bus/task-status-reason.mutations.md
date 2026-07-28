# Mutation log — `task-status-reason.test.ts`

Persistence half. Every assertion reads the JSON back off disk; a function that
returns cleanly and writes nothing is the exact shape this record exists to catch.

Restore between runs: `cp /tmp/task-orig.ts src/bus/task.ts`
Command: `npx vitest run tests/unit/bus/task-status-reason.test.ts`

---

## M1 — never bump `rev`

```diff
-    task.rev = (task.rev ?? 0) + 1;
```

**3 failed | 5 passed. KILLED.**

```
× bumps rev on EVERY transition, with or without a reason
× does not resurrect a reason when the same status is re-entered
× an existing task with no rev gains one on its first transition
```

The middle failure is the whole point: without the counter, the recycling case
has nothing to distinguish a second visit to `blocked` from the first.

## M2 — write `status_reason` unconditionally

```diff
-    if (reason !== undefined) {
-      task.status_reason = { status, reason, at: task.updated_at, rev: task.rev };
-    }
+    task.status_reason = { status, reason: reason ?? '', at: task.updated_at, rev: task.rev };
```

**2 failed | 6 passed. KILLED.**

```
× does not resurrect a reason when the same status is re-entered
× leaves a prior stamp intact on a reason-less transition
```

Clobbering on every transition destroys the prior record and replaces it with an
empty one, which is worse than either keeping or clearing it — it manufactures a
stamp nobody wrote.

## M3 — drop the completed stamp (fold the reason away)

```diff
-    if (reason !== undefined) {
+    if (false && reason !== undefined) {
```

**1 failed | 7 passed. KILLED.**

```
× carries both, because they are different claims
```

---

## End-to-end, through the built CLI

Not a unit test. `blocked(reason) → in_progress → blocked`, read off disk:

```
status: blocked          rev: 3
reason.status: blocked   reason.rev: 1
STATUSES AGREE: True   <- a status-comparison guard calls this CURRENT (the v6 bug)
REVS AGREE: False      <- the counter calls it HISTORY (correct)
```

Over-length rejection, also through the CLI:

```
$ update-task <id> blocked --reason "<2100 chars>"
--reason is 2100 chars, over the 2000 limit. Rejected rather than truncated:
a cut explanation reads as a whole one.
EXIT=1
```

## Sandbox note — the isolation worked for a different reason than I assumed

I set `CTX_ROOT` to a tmpdir believing that isolated the writes. It did not:
the tasks landed under `~/.cortextos/<CTX_INSTANCE_ID>/orgs/<CTX_ORG>/`, so it
was `CTX_INSTANCE_ID=probe` doing the work. Setting only `CTX_ROOT` would have
written into the live `default` instance.

Checked rather than assumed: the one file that did appear in the live vault org
during this session (`task_1785234933319_10221343`) is seo's, created at
10:35:33Z by seo, not test residue. The `probe` instance was removed afterwards.

## Not covered

- **No concurrency test.** `updateTask` is still an unguarded read-modify-write;
  two concurrent writers lose each other's fields. Pre-existing, and the lock is
  a later stage — but nothing here would catch it.
- **The wrapper and route are untouched**, so the live three-path operator-note
  loss is unfixed by this commit. That is deliberate sequencing, not an oversight.
