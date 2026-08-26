import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WahaClientLike } from "../../src/waha/client.js";
import { PRESENCE_REQUEST_TIMEOUT_MS, TypingPresence } from "../../src/waha/typingKeepAlive.js";

function fakeWaha(): WahaClientLike {
  return {
    sendText: vi.fn().mockResolvedValue(undefined),
    startTyping: vi.fn().mockResolvedValue(undefined),
    stopTyping: vi.fn().mockResolvedValue(undefined),
    markChatRead: vi.fn().mockResolvedValue(undefined),
    sendReaction: vi.fn().mockResolvedValue(undefined),
    editMessage: vi.fn().mockResolvedValue(undefined),
    fetchGroups: vi.fn().mockResolvedValue({}),
    fetchSessionInfo: vi.fn().mockResolvedValue(null),
    downloadMedia: vi.fn().mockResolvedValue(null),
    fetchRecentMessages: vi.fn().mockResolvedValue([]),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TypingPresence", () => {
  it("starts typing immediately on begin()", async () => {
    const waha = fakeWaha();
    new TypingPresence(waha).begin("chat1");
    // begin() runs through the same per-chat lock as send()/end() (so a
    // concurrent second exchange sharing the chat can't race it), which
    // means its own startTyping call happens a tick later, not synchronously.
    await vi.advanceTimersByTimeAsync(0);
    expect(waha.startTyping).toHaveBeenCalledWith("chat1", expect.any(AbortSignal));
  });
  it("bounds a hung initial typing request before sending", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const waha = fakeWaha();
    waha.startTyping = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>(() => undefined))
      .mockResolvedValue(undefined);
    const typing = new TypingPresence(waha);

    typing.begin("chat1");
    await vi.advanceTimersByTimeAsync(0);
    const sendPromise = typing.send("chat1", "hello");
    await vi.advanceTimersByTimeAsync(PRESENCE_REQUEST_TIMEOUT_MS);
    await expect(sendPromise).resolves.toBeUndefined();
    expect(waha.sendText).toHaveBeenCalledWith("chat1", "hello", undefined, expect.any(AbortSignal));
    expect(logSpy.mock.calls.map((call: unknown[]) => call.slice(1))).toContainEqual([
      "startTyping failed",
      "startTyping timed out",
    ]);
    await typing.end("chat1");
  });

  it("bounds a hung stopTyping request and still sends the message", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const waha = fakeWaha();
    waha.stopTyping = vi.fn().mockImplementation(() => new Promise<void>(() => undefined));
    const typing = new TypingPresence(waha);

    const sendPromise = typing.send("chat1", "hello");
    await vi.advanceTimersByTimeAsync(PRESENCE_REQUEST_TIMEOUT_MS);
    await expect(sendPromise).resolves.toBeUndefined();
    expect(waha.sendText).toHaveBeenCalledWith("chat1", "hello", undefined, expect.any(AbortSignal));
    expect(logSpy.mock.calls.map((call: unknown[]) => call.slice(1))).toContainEqual([
      "stopTyping failed",
      "stopTyping timed out",
    ]);
  });


  it("refreshes typing periodically while active", async () => {
    const waha = fakeWaha();
    new TypingPresence(waha).begin("chat1");
    await vi.advanceTimersByTimeAsync(0);
    expect(waha.startTyping).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(waha.startTyping).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(waha.startTyping).toHaveBeenCalledTimes(3);
  });
  it("swallows a periodic refresh failure", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const waha = fakeWaha();
    waha.startTyping = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("refresh failed"));
    const typing = new TypingPresence(waha);
    typing.begin("chat1");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(20_000);
    await typing.end("chat1");
    expect(logSpy.mock.calls.map((call: unknown[]) => call.slice(1))).toContainEqual([
      "startTyping failed",
      "refresh failed",
    ]);
  });

  it("swallows a stop failure during end", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const waha = fakeWaha();
    waha.stopTyping = vi.fn().mockRejectedValueOnce(new Error("stop failed"));
    const typing = new TypingPresence(waha);
    await typing.end("chat1");
    expect(logSpy.mock.calls.map((call: unknown[]) => call.slice(1))).toContainEqual([
      "stopTyping failed",
      "stop failed",
    ]);
  });

  it("handles a typing lock failure during begin", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const typing = new TypingPresence(fakeWaha());
    const failingLock = {
      run: vi.fn().mockRejectedValue(new Error("lock failed")),
    };
    Object.defineProperty(typing, "perChat", { value: failingLock });
    typing.begin("chat1");
    await vi.advanceTimersByTimeAsync(0);
    expect(failingLock.run).toHaveBeenCalledWith("chat1", expect.any(Function));
    expect(logSpy.mock.calls.map((call: unknown[]) => call.slice(1))).toContainEqual([
      "TypingPresence.begin failed",
      "lock failed",
    ]);
  });


  it("brackets a send with stopTyping then sendText then startTyping", async () => {
    const calls: string[] = [];
    const waha: WahaClientLike = {
      ...fakeWaha(),
      stopTyping: vi.fn(() => {
        calls.push("stop");
        return Promise.resolve();
      }),
      sendText: vi.fn(() => {
        calls.push("send");
        return Promise.resolve();
      }),
      startTyping: vi.fn(() => {
        calls.push("start");
        return Promise.resolve();
      }),
    };

    const typing = new TypingPresence(waha);
    typing.begin("chat1");
    await vi.advanceTimersByTimeAsync(0); // let begin()'s deferred startTyping settle first
    calls.length = 0; // discard begin()'s own startTyping call
    await typing.send("chat1", "hello", "msg_1");

    expect(calls).toEqual(["stop", "send", "start"]);
    expect(waha.sendText).toHaveBeenCalledWith("chat1", "hello", "msg_1", expect.any(AbortSignal));
  });

  it("resumes the refresh interval after a send while still active", async () => {
    const waha = fakeWaha();
    const typing = new TypingPresence(waha);
    typing.begin("chat1");
    await typing.send("chat1", "hello");

    (waha.startTyping as ReturnType<typeof vi.fn>).mockClear();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(waha.startTyping).toHaveBeenCalledWith("chat1", expect.any(AbortSignal));
  });

  it("a one-off send() with no prior begin() does not resume typing or leave an interval running", async () => {
    const waha = fakeWaha();
    const typing = new TypingPresence(waha);
    await typing.send("chat1", "hello");
    expect(vi.getTimerCount()).toBe(0);

    expect(waha.stopTyping).toHaveBeenCalledWith("chat1", expect.any(AbortSignal));
    expect(waha.sendText).toHaveBeenCalledWith("chat1", "hello", undefined, expect.any(AbortSignal));
    expect(waha.startTyping).not.toHaveBeenCalled();

    (waha.startTyping as ReturnType<typeof vi.fn>).mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(waha.startTyping).not.toHaveBeenCalled();
  });
  it("still sends the message when stopTyping fails", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const waha = fakeWaha();
    (waha.stopTyping as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("WAHA unavailable"));
    const typing = new TypingPresence(waha);

    await typing.send("chat1", "hello");

    expect(waha.sendText).toHaveBeenCalledWith("chat1", "hello", undefined, expect.any(AbortSignal));
    expect(logSpy.mock.calls.map((call: unknown[]) => call.slice(1))).toContainEqual([
      "stopTyping failed",
      "WAHA unavailable",
    ]);
  });
  it("keeps a successful send successful when typing restart fails", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const waha = fakeWaha();
    const startTyping = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("WAHA unavailable"))
      .mockResolvedValue(undefined);
    waha.startTyping = startTyping;
    const typing = new TypingPresence(waha);

    typing.begin("chat1");
    await vi.advanceTimersByTimeAsync(0);
    await expect(typing.send("chat1", "hello")).resolves.toBeUndefined();
    expect(waha.sendText).toHaveBeenCalledWith("chat1", "hello", undefined, expect.any(AbortSignal));
    expect(logSpy.mock.calls.map((call: unknown[]) => call.slice(1))).toContainEqual([
      "startTyping failed",
      "WAHA unavailable",
    ]);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(startTyping).toHaveBeenCalledTimes(3);
  });

  it("restores typing refresh after sendText fails while active", async () => {
    const waha = fakeWaha();
    const startTyping = waha.startTyping as ReturnType<typeof vi.fn>;
    waha.sendText = vi.fn().mockRejectedValue(new Error("send failed"));
    const typing = new TypingPresence(waha);

    typing.begin("chat1");
    await vi.advanceTimersByTimeAsync(0);
    startTyping.mockClear();

    await expect(typing.send("chat1", "hello")).rejects.toThrow("send failed");
    expect(startTyping).toHaveBeenCalledWith("chat1", expect.any(AbortSignal));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(startTyping).toHaveBeenCalledTimes(2);
  });


  it("uses a signal-aware WAHA send when available", async () => {
    const waha = fakeWaha();
    waha.sendTextWithSignal = vi.fn().mockResolvedValue(undefined);
    const typing = new TypingPresence(waha);

    await expect(typing.send("chat1", "hello")).resolves.toBeUndefined();
    expect(waha.sendTextWithSignal).toHaveBeenCalledWith("chat1", "hello", undefined, expect.any(AbortSignal));
  });
  it("propagates a signal-aware WAHA send failure", async () => {
    const waha = fakeWaha();
    waha.sendTextWithSignal = vi.fn().mockRejectedValue(new Error("send failed"));
    const typing = new TypingPresence(waha);

    await expect(typing.send("chat1", "hello")).rejects.toThrow("send failed");
  });
  it("cancels a signal-aware send when its parent signal aborts", async () => {
    const waha = fakeWaha();
    waha.sendTextWithSignal = vi.fn(
      (_chatId: string, _text: string, _id: string | undefined, signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }),
    );
    const typing = new TypingPresence(waha);
    const controller = new AbortController();
    const send = typing.send("chat1", "hello", undefined, controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await expect(send).rejects.toThrow("aborted");
  });
  it("bounds a hung sendText request while keeping typing state recoverable", async () => {
    const waha = fakeWaha();
    waha.sendText = vi.fn().mockImplementation(() => new Promise<void>(() => undefined));
    const typing = new TypingPresence(waha);
    typing.begin("chat1");
    await vi.advanceTimersByTimeAsync(0);

    const sendPromise = typing.send("chat1", "hello");
    const rejection = expect(sendPromise).rejects.toThrow("sendText timed out");
    await vi.advanceTimersByTimeAsync(PRESENCE_REQUEST_TIMEOUT_MS);
    await rejection;
    expect(waha.startTyping).toHaveBeenCalledWith("chat1", expect.any(AbortSignal));
    await typing.end("chat1");
  });
  it("orders an in-flight refresh before stopTyping and sendText", async () => {
    const calls: string[] = [];
    let releaseRefresh!: () => void;
    const waha: WahaClientLike = {
      ...fakeWaha(),
      startTyping: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              calls.push("refresh-start");
              releaseRefresh = () => {
                calls.push("refresh-end");
                resolve();
              };
            }),
        ),
      stopTyping: vi.fn(() => {
        calls.push("stop");
        return Promise.resolve();
      }),
      sendText: vi.fn(() => {
        calls.push("send");
        return Promise.resolve();
      }),
    };
    const typing = new TypingPresence(waha);
    typing.begin("chat1");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(20_000);
    const sendPromise = typing.send("chat1", "hello");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["refresh-start"]);

    releaseRefresh();
    await sendPromise;
    expect(calls).toEqual(["refresh-start", "refresh-end", "stop", "send"]);
  });

  it("end() stops the refresh interval and calls stopTyping", async () => {
    const waha = fakeWaha();
    const typing = new TypingPresence(waha);
    typing.begin("chat1");
    await typing.end("chat1");

    expect(waha.stopTyping).toHaveBeenCalledWith("chat1", expect.any(AbortSignal));

    (waha.startTyping as ReturnType<typeof vi.fn>).mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(waha.startTyping).not.toHaveBeenCalled();
  });

  it("send() after end() does not resume the interval either", async () => {
    const waha = fakeWaha();
    const typing = new TypingPresence(waha);
    typing.begin("chat1");
    await typing.end("chat1");

    (waha.startTyping as ReturnType<typeof vi.fn>).mockClear();
    await typing.send("chat1", "late message");
    expect(waha.startTyping).not.toHaveBeenCalled();
  });

  it("tracks multiple chats independently", async () => {
    const waha = fakeWaha();
    const typing = new TypingPresence(waha);
    typing.begin("chat1");
    await typing.end("chat2"); // never began — should be a harmless no-op besides stopTyping

    (waha.startTyping as ReturnType<typeof vi.fn>).mockClear();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(waha.startTyping).toHaveBeenCalledWith("chat1", expect.any(AbortSignal));
    expect(waha.startTyping).not.toHaveBeenCalledWith("chat2", expect.any(AbortSignal));
  });

  it("two concurrent exchanges sharing a chat (e.g. two senders in one group) don't leak an interval or end each other's typing early", async () => {
    const waha = fakeWaha();
    const typing = new TypingPresence(waha);

    typing.begin("chat1"); // exchange A (sender 1)
    await vi.advanceTimersByTimeAsync(0);
    typing.begin("chat1"); // exchange B (sender 2), same chat — SenderLock only serializes per sender
    await vi.advanceTimersByTimeAsync(0);

    // Only one refresh interval should be running for the chat, not two.
    (waha.startTyping as ReturnType<typeof vi.fn>).mockClear();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(waha.startTyping).toHaveBeenCalledTimes(1);

    // Exchange A finishes first — typing must stay up, B is still going.
    await typing.end("chat1");
    (waha.stopTyping as ReturnType<typeof vi.fn>).mockClear();
    (waha.startTyping as ReturnType<typeof vi.fn>).mockClear();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(waha.stopTyping).not.toHaveBeenCalled();
    expect(waha.startTyping).toHaveBeenCalledWith("chat1", expect.any(AbortSignal));

    // Exchange B finishes too — now it should actually stop.
    await typing.end("chat1");
    expect(waha.stopTyping).toHaveBeenCalledWith("chat1", expect.any(AbortSignal));
    (waha.startTyping as ReturnType<typeof vi.fn>).mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(waha.startTyping).not.toHaveBeenCalled();
  });
});
