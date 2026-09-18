import { describe, expect, it, vi } from "vitest";
import type { RawMessageStreamEvent } from "@anthropic-ai/sdk/resources/messages";
import type { GenerateContentResponse } from "@google/genai";
import type { ChatProvider, ProviderEvent, ProviderRequest } from "../src/core/contracts.js";
import {
  AnthropicProvider,
  GeminiProvider,
  MockProvider,
  ProviderError,
  type AnthropicClient,
  type GeminiClient,
} from "../src/providers/index.js";

function request(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    prompt: "Current question",
    history: [
      { user: "Earlier question", assistant: "Earlier answer", createdAt: 1, expiresAt: 2 },
      { user: "Next question", assistant: "Next answer", createdAt: 3, expiresAt: 4 },
    ],
    maxOutputTokens: 37,
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function* events<T>(values: T[]): AsyncGenerator<T> {
  yield* values;
}

async function collect(provider: ChatProvider, input = request()): Promise<ProviderEvent[]> {
  const output: ProviderEvent[] = [];
  for await (const event of provider.stream(input)) output.push(event);
  return output;
}

// Wire-shaped fixtures intentionally omit irrelevant SDK response fields.
function anthropicEvent(value: unknown): RawMessageStreamEvent {
  return value as RawMessageStreamEvent;
}

function geminiEvent(value: unknown): GenerateContentResponse {
  return value as GenerateContentResponse;
}

const start = () => anthropicEvent({
  type: "message_start",
  message: { usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } },
});
const textStart = (text = "", index = 0) => anthropicEvent({
  type: "content_block_start", index, content_block: { type: "text", text },
});
const textDelta = (text: string, index = 0) => anthropicEvent({
  type: "content_block_delta", index, delta: { type: "text_delta", text },
});
const finish = (reason: string, outputTokens = 4) => anthropicEvent({
  type: "message_delta", delta: { stop_reason: reason },
  usage: { input_tokens: null, output_tokens: outputTokens },
});
const stop = () => anthropicEvent({ type: "message_stop" });
const geminiText = (text: string, finishReason?: string) => geminiEvent({
  candidates: [{ index: 0, content: { role: "model", parts: [{ text }] }, finishReason }],
});

function anthropic(values: RawMessageStreamEvent[] = []) {
  const create = vi.fn<AnthropicClient["messages"]["create"]>()
    .mockImplementation(async () => events(values));
  const provider = new AnthropicProvider({
    apiKey: "test-placeholder", model: "configured-claude", client: { messages: { create } },
  });
  return { provider, create };
}

function gemini(values: GenerateContentResponse[] = []) {
  const generateContentStream = vi.fn<GeminiClient["models"]["generateContentStream"]>()
    .mockImplementation(async () => events(values));
  const provider = new GeminiProvider({
    apiKey: "test-placeholder", model: "configured-gemini", client: { models: { generateContentStream } },
  });
  return { provider, generateContentStream };
}

