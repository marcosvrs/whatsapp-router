import { createServer, type Server, type ServerResponse } from "node:http";
import type { Config } from "./config.js";
import type { MessageDedupe } from "./dedupe.js";
import { log } from "./log.js";
import { validWebhookSignature } from "./security.js";
import { resolveAllowedSender } from "./allowlist.js";
import type { RateLimiter } from "./rateLimit.js";
import type { IdentityResolver } from "./waha/identity.js";
import type { WahaClientLike } from "./waha/client.js";
import { messageDedupeKey, stripMentions, type WahaMessage, type WahaWebhookPayload } from "./waha/payload.js";
import { routeMessage, type RouterDeps } from "./router.js";

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
      if (!text) return;
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

      if (deps.rateLimiter.isLimited(senderKey)) {
        log("rate limited", senderKey);
        await deps.waha.sendText(from ?? "", "Rate limit reached — try again in a few minutes.");
        return;
      }

      log("inbound", from, JSON.stringify(text).slice(0, 200));
      const reply = await routeMessage(deps.router, senderKey, text);
      await deps.waha.sendText(from ?? "", reply);
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
