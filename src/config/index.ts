export interface Config {
  production: boolean;
  port: number;
  tenantId: string;
  clientId?: string;
  clientSecret?: string;
  localPlayground: boolean;
  stateStore: "cosmos" | "memory";
  providerMode: "live" | "mock";
  claudeModel: string;
  geminiModel: string;
  anthropicApiKey?: string;
  geminiApiKey?: string;
  cosmosEndpoint?: string;
  cosmosDatabase: string;
  cosmosContainer: string;
  managedIdentityClientId?: string;
  maxOutputTokens: number;
  maxInputChars: number;
  maxContextBytes: number;
  streamTimeoutMs: number;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required configuration: ${name}`);
  return value;
}

function number(
  env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number,
): number {
  const value = env[name] === undefined ? fallback : Number(env[name]);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === "production";
  const localPlayground = env.LOCAL_PLAYGROUND === "true";
  if (env.LOCAL_PLAYGROUND && !["true", "false"].includes(env.LOCAL_PLAYGROUND)) {
    throw new Error("LOCAL_PLAYGROUND must be true or false");
  }
  if (env.DANGEROUSLY_ALLOW_UNAUTHENTICATED_REQUESTS || env.SKIP_AUTH) {
    throw new Error("Use only LOCAL_PLAYGROUND for explicit local authentication bypass");
  }
  const stateStore = env.STATE_STORE ?? (production ? "cosmos" : "memory");
  const providerMode = env.PROVIDER_MODE ?? (production ? "live" : "mock");
  if (stateStore !== "cosmos" && stateStore !== "memory") {
    throw new Error("STATE_STORE must be cosmos or memory");
  }
  if (providerMode !== "live" && providerMode !== "mock") {
    throw new Error("PROVIDER_MODE must be live or mock");
  }
  if (production && (localPlayground || stateStore !== "cosmos" || providerMode !== "live")) {
    throw new Error("Production requires authenticated Teams, Cosmos state, and live providers");
  }
  if (localPlayground && providerMode !== "mock") {
    throw new Error("Unauthenticated Playground must use mock providers");
  }
  const config: Config = {
    production,
    port: number(env, "PORT", 3978, 1024, 65535),
    tenantId: localPlayground ? "local" : required(env, "TENANT_ID"),
    clientId: localPlayground ? undefined : required(env, "CLIENT_ID"),
    clientSecret: localPlayground ? undefined : required(env, "CLIENT_SECRET"),
    localPlayground,
    stateStore,
    providerMode,
    claudeModel: providerMode === "live" ? required(env, "CLAUDE_MODEL") : "mock-claude",
    geminiModel: providerMode === "live" ? required(env, "GEMINI_MODEL") : "mock-gemini",
    anthropicApiKey: providerMode === "live" ? required(env, "ANTHROPIC_API_KEY") : undefined,
    geminiApiKey: providerMode === "live" ? required(env, "GEMINI_API_KEY") : undefined,
    cosmosEndpoint: stateStore === "cosmos" ? required(env, "COSMOS_ENDPOINT") : undefined,
    cosmosDatabase: env.COSMOS_DATABASE ?? "teams-agent",
    cosmosContainer: env.COSMOS_CONTAINER ?? "conversations",
    managedIdentityClientId: env.AZURE_CLIENT_ID,
    maxOutputTokens: number(env, "MAX_OUTPUT_TOKENS", 2048, 1, 8192),
    maxInputChars: number(env, "MAX_INPUT_CHARS", 12000, 1, 24000),
    maxContextBytes: number(env, "MAX_CONTEXT_BYTES", 80000, 12000, 200000),
    streamTimeoutMs: number(env, "STREAM_TIMEOUT_MS", 90000, 1000, 100000),
  };
  if (config.maxContextBytes < config.maxInputChars) {
    throw new Error("MAX_CONTEXT_BYTES must be at least MAX_INPUT_CHARS");
  }
  if (providerMode === "live" &&
      (!/^claude-opus-[a-zA-Z0-9.-]+$/.test(config.claudeModel) ||
       !/^gemini-[a-zA-Z0-9.-]+$/.test(config.geminiModel))) {
    throw new Error("Configure a Claude Opus model ID and a Gemini model ID");
  }
  if (config.cosmosEndpoint && new URL(config.cosmosEndpoint).protocol !== "https:") {
    throw new Error("COSMOS_ENDPOINT must use HTTPS");
  }
  return config;
}
