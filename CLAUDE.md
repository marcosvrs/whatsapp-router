# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Routes WhatsApp messages — received via a self-hosted WAHA (WhatsApp HTTP API) instance — to one of three integrations based on a text prefix: `/new` (resets the sender's opencode agent session), `ha:` (a Home Assistant webhook), `money:` (a Firefly III transaction), or anything else (the opencode agent, one persistent session per sender). Works in 1:1 chats or in any group the bot is added to, as long as the sender is allowlisted and @-mentions the bot. `ha:`/`money:` react ✅/❌ on the original message instead of replying with text (❌ is followed by a text explanation); the agent path shows WhatsApp's native typing indicator while it works, then sends the real reply once — no placeholder message (a placeholder-then-edit approach was tried and deliberately reverted; see the request-flow note below). Every inbound message gets a read receipt. Images/documents are downloaded and forwarded to the agent as a file part; a shared location is described in words; `ha:`/`money:` ignore attachments/locations — they aren't media-aware. The agent also gets a `system`-field context per message (who's messaging, over WhatsApp, 1:1 or which group, when, replying to what, and — for group messages — recent chatter since the bot's last mention) — see the request-flow note below. The agent's Markdown reply is converted to WhatsApp's own formatting syntax before being sent — see the `markdownToWhatsapp` note below.

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
                            sendReaction, editMessage, downloadMedia, fetchGroups, fetchSessionInfo,
                            fetchRecentMessages (GET .../chats/{chatId}/messages)
    payload.ts              pure parsing of WAHA's raw webhook + chat-history payloads (mentions
                            incl. media captions, hasMedia/media fields, location, pushName,
                            dedupe key, hasDownloadableMedia, and the recent-group-history
                            trio: trimSinceLastMention, formatRecentMessages, selectRecentMedia)
    identity.ts              @lid <-> phone resolution + bot's own id (for mention detection),
                            group names (getGroupName, cached from the same fetchGroups()
                            call ensureLidMap() already makes)
  integrations/
    firefly.ts, homeAssistant.ts   plain fetch, return Promise<ActionResult>
    opencode.ts                     wraps @opencode-ai/sdk's createOpencodeClient; send()
                                    takes OpencodeSendOptions ({media?: OpencodeMediaAttachment[], system?})
  allowlist.ts             who's allowed to trigger the bot, and from where (1:1 vs group + mention gate)
  markdownToWhatsapp.ts    converts the agent's GitHub-flavored-Markdown reply to WhatsApp's
                            own (much smaller) formatting syntax — single *bold*, _italic_,
                            ~strike~, ```monospace``` only; code spans are protected first
                            and restored verbatim so nothing inside them gets rewritten
  router.ts                 text-prefix -> integration dispatch; returns a RouteReply
                            ({kind:"text"} / {kind:"reaction"}). routeMessage/handleAgent
                            take a RouteExtras ({media?: OpencodeMediaAttachment[], context?:
                            AgentContext}) — media and a formatted system-context string both
                            thread through to OpencodeClient.send; ha:/money: ignore extras
                            entirely. The agent's reply is passed through markdownToWhatsapp
                            before being returned (fallback/error strings are not, since
                            they're already plain text).
  server.ts                 HTTP wiring: auth, body-size limit, dedupe, rate limit,
                            read receipts, typing indicator, media download
                            (hasDownloadableMedia gate + base64 via waha.downloadMedia),
                            AgentContext extraction (pushName, group name, timestamp,
                            replyTo, location), recent-group-history fetch + trim + media
                            selection (groups only, skipped for ha:/money:)
  index.ts                  composition root (excluded from coverage/mutation — nothing to unit-test)
```

Every class takes its dependencies as constructor arguments — no DI framework, no global state. `waha/identity.ts` exports an `IdentityResolver` interface (and `waha/client.ts` a `WahaClientLike` interface) specifically so `server.ts`/`allowlist.ts` can be tested with fakes instead of a real WAHA connection. This pattern (narrow interface exported alongside the concrete class, used by consumers instead of the class type) is why the whole request path is unit-testable without a running WAHA/opencode/Firefly/Home Assistant instance.

**Request flow**: `server.ts` receives the webhook POST, verifies the HMAC signature over the raw body before parsing anything, then: dedupe check (WAHA fires each message twice) → `allowlist.ts` resolves the sender (handles WhatsApp's `@lid` privacy-ID indirection via `waha/identity.ts`, and for group messages requires both an allowlisted sender *and* an @-mention of the bot) → mark the chat read → rate limit check → download any attached media (base64, via `waha/client.ts`'s `downloadMedia`) → `router.ts` dispatches on the message's text prefix. `ha:`/`money:` results react on the original message (text only on failure) and ignore any attached media; anything else routes to the opencode agent, media attached — a typing indicator fires, then the real reply is sent once via `sendText`. A media-only message (no caption) is allowed through even though `msg.body` is empty — the original `if (!text) return` guard became `if (!text && !mediaAvailable) return`.

**Reverted design — placeholder + edit-in-place**: an earlier version sent an immediate "…" placeholder and edited it in place once the agent replied (`waha/client.ts` still has `editMessage` and `sendText`'s optional pre-generated `id` param from that work — kept as generically useful WAHA capabilities, just unused by the current agent flow). Reverted for two reasons: (1) UX — sending "…" before there's a real answer reads as broken/unpolished when there's nothing to progressively fill in (no response streaming from opencode today); WhatsApp's native typing indicator already covers "the bot is working" without a visible placeholder message. (2) A real bug: WAHA's message ids are composite (`true_<chatId>_<rawId>`, confirmed against a live message) — `editMessage` needs that full composite string, not just the raw id passed to `sendText`. `WahaClient.editMessage` now builds the composite internally (assuming `fromMe: true`, since this app only ever edits its own messages) if this capability is used again in the future.

**Media download host caveat**: WAHA can self-report `media.url` with a host that's meaningless from another container (observed `http://localhost:3000/...` in production, which resolves to whatsapp-router's own container, not WAHA's — caused every download to fail with `fetch failed`). `WahaClient.downloadMedia` now only trusts the *path* from WAHA's reported url and always fetches against its own configured `baseUrl` for the origin.

**Agent context (`AgentContext`, `router.ts`)**: every agent call's `system` field is built from an `AgentContext` `server.ts` assembles per message — `senderName` (`extractPushName(msg)`, from `_data.pushName` — confirmed against a live payload via the REST chat-history endpoint, absent from WAHA's own webhook docs examples), `senderPhone` (the already-resolved `senderKey`), `isGroupChat`/`groupName` (`identity.getGroupName(from)`), `timestamp`, `replyToText` (`msg.replyTo?.body`), and `locationText` (`formatLocation(msg.location)`). `formatSystemContext()` renders these as short labeled lines, omitting any that are absent — kept deliberately terse (a handful of lines) rather than dumping the raw WAHA payload, since it's resent on every single message. A location-only message (no text, no media) is let through the same way a media-only one is — the `if (!text) return` guard is now `if (!text && !mediaAvailable && !msg.location) return`. vCards (contact cards) aren't parsed or forwarded at all.

