import { describe, expect, it } from "vitest";
import type { ConversationKey, ConversationStore, Lease } from "../src/core/contracts.js";
import {
  conversationDocumentId,
  ConversationConflictError,
  ConversationConflictRetriesExceededError,
  CosmosConversationStore,
  DEFAULT_LEASE_DURATION_MS,
  HISTORY_TTL_MS,
  MemoryConversationPersistence,
  MemoryConversationStore,
  type ConversationDocument,
} from "../src/state/index.js";

const key: ConversationKey = {
  tenantId: "test-tenant", userId: "test-user", conversationId: "test-conversation",
};

async function acquire(
  store: ConversationStore,
  activityId: string,
  scope = key,
): Promise<Lease> {
  const result = await store.begin(scope, activityId);
  expect(result.status).toBe("acquired");
  if (result.status !== "acquired") throw new Error("Expected acquired lease.");
  return result.lease;
}

for (const mode of ["memory", "cosmos-persistence"] as const) {
  describe(`${mode}: shared conversation transitions`, () => {
    function setup() {
      let now = 1_000_000;
      const clock = () => now;
      const store = mode === "memory"
        ? new MemoryConversationStore({ clock })
        : new CosmosConversationStore({
            persistence: new MemoryConversationPersistence(), clock,
          });
      return { store, advance: (ms: number) => { now += ms; }, clock };
    }

    it("requires explicit selection and rejects changes while busy", async () => {
      const { store } = setup();
      expect(await store.selection(key)).toBeUndefined();
      expect(await store.begin(key, "a")).toEqual({ status: "unselected" });
      expect(await store.select(key, "claude")).toBe("selected");
      const lease = await acquire(store, "a");
      expect(lease.provider).toBe("claude");
      expect(lease.history).toEqual([]);
      expect(await store.select(key, "gemini")).toBe("busy");
      expect(await store.selection(key)).toBe("claude");
      expect(await store.begin(key, "b")).toEqual({ status: "busy" });
      await store.release(key, lease.id);
      await store.select(key, "gemini");
      expect((await acquire(store, "b")).provider).toBe("gemini");
    });

    it("keeps independent provider histories and excludes failed exchanges", async () => {
      const { store } = setup();
      await store.select(key, "claude");
      const claude = await acquire(store, "claude");
      expect(await store.complete(key, claude.id, "claude prompt", "claude answer")).toBe(true);
      await store.select(key, "gemini");
      const gemini = await acquire(store, "gemini");
      expect(gemini.history).toEqual([]);
      await store.complete(key, gemini.id, "gemini prompt", "gemini answer");
      const failed = await acquire(store, "failed");
      await store.release(key, failed.id);
      await store.select(key, "claude");
      const resumed = await acquire(store, "resumed");
      expect(resumed.history.map((exchange) => exchange.user)).toEqual(["claude prompt"]);
      await store.release(key, resumed.id);
      await store.select(key, "gemini");
      expect((await acquire(store, "resumed-gemini")).history.map((exchange) => exchange.user))
        .toEqual(["gemini prompt"]);
    });

    it("filters the exact 24-hour boundary without sliding expiry on writes", async () => {
      const { store, advance, clock } = setup();
      await store.select(key, "claude");
      const first = await acquire(store, "first");
      const createdAt = clock();
      await store.complete(key, first.id, "old", "answer");
      advance(HISTORY_TTL_MS - 1);
      await store.select(key, "gemini");
      await store.select(key, "claude");
      const before = await acquire(store, "before-boundary");
      expect(before.history).toEqual([{
        user: "old", assistant: "answer", createdAt, expiresAt: createdAt + HISTORY_TTL_MS,
      }]);
      await store.release(key, before.id);
      advance(1);
      expect((await acquire(store, "at-boundary")).history).toEqual([]);
    });

    it("caps each provider at its own latest 20 completed exchanges", async () => {
      const { store, advance } = setup();
      for (const provider of ["claude", "gemini"] as const) {
        await store.select(key, provider);
        for (let i = 0; i < 23; i++) {
          const lease = await acquire(store, `${provider}-${i}`);
          await store.complete(key, lease.id, `${provider}-prompt-${i}`, "answer");
          advance(1);
        }
      }
      for (const provider of ["claude", "gemini"] as const) {
        await store.select(key, provider);
        const lease = await acquire(store, `${provider}-inspect`);
        expect(lease.history).toHaveLength(20);
        expect(lease.history[0]?.user).toBe(`${provider}-prompt-3`);
        expect(lease.history[19]?.user).toBe(`${provider}-prompt-22`);
        await store.release(key, lease.id);
      }
    });

    it("isolates every tenant/user/conversation component", async () => {
      const { store } = setup();
      const keys = [
        key,
        { ...key, tenantId: "another-tenant" },
        { ...key, userId: "another-user" },
        { ...key, conversationId: "another-conversation" },
      ];
      await store.select(key, "claude");
      const original = await acquire(store, "same-id");
      await store.complete(key, original.id, "private prompt", "private answer");
      for (const scope of keys.slice(1)) {
        expect(await store.selection(scope)).toBeUndefined();
        await store.select(scope, "gemini");
        const isolated = await acquire(store, "same-id", scope);
        expect(isolated.history).toEqual([]);
        expect(await store.complete(scope, original.id, "wrong", "wrong")).toBe(false);
      }
      expect(await store.selection(key)).toBe("claude");
    });

    it("deduplicates active, completed, failed/released, and expired-lease activity retries", async () => {
      const { store, advance } = setup();
      await store.select(key, "claude");
      const completed = await acquire(store, "completed");
      expect(await store.begin(key, "completed")).toEqual({ status: "duplicate" });
      await store.complete(key, completed.id, "prompt", "answer");
      expect(await store.complete(key, completed.id, "again", "again")).toBe(false);
      expect(await store.begin(key, "completed")).toEqual({ status: "duplicate" });
      const failed = await acquire(store, "failed");
      await store.release(key, failed.id);
      expect(await store.begin(key, "failed")).toEqual({ status: "duplicate" });
      await acquire(store, "expired");
      advance(DEFAULT_LEASE_DURATION_MS);
      expect(await store.begin(key, "expired")).toEqual({ status: "duplicate" });
      await acquire(store, "next");
    });

    it("renews only a live owner and excludes ownership at exact lease expiry", async () => {
      const { store, advance } = setup();
      await store.select(key, "claude");
      const lease = await acquire(store, "a");
      expect(await store.renew(key, "not-owner")).toBe(false);
      expect(await store.complete(key, "not-owner", "wrong", "wrong")).toBe(false);
      advance(DEFAULT_LEASE_DURATION_MS - 1);
      expect(await store.renew(key, lease.id)).toBe(true);
      advance(1);
      expect(await store.begin(key, "b")).toEqual({ status: "busy" });
      advance(DEFAULT_LEASE_DURATION_MS - 1);
      expect(await store.renew(key, lease.id)).toBe(false);
      expect(await store.complete(key, lease.id, "late", "late")).toBe(false);
      const replacement = await acquire(store, "b");
      await store.release(key, lease.id);
      expect(await store.begin(key, "c")).toEqual({ status: "busy" });
      expect(await store.complete(key, replacement.id, "new", "new")).toBe(true);
    });

    it("reset clears selection/both histories, invalidates owners, and preserves dedup", async () => {
      const { store } = setup();
      for (const provider of ["claude", "gemini"] as const) {
        await store.select(key, provider);
        const lease = await acquire(store, provider);
        await store.complete(key, lease.id, provider, "answer");
      }
      const old = await acquire(store, "old-active");
      await store.reset(key);
      expect(await store.selection(key)).toBeUndefined();
      expect(await store.renew(key, old.id)).toBe(false);
      expect(await store.complete(key, old.id, "old", "old")).toBe(false);
      for (const activity of ["claude", "gemini", "old-active"]) {
        expect(await store.begin(key, activity)).toEqual({ status: "duplicate" });
      }
      for (const provider of ["claude", "gemini"] as const) {
        await store.select(key, provider);
        const newLease = await acquire(store, `${provider}-new`);
        expect(newLease.history).toEqual([]);
        await store.release(key, old.id);
        expect(await store.renew(key, newLease.id)).toBe(true);
        await store.release(key, newLease.id);
      }
    });

    it("returns isolated history snapshots rather than mutable stored objects", async () => {
      const { store } = setup();
      await store.select(key, "claude");
      const first = await acquire(store, "first");
      await store.complete(key, first.id, "original", "answer");
      const second = await acquire(store, "second");
      second.history[0]!.user = "changed by caller";
      second.history.push({ user: "injected", assistant: "injected", createdAt: 0, expiresAt: 0 });
      await store.release(key, second.id);
      expect((await acquire(store, "third")).history.map((exchange) => exchange.user))
        .toEqual(["original"]);
    });

    it("grants only one competing begin, and one of duplicate begins", async () => {
      const { store } = setup();
      await store.select(key, "claude");
      const results = await Promise.all([store.begin(key, "a"), store.begin(key, "b")]);
      expect(results.map((result) => result.status).sort()).toEqual(["acquired", "busy"]);
      await store.reset(key);
      await store.select(key, "claude");
      const duplicate = await Promise.all([store.begin(key, "c"), store.begin(key, "c")]);
      expect(duplicate.map((result) => result.status).sort()).toEqual(["acquired", "duplicate"]);
    });
  });
}

