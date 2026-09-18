import { createHash, randomUUID } from "node:crypto";
import type { Container } from "@azure/cosmos";
import type {
  BeginResult,
  ConversationKey,
  ConversationStore,
  ProviderId,
} from "../core/contracts.js";
import {
  CONVERSATION_TTL_SECONDS,
  ConversationConflictError,
  ConversationConflictRetriesExceededError,
  CosmosConversationPersistence,
  HISTORY_TTL_MS,
  MAX_EXCHANGES_PER_PROVIDER,
  MemoryConversationPersistence,
  type ConversationDocument,
  type ConversationPersistence,
} from "./persistence.js";

export const DEFAULT_LEASE_DURATION_MS = 120_000;
export const DEFAULT_MAX_DEDUP_ENTRIES = 256;
export const DEFAULT_MAX_CONFLICT_RETRIES = 5;

export interface ConversationStoreOptions {
  /** Milliseconds since Unix epoch; production replicas need synchronized clocks. */
  clock?: () => number;
  leaseDurationMs?: number;
  /** Activity markers have a fixed 24h expiry, with an additional count bound. */
  maxDedupEntries?: number;
  /** Number of retries after the initial conditional-write attempt. */
  maxConflictRetries?: number;
}

export type CosmosConversationStoreOptions = ConversationStoreOptions &
  (
    | { container: Container; persistence?: never }
    | { persistence: ConversationPersistence; container?: never }
  );

/** Length-delimited by JSON encoding, so delimiters inside identifiers cannot collide. */
export function conversationDocumentId(key: ConversationKey): string {
  return createHash("sha256")
    .update(JSON.stringify([key.tenantId, key.userId, key.conversationId]))
    .digest("hex");
}

function activityHash(activityId: string): string {
  return createHash("sha256").update(activityId).digest("hex");
}

