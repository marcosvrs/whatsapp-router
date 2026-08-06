import type { ActionResult } from "./actionResult.js";
import type { FireflyClient } from "./integrations/firefly.js";
import type { HaClient } from "./integrations/homeAssistant.js";
import type { OpencodeClient, OpencodeMediaAttachment } from "./integrations/opencode.js";
import { log } from "./log.js";
import { markdownToWhatsapp } from "./markdownToWhatsapp.js";
import type { SenderLock } from "./senderLock.js";
import type { SessionStore } from "./sessionStore.js";

// "text" replies go through waha.sendText; "reaction" replies react to the
// original message instead — text is only attached to a reaction on failure,
// so the sender knows what went wrong without a reply cluttering the chat.
export type RouteReply = { kind: "text"; text: string } | { kind: "reaction"; emoji: string; text?: string };

function actionReply(result: ActionResult): RouteReply {
  return result.ok
    ? { kind: "reaction", emoji: "✅" }
    : { kind: "reaction", emoji: "❌", text: result.text };
}

// Everything server.ts can tell the agent about who/where/how it's being
// reached, kept separate from the WhatsApp-domain-agnostic OpencodeClient —
// router.ts is the layer that knows both "WhatsApp" and "opencode".
export interface AgentContext {
  senderName?: string;
  senderPhone: string;
  isGroupChat: boolean;
  groupName?: string;
  timestamp?: number;
  replyToText?: string;
  locationText?: string;
}

export interface RouteExtras {
  media?: OpencodeMediaAttachment;
  context?: AgentContext;
}

function formatSystemContext(context: AgentContext): string {
  const lines = ["You are being reached over WhatsApp."];
  lines.push(
    `Message from: ${context.senderName ? `${context.senderName} (+${context.senderPhone})` : `+${context.senderPhone}`}`,
  );
  lines.push(
    context.isGroupChat
      ? `Chat: a group${context.groupName ? ` named "${context.groupName}"` : ""}`
      : "Chat: a direct message (not a group)",
  );
  if (context.timestamp) {
    lines.push(`Sent at: ${new Date(context.timestamp * 1000).toISOString()}`);
  }
  if (context.replyToText) {
    lines.push(`Replying to an earlier message: "${context.replyToText}"`);
  }
  if (context.locationText) {
    lines.push(`Shared location: ${context.locationText}`);
  }
  return lines.join("\n");
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
  extras: RouteExtras,
): Promise<string> {
  if (!deps.opencode.isConfigured()) return "opencode agent not configured yet.";
  try {
    return await deps.senderLock.run(senderKey, async () => {
      let sessionId = deps.sessions.get(senderKey);
      if (!sessionId) {
        sessionId = await deps.opencode.createSession();
        deps.sessions.set(senderKey, sessionId);
      }
      const result = await deps.opencode.send(sessionId, text, {
        media: extras.media,
        system: extras.context ? formatSystemContext(extras.context) : undefined,
      });
      if (result.sessionId !== sessionId) {
        deps.sessions.set(senderKey, result.sessionId);
      }
      // The agent's own reply is LLM-generated Markdown — WhatsApp uses a
      // different, much smaller formatting syntax (see markdownToWhatsapp.ts).
      // Our own fallback strings (below, and on the error paths) are already
      // plain text and don't need it.
      return markdownToWhatsapp(result.reply);
    });
  } catch (err) {
    log("opencode call failed", err instanceof Error ? err.message : String(err));
    return "Agent call failed — check whatsapp-router logs.";
  }
}

// "/new" resets the sender's session; "ha:"/"money:" dispatch to their
// integration; anything else falls through to the agent. An image/document
// attached to the message (any route except /new and the fallback ignores it —
// ha:/money: aren't media-aware) rides along to the agent as a file part, and
// context (who/where/how) rides along as the SDK's separate `system` field.
export async function routeMessage(
  deps: RouterDeps,
  senderKey: string,
  text: string,
  extras: RouteExtras = {},
): Promise<RouteReply> {
  const trimmed = text.trim();

  const newMatch = /^\/new\b(.*)$/i.exec(trimmed);
  if (newMatch) {
    deps.sessions.reset(senderKey);
    const rest = (newMatch[1] ?? "").trim();
    if (!rest && !extras.media && !extras.context?.locationText) {
      return { kind: "text", text: "Started a new conversation." };
    }
    return { kind: "text", text: await handleAgent(deps, senderKey, rest, extras) };
  }

  const haMatch = /^ha:(.*)$/i.exec(trimmed);
  if (haMatch) return actionReply(await deps.ha.trigger((haMatch[1] ?? "").trim()));

  const moneyMatch = /^money:(.*)$/i.exec(trimmed);
  if (moneyMatch) return actionReply(await deps.firefly.logTransaction((moneyMatch[1] ?? "").trim()));

  return { kind: "text", text: await handleAgent(deps, senderKey, trimmed, extras) };
}
