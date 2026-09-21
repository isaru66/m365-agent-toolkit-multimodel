import http from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/bot/app.js";
import { loadConfig } from "../src/config/index.js";
import { MemoryConversationStore } from "../src/state/index.js";
import { PROVIDER_IDS, type ChatProvider, type ProviderId } from "../src/core/contracts.js";
import { modelCard } from "../src/bot/models.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});

const port = (server: http.Server) => (server.address() as AddressInfo).port;
const activity = (serviceUrl: string, text: string, id: string) => ({
  type: "message", id, text, serviceUrl, channelId: "emulator",
  from: { id: "local-user", name: "Tester" },
  recipient: { id: "local-bot", name: "Agent" },
  conversation: { id: "local-chat", conversationType: "personal" },
});
async function startSink() {
  const received: unknown[] = [];
  const sink = http.createServer((request, response) => {
    let data = "";
    request.on("data", (chunk: Buffer) => { data += chunk.toString(); });
    request.on("end", () => {
      received.push(JSON.parse(data));
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: `reply-${received.length}` }));
    });
  });
  await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => sink.close(() => resolve())));
  return { sink, received };
}
function provider(id: ProviderId): ChatProvider {
  return {
    id, model: `mock-${id}`,
    stream: vi.fn(async function* () {
      yield { type: "text", text: "Hello " } as const;
      await delay(2200);
      yield { type: "text", text: "from a mock model." } as const;
      yield { type: "complete", status: "completed" } as const;
    }),
  };
}

describe("real SDK HTTP integration", () => {
  it("returns the same enabled-model selector for help and /model", async () => {
    const { sink, received } = await startSink();
    const config = loadConfig({ LOCAL_PLAYGROUND: "true", ENABLED_PROVIDERS: "azure-openai" });
    const store = new MemoryConversationStore();
    const key = { tenantId: "local", userId: "local-user", conversationId: "local-chat" };
    await store.select(key, "azure-openai");
    const providers = { "azure-openai": provider("azure-openai") };
    const runtime = createApp({ ...config, port: 0 }, store, providers);
    await runtime.start();
    cleanups.push(() => runtime.stop());
    for (const text of ["help", " /MoDeL "]) {
      const response = await fetch(`http://127.0.0.1:${port(runtime.server)}/api/messages`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...activity(`http://127.0.0.1:${port(sink)}`, text, text.trim()),
          channelId: "msteams",
        }),
      });
      expect(response.status).toBe(200);
      await vi.waitFor(() => expect(runtime.tasks.size).toBe(0));
    }
    expect(received).toHaveLength(2);
    for (const reply of received) {
      expect(reply).toMatchObject({
        type: "message",
        attachments: [{
          contentType: "application/vnd.microsoft.card.adaptive",
          content: modelCard(["azure-openai"]),
        }],
      });
    }
    expect(await store.selection(key)).toBe("azure-openai");
    expect(providers["azure-openai"].stream).not.toHaveBeenCalled();
  });

  it("keeps live Playground bound to loopback and rejects remote callbacks before inference", async () => {
    const config = loadConfig({
      LOCAL_PLAYGROUND: "true", ALLOW_LOCAL_LIVE_PROVIDERS: "true",
      PROVIDER_MODE: "live", ENABLED_PROVIDERS: "claude",
      ANTHROPIC_BASE_URL: "https://resource.services.ai.azure.com/anthropic",
      ANTHROPIC_API_KEY: "test-only", CLAUDE_MODEL: "test-deployment",
    });
    const providers = { claude: provider("claude") };
    const runtime = createApp({ ...config, port: 0 }, new MemoryConversationStore(), providers);
    await runtime.start();
    cleanups.push(() => runtime.stop());
    expect((runtime.server.address() as AddressInfo).address).toBe("127.0.0.1");
    const response = await fetch(`http://127.0.0.1:${port(runtime.server)}/api/messages`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...activity("https://example.com", "Hello", "remote-callback"), channelId: "msteams",
      }),
    });
    expect(response.status).toBe(403);
    expect(providers.claude.stream).not.toHaveBeenCalled();
    expect(runtime.tasks.size).toBe(0);
  });

  it("authenticates before dispatch and refuses missing or invalid service tokens", async () => {
    const config = loadConfig({
      NODE_ENV: "test", CLIENT_ID: "11111111-1111-4111-8111-111111111111",
      CLIENT_SECRET: "test-only-not-a-real-credential", TENANT_ID: "22222222-2222-4222-8222-222222222222",
    });
    const providers = { claude: provider("claude"), gemini: provider("gemini") };
    const runtime = createApp({ ...config, port: 0 }, new MemoryConversationStore(), providers);
    await runtime.start();
    cleanups.push(() => runtime.stop());
    const url = `http://127.0.0.1:${port(runtime.server)}/api/messages`;
    for (const token of ["", "Bearer invalid"]) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { authorization: token } : {}) },
        body: JSON.stringify(activity("https://example.com", "Hello", "1")),
      });
      expect(response.status).toBe(401);
    }
    expect(providers.claude.stream).not.toHaveBeenCalled();
    expect(runtime.tasks.size).toBe(0);
  });

  it.each([
    { id: "claude", channelId: "emulator" },
    { id: "azure-openai", channelId: "emulator" },
    { id: "claude", channelId: "msteams" },
    { id: "azure-openai", channelId: "msteams" },
  ] as const)("acknowledges promptly, streams $id over $channelId, and persists only final answers", async ({ id, channelId }) => {
    const { sink, received } = await startSink();
    const config = loadConfig({ LOCAL_PLAYGROUND: "true", ENABLED_PROVIDERS: PROVIDER_IDS.join(",") });
    const store = new MemoryConversationStore();
    const providers = { claude: provider("claude"), gemini: provider("gemini"), "azure-openai": provider("azure-openai") };
    const runtime = createApp({ ...config, port: 0 }, store, providers);
    await runtime.start();
    cleanups.push(() => runtime.stop());
    const url = `http://127.0.0.1:${port(runtime.server)}/api/messages`;
    const serviceUrl = `http://127.0.0.1:${port(sink)}`;
    const send = (text: string, id: string) => fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...activity(serviceUrl, text, id), channelId }),
    });
    expect((await send(`model ${id}`, "select")).status).toBe(200);
    while (runtime.tasks.size) await delay(20);
    expect(received).toHaveLength(1);
    const started = Date.now();
    expect((await send("Hello", "question")).status).toBe(200);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(runtime.tasks.size).toBe(1);
    const limit = Date.now() + 10000;
    while (runtime.tasks.size && Date.now() < limit) await delay(50);
    expect(runtime.tasks.size).toBe(0);
    expect(received).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "typing", text: "Hello " }),
      expect.objectContaining({ type: "message", text: "Hello from a mock model." }),
    ]));
    for (const other of PROVIDER_IDS.filter((value) => value !== id)) {
      expect(providers[other].stream).not.toHaveBeenCalled();
    }
    const next = await store.begin({ tenantId: "local", userId: "local-user", conversationId: "local-chat" }, "next");
    expect(next.status).toBe("acquired");
    if (next.status === "acquired") expect(next.lease.history[0]?.assistant).toBe("Hello from a mock model.");
  }, 20000);
});