describe("AnthropicProvider", () => {
  it("streams answer text in order, ignores reasoning, and reports cumulative final usage once", async () => {
    const { provider } = anthropic([
      start(),
      anthropicEvent({ type: "content_block_start", index: 9, content_block: { type: "thinking", thinking: "private reasoning" } }),
      anthropicEvent({ type: "content_block_delta", index: 9, delta: { type: "thinking_delta", thinking: "private reasoning" } }),
      anthropicEvent({ type: "content_block_delta", index: 9, delta: { type: "signature_delta", signature: "private signature" } }),
      textStart("Hello"),
      textDelta(" "),
      textDelta("world"),
      anthropicEvent({ type: "content_block_stop", index: 0 }),
      anthropicEvent({ type: "message_delta", delta: { stop_reason: null }, usage: { output_tokens: 2 } }),
      finish("end_turn", 7),
      stop(),
    ]);
    expect(await collect(provider)).toEqual([
      { type: "text", text: "Hello" }, { type: "text", text: " " }, { type: "text", text: "world" },
      { type: "complete", status: "completed", inputTokens: 15, outputTokens: 7 },
    ]);
  });

  it("sends precisely the supplied history, token cap, and model without server history or retries", async () => {
    const { provider, create } = anthropic([start(), textStart(), textDelta("Answer"), finish("end_turn"), stop()]);
    await collect(provider);
    const [parameters, options] = create.mock.calls[0]!;
    expect(parameters).toEqual({
      model: "configured-claude",
      messages: [
        { role: "user", content: "Earlier question" }, { role: "assistant", content: "Earlier answer" },
        { role: "user", content: "Next question" }, { role: "assistant", content: "Next answer" },
        { role: "user", content: "Current question" },
      ],
      max_tokens: 37, stream: true, thinking: { type: "disabled" },
    });
    expect(options.maxRetries).toBe(0);
    expect(options.signal).toBeInstanceOf(AbortSignal);
    await collect(provider, request({ history: [] }));
    expect(create.mock.calls[1]![0].messages).toEqual([{ role: "user", content: "Current question" }]);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["end_turn", "completed"],
    ["stop_sequence", "completed"],
    ["max_tokens", "truncated"],
    ["model_context_window_exceeded", "truncated"],
    ["pause_turn", "truncated"],
    ["refusal", "blocked"],
  ])("maps %s to %s", async (reason, status) => {
    const { provider } = anthropic([start(), textStart("Answer"), finish(reason!), stop()]);
    expect((await collect(provider)).at(-1)).toMatchObject({ type: "complete", status });
  });

  it("allows an explicit refusal without answer text", async () => {
    const { provider } = anthropic([start(), finish("refusal"), stop()]);
    expect(await collect(provider)).toEqual([
      { type: "complete", status: "blocked", inputTokens: 15, outputTokens: 4 },
    ]);
  });

  it.each([
    [[], "incomplete_response"],
    [[start(), textStart("Partial"), finish("end_turn")], "incomplete_response"],
    [[start(), textStart("Partial"), stop()], "incomplete_response"],
    [[start(), textStart(" \n"), finish("end_turn"), stop()], "empty_response"],
    [[start(), textStart("Partial"), finish("tool_use"), stop()], "unsupported_response"],
    [[start(), textStart("Partial"), finish("new_unknown_reason"), stop()], "unsupported_response"],
    [[start(), textStart("Answer"), finish("end_turn"), stop(), textDelta("late")], "incomplete_response"],
  ] as const)("rejects absent, empty, unsupported, or malformed completion %#", async (values, code) => {
    const { provider } = anthropic([...values]);
    await expect(collect(provider)).rejects.toMatchObject({ name: "ProviderError", code });
  });

  it("does not forward a text-shaped delta from a non-text block", async () => {
    const { provider } = anthropic([
      start(),
      anthropicEvent({ type: "content_block_start", index: 0, content_block: { type: "redacted_thinking", data: "private" } }),
      textDelta("private"),
      finish("end_turn"), stop(),
    ]);
    await expect(collect(provider)).rejects.toMatchObject({ code: "empty_response" });
  });
});

