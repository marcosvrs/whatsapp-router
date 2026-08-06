import { log } from "../log.js";

export interface WahaGroupParticipant {
  id?: string;
  phoneNumber?: string;
}

export interface WahaGroup {
  subject?: string;
  participants?: WahaGroupParticipant[];
}

export interface WahaSessionInfo {
  me?: {
    id?: string;
    lid?: string;
  };
}

export interface WahaClientLike {
  sendText: (chatId: string, text: string, id?: string) => Promise<void>;
  startTyping: (chatId: string) => Promise<void>;
  markChatRead: (chatId: string) => Promise<void>;
  sendReaction: (messageId: string, reaction: string) => Promise<void>;
  editMessage: (chatId: string, messageId: string, text: string) => Promise<void>;
  fetchGroups: () => Promise<Record<string, WahaGroup>>;
  fetchSessionInfo: () => Promise<WahaSessionInfo | null>;
  downloadMedia: (url: string) => Promise<string | null>;
}

export class WahaClient implements WahaClientLike {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly session: string,
  ) {}

  private call(method: string, path: string, body: unknown): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { "Content-Type": "application/json", "X-Api-Key": this.apiKey },
      body: JSON.stringify(body),
    });
  }

  private async logIfFailed(action: string, res: Response): Promise<void> {
    if (!res.ok) {
      log(`${action} failed`, res.status, await res.text().catch(() => ""));
    }
  }

  async sendText(chatId: string, text: string, id?: string): Promise<void> {
    const res = await this.call("POST", "/api/sendText", {
      session: this.session,
      chatId,
      text,
      ...(id ? { id } : {}),
    });
    await this.logIfFailed("sendText", res);
  }

  async startTyping(chatId: string): Promise<void> {
    const res = await this.call("POST", "/api/startTyping", { session: this.session, chatId });
    await this.logIfFailed("startTyping", res);
  }

  async markChatRead(chatId: string): Promise<void> {
    const res = await this.call(
      "POST",
      `/api/${this.session}/chats/${encodeURIComponent(chatId)}/messages/read`,
      {},
    );
    await this.logIfFailed("markChatRead", res);
  }

  async sendReaction(messageId: string, reaction: string): Promise<void> {
    const res = await this.call("PUT", "/api/reaction", {
      session: this.session,
      messageId,
      reaction,
    });
    await this.logIfFailed("sendReaction", res);
  }

  // WAHA's real message ids are composite ("true_<chatId>_<rawId>", confirmed
  // against a live message) — editMessage only ever targets a message this
  // client itself just sent, so fromMe is always "true". `messageId` is the
  // same raw id passed to sendText's `id` field.
  async editMessage(chatId: string, messageId: string, text: string): Promise<void> {
    const composedId = `true_${chatId}_${messageId}`;
    const res = await this.call(
      "PUT",
      `/api/${this.session}/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(composedId)}`,
      { text },
    );
    await this.logIfFailed("editMessage", res);
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

  // `url` is the absolute URL WAHA reported in the message payload's
  // media.url field — its host can't be trusted (WAHA has reported
  // "localhost", meaningless from inside a different container), so only
  // the path is kept; the origin always comes from this client's own
  // configured baseUrl.
  async downloadMedia(url: string): Promise<string | null> {
    try {
      const parsed = new URL(url);
      const res = await fetch(`${this.baseUrl}${parsed.pathname}${parsed.search}`, {
        headers: { "X-Api-Key": this.apiKey },
      });
      if (!res.ok) {
        log("downloadMedia failed", res.status, await res.text().catch(() => ""));
        return null;
      }
      return Buffer.from(await res.arrayBuffer()).toString("base64");
    } catch (err) {
      log("downloadMedia failed", err instanceof Error ? err.message : String(err));
      return null;
    }
  }
}
