import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { join, relative } from 'path';
import type { AgentConfig, AgentStatus, CtxEnv, BusPaths, WorkerStatus, TelegramMessage } from '../types/index.js';
import { AgentProcess } from './agent-process.js';
import { WorkerProcess } from './worker-process.js';
import { FastChecker } from './fast-checker.js';
import { CronScheduler } from './cron-scheduler.js';
import { migrateCronsForAgent } from './cron-migration.js';
import type { CronDefinition } from '../types/index.js';
import { TelegramAPI } from '../telegram/api.js';
import { TelegramPoller } from '../telegram/poller.js';
import { resolvePaths } from '../utils/paths.js';
import { resolveEnv } from '../utils/env.js';
import { recordInboundTelegram, cacheLastSent, logOutboundMessage, buildRecentHistory } from '../telegram/logging.js';
import { resolvePendingCallback } from '../telegram/pending-callback.js';
import { collectTelegramCommands, registerTelegramCommands } from '../bus/metrics.js';
import { stripControlChars } from '../utils/validate.js';
import { processMediaMessage } from '../telegram/media.js';
import { stripBom } from '../utils/strip-bom.js';

type LogFn = (msg: string) => void;

/**
 * Pure decision for routing an inline-button callback to a checker, given the
 * already-resolved owner. Extracted so the safety matrix is unit-testable.
 *
 *   - no owner + a thread WAS present + ask callback  -> 'drop' (fail closed:
 *     ask callbacks replay as PTY keystrokes; never run them on a guessed PTY)
 *   - no owner otherwise (General/no-thread, or perm/restart)  -> 'self'
 *   - owner is the orchestrator itself  -> 'self'
 *   - owner is another agent, running  -> { agent }
 *   - owner is another agent, NOT running  -> 'drop' (don't mis-route)
 */
export function decideCallbackRoute(params: {
  isAsk: boolean;
  threadPresent: boolean;
  owner: string | null;
  selfName: string;
  ownerRunning: boolean;
}): { action: 'self' } | { action: 'drop' } | { action: 'agent'; owner: string } {
  const { isAsk, threadPresent, owner, selfName, ownerRunning } = params;
  if (!owner) {
    if (threadPresent && isAsk) return { action: 'drop' };
    return { action: 'self' };
  }
  if (owner === selfName) return { action: 'self' };
  if (!ownerRunning) return { action: 'drop' };
  return { action: 'agent', owner };
}

/**
 * Manages all agents in a cortextOS instance.
 */
export class AgentManager {
  private agents: Map<string, { process: AgentProcess; checker: FastChecker; poller?: TelegramPoller; activityPoller?: TelegramPoller; telegramRejectCount?: number; telegramLastRejectAlertAt?: number; topicId?: number; chatId?: string }> = new Map();
  private workers: Map<string, WorkerProcess> = new Map();
  /**
   * Forum-topic routing registry: "${chatId}:${topicId}" -> agentName.
   * Built in a pre-pass over every enabled agent's .env BEFORE any poller
   * starts (avoids a start-order race where the orchestrator's poller would
   * resolve against a partial agent map). A duplicate (chatId, topicId)
   * fails closed: both entries are dropped and a warning is logged.
   */
  private topicRegistry: Map<string, string> = new Map();
  /** Daemon-level cron scheduler registry: one CronScheduler per enabled agent. */
  private cronSchedulers: Map<string, CronScheduler> = new Map();
  // Tracks agents that received a start request while still stopping.
  // stopAgent() honors these after cleanup completes so restart-all is race-free.
  private pendingRestarts: Set<string> = new Set();
  private instanceId: string;
  private ctxRoot: string;
  private frameworkRoot: string;
  private org: string;

  // Set true at construction time if any agent in state/ has a stale
  // .daemon-crashed marker, meaning the previous daemon process died
  // abruptly. Used by startAgent() to downgrade the BUG-011 regression
  // alarm to an info log in the post-crash overlap case (PR #11 only
  // closed the in-flight stop/start race; crash-restart can legitimately
  // see overlapping registry state). Cleared after discoverAndStart()
  // finishes so the next clean restart starts from a known-good baseline.
  private daemonJustCrashed: boolean = false;

  constructor(instanceId: string, ctxRoot: string, frameworkRoot: string, org: string) {
    this.instanceId = instanceId;
    this.ctxRoot = ctxRoot;
    this.frameworkRoot = frameworkRoot;
    this.org = org;
    this.daemonJustCrashed = this.detectDaemonCrashMarkers();
    if (this.daemonJustCrashed) {
      console.log('[agent-manager] Detected .daemon-crashed marker(s) — previous daemon exited abnormally. Will quiet BUG-011 alarm for this startup cycle.');
    }
  }

