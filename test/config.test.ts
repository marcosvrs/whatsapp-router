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
    expect(config.port).toBe(8080);
    expect(config.allowedUsers.size).toBe(0);
    expect(config.wahaBaseUrl).toBe("http://waha:3000");
    expect(config.wahaSession).toBe("default");
    expect(config.opencodeAuthHeader).toBe("");
    expect(config.opencodeAutoApprove).toBe(true);
    expect(config.maxBodyBytes).toBe(64 * 1024);
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
