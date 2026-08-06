import type { ActionResult } from "./actionResult.js";
import type { FireflyClient } from "./integrations/firefly.js";
import type { HaClient } from "./integrations/homeAssistant.js";
import type { OpencodeClient, OpencodeMediaAttachment } from "./integrations/opencode.js";
import { log } from "./log.js";
import type { SenderLock } from "./senderLock.js";
import type { SessionStore } from "./sessionStore.js";

// "text" replies go through waha.sendText; "reaction" replies react to the
// original message instead — text is only attached to a reaction on failure,
// so the sender knows what went wrong without a reply cluttering the chat.
// "agent" replies are resolved lazily (via `resolve`) so the caller can send
// a placeholder message first and edit it in place once the — potentially
// slow — agent call actually finishes.
export type RouteReply =
  | { kind: "text"; text: string }
  | { kind: "reaction"; emoji: string; text?: string }
  | { kind: "agent"; resolve: () => Promise<string> };

function actionReply(result: ActionResult): RouteReply {
  return result.ok
    ? { kind: "reaction", emoji: "✅" }
    : { kind: "reaction", emoji: "❌", text: result.text };
}

// Concrete classes, not interfaces (unlike ServerDeps in server.ts): tests
// construct real HaClient/FireflyClient/OpencodeClient instances and stub
// their one dependency (global fetch) instead, since these classes have no
// state worth faking and TS structural typing can't match a class type
// against a hand-rolled fake with private fields.
export interface RouterDeps {
  ha: HaClient;
  firefly: FireflyClient;
  opencode: OpencodeClient;
  sessions: SessionStore;
  senderLock: SenderLock;
}

async function handleAgent(
  deps: RouterDeps,
  senderKey: string,
  text: string,
  media?: OpencodeMediaAttachment,
): Promise<string> {
  if (!deps.opencode.isConfigured()) return "opencode agent not configured yet.";
  try {
    return await deps.senderLock.run(senderKey, async () => {
      let sessionId = deps.sessions.get(senderKey);
      if (!sessionId) {
        sessionId = await deps.opencode.createSession();
        deps.sessions.set(senderKey, sessionId);
      }
      const result = await deps.opencode.send(sessionId, text, media);
      if (result.sessionId !== sessionId) {
        deps.sessions.set(senderKey, result.sessionId);
      }
      return result.reply;
    });
  } catch (err) {
    log("opencode call failed", err instanceof Error ? err.message : String(err));
    return "Agent call failed — check whatsapp-router logs.";
  }
}

// "/new" resets the sender's session; "ha:"/"money:" dispatch to their
// integration; anything else falls through to the agent. An image/document
// attached to the message (any route except /new and the fallback ignores it —
// ha:/money: aren't media-aware) rides along to the agent as a file part.
export async function routeMessage(
  deps: RouterDeps,
  senderKey: string,
  text: string,
  media?: OpencodeMediaAttachment,
): Promise<RouteReply> {
  const trimmed = text.trim();

  const newMatch = /^\/new\b(.*)$/i.exec(trimmed);
  if (newMatch) {
    deps.sessions.reset(senderKey);
    const rest = (newMatch[1] ?? "").trim();
    if (!rest && !media) return { kind: "text", text: "Started a new conversation." };
    return { kind: "agent", resolve: () => handleAgent(deps, senderKey, rest, media) };
  }

  const haMatch = /^ha:(.*)$/i.exec(trimmed);
  if (haMatch) return actionReply(await deps.ha.trigger((haMatch[1] ?? "").trim()));

  const moneyMatch = /^money:(.*)$/i.exec(trimmed);
  if (moneyMatch) return actionReply(await deps.firefly.logTransaction((moneyMatch[1] ?? "").trim()));

  return { kind: "agent", resolve: () => handleAgent(deps, senderKey, trimmed, media) };
}