  /**
   * Scan state/<agent>/.daemon-crashed markers (written by daemon/index.ts:handleFatal).
   * Presence means the previous daemon process died via uncaughtException
   * or process.kill rather than a clean shutdown.
   */
  private detectDaemonCrashMarkers(): boolean {
    const stateBase = join(this.ctxRoot, 'state');
    if (!existsSync(stateBase)) return false;
    try {
      const dirs = readdirSync(stateBase, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
      return dirs.some(name => existsSync(join(stateBase, name, '.daemon-crashed')));
    } catch {
      return false;
    }
  }

  /**
   * Delete .daemon-crashed markers after a successful discoverAndStart pass
   * AND clear the daemonJustCrashed flag. Once the initial post-crash
   * discovery has finished, any further startAgent calls — IPC-triggered
   * agent enables, dashboard restarts, manual restartAgent — represent
   * normal operation, not post-crash overlap. They should fire the real
   * BUG-011 alarm, not the quieted variant.
   *
   * Called once per daemon startup at the end of discoverAndStart().
   * Idempotent — if no markers exist, this is a no-op. Wrapped in
   * best-effort try/catch so a missing dir or permission error never
   * blocks daemon startup.
   */
  private clearDaemonCrashMarkers(): void {
    if (!this.daemonJustCrashed) return;
    const stateBase = join(this.ctxRoot, 'state');
    if (existsSync(stateBase)) {
      try {
        const dirs = readdirSync(stateBase, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => d.name);
        for (const name of dirs) {
          try {
            const marker = join(stateBase, name, '.daemon-crashed');
            if (existsSync(marker)) unlinkSync(marker);
          } catch { /* per-agent best effort */ }
        }
      } catch { /* directory unreadable — leave markers, next clean startup will retry */ }
    }
    // Reset the flag so subsequent startAgent calls (IPC enable, dashboard
    // restart, manual restartAgent) get the real BUG-011 alarm, not the
    // quieted post-crash variant.
    this.daemonJustCrashed = false;
  }

  /**
   * Discover and start all enabled agents.
   */
  async discoverAndStart(): Promise<void> {
    const agentDirs = this.discoverAgents();

    // BUG-028: read instance-level enabled-agents.json so the daemon respects
    // the user's explicit enable/disable choices written by the CLI
    // (`cortextos enable`/`disable`) and the dashboard. Without this read, those
    // commands have no effect across daemon restarts — the daemon would
    // re-discover and re-start any agent dir on disk regardless of user intent.
    const instanceEnabled = this.readInstanceEnableList();

    const willStart = agentDirs.filter(({ name, config }) => {
      if (config.enabled === false) {
        console.log(`[agent-manager] Skipping disabled agent: ${name} (per-agent config.json)`);
        return false;
      }
      const entry = instanceEnabled[name];
      if (entry && entry.enabled === false) {
        console.log(`[agent-manager] Skipping disabled agent: ${name} (enabled-agents.json)`);
        return false;
      }
      return true;
    });

    // Pre-pass: build the forum-topic routing registry from every agent that
    // WILL start, before starting any of them. This is race-free by
    // construction — the orchestrator's poller (started inside startAgent)
    // never resolves against a partial map.
    this.buildTopicRegistry(willStart.map(({ name, dir, config }) => ({ name, dir, config })));

    for (const { name, dir, org, config } of willStart) {
      // BUG-043 fix: pass the per-agent org so startAgent can use it instead
      // of falling back to `this.org` (the daemon's startup org).
      await this.startAgent(name, dir, config, org);
    }

    // Successful startup pass — clear .daemon-crashed markers from disk
    // AND clear the in-memory daemonJustCrashed flag. After this point,
    // any further startAgent() calls (IPC enable, dashboard restart, etc)
    // are normal operation and should fire the real BUG-011 alarm if a
    // race ever does leak through PR #11's protection.
    this.clearDaemonCrashMarkers();
  }

  /**
   * Read CHAT_ID + TOPIC_ID from an agent's .env. Returns undefined fields
   * when absent. Single source of truth for topic config is the .env
   * (consistent with BOT_TOKEN/CHAT_ID/ALLOWED_USER resolution).
   */
  private readTopicEnv(agentDir: string): { chatId?: string; topicId?: number } {
    const envFile = join(agentDir, '.env');
    if (!existsSync(envFile)) return {};
    try {
      const content = readFileSync(envFile, 'utf-8');
      const chatId = content.match(/^CHAT_ID=(.+)$/m)?.[1]?.trim();
      const topicRaw = content.match(/^TOPIC_ID=(.+)$/m)?.[1]?.trim();
      const topicId = topicRaw && /^\d+$/.test(topicRaw) ? parseInt(topicRaw, 10) : undefined;
      return { chatId: chatId || undefined, topicId };
    } catch {
      return {};
    }
  }

  /**
   * Build the forum-topic routing registry keyed by "${chatId}:${topicId}".
   * Duplicate (chatId, topicId) across agents fails closed: BOTH owners are
   * dropped and a warning logged, so an ambiguous topic never mis-routes.
   */
  private buildTopicRegistry(agents: Array<{ name: string; dir: string; config?: AgentConfig }>): void {
    this.topicRegistry.clear();
    const dupes = new Set<string>();
    for (const { name, dir, config } of agents) {
      const { chatId, topicId } = this.readTopicEnv(dir);
      if (chatId === undefined) continue; // no group/chat → nothing to map
      // v1 single-group: one .env TOPIC_ID per agent.
      if (topicId !== undefined) this.registerTopicKey(name, chatId, topicId, dupes);
      // v2 per-agent-group: every project topic in this agent's own group →
      // this agent. Required so the agent's OWN topic callbacks resolve to self
      // (an unregistered topic would drop ask callbacks, fail-closed).
      for (const k of Object.keys(config?.project_topics ?? {})) {
        const pt = /^\d+$/.test(k) ? parseInt(k, 10) : NaN;
        if (Number.isFinite(pt)) this.registerTopicKey(name, chatId, pt, dupes);
      }
    }
    console.log(`[agent-manager] Topic registry built: ${this.topicRegistry.size} topic(s) mapped.`);
  }

  /**
   * Register one (chatId, topicId) → agent mapping with duplicate fail-closed:
   * a conflicting owner drops BOTH entries so an ambiguous topic never routes.
   */
  private registerTopicKey(name: string, chatId: string, topicId: number, dupes?: Set<string>): void {
    const key = `${chatId}:${topicId}`;
    if (dupes?.has(key)) return; // already poisoned by a cross-owner collision
    const existing = this.topicRegistry.get(key);
    if (existing === name) return; // same agent re-registering (e.g. .env TOPIC_ID also in project_topics) — idempotent
    if (existing !== undefined) {
      // A DIFFERENT agent already claims this (chat, topic) — ambiguous; fail closed.
      console.warn(`[agent-manager] Duplicate topic ${topicId} in chat ${chatId} (${existing} vs ${name}) — both unmapped, fail closed.`);
      this.topicRegistry.delete(key);
      dupes?.add(key);
      return;
    }
    this.topicRegistry.set(key, name);
  }

  /**
   * Resolve the agent that owns a forum topic for a given chat.
   *   - threadId undefined  -> null (General / DM: caller keeps the message)
   *   - mapped (chatId,thread) -> owning agent name
   *   - set but unmapped    -> null (caller falls back + warns)
   */
  resolveTopicOwner(chatId: string | number, threadId?: number): string | null {
    if (threadId === undefined) return null;
    return this.topicRegistry.get(`${chatId}:${threadId}`) ?? null;
  }

  /**
   * Add/refresh a single agent's topic mapping. Used when an agent is started
   * dynamically (IPC enable / restart) AFTER the discoverAndStart pre-pass, so
   * its topic resolves immediately instead of falling back to the orchestrator
   * until the next daemon restart. Conflicting (chatId,topicId) fails closed.
   */
  private upsertTopicRegistry(name: string, chatId?: string, topicId?: number, config?: AgentConfig): void {
    if (!chatId) return;
    // Share ONE dupes set across this agent's TOPIC_ID + project_topics calls so
    // a cross-owner collision stays poisoned for the whole upsert. Without it, a
    // collision deleted in the first call would be silently re-added by the
    // second (e.g. when .env TOPIC_ID is also a project_topics key). [Codex CB1]
    const dupes = new Set<string>();
    if (topicId !== undefined) this.registerTopicKey(name, chatId, topicId, dupes);
    for (const k of Object.keys(config?.project_topics ?? {})) {
      const pt = /^\d+$/.test(k) ? parseInt(k, 10) : NaN;
      if (Number.isFinite(pt)) this.registerTopicKey(name, chatId, pt, dupes);
    }
  }

  /** Drop any topic mapping owned by `name` (on stop/disable). */
  private removeFromTopicRegistry(name: string): void {
    for (const [k, v] of this.topicRegistry) {
      if (v === name) this.topicRegistry.delete(k);
    }
  }

  /**
   * Read the instance-level enabled-agents.json registry.
   * Returns an empty object if the file is missing or unreadable —
   * agents not present in the file default to enabled, matching the existing
   * default-on behavior of `discoverAndStart`.
   */
  private readInstanceEnableList(): Record<string, { enabled?: boolean; org?: string; status?: string }> {
    const enabledFile = join(this.ctxRoot, 'config', 'enabled-agents.json');
    if (!existsSync(enabledFile)) return {};
    try {
      return JSON.parse(readFileSync(enabledFile, 'utf-8'));
    } catch {
      return {}; // corrupt or unreadable — fall through to default-enabled
    }
  }

  /**
   * BUG-043 fix: resolve the canonical org for a given agent without
   * defaulting to the daemon's startup `this.org`.
   *
   * Resolution order:
   *   1. Explicit `org` argument (e.g. from `discoverAgents()` which knows
   *      which org a dir lives under)
   *   2. `enabled-agents.json[name].org` — set by `cortextos enable`/`add-agent`
   *   3. Filesystem scan: walk `frameworkRoot/orgs/*` looking for a dir
   *      named `name` — handles legacy enabled-agents.json entries that
   *      were written before the `org` field was added
   *   4. Legacy fallback: `this.org` (preserves single-org install behavior)
   *
   * Before this fix, all six `this.org` sites in `agent-manager.ts` would
   * short-circuit to the daemon's startup `CTX_ORG`, which silently broke
   * multi-org installs — agents in `lifeos` or `cointally` were invisible
   * to a daemon started with `CTX_ORG=testorg`.
   */
  private resolveAgentOrg(name: string, explicitOrg?: string): string {
    if (explicitOrg) return explicitOrg;

    const enabledAgents = this.readInstanceEnableList();
    const entry = enabledAgents[name];
    if (entry?.org) return entry.org;

    // Legacy fallback: scan all orgs on disk for a dir named `name`.
    // Handles enabled-agents.json entries missing the `org` field, or
    // agents that were created via raw filesystem operations.
    const orgsBase = join(this.frameworkRoot, 'orgs');
    if (existsSync(orgsBase)) {
      try {
        const orgs = readdirSync(orgsBase, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => d.name);
        for (const org of orgs) {
          if (existsSync(join(orgsBase, org, 'agents', name))) {
            return org;
          }
        }
      } catch { /* ignore read errors */ }
    }

    // Ultimate fallback: daemon's startup org (single-org install behavior)
    return this.org;
  }

  /**
   * Start a specific agent.
   *
   * BUG-043 fix: accepts an optional `org` parameter and uses
   * `resolveAgentOrg()` to find the correct org for path/env lookups
   * instead of falling back to `this.org`. This makes the daemon
   * multi-org aware — an install with lifeos + cointally + testorg will
   * spawn each agent in its correct org dir regardless of what
   * `CTX_ORG` the daemon was started with.
   */
  /**
   * Synchronously classify a start/stop/restart request before dispatch.
   *
   * Lets the IPC handler distinguish DEDUPED (agent already in registry, so
   * a start is collapsing against an in-flight identical op — or a stop /
   * restart of an agent that was just removed) from NOT_FOUND (agent never
   * existed in the registry). The dedup logic in startAgent / stopAgent /
   * restartAgent is unchanged — this read-only check exists purely to give
   * the IPC layer enough info to set IPCResponse.code. See issue #346.
   */
  inspectAgentOp(op: 'start' | 'stop' | 'restart', name: string): { ok: true } | { ok: false; code: 'DEDUPED' | 'NOT_FOUND'; message: string } {
    const inRegistry = this.agents.has(name);
    if (op === 'start') {
      if (inRegistry) {
        return { ok: false, code: 'DEDUPED', message: `start request for "${name}" deduped — agent already in registry (in-flight start or already running)` };
      }
      return { ok: true };
    }
    // stop / restart need the agent to be present
    if (!inRegistry) {
      return { ok: false, code: 'NOT_FOUND', message: `agent "${name}" not in registry — cannot ${op}` };
    }
    return { ok: true };
  }

  async startAgent(name: string, agentDir: string, config?: AgentConfig, org?: string): Promise<void> {
    if (this.agents.has(name)) {
      // BUG-031: this branch was the workaround for the BUG-011 PTY race
      // (restart-all could send stop+start simultaneously, and the new
      // start would arrive while the old stop's PTY exit was still in
      // flight). PR #11 closed BUG-011 by making `AgentProcess.stop()`
      // await the actual PTY exit before resolving — which means this
      // branch should NEVER fire under normal restart paths.
      //
      // We log a regression warning here instead of deleting the branch
      // entirely, so we'll know IMMEDIATELY if BUG-011 ever regresses
      // (a future change accidentally breaks the exit-await). Phase 4 of
      // the core stability test plan + cycle 2 of PR #13 both confirmed
      // this branch is dormant. Once we have weeks of zero-warning
      // production data, we can delete the queue mechanism entirely.
      if (this.daemonJustCrashed) {
        // Post-crash startup. The previous daemon exited via
        // uncaughtException without running stopAll(), so the in-memory
        // registry from the prior process is gone — but the post-crash
        // discoverAndStart pass can briefly re-enter startAgent for an
        // agent whose pendingRestarts entry survived. This is benign and
        // distinct from the BUG-011 in-flight race PR #11 closed. Log at
        // info level so operators don't think PR #11 has regressed.
        console.log(`[agent-manager] ${name} already in registry (post-crash discovery overlap, expected). Queueing restart.`);
      } else {
        console.warn(`[agent-manager] BUG-011 REGRESSION CHECK: ${name} still in registry during startAgent — pendingRestarts queueing engaged. This should not happen with PR #11 in place.`);
      }
      this.pendingRestarts.add(name);
      return;
    }

    // BUG-043 fix: resolve the agent's true org instead of using `this.org`.
    const resolvedOrg = this.resolveAgentOrg(name, org);

    // Auto-discover agent directory if not provided (e.g. when started via IPC)
    if (!agentDir || !existsSync(agentDir)) {
      const discovered = join(this.frameworkRoot, 'orgs', resolvedOrg, 'agents', name);
      if (existsSync(discovered)) {
        agentDir = discovered;
      } else {
        console.error(`[agent-manager] Agent directory not found for ${name}: tried ${discovered}`);
        return;
      }
    }

    if (!config) {
      config = this.loadAgentConfig(agentDir);
    }

    const env: CtxEnv = {
      instanceId: this.instanceId,
      ctxRoot: this.ctxRoot,
      frameworkRoot: this.frameworkRoot,
      agentName: name,
      agentDir,
      org: resolvedOrg,
      projectRoot: this.frameworkRoot,
    };

    const paths = resolvePaths(name, this.instanceId, resolvedOrg);

    const log = (msg: string) => {
      console.log(`[${name}] ${msg}`);
    };

    // Read agent .env for Telegram credentials
    const agentEnvFile = join(agentDir, '.env');
    let telegramApi: TelegramAPI | undefined;
    let chatId: string | undefined;
    let allowedUserId: string | undefined;
    let botToken: string | undefined;
    let topicId: number | undefined;

    if (existsSync(agentEnvFile)) {
      // stripBom: Windows tooling writes .env with a UTF-8 BOM that breaks
      // /^BOT_TOKEN=/m when BOT_TOKEN is on line 1 (2026-05-16 silent
      // smith-not-receiving-Telegram incident). See src/utils/strip-bom.ts.
      const envContent = stripBom(readFileSync(agentEnvFile, 'utf-8'));
      const botTokenMatch = envContent.match(/^BOT_TOKEN=(.+)$/m);
      const chatIdMatch = envContent.match(/^CHAT_ID=(.+)$/m);
      const allowedUserMatch = envContent.match(/^ALLOWED_USER=(.+)$/m);
      botToken = botTokenMatch?.[1]?.trim();
      chatId = chatIdMatch?.[1]?.trim();
      allowedUserId = allowedUserMatch?.[1]?.trim() || undefined;
      // Forum-topic id (single source of truth for this agent's topic).
      // Unset = the agent owns the General topic / plain DM.
      const topicRaw = envContent.match(/^TOPIC_ID=(.+)$/m)?.[1]?.trim();
      topicId = topicRaw && /^\d+$/.test(topicRaw) ? parseInt(topicRaw, 10) : undefined;

      // Validate BOT_TOKEN format: must be numeric_id:alphanumeric_secret
      if (botToken && !/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) {
        log(`WARNING: BOT_TOKEN format invalid (expected: 123456:ABC...). Telegram will not start.`);
        botToken = undefined;
      }

      // ALLOWED_USER must be one or more numeric Telegram user IDs.
      // Comma-separated for multi-user (e.g. group chats with Sam + a collaborator).
      // Whitespace tolerated; any non-numeric token rejects the whole list.
      if (allowedUserId) {
        const ids = allowedUserId.split(',').map((s) => s.trim()).filter(Boolean);
        if (ids.length === 0 || !ids.every((id) => /^\d+$/.test(id))) {
          log(`SECURITY: ALLOWED_USER must be a comma-separated list of numeric Telegram user IDs (e.g. 123456789,987654321). Refusing to enable Telegram. Fix the .env file.`);
          allowedUserId = undefined;
        } else {
          // Normalize to comma-joined form so downstream gate splits on it
          allowedUserId = ids.join(',');
        }
      }

      // Security: ALLOWED_USER is REQUIRED when BOT_TOKEN is set. Without it,
      // ANY Telegram user who finds the bot @handle could control the agent.
      // Fail closed: refuse to start Telegram unless the operator explicitly
      // whitelists their numeric user ID.
      if (botToken && !allowedUserId) {
        log(`SECURITY: BOT_TOKEN is set but ALLOWED_USER is missing. Refusing to enable Telegram. Set ALLOWED_USER to your numeric Telegram user ID in .env, or remove BOT_TOKEN to start the agent without Telegram.`);
        if (chatId) {
          const alertApi = new TelegramAPI(botToken);
          alertApi.sendMessage(chatId,
            `⚠️ WATCHDOG: ${name} has BOT_TOKEN but ALLOWED_USER is missing or malformed in .env. Telegram is DISABLED for this agent. Fix ALLOWED_USER and restart.`,
            undefined,
            { messageThreadId: topicId },
          ).catch(() => {});
        }
        botToken = undefined;
      }

      if (botToken && chatId) {
        telegramApi = new TelegramAPI(botToken);
        // Don't log sensitive user IDs — just indicate the gate is enabled
        log(`Telegram configured (chat_id: ****${String(chatId).slice(-4)}, allowed_user: enabled)`);
      }
    }

    const agentProcess = new AgentProcess(name, env, config, log);
    // Issue #330: pass the Telegram handle into AgentProcess so CodexAppServerPTY
    // can emit sendChatAction directly from the JSONL stream. Has no effect for
    // claude-code / hermes runtimes — those still use fast-checker.
    if (telegramApi && chatId) {
      agentProcess.setTelegramHandle(telegramApi, chatId, topicId);
    }
    const checker = new FastChecker(agentProcess, paths, this.frameworkRoot, {
      log,
      telegramApi,
      chatId,
      topicId,
      // FastChecker only needs the first ID for its single-recipient typing
      // indicator / quick-checks. Multi-user is enforced by the gates above.
      allowedUserId: allowedUserId ? parseInt(allowedUserId.split(',')[0].trim(), 10) : undefined,
    });

    // Send Telegram notification on crashes and session refreshes
    if (telegramApi && chatId) {
      const tgApi = telegramApi;
      const tgChatId = chatId;
      const tgThread = topicId;
      let prevStatus: string | null = null;
      agentProcess.onStatusChanged((status) => {
        if (status.status === 'crashed') {
          const crashNum = status.crashCount ?? '?';
          tgApi.sendMessage(tgChatId, `Agent ${name} crashed (crash #${crashNum}) — auto-restarting`, undefined, { messageThreadId: tgThread }).catch(() => {});
        } else if (status.status === 'halted') {
          tgApi.sendMessage(tgChatId, `Agent ${name} HALTED — exceeded crash limit. Restart manually with: cortextos start ${name}`, undefined, { messageThreadId: tgThread }).catch(() => {});
        } else if (status.status === 'running' && prevStatus === 'crashed') {
          tgApi.sendMessage(tgChatId, `Agent ${name} recovered and is back online`, undefined, { messageThreadId: tgThread }).catch(() => {});
        }
        prevStatus = status.status;
      });
    }

    this.agents.set(name, { process: agentProcess, checker, topicId, chatId });
    // Keep the topic registry current for agents started after the
    // discoverAndStart pre-pass (IPC enable / restart). [Codex R1 #3]
    this.upsertTopicRegistry(name, chatId, topicId, config);

    // Start agent
    await agentProcess.start();

    // Subtask 2.2: Auto-migrate crons from config.json → crons.json before
    // starting the scheduler, so the scheduler always has a populated crons.json
    // to read from.  The migration is idempotent (marker file prevents re-runs).
    const configJsonPath = join(agentDir, 'config.json');
    migrateCronsForAgent(name, configJsonPath, this.ctxRoot, {
      log: (msg) => log(`[migration] ${msg}`),
    });

    // Wire daemon-level CronScheduler for this agent.
    // The scheduler reads crons.json, fires crons, and injects prompts into
    // the agent PTY via injectAgent().  This is the Phase 2 daemon-managed
    // external cron system — agents no longer need to call CronCreate on boot.
    this.startAgentCronScheduler(name);

    // Start fast checker in background
    checker.start().catch(err => {
      console.error(`[${name}] Fast checker error:`, err);
    });

    // Register Telegram slash commands at startup (fix for issue #1)
    if (telegramApi && botToken) {
      const scanDirs = [agentDir, this.frameworkRoot].filter(Boolean);
      const commands = collectTelegramCommands(scanDirs);
      registerTelegramCommands(botToken, commands).then((result) => {
        if (result.status === 'ok') {
          log(`Telegram commands registered (${result.count} commands)`);
        }
      }).catch(() => { /* non-fatal */ });
    }

    // Start Telegram poller if credentials are available and not explicitly disabled.
    // Set telegram_polling: false in config.json to prevent a specialist agent from
    // running its own poller (only the designated orchestrator agent should poll).
    if (telegramApi && chatId && config.telegram_polling !== false) {
      const stateDir = join(this.ctxRoot, 'state', name);
      const poller = new TelegramPoller(telegramApi, stateDir);

      const REJECT_ALERT_THRESHOLD = 3;
      const REJECT_ALERT_COOLDOWN_MS = 30 * 60 * 1000;

      poller.onMessage((msg) => {
        // ALLOWED_USER gate: comma-separated list of numeric user IDs.
        // If configured, ignore messages from other users. Always log the
        // rejected user_id + name so operators can discover IDs to whitelist.
        if (allowedUserId) {
          const allowedIds = allowedUserId.split(',').map((s) => parseInt(s.trim(), 10));
          const fromId = msg.from?.id;
          if (typeof fromId !== 'number' || !allowedIds.includes(fromId)) {
            const rejectedFrom = msg.from?.first_name || msg.from?.username || 'unknown';
            log(`Ignoring message from unauthorized user (allowed_user gate): from=${fromId} (${rejectedFrom})`);
            // #459 reject-count watchdog: alert after N consecutive rejects (multi-user gate from #467 preserved).
            const entry = this.agents.get(name);
            if (entry) {
              entry.telegramRejectCount = (entry.telegramRejectCount ?? 0) + 1;
              if (entry.telegramRejectCount >= REJECT_ALERT_THRESHOLD) {
                const now = Date.now();
                const lastAlert = entry.telegramLastRejectAlertAt ?? 0;
                if (now - lastAlert > REJECT_ALERT_COOLDOWN_MS) {
                  entry.telegramLastRejectAlertAt = now;
                  const alertText = `⚠️ WATCHDOG: ${name} rejected ${entry.telegramRejectCount} consecutive Telegram messages (ALLOWED_USER gate). Last from_id: ${fromId ?? 'unknown'}. Verify ALLOWED_USER in .env matches expected users, or this may be unsolicited contact.`;
                  log(alertText);
                  if (telegramApi && chatId) {
                    telegramApi.sendMessage(chatId, alertText, undefined, { messageThreadId: topicId }).catch(() => {});
                  }
                }
              }
            }
            return;
          }
        }

        // Message passed ALLOWED_USER gate — reset rejection counter.
        const agentEntry = this.agents.get(name);
        if (agentEntry) agentEntry.telegramRejectCount = 0;

        const from = stripControlChars(msg.from?.first_name || msg.from?.username || 'Unknown');
        const msgChatId = msg.chat?.id;
        const effectiveChatId = msgChatId ?? chatId ?? '';

        // Forum service messages (topic created/edited/closed/reopened, General
        // hidden/unhidden) arrive on the ordinary `message` update carrying a
        // message_thread_id but no human body. Filter them BEFORE routing —
        // otherwise they inject as a blank prompt (and they fire during the
        // migration's own topic-creation step). [Codex CB5]
        if (
          msg.forum_topic_created || msg.forum_topic_edited || msg.forum_topic_closed ||
          msg.forum_topic_reopened || msg.general_forum_topic_hidden || msg.general_forum_topic_unhidden
        ) {
          log(`[topic-routing] ignoring forum service message (thread ${msg.message_thread_id ?? '?'})`);
          return;
        }

        // Chat-scope guard: a forum topic id is only meaningful within its own
        // chat. Never route on a thread id from a chat other than this agent's
        // configured CHAT_ID — otherwise a foreign group's matching topic id
        // could inject into an agent. [Codex CB1]
        if (chatId !== undefined && String(msgChatId) !== String(chatId)) {
          log(`[topic-routing] ignoring message from non-configured chat ${msgChatId} (expected ${chatId})`);
          return;
        }

        // Resolve the topic owner. undefined thread = General → this (the
        // polling orchestrator). A set-but-unmapped thread falls back to the
        // orchestrator with a logged warning (single source of routing truth).
        const threadId = msg.message_thread_id;
        const resolvedOwner = this.resolveTopicOwner(effectiveChatId, threadId);
        if (threadId !== undefined && resolvedOwner === null) {
          log(`[topic-routing] unknown thread ${threadId} in chat ${effectiveChatId} → orchestrator fallback`);
        }
        const targetName = resolvedOwner ?? name;
        // Route state/history/inbound-log under the OWNER agent identity so a
        // routed specialist sees its own last-sent/history, and per-agent state
        // dirs keep each topic's traffic isolated. [Codex CB4 / Claude C1]
        const targetStateDir = join(this.ctxRoot, 'state', targetName);
        const targetPaths = targetName === name ? paths : resolvePaths(targetName, this.instanceId, resolvedOrg);

        // Single delivery decision point: inject into the owning agent's PTY,
        // or queue to the orchestrator's own checker for General. Used by EVERY
        // branch below (text, media-success, media-null, media-error) so no
        // branch can silently self-queue a routed message. [Claude B3]
        const deliver = (formatted: string): void => {
          if (targetName !== name) {
            const res = this.injectAgentDetailed(targetName, formatted);
            if (!res.ok && res.code !== 'DEDUPED') {
              log(`[topic-routing] inject to ${targetName} failed (${res.code}) → orchestrator fallback`);
              if (!checker.isDuplicate(formatted)) checker.queueTelegramMessage(formatted);
            }
            return;
          }
          if (!checker.isDuplicate(formatted)) checker.queueTelegramMessage(formatted);
        };

        // Persist the inbound message to JSONL AND emit a
        // `message/telegram_received` bus event — under the OWNER's identity.
        recordInboundTelegram(targetPaths, this.ctxRoot, targetName, resolvedOrg, from, msg, log);

        // Check for media messages (photo, document, voice, audio, video, video_note)
        const isMedia = !!(msg.photo || msg.document || msg.voice || msg.audio || msg.video || msg.video_note);

        if (isMedia && telegramApi) {
          // Media must be downloaded into AND relativized against the OWNING
          // agent's workspace, not the polling orchestrator's — otherwise the
          // injected local_file path won't resolve when the target agent reads
          // it. [Codex R1 #1]
          const ownerProc = this.agents.get(targetName)?.process;
          const ownerAgentDir = ownerProc?.getAgentDir() ?? agentDir;
          const ownerConfig = ownerProc?.getConfig() ?? config;
          const downloadDir = join(ownerAgentDir, 'telegram-images');
          processMediaMessage(msg, telegramApi, downloadDir).then((media) => {
            if (!media) {
              log('Media processing returned null - falling back to text format');
              const text = stripControlChars(msg.caption || '');
              deliver(FastChecker.formatTelegramTextMessage(from, effectiveChatId, text, this.frameworkRoot, undefined, undefined, undefined, threadId));
              return;
            }

            // BUG-046: Convert absolute paths to relative (from agent working dir).
            // Claude Code strips absolute paths from pasted user input, so the
            // agent never sees them. Relative paths survive injection.
            // BUG-049: Use the agent's actual launch cwd (config.working_directory
            // if set, else agentDir) so the path resolves when Read() is invoked.
            const launchDir = ownerConfig?.working_directory || ownerAgentDir;
            const toRel = (p: string | undefined) => p ? relative(launchDir, p) : '';
            const relImagePath = toRel(media.image_path);
            const relFilePath = toRel(media.file_path);

            log(`[DEBUG] media.type=${media.type} image_path=${JSON.stringify(relImagePath)} file_path=${JSON.stringify(relFilePath)}`);
            let formatted: string;
            if (media.type === 'photo') {
              formatted = FastChecker.formatTelegramPhotoMessage(from, effectiveChatId, media.text, relImagePath, threadId);
            } else if (media.type === 'document') {
              formatted = FastChecker.formatTelegramDocumentMessage(from, effectiveChatId, media.text, relFilePath, media.file_name!, threadId);
            } else if (media.type === 'voice' || media.type === 'audio') {
              formatted = FastChecker.formatTelegramVoiceMessage(from, effectiveChatId, relFilePath, media.duration, media.transcript, threadId);
            } else {
              // video or video_note
              formatted = FastChecker.formatTelegramVideoMessage(from, effectiveChatId, media.text, relFilePath, media.file_name || '', media.duration, threadId);
            }

            log(`Media message received: type=${media.type}, path=${media.image_path || media.file_path}`);
            deliver(formatted);
          }).catch((err) => {
            log(`Media processing error: ${err} - falling back to text format`);
            const text = stripControlChars(msg.caption || '');
            deliver(FastChecker.formatTelegramTextMessage(from, effectiveChatId, text, this.frameworkRoot, undefined, undefined, undefined, threadId));
          });
          return;
        }

        // Text message (non-media)
        const text = stripControlChars(msg.text || '');
        const lastSent = FastChecker.readLastSent(targetStateDir, effectiveChatId, threadId);
        // Build reply context from the replied-to message.
        const replyToText = buildReplyContext(msg.reply_to_message);

        const recentHistory = buildRecentHistory(this.ctxRoot, targetName, effectiveChatId, 6, threadId) ?? undefined;
        // PAG: label the project topic from this agent's own config map.
        const projectLabel = threadId !== undefined ? config?.project_topics?.[String(threadId)] : undefined;
        deliver(FastChecker.formatTelegramTextMessage(
          from,
          effectiveChatId,
          text,
          this.frameworkRoot,
          replyToText,
          lastSent ?? undefined,
          recentHistory,
          threadId,
          projectLabel,
        ));
      });

      poller.onCallback((query) => {
        // Route the callback to the OWNING agent's checker so the hook-response
        // file / PTY keystrokes land in the agent that posted the prompt — not
        // always the polling orchestrator. [Codex CB5/R2#1 / Claude C3 / GLM#3]
        //
        // Resolution order:
        //   1. topic thread (normal case: the button sits in the agent's topic)
        //   2. pending-callback index by the unique id in callback_data
        //      (covers the case where Telegram omits message_thread_id on
        //      perm/restart prompts)
        // Safety rules:
        //   - AskUserQuestion callbacks (askopt/asktoggle/asksubmit) execute as
        //     PTY KEYSTROKES. They are not globally unique, so when a thread is
        //     present but resolves to no running owner we FAIL CLOSED (drop) —
        //     never replay keystrokes on a guessed/orchestrator PTY. A General
        //     (no-thread) ask is the orchestrator's own and routes to self.
        //   - A resolved-but-not-running owner is DROPPED (not handed to the
        //     orchestrator), so a stopped agent's button never mis-fires.
        const data = query.data || '';
        const isAsk = /^(?:askopt|asktoggle|asksubmit)_/.test(data);
        const cbChatId = query.message?.chat?.id ?? chatId ?? '';
        const cbThread = query.message?.message_thread_id;
        const answerExpired = () => {
          if (telegramApi) telegramApi.answerCallbackQuery(query.id, 'Expired or unavailable').catch(() => {});
        };

        let owner = this.resolveTopicOwner(cbChatId, cbThread);
        if (!owner) {
          const id = data.match(/^(?:perm|restart)_(?:allow|deny|continue)_([a-f0-9]+)$/)?.[1];
          if (id) owner = resolvePendingCallback(this.ctxRoot, id);
        }

        const route = decideCallbackRoute({
          isAsk,
          threadPresent: cbThread !== undefined,
          owner,
          selfName: name,
          ownerRunning: owner ? this.agents.has(owner) : false,
        });

        if (route.action === 'drop') {
          log(`[topic-routing] callback dropped (fail-safe): owner=${owner ?? '?'} thread=${cbThread ?? '?'} ask=${isAsk}`);
          answerExpired();
          return;
        }
        const targetChecker = route.action === 'agent' ? this.agents.get(route.owner)?.checker : checker;
        (targetChecker ?? checker).handleCallback(query).catch(err => log(`Callback handling error: ${err}`));
      });

      poller.onReaction((reaction) => {
        // ALLOWED_USER gate: same multi-user rule as message handler.
        if (allowedUserId) {
          const allowedIds = allowedUserId.split(',').map((s) => parseInt(s.trim(), 10));
          const fromId = reaction.user?.id;
          if (typeof fromId !== 'number' || !allowedIds.includes(fromId)) {
            log(`Ignoring reaction from unauthorized user (allowed_user gate): from=${fromId}`);
            // #459 reject-count watchdog (multi-user gate from #467 preserved).
            const entry = this.agents.get(name);
            if (entry) {
              entry.telegramRejectCount = (entry.telegramRejectCount ?? 0) + 1;
              if (entry.telegramRejectCount >= REJECT_ALERT_THRESHOLD) {
                const now = Date.now();
                const lastAlert = entry.telegramLastRejectAlertAt ?? 0;
                if (now - lastAlert > REJECT_ALERT_COOLDOWN_MS) {
                  entry.telegramLastRejectAlertAt = now;
                  const alertText = `⚠️ WATCHDOG: ${name} rejected ${entry.telegramRejectCount} consecutive Telegram interactions (ALLOWED_USER gate). Verify ALLOWED_USER in .env matches expected users, or this may be unsolicited contact.`;
                  log(alertText);
                  if (telegramApi && chatId) {
                    telegramApi.sendMessage(chatId, alertText, undefined, { messageThreadId: topicId }).catch(() => {});
                  }
                }
              }
            }
            return;
          }
        }

        const agentEntry = this.agents.get(name);
        if (agentEntry) agentEntry.telegramRejectCount = 0;

        const from = stripControlChars(reaction.user?.first_name || reaction.user?.username || 'Unknown');
        const reactionChatId = reaction.chat?.id ?? chatId ?? '';
        const formatted = FastChecker.formatTelegramReaction(
          from,
          reactionChatId,
          reaction.message_id,
          reaction.old_reaction ?? [],
          reaction.new_reaction ?? [],
        );
        if (checker.isDuplicate(formatted)) {
          log('Duplicate Telegram reaction suppressed');
          return;
        }
        checker.queueTelegramMessage(formatted);
      });

      // Wrap poller.start() in a restart-on-Conflict loop. The poller's
      // internal Conflict-self-die (see TelegramPoller.start) yields the
      // Telegram getUpdates lock when a duplicate poller is detected — but
      // without a restart layer above, the agent loses Telegram input
      // permanently. After a daemon crash, the old getUpdates connections
      // can hold the lock for ~60s in Telegram's cloud, so this loop
      // sleeps and retries on 'conflict-self-die' until the lock clears.
      // Intentional stops (stopAgent → poller.stop()) set
      // lastExitReason='stopped-externally' and exit the loop cleanly.
      const startPrimaryPollerWithRestart = async () => {
        // 5min hard cap measured against CONSECUTIVE Conflict failures,
        // not total wrapper lifetime. A long-running successful poll
        // (>1min) resets the counter — without this reset, a poller that
        // runs cleanly for hours and then hits a single Conflict would
        // give up immediately because total runtime already exceeds 5min.
        const MAX_CONSECUTIVE_CONFLICT_MS = 5 * 60 * 1000;
        const LONG_RUN_RESET_MS = 60_000;
        let consecutiveConflictStart: number | null = null;
        while (true) {
          // Pre-check: agent may have been deleted from registry during
          // a previous sleep window. Skip the start() call entirely.
          if (!this.agents.has(name)) return;
          const runStart = Date.now();
          try {
            await poller.start();
          } catch (err) {
            log(`Telegram poller threw (will not restart): ${err}`);
            return;
          }
          const runDuration = Date.now() - runStart;
          if (poller.lastExitReason === 'stopped-externally') return;
          if (!this.agents.has(name)) return;
          // A poll session that ran for >LONG_RUN_RESET_MS proves the
          // Conflict lock is no longer chronic — reset the retry budget.
          if (runDuration > LONG_RUN_RESET_MS) consecutiveConflictStart = null;
          if (consecutiveConflictStart === null) consecutiveConflictStart = Date.now();
          if (Date.now() - consecutiveConflictStart > MAX_CONSECUTIVE_CONFLICT_MS) {
            log(`Telegram poller for ${name} could not clear Conflict within 5min of consecutive failures — giving up. Inspect for duplicate bot instance.`);
            return;
          }
          log(`Telegram poller for ${name} exited (${poller.lastExitReason}). Sleeping 30s then restarting to retake getUpdates lock.`);
          await new Promise(r => setTimeout(r, 30_000));
        }
      };
      startPrimaryPollerWithRestart().catch(err => {
        log(`Telegram poller wrapper crashed: ${err}`);
        // Best-effort operator alert via the agent's own bot. The wrapper
        // crashing is rare (the only catchable path is a throw from
        // poller.start() before its own try/catch), but when it happens the
        // agent silently loses Telegram input — exactly the failure class
        // the 2026-05-16 audit flagged. Surface it to the operator chat so
        // they see "X poller crashed" instead of mysterious silence.
        if (telegramApi && chatId) {
          telegramApi.sendMessage(
            String(chatId),
            `${name}: Telegram poller wrapper crashed. Inbound messages may be dropped until restart. Check daemon log.`,
            undefined,
            { messageThreadId: topicId },
          ).catch(() => { /* swallow alert failure; original log already captured */ });
        }
      });

      // Store poller reference so stopAgent() can clean it up
      const entry = this.agents.get(name);
      if (entry) entry.poller = poller;

      log('Telegram poller started (with Conflict-restart wrapper)');

      // Orchestrator-only: start a second poller for the org's activity
      // channel bot so Telegram inline-button callbacks (currently just
      // appr_allow_*/appr_deny_* from createApproval posts) route to
      // fast-checker's approval resolver. Polling coupled to orchestrator
      // lifecycle is a known trade-off accepted in task_1776053707166_292
      // — follow-up task_1776054009969_099 tracks migrating to a dedicated
      // singleton or Telegram webhook if the coupling ever causes real
      // operator pain. Non-orchestrator agents skip this entirely.
      await this.maybeStartActivityChannelPoller(name, org, agentDir, log);
    }
  }

  /**
   * If this agent is the org's orchestrator AND the org has an
   * activity-channel.env configured, start a second TelegramPoller bound
   * to ACTIVITY_BOT_TOKEN. Callbacks route to fast-checker's
   * handleActivityCallback. Safe no-op in every other case — if the
   * context.json is missing/corrupt, the orchestrator field is empty,
   * this agent is not the orchestrator, or the activity-channel.env
   * is absent/unreadable/missing credentials, this method returns
   * without starting anything.
   */
  private async maybeStartActivityChannelPoller(
    name: string,
    org: string | undefined,
    agentDir: string,
    log: LogFn,
  ): Promise<void> {
    if (!org) return;
    const orgDir = join(this.frameworkRoot, 'orgs', org);

    // Only the org's orchestrator runs the activity-channel poller.
    let orchestratorName: string | undefined;
    try {
      // stripBom: see src/utils/strip-bom.ts for incident context.
      const contextJson = stripBom(readFileSync(join(orgDir, 'context.json'), 'utf-8'));
      orchestratorName = JSON.parse(contextJson).orchestrator;
    } catch {
      return; // No context.json or unreadable — skip
    }
    if (!orchestratorName || orchestratorName !== name) return;

    // Parse activity-channel.env for the separate bot token + chat id.
    const activityEnvPath = join(orgDir, 'activity-channel.env');
    let activityBotToken: string | undefined;
    let activityChatId: string | undefined;
    try {
      // stripBom + CRLF-aware split: Windows tooling writes activity-channel.env
      // with BOM + CRLF. Without these, ACTIVITY_BOT_TOKEN never resolves
      // and the activity-channel poller silently never starts.
      const content = stripBom(readFileSync(activityEnvPath, 'utf-8'));
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx <= 0) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim();
        if (key === 'ACTIVITY_BOT_TOKEN') activityBotToken = value;
        if (key === 'ACTIVITY_CHAT_ID') activityChatId = value;
      }
    } catch {
      return; // activity-channel.env absent — silent no-op
    }

