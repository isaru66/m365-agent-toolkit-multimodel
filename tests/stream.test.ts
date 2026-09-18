import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TeamsReplyStream, type StreamActivity } from "../src/bot/stream.js";

describe("Teams native streaming", () => {
  beforeEach(() => vi.useFakeTimers({ now: 100000 }));
  afterEach(() => vi.useRealTimers());

  it("streams cumulative content before completion with monotonic sequence and final labeling", async () => {
    const sent: StreamActivity[] = [];
    const stream = new TeamsReplyStream(async (activity) => {
      sent.push(activity);
      return sent.length === 1 ? { id: "stream-id" } : {};
    }, vi.fn());
    await stream.start("Generating...");
    stream.append("Hello");
    await vi.advanceTimersByTimeAsync(1800);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.text).toBe("Hello");
    stream.append(" world");
    await vi.advanceTimersByTimeAsync(1800);
    expect(sent[2]?.text).toBe("Hello world");
    const finish = stream.finish();
    await vi.advanceTimersByTimeAsync(1800);
    await finish;
    expect(sent.map((activity) => activity.entities[0])).toEqual([
      { type: "streaminfo", streamType: "informative", streamSequence: 1, streamId: undefined },
      { type: "streaminfo", streamType: "streaming", streamSequence: 2, streamId: "stream-id" },
      { type: "streaminfo", streamType: "streaming", streamSequence: 3, streamId: "stream-id" },
      { type: "streaminfo", streamType: "final", streamId: "stream-id" },
    ]);
    expect(sent[3]?.entities[1]).toMatchObject({ additionalType: ["AIGeneratedContent"] });
    await stream.dispose();
  });
  it("does not send per token and preserves text on incomplete finalization", async () => {
    const send = vi.fn(async (_activity: StreamActivity) => ({ id: "s" }));
    const stream = new TeamsReplyStream(send, vi.fn());
    await stream.start("Generating...");
    for (let i = 0; i < 100; i++) stream.append("a");
    expect(send).toHaveBeenCalledTimes(1);
    const finish = stream.finish("Incomplete.");
    await vi.advanceTimersByTimeAsync(1800);
    await finish;
    expect(send.mock.calls[1]?.[0]).toMatchObject({ text: `${"a".repeat(100)}\n\nIncomplete.` });
    await stream.dispose();
  });
  it("recognizes Stop and never finalizes or writes after cancellation", async () => {
    const onFailure = vi.fn();
    const send = vi.fn()
      .mockResolvedValueOnce({ id: "s" })
      .mockRejectedValue({ response: { status: 403, data: { error: { message: "Content stream was canceled by user" } } } });
    const stream = new TeamsReplyStream(send, onFailure);
    await stream.start("Generating...");
    stream.append("partial");
    await vi.advanceTimersByTimeAsync(1800);
    expect(stream.failure?.code).toBe("stopped");
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(() => stream.append("ignored")).toThrow();
    await expect(stream.finish()).rejects.toMatchObject({ code: "stopped" });
    await vi.advanceTimersByTimeAsync(20000);
    expect(send).toHaveBeenCalledTimes(2);
    await stream.dispose();
  });
  it("distinguishes forbidden streaming from user cancellation", async () => {
    const stream = new TeamsReplyStream(async () => {
      throw { response: { status: 403, data: { error: { message: "Content stream is not allowed" } } } };
    }, vi.fn());
    await expect(stream.start("Generating...")).rejects.toMatchObject({ code: "not_allowed" });
    await stream.dispose();
  });
  it("bounds 429 retry, reuses sequence, and surfaces delivery failure", async () => {
    const send = vi.fn().mockRejectedValue({ response: { status: 429, headers: { "retry-after": "2" } } });
    const stream = new TeamsReplyStream(send, vi.fn());
    const start = stream.start("Generating...");
    const rejection = expect(start).rejects.toMatchObject({ code: "delivery" });
    await vi.advanceTimersByTimeAsync(4000);
    await rejection;
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls.map((args: unknown[]) => args[0])).toEqual([
      send.mock.calls[0]?.[0], send.mock.calls[0]?.[0], send.mock.calls[0]?.[0],
    ]);
    await stream.dispose();
  });
  it("will not start a send too close to Teams' two-minute deadline", async () => {
    const send = vi.fn(async () => ({ id: "s" }));
    const stream = new TeamsReplyStream(send, vi.fn());
    await stream.start("Generating...");
    stream.append("partial");
    await vi.advanceTimersByTimeAsync(106000);
    await expect(stream.finish()).rejects.toMatchObject({ code: "timeout" });
    await stream.dispose();
  });
});