describe("GeminiProvider", () => {
  it("streams ordered non-thought text parts and includes reasoning tokens only as usage", async () => {
    const { provider } = gemini([
      geminiEvent({
        candidates: [{ index: 0, content: { parts: [
          { text: "private reasoning", thought: true },
          { text: "Hello", thought: false, thoughtSignature: "private signature" },
          { inlineData: { mimeType: "image/png", data: "private" } },
          { text: " " },
        ] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
      }),
      geminiText("world", "STOP"),
      geminiEvent({ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 8 } }),
    ]);
    expect(await collect(provider)).toEqual([
      { type: "text", text: "Hello" }, { type: "text", text: " " }, { type: "text", text: "world" },
      { type: "complete", status: "completed", inputTokens: 10, outputTokens: 13 },
    ]);
  });

  it("sends explicit user/model history and disables all SDK retries", async () => {
    const { provider, generateContentStream } = gemini([geminiText("Answer", "STOP")]);
    await collect(provider);
    const parameters = generateContentStream.mock.calls[0]![0];
    expect(parameters).toEqual({
      model: "configured-gemini",
      contents: [
        { role: "user", parts: [{ text: "Earlier question" }] },
        { role: "model", parts: [{ text: "Earlier answer" }] },
        { role: "user", parts: [{ text: "Next question" }] },
        { role: "model", parts: [{ text: "Next answer" }] },
        { role: "user", parts: [{ text: "Current question" }] },
      ],
      config: {
        maxOutputTokens: 37, candidateCount: 1, responseModalities: ["TEXT"],
        thinkingConfig: { includeThoughts: false },
        abortSignal: expect.any(AbortSignal), httpOptions: { retryOptions: { attempts: 1 } },
      },
    });
    await collect(provider, request({ history: [] }));
    expect(generateContentStream.mock.calls[1]![0].contents).toEqual([
      { role: "user", parts: [{ text: "Current question" }] },
    ]);
    expect(generateContentStream).toHaveBeenCalledTimes(2);
  });

  it.each(["SAFETY", "RECITATION", "LANGUAGE", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY"])(
    "maps %s to blocked and suppresses text in the blocked chunk", async (reason) => {
      const { provider } = gemini([geminiText("Partial "), geminiText("withheld", reason)]);
      expect(await collect(provider)).toEqual([
        { type: "text", text: "Partial " }, { type: "complete", status: "blocked" },
      ]);
    },
  );

  it("reports a prompt block without any candidates or answer", async () => {
    const { provider } = gemini([geminiEvent({
      promptFeedback: { blockReason: "SAFETY", blockReasonMessage: "private explanation" },
      usageMetadata: { promptTokenCount: 6 },
    })]);
    expect(await collect(provider)).toEqual([{ type: "complete", status: "blocked", inputTokens: 6 }]);
  });

  it("reports output-cap truncation even when the budget was entirely consumed by reasoning", async () => {
    const { provider } = gemini([geminiEvent({
      candidates: [{ content: { parts: [{ text: "private", thought: true }] }, finishReason: "MAX_TOKENS" }],
      usageMetadata: { promptTokenCount: 3, thoughtsTokenCount: 37 },
    })]);
    expect(await collect(provider)).toEqual([
      { type: "complete", status: "truncated", inputTokens: 3, outputTokens: 37 },
    ]);
  });

  it.each([
    [[], "incomplete_response"],
    [[geminiText("Partial")], "incomplete_response"],
    [[geminiText(" \n", "STOP")], "empty_response"],
    [[geminiText("Partial", "OTHER")], "unsupported_response"],
    [[geminiText("", "UNEXPECTED_TOOL_CALL")], "unsupported_response"],
    [[geminiText("Answer", "STOP"), geminiText("late")], "incomplete_response"],
    [[geminiText("Answer", "STOP"), geminiText("", "MAX_TOKENS")], "incomplete_response"],
  ] as const)("rejects absent, empty, unsupported, or malformed completion %#", async (values, code) => {
    const { provider } = gemini([...values]);
    await expect(collect(provider)).rejects.toMatchObject({ name: "ProviderError", code });
  });

  it("never combines multiple candidates", async () => {
    const { provider } = gemini([geminiEvent({ candidates: [
      { index: 0, content: { parts: [{ text: "one" }] } },
      { index: 1, content: { parts: [{ text: "two" }] } },
    ] })]);
    await expect(collect(provider)).rejects.toMatchObject({ code: "unsupported_response" });
  });
});

// Run the same cancellation/error scenarios through both real adapters' injection boundaries.
function harness(id: "claude" | "gemini") {
  if (id === "claude") {
    const { provider, create } = anthropic();
    return {
      provider,
      open: create,
      signal: () => create.mock.calls[0]![1].signal,
      setStream: (value: AsyncIterable<unknown>) => create.mockResolvedValue(value as AsyncIterable<RawMessageStreamEvent>),
      prefix: [start(), textStart("First")],
      tail: [textDelta("late"), finish("end_turn"), stop()],
    };
  }
  const { provider, generateContentStream } = gemini();
  return {
    provider,
    open: generateContentStream,
    signal: () => generateContentStream.mock.calls[0]![0].config!.abortSignal!,
    setStream: (value: AsyncIterable<unknown>) => generateContentStream.mockResolvedValue(value as AsyncIterable<GenerateContentResponse>),
    prefix: [geminiText("First")],
    tail: [geminiText("late", "STOP")],
  };
}

describe.each(["claude", "gemini"] as const)("%s cancellation and safe failures", (id) => {
  it("does not open the SDK when already aborted", async () => {
    const test = harness(id);
    const controller = new AbortController();
    controller.abort(new Error("sensitive abort reason"));
    await expect(collect(test.provider, request({ signal: controller.signal })))
      .rejects.toMatchObject({ code: "cancelled" });
    expect(test.open).not.toHaveBeenCalled();
  });

  it("cancels a pending SDK open promptly even if the SDK does not settle", async () => {
    const test = harness(id);
    test.open.mockImplementation(() => new Promise<never>(() => {}));
    const controller = new AbortController();
    const pending = collect(test.provider, request({ signal: controller.signal }));
    controller.abort("private");
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(test.signal().aborted).toBe(true);
  });

  it("stops after visible text and never emits late text or terminal success", async () => {
    const test = harness(id);
    test.setStream(events([...test.prefix, ...test.tail]));
    const controller = new AbortController();
    const iterator = test.provider.stream(request({ signal: controller.signal }))[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ value: { type: "text", text: "First" }, done: false });
    controller.abort();
    expect(test.signal().aborted).toBe(true);
    await expect(iterator.next()).rejects.toMatchObject({ code: "cancelled" });
  });

  it("aborts the HTTP signal and closes the iterator on consumer return", async () => {
    const test = harness(id);
    let closed = false;
    test.setStream((async function* () {
      try { yield* [...test.prefix, ...test.tail]; } finally { closed = true; }
    })());
    for await (const event of test.provider.stream(request())) {
      expect(event.type).toBe("text");
      break;
    }
    expect(test.signal().aborted).toBe(true);
    expect(closed).toBe(true);
  });

  it("cancels a stuck read without waiting on a stuck iterator return", async () => {
    const test = harness(id);
    const next = vi.fn(() => new Promise<IteratorResult<unknown>>(() => {}));
    const close = vi.fn(() => new Promise<IteratorResult<unknown>>(() => {}));
    test.setStream({ [Symbol.asyncIterator]: () => ({ next, return: close }) });
    const controller = new AbortController();
    const pending = collect(test.provider, request({ signal: controller.signal }));
    await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(close).toHaveBeenCalledTimes(1);
    expect(test.signal().aborted).toBe(true);
  });

  it.each([
    [401, "authentication"], [403, "authentication"], [429, "rate_limited"],
    [400, "invalid_request"], [404, "invalid_request"], [408, "timeout"],
    [504, "timeout"], [500, "unavailable"], [503, "unavailable"], [undefined, "provider_error"],
  ] as const)("sanitizes HTTP %s without copying raw error fields or retrying", async (status, code) => {
    const test = harness(id);
    const raw = Object.assign(new Error("sensitive raw upstream details"), {
      status, headers: { authorization: "private" }, body: "private", request_id: "private",
    });
    test.open.mockRejectedValue(raw);
    const error = await collect(test.provider).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ provider: id, code });
    expect(String(error)).not.toMatch(/sensitive|private|upstream/);
    expect(JSON.stringify(error)).not.toMatch(/sensitive|private|upstream/);
    expect(error).not.toHaveProperty("cause");
    expect(test.open).toHaveBeenCalledTimes(1);
  });

  it("surfaces mid-stream failure after partial text without retries or complete", async () => {
    const test = harness(id);
    test.setStream((async function* () {
      yield* test.prefix;
      throw Object.assign(new Error("private upstream body"), { status: 503 });
    })());
    const output: ProviderEvent[] = [];
    await expect((async () => {
      for await (const event of test.provider.stream(request())) output.push(event);
    })()).rejects.toMatchObject({ code: "unavailable" });
    expect(output).toEqual([{ type: "text", text: "First" }]);
    expect(test.open).toHaveBeenCalledTimes(1);
    expect(test.signal().aborted).toBe(true);
  });

  it.each(["AbortError", "APIUserAbortError", "TimeoutError", "APIConnectionTimeoutError"])(
    "sanitizes SDK %s independently of HTTP status", async (name) => {
      const test = harness(id);
      test.open.mockRejectedValue(Object.assign(new Error("private detail"), { name }));
      await expect(collect(test.provider)).rejects.toMatchObject({
        code: name.includes("Timeout") ? "timeout" : "cancelled",
      });
    },
  );

  it("lets cancellation win over a concurrent terminal completion", async () => {
    const test = harness(id);
    const controller = new AbortController();
    test.setStream((async function* () {
      yield* test.prefix;
      yield* test.tail;
      controller.abort("private reason");
    })());
    const output: ProviderEvent[] = [];
    await expect((async () => {
      for await (const event of test.provider.stream(request({ signal: controller.signal }))) output.push(event);
    })()).rejects.toMatchObject({ code: "cancelled" });
    expect(output.every((event) => event.type === "text")).toBe(true);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid output cap %s locally", async (maxOutputTokens) => {
    const test = harness(id);
    await expect(collect(test.provider, request({ maxOutputTokens })))
      .rejects.toMatchObject({ code: "invalid_request" });
    expect(test.open).not.toHaveBeenCalled();
  });
});

