import type { ChatProvider, ProviderEvent, ProviderId, ProviderRequest } from "../core/contracts.js";
import { checkAbort, validateRequest } from "./stream.js";

export interface MockProviderOptions {
  id: ProviderId;
  model?: string;
}

/** Deterministic, in-process Playground provider. Never constructs an SDK client. */
export class MockProvider implements ChatProvider {
  readonly id: ProviderId;
  readonly model: string;

  constructor(options: MockProviderOptions) {
    this.id = options.id;
    this.model = options.model ?? `mock-${options.id}`;
  }

  async *stream(request: ProviderRequest): AsyncGenerator<ProviderEvent> {
    validateRequest(this.id, request);
    // Avoid echoing prompts/history; fixed synthetic tokens make local cap tests deterministic.
    const chunks = [
      "[Local mock] ",
      `Selected provider: ${this.id}. `,
      `Supplied history: ${request.history.length} exchange(s). `,
      "This is a deterministic test response; no external API was called.",
    ];
    const tokens = chunks.join("").match(/\S+\s*/g)!;
    const visible = tokens.slice(0, request.maxOutputTokens);
    for (const text of visible) {
      checkAbort(this.id, request.signal);
      yield { type: "text", text };
    }
    checkAbort(this.id, request.signal);
    yield {
      type: "complete",
      status: visible.length < tokens.length ? "truncated" : "completed",
      // These are synthetic whitespace-token counts, not provider billing estimates.
      inputTokens: [
        ...request.history.flatMap((exchange) => [exchange.user, exchange.assistant]),
        request.prompt,
      ].join(" ").match(/\S+/g)?.length ?? 0,
      outputTokens: visible.length,
    };
  }
}
