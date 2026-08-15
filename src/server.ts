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
  formatRecentMessages,
  hasDownloadableMedia,
  messageDedupeKey,
  RECENT_MESSAGES_FETCH_LIMIT,
  selectRecentMedia,
  stripMentions,
  trimSinceLastMention,
  type WahaMessage,
  type WahaWebhookPayload,
} from "./waha/payload.js";
import { routeMessage, type AgentContext, type RouterDeps } from "./router.js";
import type { OpencodeMediaAttachment } from "./integrations/opencode.js";

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

      const media: OpencodeMediaAttachment[] = [];
      if (mediaAvailable && msg.media?.url) {
        const dataBase64 = await deps.waha.downloadMedia(msg.media.url);
        if (dataBase64) {
          media.push({
            mimetype: msg.media.mimetype ?? "application/octet-stream",
            dataBase64,
            filename: msg.media.filename ?? undefined,
          });
        }
      }

      // Recent group chatter since the bot's last mention, given as extra
      // context for messages that arrive without full conversation history of
      // their own (each opencode session is per-sender, so a session only
      // ever sees what its own sender typed — not what other participants
      // said). Real I/O that only groups need, so 1:1 skips it; wrapped so a
      // WAHA hiccup here costs the enrichment, not the whole reply.
      let recentMessages: string | undefined;
      if (isGroupMessage) {
        try {
          const history = await deps.waha.fetchRecentMessages(from ?? "", RECENT_MESSAGES_FETCH_LIMIT);
          // trimSinceLastMention already excludes the triggering message by id —
          // formatRecentMessages/selectRecentMedia only need their own exclude
          // param for standalone use, so "" here is a genuine no-op, not a bug.
          const trimmed = trimSinceLastMention(history, msg.id ?? "", (id) => deps.identity.isBotId(id));
          recentMessages = formatRecentMessages(trimmed, "");
          for (const item of selectRecentMedia(trimmed, "")) {
            const dataBase64 = await deps.waha.downloadMedia(item.media?.url ?? "");
            if (dataBase64) {
              media.push({
                mimetype: item.media?.mimetype ?? "application/octet-stream",
                dataBase64,
                filename: item.media?.filename ?? undefined,
              });
            }
          }
        } catch (err) {
          log("recent-history fetch failed", err instanceof Error ? err.message : String(err));
        }
      }

      const context: AgentContext = {
        senderName: extractPushName(msg),
        senderPhone: senderKey,
        isGroupChat: isGroupMessage,
        groupName: isGroupMessage ? deps.identity.getGroupName(from ?? "") : undefined,
        timestamp: msg.timestamp,
        replyToText: msg.replyTo?.body,
        locationText: msg.location ? formatLocation(msg.location) : undefined,
        recentMessages,
      };

      const reply = await routeMessage(deps.router, senderKey, from ?? "", text, {
        media: media.length ? media : undefined,
        context,
      });
      if (reply) await deps.waha.sendText(from ?? "", reply);
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
