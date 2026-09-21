import { CosmosClient } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";
import type { Config } from "./config/index.js";
import type { ConversationStore, ProviderRegistry } from "./core/contracts.js";
import { createApp } from "./bot/app.js";
import { AnthropicProvider, AzureOpenAiProvider, GeminiProvider, MockProvider } from "./providers/index.js";
import { CosmosConversationStore, MemoryConversationStore } from "./state/index.js";

export async function bootstrap(config: Config) {
  const providers = createProviders(config);
  let store: ConversationStore;
  if (config.stateStore === "cosmos") {
    if (!config.cosmosEndpoint) throw new Error("COSMOS_ENDPOINT is required");
    const cosmos = new CosmosClient({
      endpoint: config.cosmosEndpoint,
      aadCredentials: new DefaultAzureCredential({
        managedIdentityClientId: config.managedIdentityClientId,
      }),
    });
    const container = cosmos.database(config.cosmosDatabase).container(config.cosmosContainer);
    const { resource } = await container.read();
    if (resource?.partitionKey?.paths[0] !== "/id" || resource.defaultTtl !== 86400) {
      throw new Error("Cosmos container must use /id partition key and 86400-second TTL");
    }
    store = new CosmosConversationStore({ container });
  } else {
    store = new MemoryConversationStore();
  }
  return createApp(config, store, providers);
}

/** Construct exactly the enabled providers; missing live settings never select mocks. */
export function createProviders(config: Config): ProviderRegistry {
  const providers: ProviderRegistry = {};
  const required = (value: string | undefined, name: string): string => {
    if (!value?.trim()) throw new Error(`Missing required configuration: ${name}`);
    return value;
  };
  for (const id of config.enabledProviders) {
    if (config.providerMode === "mock") {
      providers[id] = new MockProvider({ id });
      continue;
    }
    if (config.providerMode !== "live") throw new Error("Invalid provider mode");
    switch (id) {
      case "claude":
        providers[id] = new AnthropicProvider({
          apiKey: required(config.anthropicApiKey, "ANTHROPIC_API_KEY"),
          model: required(config.claudeModel, "CLAUDE_MODEL"),
          baseUrl: required(config.anthropicBaseUrl, "ANTHROPIC_BASE_URL"),
        });
        break;
      case "gemini":
        providers[id] = new GeminiProvider({
          apiKey: required(config.geminiApiKey, "GEMINI_API_KEY"),
          model: required(config.geminiModel, "GEMINI_MODEL"),
          baseUrl: required(config.geminiBaseUrl, "GEMINI_BASE_URL"),
        });
        break;
      case "azure-openai":
        providers[id] = new AzureOpenAiProvider({
          apiKey: required(config.azureOpenAiApiKey, "AZURE_OPENAI_API_KEY"),
          model: required(config.azureOpenAiDeployment, "AZURE_OPENAI_DEPLOYMENT"),
          baseUrl: required(config.azureOpenAiBaseUrl, "AZURE_OPENAI_BASE_URL"),
        });
        break;
      default:
        throw new Error("Unknown enabled provider");
    }
  }
  return providers;
}
