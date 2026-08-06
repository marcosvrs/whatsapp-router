import { normalizeAmount } from "../amount.js";
import { log } from "../log.js";
import type { ActionResult } from "../actionResult.js";

interface FireflyAccount {
  id: string;
  attributes?: { name?: string };
}

interface FireflyAccountsResponse {
  data?: FireflyAccount[];
}

// Success is cached (avoids a lookup on every "money:" message); failure is
// not, since a typo in the configured source-account name lets Firefly's
// source_name silently create a wrong account instead of failing loudly — so
// we resolve the real id up front — but a transient Firefly outage shouldn't
// wedge the feature until restart, so each call retries until it succeeds.
export class FireflyClient {
  private sourceAccountId: string | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly defaultSourceAccount: string,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.token && this.defaultSourceAccount);
  }

  private async resolveSourceAccountId(): Promise<{ id: string } | { error: string }> {
    if (this.sourceAccountId) return { id: this.sourceAccountId };
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/accounts?type=asset&limit=200`, {
        headers: { Accept: "application/json", Authorization: `Bearer ${this.token}` },
      });
      if (!res.ok) return { error: `Firefly accounts lookup failed (${String(res.status)})` };
      const data = (await res.json()) as FireflyAccountsResponse;
      const match = (data.data ?? []).find(
        (a) => a.attributes?.name === this.defaultSourceAccount,
      );
      if (!match) return { error: `Firefly asset account "${this.defaultSourceAccount}" not found.` };
      this.sourceAccountId = match.id;
      return { id: match.id };
    } catch (err) {
      return {
        error: `Firefly accounts lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async logTransaction(text: string): Promise<ActionResult> {
    if (!this.isConfigured()) return { ok: false, text: "Firefly III not configured yet." };

    const match = /^\s*([\d.,]+)\s+(.+)$/.exec(text);
    if (!match) {
      return {
        ok: false,
        text: 'Format: "money: <amount> <description>", e.g. "money: 20 groceries"',
      };
    }
    const rawAmount = match[1] ?? "";
    const amount = normalizeAmount(rawAmount);
    if (!amount) {
      return {
        ok: false,
        text: `Couldn't parse amount "${rawAmount}" — use plain numbers, e.g. "money: 20.50 groceries".`,
      };
    }
    const description = (match[2] ?? "").trim();

    const lookup = await this.resolveSourceAccountId();
    if ("error" in lookup) return { ok: false, text: lookup.error };

    const res = await fetch(`${this.baseUrl}/api/v1/transactions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({
        transactions: [
          {
            type: "withdrawal",
            date: new Date().toISOString(),
            amount,
            description,
            source_id: this.sourceAccountId,
          },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log("firefly failed", res.status, body);
      return { ok: false, text: `Firefly transaction failed (${String(res.status)}).` };
    }
    return { ok: true, text: `Logged: ${amount} — ${description}` };
  }
}
