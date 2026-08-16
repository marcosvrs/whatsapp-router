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
// whether the chat is still "active" — a one-off caller that never calls
// begin() gets a single clean bracketed send with nothing left running,
// without having to remember to call end() itself.
//
// State is refcounted per chat, not just a boolean: `allowlist.ts`'s group
// handling lets multiple different senders concurrently trigger the bot in
// the same group chat — SenderLock only serializes per *sender*, so two
// overlapping exchanges can share one chatId. A boolean "active" set would
// let the second exchange's begin() silently replace the first's interval
// (leaking the old one), and whichever exchange finishes first would call
// end() and kill typing out from under the other, still-running one. All
// three mutating operations (begin/send/end) go through the same per-chat
// lock so they can't race each other, and end() only truly ends the chat
// once the last concurrent exchange for it has finished.
export class TypingPresence {
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly activeCount = new Map<string, number>();
  private readonly perChat = new SenderLock();

  constructor(private readonly waha: WahaClientLike) {}

  begin(chatId: string): void {
    void this.perChat
      .run(chatId, async () => {
        const count = (this.activeCount.get(chatId) ?? 0) + 1;
        this.activeCount.set(chatId, count);
        if (count === 1) {
          await this.waha.startTyping(chatId).catch(logStartTypingFailure);
          this.scheduleRefresh(chatId);
        }
      })
      .catch((err: unknown) => {
        log("TypingPresence.begin failed", err instanceof Error ? err.message : String(err));
      });
  }

  send(chatId: string, text: string): Promise<void> {
    return this.perChat.run(chatId, async () => {
      this.pauseInterval(chatId);
      await this.waha.stopTyping(chatId);
      await this.waha.sendText(chatId, text);
      if ((this.activeCount.get(chatId) ?? 0) > 0) {
        await this.waha.startTyping(chatId);
        this.scheduleRefresh(chatId);
      }
    });
  }

  end(chatId: string): Promise<void> {
    return this.perChat.run(chatId, async () => {
      const count = Math.max((this.activeCount.get(chatId) ?? 0) - 1, 0);
      if (count > 0) {
        this.activeCount.set(chatId, count);
        return;
      }
      this.activeCount.delete(chatId);
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
