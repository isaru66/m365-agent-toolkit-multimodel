import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/index.js";
import { acceptMessage } from "../src/bot/access.js";
import { modelCard } from "../src/bot/models.js";
import { PROVIDER_IDS } from "../src/core/contracts.js";

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
    expect(acceptMessage({ ...activity, value: { command: "model", provider: "azure-openai" } },
      { localPlayground: false, tenantId: "tenant" })?.text).toBe("model azure-openai");
    expect(acceptMessage({ ...activity, text: "must not call a provider", value: { command: "model", provider: "unknown" } },
      { localPlayground: false, tenantId: "tenant" })?.text).toBe("model invalid");
  });
});

const liveIdentity = {
  PROVIDER_MODE: "live", CLIENT_ID: "test-client", CLIENT_SECRET: "test-only",
  TENANT_ID: "test-tenant", STATE_STORE: "memory",
};
const connections = {
  claude: {
    CLAUDE_MODEL: "team-opus-deployment",
    ANTHROPIC_API_KEY: "claude-test-only",
    ANTHROPIC_BASE_URL: "https://resource.services.ai.azure.com/anthropic/",
  },
  gemini: {
    GEMINI_MODEL: "gemini-deployment-alias",
    GEMINI_API_KEY: "gemini-test-only",
    GEMINI_BASE_URL: "https://gateway.example.com/team/gemini/",
  },
  "azure-openai": {
    AZURE_OPENAI_DEPLOYMENT: "team-gpt-deployment",
    AZURE_OPENAI_API_KEY: "azure-test-only",
    AZURE_OPENAI_BASE_URL: "https://resource.services.ai.azure.com/openai/v1/",
  },
};

describe("local live provider opt-in", () => {
  const env = {
    ...local, PROVIDER_MODE: "live", STATE_STORE: "memory",
    ENABLED_PROVIDERS: "claude,azure-openai",
    ...connections.claude, ...connections["azure-openai"],
  };

  it.each([undefined, "false"])("rejects live calls without explicit opt-in: %s", (value) => {
    expect(() => loadConfig({ ...env, ALLOW_LOCAL_LIVE_PROVIDERS: value }))
      .toThrow("Live Playground requires ALLOW_LOCAL_LIVE_PROVIDERS=true");
  });

  it.each(["", "TRUE", "1", "yes"])("rejects invalid opt-in %j", (value) => {
    expect(() => loadConfig({ ...env, ALLOW_LOCAL_LIVE_PROVIDERS: value }))
      .toThrow("ALLOW_LOCAL_LIVE_PROVIDERS must be true or false");
  });

  it("allows explicit local live calls without bot identity", () => {
    expect(loadConfig({ ...env, ALLOW_LOCAL_LIVE_PROVIDERS: "true" })).toMatchObject({
      localPlayground: true, providerMode: "live", stateStore: "memory",
      tenantId: "local", clientId: undefined, clientSecret: undefined,
      claudeModel: connections.claude.CLAUDE_MODEL,
      azureOpenAiDeployment: connections["azure-openai"].AZURE_OPENAI_DEPLOYMENT,
    });
  });

  it.each([
    { ...env, NODE_ENV: "production", STATE_STORE: "cosmos" },
    { ...liveIdentity, NODE_ENV: "production", STATE_STORE: "cosmos" },
    { ...liveIdentity },
  ])("rejects opt-in outside local nonproduction use %#", (settings) => {
    expect(() => loadConfig({ ...settings, ALLOW_LOCAL_LIVE_PROVIDERS: "true" })).toThrow();
  });

  for (const id of PROVIDER_IDS) {
    it.each(Object.keys(connections[id]))(`requires local live ${id} setting %s`, (name) => {
      const settings: NodeJS.ProcessEnv = {
        ...local, PROVIDER_MODE: "live", ALLOW_LOCAL_LIVE_PROVIDERS: "true",
        ENABLED_PROVIDERS: id, ...connections[id],
      };
      delete settings[name];
      expect(() => loadConfig(settings)).toThrow(name);
    });
  }

  it("does not change the default mock mode when opting in", () => {
    expect(loadConfig({ ...local, ALLOW_LOCAL_LIVE_PROVIDERS: "true" }).providerMode).toBe("mock");
    expect(loadConfig({ ...local, ALLOW_LOCAL_LIVE_PROVIDERS: "false" }).providerMode).toBe("mock");
  });
});

