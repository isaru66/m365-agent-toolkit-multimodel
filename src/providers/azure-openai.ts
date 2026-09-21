import OpenAI from "openai";
import type {
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions";
import { providerBaseUrl } from "../config/endpoints.js";
import type { ChatProvider, ProviderEvent, ProviderRequest } from "../core/contracts.js";
import { ProviderError, safeProviderError } from "./errors.js";
import { checkAbort, providerStream, tokenCount, validateRequest } from "./stream.js";

/** Minimal injection boundary; production uses the official v1 Chat Completions client. */
export interface AzureOpenAiClient {
  chat: {
    completions: {
      create(
        parameters: ChatCompletionCreateParamsStreaming,
        options: { signal: AbortSignal; maxRetries: number },
      ): PromiseLike<AsyncIterable<ChatCompletionChunk>>;
    };
  };
}

export interface AzureOpenAiProviderOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  client?: AzureOpenAiClient;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class AzureOpenAiProvider implements ChatProvider {
  readonly id = "azure-openai" as const;
  readonly model: string;
  private readonly client: AzureOpenAiClient;

  constructor(options: AzureOpenAiProviderOptions) {
    if (!options.apiKey?.trim() || !options.model?.trim()) {
      throw new ProviderError(this.id, "configuration");
    }
    this.model = options.model;
    let baseURL: string;
    try {
      baseURL = providerBaseUrl(options.baseUrl, "AZURE_OPENAI_BASE_URL");
    } catch {
      throw new ProviderError(this.id, "configuration");
    }
    try {
      this.client = options.client ?? new OpenAI({
        apiKey: options.apiKey,
        baseURL,
        // Azure v1 supports the standard SDK's Bearer API-key authentication.
        // Do not inherit unrelated public-OpenAI account metadata from the environment.
        organization: null,
        project: null,
        adminAPIKey: null,
        maxRetries: 0,
        logLevel: "off",
      });
    } catch (error) {
      throw safeProviderError(this.id, error);
    }
  }

  async *stream(request: ProviderRequest): AsyncGenerator<ProviderEvent> {
    validateRequest(this.id, request);
    const messages: ChatCompletionCreateParamsStreaming["messages"] = request.history.flatMap(
      (exchange) => [
        { role: "user" as const, content: exchange.user },
        { role: "assistant" as const, content: exchange.assistant },
      ],
    );
    messages.push({ role: "user", content: request.prompt });
    let finishReason: string | undefined;
    let refused = false;
    let hasAnswer = false;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    try {
      for await (const event of providerStream(this.id, request.signal, (signal) =>
        this.client.chat.completions.create({
          model: this.model,
          messages,
          max_completion_tokens: request.maxOutputTokens,
          stream: true,
          stream_options: { include_usage: true },
          store: false,
        }, { signal, maxRetries: 0 }))) {
        if (event.usage) {
          inputTokens = tokenCount(event.usage.prompt_tokens) ?? inputTokens;
          // Completion usage already includes reasoning; never forward its content.
          outputTokens = tokenCount(event.usage.completion_tokens) ?? outputTokens;
        }
        if (!Array.isArray(event.choices)) throw new ProviderError(this.id, "incomplete_response");
        // Azure filter metadata and final usage can arrive without a choice.
        if (event.choices.length === 0) continue;
        if (event.choices.length !== 1 || event.choices[0]!.index !== 0) {
          throw new ProviderError(this.id, "unsupported_response");
        }
        const choice = event.choices[0]!;
        const delta = choice.delta;
        // Azure async-filter annotations aren't represented in the OpenAI SDK types.
        // They can omit delta, and can arrive after stop but before stream EOF.
        const results = (choice as typeof choice & { content_filter_results?: unknown }).content_filter_results;
        const filtered = isRecord(results) &&
          Object.values(results).some((result) => isRecord(result) && result.filtered === true);
        if (filtered) refused = true;
        const annotationOnly = isRecord(results) &&
          (delta == null || (isRecord(delta) && Object.keys(delta).length === 0)) &&
          (choice.finish_reason == null || choice.finish_reason === "content_filter");
        if (annotationOnly) {
          if (choice.finish_reason === "content_filter" || filtered) {
            // A delayed block must override an earlier stop; success is emitted only at EOF.
            finishReason = "content_filter";
          }
          continue;
        }
        if (finishReason) throw new ProviderError(this.id, "incomplete_response");
        if (!isRecord(delta)) throw new ProviderError(this.id, "incomplete_response");
        if ((delta.tool_calls != null &&
             (!Array.isArray(delta.tool_calls) || delta.tool_calls.length > 0)) || delta.function_call) {
          throw new ProviderError(this.id, "unsupported_response");
        }
        if (delta.refusal) refused = true;
        if (choice.finish_reason) {
          finishReason = choice.finish_reason;
          if (!["stop", "length", "content_filter"].includes(finishReason)) {
            throw new ProviderError(this.id, "unsupported_response");
          }
        }
        // Only answer text is exposed, never refusal details, tools, audio, or reasoning.
        if (!refused && finishReason !== "content_filter" && typeof delta.content === "string" && delta.content) {
          hasAnswer ||= delta.content.trim().length > 0;
          yield { type: "text", text: delta.content };
        }
      }
      checkAbort(this.id, request.signal);
      if (!finishReason) throw new ProviderError(this.id, "incomplete_response");
      const status = refused || finishReason === "content_filter"
        ? "blocked" : finishReason === "length" ? "truncated" : "completed";
      if (status === "completed" && !hasAnswer) throw new ProviderError(this.id, "empty_response");
      yield {
        type: "complete",
        status,
        ...(inputTokens === undefined ? {} : { inputTokens }),
        ...(outputTokens === undefined ? {} : { outputTokens }),
      };
    } catch (error) {
      throw safeProviderError(this.id, error, request.signal);
    }
  }
}
