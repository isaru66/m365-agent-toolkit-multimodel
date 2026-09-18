import type { ProviderId } from "../core/contracts.js";

const messages = {
  cancelled: "The response was cancelled. Any partial answer is incomplete.",
  timeout: "The provider timed out. Any partial answer is incomplete.",
  authentication: "The provider credentials or permissions need attention.",
  rate_limited: "The provider quota or rate limit was reached. Please try again later.",
  invalid_request: "The provider could not accept this request or model.",
  unavailable: "The provider is temporarily unavailable. Please try again later.",
  empty_response: "The provider returned no answer text.",
  incomplete_response: "The provider response ended without a valid completion.",
  unsupported_response: "The provider returned an unsupported response.",
  configuration: "The provider configuration is invalid.",
  provider_error: "The provider request failed. Any partial answer is incomplete.",
} as const;

export type ProviderErrorCode = keyof typeof messages;

/** Safe to display/log: never retains an SDK error, cause, body, or headers. */
export class ProviderError extends Error {
  readonly provider: ProviderId;
  readonly code: ProviderErrorCode;

  constructor(provider: ProviderId, code: ProviderErrorCode) {
    super(messages[code]);
    this.name = "ProviderError";
    this.provider = provider;
    this.code = code;
  }
}

export function safeProviderError(
  provider: ProviderId,
  error: unknown,
  signal?: AbortSignal,
): ProviderError {
  if (signal?.aborted) return new ProviderError(provider, "cancelled");
  if (error instanceof ProviderError) return error;
  // Read only classification fields; raw messages and response bodies are never copied.
  const fields = error !== null && typeof error === "object"
    ? error as { status?: unknown; name?: unknown }
    : {};
  if (fields.name === "AbortError" || fields.name === "APIUserAbortError") {
    return new ProviderError(provider, "cancelled");
  }
  if (fields.name === "TimeoutError" || fields.name === "APIConnectionTimeoutError"
    || fields.status === 408 || fields.status === 504) {
    return new ProviderError(provider, "timeout");
  }
  if (fields.status === 401 || fields.status === 403) {
    return new ProviderError(provider, "authentication");
  }
  if (fields.status === 429) return new ProviderError(provider, "rate_limited");
  if (fields.status === 400 || fields.status === 404 || fields.status === 422) {
    return new ProviderError(provider, "invalid_request");
  }
  if (typeof fields.status === "number" && fields.status >= 500) {
    return new ProviderError(provider, "unavailable");
  }
  return new ProviderError(provider, "provider_error");
}
