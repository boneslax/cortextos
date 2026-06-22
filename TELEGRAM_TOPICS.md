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

---

# v2 — One Group Per Agent (per-agent-group mode)

v1 above puts the whole fleet in ONE group (topic per agent, one shared bot, the
orchestrator polls). **v2** generalizes it to Bones's settled model:

- **Solo DM stays exactly as-is** (the orchestrator / command line). Never moves.
- **One Telegram group per agent** = that agent's workspace.
- **Topics inside an agent's group = that agent's projects** (Dev group → a topic
  per app; Sales group → a topic per deal).
- **Each agent owns + polls its own group**, via **its own bot** (bot-per-agent).

## How it works (v2)
- Each agent's `.env`: its own `BOT_TOKEN` (a distinct BotFather bot), its group's
  negative `CHAT_ID`, `ALLOWED_USER`, and `TOPIC_ID` = its **default/standup
  topic** (where proactive sends + permission/plan/ask prompts land). Polling on.
- `config.json` `project_topics`: `{ "<topicId>": "<project label>", ... }` — every
  project topic in the agent's group. This registers each topic to the agent (so
  its own callbacks resolve to self, never dropped) and labels inbound messages
  `[project: <label>]`.
- Inbound message in topic X → injected to the agent with the project label; the
  agent replies with `--thread X` (round-trips into the same topic). Proactive /
  cron / status sends → the default `TOPIC_ID` topic.
- Per-(chat,topic) last-sent + recent-history keep each project's conversation
  isolated. The orchestrator's solo DM is byte-identical to today.

## Bot model
**One bot per agent.** Telegram allows one `getUpdates` holder per token, and each
agent runs its own poller, so each needs its own token. Trade-off vs a shared bot
with a central router: per-agent bots reuse the existing per-agent poller (zero new
infra) and isolate blast radius; cost is N BotFather bots + N tokens.

## Migration runbook (Bones, per agent — bots can't create groups)
For EACH agent in the cabinet:
1. **Create a bot** in @BotFather (one per agent); copy its token.
2. **Create a forum supergroup** for the agent → enable **Topics**.
3. **Add that agent's bot** to its group (member + send). **Disable BotFather
   privacy** for the bot (`/setprivacy` → Disable) — mandatory.
4. Create one topic per project; capture each `topic_id` (link trailing number =
   message_thread_id). Pick one as the **default/standup** topic.
5. Capture the group's negative `CHAT_ID`.
6. Wire the agent's `.env`: its `BOT_TOKEN`, `CHAT_ID=<neg group>`,
   `ALLOWED_USER=<Bones id>`, `TOPIC_ID=<default topic>`, polling on. Set
   `config.json.project_topics` = every `(topicId → label)`.
7. **Never enable a specialist's polling while it still shares the v1 bot token** —
   N pollers on one token 409-conflict. Each agent needs its OWN token first.
8. Validate the group `CHAT_ID` with that agent's bot, restart the daemon, run the
   smoke checklist.
The orchestrator's DM `.env` is untouched.

## Manual smoke checklist (v2, per agent — live)
- [ ] A message in agent A's group reaches A (not any other agent / the orchestrator).
- [ ] A message in topic X carries `[project: <label>]` and the reply round-trips into topic X.
- [ ] A permission/ask button in the agent's group unblocks THAT agent (response file in its state dir), never another agent.
- [ ] Creating a topic injects no blank message; a foreign chat doesn't route.
- [ ] Two project topics in one group don't bleed each other's history/last-sent.
- [ ] Proactive/cron sends land in the default topic, not an arbitrary one.
- [ ] Solo DM still works exactly as before.

## Coverage boundary (honest)
Unit + Codex 3-round + GLM gate the code: registry per-topic registration,
thread-aware state isolation, project labelling, callback fail-safe (reused from
v1), DM/v1 byte-compat. **Live per-agent-group routing — each agent polling its own
real group, callbacks, the service-message filter — is NOT auto-tested** (needs N
real forum groups + N bots + Bones's Telegram). Covered by the checklist above,
pending the groups Bones provisions; driven with Bones after provisioning.

## Known boundaries (v2)
- Interactive hook prompts (permission/plan/ask) land in the agent's **default**
  topic, not necessarily the originating project topic — carrying the live inbound
  topic into a separate hook process is deferred. Inbound *replies* DO thread the
  originating topic.
- Media messages in a project topic are not yet labelled `[project:]` (text is);
  minor, deferred.
- Reactions self-route to the group-owning agent (no per-topic reaction routing) —
  acceptable: a reaction is a no-action notification.
- Dynamic project-topic add needs a daemon reload (registry is built at start /
  agent-start); no runtime add yet.
