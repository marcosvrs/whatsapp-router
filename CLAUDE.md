# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Routes WhatsApp messages — received via a self-hosted WAHA (WhatsApp HTTP API) instance — to one of three integrations based on a text prefix: `/new` (resets the sender's opencode agent session), `ha:` (a Home Assistant webhook), `money:` (a Firefly III transaction), or anything else (the opencode agent, one persistent session per sender). Works in 1:1 chats or in any group the bot is added to, as long as the sender is allowlisted and @-mentions the bot. `ha:`/`money:` react ✅/❌ on the original message instead of replying with text (❌ is followed by a text explanation); the agent path shows WhatsApp's native typing indicator while it works, then sends the real reply once — no placeholder message (a placeholder-then-edit approach was tried and deliberately reverted; see the request-flow note below). Every inbound message gets a read receipt. Images/documents are downloaded and forwarded to the agent as a file part (`ha:`/`money:` ignore attachments — they aren't media-aware).

WAHA itself is purely a transport layer with no routing, per-sender state, or allowlist concept — this service is that glue, kept intentionally small: a single Node HTTP server, no framework, plain constructor-injected classes per integration. The only production dependency is `@opencode-ai/sdk` (the official opencode client); every other integration talks to its REST API directly via native `fetch`.

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
  actionResult.ts           { ok, text } shape shared by the ha:/money: integrations
  rateLimit.ts, dedupe.ts, senderLock.ts, sessionStore.ts
  waha/
    client.ts              WAHA REST API wrapper: sendText, startTyping, markChatRead,
                            sendReaction, editMessage, downloadMedia, fetchGroups, fetchSessionInfo
    payload.ts              pure parsing of WAHA's raw webhook payload (mentions incl. media
                            captions, hasMedia/media fields, dedupe key)
    identity.ts              @lid <-> phone resolution + bot's own id (for mention detection)
  integrations/
    firefly.ts, homeAssistant.ts   plain fetch, return Promise<ActionResult>
    opencode.ts                     wraps @opencode-ai/sdk's createOpencodeClient; send()
                                    takes an optional OpencodeMediaAttachment (file part)
  allowlist.ts             who's allowed to trigger the bot, and from where (1:1 vs group + mention gate)
  router.ts                 text-prefix -> integration dispatch; returns a RouteReply
                            ({kind:"text"} / {kind:"reaction"}). routeMessage/handleAgent
                            take an optional media param threaded through to
                            OpencodeClient.send — ha:/money: ignore it.
  server.ts                 HTTP wiring: auth, body-size limit, dedupe, rate limit,
                            read receipts, typing indicator, media download
                            (hasDownloadableMedia gate + base64 via waha.downloadMedia)
  index.ts                  composition root (excluded from coverage/mutation — nothing to unit-test)
```

Every class takes its dependencies as constructor arguments — no DI framework, no global state. `waha/identity.ts` exports an `IdentityResolver` interface (and `waha/client.ts` a `WahaClientLike` interface) specifically so `server.ts`/`allowlist.ts` can be tested with fakes instead of a real WAHA connection. This pattern (narrow interface exported alongside the concrete class, used by consumers instead of the class type) is why the whole request path is unit-testable without a running WAHA/opencode/Firefly/Home Assistant instance.

**Request flow**: `server.ts` receives the webhook POST, verifies the HMAC signature over the raw body before parsing anything, then: dedupe check (WAHA fires each message twice) → `allowlist.ts` resolves the sender (handles WhatsApp's `@lid` privacy-ID indirection via `waha/identity.ts`, and for group messages requires both an allowlisted sender *and* an @-mention of the bot) → mark the chat read → rate limit check → download any attached media (base64, via `waha/client.ts`'s `downloadMedia`) → `router.ts` dispatches on the message's text prefix. `ha:`/`money:` results react on the original message (text only on failure) and ignore any attached media; anything else routes to the opencode agent, media attached — a typing indicator fires, then the real reply is sent once via `sendText`. A media-only message (no caption) is allowed through even though `msg.body` is empty — the original `if (!text) return` guard became `if (!text && !mediaAvailable) return`.

**Reverted design — placeholder + edit-in-place**: an earlier version sent an immediate "…" placeholder and edited it in place once the agent replied (`waha/client.ts` still has `editMessage` and `sendText`'s optional pre-generated `id` param from that work — kept as generically useful WAHA capabilities, just unused by the current agent flow). Reverted for two reasons: (1) UX — sending "…" before there's a real answer reads as broken/unpolished when there's nothing to progressively fill in (no response streaming from opencode today); WhatsApp's native typing indicator already covers "the bot is working" without a visible placeholder message. (2) A real bug: WAHA's message ids are composite (`true_<chatId>_<rawId>`, confirmed against a live message) — `editMessage` needs that full composite string, not just the raw id passed to `sendText`. `WahaClient.editMessage` now builds the composite internally (assuming `fromMe: true`, since this app only ever edits its own messages) if this capability is used again in the future.

**Media download host caveat**: WAHA can self-report `media.url` with a host that's meaningless from another container (observed `http://localhost:3000/...` in production, which resolves to whatsapp-router's own container, not WAHA's — caused every download to fail with `fetch failed`). `WahaClient.downloadMedia` now only trusts the *path* from WAHA's reported url and always fetches against its own configured `baseUrl` for the origin.

**opencode integration**: `integrations/opencode.ts` is a thin wrapper around `@opencode-ai/sdk`'s `createOpencodeClient()` — no raw `fetch` calls to the opencode server anywhere in the codebase. `session.create()` only accepts `{ parentID?, title? }` in this SDK version (verified against the real deployed server — a permission/auto-approve body sent to it is a no-op today), so session creation is a plain `client.session.create({})`. The `send(sessionId, text, media?)` method calls `client.session.prompt(...)` with a `parts` array built from a `TextPartInput` (only when `text` is non-empty) and/or a `FilePartInput` (when `media` is present, as a `data:<mimetype>;base64,...` URI — WAHA's own media URL requires an `X-Api-Key` header the SDK has no way to attach, so the file is downloaded and inlined rather than referenced by URL), retries once via a fresh session on a 404 (stale session), and narrows `AssistantMessage["error"]` per-variant since only some error shapes guarantee a `data.message` string (`MessageOutputLengthError`'s `data` is an untyped bag — falls back to `error.name`).

**Known limitation**: mention detection recognizes plain-text messages (`extendedTextMessage.contextInfo.mentionedJid`, confirmed against a live WAHA payload) and, assumed to mirror that shape, image/document/video captions (`imageMessage`/`documentMessage`/`videoMessage.contextInfo.mentionedJid` — **not independently confirmed** against a live payload; check this first if group @-mentions on media captions don't work). A mention inside a reply uses a different message shape and isn't handled at all.
