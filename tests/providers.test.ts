import { describe, expect, it, vi } from "vitest";
import type { RawMessageStreamEvent } from "@anthropic-ai/sdk/resources/messages";
import type { GenerateContentResponse } from "@google/genai";
import type { ChatCompletionChunk } from "openai/resources/chat/completions";
import { PROVIDER_IDS, type ChatProvider, type ProviderEvent, type ProviderId, type ProviderRequest } from "../src/core/contracts.js";
import {
  AnthropicProvider,
  AzureOpenAiProvider,
  GeminiProvider,
  MockProvider,
  ProviderError,
  type AnthropicClient,
  type AzureOpenAiClient,
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
const baseUrls = {
  claude: "https://resource.services.ai.azure.com/anthropic",
  gemini: "https://generativelanguage.googleapis.com",
  "azure-openai": "https://resource.services.ai.azure.com/openai/v1",
};
const azureEvent = (value: unknown) => value as ChatCompletionChunk;
const azureText = (text: string, finishReason: string | null = null) => azureEvent({
  choices: [{ index: 0, delta: { content: text }, finish_reason: finishReason }],
});
const azureAnnotation = (overrides: Record<string, unknown> = {}) => azureEvent({
  choices: [{
    index: 0,
    finish_reason: null,
    content_filter_results: { violence: { filtered: false, severity: "safe" } },
    content_filter_offsets: { check_offset: 10, start_offset: 0, end_offset: 10 },
    ...overrides,
  }],
});

function azure(values: ChatCompletionChunk[] = []) {
  const create = vi.fn<AzureOpenAiClient["chat"]["completions"]["create"]>()
    .mockImplementation(async () => events(values));
  const provider = new AzureOpenAiProvider({
    apiKey: "test-placeholder", model: "configured-deployment", baseUrl: baseUrls["azure-openai"],
    client: { chat: { completions: { create } } },
  });
  return { provider, create };
}

function anthropic(values: RawMessageStreamEvent[] = []) {
  const create = vi.fn<AnthropicClient["messages"]["create"]>()
    .mockImplementation(async () => events(values));
  const provider = new AnthropicProvider({
    apiKey: "test-placeholder", model: "configured-claude", baseUrl: baseUrls.claude, client: { messages: { create } },
  });
  return { provider, create };
}

function gemini(values: GenerateContentResponse[] = []) {
  const generateContentStream = vi.fn<GeminiClient["models"]["generateContentStream"]>()
    .mockImplementation(async () => events(values));
  const provider = new GeminiProvider({
    apiKey: "test-placeholder", model: "configured-gemini", baseUrl: baseUrls.gemini, client: { models: { generateContentStream } },
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

describe("AzureOpenAiProvider", () => {
  it("streams only answer text, with final usage-only metadata and no reasoning leakage", async () => {
    const { provider } = azure([
      azureEvent({ choices: [] }), // Azure prompt-filter metadata.
      azureEvent({ choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "private reasoning" }, finish_reason: null }] }),
      azureText("Hello "),
      azureText("world", "stop"),
      azureEvent({ choices: [], usage: {
        prompt_tokens: 10, completion_tokens: 12, completion_tokens_details: { reasoning_tokens: 9 },
      } }),
    ]);
    expect(await collect(provider)).toEqual([
      { type: "text", text: "Hello " }, { type: "text", text: "world" },
      { type: "complete", status: "completed", inputTokens: 10, outputTokens: 12 },
    ]);
  });

  it("sends stateless history, deployment and bounded completion tokens without tools or temperature", async () => {
    const { provider, create } = azure([azureText("Answer", "stop")]);
    await collect(provider);
    expect(create.mock.calls[0]![0]).toEqual({
      model: "configured-deployment",
      messages: [
        { role: "user", content: "Earlier question" }, { role: "assistant", content: "Earlier answer" },
        { role: "user", content: "Next question" }, { role: "assistant", content: "Next answer" },
        { role: "user", content: "Current question" },
      ],
      max_completion_tokens: 37, stream: true, stream_options: { include_usage: true }, store: false,
    });
    expect(create.mock.calls[0]![1]).toEqual({ signal: expect.any(AbortSignal), maxRetries: 0 });
    await collect(provider, request({ history: [] }));
    expect(create.mock.calls[1]![0].messages).toEqual([{ role: "user", content: "Current question" }]);
  });

  it.each([["stop", "completed"], ["length", "truncated"], ["content_filter", "blocked"]])(
    "maps %s to %s and suppresses filtered terminal text", async (reason, status) => {
      const { provider } = azure([azureText("Answer", reason)]);
      const output = await collect(provider);
      expect(output.at(-1)).toEqual({ type: "complete", status });
      expect(output.filter((event) => event.type === "text")).toHaveLength(status === "blocked" ? 0 : 1);
    },
  );

  it("supports truncation with reasoning-only output", async () => {
    const { provider } = azure([azureText("", "length")]);
    expect(await collect(provider)).toEqual([{ type: "complete", status: "truncated" }]);
  });

  it("maps refusal to blocked without forwarding refusal details or accompanying text", async () => {
    const { provider } = azure([
      azureEvent({ choices: [{ index: 0, delta: { refusal: "private reason", content: "withheld" }, finish_reason: null }] }),
      azureText("withheld", "stop"),
    ]);
    expect(await collect(provider)).toEqual([{ type: "complete", status: "blocked" }]);
  });

  it.each([
    [[], "incomplete_response"],
    [[azureText("partial")], "incomplete_response"],
    [[azureText(" \n", "stop")], "empty_response"],
    [[azureText("", "stop")], "empty_response"],
    [[azureText("", "tool_calls")], "unsupported_response"],
    [[azureText("", "function_call")], "unsupported_response"],
    [[azureText("partial", "new_reason")], "unsupported_response"],
    [[azureText("Answer", "stop"), azureText("late")], "incomplete_response"],
    [[azureText("Answer", "stop"), azureText("", "length")], "incomplete_response"],
    [[azureEvent({ choices: [], usage: { prompt_tokens: 10 } })], "incomplete_response"],
    [[azureEvent({ choices: [{ index: 1, delta: {}, finish_reason: "stop" }] })], "unsupported_response"],
    [[azureEvent({ choices: [{ index: 0 }, { index: 1 }] })], "unsupported_response"],
    [[azureEvent({ choices: [{ index: 0, finish_reason: "stop" }] })], "incomplete_response"],
    [[azureEvent({})], "incomplete_response"],
    [[azureEvent({ choices: [{ index: 0, delta: { tool_calls: [{ function: { arguments: "private" } }] } }] })], "unsupported_response"],
    [[azureEvent({ choices: [{ index: 0, delta: { function_call: { arguments: "private" } } }] })], "unsupported_response"],
  ] as const)("rejects incomplete, empty, tool, or malformed completion %#", async (values, code) => {
    const { provider } = azure([...values]);
    await expect(collect(provider)).rejects.toMatchObject({ name: "ProviderError", code });
  });
});

// Run the same cancellation/error scenarios through all adapters' injection boundaries.
function harness(id: ProviderId) {
  if (id === "azure-openai") {
    const { provider, create } = azure();
    return {
      provider,
      open: create,
      signal: () => create.mock.calls[0]![1].signal,
      setStream: (value: AsyncIterable<unknown>) => create.mockResolvedValue(value as AsyncIterable<ChatCompletionChunk>),
      prefix: [azureText("First")],
      tail: [azureText("late", "stop")],
    };
  }
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

describe.each(PROVIDER_IDS)("%s cancellation and safe failures", (id) => {
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
  function sdkProvider(id: ProviderId, baseUrl = baseUrls[id]) {
    const options = { apiKey: `${id}-test-key`, model: "configured-test-model", baseUrl };
    return id === "claude" ? new AnthropicProvider(options)
      : id === "gemini" ? new GeminiProvider(options) : new AzureOpenAiProvider(options);
  }
  function sse(id: ProviderId) {
    const wireEvents = id === "claude" ? [start(), textStart(), textDelta("Answer"), finish("end_turn"), stop()]
      : id === "gemini" ? [geminiText("Answer", "STOP")]
        : [azureText("Answer", "stop"), azureEvent({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 4 } })];
    return wireEvents.map((event) =>
      `${id === "claude" ? `event: ${(event as RawMessageStreamEvent).type}\n` : ""}data: ${JSON.stringify(event)}\n\n`,
    ).join("") + (id === "azure-openai" ? "data: [DONE]\n\n" : "");
  }

  it.each([
    {
      name: "annotations during generation and after stop",
      chunks: [azureText("Hello "), azureAnnotation(), azureText("world", "stop"), azureAnnotation()],
      texts: ["Hello ", "world"], status: "completed",
    },
    {
      name: "annotations with null and empty deltas after stop",
      chunks: [azureText("Answer", "stop"), azureAnnotation({ delta: null }), azureAnnotation({ delta: {} })],
      texts: ["Answer"], status: "completed",
    },
    {
      name: "normal terminal stop with an empty delta and filter metadata",
      chunks: [azureText("Answer"), azureAnnotation({ delta: {}, finish_reason: "stop", content_filter_results: {} })],
      texts: ["Answer"], status: "completed",
    },
    {
      name: "normal terminal length with an empty delta and filter metadata",
      chunks: [azureText("Partial"), azureAnnotation({ delta: {}, finish_reason: "length" })],
      texts: ["Partial"], status: "truncated",
    },
    {
      name: "filtered text is suppressed even when a stop accompanies the metadata",
      chunks: [azureAnnotation({
        delta: { content: "must not be displayed" }, finish_reason: "stop",
        content_filter_results: { violence: { filtered: true, severity: "high" } },
      })],
      texts: [], status: "blocked",
    },
    {
      name: "annotation-only terminal block",
      chunks: [azureAnnotation({
        finish_reason: "content_filter",
        content_filter_results: { protected_material_text: { detected: true, filtered: true } },
      })],
      texts: [], status: "blocked",
    },
    {
      name: "annotation block during generation",
      chunks: [azureText("Partial"), azureAnnotation({ finish_reason: "content_filter" })],
      texts: ["Partial"], status: "blocked",
    },
    {
      name: "late annotation block overrides stop and remains blocked after benign metadata",
      chunks: [azureText("Answer", "stop"), azureAnnotation({ finish_reason: "content_filter" }), azureAnnotation()],
      texts: ["Answer"], status: "blocked",
    },
    {
      name: "filtered annotation without finish reason cannot commit a prior stop",
      chunks: [azureText("Answer", "stop"), azureAnnotation({
        content_filter_results: { violence: { filtered: true, severity: "high" } },
      })],
      texts: ["Answer"], status: "blocked",
    },
  ])("parses Azure async-filter SSE: $name", async ({ chunks, texts, status }) => {
    const usage = azureEvent({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 4 } });
    const body = [...chunks, usage].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(body, { headers: { "content-type": "text/event-stream" } }),
    );
    vi.stubGlobal("fetch", fetch);
    try {
      const output = await collect(sdkProvider("azure-openai"));
      // Exactly one terminal event, after all annotations/usage; never early completed.
      expect(output).toEqual([
        ...texts.map((text) => ({ type: "text", text })),
        { type: "complete", status, inputTokens: 10, outputTokens: 4 },
      ]);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    { name: "non-annotation missing delta", chunks: [azureEvent({ choices: [{ index: 0, finish_reason: "stop" }] })] },
    { name: "string annotation", chunks: [azureAnnotation({ content_filter_results: "invalid" })] },
    { name: "array annotation", chunks: [azureAnnotation({ content_filter_results: [] })] },
    { name: "null annotation", chunks: [azureAnnotation({ content_filter_results: null })] },
    { name: "annotation with invalid delta", chunks: [azureAnnotation({ delta: false })] },
    { name: "terminal array delta", chunks: [azureText("Partial"), azureEvent({ choices: [{ index: 0, delta: [], finish_reason: "stop" }] })] },
    { name: "terminal scalar delta", chunks: [azureText("Partial"), azureEvent({ choices: [{ index: 0, delta: 42, finish_reason: "stop" }] })] },
    { name: "annotation claiming stop without delta", chunks: [azureAnnotation({ finish_reason: "stop" })] },
    { name: "benign annotations without a terminal choice", chunks: [azureText("Partial"), azureAnnotation()] },
    { name: "text after stop", chunks: [azureText("Answer", "stop"), azureText("late")] },
    { name: "text disguised as annotation after stop", chunks: [azureText("Answer", "stop"), azureAnnotation({ delta: { content: "late" } })] },
    { name: "missing delta after stop", chunks: [azureText("Answer", "stop"), azureEvent({ choices: [{ index: 0 }] })] },
  ])("rejects malformed Azure SSE: $name", async ({ chunks }) => {
    const body = chunks.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(body, { headers: { "content-type": "text/event-stream" } }),
    );
    vi.stubGlobal("fetch", fetch);
    try {
      const output: ProviderEvent[] = [];
      await expect((async () => {
        for await (const event of sdkProvider("azure-openai").stream(request())) output.push(event);
      })()).rejects.toMatchObject({ code: "incomplete_response" });
      expect(output.every((event) => event.type === "text" && event.text !== "late")).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(PROVIDER_IDS.flatMap((id) => [false, true].map((gateway) => ({ id, gateway }))))(
    "uses $id SDK SSE, native auth and exact routes (gateway=$gateway)", async ({ id, gateway }) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(sse(id), { headers: { "content-type": "text/event-stream" } }),
    );
    vi.stubGlobal("fetch", fetch);
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "unrelated-secret");
    vi.stubEnv("OPENAI_ORG_ID", "unrelated-org");
    vi.stubEnv("OPENAI_PROJECT_ID", "unrelated-project");
    vi.stubEnv("OPENAI_API_KEY", "unrelated-key");
    try {
      const baseUrl = gateway
        ? `https://gateway.example.test/trusted/prefix/${id}${id === "azure-openai" ? "/openai/v1" : ""}`
        : baseUrls[id];
      const provider = sdkProvider(id, `${baseUrl}///`);
      const output = await collect(provider);
      expect(output[0]).toEqual({ type: "text", text: "Answer" });
      expect(output.at(-1)).toMatchObject({ type: "complete", status: "completed" });
      expect(fetch).toHaveBeenCalledTimes(1);
      const [input, init] = fetch.mock.calls[0]!;
      const url = String(input);
      const route = id === "claude" ? "/v1/messages" : id === "gemini"
        ? "/v1beta/models/configured-test-model:streamGenerateContent?alt=sse" : "/chat/completions";
      expect(url).toBe(`${baseUrl}${route}`);
      const headers = new Headers(init?.headers);
      expect(headers.get("x-api-key")).toBe(id === "claude" ? "claude-test-key" : null);
      expect(headers.get("x-goog-api-key")).toBe(id === "gemini" ? "gemini-test-key" : null);
      expect(headers.get("authorization")).toBe(id === "azure-openai" ? "Bearer azure-openai-test-key" : null);
      expect(headers.get("api-key")).toBeNull();
      expect(headers.get("openai-organization")).toBeNull();
      expect(headers.get("openai-project")).toBeNull();
      headers.forEach((value) => expect(value).not.toContain("unrelated"));
      expect(url).not.toContain("key=");
      const body = JSON.parse(String(init?.body));
      if (id === "azure-openai") expect(body).toMatchObject({
        model: "configured-test-model", max_completion_tokens: 37, stream: true, store: false,
      });
      if (id === "claude") expect(body).toMatchObject({ model: "configured-test-model", max_tokens: 37, stream: true });
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it.each(PROVIDER_IDS.flatMap((id) => [401, 403, 429, 503].map((status) => ({ id, status }))))(
    "does not retry HTTP $status or leak its body using the real $id client", async ({ id, status }) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: status, message: "private upstream details" } }), {
        status, headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    try {
      const error = await collect(sdkProvider(id)).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: status === 429 ? "rate_limited" : status === 503 ? "unavailable" : "authentication" });
      expect(String(error)).not.toContain("private");
      expect(JSON.stringify(error)).not.toContain("private");
      expect(error).not.toHaveProperty("cause");
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(PROVIDER_IDS)("rejects unsafe/missing %s base URLs before opening fetch", (id) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    try {
      for (const baseUrl of ["", "http://example.test", "https://user:private@example.test",
        "https://example.test/api/projects/project", "https://example.test?key=private", "https://example.test#private"]) {
        expect(() => sdkProvider(id, baseUrl)).toThrowError(expect.objectContaining({ code: "configuration" }));
      }
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(PROVIDER_IDS)("aborts the real %s SDK HTTP request after partial text", async (id) => {
    let cancelled = false;
    const prefix = id === "claude"
      ? [start(), textStart("First")]
      : id === "gemini" ? [geminiText("First")] : [azureText("First")];
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_input, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(prefix.map((event) =>
            `${id === "claude" ? `event: ${(event as RawMessageStreamEvent).type}\n` : ""}data: ${JSON.stringify(event)}\n\n`,
          ).join("")));
          init?.signal?.addEventListener("abort", () => {
            cancelled = true;
            controller.error(new DOMException("private detail", "AbortError"));
          }, { once: true });
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    });
    vi.stubGlobal("fetch", fetch);
    try {
      const controller = new AbortController();
      const iterator = sdkProvider(id).stream(request({ signal: controller.signal }))[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toEqual({ type: "text", text: "First" });
      controller.abort();
      await expect(iterator.next()).rejects.toMatchObject({ code: "cancelled" });
      expect(cancelled).toBe(true);
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
