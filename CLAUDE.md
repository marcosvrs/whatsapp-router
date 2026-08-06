# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Routes WhatsApp messages — received via a self-hosted WAHA (WhatsApp HTTP API) instance — to one of three integrations based on a text prefix: `/new` (resets the sender's opencode agent session), `ha:` (a Home Assistant webhook), `money:` (a Firefly III transaction), or anything else (the opencode agent, one persistent session per sender). Works in 1:1 chats or in any group the bot is added to, as long as the sender is allowlisted and @-mentions the bot.

WAHA itself is purely a transport layer with no routing, per-sender state, or allowlist concept — this service is that glue, kept intentionally small: a single Node HTTP server, no framework, plain constructor-injected classes per integration.

## Commands

```sh
npm install
git config core.hooksPath .githooks   # one-time per clone — enables pre-commit/pre-push hooks

npm run typecheck                      # tsc --noEmit, whole-program
npm run lint                           # eslint (strict + type-checked), or `npm run lint:fix`
npm test                               # vitest run, full suite
npx vitest run test/amount.test.ts     # single test file
npx vitest run -t "name substring"     # single test case by name
npm run test:coverage                  # vitest run --coverage
npm run test:mutation                  # stryker run, full mutation suite (slow)
npm run build                          # tsc -p tsconfig.build.json -> dist/
npm start                              # node dist/index.js (needs build + env vars)
```

Node 22.16+ required (uses `import.meta.dirname`, native `fetch`/`Response`). Docker image bundles everything; local Node is only needed for development.

## Tooling policy

- **No dependencies with a native equivalent.** Git hooks use native `core.hooksPath` (no husky), pre-commit lints staged files via a plain `git diff --cached | xargs eslint` (no lint-staged). `eslint-plugin-n` was deliberately dropped — its one real catch (an `import.meta.dirname` Node-version check) is handled by keeping `engines.node` accurate instead. Before adding a new dependency, check whether Node or an existing dependency already provides it.
- **`.npmrc`**: `ignore-scripts=true` (no install/postinstall script ever runs automatically — after `npm install`, git hooks need no extra step since they're native, not npm-script-driven) and `save-exact=true` (new/bumped dependencies are pinned to exact versions). New dependency versions should be checked with `npm view <pkg> time` and only added once they've been out a few days (supply-chain hardening — avoids a just-published/compromised version).
- **Git hooks are intentionally asymmetric.** `pre-commit` stays fast (lint staged `.ts` files only). `pre-push` is more thorough but still scoped where it's *safe* to scope: gitleaks runs full-history (needs to, and it's fast anyway), typecheck stays whole-program (a change to a shared type can break other files without touching their text — TypeScript checking is inherently holistic; sped up via `tsconfig.json`'s `incremental: true` instead), tests run via `vitest run --changed origin/main` (import-graph-scoped), mutation testing via `stryker run --incremental` (persists `reports/stryker-incremental.json`, gitignored, only re-tests what could have changed status). **CI always runs the full, unscoped versions of everything** — the hooks trade rigor for local speed; CI is the actual gate.
- Mutation score thresholds (`stryker.config.mjs`): break 70 / low 75 / high 85.

## Architecture

```
src/
  config.ts              env var loading (pure function of an env object, not process.env directly — testable)
  security.ts             webhook HMAC-SHA512 verification
  amount.ts                "20,50" / "1,234.56" / "1.234,56" amount normalization (money: prefix)
  rateLimit.ts, dedupe.ts, senderLock.ts, sessionStore.ts
  waha/
    client.ts              thin WAHA REST API wrapper (sendText, fetchGroups, fetchSessionInfo)
    payload.ts              pure parsing of WAHA's raw webhook payload (mentions, dedupe key)
    identity.ts              @lid <-> phone resolution + bot's own id (for mention detection)
  integrations/
    firefly.ts, homeAssistant.ts, opencode.ts
  allowlist.ts             who's allowed to trigger the bot, and from where (1:1 vs group + mention gate)
  router.ts                 text-prefix -> integration dispatch
  server.ts                 HTTP wiring: auth, body-size limit, dedupe, rate limit
  index.ts                  composition root (excluded from coverage/mutation — nothing to unit-test)
```

Every class takes its dependencies as constructor arguments — no DI framework, no global state. `waha/identity.ts` exports an `IdentityResolver` interface (and `waha/client.ts` a `WahaClientLike` interface) specifically so `server.ts`/`allowlist.ts` can be tested with fakes instead of a real WAHA connection. This pattern (narrow interface exported alongside the concrete class, used by consumers instead of the class type) is why the whole request path is unit-testable without a running WAHA/opencode/Firefly/Home Assistant instance.

**Request flow**: `server.ts` receives the webhook POST, verifies the HMAC signature over the raw body before parsing anything, then: dedupe check (WAHA fires each message twice) → `allowlist.ts` resolves the sender (handles WhatsApp's `@lid` privacy-ID indirection via `waha/identity.ts`, and for group messages requires both an allowlisted sender *and* an @-mention of the bot) → rate limit check → `router.ts` dispatches on the message's text prefix → the matched integration (or the opencode agent, via `sessionStore.ts` for per-sender session persistence) produces a reply → sent back through `waha/client.ts`.

**Known limitation**: mention detection only recognizes plain-text messages (`extendedTextMessage.contextInfo.mentionedJid`, confirmed against a live WAHA payload). A mention inside an image/video caption or a reply uses a different message shape and isn't handled.
