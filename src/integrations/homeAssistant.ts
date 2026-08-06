import type { ActionResult } from "../actionResult.js";

export class HaClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly webhookId: string,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.webhookId && this.token);
  }

  async trigger(text: string): Promise<ActionResult> {
    if (!this.isConfigured()) {
      return { ok: false, text: "Home Assistant webhook not configured yet." };
    }
    const res = await fetch(`${this.baseUrl}/api/webhook/${this.webhookId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ text }),
    });
    return res.ok
      ? { ok: true, text: "Sent to Home Assistant." }
      : { ok: false, text: `HA webhook failed (${String(res.status)}).` };
  }
}
