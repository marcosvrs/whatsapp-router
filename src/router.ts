import type { OpencodeClient, OpencodeMediaAttachment } from "./integrations/opencode.js";
import { log } from "./log.js";
import { markdownToWhatsapp } from "./markdownToWhatsapp.js";
import type { SenderLock } from "./senderLock.js";
import type { SessionStore } from "./sessionStore.js";

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
  // Recent group chatter since the bot's last mention — see
  // waha/payload.ts's formatRecentMessages/trimSinceLastMention.
  recentMessages?: string;
}

export interface RouteExtras {
  media?: OpencodeMediaAttachment[];
  context?: AgentContext;
}

function hasMedia(extras: RouteExtras): boolean {
  return Boolean(extras.media && extras.media.length > 0);
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
  if (context.recentMessages) {
    lines.push(`Recent messages in this group (oldest first):\n${context.recentMessages}`);
  }
  return lines.join("\n");
}

// A concrete class, not an interface (unlike ServerDeps in server.ts): tests
// construct a real OpencodeClient instance and stub its one dependency
// (global fetch) instead, since it has no state worth faking and TS
// structural typing can't match a class type against a hand-rolled fake
// with private fields.
export interface RouterDeps {
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

// "/new" resets the sender's session; anything else falls through to the
// agent (which is now the only route — Home Assistant and Firefly control
// happen through opencode's own tools/MCP servers instead of dedicated
// prefixes here). Attached media (the triggering message's own attachment,
// plus — for group messages — any recent-history media forwarded alongside
// it) rides along to the agent as file parts, and context (who/where/how)
// rides along as the SDK's separate `system` field.
export async function routeMessage(
  deps: RouterDeps,
  senderKey: string,
  text: string,
  extras: RouteExtras = {},
): Promise<string> {
  const trimmed = text.trim();

  const newMatch = /^\/new\b(.*)$/i.exec(trimmed);
  if (newMatch) {
    deps.sessions.reset(senderKey);
    const rest = (newMatch[1] ?? "").trim();
    if (!rest && !hasMedia(extras) && !extras.context?.locationText) {
      return "Started a new conversation.";
    }
    return handleAgent(deps, senderKey, rest, extras);
  }

  return handleAgent(deps, senderKey, trimmed, extras);
}
