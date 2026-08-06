import { loadConfig } from "./config.js";
import { MessageDedupe } from "./dedupe.js";
import { FireflyClient } from "./integrations/firefly.js";
import { HaClient } from "./integrations/homeAssistant.js";
import { OpencodeClient } from "./integrations/opencode.js";
import { log } from "./log.js";
import { RateLimiter } from "./rateLimit.js";
import { SenderLock } from "./senderLock.js";
import { SessionStore } from "./sessionStore.js";
import { buildServer, type ServerDeps } from "./server.js";
import { WahaClient } from "./waha/client.js";
import { Identity } from "./waha/identity.js";

const config = loadConfig();

const waha = new WahaClient(config.wahaBaseUrl, config.wahaApiKey, config.wahaSession);
const identity = new Identity(waha);

const deps: ServerDeps = {
  waha,
  identity,
  rateLimiter: new RateLimiter(config.rateLimitMax, config.rateLimitWindowMs),
  dedupe: new MessageDedupe(5 * 60 * 1000),
  router: {
    ha: new HaClient(config.hassBaseUrl, config.hassToken, config.haWebhookId),
    firefly: new FireflyClient(
      config.fireflyBaseUrl,
      config.fireflyPat,
      config.fireflyDefaultSourceAccount,
    ),
    opencode: new OpencodeClient({
      baseUrl: config.opencodeBaseUrl,
      authHeader: config.opencodeAuthHeader,
      modelProvider: config.opencodeModelProvider,
      modelId: config.opencodeModelId,
    }),
    sessions: new SessionStore(config.sessionsFile),
    senderLock: new SenderLock(),
  },
};

const server = buildServer(config, deps);
server.listen(config.port, () => {
  log(`whatsapp-router listening on :${String(config.port)}`);
});
void identity.ensureLidMap();
