import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { TelegramUpdate, TelegramMessage, TelegramCallbackQuery, TelegramMessageReaction } from '../types/index.js';
import { TelegramAPI } from './api.js';
import { ensureDir, atomicWriteSync } from '../utils/atomic.js';

export type MessageHandler = (msg: TelegramMessage) => void;
export type CallbackHandler = (query: TelegramCallbackQuery) => void;
export type ReactionHandler = (reaction: TelegramMessageReaction) => void;

/**
 * Telegram polling loop. Replaces the Telegram portion of fast-checker.sh.
 * Polls getUpdates every 1 second and routes messages/callbacks to handlers.
 */
export class TelegramPoller {
  private api: TelegramAPI;
  private offset: number = 0;
  private running: boolean = false;
  private stateDir: string;
  private offsetFileName: string;
  private messageHandlers: MessageHandler[] = [];
  private callbackHandlers: CallbackHandler[] = [];
  private reactionHandlers: ReactionHandler[] = [];
  private pollInterval: number;
  /**
   * Why the poll loop last exited. Read by AgentManager's poller-supervisor
   * (#459 supervision-gap fix) to decide whether to restart:
   *   - 'stopped-externally': intentional stop() (stopAgent) — do NOT restart.
   *   - 'conflict-self-die': a Telegram 409 Conflict (another getUpdates
   *     holder owns the lock, e.g. a not-yet-released connection after a
   *     daemon crash) — the loop exits so the supervisor can sleep 30s and
   *     retake the lock instead of hot-looping on Conflict.
   *   - '' : loop still running / never exited.
   */
  lastExitReason: string = '';

  /**
   * D0 liveness facts (PLAN-v3 §4b). `lastSuccessfulPollAt` advances on EVERY
   * successful getUpdates including an empty batch — it is the only proof the
   * loop is alive when the offset has run past every real update_id (getUpdates
   * then returns empty forever). `lastUpdateReceivedAt` advances only when
   * updates arrive; zero updates is legitimate for an idle agent, so the PAIR
   * distinguishes polling from receiving. Both are epoch-ms, 0 = never.
   */
  lastSuccessfulPollAt: number = 0;
  lastUpdateReceivedAt: number = 0;

  /**
   * @param api Telegram API client scoped to a single bot token.
   * @param stateDir Directory for persisted poller state (offset, dedup).
   * @param pollInterval Milliseconds between getUpdates calls.
   * @param offsetFileSuffix Optional distinct suffix for the offset file.
   *   When omitted (default), offset persists to `.telegram-offset`. When
   *   provided, offset persists to `.telegram-offset-<suffix>`. Use this
   *   when running a second poller in the same stateDir against a
   *   different bot token (e.g. an activity-channel bot alongside the
   *   agent's own bot), so the two pollers do not clobber each other's
   *   offsets. Without this, two pollers sharing a stateDir would both
   *   write to `.telegram-offset` and lose track of which bot each
   *   offset belonged to.
   */
  constructor(api: TelegramAPI, stateDir: string, pollInterval: number = 1000, offsetFileSuffix?: string) {
    this.api = api;
    this.stateDir = stateDir;
    this.pollInterval = pollInterval;
    this.offsetFileName = offsetFileSuffix
      ? `.telegram-offset-${offsetFileSuffix}`
      : '.telegram-offset';
    this.loadOffset();
  }

  /**
   * Register a handler for incoming messages.
   */
  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  /**
   * Register a handler for callback queries.
   */
  onCallback(handler: CallbackHandler): void {
    this.callbackHandlers.push(handler);
  }

  /**
   * Register a handler for message_reaction updates. These fire when a
   * user adds or removes an emoji reaction on a chat message the bot can
   * see. Requires the bot's getUpdates call to include `message_reaction`
   * in allowed_updates (handled by TelegramAPI.getUpdates).
   */
  onReaction(handler: ReactionHandler): void {
    this.reactionHandlers.push(handler);
  }

  /**
   * Start the polling loop.
   */
  async start(): Promise<void> {
    this.running = true;
    this.lastExitReason = '';
    while (this.running) {
      try {
        await this.pollOnce();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // A 409 Conflict means another getUpdates connection holds the lock
        // (e.g. a not-yet-released connection lingering ~60s after a daemon
        // crash). Exit the loop with a distinct reason so the supervisor can
        // sleep and retake the lock, rather than hot-looping on Conflict.
        if (/Conflict/i.test(msg)) {
          this.lastExitReason = 'conflict-self-die';
          this.running = false;
          return;
        }
        // Other errors are transient — log and continue polling.
        console.error('[telegram-poller] Poll error:', err);
      }
      await sleep(this.pollInterval);
    }
  }

  /**
   * Stop the polling loop. Marks the exit as intentional so the supervisor
   * does not restart it.
   */
  stop(): void {
    this.running = false;
    this.lastExitReason = 'stopped-externally';
  }

