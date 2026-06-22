/**
 * Pending-callback index for forum-topic routing.
 *
 * Under a single shared group bot, only the orchestrator polls, so it receives
 * EVERY inline-button callback_query. A button pressed in agent X's topic must
 * unblock agent X — but Telegram's CallbackQuery.message (and its
 * message_thread_id) are both OPTIONAL. When the thread id IS present the
 * orchestrator routes by topic; when it is absent this index is the fallback:
 * the agent that POSTED an interactive prompt records `<callbackId> -> agent`
 * here, and the orchestrator resolves the owner by the unique id parsed from
 * callback_data. Fail-safe: an unresolved callback is never dispatched to a
 * guessed agent.
 *
 * Only callbacks with a UNIQUE id namespace are recorded (permission/restart
 * hex ids). AskUserQuestion callbacks (askopt_/asktoggle_/asksubmit_) are not
 * globally unique, so they rely on topic-thread routing instead.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const TTL_MS = 60 * 60 * 1000; // 1h — interactive prompts resolve well within this

function dir(ctxRoot: string): string {
  return join(ctxRoot, 'state', 'pending-callbacks');
}

/** Record that `agentName` owns the pending callback identified by `id`. */
export function recordPendingCallback(ctxRoot: string, id: string, agentName: string): void {
  try {
    const d = dir(ctxRoot);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, sanitize(id)), agentName, 'utf-8');
  } catch { /* best-effort: thread routing is the primary path */ }
}

/** Resolve the owning agent for a pending callback id, or null if unknown. */
export function resolvePendingCallback(ctxRoot: string, id: string): string | null {
  try {
    const f = join(dir(ctxRoot), sanitize(id));
    if (!existsSync(f)) return null;
    return readFileSync(f, 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

/** Remove a resolved entry. Also opportunistically reaps entries past the TTL. */
export function clearPendingCallback(ctxRoot: string, id: string): void {
  const d = dir(ctxRoot);
  try { unlinkSync(join(d, sanitize(id))); } catch { /* already gone */ }
  // Opportunistic TTL sweep so a never-answered prompt does not leak files.
  try {
    const now = Date.now();
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      try { if (now - statSync(p).mtimeMs > TTL_MS) unlinkSync(p); } catch { /* skip */ }
    }
  } catch { /* dir may not exist */ }
}

// callback ids are hex / alnum+underscore; strip anything else so the id can
// never escape the pending-callbacks dir.
function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128);
}