    if (!activityBotToken || !activityChatId) {
      log('Activity-channel env present but missing BOT_TOKEN or CHAT_ID — skipping poller');
      return;
    }

    const activityApi = new TelegramAPI(activityBotToken);
    const stateDir = join(this.ctxRoot, 'state', name);
    // offsetFileSuffix keeps the activity poller's offset file distinct
    // from the primary bot's .telegram-offset — without this they would
    // clobber each other in the same stateDir.
    const activityPoller = new TelegramPoller(activityApi, stateDir, 1000, 'activity');

    activityPoller.onCallback((query) => {
      const entry = this.agents.get(name);
      if (!entry) return;
      entry.checker.handleActivityCallback(query, activityApi).catch((err) => {
        log(`Activity-channel callback error: ${err}`);
      });
    });

    // Best-effort message logger — activity channel is primarily outbound
    // but any inbound chatter (broadcasts, user DMs, etc.) gets logged
    // so operators can see what is flowing. No PTY injection.
    activityPoller.onMessage((msg) => {
      const from = stripControlChars(msg.from?.first_name || msg.from?.username || 'Unknown');
      const text = stripControlChars(msg.text || msg.caption || '');
      log(`[activity-channel inbound] from ${from}: ${text.slice(0, 120)}`);
    });

    // Same Conflict-restart wrapper as the primary poller — activity
    // channel can lose its getUpdates lock after a daemon crash too.
    // 5min retry budget measured against CONSECUTIVE failures; resets
    // after a >1min successful run. See primary poller wrapper for rationale.
    const startActivityPollerWithRestart = async () => {
      const MAX_CONSECUTIVE_CONFLICT_MS = 5 * 60 * 1000;
      const LONG_RUN_RESET_MS = 60_000;
      let consecutiveConflictStart: number | null = null;
      while (true) {
        if (!this.agents.has(name)) return;
        const runStart = Date.now();
        try {
          await activityPoller.start();
        } catch (err) {
          log(`Activity-channel poller threw (will not restart): ${err}`);
          return;
        }
        const runDuration = Date.now() - runStart;
        if (activityPoller.lastExitReason === 'stopped-externally') return;
        if (!this.agents.has(name)) return;
        if (runDuration > LONG_RUN_RESET_MS) consecutiveConflictStart = null;
        if (consecutiveConflictStart === null) consecutiveConflictStart = Date.now();
        if (Date.now() - consecutiveConflictStart > MAX_CONSECUTIVE_CONFLICT_MS) {
          log(`Activity-channel poller for ${name} could not clear Conflict within 5min of consecutive failures — giving up.`);
          return;
        }
        log(`Activity-channel poller for ${name} exited (${activityPoller.lastExitReason}). Sleeping 30s then restarting.`);
        await new Promise(r => setTimeout(r, 30_000));
      }
    };
    startActivityPollerWithRestart().catch((err) => {
      log(`Activity-channel poller wrapper crashed: ${err}`);
    });