  /**
   * Perform a single poll cycle.
   *
   * Offset-after-handler semantics: the offset only advances after every
   * registered handler for an update returns successfully. If any handler
   * throws, the update is left un-acknowledged (Telegram will re-deliver it
   * on the next `getUpdates` call) and the remainder of the batch is deferred
   * to preserve ordering. The offset is persisted after each successful
   * update so a crash mid-batch does not drop confirmed state.
   */
  async pollOnce(): Promise<void> {
    const result = await this.api.getUpdates(this.offset, 1);
    // getUpdates returned without throwing = the loop is ALIVE, even on an empty
    // batch. Record it BEFORE the early return, or an idle/killer-offset agent
    // looks identical to a dead one (the whole D0 gap).
    this.lastSuccessfulPollAt = Date.now();
    if (!result?.result?.length) return;
    this.lastUpdateReceivedAt = Date.now();

    for (const update of result.result as TelegramUpdate[]) {
      const nextOffset = update.update_id + 1;
      let handlerFailed = false;

      if (update.message) {
        for (const handler of this.messageHandlers) {
          try {
            handler(update.message);
          } catch (err) {
            console.error('[telegram-poller] Message handler error:', err);
            handlerFailed = true;
            break;
          }
        }
      }

      if (!handlerFailed && update.callback_query) {
        for (const handler of this.callbackHandlers) {
          try {
            handler(update.callback_query);
          } catch (err) {
            console.error('[telegram-poller] Callback handler error:', err);
            handlerFailed = true;
            break;
          }
        }
      }

      if (!handlerFailed && update.message_reaction) {
        for (const handler of this.reactionHandlers) {
          try {
            handler(update.message_reaction);
          } catch (err) {
            console.error('[telegram-poller] Reaction handler error:', err);
            handlerFailed = true;
            break;
          }
        }
      }

      if (handlerFailed) {
        // Do not advance offset — the update will be redelivered.
        // Stop processing the rest of this batch to preserve ordering.
        return;
      }

      this.offset = nextOffset;
      this.saveOffset();
    }
  }

  /**
   * Load persisted offset from state file.
   */
  private loadOffset(): void {
    // D0 (PLAN-v3 §4b): the offset is bound to the bot identity. An offset that
    // does not belong to the current bot (token rotation, stateDir clobber, a
    // legacy provenance-less file) is DISCARDED — otherwise getUpdates can
    // return empty forever while every liveness layer reads green. Parsing is
    // strict: a whole non-negative integer only. `this.offset` defaults to 0, so
    // every reject path simply leaves it there.
    const offsetFile = join(this.stateDir, this.offsetFileName);
    try {
      if (!existsSync(offsetFile)) return;
      const content = readFileSync(offsetFile, 'utf-8').trim();
      if (!content) return;

      let parsed: any;
      try {
        parsed = JSON.parse(content);
      } catch {
        parsed = undefined;
      }

      // New bound format: { botId, offset }.
      if (parsed && typeof parsed === 'object' && 'botId' in parsed && 'offset' in parsed) {
        if (parsed.botId !== this.api.botId) {
          console.warn(
            `[telegram-poller] offset botId ${parsed.botId} != current bot ${this.api.botId} — discarding, reset to 0`,
          );
          return; // provenance mismatch: discard
        }
        const off = parsed.offset;
        if (typeof off === 'number' && Number.isInteger(off) && off >= 0) {
          this.offset = off;
        }
        return; // matching record; invalid offset already left at 0
      }

      // Legacy bare-integer file (or garbage). No botId => no provenance =>
      // unknown => discard to 0. Log the legacy case so a first-deploy re-read
      // is a recorded expected event, not a mystery (solo, decision A).
      if (/^\d+$/.test(content)) {
        console.warn(`[telegram-poller] legacy offset ${content} discarded, no botId, reset to 0`);
      }
    } catch {
      // Any read/parse failure: stay at 0.
    }
  }

  /**
   * Save current offset to state file.
   */
  private saveOffset(): void {
    ensureDir(this.stateDir);
    const offsetFile = join(this.stateDir, this.offsetFileName);
    try {
      // Bound + atomic (PLAN-v3 §4b): stamp the botId so a later load can verify
      // provenance, and use atomicWriteSync so a torn write can't corrupt the
      // offset into a negative (which Telegram reads with special meaning).
      atomicWriteSync(offsetFile, JSON.stringify({ botId: this.api.botId, offset: this.offset }));
    } catch {
      // Ignore write errors
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * D0 staleness decision (PLAN-v3 §4b) — PURE. The poll loop is stuck if no
 * successful getUpdates has landed within `thresholdMs`. A healthy loop records
 * `lastSuccessfulPollAt` every ~2s (getUpdates long-poll ≤1s + 1s sleep), so a
 * threshold well above that (e.g. 60s) means the loop is genuinely wedged, not
 * merely between cycles. `lastSuccessfulPollAt === 0` (never polled) is stale
 * once enough time has passed for at least one poll to have been expected.
 */
export function pollerIsStale(lastSuccessfulPollAt: number, now: number, thresholdMs: number): boolean {
  return now - lastSuccessfulPollAt > thresholdMs;
}
