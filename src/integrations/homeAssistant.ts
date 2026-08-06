export class HaClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly webhookId: string,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.webhookId && this.token);
  }

  async trigger(text: string): Promise<string> {
    if (!this.isConfigured()) return "Home Assistant webhook not configured yet.";
    const res = await fetch(`${this.baseUrl}/api/webhook/${this.webhookId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ text }),
    });
    return res.ok ? "Sent to Home Assistant." : `HA webhook failed (${String(res.status)}).`;
  }
}