function integerOption(value: number, name: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${name} must be an integer >= ${minimum}.`);
  }
  return value;
}

/** Both public stores execute these same transitions against atomic persistence. */
class PersistentConversationStore implements ConversationStore {
  private readonly clock: () => number;
  private readonly leaseDurationMs: number;
  private readonly maxDedupEntries: number;
  private readonly maxConflictRetries: number;

  constructor(
    private readonly persistence: ConversationPersistence,
    options: ConversationStoreOptions,
  ) {
    this.clock = options.clock ?? Date.now;
    this.leaseDurationMs = integerOption(
      options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS, "leaseDurationMs", 1,
    );
    this.maxDedupEntries = integerOption(
      options.maxDedupEntries ?? DEFAULT_MAX_DEDUP_ENTRIES, "maxDedupEntries", 1,
    );
    this.maxConflictRetries = integerOption(
      options.maxConflictRetries ?? DEFAULT_MAX_CONFLICT_RETRIES, "maxConflictRetries", 0,
    );
  }

  async selection(key: ConversationKey): Promise<ProviderId | undefined> {
    return (await this.persistence.read(conversationDocumentId(key)))?.document.selected;
  }

  select(key: ConversationKey, provider: ProviderId): Promise<"selected" | "busy"> {
    return this.mutate(key, (document) => {
      if (document.lease) return { value: "busy", changed: false };
      const changed = document.selected !== provider;
      document.selected = provider;
      return { value: "selected", changed };
    });
  }

  reset(key: ConversationKey): Promise<void> {
    return this.mutate(key, (document) => {
      document.generation++;
      delete document.selected;
      delete document.lease;
      document.histories = { claude: [], gemini: [] };
      // Keep recent dedup markers: reset must not make old activity retries new.
      return { value: undefined, changed: true };
    });
  }

  begin(key: ConversationKey, activityId: string): Promise<BeginResult> {
    const activity = activityHash(activityId);
    return this.mutate<BeginResult>(key, (document, now) => {
      if (
        document.dedup.some((marker) => marker.activityId === activity) ||
        document.lease?.activityId === activity
      ) {
        return { value: { status: "duplicate" }, changed: false };
      }
      if (document.lease) return { value: { status: "busy" }, changed: false };
      if (!document.selected) {
        return { value: { status: "unselected" }, changed: false };
      }
      const provider = document.selected;
      const leaseId = randomUUID();
      document.lease = {
        id: leaseId, activityId: activity, provider,
        generation: document.generation,
        expiresAt: now + this.leaseDurationMs,
      };
      document.dedup.push({ activityId: activity, expiresAt: now + HISTORY_TTL_MS });
      document.dedup = document.dedup.slice(-this.maxDedupEntries);
      return {
        value: {
          status: "acquired",
          lease: {
            id: leaseId, activityId, provider,
            history: structuredClone(document.histories[provider]),
          },
        },
        changed: true,
      };
    });
  }

  renew(key: ConversationKey, leaseId: string): Promise<boolean> {
    return this.mutate(key, (document, now) => {
      if (!this.ownsLease(document, leaseId)) return { value: false, changed: false };
      document.lease!.expiresAt = now + this.leaseDurationMs;
      return { value: true, changed: true };
    });
  }

  complete(
    key: ConversationKey,
    leaseId: string,
    prompt: string,
    answer: string,
  ): Promise<boolean> {
    return this.mutate(key, (document, now) => {
      if (!this.ownsLease(document, leaseId)) return { value: false, changed: false };
      const provider = document.lease!.provider;
      document.histories[provider].push({
        user: prompt, assistant: answer, createdAt: now, expiresAt: now + HISTORY_TTL_MS,
      });
      document.histories[provider] =
        document.histories[provider].slice(-MAX_EXCHANGES_PER_PROVIDER);
      delete document.lease;
      return { value: true, changed: true };
    });
  }

  release(key: ConversationKey, leaseId: string): Promise<void> {
    return this.mutate(key, (document) => {
      if (!this.ownsLease(document, leaseId)) return { value: undefined, changed: false };
      delete document.lease;
      // The marker recorded by begin survives failure, Stop, or failed delivery.
      return { value: undefined, changed: true };
    });
  }

  private ownsLease(document: ConversationDocument, leaseId: string): boolean {
    // Expired leases have already been removed by prune before every transition.
    return document.lease?.id === leaseId &&
      document.lease.generation === document.generation;
  }

  private prune(document: ConversationDocument, now: number): boolean {
    let changed = false;
    for (const provider of ["claude", "gemini"] as const) {
      const history = document.histories[provider];
      document.histories[provider] = history
        .filter((exchange) => exchange.expiresAt > now)
        .slice(-MAX_EXCHANGES_PER_PROVIDER);
      changed ||= document.histories[provider].length !== history.length;
    }
    const dedupLength = document.dedup.length;
    document.dedup = document.dedup
      .filter((marker) => marker.expiresAt > now)
      .slice(-this.maxDedupEntries);
    changed ||= document.dedup.length !== dedupLength;
    if (
      document.lease &&
      (document.lease.expiresAt <= now || document.lease.generation !== document.generation)
    ) {
      delete document.lease;
      changed = true;
    }
    return changed;
  }

  private async mutate<T>(
    key: ConversationKey,
    transition: (document: ConversationDocument, now: number) => {
      value: T;
      changed: boolean;
    },
  ): Promise<T> {
    const id = conversationDocumentId(key);
    for (let attempt = 0; attempt <= this.maxConflictRetries; attempt++) {
      const snapshot = await this.persistence.read(id);
      const document: ConversationDocument = snapshot
        ? structuredClone(snapshot.document)
        : {
            id, schemaVersion: 1, ttl: CONVERSATION_TTL_SECONDS,
            generation: 0, histories: { claude: [], gemini: [] }, dedup: [],
          };
      // Re-sample on every retry: an ETag conflict must not reuse expired ownership.
      const now = this.clock();
      const pruned = this.prune(document, now);
      const result = transition(document, now);
      if (!pruned && !result.changed) return result.value;
      document.ttl = CONVERSATION_TTL_SECONDS;
      try {
        if (snapshot) await this.persistence.replace(document, snapshot.etag);
        else await this.persistence.create(document);
        return result.value;
      } catch (error) {
        if (!(error instanceof ConversationConflictError)) throw error;
        if (attempt === this.maxConflictRetries) {
          throw new ConversationConflictRetriesExceededError();
        }
      }
    }
    throw new ConversationConflictRetriesExceededError();
  }
}

/** Opt in only for local development/tests; never a production fallback. */
export class MemoryConversationStore extends PersistentConversationStore {
  constructor(options: ConversationStoreOptions = {}) {
    super(new MemoryConversationPersistence(), options);
  }
}

/** Production store. The caller constructs/authenticates the Cosmos client. */
export class CosmosConversationStore extends PersistentConversationStore {
  constructor(container: Container, options?: ConversationStoreOptions);
  constructor(options: CosmosConversationStoreOptions);
  constructor(
    containerOrOptions: Container | CosmosConversationStoreOptions,
    storeOptions: ConversationStoreOptions = {},
  ) {
    const options: CosmosConversationStoreOptions = "item" in containerOrOptions
      ? { ...storeOptions, container: containerOrOptions }
      : containerOrOptions;
    if ((options.container === undefined) === (options.persistence === undefined)) {
      throw new TypeError("Supply exactly one Cosmos container or persistence implementation.");
    }
    super(
      options.persistence ?? new CosmosConversationPersistence(options.container!),
      options,
    );
  }
}