describe("enabled provider configuration", () => {
  it.each(PROVIDER_IDS)("allows %s alone without other provider credentials", (id) => {
    const config = loadConfig({ ...liveIdentity, ENABLED_PROVIDERS: id, ...connections[id] });
    expect(config.enabledProviders).toEqual([id]);
    const keys = {
      claude: config.anthropicApiKey, gemini: config.geminiApiKey, "azure-openai": config.azureOpenAiApiKey,
    };
    for (const other of PROVIDER_IDS.filter((value) => value !== id)) expect(keys[other]).toBeUndefined();
  });

  it("supports all three with deployment aliases and normalized prefixed URLs", () => {
    const config = loadConfig({
      ...liveIdentity, ENABLED_PROVIDERS: PROVIDER_IDS.join(","),
      ...connections.claude, ...connections.gemini, ...connections["azure-openai"],
    });
    expect(config).toMatchObject({
      enabledProviders: [...PROVIDER_IDS],
      claudeModel: "team-opus-deployment",
      anthropicBaseUrl: "https://resource.services.ai.azure.com/anthropic",
      geminiBaseUrl: "https://gateway.example.com/team/gemini",
      azureOpenAiBaseUrl: "https://resource.services.ai.azure.com/openai/v1",
      azureOpenAiDeployment: "team-gpt-deployment",
    });
  });

  it("keeps mock mode credential-free and the historical default provider set", () => {
    expect(loadConfig(local).enabledProviders).toEqual(["claude", "gemini"]);
    expect(loadConfig({ ...local, ENABLED_PROVIDERS: "azure-openai" })).toMatchObject({
      enabledProviders: ["azure-openai"], azureOpenAiDeployment: "mock-azure-openai",
      azureOpenAiApiKey: undefined, azureOpenAiBaseUrl: undefined, claudeModel: undefined,
    });
  });

  it.each(["", " ", ",", "claude,", "claude,claude", "CLAUDE", "openai", "claude,unknown"])(
    "rejects invalid provider lists %j", (value) => {
      expect(() => loadConfig({ ...local, ENABLED_PROVIDERS: value })).toThrow("ENABLED_PROVIDERS");
    });

  for (const id of PROVIDER_IDS) {
    it.each(Object.keys(connections[id]))(`requires each configured ${id} setting: %s`, (name) => {
      const env: NodeJS.ProcessEnv = { ...liveIdentity, ENABLED_PROVIDERS: id, ...connections[id] };
      delete env[name];
      expect(() => loadConfig(env)).toThrow(name);
      env[name] = " ";
      expect(() => loadConfig(env)).toThrow(name);
    });
  }

  it.each([
    "http://resource.example/anthropic", "not-a-url", "https:resource.example", "https:/resource.example",
    "https://user:private-value@resource.example/anthropic",
    "https://resource.example/anthropic?key=private-value",
    "https://resource.example/anthropic#private-value",
    "https://resource.example/anthropic?", "https://resource.example/anthropic#",
    "https://resource.example/api/projects/proj-default",
    "https://resource.example/anthropic/v1", "https://resource.example/anthropic/v1/messages",
    "https://resource.example/anthropic/v1/models",
  ])("rejects invalid Anthropic endpoint without exposing its value: %#", (endpoint) => {
    const env = { ...liveIdentity, ...connections.claude, ENABLED_PROVIDERS: "claude", ANTHROPIC_BASE_URL: endpoint };
    expect(() => loadConfig(env)).toThrow("ANTHROPIC_BASE_URL");
    try {
      loadConfig(env);
    } catch (error) {
      expect(String(error)).not.toContain("private-value");
    }
  });

  it.each([
    ["gemini", "GEMINI_BASE_URL", "https://resource.example/v1beta"],
    ["azure-openai", "AZURE_OPENAI_BASE_URL", "https://resource.example/openai/v1/chat/completions"],
    ["azure-openai", "AZURE_OPENAI_BASE_URL", "https://resource.example/api/projects/proj-default"],
  ] as const)("rejects client-added routes and project endpoints for %s: %#", (id, name, value) => {
    expect(() => loadConfig({
      ...liveIdentity, ENABLED_PROVIDERS: id, ...connections[id], [name]: value,
    })).toThrow(name);
  });

  it.each(["models/claude", "../model", "model?key=private", "model\nname"])(
    "rejects identifiers containing URL/control delimiters %#", (value) => {
      expect(() => loadConfig({
        ...liveIdentity, ...connections.claude, ENABLED_PROVIDERS: "claude", CLAUDE_MODEL: value,
      })).toThrow("CLAUDE_MODEL");
    });

  it("shows only enabled providers and commands in model cards", () => {
    const card = modelCard(["azure-openai"]);
    expect(card.actions).toEqual([
      { type: "Action.Submit", title: "Azure OpenAI", data: { command: "model", provider: "azure-openai" } },
    ]);
    expect(JSON.stringify(card)).not.toContain("model claude");
    expect(JSON.stringify(card)).not.toContain("model gemini");
    expect(modelCard(PROVIDER_IDS).actions.map((action) => action.data.provider)).toEqual([...PROVIDER_IDS]);
  });
});
