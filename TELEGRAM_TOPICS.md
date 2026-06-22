# Telegram Forum Topics (per-agent threads)

Run the whole agent fleet through **one Telegram forum supergroup with one
topic per agent** instead of separate 1:1 DMs — a single notification surface,
one bot, but each agent has its own thread. Backward compatible: with no topic
configured, an agent behaves exactly as before (plain DM / General).

## How it works

- **One shared bot** lives in the forum supergroup. Every agent's outbound uses
  the shared `BOT_TOKEN` + the group's negative `CHAT_ID` + that agent's own
  `TOPIC_ID`.
- **Only the orchestrator polls** `getUpdates` (others set `telegram_polling:
  false`). On each inbound update the orchestrator resolves the topic owner from
  a `(chatId, topicId) -> agent` registry and injects the message into that
  agent — or handles it itself when there is no thread (the General topic).
- **Replies round-trip**: the injected reply instruction carries
  `--thread <id>`, so an agent's reply lands back in its own topic.
- **Callbacks** (approval / permission / plan / AskUserQuestion buttons) route to
  the agent that posted the prompt, by topic thread with a pending-callback
  index fallback. Fail-safe: an unresolved callback is never dispatched to a
  guessed agent.

## Config

Single source of truth is the agent `.env`:

```
BOT_TOKEN=<the one group bot token>     # same for every agent in the group
CHAT_ID=-1001234567890                  # the negative forum supergroup id
ALLOWED_USER=<your numeric Telegram user id>
TOPIC_ID=11                             # this agent's forum topic (omit for the orchestrator)
```

Set `telegram_polling: false` in every specialist agent's `config.json`; leave
it on for the orchestrator (the sole poller). The orchestrator has **no**
`TOPIC_ID` — it owns the General topic (the no-thread default). No two agents
may share a `TOPIC_ID` in the same chat (the daemon fails that closed at start).

## Migration runbook (one-time, manual)

1. Create a Telegram group → promote to **supergroup** → enable **Topics**
   (forum mode).
2. Add the group bot as a **member with send permission**. (Manage Topics is
   only needed to *create/close* topics, not to post into existing ones — you
   create the topics yourself in step 5, so it's optional.)
3. **Disable BotFather privacy mode** (`/setprivacy` → Disable). Mandatory —
   otherwise the bot only receives commands and replies, not all topic messages.
4. *(optional)* Confirm `getChat` reports `is_forum: true`.
5. Create one topic per specialist agent. Capture each `topic_id` = the topic
   link's trailing number (= the topic root `message_id` = `message_thread_id`),
   or post in the topic and read `result[-1].message.message_thread_id` from
   `getUpdates`.
6. **Verify receipt before configuring**: post a test message in each topic and
   confirm the bot received it via `getUpdates` (proves privacy is off and the
   bot is present).
7. Capture the negative group `CHAT_ID` (`-100…`).
8. Write each agent's `.env` (above). Restart the daemon.
9. Run the smoke checklist below.

## Manual smoke checklist (live forum group)

Inbound topic routing, callbacks, and the service-message filter require a real
forum supergroup + the bot + your Telegram account, so they are verified by hand
against a **throwaway** group (never the live DM):

- [ ] An agent with `TOPIC_ID` posts a message that lands in its topic (not General).
- [ ] A reply you send inside topic X reaches agent X (that agent acts on it), not the orchestrator.
- [ ] An agent with no `TOPIC_ID` still works as a plain DM / General post.
- [ ] A permission/plan/AskUserQuestion prompt from agent X appears in X's topic, and tapping a button unblocks **X** (check `state/<X>/hook-response-*.json`), not the orchestrator.
- [ ] Creating a new topic (a forum service message) does **not** inject a blank prompt into any agent.
- [ ] A message from an unrelated chat does not route on a matching topic id.

## Coverage boundary (honest)

Unit + typecheck + Codex review cover the outbound API threading, the CLI
`--thread`, the topic registry / `resolveTopicOwner` (mapped, unmapped,
foreign-chat, duplicate-fail-closed), the pending-callback index, and the reply
formatters. **Live inbound topic routing, callback unblocking, and the
service-message filter are NOT auto-tested** — they need the live forum group
above and are covered by the manual smoke checklist, pending the throwaway-group
run.
