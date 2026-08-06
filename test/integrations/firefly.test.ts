import { afterEach, describe, expect, it, vi } from "vitest";
import { FireflyClient } from "../../src/integrations/firefly.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FireflyClient", () => {
  it("reports not configured when the token is missing", async () => {
    const client = new FireflyClient("http://firefly.test", "", "Checking");
    expect(client.isConfigured()).toBe(false);
    expect(await client.logTransaction("20 groceries")).toBe("Firefly III not configured yet.");
  });

  it("reports not configured when the default source account is missing", () => {
    const client = new FireflyClient("http://firefly.test", "token", "");
    expect(client.isConfigured()).toBe(false);
  });

  it("reports configured when both token and source account are set", () => {
    const client = new FireflyClient("http://firefly.test", "token", "Checking");
    expect(client.isConfigured()).toBe(true);
  });

  it("returns a format hint when the text doesn't match amount+description", async () => {
    const client = new FireflyClient("http://firefly.test", "token", "Checking");
    const reply = await client.logTransaction("groceries");
    expect(reply).toContain("Format:");
  });

  it("returns a parse error for an amount that matches the shape but not the number format", async () => {
    // "1.2.3" matches [\d.,]+ but normalizeAmount rejects it (multiple decimal points).
    const client = new FireflyClient("http://firefly.test", "token", "Checking");
    const reply = await client.logTransaction("1.2.3 groceries");
    expect(reply).toContain('Couldn\'t parse amount "1.2.3"');
  });

  it("returns a not-found message when the configured account doesn't exist", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ data: [] })));
    const client = new FireflyClient("http://firefly.test", "token", "Checking");
    const reply = await client.logTransaction("20 groceries");
    expect(reply).toBe('Firefly asset account "Checking" not found.');
  });

  it("returns a not-found message when the account list omits the matching name", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ data: [{ id: "1", attributes: { name: "Savings" } }] })),
    );
    const client = new FireflyClient("http://firefly.test", "token", "Checking");
    const reply = await client.logTransaction("20 groceries");
    expect(reply).toBe('Firefly asset account "Checking" not found.');
  });

  it("requests the accounts lookup with the exact url, method, and headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new FireflyClient("http://firefly.test", "secret-token", "Checking");
    await client.logTransaction("20 groceries");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://firefly.test/api/v1/accounts?type=asset&limit=200");
    expect(init.headers).toEqual({
      Accept: "application/json",
      Authorization: "Bearer secret-token",
    });
  });

  it("returns a failure message and does not throw when the accounts fetch itself rejects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const client = new FireflyClient("http://firefly.test", "token", "Checking");
    const reply = await client.logTransaction("20 groceries");
    expect(reply).toBe("Firefly accounts lookup failed: network down");
  });

  it("looks up the account once, then reuses it across calls", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/accounts")) {
        return Promise.resolve(
          jsonResponse({ data: [{ id: "42", attributes: { name: "Checking" } }] }),
        );
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new FireflyClient("http://firefly.test", "token", "Checking");
    await client.logTransaction("20 groceries");
    await client.logTransaction("5 coffee");

    const accountLookups = fetchMock.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && call[0].includes("/accounts"),
    );
    expect(accountLookups).toHaveLength(1);
  });

  it("posts a withdrawal transaction with the normalized amount and resolved source_id", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/accounts")) {
        return Promise.resolve(
          jsonResponse({ data: [{ id: "42", attributes: { name: "Checking" } }] }),
        );
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new FireflyClient("http://firefly.test", "token", "Checking");
    const reply = await client.logTransaction("1,234.56 rent");

    expect(reply).toBe("Logged: 1234.56 — rent");
    const transactionCall = fetchMock.mock.calls.find(
      (call: unknown[]) => typeof call[0] === "string" && call[0].includes("/transactions"),
    ) as [string, RequestInit];
    const body = JSON.parse(transactionCall[1].body as string) as {
      transactions: { source_id: string; amount: string; description: string }[];
    };
    expect(body.transactions[0]).toEqual({
      type: "withdrawal",
      date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/) as string,
      amount: "1234.56",
      description: "rent",
      source_id: "42",
    });
    expect(transactionCall[0]).toBe("http://firefly.test/api/v1/transactions");
    expect(transactionCall[1].method).toBe("POST");
    expect(transactionCall[1].headers).toEqual({
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: "Bearer token",
    });
  });

  it("returns a failure message when the transaction post fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("/accounts")) {
          return Promise.resolve(
            jsonResponse({ data: [{ id: "42", attributes: { name: "Checking" } }] }),
          );
        }
        return Promise.resolve(new Response(null, { status: 500 }));
      }),
    );

    const client = new FireflyClient("http://firefly.test", "token", "Checking");
    const reply = await client.logTransaction("20 groceries");
    expect(reply).toBe("Firefly transaction failed (500).");
  });

  it("logs the exact status and response body when the transaction post fails", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("/accounts")) {
          return Promise.resolve(
            jsonResponse({ data: [{ id: "42", attributes: { name: "Checking" } }] }),
          );
        }
        return Promise.resolve(new Response("server exploded", { status: 500 }));
      }),
    );
    const client = new FireflyClient("http://firefly.test", "token", "Checking");
    await client.logTransaction("20 groceries");

    const logged = logSpy.mock.calls.map((call: unknown[]) => call.slice(1));
    expect(logged).toContainEqual(["firefly failed", 500, "server exploded"]);
    logSpy.mockRestore();
  });

  it("retries the account lookup on the next call after a transient failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "42", attributes: { name: "Checking" } }] }))
      .mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new FireflyClient("http://firefly.test", "token", "Checking");
    const first = await client.logTransaction("20 groceries");
    expect(first).toBe("Firefly accounts lookup failed (500)");

    const second = await client.logTransaction("20 groceries");
    expect(second).toBe("Logged: 20 — groceries");
  });
});
