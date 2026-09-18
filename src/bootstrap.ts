import { CosmosClient } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";
import type { Config } from "./config/index.js";
import type { ChatProvider, ConversationStore, ProviderId } from "./core/contracts.js";
import { createApp } from "./bot/app.js";
import { AnthropicProvider, GeminiProvider, MockProvider } from "./providers/index.js";
import { CosmosConversationStore, MemoryConversationStore } from "./state/index.js";

export async function bootstrap(config: Config) {
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
  let providers: Record<ProviderId, ChatProvider>;
  if (config.providerMode === "live") {
    if (!config.anthropicApiKey || !config.geminiApiKey) throw new Error("Provider API keys are required");
    providers = {
      claude: new AnthropicProvider({ apiKey: config.anthropicApiKey, model: config.claudeModel }),
      gemini: new GeminiProvider({ apiKey: config.geminiApiKey, model: config.geminiModel }),
    };
  } else {
    providers = {
      claude: new MockProvider({ id: "claude" }),
      gemini: new MockProvider({ id: "gemini" }),
    };
  }
  return createApp(config, store, providers);
}
