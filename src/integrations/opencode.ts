import { log } from "../log.js";

interface OpencodeMessagePart {
  type: string;
  text?: string;
}

interface OpencodeMessageResponse {
  info?: {
    error?: {
      name?: string;
      data?: { message?: string };
    };
  };
  parts?: OpencodeMessagePart[];
}

interface OpencodeSessionResponse {
  id: string;
}

export interface OpencodeClientOptions {
  baseUrl: string;
  authHeader: string;
  modelProvider: string;
  modelId: string;
  autoApprove: boolean;
}

export class OpencodeClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly modelProvider: string;
  private readonly modelId: string;
  private readonly autoApprove: boolean;

  constructor(options: OpencodeClientOptions) {
    this.baseUrl = options.baseUrl;
    this.authHeader = options.authHeader;
    this.modelProvider = options.modelProvider;
    this.modelId = options.modelId;
    this.autoApprove = options.autoApprove;
  }

  isConfigured(): boolean {
    return Boolean(this.authHeader);
  }

  async createSession(): Promise<string> {
    // Matches the CLI's --auto flag (auto-approve permissions not explicitly
    // denied). Required here too: there's no interactive channel to approve a
    // gated tool call, so without this a conversation that triggers one just
    // hangs forever.
    const body = this.autoApprove
      ? { permission: [{ permission: "*", pattern: "*", action: "allow" }] }
      : {};
    const res = await fetch(`${this.baseUrl}/session`, {
      method: "POST",
      headers: { Authorization: this.authHeader, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`session create failed: ${String(res.status)}`);
    const session = (await res.json()) as OpencodeSessionResponse;
    return session.id;
  }

  private async sendMessage(
    sessionId: string,
    text: string,
  ): Promise<{ status: number; msg: OpencodeMessageResponse }> {
    const body: Record<string, unknown> = { parts: [{ type: "text", text }] };
    if (this.modelProvider && this.modelId) {
      body.model = { providerID: this.modelProvider, modelID: this.modelId };
    }
    const res = await fetch(`${this.baseUrl}/session/${sessionId}/message`, {
      method: "POST",
      headers: { Authorization: this.authHeader, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, msg: (await res.json()) as OpencodeMessageResponse };
  }

  // Sends text to an existing session; if the session is stale (404 — e.g. the
  // opencode server restarted / db reset), creates a fresh one and retries once.
  // Returns the session id actually used, so the caller can persist it if it changed.
  async send(sessionId: string, text: string): Promise<{ sessionId: string; reply: string }> {
    let currentSessionId = sessionId;
    const first = await this.sendMessage(currentSessionId, text);
    let msg = first.msg;

    if (first.status === 404) {
      currentSessionId = await this.createSession();
      msg = (await this.sendMessage(currentSessionId, text)).msg;
    }

    if (msg.info?.error) {
      const errMsg = msg.info.error.data?.message ?? msg.info.error.name ?? "unknown error";
      log("opencode agent error", errMsg);
      return { sessionId: currentSessionId, reply: `Agent error: ${errMsg}` };
    }

    const reply = (msg.parts ?? [])
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("\n")
      .trim();
    return { sessionId: currentSessionId, reply: reply || "(no output)" };
  }
}
