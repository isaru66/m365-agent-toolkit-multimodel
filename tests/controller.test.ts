import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatController, trimHistory, type ChatOutput } from "../src/bot/controller.js";
import { loadConfig } from "../src/config/index.js";
import type { ChatProvider, ConversationStore, ProviderEvent, ProviderRequest, ProviderId } from "../src/core/contracts.js";
import type { AcceptedMessage } from "../src/bot/access.js";
import { StreamFailure, type ReplyStream } from "../src/bot/stream.js";

const message: AcceptedMessage = {
  key: { tenantId: "local", userId: "u", conversationId: "c" },
  activityId: "a", text: "Hello", hasAttachments: false,
};
function setup(
  events: ProviderEvent[] = [{ type: "text", text: "Hi" }, { type: "complete", status: "completed" }],
  enabledProviders: ProviderId[] = ["claude", "gemini"],
) {
  const store: ConversationStore = {
    selection: vi.fn<ConversationStore["selection"]>(async () => "claude"),
    select: vi.fn<ConversationStore["select"]>(async () => "selected"),
    reset: vi.fn(async () => undefined),
    begin: vi.fn<ConversationStore["begin"]>(async () => ({ status: "acquired", lease: { id: "lease", activityId: "a", provider: "claude", history: [] } })),
    renew: vi.fn(async () => true),
    complete: vi.fn(async () => true),
    release: vi.fn(async () => undefined),
  };
  const provider: ChatProvider = {
    id: "claude", model: "test",
    stream: vi.fn(async function* (_request: ProviderRequest) { yield* events; }),
  };
  const other: ChatProvider = {
    ...provider, id: "gemini",
    stream: vi.fn(async function* (_request: ProviderRequest) { yield* events; }),
  };
  const azure: ChatProvider = {
    ...provider, id: "azure-openai",
    stream: vi.fn(async function* (_request: ProviderRequest) { yield* events; }),
  };
  const reply: ReplyStream = {
    failure: undefined, start: vi.fn(async () => undefined), append: vi.fn(),
    finish: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined),
  };
  const output: ChatOutput = {
    send: vi.fn(async () => undefined), chooseModel: vi.fn(async () => undefined),
    stream: vi.fn(() => reply),
  };
  const controller = new ChatController(loadConfig({
    LOCAL_PLAYGROUND: "true", ENABLED_PROVIDERS: enabledProviders.join(","),
  }), store, { claude: provider, gemini: other, "azure-openai": azure });
  return { controller, store, provider, other, azure, reply, output };
}

