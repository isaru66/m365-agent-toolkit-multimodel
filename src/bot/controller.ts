import { randomUUID } from "node:crypto";
import type { Config } from "../config/index.js";
import type { ChatProvider, ConversationStore, Exchange, ProviderId } from "../core/contracts.js";
import { logEvent } from "../telemetry/logger.js";
import { ProviderError } from "../providers/index.js";
import type { AcceptedMessage } from "./access.js";
import { StreamFailure, type ReplyStream } from "./stream.js";

export interface ChatOutput {
  send(text: string): Promise<void>;
  chooseModel(): Promise<void>;
  stream(onFailure: (error: StreamFailure) => void): ReplyStream;
}

export function trimHistory(history: Exchange[], prompt: string, budget: number): Exchange[] {
  let size = Buffer.byteLength(prompt, "utf8");
  const result: Exchange[] = [];
  for (const exchange of [...history].reverse()) {
    size += Buffer.byteLength(exchange.user, "utf8") + Buffer.byteLength(exchange.assistant, "utf8");
    if (size > budget) break;
    result.unshift(exchange);
  }
  return result;
}

export class ChatController {
  private readonly active = new Map<string, AbortController>();
  constructor(
    private readonly config: Config,
    private readonly store: ConversationStore,
    private readonly providers: Record<ProviderId, ChatProvider>,
  ) {}

  async stop(): Promise<void> {
    for (const abort of this.active.values()) abort.abort(new Error("shutdown"));
  }

  async handle(message: AcceptedMessage, output: ChatOutput): Promise<void> {
    const { key, text, activityId } = message;
    const command = text.toLowerCase();
    if (command === "help" || !text) {
      await output.chooseModel();
      return;
    }
    if (command === "reset") {
      await this.store.reset(key);
      this.active.get(JSON.stringify(key))?.abort(new Error("reset"));
      await output.send("Conversation reset. Both models' app-held histories and your selection are cleared. " +
        "Teams messages and provider-retained data are not deleted.");
      return;
    }
    if (command === "model") {
      const selected = await this.store.selection(key);
      if (selected) await output.send(`Selected: ${selected} (${this.providers[selected].model}).`);
      await output.chooseModel();
      return;
    }
    if (command.startsWith("model ")) {
      const selected = command.slice(6).trim();
      if (selected !== "claude" && selected !== "gemini") {
        await output.send("Choose `model claude` or `model gemini`.");
        return;
      }
      const result = await this.store.select(key, selected);
      await output.send(result === "busy"
        ? "A response is active. Stop it or wait for it to finish before changing models."
        : `Selected ${selected} (${this.providers[selected].model}). Only this provider's unexpired history will be used.`);
      return;
    }
    if (message.hasAttachments) {
      await output.send("This version supports text only. Please send your question without attachments.");
      return;
    }
    if (text.length > this.config.maxInputChars ||
        Buffer.byteLength(text, "utf8") > this.config.maxContextBytes) {
      await output.send(`Your prompt is too large. Use at most ${this.config.maxInputChars} characters and stay within the context byte limit.`);
      return;
    }
    const started = await this.store.begin(key, activityId);
    if (started.status === "duplicate") return;
    if (started.status === "unselected") {
      await output.chooseModel();
      return;
    }
    if (started.status === "busy") {
      await output.send("A response is already active in this chat. Stop it or wait for it to finish.");
      return;
    }
    if (started.status !== "acquired") throw new Error("Unexpected conversation state");
    const lease = started.lease;
    const provider = this.providers[lease.provider];
    const abort = new AbortController();
    const correlationId = randomUUID();
    const beganAt = Date.now();
    const activeKey = JSON.stringify(key);
    this.active.set(activeKey, abort);
    const stream = output.stream((error) => abort.abort(error));
    const timeout = setTimeout(() => abort.abort(new StreamFailure("timeout")), this.config.streamTimeoutMs);
    let heartbeat: ReturnType<typeof setTimeout> | undefined;
    let renewing: Promise<void> = Promise.resolve();
    let done = false;
    const renew = () => {
      heartbeat = setTimeout(() => {
        renewing = this.store.renew(key, lease.id).then((owned) => {
          if (!owned) abort.abort(new Error("lease_lost"));
        }).catch(() => {
          logEvent("state_renew_failed", { correlationId });
          abort.abort(new Error("state_unavailable"));
        }).finally(() => {
          if (!done && !abort.signal.aborted) renew();
        });
      }, 3000);
    };
    renew();
    let textLength = 0;
    let answer = "";
    let completed = false;
    let finalized = false;
    try {
      const history = trimHistory(lease.history, text, this.config.maxContextBytes);
      const trimmed = history.length < lease.history.length;
      await stream.start(`Generating with ${provider.model}${trimmed ? " (older context omitted to fit the limit)" : ""}...`);
      abort.signal.throwIfAborted();
      for await (const event of provider.stream({
        prompt: text, history, maxOutputTokens: this.config.maxOutputTokens, signal: abort.signal,
      })) {
        abort.signal.throwIfAborted();
        if (stream.failure) throw stream.failure;
        if (event.type === "text") {
          if (completed) throw new Error("provider_content_after_completion");
          if (textLength === 0 && event.text) {
            logEvent("answer_started", { correlationId, provider: provider.id, milliseconds: Date.now() - beganAt });
          }
          textLength += Buffer.byteLength(event.text, "utf8");
          if (textLength > 24000) throw new Error("message_size_limit");
          answer += event.text;
          stream.append(event.text);
        } else {
          if (event.status !== "completed") throw new Error(`provider_${event.status}`);
          completed = true;
          logEvent("provider_completed", {
            correlationId, provider: provider.id, model: provider.model,
            inputTokens: event.inputTokens, outputTokens: event.outputTokens,
          });
        }
      }
      abort.signal.throwIfAborted();
      if (!completed || !answer.trim()) throw new Error("provider_incomplete");
      if (!await this.store.renew(key, lease.id)) throw new Error("lease_lost");
      await stream.finish();
      finalized = true;
      abort.signal.throwIfAborted();
      if (!await this.store.complete(key, lease.id, text, answer)) {
        await output.send("The answer was delivered, but the conversation changed before it could be saved. It will not be used as future context.");
      }
      logEvent("answer_completed", { correlationId, provider: provider.id, milliseconds: Date.now() - beganAt });
    } catch (error) {
      abort.abort(error);
      const reason = stream.failure?.code ??
        (error instanceof StreamFailure || error instanceof ProviderError ? error.code : "generation");
      logEvent("answer_incomplete", { correlationId, provider: provider.id, reason });
      const notice = reason === "stopped"
        ? "Stopped. The partial answer is incomplete and this exchange is excluded from future context."
        : reason === "not_allowed"
          ? "Teams streaming is not available for this app or user. No alternate model was called."
          : error instanceof ProviderError
            ? `Response incomplete. ${error.message} This exchange is excluded from future context.`
            : "Response incomplete: generation, delivery, or the response limit interrupted it. This exchange is excluded from future context. Please try a shorter prompt.";
      if (!finalized && !stream.failure) {
        try {
          await stream.finish(notice);
        } catch {
          logEvent("incomplete_notice_delivery_failed", { correlationId });
          await output.send(notice);
        }
      } else {
        await output.send(notice);
      }
    } finally {
      done = true;
      clearTimeout(timeout);
      if (heartbeat) clearTimeout(heartbeat);
      abort.abort();
      await renewing;
      await stream.dispose();
      if (this.active.get(activeKey) === abort) this.active.delete(activeKey);
      await this.store.release(key, lease.id);
    }
  }
}