**Recent group-history context (`trimSinceLastMention`/`formatRecentMessages`/`selectRecentMedia`, `waha/payload.ts`)**: each opencode session belongs to one sender (`SessionStore` keys by phone number), so in a group with multiple participants, whoever's session responds has no visibility into what anyone *else* in the group said — the per-message context above only covers the single triggering message. To close that gap, group messages (only — 1:1 sessions already have full continuity, and `ha:`/`money:` skip this entirely since they ignore `context`/`media` anyway and it'd just be wasted WAHA calls) fetch recent chat history via `waha.fetchRecentMessages(chatId, RECENT_MESSAGES_FETCH_LIMIT)` and run it through three pure functions: `trimSinceLastMention` drops the triggering message (matched by id) and stops — without including — the first earlier message that itself @-mentions the bot, so nothing already sent to the agent in a prior turn gets resent (walking newest-first, this always lands on the *nearest* prior mention, never an older one further back); `formatRecentMessages` renders what's left as `sender: text` lines, oldest-first, bounded by both a message-count cap (15) and a character budget (2500) — whichever hits first — with media-only messages shown as `[image]`/`[document]`/`[video]`/`[audio]` placeholders; `selectRecentMedia` picks up to `RECENT_MEDIA_MAX` (2) of the most recent downloadable media items from that same trimmed window, downloaded via `waha.downloadMedia` and appended to the same `media` array the triggering message's own attachment goes into (now `OpencodeMediaAttachment[]`, not a single item — `promptMessage` pushes one file part per entry). The whole fetch+trim+download block is wrapped in its own try/catch in `server.ts`: a WAHA hiccup here degrades to "no recent-history context" rather than dropping the reply entirely, since it's enrichment, not the core request.

