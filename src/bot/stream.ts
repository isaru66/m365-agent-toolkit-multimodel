import { setTimeout as delay } from "node:timers/promises";

export type StreamFailureCode = "stopped" | "timeout" | "not_allowed" | "delivery";

export class StreamFailure extends Error {
  constructor(readonly code: StreamFailureCode) {
    super(`Teams streaming ${code}`);
  }
}

export type StreamActivity = ({ type: "typing" } | { type: "message" }) & {
  text: string;
  entities: Array<
    | {
        type: "streaminfo";
        streamType: "informative" | "streaming" | "final";
        streamId?: string;
        streamSequence?: number;
      }
    | {
        type: "https://schema.org/Message";
        "@type": "Message";
        "@context": "https://schema.org";
        "@id": "";
        additionalType: ["AIGeneratedContent"];
      }
  >;
};

export type StreamSender = (activity: StreamActivity) => Promise<{ id?: string }>;

function responseDetails(error: unknown): { status?: number; message: string; retryMs: number } {
  if (typeof error !== "object" || error === null || !("response" in error)) {
    return { message: "", retryMs: 2000 };
  }
  const response = error.response;
  if (typeof response !== "object" || response === null) return { message: "", retryMs: 2000 };
  const status = "status" in response && typeof response.status === "number" ? response.status : undefined;
  const data = "data" in response ? response.data : undefined;
  const detail = typeof data === "object" && data !== null && "error" in data ? data.error : undefined;
  const message = typeof detail === "object" && detail !== null && "message" in detail &&
    typeof detail.message === "string" ? detail.message.toLowerCase() : "";
  const headers = "headers" in response ? response.headers : undefined;
  const value = typeof headers === "object" && headers !== null && "retry-after" in headers
    ? Number(headers["retry-after"]) : 2;
  return { status, message, retryMs: Number.isFinite(value) ? Math.max(1500, value * 1000) : 2000 };
}

export interface ReplyStream {
  readonly failure: StreamFailure | undefined;
  start(status: string): Promise<void>;
  append(text: string): void;
  finish(notice?: string): Promise<void>;
  dispose(): Promise<void>;
}

/** Uses the SDK's authenticated send API with the documented native stream protocol.
 * Owning the send loop avoids SDK background-flush errors being swallowed.
 */
export class TeamsReplyStream implements ReplyStream {
  private id?: string;
  private sequence = 0;
  private text = "";
  private sentText = "";
  private status = "";
  private timer?: ReturnType<typeof setTimeout>;
  private pending: Promise<void> = Promise.resolve();
  private ended = false;
  private lastSend = 0;
  private readonly deadline: number;
  failure: StreamFailure | undefined;

  constructor(
    private readonly send: StreamSender,
    private readonly onFailure: (error: StreamFailure) => void,
    private readonly intervalMs = 1800,
    private readonly now = Date.now,
  ) {
    this.deadline = now() + 115000;
  }

  async start(status: string): Promise<void> {
    this.status = status;
    await this.transmit("informative", status);
    this.schedule();
  }

  append(text: string): void {
    if (this.failure) throw this.failure;
    if (this.ended) throw new StreamFailure("delivery");
    this.text += text;
  }

  private schedule(): void {
    if (this.ended || this.failure) return;
    this.timer = setTimeout(() => {
      this.pending = this.flush().catch((error: unknown) => {
        this.fail(error);
      }).finally(() => this.schedule());
    }, this.intervalMs);
  }

  private async flush(): Promise<void> {
    if (this.ended || this.failure) return;
    if (this.text !== this.sentText) {
      const snapshot = this.text;
      await this.transmit("streaming", snapshot);
      this.sentText = snapshot;
    } else if (this.now() - this.lastSend >= 5000) {
      // Keep the stream responsive to Stop even when provider generation stalls.
      await this.transmit(this.text ? "streaming" : "informative", this.text || this.status);
    }
  }

  private fail(error: unknown): StreamFailure {
    if (!this.failure) {
      this.failure = error instanceof StreamFailure ? error : new StreamFailure("delivery");
      this.onFailure(this.failure);
    }
    return this.failure;
  }

  private async transmit(kind: "informative" | "streaming" | "final", text: string): Promise<void> {
    const wait = Math.max(0, this.lastSend + this.intervalMs - this.now());
    if (wait) await delay(wait);
    const activity: StreamActivity = {
      type: kind === "final" ? "message" : "typing",
      text,
      entities: [{
        type: "streaminfo", streamType: kind, streamId: this.id,
        ...(kind === "final" ? {} : { streamSequence: this.sequence + 1 }),
      }],
    };
    if (kind === "final") {
      activity.entities.push({
        type: "https://schema.org/Message", "@type": "Message",
        "@context": "https://schema.org", "@id": "", additionalType: ["AIGeneratedContent"],
      });
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.failure) throw this.failure;
      if (this.now() + 10000 >= this.deadline) throw this.fail(new StreamFailure("timeout"));
      try {
        const response = await this.send(activity);
        if (!response.id && !this.id) throw new StreamFailure("delivery");
        this.id ??= response.id;
        if (kind !== "final") this.sequence++;
        this.lastSend = this.now();
        return;
      } catch (error) {
        const details = responseDetails(error);
        if (details.status === 403) {
          const code = details.message.includes("cancel") ? "stopped"
            : details.message.includes("exceeded streaming time") ? "timeout"
              : details.message.includes("not allowed") ? "not_allowed" : "delivery";
          throw this.fail(new StreamFailure(code));
        }
        if (details.status === 429 && attempt < 2 &&
            this.now() + details.retryMs + 10000 < this.deadline) {
          await delay(details.retryMs);
          continue;
        }
        throw this.fail(error);
      }
    }
  }

  async finish(notice?: string): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.ended = true;
    await this.pending;
    if (this.failure) throw this.failure;
    const text = this.text + (notice ? `\n\n${notice}` : "");
    if (!text.trim()) throw this.fail(new StreamFailure("delivery"));
    await this.transmit("final", text);
  }

  async dispose(): Promise<void> {
    this.ended = true;
    if (this.timer) clearTimeout(this.timer);
    await this.pending;
  }
}
