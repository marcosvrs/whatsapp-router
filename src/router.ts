import type { FireflyClient } from "./integrations/firefly.js";
import type { HaClient } from "./integrations/homeAssistant.js";
import type { OpencodeClient } from "./integrations/opencode.js";
import { log } from "./log.js";
import type { SenderLock } from "./senderLock.js";
import type { SessionStore } from "./sessionStore.js";

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

async function handleAgent(deps: RouterDeps, senderKey: string, text: string): Promise<string> {
  if (!deps.opencode.isConfigured()) return "opencode agent not configured yet.";
  try {
    return await deps.senderLock.run(senderKey, async () => {
      let sessionId = deps.sessions.get(senderKey);
      if (!sessionId) {
        sessionId = await deps.opencode.createSession();
        deps.sessions.set(senderKey, sessionId);
      }
      const result = await deps.opencode.send(sessionId, text);
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
// integration; anything else falls through to the agent.
export async function routeMessage(
  deps: RouterDeps,
  senderKey: string,
  text: string,
): Promise<string> {
  const trimmed = text.trim();

  const newMatch = /^\/new\b(.*)$/i.exec(trimmed);
  if (newMatch) {
    deps.sessions.reset(senderKey);
    const rest = (newMatch[1] ?? "").trim();
    if (!rest) return "Started a new conversation.";
    return handleAgent(deps, senderKey, rest);
  }

  const haMatch = /^ha:(.*)$/i.exec(trimmed);
  if (haMatch) return deps.ha.trigger((haMatch[1] ?? "").trim());

  const moneyMatch = /^money:(.*)$/i.exec(trimmed);
  if (moneyMatch) return deps.firefly.logTransaction((moneyMatch[1] ?? "").trim());

  return handleAgent(deps, senderKey, trimmed);
}
