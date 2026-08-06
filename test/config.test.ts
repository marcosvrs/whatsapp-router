import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

function baseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { WAHA_API_KEY: "waha-key", WEBHOOK_SECRET: "webhook-secret", ...overrides };
}

describe("loadConfig", () => {
  it("throws when a required var is missing", () => {
    expect(() => loadConfig({})).toThrow("WAHA_API_KEY is required");
  });

  it("throws for a missing WEBHOOK_SECRET specifically", () => {
    expect(() => loadConfig({ WAHA_API_KEY: "k" })).toThrow("WEBHOOK_SECRET is required");
  });

  it("applies sensible defaults when only the required vars are set", () => {
    const config = loadConfig(baseEnv());
    expect(config).toEqual({
      port: 8080,
      allowedUsers: new Set(),
      wahaBaseUrl: "http://waha:3000",
      wahaApiKey: "waha-key",
      wahaSession: "default",
      webhookSecret: "webhook-secret",
      hassBaseUrl: "http://host.docker.internal:8123",
      hassToken: "",
      haWebhookId: "",
      fireflyBaseUrl: "http://firefly:8080",
      fireflyPat: "",
      fireflyDefaultSourceAccount: "",
      opencodeBaseUrl: "http://opencode:4096",
      opencodeServerUsername: "opencode",
      opencodeServerPassword: "",
      opencodeAuthHeader: "",
      opencodeModelProvider: "",
      opencodeModelId: "",
      opencodeAutoApprove: true,
      sessionsFile: "/app/state/sessions.json",
      maxBodyBytes: 65536,
      rateLimitMax: 20,
      rateLimitWindowMs: 300000,
    });
  });

  it("passes every string var straight through when overridden", () => {
    const config = loadConfig(
      baseEnv({
        PORT: "9090",
        WAHA_BASE_URL: "http://waha-override:3000",
        WAHA_SESSION: "override-session",
        HASS_BASE_URL: "http://ha-override:8123",
        HASS_TOKEN: "ha-token",
        HA_WEBHOOK_ID: "hook-id",
        FIII_BASE_URL: "http://firefly-override:8080",
        FIII_PAT: "firefly-pat",
        FIII_DEFAULT_SOURCE_ACCOUNT: "Checking",
        OPENCODE_BASE_URL: "http://opencode-override:4096",
        OPENCODE_MODEL_PROVIDER: "openai",
        OPENCODE_MODEL_ID: "gpt-5.6-luna",
        SESSIONS_FILE: "/custom/sessions.json",
      }),
    );
    expect(config.port).toBe(9090);
    expect(config.wahaBaseUrl).toBe("http://waha-override:3000");
    expect(config.wahaSession).toBe("override-session");
    expect(config.hassBaseUrl).toBe("http://ha-override:8123");
    expect(config.hassToken).toBe("ha-token");
    expect(config.haWebhookId).toBe("hook-id");
    expect(config.fireflyBaseUrl).toBe("http://firefly-override:8080");
    expect(config.fireflyPat).toBe("firefly-pat");
    expect(config.fireflyDefaultSourceAccount).toBe("Checking");
    expect(config.opencodeBaseUrl).toBe("http://opencode-override:4096");
    expect(config.opencodeModelProvider).toBe("openai");
    expect(config.opencodeModelId).toBe("gpt-5.6-luna");
    expect(config.sessionsFile).toBe("/custom/sessions.json");
  });

  it("defaults RATE_LIMIT_WINDOW_MS to 5 minutes in milliseconds", () => {
    expect(loadConfig(baseEnv()).rateLimitWindowMs).toBe(300000);
  });

  it("defaults maxBodyBytes to exactly 64 KiB, not configurable via env", () => {
    expect(loadConfig(baseEnv({ MAX_BODY_BYTES: "1" })).maxBodyBytes).toBe(65536);
  });

  it("parses a comma-separated allowlist, trimming whitespace and dropping empties", () => {
    const config = loadConfig(baseEnv({ WHATSAPP_ALLOWED_USERS: " 111, 222,,333 " }));
    expect(config.allowedUsers).toEqual(new Set(["111", "222", "333"]));
  });

  it("builds a Basic auth header from the opencode username/password", () => {
    const config = loadConfig(
      baseEnv({ OPENCODE_SERVER_USERNAME: "user", OPENCODE_SERVER_PASSWORD: "pass" }),
    );
    expect(config.opencodeAuthHeader).toBe(`Basic ${Buffer.from("user:pass").toString("base64")}`);
  });

  it("defaults the opencode username to 'opencode' when only a password is set", () => {
    const config = loadConfig(baseEnv({ OPENCODE_SERVER_PASSWORD: "pass" }));
    expect(config.opencodeAuthHeader).toBe(
      `Basic ${Buffer.from("opencode:pass").toString("base64")}`,
    );
  });

  it("treats OPENCODE_AUTO_APPROVE=false as disabled, anything else as enabled", () => {
    expect(loadConfig(baseEnv({ OPENCODE_AUTO_APPROVE: "false" })).opencodeAutoApprove).toBe(
      false,
    );
    expect(loadConfig(baseEnv({ OPENCODE_AUTO_APPROVE: "true" })).opencodeAutoApprove).toBe(true);
    expect(loadConfig(baseEnv()).opencodeAutoApprove).toBe(true);
  });

  it("parses numeric overrides for rate limiting", () => {
    const config = loadConfig(
      baseEnv({ RATE_LIMIT_MAX: "5", RATE_LIMIT_WINDOW_MS: "1000" }),
    );
    expect(config.rateLimitMax).toBe(5);
    expect(config.rateLimitWindowMs).toBe(1000);
  });
});
