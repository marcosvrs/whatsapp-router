import { log } from "../log.js";
import { SenderLock } from "../senderLock.js";
import type { WahaClientLike } from "./client.js";

// WAHA doesn't document an exact expiry for the typing indicator, so it's
// refreshed periodically while an exchange is still in progress.
const TYPING_REFRESH_MS = 20_000;

function logStartTypingFailure(err: unknown): void {
  log("startTyping failed", err instanceof Error ? err.message : String(err));
}

// Keeps WhatsApp's typing indicator visible across a whole agent exchange,
// including any background-task rounds that complete after the first reply.
// Bundles WAHA's own documented bracket (startTyping -> wait -> stopTyping ->
// sendText) into send(). Whether send() resumes typing afterward is driven by
// whether begin()/end() currently consider the chat "active" — a one-off
// caller that never calls begin() gets a single clean bracketed send with
// nothing left running, without having to remember to call end() itself.
export class TypingPresence {
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly active = new Set<string>();
  // Multiple turns can complete close together during a streamed exchange —
  // send()/end() calls for the same chat are serialized so delivery always
  // happens in the order it was requested, not in whichever order their HTTP
  // round trips happen to resolve.
  private readonly perChat = new SenderLock();

  constructor(private readonly waha: WahaClientLike) {}

  begin(chatId: string): void {
    this.active.add(chatId);
    void this.waha.startTyping(chatId).catch(logStartTypingFailure);
    this.scheduleRefresh(chatId);
  }

  send(chatId: string, text: string): Promise<void> {
    return this.perChat.run(chatId, async () => {
      this.pauseInterval(chatId);
      await this.waha.stopTyping(chatId);
      await this.waha.sendText(chatId, text);
      if (this.active.has(chatId)) {
        await this.waha.startTyping(chatId);
        this.scheduleRefresh(chatId);
      }
    });
  }

  end(chatId: string): Promise<void> {
    return this.perChat.run(chatId, async () => {
      this.active.delete(chatId);
      this.pauseInterval(chatId);
      await this.waha.stopTyping(chatId);
    });
  }

  private pauseInterval(chatId: string): void {
    const timer = this.timers.get(chatId);
    if (timer) clearInterval(timer);
    this.timers.delete(chatId);
  }

  private scheduleRefresh(chatId: string): void {
    this.timers.set(
      chatId,
      setInterval(() => void this.waha.startTyping(chatId).catch(logStartTypingFailure), TYPING_REFRESH_MS),
    );
  }
}
