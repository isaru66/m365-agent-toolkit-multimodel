import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageCreateParamsStreaming,
  RawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/messages";
import type { ChatProvider, ProviderEvent, ProviderRequest } from "../core/contracts.js";
import { ProviderError, safeProviderError } from "./errors.js";
import { checkAbort, providerStream, tokenCount, validateRequest } from "./stream.js";

/** Minimal injection boundary; production uses the official Messages client. */
export interface AnthropicClient {
  messages: {
    create(
      parameters: MessageCreateParamsStreaming,
      options: { signal: AbortSignal; maxRetries: number },
    ): PromiseLike<AsyncIterable<RawMessageStreamEvent>>;
  };
}

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  client?: AnthropicClient;
}

export class AnthropicProvider implements ChatProvider {
  readonly id = "claude" as const;
  readonly model: string;
  private readonly client: AnthropicClient;

  constructor(options: AnthropicProviderOptions) {
    if (!options.apiKey?.trim() || !options.model?.trim()) {
      throw new ProviderError(this.id, "configuration");
    }
    this.model = options.model;
    try {
      this.client = options.client ?? new Anthropic({
        apiKey: options.apiKey,
        baseURL: "https://api.anthropic.com",
        maxRetries: 0,
        // SDK debug logging may contain prompts/headers; app telemetry is sanitized separately.
        logLevel: "off",
      });
    } catch (error) {
      throw safeProviderError(this.id, error);
    }
  }

  async *stream(request: ProviderRequest): AsyncGenerator<ProviderEvent> {
    validateRequest(this.id, request);
    const messages: MessageCreateParamsStreaming["messages"] = request.history.flatMap(
      (exchange) => [
        { role: "user" as const, content: exchange.user },
        { role: "assistant" as const, content: exchange.assistant },
      ],
    );
    messages.push({ role: "user", content: request.prompt });
    let reason: string | null | undefined;
    let stopped = false;
    let hasAnswer = false;
    let inputTokens: number | undefined;
    let cacheRead: number | undefined;
    let cacheCreation: number | undefined;
    let outputTokens: number | undefined;
    const textBlocks = new Set<number>();
    try {
      for await (const event of providerStream(this.id, request.signal, (signal) =>
        this.client.messages.create({
          model: this.model,
          messages,
          max_tokens: request.maxOutputTokens,
          stream: true,
          // Never request reasoning content or any tools.
          thinking: { type: "disabled" },
        }, { signal, maxRetries: 0 }))) {
        if (stopped) throw new ProviderError(this.id, "incomplete_response");
        switch (event.type) {
          case "message_start":
            inputTokens = tokenCount(event.message.usage.input_tokens);
            cacheRead = tokenCount(event.message.usage.cache_read_input_tokens);
            cacheCreation = tokenCount(event.message.usage.cache_creation_input_tokens);
            outputTokens = tokenCount(event.message.usage.output_tokens);
            break;
          case "content_block_start":
            if (event.content_block.type === "text") {
              textBlocks.add(event.index);
              if (event.content_block.text) {
                hasAnswer ||= event.content_block.text.trim().length > 0;
                yield { type: "text", text: event.content_block.text };
              }
            }
            break;
          case "content_block_delta":
            if (textBlocks.has(event.index) && event.delta.type === "text_delta" && event.delta.text) {
              hasAnswer ||= event.delta.text.trim().length > 0;
              yield { type: "text", text: event.delta.text };
            }
            break;
          case "content_block_stop":
            textBlocks.delete(event.index);
            break;
          case "message_delta":
            reason = event.delta.stop_reason ?? reason;
            inputTokens = tokenCount(event.usage.input_tokens) ?? inputTokens;
            cacheRead = tokenCount(event.usage.cache_read_input_tokens) ?? cacheRead;
            cacheCreation = tokenCount(event.usage.cache_creation_input_tokens) ?? cacheCreation;
            outputTokens = tokenCount(event.usage.output_tokens) ?? outputTokens;
            break;
          case "message_stop":
            stopped = true;
            break;
        }
      }
      checkAbort(this.id, request.signal);
      if (!stopped || !reason) throw new ProviderError(this.id, "incomplete_response");
      let status: "completed" | "truncated" | "blocked";
      switch (reason) {
        case "end_turn":
        case "stop_sequence":
          status = "completed";
          break;
        case "max_tokens":
        case "model_context_window_exceeded":
        case "pause_turn":
          status = "truncated";
          break;
        case "refusal":
          status = "blocked";
          break;
        default:
          throw new ProviderError(this.id, "unsupported_response");
      }
      if (status === "completed" && !hasAnswer) throw new ProviderError(this.id, "empty_response");
      yield {
        type: "complete",
        status,
        // Anthropic reports uncached, cache-read and cache-creation input separately.
        ...(inputTokens === undefined ? {} : {
          inputTokens: inputTokens + (cacheRead ?? 0) + (cacheCreation ?? 0),
        }),
        ...(outputTokens === undefined ? {} : { outputTokens }),
      };
    } catch (error) {
      throw safeProviderError(this.id, error, request.signal);
    }
  }
}