describe("chat controller", () => {
  afterEach(() => vi.useRealTimers());
  it("only saves a completed answer after final delivery", async () => {
    const { controller, store, provider, other, reply, output } = setup();
    await controller.handle(message, output);
    expect(provider.stream).toHaveBeenCalledOnce();
    expect(other.stream).not.toHaveBeenCalled();
    expect(reply.append).toHaveBeenCalledWith("Hi");
    expect(store.complete).toHaveBeenCalledWith(message.key, "lease", "Hello", "Hi");
    expect(vi.mocked(reply.finish).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(store.complete).mock.invocationCallOrder[0]!);
    expect(store.release).toHaveBeenCalledOnce();
  });
  it.each(["busy", "duplicate", "unselected"] as const)("does not call a provider for %s", async (status) => {
    const { controller, store, provider, output } = setup();
    vi.mocked(store.begin).mockResolvedValue({ status });
    await controller.handle(message, output);
    expect(provider.stream).not.toHaveBeenCalled();
  });
  it.each(["truncated", "blocked"] as const)("keeps %s output out of context", async (status) => {
    const { controller, store, reply, other, output } = setup([
      { type: "text", text: "Partial" }, { type: "complete", status },
    ]);
    await controller.handle(message, output);
    expect(store.complete).not.toHaveBeenCalled();
    expect(reply.finish).toHaveBeenCalledWith(expect.stringContaining("incomplete"));
    expect(other.stream).not.toHaveBeenCalled();
  });
  it("never modifies a stopped bubble and sends a separate notice", async () => {
    const { controller, store, reply, output } = setup();
    vi.mocked(reply.append).mockImplementation(() => {
      Object.assign(reply, { failure: new StreamFailure("stopped") });
      throw new StreamFailure("stopped");
    });
    await controller.handle(message, output);
    expect(reply.finish).not.toHaveBeenCalled();
    expect(output.send).toHaveBeenCalledWith(expect.stringContaining("Stopped"));
    expect(store.complete).not.toHaveBeenCalled();
  });
  it("does not store when final delivery fails or a reset invalidates the lease", async () => {
    const first = setup();
    vi.mocked(first.reply.finish).mockRejectedValue(new StreamFailure("delivery"));
    await first.controller.handle(message, first.output);
    expect(first.store.complete).not.toHaveBeenCalled();
    const second = setup();
    vi.mocked(second.store.renew).mockResolvedValue(false);
    await second.controller.handle(message, second.output);
    expect(second.store.complete).not.toHaveBeenCalled();
  });
  it("passes the configured output limit and an abortable request", async () => {
    const { controller, provider, output } = setup();
    await controller.handle(message, output);
    const request = vi.mocked(provider.stream).mock.calls[0]?.[0];
    expect(request?.maxOutputTokens).toBe(2048);
    expect(request?.signal.aborted).toBe(true);
  });
  it("aborts a stalled provider within the configured deadline", async () => {
    vi.useFakeTimers();
    const { controller, provider, store, output } = setup();
    vi.mocked(provider.stream).mockImplementation(async function* (request) {
      await new Promise<void>((_resolve, reject) => request.signal.addEventListener(
        "abort", () => reject(request.signal.reason), { once: true },
      ));
      yield { type: "complete", status: "completed" };
    });
    const handling = controller.handle(message, output);
    await vi.advanceTimersByTimeAsync(90000);
    await handling;
    expect(store.complete).not.toHaveBeenCalled();
    expect(store.release).toHaveBeenCalledOnce();
  });
  it("handles controls without inference and rejects oversized/attached input", async () => {
    const { controller, provider, output, store } = setup();
    for (const text of ["help", "model", "model gemini", "model invalid", "reset", "x".repeat(12001)]) {
      await controller.handle({ ...message, text }, output);
    }
    await controller.handle({ ...message, hasAttachments: true }, output);
    expect(provider.stream).not.toHaveBeenCalled();
    expect(store.select).toHaveBeenCalledWith(message.key, "gemini");
    expect(store.reset).toHaveBeenCalledWith(message.key);
  });
  it.each(["help", "/model", "/MoDeL"])("opens the chooser for %s without changing state or inference", async (text) => {
    const { controller, provider, other, azure, output, store } = setup();
    await controller.handle({ ...message, text }, output);
    expect(output.chooseModel).toHaveBeenCalledOnce();
    expect(output.send).not.toHaveBeenCalled();
    expect(output.stream).not.toHaveBeenCalled();
    expect(store.selection).not.toHaveBeenCalled();
    expect(store.select).not.toHaveBeenCalled();
    expect(store.reset).not.toHaveBeenCalled();
    expect(store.begin).not.toHaveBeenCalled();
    for (const client of [provider, other, azure]) {
      expect(client.stream).not.toHaveBeenCalled();
    }
  });
  it("trims oldest exchanges using a conservative UTF-8 context budget", () => {
    const history = ["old", "new"].map((user) => ({ user, assistant: "answer", createdAt: 1, expiresAt: 100 }));
    expect(trimHistory(history, "prompt", 16)).toEqual([history[1]]);
    expect(trimHistory(history, "prompt", 6)).toEqual([]);
  });
  it("selects and streams Azure OpenAI without calling another provider", async () => {
    const { controller, store, provider, other, azure, output } = setup(undefined, ["azure-openai"]);
    await controller.handle({ ...message, text: "model azure-openai" }, output);
    expect(store.select).toHaveBeenCalledWith(message.key, "azure-openai");
    vi.mocked(store.selection).mockResolvedValue("azure-openai");
    vi.mocked(store.begin).mockResolvedValue({
      status: "acquired", lease: { id: "azure-lease", activityId: "a", provider: "azure-openai", history: [] },
    });
    await controller.handle(message, output);
    expect(azure.stream).toHaveBeenCalledOnce();
    expect(provider.stream).not.toHaveBeenCalled();
    expect(other.stream).not.toHaveBeenCalled();
    expect(store.complete).toHaveBeenCalledWith(message.key, "azure-lease", "Hello", "Hi");
  });
  it("rejects a disabled provider even if an extra client exists in the registry", async () => {
    const { controller, store, other, output } = setup(undefined, ["claude"]);
    await controller.handle({ ...message, text: "model gemini" }, output);
    expect(output.send).toHaveBeenCalledWith(expect.stringContaining("not enabled"));
    expect(store.select).not.toHaveBeenCalled();
    expect(other.stream).not.toHaveBeenCalled();
  });
  it.each(["model", "Hello"])("handles a stale disabled selection for %s without taking a lease", async (text) => {
    const { controller, store, azure, output } = setup();
    vi.mocked(store.selection).mockResolvedValue("azure-openai");
    await controller.handle({ ...message, text }, output);
    expect(store.begin).not.toHaveBeenCalled();
    expect(azure.stream).not.toHaveBeenCalled();
    expect(output.send).toHaveBeenCalledWith(expect.stringContaining("no longer enabled"));
    expect(output.chooseModel).toHaveBeenCalledOnce();
  });
  it("releases a lease when the selected provider changed to disabled before acquisition", async () => {
    const { controller, store, provider, azure, output } = setup();
    vi.mocked(store.begin).mockResolvedValue({
      status: "acquired", lease: { id: "stale", activityId: "a", provider: "azure-openai", history: [] },
    });
    await controller.handle(message, output);
    expect(store.release).toHaveBeenCalledWith(message.key, "stale");
    expect(provider.stream).not.toHaveBeenCalled();
    expect(azure.stream).not.toHaveBeenCalled();
    expect(output.stream).not.toHaveBeenCalled();
    expect(output.chooseModel).toHaveBeenCalledOnce();
  });
  it("fails explicitly when an enabled provider is not registered", () => {
    const { store, provider } = setup();
    expect(() => new ChatController(loadConfig({ LOCAL_PLAYGROUND: "true" }), store, { claude: provider }))
      .toThrow("gemini is not registered");
  });
});
