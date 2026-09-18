import type { ProviderId, ProviderRequest } from "../core/contracts.js";
import { ProviderError, safeProviderError } from "./errors.js";

export function checkAbort(provider: ProviderId, signal: AbortSignal): void {
  if (signal.aborted) throw new ProviderError(provider, "cancelled");
}

export function validateRequest(provider: ProviderId, request: ProviderRequest): void {
  checkAbort(provider, request.signal);
  if (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens <= 0) {
    throw new ProviderError(provider, "invalid_request");
  }
}

export function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

/** Do not wait for a stalled SDK read to acknowledge cancellation. */
function abortable<T>(promise: PromiseLike<T>, provider: ProviderId, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new ProviderError(provider, "cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
    if (signal.aborted) abort();
  });
}

/**
 * A separate controller lets consumer return()/break cancel the HTTP request too.
 * Both opening the request and individual reads are abortable. Cleanup is best
 * effort and deliberately not awaited: async-generator return can queue behind
 * an unresponsive next(), otherwise cancellation itself could hang.
 */
export async function* providerStream<T>(
  provider: ProviderId,
  signal: AbortSignal,
  open: (signal: AbortSignal) => PromiseLike<AsyncIterable<T>>,
): AsyncGenerator<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  let iterator: AsyncIterator<T> | undefined;
  try {
    checkAbort(provider, controller.signal);
    const stream = await abortable(open(controller.signal), provider, controller.signal);
    checkAbort(provider, controller.signal);
    iterator = stream[Symbol.asyncIterator]();
    while (true) {
      checkAbort(provider, controller.signal);
      const next = await abortable(iterator.next(), provider, controller.signal);
      checkAbort(provider, controller.signal);
      if (next.done) break;
      yield next.value;
    }
  } catch (error) {
    throw safeProviderError(provider, error, signal);
  } finally {
    controller.abort();
    signal.removeEventListener("abort", abort);
    try {
      const cleanup = iterator?.return?.();
      if (cleanup) void Promise.resolve(cleanup).catch(() => {});
    } catch {
      // Cleanup must never replace the original error or leak an SDK exception.
    }
  }
}
