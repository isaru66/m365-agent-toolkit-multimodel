import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/bot/app.js";
import { loadConfig } from "../src/config/index.js";
import { MemoryConversationStore } from "../src/state/index.js";
import type { ChatProvider } from "../src/core/contracts.js";

describe("public pilot information pages", () => {
  const stream = vi.fn<ChatProvider["stream"]>();
  const config = loadConfig({
    NODE_ENV: "test",
    CLIENT_ID: "11111111-1111-4111-8111-111111111111",
    CLIENT_SECRET: "test-only-not-a-real-credential",
    TENANT_ID: "22222222-2222-4222-8222-222222222222",
  });
  const store = new MemoryConversationStore();
  const begin = vi.spyOn(store, "begin");
  const runtime = createApp({ ...config, port: 0 }, store, {
    claude: { id: "claude", model: "mock-claude", stream },
    gemini: { id: "gemini", model: "mock-gemini", stream },
  });
  let base: string;

  beforeAll(async () => {
    await runtime.start();
    base = `http://127.0.0.1:${(runtime.server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await runtime.stop(); });

  it.each([
    ["/", "Multi-model Agent"],
    ["/privacy", "Privacy notice"],
    ["/terms", "Pilot terms of use"],
  ])("serves %s without auth, state access, scripts, or reflected input", async (path, title) => {
    const response = await fetch(`${base}${path}?text=untrusted-query-sentinel`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/html; charset=utf-8$/i);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await response.text();
    expect(html).toContain(`<h1>${title}</h1>`);
    expect(html).toContain(`<a href="${path}" aria-current="page">`);
    expect(html).toContain('lang="en"');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('href="#content"');
    expect(html).toContain('id="content"');
    expect(html).toContain("isaru66");
    expect(html).not.toMatch(/<script|<form|<iframe|https?:\/\/|untrusted-query-sentinel/);
    expect(html).not.toContain(config.clientSecret);
    expect(html).not.toContain(config.tenantId);
    const css = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1];
    expect(css).toBeDefined();
    const hash = createHash("sha256").update(css!).digest("base64");
    const csp = response.headers.get("content-security-policy");
    expect(csp).toContain(`style-src 'sha256-${hash}'`);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(css).toContain("prefers-color-scheme: dark");
    expect(stream).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
    expect(runtime.tasks.size).toBe(0);
  });

  it("explains retention and reset without promising upstream deletion", async () => {
    const html = await (await fetch(`${base}/privacy`)).text();
    expect(html).toContain("20 completed exchanges");
    expect(html).toContain("24 hours after completion");
    expect(html).toContain("physical cleanup is eventual");
    expect(html).toContain("Reset and expiry do not delete");
    expect(html).toContain("does not promise zero retention");
  });

  it("preserves probes, unknown-route rejection, and authenticated activity handling", async () => {
    for (const path of ["/healthz", "/readyz"]) {
      expect((await fetch(base + path)).status).toBe(200);
    }
    expect((await fetch(`${base}/unknown-page`)).status).toBe(404);
    expect((await fetch(`${base}/privacy`, { method: "POST" })).status).toBe(404);
    for (const authorization of [undefined, "Bearer invalid-test-token"]) {
      const response = await fetch(`${base}/api/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authorization ? { authorization } : {}),
        },
        body: JSON.stringify({ type: "message", text: "Do not run inference." }),
      });
      expect(response.status).toBe(401);
    }
    expect(stream).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
    expect(runtime.tasks.size).toBe(0);
  });
});

it("describes enabled providers and reset accurately in the Teams package", () => {
  const manifest = JSON.parse(readFileSync(new URL("../appPackage/manifest.json", import.meta.url), "utf8"));
  expect(manifest.name.full).toBe("Multi-model Teams Agent");
  expect(manifest.bots[0].scopes).toEqual(["personal"]);
  expect(manifest.bots[0].commandLists[0].commands).toEqual(expect.arrayContaining([
    expect.objectContaining({ title: "model", description: expect.stringContaining("Azure OpenAI") }),
    expect.objectContaining({ title: "reset", description: expect.stringContaining("all providers") }),
  ]));
  expect(JSON.stringify(manifest)).not.toMatch(/Claude Opus|both models/);
});
