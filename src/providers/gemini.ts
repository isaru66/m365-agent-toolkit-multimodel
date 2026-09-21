import {
  GoogleGenAI,
  type GenerateContentParameters,
  type GenerateContentResponse,
} from "@google/genai";
import type { ChatProvider, ProviderEvent, ProviderRequest } from "../core/contracts.js";
import { providerBaseUrl } from "../config/endpoints.js";
import { ProviderError, safeProviderError } from "./errors.js";
import { checkAbort, providerStream, tokenCount, validateRequest } from "./stream.js";

export interface GeminiClient {
  models: {
    generateContentStream(
      parameters: GenerateContentParameters,
    ): PromiseLike<AsyncIterable<GenerateContentResponse>>;
  };
}

export interface GeminiProviderOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  client?: GeminiClient;
}

const blockedReasons = new Set([
  "SAFETY", "RECITATION", "LANGUAGE", "BLOCKLIST", "PROHIBITED_CONTENT",
  "SPII", "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT", "IMAGE_RECITATION",
]);

export class GeminiProvider implements ChatProvider {
  readonly id = "gemini" as const;
  readonly model: string;
  private readonly client: GeminiClient;

  constructor(options: GeminiProviderOptions) {
    if (!options.apiKey?.trim() || !options.model?.trim()) {
      throw new ProviderError(this.id, "configuration");
    }
    this.model = options.model;
    let baseUrl: string;
    try {
      baseUrl = providerBaseUrl(options.baseUrl, "GEMINI_BASE_URL");
    } catch {
      throw new ProviderError(this.id, "configuration");
    }
    try {
      this.client = options.client ?? new GoogleGenAI({
        apiKey: options.apiKey,
        vertexai: false,
        httpOptions: {
          baseUrl,
          apiVersion: "v1beta",
          retryOptions: { attempts: 1 },
        },
      });
    } catch (error) {
      throw safeProviderError(this.id, error);
    }
  }

  async *stream(request: ProviderRequest): AsyncGenerator<ProviderEvent> {
    validateRequest(this.id, request);
    // Do not use chats, interactions, previous IDs, or any provider-held history.
    const contents = request.history.flatMap((exchange) => [
      { role: "user", parts: [{ text: exchange.user }] },
      { role: "model", parts: [{ text: exchange.assistant }] },
    ]);
    contents.push({ role: "user", parts: [{ text: request.prompt }] });
    let finishReason: string | undefined;
    let promptBlocked = false;
    let hasAnswer = false;
    let inputTokens: number | undefined;
    let candidateTokens: number | undefined;
    let thoughtTokens: number | undefined;
    try {
      for await (const event of providerStream(this.id, request.signal, (signal) =>
        this.client.models.generateContentStream({
          model: this.model,
          contents,
          config: {
            maxOutputTokens: request.maxOutputTokens,
            candidateCount: 1,
            responseModalities: ["TEXT"],
            thinkingConfig: { includeThoughts: false },
            abortSignal: signal,
            httpOptions: { retryOptions: { attempts: 1 } },
          },
        }))) {
        if (event.usageMetadata) {
          inputTokens = tokenCount(event.usageMetadata.promptTokenCount) ?? inputTokens;
          candidateTokens = tokenCount(event.usageMetadata.candidatesTokenCount) ?? candidateTokens;
          thoughtTokens = tokenCount(event.usageMetadata.thoughtsTokenCount) ?? thoughtTokens;
        }
        const blockReason = event.promptFeedback?.blockReason;
        if (blockReason && blockReason !== "BLOCKED_REASON_UNSPECIFIED") promptBlocked = true;
        // Only the requested single candidate is allowed; never mix alternative answers.
        if (event.candidates && event.candidates.length > 1) {
          throw new ProviderError(this.id, "unsupported_response");
        }
        const candidate = event.candidates?.[0];
        if (!candidate) continue; // Metadata-only final chunks are valid.
        if (candidate.index !== undefined && candidate.index !== 0) {
          throw new ProviderError(this.id, "unsupported_response");
        }
        const parts = candidate.content?.parts ?? [];
        const texts = parts.filter((part) => part.thought !== true && typeof part.text === "string")
          .map((part) => part.text!)
          .filter((text) => text.length > 0);
        // A terminal chunk may include final text, but later text is malformed.
        if (finishReason && texts.length > 0) {
          throw new ProviderError(this.id, "incomplete_response");
        }
        if (candidate.finishReason) {
          if (finishReason && finishReason !== candidate.finishReason) {
            throw new ProviderError(this.id, "incomplete_response");
          }
          finishReason = candidate.finishReason;
        }
        if (!promptBlocked && !(finishReason && blockedReasons.has(finishReason))) {
          for (const text of texts) {
            hasAnswer ||= text.trim().length > 0;
            yield { type: "text", text };
            checkAbort(this.id, request.signal);
          }
        }
      }
      checkAbort(this.id, request.signal);
      let status: "completed" | "truncated" | "blocked";
      if (promptBlocked || (finishReason && blockedReasons.has(finishReason))) {
        status = "blocked";
      } else if (finishReason === "MAX_TOKENS") {
        status = "truncated";
      } else if (finishReason === "STOP") {
        status = "completed";
      } else {
        throw new ProviderError(this.id, finishReason ? "unsupported_response" : "incomplete_response");
      }
      if (status === "completed" && !hasAnswer) throw new ProviderError(this.id, "empty_response");
      yield {
        type: "complete",
        status,
        ...(inputTokens === undefined ? {} : { inputTokens }),
        // Include billed reasoning output without ever forwarding thought content.
        ...(candidateTokens === undefined && thoughtTokens === undefined ? {} : {
          outputTokens: (candidateTokens ?? 0) + (thoughtTokens ?? 0),
        }),
      };
    } catch (error) {
      throw safeProviderError(this.id, error, request.signal);
    }
  }
}
