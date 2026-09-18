export type ProviderId = "claude" | "gemini";

export interface ConversationKey {
  tenantId: string;
  userId: string;
  conversationId: string;
}

export interface Exchange {
  user: string;
  assistant: string;
  createdAt: number;
  expiresAt: number;
}

export interface ProviderRequest {
  prompt: string;
  history: Exchange[];
  maxOutputTokens: number;
  signal: AbortSignal;
}

export type ProviderEvent =
  | { type: "text"; text: string }
  | {
      type: "complete";
      status: "completed" | "truncated" | "blocked";
      inputTokens?: number;
      outputTokens?: number;
    };

export interface ChatProvider {
  readonly id: ProviderId;
  readonly model: string;
  stream(request: ProviderRequest): AsyncIterable<ProviderEvent>;
}

export interface Lease {
  id: string;
  activityId: string;
  provider: ProviderId;
  history: Exchange[];
}

export type BeginResult =
  | { status: "acquired"; lease: Lease }
  | { status: "busy" | "duplicate" | "unselected" };

export interface ConversationStore {
  selection(key: ConversationKey): Promise<ProviderId | undefined>;
  select(key: ConversationKey, provider: ProviderId): Promise<"selected" | "busy">;
  reset(key: ConversationKey): Promise<void>;
  begin(key: ConversationKey, activityId: string): Promise<BeginResult>;
  renew(key: ConversationKey, leaseId: string): Promise<boolean>;
  complete(
    key: ConversationKey,
    leaseId: string,
    prompt: string,
    answer: string,
  ): Promise<boolean>;
  release(key: ConversationKey, leaseId: string): Promise<void>;
}
