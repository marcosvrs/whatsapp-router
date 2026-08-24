import { debug, error, warn } from "../log.js";
import { SenderLock } from "../senderLock.js";
import type { WahaClientLike } from "./client.js";

// WAHA doesn't document an exact expiry for the typing indicator, so it's
// refreshed periodically while an exchange is still in progress.
const TYPING_REFRESH_MS = 20_000;
export const PRESENCE_REQUEST_TIMEOUT_MS = 10_000;

function boundedPresenceRequest(
  action: string,
  request: (signal: AbortSignal) => Promise<void>,
): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`${action} timed out`));
    }, PRESENCE_REQUEST_TIMEOUT_MS);
  });
  return Promise.race([Promise.resolve().then(() => request(controller.signal)), timeout]).finally(() => {
    clearTimeout(timer);
  });
}

function logStartTypingFailure(err: unknown): void {
  warn("startTyping failed", err instanceof Error ? err.message : String(err));
}

// Keeps WhatsApp's typing indicator visible across a whole agent exchange,
// including any background-task rounds that complete after the first reply.
// Bundles WAHA's own documented bracket (startTyping -> wait -> stopTyping ->
// sendText) into send(). Whether send() resumes typing afterward is driven by
// whether the chat is still "active" — a one-off caller that never calls
// begin() gets a single clean bracketed send with nothing left running,
// without having to remember to call end() itself.
//
// State is refcounted per chat, not just a boolean: allowlist.ts's group
// handling lets multiple different senders concurrently trigger the bot in
// the same group chat. SenderLock only serializes per sender, so two
// overlapping exchanges can share one chatId. All three mutating operations
// (begin/send/end) go through the same per-chat lock so they cannot race each
// other, and end() only truly ends the chat once the last concurrent exchange
// has finished.
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
          await boundedPresenceRequest("startTyping", (signal) => this.waha.startTyping(chatId, signal)).catch(
            logStartTypingFailure,
          );
          this.scheduleRefresh(chatId);
        }
      })
      .catch((err: unknown) => {
        error("TypingPresence.begin failed", err instanceof Error ? err.message : String(err));
      });
  }

  send(chatId: string, text: string, id?: string): Promise<void> {
    return this.perChat.run(chatId, async () => {
      debug("sending WhatsApp reply", chatId, id ?? "without-id");
      this.pauseInterval(chatId);
      // Presence cleanup is best-effort. A transient WAHA failure must never
      // suppress the actual reply, and the message id may already be marked
      // delivered by the caller's dedupe set.
      await boundedPresenceRequest("stopTyping", (signal) => this.waha.stopTyping(chatId, signal)).catch(
        (err: unknown) => {
          warn("stopTyping failed", err instanceof Error ? err.message : String(err));
        },
      );
      if (id) await this.waha.sendText(chatId, text, id);
      else await this.waha.sendText(chatId, text);
      if ((this.activeCount.get(chatId) ?? 0) > 0) {
        await boundedPresenceRequest("startTyping", (signal) => this.waha.startTyping(chatId, signal)).catch(
          logStartTypingFailure,
        );
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
      await boundedPresenceRequest("stopTyping", (signal) => this.waha.stopTyping(chatId, signal)).catch(
        (err: unknown) => {
          warn("stopTyping failed", err instanceof Error ? err.message : String(err));
        },
      );
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
      setInterval(() => {
        void this.perChat
          .run(chatId, async () => {
            if ((this.activeCount.get(chatId) ?? 0) > 0) {
              await boundedPresenceRequest("startTyping", (signal) => this.waha.startTyping(chatId, signal));
            }
          })
          .catch((err: unknown) => {
            logStartTypingFailure(err);
          });
      }, TYPING_REFRESH_MS),
    );
  }
}
