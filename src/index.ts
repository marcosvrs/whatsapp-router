import { loadConfig } from "./config.js";
import { MessageDedupe } from "./dedupe.js";
import { OpencodeClient } from "./integrations/opencode.js";
import { DeliveryRetryStore } from "./deliveryRetryStore.js";
import { info } from "./log.js";
import { AgentExchangeManager } from "./router.js";
import { RateLimiter } from "./rateLimit.js";
import { SenderLock } from "./senderLock.js";
import { SessionStore } from "./sessionStore.js";
import { buildServer, type ServerDeps } from "./server.js";
import { WahaClient } from "./waha/client.js";
import { Identity } from "./waha/identity.js";
import { TypingPresence } from "./waha/typingKeepAlive.js";

const config = loadConfig();

const waha = new WahaClient(config.wahaBaseUrl, config.wahaApiKey, config.wahaSession);
const identity = new Identity(waha);

const exchanges = new AgentExchangeManager();
const deliveryRetries = new DeliveryRetryStore(`${config.sessionsFile}.delivery-retries.json`);
const router = {
  opencode: new OpencodeClient({
    baseUrl: config.opencodeBaseUrl,
    authHeader: config.opencodeAuthHeader,
    modelProvider: config.opencodeModelProvider,
    modelId: config.opencodeModelId,
  }),
  sessions: new SessionStore(config.sessionsFile),
  deliveryRetries,
  senderLock: new SenderLock(),
  typing: new TypingPresence(waha),
  exchanges,
};

const deps: ServerDeps = {
  waha,
  identity,
  rateLimiter: new RateLimiter(config.rateLimitMax, config.rateLimitWindowMs),
  dedupe: new MessageDedupe(5 * 60 * 1000),
  router,
};

const server = buildServer(config, deps);
server.listen(config.port, () => {
  info(`whatsapp-router listening on :${String(config.port)}`);
});
exchanges.drainPersistedDeliveries(router);
void identity.ensureLidMap();