class HookPersistence extends MemoryConversationPersistence {
  beforeReplace?: () => Promise<void>;
  replacements = 0;

  override async replace(document: ConversationDocument, etag: string): Promise<void> {
    this.replacements++;
    const hook = this.beforeReplace;
    this.beforeReplace = undefined;
    await hook?.();
    await super.replace(document, etag);
  }
}

describe("persistence races and bounded retries", () => {
  it("hashes all scopes without delimiter collisions or raw identifiers", () => {
    const id = conversationDocumentId(key);
    expect(id).toMatch(/^[a-f0-9]{64}$/);
    expect(conversationDocumentId({ tenantId: "a:b", userId: "c", conversationId: "d" }))
      .not.toBe(conversationDocumentId({ tenantId: "a", userId: "b:c", conversationId: "d" }));
  });

  it("enforces a single owner across independent replicas sharing persistence", async () => {
    const persistence = new MemoryConversationPersistence();
    const a = new CosmosConversationStore({ persistence });
    const b = new CosmosConversationStore({ persistence });
    await Promise.all([a.select(key, "claude"), b.select(key, "claude")]);
    const results = await Promise.all([a.begin(key, "a"), b.begin(key, "b")]);
    expect(results.map((result) => result.status).sort()).toEqual(["acquired", "busy"]);
    expect(await b.select(key, "gemini")).toBe("busy");
  });

  it("retries a completion/reset race without reviving erased prompts or selection", async () => {
    const persistence = new HookPersistence();
    const a = new CosmosConversationStore({ persistence });
    const b = new CosmosConversationStore({ persistence });
    await a.select(key, "claude");
    const lease = await acquire(a, "old");
    persistence.beforeReplace = () => b.reset(key);
    expect(await a.complete(key, lease.id, "old prompt", "old answer")).toBe(false);
    expect(await b.selection(key)).toBeUndefined();
    await b.select(key, "claude");
    expect((await acquire(b, "new")).history).toEqual([]);
    expect(await a.begin(key, "old")).toEqual({ status: "duplicate" });
  });

  it("rechecks expiration with a fresh clock after a conditional-write conflict", async () => {
    let now = 0;
    const persistence = new HookPersistence();
    const store = new CosmosConversationStore({ persistence, clock: () => now });
    await store.select(key, "claude");
    const lease = await acquire(store, "a");
    persistence.beforeReplace = async () => {
      now = DEFAULT_LEASE_DURATION_MS;
      throw new ConversationConflictError();
    };
    expect(await store.complete(key, lease.id, "late", "late")).toBe(false);
    expect((await acquire(store, "b")).history).toEqual([]);
  });

  it("bounds retry attempts exactly and exposes exhausted conflicts", async () => {
    class ConflictingPersistence extends MemoryConversationPersistence {
      attempts = 0;
      override async create(): Promise<void> {
        this.attempts++;
        throw new ConversationConflictError();
      }
    }
    const persistence = new ConflictingPersistence();
    const store = new CosmosConversationStore({ persistence, maxConflictRetries: 2 });
    await expect(store.select(key, "claude"))
      .rejects.toBeInstanceOf(ConversationConflictRetriesExceededError);
    expect(persistence.attempts).toBe(3);
  });

  it("does not retry or suppress unrelated persistence errors", async () => {
    const failure = new Error("Test transport failure");
    class FailingPersistence extends MemoryConversationPersistence {
      attempts = 0;
      override async create(): Promise<void> {
        this.attempts++;
        throw failure;
      }
    }
    const persistence = new FailingPersistence();
    const store = new CosmosConversationStore({ persistence });
    await expect(store.select(key, "claude")).rejects.toBe(failure);
    expect(persistence.attempts).toBe(1);
  });

  it("prunes both stored histories on mutation and writes Cosmos cleanup TTL", async () => {
    let now = 0;
    const persistence = new MemoryConversationPersistence();
    const store = new CosmosConversationStore({ persistence, clock: () => now });
    for (const provider of ["claude", "gemini"] as const) {
      await store.select(key, provider);
      const lease = await acquire(store, provider);
      await store.complete(key, lease.id, provider, "answer");
    }
    now = HISTORY_TTL_MS;
    await store.select(key, "claude");
    const snapshot = await persistence.read(conversationDocumentId(key));
    expect(snapshot?.document.histories).toEqual({ claude: [], gemini: [] });
    expect(snapshot?.document.dedup).toEqual([]);
    expect(snapshot?.document.ttl).toBe(86_400);
  });

  it("bounds fixed-expiry dedup by count, preserves markers on reset, and expires at equality", async () => {
    let now = 0;
    const persistence = new MemoryConversationPersistence();
    const store = new CosmosConversationStore({
      persistence, clock: () => now, maxDedupEntries: 2,
    });
    await store.select(key, "claude");
    for (const id of ["a", "b", "c"]) {
      const lease = await acquire(store, id);
      await store.release(key, lease.id);
    }
    expect((await persistence.read(conversationDocumentId(key)))?.document.dedup).toHaveLength(2);
    const evicted = await acquire(store, "a");
    await store.release(key, evicted.id);
    await store.reset(key);
    now = HISTORY_TTL_MS - 1;
    expect(await store.begin(key, "a")).toEqual({ status: "duplicate" });
    now++;
    expect(await store.begin(key, "a")).toEqual({ status: "unselected" });
    await store.select(key, "claude");
    await acquire(store, "a");
  });

  it("honors configurable lease duration and rejects invalid options", async () => {
    let now = 0;
    const store = new MemoryConversationStore({ leaseDurationMs: 10, clock: () => now });
    await store.select(key, "claude");
    const lease = await acquire(store, "a");
    now = 10;
    expect(await store.complete(key, lease.id, "late", "late")).toBe(false);
    expect(() => new MemoryConversationStore({ leaseDurationMs: 0 })).toThrow(RangeError);
    expect(() => new MemoryConversationStore({ maxDedupEntries: 0 })).toThrow(RangeError);
    expect(() => new MemoryConversationStore({ maxConflictRetries: -1 })).toThrow(RangeError);
  });
});
