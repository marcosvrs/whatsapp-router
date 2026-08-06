import { log } from "../log.js";

export interface WahaGroupParticipant {
  id?: string;
  phoneNumber?: string;
}

export interface WahaGroup {
  participants?: WahaGroupParticipant[];
}

export interface WahaSessionInfo {
  me?: {
    id?: string;
    lid?: string;
  };
}

export interface WahaClientLike {
  sendText: (chatId: string, text: string) => Promise<void>;
  fetchGroups: () => Promise<Record<string, WahaGroup>>;
  fetchSessionInfo: () => Promise<WahaSessionInfo | null>;
}

export class WahaClient implements WahaClientLike {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly session: string,
  ) {}

  async sendText(chatId: string, text: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/sendText`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": this.apiKey },
      body: JSON.stringify({ session: this.session, chatId, text }),
    });
    if (!res.ok) {
      log("sendText failed", res.status, await res.text().catch(() => ""));
    }
  }

  async fetchGroups(): Promise<Record<string, WahaGroup>> {
    const res = await fetch(`${this.baseUrl}/api/${this.session}/groups`, {
      headers: { "X-Api-Key": this.apiKey },
    });
    if (!res.ok) return {};
    return (await res.json()) as Record<string, WahaGroup>;
  }

  async fetchSessionInfo(): Promise<WahaSessionInfo | null> {
    const res = await fetch(`${this.baseUrl}/api/sessions/${this.session}`, {
      headers: { "X-Api-Key": this.apiKey },
    });
    if (!res.ok) return null;
    return (await res.json()) as WahaSessionInfo;
  }
}
