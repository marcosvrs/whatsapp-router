import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WahaClientLike } from "../../src/waha/client.js";
import { TypingPresence } from "../../src/waha/typingKeepAlive.js";

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
  it("starts typing immediately on begin()", () => {
    const waha = fakeWaha();
    new TypingPresence(waha).begin("chat1");
    expect(waha.startTyping).toHaveBeenCalledWith("chat1");
  });

  it("refreshes typing periodically while active", async () => {
    const waha = fakeWaha();
    new TypingPresence(waha).begin("chat1");
    expect(waha.startTyping).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(waha.startTyping).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(waha.startTyping).toHaveBeenCalledTimes(3);
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
    calls.length = 0; // discard begin()'s own startTyping call
    await typing.send("chat1", "hello");

    expect(calls).toEqual(["stop", "send", "start"]);
    expect(waha.sendText).toHaveBeenCalledWith("chat1", "hello");
  });

  it("resumes the refresh interval after a send while still active", async () => {
    const waha = fakeWaha();
    const typing = new TypingPresence(waha);
    typing.begin("chat1");
    await typing.send("chat1", "hello");

    (waha.startTyping as ReturnType<typeof vi.fn>).mockClear();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(waha.startTyping).toHaveBeenCalledWith("chat1");
  });

  it("a one-off send() with no prior begin() does not resume typing or leave an interval running", async () => {
    const waha = fakeWaha();
    const typing = new TypingPresence(waha);
    await typing.send("chat1", "hello");

    expect(waha.stopTyping).toHaveBeenCalledWith("chat1");
    expect(waha.sendText).toHaveBeenCalledWith("chat1", "hello");
    expect(waha.startTyping).not.toHaveBeenCalled();

    (waha.startTyping as ReturnType<typeof vi.fn>).mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(waha.startTyping).not.toHaveBeenCalled();
  });

  it("end() stops the refresh interval and calls stopTyping", async () => {
    const waha = fakeWaha();
    const typing = new TypingPresence(waha);
    typing.begin("chat1");
    await typing.end("chat1");

    expect(waha.stopTyping).toHaveBeenCalledWith("chat1");

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
    expect(waha.startTyping).toHaveBeenCalledWith("chat1");
    expect(waha.startTyping).not.toHaveBeenCalledWith("chat2");
  });
});
