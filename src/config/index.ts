import { isProviderId, type ProviderId } from "../core/contracts.js";
import { providerBaseUrl } from "./endpoints.js";

export interface Config {
  production: boolean;
  port: number;
  tenantId: string;
  clientId?: string;
  clientSecret?: string;
  localPlayground: boolean;
  stateStore: "cosmos" | "memory";
  providerMode: "live" | "mock";
  enabledProviders: ProviderId[];
  claudeModel?: string;
  geminiModel?: string;
  azureOpenAiDeployment?: string;
  anthropicBaseUrl?: string;
  geminiBaseUrl?: string;
  azureOpenAiBaseUrl?: string;
  anthropicApiKey?: string;
  geminiApiKey?: string;
  azureOpenAiApiKey?: string;
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
  const allowLocalLive = env.ALLOW_LOCAL_LIVE_PROVIDERS === "true";
  if (env.ALLOW_LOCAL_LIVE_PROVIDERS !== undefined &&
      !["true", "false"].includes(env.ALLOW_LOCAL_LIVE_PROVIDERS)) {
    throw new Error("ALLOW_LOCAL_LIVE_PROVIDERS must be true or false");
  }
  if (allowLocalLive && (production || !localPlayground)) {
    throw new Error("ALLOW_LOCAL_LIVE_PROVIDERS is only for local Playground");
  }
  if (localPlayground && providerMode === "live" && !allowLocalLive) {
    throw new Error("Live Playground requires ALLOW_LOCAL_LIVE_PROVIDERS=true");
  }
  const enabledProviders = (env.ENABLED_PROVIDERS ?? "claude,gemini").split(",").map((id) => id.trim());
  if (!enabledProviders.every(isProviderId) ||
      new Set(enabledProviders).size !== enabledProviders.length) {
    throw new Error("ENABLED_PROVIDERS must be a nonempty, unique list of claude, gemini, azure-openai");
  }
  const live = (provider: ProviderId) => providerMode === "live" && enabledProviders.includes(provider);
  const model = (provider: ProviderId, name: string): string | undefined => {
    if (!enabledProviders.includes(provider)) return undefined;
    if (providerMode === "mock") return `mock-${provider}`;
    const value = required(env, name);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(value)) {
      throw new Error(`${name} must be a model or deployment identifier without URL delimiters`);
    }
    return value;
  };
  const config: Config = {
    production,
    port: number(env, "PORT", 3978, 1024, 65535),
    tenantId: localPlayground ? "local" : required(env, "TENANT_ID"),
    clientId: localPlayground ? undefined : required(env, "CLIENT_ID"),
    clientSecret: localPlayground ? undefined : required(env, "CLIENT_SECRET"),
    localPlayground,
    stateStore,
    providerMode,
    enabledProviders,
    claudeModel: model("claude", "CLAUDE_MODEL"),
    geminiModel: model("gemini", "GEMINI_MODEL"),
    azureOpenAiDeployment: model("azure-openai", "AZURE_OPENAI_DEPLOYMENT"),
    anthropicBaseUrl: live("claude") ? providerBaseUrl(required(env, "ANTHROPIC_BASE_URL"), "ANTHROPIC_BASE_URL") : undefined,
    geminiBaseUrl: live("gemini") ? providerBaseUrl(required(env, "GEMINI_BASE_URL"), "GEMINI_BASE_URL") : undefined,
    azureOpenAiBaseUrl: live("azure-openai") ? providerBaseUrl(required(env, "AZURE_OPENAI_BASE_URL"), "AZURE_OPENAI_BASE_URL") : undefined,
    anthropicApiKey: live("claude") ? required(env, "ANTHROPIC_API_KEY") : undefined,
    geminiApiKey: live("gemini") ? required(env, "GEMINI_API_KEY") : undefined,
    azureOpenAiApiKey: live("azure-openai") ? required(env, "AZURE_OPENAI_API_KEY") : undefined,
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
  if (config.cosmosEndpoint && new URL(config.cosmosEndpoint).protocol !== "https:") {
    throw new Error("COSMOS_ENDPOINT must use HTTPS");
  }
  return config;
}
