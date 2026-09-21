import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/index.js";

// Synthetic values only: never read .env, resolve real keys, or send requests.
const dummy: Record<string, string> = {
  ANTHROPIC_BASE_URL: "https://claude.example.test/team/anthropic",
  GEMINI_BASE_URL: "https://gemini.example.test/team",
  GEMINI_API_KEY: "dummy-gemini",
  VERTEX_AI_BASE_URL: "https://vertex.example.test/team",
  GOOGLE_CLOUD_PROJECT: "offline-project",
  GOOGLE_CLOUD_LOCATION: "global",
  AZURE_OPENAI_BASE_URL: "https://azure.example.test/team/openai/v1",
  ANTHROPIC_API_KEY: "dummy-claude",
  GOOGLE_ACCESS_TOKEN: "dummy-google-access-token",
  AZURE_OPENAI_API_KEY: "dummy-azure",
  CLAUDE_MODEL: "my-azure-claude-alias",
  GEMINI_MODEL: "gemini-offline-test",
  AZURE_OPENAI_DEPLOYMENT: "my-chat-deployment",
};
const profiles = [
  { file: "anthropic.http", base: "ANTHROPIC_BASE_URL", key: "ANTHROPIC_API_KEY", header: "x-api-key", authPrefix: "",
    routes: ["/v1/models?limit=100", "/v1/messages", "/v1/messages"] },
  { file: "gemini.http", base: "GEMINI_BASE_URL", key: "GEMINI_API_KEY", header: "x-goog-api-key", authPrefix: "",
    routes: [
      "/v1beta/models",
      "/v1beta/models/gemini-offline-test:generateContent",
      "/v1beta/models/gemini-offline-test:streamGenerateContent?alt=sse",
    ] },
  { file: "gemini-vertex.http", base: "VERTEX_AI_BASE_URL", key: "GOOGLE_ACCESS_TOKEN", header: "Authorization", authPrefix: "Bearer ",
    routes: [
      "/v1/projects/offline-project/locations/global/publishers/google/models/gemini-offline-test:generateContent",
      "/v1/projects/offline-project/locations/global/publishers/google/models/gemini-offline-test:streamGenerateContent?alt=sse",
      "/v1/projects/offline-project/locations/global/publishers/google/models/gemini-offline-test:streamGenerateContent?alt=sse",
    ] },
  { file: "azure-openai.http", base: "AZURE_OPENAI_BASE_URL", key: "AZURE_OPENAI_API_KEY", header: "api-key", authPrefix: "",
    routes: ["/chat/completions", "/chat/completions"] },
];