**Agent identity can't be overridden — the agent is "Sisyphus", full stop**: an earlier version of this feature sent `You are ${agentName}, an AI assistant...` (config'd via `AGENT_NAME`/default "Jarvis"), intending to give the agent a consistent self-identity over WhatsApp. Verified live against the deployed opencode server (Jarvis homelab) that this doesn't work, and traced it to the root cause rather than stopping at "it doesn't work": the server runs the `oh-my-openagent` plugin, whose default agent's compiled system prompt (fetched live via the SDK's `app.agents()` endpoint) opens with an explicit, hardcoded guard —  *"Your designated identity for this session is 'Sisyphus'. This identity supersedes any prior identity statements... Do not identify as any other assistant or AI."* This isn't a soft default that a stronger prompt can out-argue; it's a deliberate anti-impersonation instruction. Three separate override attempts were tried and confirmed ineffective: (1) the per-request `system` field (this repo's own mechanism, any phrasing), (2) oh-my-openagent's documented `agents.sisyphus.prompt_append` config key (edited directly on the Jarvis server, restarted, verified via `app.agents()` that the appended text never even reached the compiled prompt), (3) explicitly selecting an `agent` by name in the SDK request (the config key `sisyphus` isn't a valid SDK agent name — the real registered name is `"Sisyphus - ultraworker"` — passing it caused a 500). A fourth option, renaming the `sisyphus` key in `oh-my-openagent.jsonc` itself (the identity text likely templates off that key), was identified but deliberately not attempted: the literal string `sisyphus` is also used by that plugin's own hooks (`no-sisyphus-gpt`, `sisyphus-junior-notepad`), so renaming it risks breaking real coding-agent usage elsewhere on the same server for an unverified, cosmetic-only payoff. Conclusion: the agent's name is Sisyphus everywhere it's reached, WhatsApp included, and this repo does not try to change that. The rest of the context (sender name, location, platform, chat type) *does* land correctly and is unaffected.

**Markdown-to-WhatsApp conversion (`markdownToWhatsapp.ts`)**: the opencode agent replies in standard Markdown, but WhatsApp renders its own, much smaller formatting syntax — researched against WhatsApp's own docs rather than assumed, since GitHub-flavored Markdown and WhatsApp's syntax overlap just enough to be misleading (both use `*`, but markdown's single `*text*` is italic while WhatsApp's single `*text*` is bold). Confirmed rules: bold is `*text*` (single asterisk, not `**`), italic is `_text_`, strikethrough is `~text~` (single tilde, not `~~`), and monospace is triple-backtick only — WhatsApp has no single-backtick inline form, and content inside a monospace span is rendered completely literally (no nested formatting), which is why code spans are extracted into a side array and restored verbatim at the end rather than being processed by the other rules. Bulleted/numbered lists and blockquotes need no conversion — WhatsApp already renders `- item`/`> quote` natively. Headers and markdown link syntax have no WhatsApp equivalent: headers become bold text, links become `label: url` (WhatsApp auto-links bare URLs on its own). Considered and rejected two npm packages instead of hand-rolling this: one solves the opposite direction (WhatsApp-to-Markdown), and the other (`md-to-whatsapp`) ships prebuilt native binaries via `optionalDependencies` with no musl-libc variant — a real risk since this repo's Docker image is `node:22-alpine` (musl, not glibc) — for a problem trivial enough that the repo's own "no dependency with a native equivalent" policy argues for hand-writing it instead, especially given this is still the only production dependency the project has (`@opencode-ai/sdk`).

**opencode integration**: `integrations/opencode.ts` is a thin wrapper around `@opencode-ai/sdk`'s `createOpencodeClient()` — no raw `fetch` calls to the opencode server anywhere in the codebase. `session.create()` only accepts `{ parentID?, title? }` in this SDK version (verified against the real deployed server — a permission/auto-approve body sent to it is a no-op today), so session creation is a plain `client.session.create({})`. The `send(sessionId, text, media?)` method calls `client.session.prompt(...)` with a `parts` array built from a `TextPartInput` (only when `text` is non-empty) and/or a `FilePartInput` (when `media` is present, as a `data:<mimetype>;base64,...` URI — WAHA's own media URL requires an `X-Api-Key` header the SDK has no way to attach, so the file is downloaded and inlined rather than referenced by URL), retries once via a fresh session on a 404 (stale session), and narrows `AssistantMessage["error"]` per-variant since only some error shapes guarantee a `data.message` string (`MessageOutputLengthError`'s `data` is an untyped bag — falls back to `error.name`).

**Known limitations**: mention detection recognizes plain-text messages (`extendedTextMessage.contextInfo.mentionedJid`) and image/document captions (`imageMessage`/`documentMessage.contextInfo.mentionedJid`) — both confirmed against live WAHA payloads, pulled from real group message history via `GET /api/{session}/chats/{chatId}/messages` (`videoMessage.contextInfo.mentionedJid` still unconfirmed — no video-with-mention message existed in the sampled history — but follows the identical shape as the other two, so is very likely correct too). A mention inside a reply uses a different message shape and isn't handled at all. `WahaLocation` mirrors WAHA's documented *send*-location shape (`latitude`/`longitude`/`title`) — the receive side isn't independently confirmed either.
