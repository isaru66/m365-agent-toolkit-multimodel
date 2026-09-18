import type { Container } from "@azure/cosmos";
import { describe, expect, it, vi } from "vitest";
import {
  ConversationConflictError,
  CosmosConversationPersistence,
  CosmosConversationStore,
  type ConversationDocument,
} from "../src/state/index.js";

const document: ConversationDocument = {
  id: "hashed-id", schemaVersion: 1, ttl: 86_400, generation: 0,
  histories: { claude: [], gemini: [] }, dedup: [],
};

function mockContainer() {
  const read = vi.fn().mockResolvedValue({
    resource: { ...document, _etag: "system-etag", _ts: 123 },
    etag: "etag-1", statusCode: 200,
  });
  const replace = vi.fn().mockResolvedValue({});
  const create = vi.fn().mockResolvedValue({});
  const item = vi.fn().mockReturnValue({ read, replace });
  const container = { item, items: { create } } as unknown as Container;
  return {
    container, read, replace, create, item, persistence: new CosmosConversationPersistence(container),
  };
}

describe("Cosmos SDK adapter", () => {
  it("supports a Container plus optional store options constructor", async () => {
    const { container, read, create } = mockContainer();
    read.mockResolvedValueOnce({ statusCode: 404 });
    const store = new CosmosConversationStore(container, {
      clock: () => 123, leaseDurationMs: 120_000,
    });
    await expect(store.select({
      tenantId: "tenant", userId: "user", conversationId: "conversation",
    }, "claude")).resolves.toBe("selected");
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      selected: "claude", ttl: 86_400,
    }));
  });

  it("reads by /id partition key and retains the ETag without system properties", async () => {
    const { persistence, item } = mockContainer();
    expect(await persistence.read(document.id)).toEqual({ document, etag: "etag-1" });
    expect(item).toHaveBeenCalledWith(document.id, document.id);
  });

  it("uses atomic create and IfMatch conditional replacement, never upsert", async () => {
    const { persistence, create, item, replace } = mockContainer();
    await persistence.create(document);
    expect(create).toHaveBeenCalledWith(document);
    await persistence.replace(document, "expected-etag");
    expect(item).toHaveBeenCalledWith(document.id, document.id);
    expect(replace).toHaveBeenCalledWith(document, {
      accessCondition: { type: "IfMatch", condition: "expected-etag" },
    });
  });

  it("treats only an explicit read 404 as absence, including non-throwing SDK responses", async () => {
    const { persistence, read } = mockContainer();
    read.mockRejectedValueOnce({ code: 404 });
    expect(await persistence.read(document.id)).toBeUndefined();
    read.mockResolvedValueOnce({ statusCode: 404 });
    expect(await persistence.read(document.id)).toBeUndefined();
    read.mockResolvedValueOnce({ statusCode: 200 });
    await expect(persistence.read(document.id)).rejects.toThrow("no document or ETag");
    read.mockResolvedValueOnce({ resource: document, statusCode: 200 });
    await expect(persistence.read(document.id)).rejects.toThrow("no document or ETag");
  });

  it.each([401, 403, 429, 500, 503])("propagates read error %s unchanged", async (code) => {
    const { persistence, read } = mockContainer();
    const failure = { code };
    read.mockRejectedValueOnce(failure);
    await expect(persistence.read(document.id)).rejects.toBe(failure);
  });

  it("classifies create 409 and replacement 412/404 as conflicts", async () => {
    const { persistence, create, replace } = mockContainer();
    create.mockRejectedValueOnce({ code: 409 });
    await expect(persistence.create(document)).rejects.toBeInstanceOf(ConversationConflictError);
    for (const code of [412, "412", 404]) {
      replace.mockRejectedValueOnce({ code });
      await expect(persistence.replace(document, "etag"))
        .rejects.toBeInstanceOf(ConversationConflictError);
    }
  });

  it.each([401, 403, 429, 500, 503])("propagates write error %s unchanged", async (code) => {
    const { persistence, create, replace } = mockContainer();
    const failure = { code };
    create.mockRejectedValueOnce(failure);
    await expect(persistence.create(document)).rejects.toBe(failure);
    replace.mockRejectedValueOnce(failure);
    await expect(persistence.replace(document, "etag")).rejects.toBe(failure);
  });
});