function requestBlocks(file: string): string[] {
  return readFileSync(new URL(`./http/${file}`, import.meta.url), "utf8")
    .replace(/\r\n/g, "\n").split(/^###.*$/m).map((block) => block.trim()).filter(Boolean);
}

function substitute(block: string): string {
  return block.replace(/\{\{\$dotenv ([A-Z_]+)\}\}/g, (_match, name: string) => {
    const value = dummy[name];
    if (value === undefined) throw new Error(`Unexpected fixture variable: ${name}`);
    return value;
  });
}

describe.each(profiles)("manual requests in $file", ({ file, base, key, header, authPrefix, routes }) => {
  it("uses configured full paths, shared dotenv references, and only its native credentials", () => {
    const blocks = requestBlocks(file);
    expect(blocks).toHaveLength(routes.length);
    const names = blocks.map((raw, index) => {
      const name = raw.match(/^# @name ([a-zA-Z0-9]+)$/m)?.[1];
      expect(name).toBeDefined();
      expect(raw).toContain(`{{$dotenv ${base}}}`);
      expect(raw).toContain(`${header}: ${authPrefix}{{$dotenv ${key}}}`);
      const block = substitute(raw);
      expect(block).not.toContain("{{");
      const request = block.split("\n").find((line) => /^(GET|POST) /.test(line));
      if (!request) throw new Error(`Missing request line in ${file}`);
      const url = new URL(request.replace(/^(GET|POST) /, ""));
      expect(url.href).toBe(`${dummy[base]}${routes[index]}`);
      expect(url.protocol).toBe("https:");
      expect(url.username).toBe("");
      expect(url.password).toBe("");
      expect(url.searchParams.has("key")).toBe(false);
      const authHeaders = block.match(/^(?:authorization|api-key|x-api-key|x-goog-api-key):.*$/gim);
      expect(authHeaders).toEqual([`${header}: ${authPrefix}${dummy[key]}`]);
      expect(url.href).not.toContain(dummy[key]);
      if (file.startsWith("gemini")) expect(block).toContain("# @no-redirect");
      if (file === "gemini.http") {
        expect(block).not.toContain("Authorization:");
        expect(block).not.toContain("/projects/");
        expect(block).toContain("/v1beta/models");
      }
      if (file === "gemini-vertex.http") {
        expect(block).toContain("# @no-redirect");
        expect(block).not.toContain("x-goog-api-key");
        expect(block).not.toContain("/v1beta/");
      }
      for (const other of profiles.filter((profile) => profile.key !== key)) {
        expect(block).not.toContain(dummy[other.key]);
      }
      if (file === "anthropic.http") expect(block).toContain("anthropic-version: 2023-06-01");
      else expect(block).not.toContain("anthropic-version");
      return name;
    });
    expect(new Set(names).size).toBe(blocks.length);
  });

  it("has bounded, stateless JSON generation and SSE cases without key material in bodies", () => {
    const blocks = requestBlocks(file).filter((block) => /^POST /m.test(block));
    expect(blocks).toHaveLength(file === "gemini-vertex.http" ? 3 : 2);
    for (const [index, raw] of blocks.entries()) {
      const block = substitute(raw);
      const separator = block.indexOf("\n\n");
      if (separator < 0) throw new Error(`Missing JSON body in ${file}`);
      const json = block.slice(separator + 2);
      const body: unknown = JSON.parse(json);
      expect(block).toContain("Content-Type: application/json");
      for (const profile of profiles) expect(json).not.toContain(dummy[profile.key]);
      expect(body).not.toHaveProperty("previous_response_id");
      expect(body).not.toHaveProperty("previous_interaction_id");
      if (file === "anthropic.http") {
        expect(body).toEqual({
          model: dummy.CLAUDE_MODEL, max_tokens: 256, stream: index === 1,
          messages: [{ role: "user", content: expect.any(String) }],
        });
      } else if (file.startsWith("gemini")) {
        expect(body).toEqual({
          contents: [{ role: "user", parts: [
            ...(index === 2 ? [{
              fileData: { mimeType: "image/jpeg", fileUri: "gs://generativeai-downloads/images/scones.jpg" },
            }] : []),
            { text: index === 2 ? "Describe this picture." : expect.any(String) },
          ] }],
          generationConfig: { maxOutputTokens: 2048 },
        });
      } else {
        expect(body).toEqual({
          model: dummy.AZURE_OPENAI_DEPLOYMENT, max_completion_tokens: 2048,
          stream: index === 1, store: false,
          ...(index === 1 ? { stream_options: { include_usage: true } } : {}),
          messages: [{ role: "user", content: expect.any(String) }],
        });
      }
      expect(block).toContain(index >= 1 ? "Accept: text/event-stream" : "Accept: application/json");
    }
  });
});

it("declares every HTTP dotenv reference in the single root template with empty credentials", () => {
  const template = parseEnv(readFileSync(new URL("../.env.example", import.meta.url), "utf8"));
  const exampleModels: Record<string, string> = {
    CLAUDE_MODEL: "claude-sonnet-5",
    GEMINI_MODEL: "gemini-3.8-flash",
    AZURE_OPENAI_DEPLOYMENT: "gpt-5.6-luna",
  };
  const references = new Set(profiles.flatMap(({ file }) => requestBlocks(file).flatMap((block) =>
    [...block.matchAll(/\{\{\$dotenv ([A-Z_]+)\}\}/g)].map((match) => match[1]))));
  expect([...references].sort()).toEqual(Object.keys(dummy).sort());
  for (const name of references) {
    if (!name) throw new Error("Missing dotenv variable name");
    expect(template).toHaveProperty(name);
    if (name === "GOOGLE_CLOUD_LOCATION") expect(template[name]).toBe("global");
    else if (name in exampleModels) expect(template[name]).toBe(exampleModels[name]);
    else if (!name.endsWith("_BASE_URL")) expect(template[name]).toBe("");
  }
  for (const name of ["CLIENT_ID", "CLIENT_SECRET", "TENANT_ID"]) {
    expect(template[name]).toBe("");
  }
  expect(template.ALLOW_LOCAL_LIVE_PROVIDERS).toBe("false");
  expect(existsSync(new URL("./http/.env.example", import.meta.url))).toBe(false);
  expect(loadConfig(template)).toMatchObject({
    localPlayground: true, providerMode: "mock", stateStore: "memory",
    enabledProviders: ["claude", "gemini", "azure-openai"],
    anthropicApiKey: undefined, geminiApiKey: undefined, azureOpenAiApiKey: undefined,
  });
});

it("loads root dotenv explicitly for local startup and keeps it out of container builds", () => {
  const packageJson: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  expect(packageJson).toMatchObject({ scripts: { dev: "tsx watch --import ./scripts/load-local-env.mjs src/index.ts" } });
  const launch: unknown = JSON.parse(readFileSync(new URL("../.vscode/launch.json", import.meta.url), "utf8"));
  expect(launch).toMatchObject({
    configurations: expect.arrayContaining([expect.objectContaining({
      cwd: "${workspaceFolder}",
      runtimeArgs: expect.arrayContaining(["--import", "./scripts/load-local-env.mjs"]),
    })]),
  });
  const ignore = readFileSync(new URL("../.dockerignore", import.meta.url), "utf8");
  expect(ignore.split(/\r?\n/)).toEqual(expect.arrayContaining(["tests", ".env", ".env.*"]));
});

describe("manual ACA checks", () => {
  it("covers liveness, readiness, and both authentication rejection cases without credentials", () => {
    const [variables, ...blocks] = requestBlocks("aca.http");
    const base = variables?.match(/^@acaBaseUrl = (https:\/\/[a-z0-9.-]+)$/)?.[1];
    expect(base).toBeDefined();
    expect(blocks).toHaveLength(4);
    const cases = [
      { name: "acaHealth", method: "GET", path: "/healthz" },
      { name: "acaReadiness", method: "GET", path: "/readyz" },
      { name: "acaMissingToken", method: "POST", path: "/api/messages" },
      { name: "acaInvalidToken", method: "POST", path: "/api/messages" },
    ];
    for (const [index, block] of blocks.entries()) {
      const expected = cases[index]!;
      expect(block).toContain(`# @name ${expected.name}`);
      expect(block).toContain("# @no-redirect");
      expect(block).toContain(`${expected.method} {{acaBaseUrl}}${expected.path}`);
      const resolved = block.replaceAll("{{acaBaseUrl}}", "https://aca.example.test");
      expect(resolved).not.toContain("{{");
      expect(resolved).not.toMatch(/api-key|client_secret|\$dotenv|\$processEnv/i);
      expect(resolved.match(/^Authorization:.*$/gim) ?? []).toEqual(index === 3
        ? ["Authorization: Bearer invalid-aca-test-token"] : []);
      if (expected.method === "POST") {
        expect(block).toContain("Content-Type: application/json");
        expect(JSON.parse(block.slice(block.indexOf("\n\n") + 2))).toEqual({
          type: "message",
          id: index === 2 ? "aca-http-missing-token" : "aca-http-invalid-token",
          channelId: "msteams",
          text: "Synthetic authentication check.",
        });
      } else {
        expect(block).not.toContain("\n\n");
      }
    }
  });
});