describe("official SDK transport integration (mocked fetch, no network)", () => {
  it.each(["claude", "gemini"] as const)("uses the pinned %s SDK's real SSE parser", async (id) => {
    const wireEvents = id === "claude"
      ? [start(), textStart(), textDelta("Answer"), finish("end_turn"), stop()]
      : [geminiText("Answer", "STOP")];
    const body = wireEvents.map((event) =>
      `${id === "claude" ? `event: ${(event as RawMessageStreamEvent).type}\n` : ""}data: ${JSON.stringify(event)}\n\n`,
    ).join("");
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(body, { headers: { "content-type": "text/event-stream" } }),
    );
    vi.stubGlobal("fetch", fetch);
    try {
      const options = { apiKey: "test-placeholder", model: "configured-test-model" };
      const provider = id === "claude" ? new AnthropicProvider(options) : new GeminiProvider(options);
      const output = await collect(provider);
      expect(output[0]).toEqual({ type: "text", text: "Answer" });
      expect(output.at(-1)).toMatchObject({ type: "complete", status: "completed" });
      expect(fetch).toHaveBeenCalledTimes(1);
      const url = String(fetch.mock.calls[0]![0]);
      expect(url).toContain(id === "claude" ? "https://api.anthropic.com/" : "https://generativelanguage.googleapis.com/");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(["claude", "gemini"] as const)("does not retry an HTTP 429 using the real %s client", async (id) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 429, message: "private upstream details" } }), {
        status: 429, headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    try {
      const options = { apiKey: "test-placeholder", model: "configured-test-model" };
      const provider = id === "claude" ? new AnthropicProvider(options) : new GeminiProvider(options);
      await expect(collect(provider)).rejects.toMatchObject({ code: "rate_limited" });
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("MockProvider", () => {
  it("is deterministic, explicitly synthetic, and does not echo prompt/history", async () => {
    const provider = new MockProvider({ id: "claude" });
    const first = await collect(provider, request({ maxOutputTokens: 100 }));
    expect(await collect(provider, request({ maxOutputTokens: 100 }))).toEqual(first);
    expect(provider.id).toBe("claude");
    expect(provider.model).toBe("mock-claude");
    const answer = first.filter((event) => event.type === "text").map((event) => event.text).join("");
    expect(answer).toContain("[Local mock]");
    expect(answer).toContain("no external API was called");
    expect(answer).not.toContain("Current question");
    expect(answer).not.toContain("Earlier answer");
    expect(first.at(-1)).toMatchObject({ type: "complete", status: "completed" });
  });

  it("supports either provider identity and deterministic synthetic token truncation", async () => {
    const provider = new MockProvider({ id: "gemini", model: "local-test" });
    const output = await collect(provider, request({ maxOutputTokens: 1 }));
    expect(provider.model).toBe("local-test");
    expect(output).toHaveLength(2);
    expect(output[1]).toMatchObject({ type: "complete", status: "truncated", outputTokens: 1 });
  });

  it("checks cancellation between chunks", async () => {
    const provider = new MockProvider({ id: "gemini" });
    const controller = new AbortController();
    const iterator = provider.stream(request({ signal: controller.signal }));
    expect((await iterator.next()).value).toMatchObject({ type: "text" });
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ code: "cancelled" });
  });
});
