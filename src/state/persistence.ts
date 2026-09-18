import type { Container } from "@azure/cosmos";
import type { Exchange, ProviderId } from "../core/contracts.js";

export const CONVERSATION_TTL_SECONDS = 86_400;
export const HISTORY_TTL_MS = CONVERSATION_TTL_SECONDS * 1_000;
export const MAX_EXCHANGES_PER_PROVIDER = 20;

export interface ConversationDocument {
  id: string;
  schemaVersion: 1;
  ttl: number;
  generation: number;
  selected?: ProviderId;
  histories: Record<ProviderId, Exchange[]>;
  dedup: Array<{ activityId: string; expiresAt: number }>;
  lease?: {
    id: string;
    activityId: string;
    provider: ProviderId;
    generation: number;
    expiresAt: number;
  };
}

export interface ConversationSnapshot {
  document: ConversationDocument;
  etag: string;
}

/**
 * Implementations must return isolated snapshots and make writes atomic.
 * Only actual create/ETag conflicts should throw ConversationConflictError.
 */
export interface ConversationPersistence {
  read(id: string): Promise<ConversationSnapshot | undefined>;
  create(document: ConversationDocument): Promise<void>;
  replace(document: ConversationDocument, etag: string): Promise<void>;
}

export class ConversationConflictError extends Error {
  constructor() {
    super("Conversation state changed concurrently.");
    this.name = "ConversationConflictError";
  }
}

export class ConversationConflictRetriesExceededError extends Error {
  constructor() {
    super("Conversation state conflict retry limit exceeded.");
    this.name = "ConversationConflictRetriesExceededError";
  }
}

/** Explicitly process-local; never use for a multi-replica production runtime. */
export class MemoryConversationPersistence implements ConversationPersistence {
  private readonly documents = new Map<string, ConversationSnapshot>();
  private revision = 0;

  async read(id: string): Promise<ConversationSnapshot | undefined> {
    const snapshot = this.documents.get(id);
    return snapshot ? structuredClone(snapshot) : undefined;
  }

  async create(document: ConversationDocument): Promise<void> {
    if (this.documents.has(document.id)) throw new ConversationConflictError();
    this.save(document);
  }

  async replace(document: ConversationDocument, etag: string): Promise<void> {
    if (this.documents.get(document.id)?.etag !== etag) {
      throw new ConversationConflictError();
    }
    this.save(document);
  }

  private save(document: ConversationDocument): void {
    this.documents.set(document.id, {
      document: structuredClone(document),
      etag: String(++this.revision),
    });
  }
}

function hasStatus(error: unknown, status: number): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === status || error.code === String(status))
  );
}

/** Uses a single document whose partition key is its id (container path /id). */
export class CosmosConversationPersistence implements ConversationPersistence {
  constructor(private readonly container: Container) {}

  async read(id: string): Promise<ConversationSnapshot | undefined> {
    try {
      const response = await this.container
        .item(id, id)
        .read<ConversationDocument>();
      if (response.statusCode === 404) return undefined;
      if (!response.resource || !response.etag) {
        throw new Error("Cosmos conversation read returned no document or ETag.");
      }
      // Drop Cosmos system properties rather than sending them back on replace.
      const { id: documentId, schemaVersion, ttl, generation, selected,
        histories, dedup, lease } = response.resource;
      return {
        document: {
          id: documentId, schemaVersion, ttl, generation,
          ...(selected === undefined ? {} : { selected }),
          histories, dedup,
          ...(lease === undefined ? {} : { lease }),
        },
        etag: response.etag,
      };
    } catch (error) {
      if (hasStatus(error, 404)) return undefined;
      throw error;
    }
  }

  async create(document: ConversationDocument): Promise<void> {
    try {
      await this.container.items.create(document);
    } catch (error) {
      if (hasStatus(error, 409)) throw new ConversationConflictError();
      throw error;
    }
  }

  async replace(document: ConversationDocument, etag: string): Promise<void> {
    try {
      await this.container.item(document.id, document.id).replace(document, {
        accessCondition: { type: "IfMatch", condition: etag },
      });
    } catch (error) {
      // A TTL deletion between read and write is also an optimistic conflict.
      if (hasStatus(error, 412) || hasStatus(error, 404)) {
        throw new ConversationConflictError();
      }
      throw error;
    }
  }
}
