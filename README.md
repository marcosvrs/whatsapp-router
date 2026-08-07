# whatsapp-router

Bridges WhatsApp — received via a self-hosted [WAHA](https://waha.devlike.pro/)
(WhatsApp HTTP API) instance — to an [opencode](https://opencode.ai/) AI agent
session, one per sender:

| Message | Routed to |
|---|---|
| `/new [message]` | Resets the sender's conversation with the agent, optionally starting a new one immediately |
| anything else | The opencode agent session (identifies itself as "Sisyphus" — see below) — WhatsApp's own typing indicator shows while it's working, then the real reply is sent once, no placeholder |

Home Assistant and Firefly III control both live inside opencode itself now
(via its own tools/MCP servers), not as prefix routes here — this service's
only job is getting the message to the agent and the reply back to WhatsApp.

Every inbound message gets a WhatsApp read receipt, and a typing indicator
shows while the agent is working.

Works in a 1:1 chat with the bot, or in any group it's added to — as long as
the sender is allowlisted and @-mentions the bot. Images and documents are
downloaded and forwarded to the opencode agent as an attachment (alongside
any caption text as the message); a shared location is described in words
instead (no attachment to forward). WhatsApp contact cards (vCards) aren't
handled — parsing them into something worth passing to the agent was judged
not worth the complexity for now.

The agent gets more than just the message text: every call includes a
`system` context (kept separate from the SDK's own agent system prompt, and
from the user's message) telling it that it's being reached over WhatsApp,
the sender's WhatsApp display name and phone number, whether it's a 1:1 or
group chat (and the group's name, if any), the message's timestamp, the text
of whatever message it's replying to, and any shared location — everything
WAHA exposes about the message that's actually worth telling the agent,
without dumping raw payload noise into its context. One thing this context
deliberately does *not* try to do: rename the agent. It identifies itself as
"Sisyphus" (its identity comes from the opencode server's own
[`oh-my-openagent`](https://github.com/code-yeongyu/oh-my-openagent) plugin
config, hardcoded with an explicit instruction to reject any other name) —
that's true everywhere it's reached, WhatsApp included, and isn't something
this repo can or should override.

For group messages, the context also includes recent chatter since the bot's
last mention — each opencode session belongs to one sender, so without this
the agent would only ever see what the person talking to it personally typed,
missing everything anyone else in the group said. Bounded by both a message
count and a character budget, and trimmed to stop at (not including) the
previous time the bot was mentioned, so nothing already answered gets resent.
Up to two of the most recent images/documents in that window are forwarded
as real attachments, not just described in text.

The agent's reply comes back as standard Markdown, but WhatsApp renders its
own smaller formatting syntax (single `*bold*`, `_italic_`, `~strike~`,
triple-backtick monospace only). Replies are converted before sending —
see `markdownToWhatsapp.ts`.

## Why this exists

WAHA is purely a WhatsApp transport layer (send/receive, sessions, media) —
it has no concept of maintaining a conversation per sender or an allowlist,
and opencode has no concept of WhatsApp. This service is the glue between
them, kept intentionally small: a single Node HTTP server, no web framework.
The only production dependency is
[`@opencode-ai/sdk`](https://www.npmjs.com/package/@opencode-ai/sdk), the
official client for the opencode agent — WAHA's own REST API is called
directly via native `fetch`.

## Requirements

- A running WAHA instance with a session already linked to a WhatsApp number
- Node.js 22.16+ (only for local development — the Docker image bundles everything)

## Setup

1. Copy `.env.example` to `.env` and fill in the required values (`WAHA_API_KEY`,
   `WEBHOOK_SECRET`, `WHATSAPP_ALLOWED_USERS`). The opencode section is
   optional — leave it empty and the agent replies with a "not configured
   yet" message instead of erroring.

2. Point WAHA's session webhook at this service, signed with the same secret:

   ```json
   PUT /api/sessions/{session}
   {
     "config": {
       "webhooks": [
         {
           "url": "http://whatsapp-router:8080/webhook",
           "events": ["message"],
           "hmac": { "key": "<WEBHOOK_SECRET>" }
         }
       ]
     }
   }
   ```

3. Run it:

   ```sh
   docker build -t whatsapp-router .
   docker run --env-file .env -p 8080:8080 -v "$(pwd)/state:/app/state" whatsapp-router
   ```

## Development

```sh
npm install
git config core.hooksPath .githooks   # one-time — see below
npm run typecheck    # tsc --noEmit
npm run lint         # eslint (strict + type-checked)
npm test             # vitest
npm run test:coverage
npm run test:mutation  # StrykerJS
npm run build         # tsc -> dist/
```

**Supply-chain hardening** (`.npmrc`): `ignore-scripts=true` — no package's
install/postinstall script ever runs automatically. `save-exact=true` — any
dependency added or bumped from now on is pinned to an exact version rather
than a range. `package-lock.json` is committed either way, so builds
(`npm ci`) are always reproducible regardless. New dependencies are only
added once their version has been out long enough to have surfaced any
compromise (checked via `npm view <pkg> time`).

**Git hooks** (`.githooks/`, native `core.hooksPath` — no dependency): `pre-commit`
lints staged `.ts` files. `pre-push` scans the full commit history for secrets
with [gitleaks](https://github.com/gitleaks/gitleaks) (fast enough that scoping
it wouldn't help, and it needs full history anyway to be meaningful), then
typecheck + tests + mutation testing — scoped to changed code wherever that's
actually safe:
- **Typecheck** stays whole-program (a change to a shared type can break
  correctness elsewhere without touching that file's text — TS checking is
  inherently holistic), but `tsconfig.json` has `incremental: true` to cache
  unchanged files' analysis instead.
- **Tests**: `vitest run --changed origin/main` — only runs tests affected by
  the diff (via import-graph analysis), not the full suite.
- **Mutation testing**: `stryker run --incremental` — persists results
  (`reports/stryker-incremental.json`, gitignored) and only re-mutates/re-tests
  what could have changed status since the last run.

CI (`npm run typecheck` / `lint` / `test:coverage` / `test:mutation`) always
runs the full, unscoped versions — the hooks trade some rigor for speed on
your own machine; CI is the actual safety net.

Requires the one-time `git config` above (per clone — it's a local setting,
not something a repo can force on a contributor).

## Architecture

```
src/
  config.ts              env var loading
  security.ts             webhook HMAC verification
  rateLimit.ts, dedupe.ts, senderLock.ts, sessionStore.ts
  waha/
    client.ts              WAHA REST API wrapper — send/react/edit/typing/read-receipts/media/
                            fetchRecentMessages (chat history)
    payload.ts              parsing WAHA's raw webhook + chat-history payloads (mentions, media,
                            location, push name, dedupe key, recent-group-history trimming/
                            formatting/media selection)
    identity.ts              @lid <-> phone resolution, bot's own id, group names
                            (for mention detection and agent context)
  integrations/
    opencode.ts             wraps @opencode-ai/sdk; send() takes optional
                            media (array) + a system-context string
  allowlist.ts             who's allowed to trigger the bot, and from where
  markdownToWhatsapp.ts    converts the agent's Markdown reply to WhatsApp's
                            own formatting syntax
  router.ts                 "/new" vs. everything else -> the agent; returns the
                            reply text directly; builds the agent's system context
                            from an AgentContext (who/where/when/recent group history);
                            converts the agent's reply via markdownToWhatsapp before returning it
  server.ts                 HTTP wiring: auth, size limits, dedupe, rate limit,
                            typing indicator, read receipts, media download,
                            agent-context extraction, recent-group-history fetch (groups only)
  index.ts                  composition root
```

Each class takes its dependencies as constructor arguments — no DI framework,
no global state — which is what makes the whole thing unit-testable without
a running WAHA or opencode instance in the loop.

## Known limitations

- Mention detection recognizes plain-text messages
  (`extendedTextMessage.contextInfo.mentionedJid`) and image/document/video
  captions (`imageMessage`/`documentMessage`/`videoMessage.contextInfo.mentionedJid`)
  — both confirmed against live WAHA payloads (pulled from real group message
  history via WAHA's REST API). A mention inside a reply uses a different
  message shape and isn't handled at all — left alone rather than guessed at.
- Location messages (`WahaLocation`, `latitude`/`longitude`/`title`) mirror
  WAHA's documented *send*-location request shape — the receive side isn't
  independently confirmed against a live payload either.
- Contact cards (vCards) aren't parsed or forwarded at all; a shared contact
  is silently ignored.

## License

MIT
