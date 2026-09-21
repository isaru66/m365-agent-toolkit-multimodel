import { describe, expect, it, vi } from "vitest";
import { createProviders } from "../src/bootstrap.js";
import { loadConfig } from "../src/config/index.js";
import { PROVIDER_IDS } from "../src/core/contracts.js";
import { AnthropicProvider, AzureOpenAiProvider, GeminiProvider, MockProvider } from "../src/providers/index.js";

// Registry construction is tested without starting Teams or connecting to Cosmos.
vi.mock("../src/bot/app.js", () => ({ createApp: vi.fn() }));

const liveEnv = {
  PROVIDER_MODE: "live",
  TENANT_ID: "test-tenant",
  CLIENT_ID: "test-client",
  CLIENT_SECRET: "test-placeholder",
};
const settings = {
  claude: {
    ANTHROPIC_API_KEY: "claude-test-key",
    ANTHROPIC_BASE_URL: "https://resource.services.ai.azure.com/anthropic",
    CLAUDE_MODEL: "claude-deployment",
  },
  gemini: {
    GEMINI_API_KEY: "gemini-test-key",
    GEMINI_BASE_URL: "https://generativelanguage.googleapis.com",
    GEMINI_MODEL: "gemini-deployment",
  },
  "azure-openai": {
    AZURE_OPENAI_API_KEY: "azure-test-key",
    AZURE_OPENAI_BASE_URL: "https://resource.services.ai.azure.com/openai/v1",
    AZURE_OPENAI_DEPLOYMENT: "azure-deployment",
  },
};
const classes = { claude: AnthropicProvider, gemini: GeminiProvider, "azure-openai": AzureOpenAiProvider };

describe("enabled provider bootstrap", () => {
  it.each(PROVIDER_IDS)("constructs real %s for opted-in local Playground", (id) => {
    const config = loadConfig({
      LOCAL_PLAYGROUND: "true", ALLOW_LOCAL_LIVE_PROVIDERS: "true",
      PROVIDER_MODE: "live", ENABLED_PROVIDERS: id, ...settings[id],
    });
    const providers = createProviders(config);
    expect(Object.keys(providers)).toEqual([id]);
    expect(providers[id]).toBeInstanceOf(classes[id]);
    expect(providers[id]).not.toBeInstanceOf(MockProvider);
  });

  it.each(PROVIDER_IDS)("constructs only live %s with no disabled-provider credentials", (id) => {
    const config = loadConfig({ ...liveEnv, ENABLED_PROVIDERS: id, ...settings[id] });
    const providers = createProviders(config);
    expect(Object.keys(providers)).toEqual([id]);
    expect(providers[id]).toBeInstanceOf(classes[id]);
    expect(providers[id]).not.toBeInstanceOf(MockProvider);
  });

  it("constructs all three live providers without issuing requests", () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    try {
      const providers = createProviders(loadConfig({
        ...liveEnv, ENABLED_PROVIDERS: PROVIDER_IDS.join(","),
        ...settings.claude, ...settings.gemini, ...settings["azure-openai"],
      }));
      expect(Object.keys(providers)).toEqual([...PROVIDER_IDS]);
      for (const id of PROVIDER_IDS) expect(providers[id]).toBeInstanceOf(classes[id]);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(PROVIDER_IDS)("constructs credential-free mocks only for enabled %s", (id) => {
    const config = loadConfig({ LOCAL_PLAYGROUND: "true", PROVIDER_MODE: "mock", ENABLED_PROVIDERS: id });
    const providers = createProviders(config);
    expect(Object.keys(providers)).toEqual([id]);
    expect(providers[id]).toBeInstanceOf(MockProvider);
    expect(providers[id]?.model).toBe(`mock-${id}`);
  });

  it.each([
    ["claude", "anthropicApiKey", "ANTHROPIC_API_KEY"],
    ["claude", "anthropicBaseUrl", "ANTHROPIC_BASE_URL"],
    ["claude", "claudeModel", "CLAUDE_MODEL"],
    ["gemini", "geminiApiKey", "GEMINI_API_KEY"],
    ["gemini", "geminiBaseUrl", "GEMINI_BASE_URL"],
    ["gemini", "geminiModel", "GEMINI_MODEL"],
    ["azure-openai", "azureOpenAiApiKey", "AZURE_OPENAI_API_KEY"],
    ["azure-openai", "azureOpenAiBaseUrl", "AZURE_OPENAI_BASE_URL"],
    ["azure-openai", "azureOpenAiDeployment", "AZURE_OPENAI_DEPLOYMENT"],
  ] as const)("fails explicitly for enabled %s missing %s, rather than selecting a mock", (id, property, name) => {
    const config = loadConfig({ ...liveEnv, ENABLED_PROVIDERS: id, ...settings[id] });
    config[property] = undefined;
    expect(() => createProviders(config)).toThrow(`Missing required configuration: ${name}`);
  });
});
