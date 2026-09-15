# Slack adapter setup (per-agent routing)

Operational runbook for this Slack stack: per-agent Socket Mode listeners with
durable-inbox delivery and a fail-closed route gate. Builds on the setup runbook
from the original Socket Mode adapter (#906).

## 1. Slack app prerequisites (ONE APP PER AGENT)

Create **one Slack app for each agent** — never one shared app. Slack
distributes an app's event envelopes across that app's open Socket Mode
connections (each event reaches ONE connection), so two agents on a shared app
would each receive a random subset of messages: silent loss, not fan-out. N:1
works because each agent's own app gets its own full copy of a channel's
events. The daemon detects two agents using the same app token and warns
loudly, but the fix is always per-agent apps.

For each agent's app:

1. Create a Slack app with **Socket Mode** enabled.
2. Event subscriptions: `message.channels` (+ `message.groups` for private
   channels).
3. Bot token scopes: `chat:write`, `channels:read`, `channels:history`,
   `groups:read`, `groups:history`, `users:read`, plus `chat:write.customize`
   ONLY if the persona review has cleared custom display identity (see §5).
4. Install the app; invite this agent's bot to every channel the agent should
   read (each agent that should see a shared channel gets its own bot invited).

## 2. Per-agent tokens (`agents/<name>/.env` — secrets live here, never in slack.json)

```
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...   # inbound Socket Mode; omit for outbound-only
```

Add the channel this agent listens on:

```bash
SLACK_CHANNEL=C0123456789   # channel id the agent watches (inbound)
```

Missing tokens leave Slack inbound inactive for that agent; other transports
continue.

**Node < 22:** native `WebSocket` is unavailable, so Socket Mode cannot run and
Slack inbound stays inactive for the agent — a clear log line says so, and there
is no silent no-inbound state. Upgrade to Node 22+ to use Slack inbound.

### What activates inbound

Slack inbound starts for an agent when its `.env` provides `SLACK_APP_TOKEN`,
`SLACK_BOT_TOKEN`, and `SLACK_CHANNEL` (and native `WebSocket` is available).
Activation is by deliberate `.env` configuration — the tokens and channel are an
explicit per-agent opt-in.

Adding a `slack.json` (next section) is optional and layers the fail-closed route
gate on top of the single-channel default; the route gate is what makes
misconfiguration deny rather than fail open.

- `SLACK_CHANNEL` is the primary channel. Under routing it must also appear in
  `allowed_channels`, or the route gate denies it.
- `interval_ms` is the poll cadence (ignored while Socket Mode is active).

### Node < 22

Socket Mode needs native `WebSocket` (Node 22+). On older Node the listener is
skipped and Slack inbound stays inactive for the agent — a clear log line says
so, never a silent no-inbound state. Upgrade Node to use Slack inbound.

## 3. Per-agent routing (`agents/<name>/slack.json` — non-secret)

```json
{
  "display_name": "sample-agent",
  "allowed_channels": ["C0123456789", "C0987654321"],
  "allowed_users": ["T0AAAAAA:U0BBBBBB"]
}
```

- `allowed_channels`: channels this agent RECEIVES from. The listener watches
  all of them. **Empty or absent denies all inbound** (fail-closed).
- `allowed_users`: `"<team_id>:<user_id>"` composite senders. Channel
  membership alone is never authority — both gates must pass. Find ids with
  `cortextos bus slack-discover-channels` and the sender's Slack profile.
- **No `slack.json` at all = legacy mode**: the agent keeps its `.env`-driven
  single-channel behavior exactly. Routing is opt-in per agent.
- A malformed `slack.json` is logged loudly at agent start and routing is
  DISABLED for that agent (legacy mode) until fixed — check the daemon log if
  routing seems inert.
- N:1 is supported: several agents may list the same channel; each receives
  its own inbox copy and acks independently. This works through the per-agent
  apps from §1 — each agent's own app receives its own copy of the channel's
  events. Agents sharing one app token would SPLIT events instead (see §1).

Config changes are **restart-to-apply** (shared connections are rebuilt at
agent start; hot reload is not a tested path).

## 4. Verify

```
cortextos bus slack-discover-channels        # bot-member channels + ids
cortextos bus slack-test-send C0123456789    # posts and reports the outcome
```

`slack-test-send` exits nonzero with Slack's reason on failure — a failing
test is the answer, not a soft skip.

## 5. Display identity — PERSONA GATE (enforced, not advisory)

`display_name` / `icon_emoji` / `icon_url` change how a member-visible message
is attributed, and the daemon ENFORCES the gate on the send path:

- Every agent posts under its plain functional name — taken from the
  daemon-provisioned agent context (`CTX_AGENT_NAME`) at process start, not
  from any config or caller input. Setting `display_name` to anything else is
  loudly suppressed at send time and the functional name is sent instead —
  the custom value never reaches Slack.
- `icon_emoji` / `icon_url` are never sent (no icon values are
  persona-review approved yet); their presence is loudly logged.
- Custom display names/icons are persona/brand surface and require the
  brand-persona review — the same review that owns voice personas. Admitting
  an approved value is a code change to the gate, not a config edit.

## 6. Troubleshooting

- **No inbound and no Slack lines in the log at all**: the agent's `.env` is
  missing `SLACK_APP_TOKEN` or `SLACK_CHANNEL` (see §2), or Node is < 22 so
  Socket Mode cannot run — tokens plus a channel on Node 22+ are what start the
  listener.
- **No inbound**: check the daemon log for the route-gate DENIED lines (they
  name the reason: `no-config`, `channel-not-allowed`, `user-not-allowed`) and
  for the malformed-slack.json warning. Fail-closed means misconfig looks like
  silence — the log always says why.
- **Auth dead**: a permanent auth failure alerts three ways (daemon log,
  urgent agent inbox, operator Telegram) and does NOT self-heal — fix the
  token and restart the agent.
- **Duplicate deliveries**: socket redeliveries are collapsed per
  (event, agent) in a bounded window; a duplicate that still lands after a
  window eviction is expected-rare and harmless (agents dedup at read time).
