export interface Config {
  port: number;
  allowedUsers: Set<string>;

  wahaBaseUrl: string;
  wahaApiKey: string;
  wahaSession: string;

  webhookSecret: string;

  hassBaseUrl: string;
  hassToken: string;
  haWebhookId: string;

  fireflyBaseUrl: string;
  fireflyPat: string;
  fireflyDefaultSourceAccount: string;

  opencodeBaseUrl: string;
  opencodeServerUsername: string;
  opencodeServerPassword: string;
  opencodeAuthHeader: string;
  opencodeModelProvider: string;
  opencodeModelId: string;
  opencodeAutoApprove: boolean;

  sessionsFile: string;

  maxBodyBytes: number;
  rateLimitMax: number;
  rateLimitWindowMs: number;
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const opencodeServerUsername = env.OPENCODE_SERVER_USERNAME ?? "opencode";
  const opencodeServerPassword = env.OPENCODE_SERVER_PASSWORD ?? "";
  const opencodeAuthHeader = opencodeServerPassword
    ? `Basic ${Buffer.from(`${opencodeServerUsername}:${opencodeServerPassword}`).toString("base64")}`
    : "";

  return {
    port: Number(env.PORT ?? 8080),
    allowedUsers: new Set(
      (env.WHATSAPP_ALLOWED_USERS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),

    wahaBaseUrl: env.WAHA_BASE_URL ?? "http://waha:3000",
    wahaApiKey: requireEnv(env, "WAHA_API_KEY"),
    wahaSession: env.WAHA_SESSION ?? "default",

    webhookSecret: requireEnv(env, "WEBHOOK_SECRET"),

    hassBaseUrl: env.HASS_BASE_URL ?? "http://host.docker.internal:8123",
    hassToken: env.HASS_TOKEN ?? "",
    haWebhookId: env.HA_WEBHOOK_ID ?? "",

    fireflyBaseUrl: env.FIII_BASE_URL ?? "http://firefly:8080",
    fireflyPat: env.FIII_PAT ?? "",
    fireflyDefaultSourceAccount: env.FIII_DEFAULT_SOURCE_ACCOUNT ?? "",

    opencodeBaseUrl: env.OPENCODE_BASE_URL ?? "http://opencode:4096",
    opencodeServerUsername,
    opencodeServerPassword,
    opencodeAuthHeader,
    opencodeModelProvider: env.OPENCODE_MODEL_PROVIDER ?? "",
    opencodeModelId: env.OPENCODE_MODEL_ID ?? "",
    opencodeAutoApprove: env.OPENCODE_AUTO_APPROVE !== "false",

    sessionsFile: env.SESSIONS_FILE ?? "/app/state/sessions.json",

    maxBodyBytes: 64 * 1024,
    rateLimitMax: Number(env.RATE_LIMIT_MAX ?? 20),
    rateLimitWindowMs: Number(env.RATE_LIMIT_WINDOW_MS ?? 5 * 60 * 1000),
  };
}
