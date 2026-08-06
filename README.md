# whatsapp-router

Routes WhatsApp messages — received via a self-hosted [WAHA](https://waha.devlike.pro/)
(WhatsApp HTTP API) instance — to one of three integrations, based on a text
prefix:

| Message | Routed to |
|---|---|
| `/new [message]` | Resets the sender's conversation with the agent, optionally starting a new one immediately |
| `ha: <text>` | A configured [Home Assistant](https://www.home-assistant.io/) webhook |
| `money: <amount> <description>` | A [Firefly III](https://www.firefly-iii.org/) withdrawal transaction |
| anything else | An [opencode](https://opencode.ai/) agent session (one persistent session per sender) |

Works in a 1:1 chat with the bot, or in any group it's added to — as long as
the sender is allowlisted and @-mentions the bot.

## Why this exists

WAHA is purely a WhatsApp transport layer (send/receive, sessions, media) —
it has no concept of routing a message to an arbitrary set of internal APIs,
maintaining a conversation per sender, or an allowlist. This service is that
glue, kept intentionally small: a single Node HTTP server, one dependency-free
runtime (no framework), plain constructor-injected classes per integration.

## Requirements

- A running WAHA instance with a session already linked to a WhatsApp number
- Node.js 22.16+ (only for local development — the Docker image bundles everything)

## Setup

1. Copy `.env.example` to `.env` and fill in the required values (`WAHA_API_KEY`,
   `WEBHOOK_SECRET`, `WHATSAPP_ALLOWED_USERS`). The Home Assistant / Firefly III /
   opencode sections are each independently optional — leave a section's vars
   empty and that prefix replies with a "not configured yet" message instead of
   erroring.

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
  amount.ts                "20,50" / "1,234.56" / "1.234,56" amount parsing
  rateLimit.ts, dedupe.ts, senderLock.ts, sessionStore.ts
  waha/
    client.ts              thin WAHA REST API wrapper
    payload.ts              parsing WAHA's raw webhook payload (mentions, dedupe key)
    identity.ts              @lid <-> phone resolution, bot's own id (for mention detection)
  integrations/
    firefly.ts, homeAssistant.ts, opencode.ts
  allowlist.ts             who's allowed to trigger the bot, and from where
  router.ts                 prefix -> integration dispatch
  server.ts                 HTTP wiring: auth, size limits, dedupe, rate limit
  index.ts                  composition root
```

Each class takes its dependencies as constructor arguments — no DI framework,
no global state — which is what makes the whole thing unit-testable without
a running WAHA/opencode/Firefly/Home Assistant instance in the loop.

## Known limitation

Mention detection only recognizes plain-text messages
(`extendedTextMessage.contextInfo.mentionedJid`, confirmed against a live WAHA
payload). A mention inside an image/video caption or a reply uses a different
message shape and isn't handled — left alone rather than guessed at.

## License

MIT
