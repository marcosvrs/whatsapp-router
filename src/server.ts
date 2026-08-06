import { createServer, type Server, type ServerResponse } from "node:http";
import type { Config } from "./config.js";
import type { MessageDedupe } from "./dedupe.js";
import { log } from "./log.js";
import { validWebhookSignature } from "./security.js";
import { resolveAllowedSender } from "./allowlist.js";
import type { RateLimiter } from "./rateLimit.js";
import type { IdentityResolver } from "./waha/identity.js";
import type { WahaClientLike } from "./waha/client.js";
import {
  extractPushName,
  formatLocation,
  messageDedupeKey,
  stripMentions,
  type WahaMessage,
  type WahaWebhookPayload,
} from "./waha/payload.js";
import { routeMessage, type AgentContext, type RouterDeps } from "./router.js";
import type { OpencodeMediaAttachment } from "./integrations/opencode.js";

// WAHA reports hasMedia:true even when it couldn't fetch the file itself
// (media.error set, media.url null) — only worth downloading when there's an
// actual url to fetch.
function hasDownloadableMedia(msg: WahaMessage): boolean {
  return Boolean(msg.hasMedia && msg.media?.url && !msg.media.error);
}

export interface ServerDeps {
  waha: WahaClientLike;
  identity: IdentityResolver;
  rateLimiter: RateLimiter;
  dedupe: MessageDedupe;
  router: RouterDeps;
}

export function buildServer(config: Config, deps: ServerDeps): Server {
  async function handleWebhook(
    body: string,
    signature: string | undefined,
    res: ServerResponse,
  ): Promise<void> {
    if (!validWebhookSignature(body, signature, config.webhookSecret)) {
      log("rejected webhook: bad or missing hmac signature");
      res.writeHead(401).end();
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" }).end("{}");

    try {
      const payload = JSON.parse(body) as WahaWebhookPayload;
      if (payload.event !== "message") return;
      const msg: WahaMessage = payload.payload ?? {};
      if (msg.fromMe) return;

      const from = msg.from;
      const isGroupMessage = (from ?? "").endsWith("@g.us");
      let text = msg.body ?? "";
      const mediaAvailable = hasDownloadableMedia(msg);
      if (!text && !mediaAvailable && !msg.location) return;
      if (deps.dedupe.alreadyProcessed(messageDedupeKey(msg))) return;

      const senderKey = await resolveAllowedSender(deps.identity, config.allowedUsers, from, msg);
      if (!senderKey) {
        if (isGroupMessage) {
          log("ignored group message (not mentioned or not allowed)", from);
        } else {
          log("rejected sender", from);
        }
        return;
      }

      if (isGroupMessage) {
        text = stripMentions(text, msg);
      }

      await deps.waha.markChatRead(from ?? "");

      if (deps.rateLimiter.isLimited(senderKey)) {
        log("rate limited", senderKey);
        await deps.waha.sendText(from ?? "", "Rate limit reached — try again in a few minutes.");
        return;
      }

      log("inbound", from, JSON.stringify(text).slice(0, 200));
      await deps.waha.startTyping(from ?? "");

      let media: OpencodeMediaAttachment | undefined;
      if (mediaAvailable && msg.media?.url) {
        const dataBase64 = await deps.waha.downloadMedia(msg.media.url);
        if (dataBase64) {
          media = {
            mimetype: msg.media.mimetype ?? "application/octet-stream",
            dataBase64,
            filename: msg.media.filename ?? undefined,
          };
        }
      }

      const context: AgentContext = {
        agentName: config.agentName,
        senderName: extractPushName(msg),
        senderPhone: senderKey,
        isGroupChat: isGroupMessage,
        groupName: isGroupMessage ? deps.identity.getGroupName(from ?? "") : undefined,
        timestamp: msg.timestamp,
        replyToText: msg.replyTo?.body,
        locationText: msg.location ? formatLocation(msg.location) : undefined,
      };

      const reply = await routeMessage(deps.router, senderKey, text, { media, context });
      if (reply.kind === "reaction") {
        await deps.waha.sendReaction(msg.id ?? "", reply.emoji);
        if (reply.text) await deps.waha.sendText(from ?? "", reply.text);
      } else {
        await deps.waha.sendText(from ?? "", reply.text);
      }
    } catch (err) {
      log("webhook handling error", err instanceof Error ? err.message : String(err));
    }
  }

  return createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/webhook") {
      res.writeHead(404).end();
      return;
    }

    const signatureHeader = req.headers["x-webhook-hmac"];
    const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;

    let body = "";
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      body += String(chunk);
      if (body.length > config.maxBodyBytes) {
        tooLarge = true;
        log("rejected webhook: body too large");
        res.writeHead(413).end();
        req.destroy();
      }
    });

    req.on("end", () => {
      if (tooLarge) return;
      void handleWebhook(body, signature, res);
    });
  });
}