    const entry = this.agents.get(name);
    if (entry) entry.activityPoller = activityPoller;

    log(`Activity-channel poller started (chat ${activityChatId}, with Conflict-restart wrapper)`);
  }

  /**
   * Stop a specific agent.
   */
  async stopAgent(name: string): Promise<void> {
    const entry = this.agents.get(name);
    if (!entry) {
      console.log(`[agent-manager] Agent ${name} not found`);
      return;
    }

    if (entry.poller) entry.poller.stop();
    if (entry.activityPoller) entry.activityPoller.stop();
    entry.checker.stop();
    await entry.process.stop();
    this.agents.delete(name);
    this.removeFromTopicRegistry(name);

    // Stop and remove the agent's cron scheduler (if one was wired)
    const scheduler = this.cronSchedulers.get(name);
    if (scheduler) {
      scheduler.stop();
      this.cronSchedulers.delete(name);
    }

    // BUG-031: honor any restart that was queued while we were stopping.
    // After PR #11 (BUG-011 fix) this branch should never fire — see the
    // matching warning comment in startAgent(). The honor logic is preserved
    // as a safety net in case BUG-011 regresses; the warn line tells us
    // immediately if it ever does.
    if (this.pendingRestarts.has(name)) {
      if (this.daemonJustCrashed) {
        console.log(`[agent-manager] pendingRestarts fired for ${name} (post-crash safety net, expected). Honoring queued restart.`);
      } else {
        console.warn(`[agent-manager] BUG-011 REGRESSION CHECK: pendingRestarts fired for ${name} — race condition leaked through. Honoring queued restart as safety net.`);
      }
      this.pendingRestarts.delete(name);
      console.log(`[agent-manager] Honoring queued restart for ${name}`);
      this.startAgent(name, '').catch(err =>
        console.error(`[agent-manager] Queued restart failed for ${name}:`, err),
      );
    }
  }

  /**
   * Restart a specific agent.
   *
   * Delegates to stopAgent + startAgent to guarantee a full teardown and
   * rebuild of every per-agent resource: AgentProcess, FastChecker, TelegramAPI,
   * TelegramPoller, crash callback, and slash-command registration. Fresh
   * credentials are re-read from {agentDir}/.env on each restart.
   *
   * agentDir is auto-discovered by startAgent() from frameworkRoot/orgs/{org}/agents/{name}.
   * Participates in the pendingRestarts race protection used by restart-all.
   */
  async restartAgent(name: string): Promise<void> {
    if (!this.agents.has(name)) {
      console.log(`[agent-manager] Agent ${name} not found — cannot restart`);
      return;
    }
    console.log(`[agent-manager] Restarting ${name}`);
    await this.stopAgent(name);
    await this.startAgent(name, '');
    console.log(`[agent-manager] Restart complete for ${name}`);
  }

  /**
   * Stop all agents.
   *
   * BUG-034 partial fix: writes a `.daemon-stop` marker file in each agent's
   * state dir BEFORE stopping it. The SessionEnd crash-alert hook
   * (src/hooks/hook-crash-alert.ts) reads this marker and reports a clean
   * `🛑 daemon shutdown` notification instead of a false `🚨 CRASH` alarm.
   * Without this, every `pm2 restart cortextos-daemon` (or `pm2 stop`)
   * generates a false crash alarm per agent — trust-destroying.
   *
   * Pattern matches src/cli/bus.ts:1283-1289 and PR #12 (BUG-036). Markers
   * are written synchronously before the async stop loop starts, so by the
   * time `pty.kill()` runs, every agent already has its marker on disk.
   */
  async stopAll(): Promise<void> {
    const names = [...this.agents.keys()];

    for (const name of names) {
      try {
        const stateDir = join(this.ctxRoot, 'state', name);
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(join(stateDir, '.daemon-stop'), 'daemon shutdown (SIGTERM)');
      } catch (err) {
        // Don't block shutdown on marker-write failure — worst case the user
        // gets a false crash alarm (the bug we're fixing), best case they get
        // the correct daemon-stop notification.
        console.error(`[agent-manager] Failed to write .daemon-stop marker for ${name}: ${err}`);
      }
    }

    for (const name of names) {
      try {
        await this.stopAgent(name);
      } catch (err) {
        console.error(`[agent-manager] Error stopping ${name}:`, err);
      }
    }
  }

  /**
   * Get status of all agents.
   */
  getAllStatuses(): AgentStatus[] {
    const statuses: AgentStatus[] = [];
    for (const [, entry] of this.agents) {
      statuses.push(entry.process.getStatus());
    }
    return statuses;
  }

  /**
   * Get status of a specific agent.
   */
  getAgentStatus(name: string): AgentStatus | null {
    const entry = this.agents.get(name);
    return entry ? entry.process.getStatus() : null;
  }

  /**
   * Get the FastChecker for an agent (for Telegram message routing).
   */
  getFastChecker(name: string): FastChecker | null {
    return this.agents.get(name)?.checker || null;
  }

  /**
   * Get all agent names.
   */
  getAgentNames(): string[] {
    return [...this.agents.keys()];
  }

  /**
   * Return the CronScheduler for a given agent (for testing / introspection).
   * Returns undefined if no scheduler is running for that agent.
   */
  getCronScheduler(agentName: string): CronScheduler | undefined {
    return this.cronSchedulers.get(agentName);
  }

  // --- Worker management ---

  /**
   * Spawn an ephemeral worker session for a parallelized task.
   */
  async spawnWorker(name: string, dir: string, prompt: string, parent?: string, model?: string): Promise<void> {
    if (this.workers.has(name)) {
      throw new Error(`Worker "${name}" is already running`);
    }
    if (this.agents.has(name)) {
      throw new Error(`"${name}" is already a registered agent name`);
    }

    const log = (msg: string) => console.log(`[worker:${name}] ${msg}`);
    const worker = new WorkerProcess(name, dir, parent, log);

    const env: CtxEnv = {
      instanceId: this.instanceId,
      ctxRoot: this.ctxRoot,
      frameworkRoot: this.frameworkRoot,
      agentName: name,
      agentDir: dir,
      org: this.org,
      projectRoot: this.frameworkRoot,
    };

    const config = model ? { model } : {};

    this.workers.set(name, worker);

    worker.onDone((workerName) => {
      // Auto-remove finished workers after a short delay so list-workers
      // can still show the final status briefly before cleanup
      setTimeout(() => {
        if (this.workers.get(workerName)?.isFinished()) {
          this.workers.delete(workerName);
        }
      }, 30_000); // keep for 30s after exit
    });

    await worker.spawn(env, prompt, config);
  }

  /**
   * Terminate a running worker session.
   */
  async terminateWorker(name: string): Promise<void> {
    const worker = this.workers.get(name);
    if (!worker) {
      throw new Error(`Worker "${name}" not found`);
    }
    await worker.terminate();
    this.workers.delete(name);
  }

  /**
   * Inject text into a running worker's PTY (nudge / stuck-state recovery).
   */
  injectWorker(name: string, text: string): boolean {
    const worker = this.workers.get(name);
    if (!worker) return false;
    return worker.inject(text);
  }

  /**
   * Inject text directly into a running agent's PTY.
   * Used by `cortextos bus test-cron-fire` to fire a cron immediately for testing.
   * Returns true if the agent is running and the inject succeeded; false otherwise.
   */
  injectAgent(agentName: string, text: string): boolean {
    return this.injectAgentDetailed(agentName, text).ok;
  }

  /**
   * Inject text into an agent's PTY with structured outcome — issue #346.
   *
   * Returns NOT_FOUND if the agent isn't in the registry, NOT_RUNNING if
   * registered but the PTY is gone, DEDUPED on a MessageDedup hash hit. The
   * boolean-returning `injectAgent()` is preserved for callers (cron
   * scheduler, fast-checker, fire-cron) that only need pass/fail.
   */
  injectAgentDetailed(agentName: string, text: string): { ok: true } | { ok: false; code: 'NOT_FOUND' | 'NOT_RUNNING' | 'DEDUPED'; message: string } {
    const entry = this.agents.get(agentName);
    if (!entry) {
      return { ok: false, code: 'NOT_FOUND', message: `agent "${agentName}" not in registry` };
    }
    return entry.process.injectMessageDetailed(text);
  }

  /**
   * Signal the CronScheduler for an agent to re-read crons.json.
   *
   * Called by the IPC server after a `bus add-cron` / `bus remove-cron` write so
   * the daemon-level scheduler picks up the new definition without waiting for
   * the next 30 s tick.  Returns true on a successful reload (or no-op for
   * Hermes agents, which manage their own crons natively); false if the agent
   * is not running at all.
   *
   * Iter 7 fix: previously this returned `true` for any registered agent even
   * when no scheduler existed in `cronSchedulers`, silently dropping reload
   * requests during the start-window gap between `this.agents.set(name, ...)`
   * and `startAgentCronScheduler(name)` (across the `await agentProcess.start()`
   * yield in `startAgent`). Now: for non-Hermes agents that lack a scheduler we
   * lazy-wire one so the just-written crons.json is read immediately.
   */
  reloadCrons(agentName: string): boolean {
    const scheduler = this.cronSchedulers.get(agentName);
    if (scheduler) {
      scheduler.reload();
      console.log(`[agent-manager] Cron scheduler reloaded for ${agentName}`);
      return true;
    }

    const entry = this.agents.get(agentName);
    if (!entry) return false;

    // Hermes manages its own crons natively — no daemon scheduler exists by
    // design. The reload IS a no-op; report success so the caller does not
    // retry forever.
    if (entry.process['config']?.runtime === 'hermes') {
      return true;
    }

    // Non-Hermes agent registered but no scheduler: this is the start-window
    // gap. Lazy-wire the scheduler now; its start() reads crons.json which
    // already contains the new entry the caller just wrote.
    this.startAgentCronScheduler(agentName);
    console.log(`[agent-manager] Cron scheduler lazy-created for ${agentName} (start-window reload)`);
    return this.cronSchedulers.has(agentName);
  }

  /**
   * Wire a daemon-level CronScheduler for the named agent.
   *
   * The scheduler reads `crons.json` (via `readCrons()`), computes fire times,
   * and on each tick injects the cron's prompt text directly into the agent PTY
   * via `injectAgent()`.  The fire callback builds the same injected text that
   * a Claude-Code `CronCreate` callback would emit so the agent's session sees
   * a normal-looking cron-fire message and handles it with existing skill code.
   *
   * Hermes agents manage their own cron system natively — skip them here.
   * If crons.json is absent or empty the scheduler starts but has nothing to do;
   * it will pick up new entries on the next `reloadCrons()` call.
   */
  private startAgentCronScheduler(agentName: string): void {
    // Skip if already running (idempotent — e.g. called twice on fast restart)
    if (this.cronSchedulers.has(agentName)) {
      console.log(`[agent-manager] Cron scheduler already running for ${agentName} — skipped`);
      return;
    }

    const entry = this.agents.get(agentName);
    if (!entry) return;

    // Hermes manages its own cron scheduling — don't double-schedule
    if (entry.process['config']?.runtime === 'hermes') {
      console.log(`[daemon] Skipping external cron scheduler for Hermes agent "${agentName}"`);
      return;
    }

    const onFire = async (cron: CronDefinition): Promise<void> => {
      const prompt = cron.prompt ?? `[cron] ${cron.name} fired`;
      // Salt with the fire timestamp so MessageDedup (which hashes the last 100
      // injects) does not reject identical cron prompts on subsequent fires.
      // Without the salt, every recurring cron after its first fire would be
      // dedup-rejected and treated as a dispatch failure.
      const firedAt = new Date().toISOString();
      const injection = `[CRON FIRED ${firedAt}] ${cron.name}: ${prompt}`;
      const injected = this.injectAgent(agentName, injection);
      if (!injected) {
        throw new Error(`injectAgent returned false for agent "${agentName}" — agent may not be running`);
      }
    };

    const scheduler = new CronScheduler({
      agentName,
      onFire,
      logger: (msg) => console.log(`[daemon] ${msg}`),
    });

    scheduler.start();
    this.cronSchedulers.set(agentName, scheduler);

    const count = scheduler.getNextFireTimes().length;
    console.log(`[daemon] Loaded ${count} external cron(s) for agent "${agentName}" from crons.json`);
  }

  /**
   * Get status of all workers (running + recently completed).
   */
  listWorkers(): WorkerStatus[] {
    return [...this.workers.values()].map(w => w.getStatus());
  }

  /**
   * Get status of a specific worker.
   */
  getWorkerStatus(name: string): WorkerStatus | null {
    return this.workers.get(name)?.getStatus() ?? null;
  }

  /**
   * Discover agents from the organization directory structure.
   *
   * BUG-043 fix: iterate over EVERY org under `frameworkRoot/orgs/*`,
   * not just `this.org`. Before this fix, a daemon started with
   * `CTX_ORG=testorg` would only discover agents in `orgs/testorg/agents/`
   * — agents in `orgs/lifeos/agents/` and `orgs/cointally/agents/` were
   * effectively invisible to the daemon and could never be auto-spawned
   * from a cold start. Multi-org installs silently half-worked.
   *
   * The returned tuple now includes an `org` field so `discoverAndStart()`
   * can pass the correct org to `startAgent()` and downstream path
   * lookups via `resolveAgentOrg()`.
   */
  private discoverAgents(): Array<{ name: string; dir: string; org: string; config: AgentConfig }> {
    const agents: Array<{ name: string; dir: string; org: string; config: AgentConfig }> = [];

    const orgsBase = join(this.frameworkRoot, 'orgs');
    if (!existsSync(orgsBase)) return agents;

    let orgNames: string[] = [];
    try {
      orgNames = readdirSync(orgsBase, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
    } catch {
      return agents; // unreadable orgs dir — treat as empty
    }

    for (const org of orgNames) {
      const agentsBase = join(orgsBase, org, 'agents');
      if (!existsSync(agentsBase)) continue;

      try {
        const dirs = readdirSync(agentsBase, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => d.name);

        for (const name of dirs) {
          const dir = join(agentsBase, name);
          const config = this.loadAgentConfig(dir);
          agents.push({ name, dir, org, config });
        }
      } catch {
        // Ignore read errors for this org — continue scanning others
      }
    }

    return agents;
  }

  /**
   * Load agent config from config.json.
   *
   * On parse error: log a clear, operator-actionable error to stderr (file path,
   * SyntaxError message, and a 1-line offending-snippet hint when locatable) and
   * fall back to default config so the daemon does not hard-crash. Without this
   * surfacing, a trailing comma in config.json silently degrades the agent into
   * a "model not available" state because the model field is missing — see #345.
   */
  private loadAgentConfig(agentDir: string): AgentConfig {
    const configPath = join(agentDir, 'config.json');
    if (!existsSync(configPath)) return {};
    let raw: string;
    try {
      raw = readFileSync(configPath, 'utf-8');
    } catch (err) {
      console.error(`[agent-manager] config read failed: ${configPath}: ${(err as Error).message}`);
      return {};
    }
    try {
      return JSON.parse(raw);
    } catch (err) {
      const msg = (err as SyntaxError).message;
      // Best-effort line/column extraction from V8 SyntaxError messages.
      // V8 emits "Unexpected token ... in JSON at position N" — we resolve
      // N back to a 1-indexed line/column so operators can jump to the offender.
      const posMatch = /position (\d+)/.exec(msg);
      let locHint = '';
      if (posMatch) {
        const pos = Math.min(Number(posMatch[1]), raw.length);
        const before = raw.slice(0, pos);
        const line = before.split('\n').length;
        const col = pos - (before.lastIndexOf('\n') + 1) + 1;
        const offendingLine = raw.split('\n')[line - 1] || '';
        locHint = ` (line ${line}, col ${col}: \`${offendingLine.trim().slice(0, 80)}\`)`;
      }
      console.error(`[agent-manager] config.json invalid JSON: ${configPath}${locHint}: ${msg}`);
      console.error(`[agent-manager] hint: trailing commas, unquoted keys, and single quotes are common causes`);
      return {};
    }
  }
}

/**
 * Derive a human-readable reply context string from a Telegram replied-to message.
 *
 * Priority: text > caption > media type label.
 * This is exported for unit testing; call sites use it via the message handler.
 *
 * Before this fix (BUG: reply context lost for media messages): only `.text` was
 * checked, so replies to videos/photos/voice arrived as bare text with no
 * indication of what was being replied to (e.g. "This one" with zero context).
 */
export function buildReplyContext(
  replyMsg: TelegramMessage | undefined,
): string | undefined {
  if (!replyMsg) return undefined;
  if (replyMsg.text) return stripControlChars(replyMsg.text);
  if (replyMsg.caption) return stripControlChars(replyMsg.caption);
  if (replyMsg.video) return '[video]';
  if (replyMsg.video_note) return '[video note]';
  if (replyMsg.photo) return '[photo]';
  if (replyMsg.voice) return '[voice message]';
  if (replyMsg.audio) return '[audio]';
  if (replyMsg.document) return `[document: ${replyMsg.document.file_name ?? 'file'}]`;
  return undefined;
}
