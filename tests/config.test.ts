import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/index.js";
import { acceptMessage } from "../src/bot/access.js";

const local = { LOCAL_PLAYGROUND: "true" };

describe("configuration and scope gates", () => {
  it("requires credentials unless the local mock playground is explicit", () => {
    expect(() => loadConfig({})).toThrow("TENANT_ID");
    expect(loadConfig(local)).toMatchObject({ localPlayground: true, providerMode: "mock", maxOutputTokens: 2048 });
  });
  it.each([
    { NODE_ENV: "production", LOCAL_PLAYGROUND: "true" },
    { LOCAL_PLAYGROUND: "true", PROVIDER_MODE: "live" },
    { LOCAL_PLAYGROUND: "true", STREAM_TIMEOUT_MS: "120000" },
    { LOCAL_PLAYGROUND: "true", MAX_OUTPUT_TOKENS: "NaN" },
    { LOCAL_PLAYGROUND: "true", DANGEROUSLY_ALLOW_UNAUTHENTICATED_REQUESTS: "true" },
    { LOCAL_PLAYGROUND: "true", PROVIDER_MODE: "typo" },
  ])("rejects insecure/invalid configuration %#", (env) => {
    expect(() => loadConfig(env)).toThrow();
  });
  const activity = {
    type: "message", id: "1", text: "hello", channelId: "msteams",
    conversation: { id: "chat", conversationType: "personal", tenantId: "tenant" },
    channelData: { tenant: { id: "tenant" } }, from: { id: "user", aadObjectId: "aad-user" },
    serviceUrl: "https://smba.trafficmanager.net/teams",
  };
  it("isolates tenant, user, and personal conversation", () => {
    expect(acceptMessage(activity, { localPlayground: false, tenantId: "tenant" })?.key)
      .toEqual({ tenantId: "tenant", userId: "aad-user", conversationId: "chat" });
    expect(acceptMessage(activity, { localPlayground: false, tenantId: "other" })).toBeUndefined();
    expect(acceptMessage({ ...activity, conversation: { ...activity.conversation, conversationType: "channel" } },
      { localPlayground: false, tenantId: "tenant" })).toBeUndefined();
    expect(acceptMessage({ ...activity, from: { id: "no-aad" } },
      { localPlayground: false, tenantId: "tenant" })).toBeUndefined();
  });
  it("accepts only known model card actions and loopback local callbacks", () => {
    expect(acceptMessage({ ...activity, value: { command: "model", provider: "gemini" } },
      { localPlayground: false, tenantId: "tenant" })?.text).toBe("model gemini");
    expect(acceptMessage(activity, { localPlayground: true, tenantId: "local" })).toBeUndefined();
    expect(acceptMessage({ ...activity, serviceUrl: "http://127.0.0.1:56150" },
      { localPlayground: true, tenantId: "local" })).toBeDefined();
  });
});
