import {
  createOpencodeClient,
  type AssistantMessage,
  type OpencodeClient as SdkClient,
  type Part,
} from "@opencode-ai/sdk";
import { log } from "../log.js";

export interface OpencodeClientOptions {
  baseUrl: string;
  authHeader: string;
  modelProvider: string;
  modelId: string;
}

// Every error variant has a `name`; only some also have a string `data.message`
// (MessageOutputLengthError's `data` is an untyped bag) — narrow explicitly
// rather than assume the shape.
function errorMessage(error: NonNullable<AssistantMessage["error"]>): string {
  const data: unknown = error.data;
  if (
    data &&
    typeof data === "object" &&
    "message" in data &&
    typeof data.message === "string"
  ) {
    return data.message;
  }
  return error.name;
}

export class OpencodeClient {
  private readonly client: SdkClient;
  private readonly authHeader: string;
  private readonly modelProvider: string;
  private readonly modelId: string;

  constructor(options: OpencodeClientOptions) {
    this.authHeader = options.authHeader;
    this.modelProvider = options.modelProvider;
    this.modelId = options.modelId;
    this.client = createOpencodeClient({
      baseUrl: options.baseUrl,
      headers: this.authHeader ? { Authorization: this.authHeader } : undefined,
    });
  }

  isConfigured(): boolean {
    return Boolean(this.authHeader);
  }

  async createSession(): Promise<string> {
    const { data, response } = await this.client.session.create({});
    if (!data) throw new Error(`session create failed: ${String(response.status)}`);
    return data.id;
  }

  private promptMessage(sessionId: string, text: string) {
    return this.client.session.prompt({
      path: { id: sessionId },
      body: {
        parts: [{ type: "text", text }],
        ...(this.modelProvider && this.modelId
          ? { model: { providerID: this.modelProvider, modelID: this.modelId } }
          : {}),
      },
    });
  }

  // Sends text to an existing session; if the session is stale (404 — e.g. the
  // opencode server restarted / db reset), creates a fresh one and retries once.
  // Returns the session id actually used, so the caller can persist it if it changed.
  async send(sessionId: string, text: string): Promise<{ sessionId: string; reply: string }> {
    let currentSessionId = sessionId;
    let result = await this.promptMessage(currentSessionId, text);

    if (result.response.status === 404) {
      currentSessionId = await this.createSession();
      result = await this.promptMessage(currentSessionId, text);
    }

    if (!result.data) {
      throw new Error(`opencode message send failed: ${String(result.response.status)}`);
    }

    const { info, parts } = result.data;
    if (info.error) {
      const errMsg = errorMessage(info.error);
      log("opencode agent error", errMsg);
      return { sessionId: currentSessionId, reply: `Agent error: ${errMsg}` };
    }

    const reply = parts
      .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
      .map((p) => p.text)
      .filter(Boolean)
      .join("\n")
      .trim();
    return { sessionId: currentSessionId, reply: reply || "(no output)" };
  }
}
