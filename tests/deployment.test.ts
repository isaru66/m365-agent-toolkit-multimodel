import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
// Scripts intentionally remain dependency-free Node ESM rather than TS build inputs.
// @ts-expect-error JS tooling module has no declaration file
import { parseDeploymentOutput, parseFlags, provision, terraformRunner } from "../scripts/provision.mjs";
// @ts-expect-error JS tooling module has no declaration file
import { assertRevisionReady, deploy, makeImageTag, validateBuildIgnore, verifyHealth, waitForRevision } from "../scripts/deploy.mjs";
// @ts-expect-error JS tooling module has no declaration file
import { dotenvQuote, mergeToolkitEnv, syncToolkitEnv } from "../scripts/sync-toolkit-env.mjs";

const id = "00000000-0000-0000-0000-000000000001";
const deployment = {
  schema_version: 1, runtime_enabled: true, subscription_id: id, tenant_id: id,
  resource_group_name: "pilot-rg", acr_name: "pilotacr", acr_login_server: "pilotacr.azurecr.io",
  container_app_name: "pilot-app", container_name: "agent",
  container_app_url: "https://pilot-app.example.southeastasia.azurecontainerapps.io",
  bot_id: id, bot_application_object_id: id, bot_service_principal_id: id,
  bot_domain: "pilot-app.example.southeastasia.azurecontainerapps.io",
  bot_endpoint: "https://pilot-app.example.southeastasia.azurecontainerapps.io/api/messages",
  runtime_identity_id: `/subscriptions/${id}/resourceGroups/pilot-rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/pilot-runtime`,
  runtime_identity_client_id: id,
  key_vault_name: "pilot-kv", key_vault_uri: "https://pilot-kv.vault.azure.net/",
  cosmos_endpoint: "https://pilot-cosmos.documents.azure.com:443/",
  cosmos_database: "teams-agent", cosmos_container: "conversations",
};
const ignore = ".env\n.env.*\nenv\ninfra\n.azure\n.git\nnode_modules\nplan\n";
const quiet = () => undefined;
type Run = (command: string, args: string[], options?: object) => string;

function releaseMock(runtime = true) {
  let updated = false;
  const run = vi.fn<Run>((command, args) => {
    if (command === "terraform") return JSON.stringify({ ...deployment, runtime_enabled: runtime });
    if (args[0] === "containerapp" && args[1] === "update") updated = true;
    if (args[1] === "show") return JSON.stringify({
      image: updated ? "pilotacr.azurecr.io/teams-agent:release-test"
        : runtime ? "pilotacr.azurecr.io/teams-agent:previous" : "node:22-alpine",
      command: runtime ? null : ["node", "-e", "status:'bootstrap'"],
      revision: "pilot-app--001", readyRevision: "pilot-app--001", provisioning: "Succeeded",
    });
    return "";
  });
  const health = vi.fn().mockResolvedValue(undefined);
  return { run, health, log: quiet, hasFile: () => true, readFile: () => ignore, tag: () => "release-test" };
}

describe("Terraform orchestration gates", () => {
  it("defaults to validate/plan only, accepts Terraform diff exit code", () => {
    const run = vi.fn<Run>().mockReturnValue("");
    provision([], { run, log: quiet });
    expect(run.mock.calls.map((call) => call[1][1])).toEqual(["validate", "plan"]);
    expect(run.mock.calls[1]?.[2]).toEqual({ allowedStatuses: [0, 2] });
    expect(run.mock.calls.every((call) => call[1][0] === "-chdir=infra")).toBe(true);
  });

  it("requires explicit apply and retains Terraform interactive confirmation", () => {
    const run = vi.fn<Run>().mockReturnValue("");
    provision(["--apply", "--var-file", "infra/pilot config;echo.tfvars"], { run, log: quiet });
    expect(run.mock.calls.map((call) => call[1][1])).toEqual(["validate", "plan", "apply"]);
    const args = run.mock.calls[2]?.[1] ?? [];
    expect(args.some((arg) => arg.includes("pilot config;echo.tfvars"))).toBe(true);
    expect(args).not.toContain("-auto-approve");
    expect(args).not.toContain("-input=false");
    expect(args).not.toContain("echo");
  });

  it("requires explicit backend configuration and passes it as one argument", () => {
    const run = vi.fn<Run>().mockReturnValue("");
    expect(() => provision(["--init"], { run })).toThrow("backend-config");
    expect(run).not.toHaveBeenCalled();
    provision(["--init", "--backend-config", "infra/backend file.hcl"], { run, log: quiet });
    expect(run.mock.calls[0]?.[1][1]).toBe("init");
    expect(run.mock.calls[0]?.[1]).toHaveLength(3);
  });

  it("does not apply after a failed plan", () => {
    const run = vi.fn<Run>((_command, args) => {
      if (args[1] === "plan") throw new Error("plan failed");
      return "";
    });
    expect(() => provision(["--apply"], { run })).toThrow("plan failed");
    expect(run.mock.calls.some((call) => call[1].includes("apply"))).toBe(false);
  });

  it("rejects hidden Terraform CLI arguments", () => {
    vi.stubEnv("TF_CLI_ARGS_apply", "-auto-approve");
    try {
      const run = vi.fn();
      expect(() => provision(["--apply"], { run })).toThrow("TF_CLI_ARGS");
      expect(run).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });

  it.each([
    { args: ["--destroy"] }, { args: ["--apply", "--apply"] },
    { args: ["--var-file"] }, { args: ["--var-file", "--apply"] },
  ])("rejects unsafe/ambiguous argv $args", ({ args }) => {
    expect(() => parseFlags(args, ["--apply"], ["--var-file"])).toThrow();
  });
});

describe("Versioned nonsecret outputs and dotenv", () => {
  it("drops unrecognized outputs and validates the complete contract", () => {
    expect(parseDeploymentOutput(JSON.stringify({ ...deployment, CLIENT_SECRET: "not-exported" }))).toEqual(deployment);
    expect(() => parseDeploymentOutput("{")).toThrow("JSON");
    expect(() => parseDeploymentOutput(JSON.stringify({ ...deployment, schema_version: 2 }))).toThrow("schema");
    expect(() => parseDeploymentOutput(JSON.stringify({ ...deployment, bot_id: undefined }))).toThrow("bot_id");
  });

  it.each([
    { bot_id: "wrong" }, { acr_login_server: "attacker.example" },
    { container_app_url: "http://localhost:3978" }, { bot_domain: "example.com" },
    { resource_group_name: "--subscription=wrong" }, { tenant_id: `${id}\nINJECT=1` },
    { cosmos_container: "wrong" }, { runtime_identity_id: "/other-subscription/identity" },
  ])("rejects untrusted field overrides %j", (override) => {
    expect(() => parseDeploymentOutput(JSON.stringify({ ...deployment, ...override }))).toThrow();
  });

  it("preserves Teams registration/local variables and replaces only allowlisted values", () => {
    const existing = "\uFEFF# local settings\r\nTEAMS_APP_ID=keep\r\nSECRET_BOT_PASSWORD=keep-private\r\nBOT_ID=old\r\nexport BOT_ID=duplicate\r\nCUSTOM=\"hash#value\"\r\n";
    const merged = mergeToolkitEnv(existing, deployment);
    expect(merged).toContain("TEAMS_APP_ID=keep\nSECRET_BOT_PASSWORD=keep-private");
    expect(merged).toContain('CUSTOM="hash#value"');
    expect(merged.match(/^BOT_ID=/gm)).toHaveLength(1);
    expect(merged).toContain(`BOT_ID="${id}"`);
    expect(merged).not.toContain("CLIENT_SECRET=");
    expect(merged).not.toContain("\r");
  });

  it("does not rewrite managed-looking text inside multiline unknown values", () => {
    const merged = mergeToolkitEnv('CUSTOM="first\nBOT_ID=inside\nlast"\n', deployment);
    expect(merged).toContain('CUSTOM="first\nBOT_ID=inside\nlast"');
    expect(() => mergeToolkitEnv('BOT_ID="first\nlast"\n', deployment)).toThrow("multiline");
    expect(() => mergeToolkitEnv('CUSTOM="unclosed', deployment)).toThrow("unterminated");
  });

  it("quotes dotenv literals without JSON backslash-escape corruption", () => {
    expect(dotenvQuote("https://example/#hash")).toBe('"https://example/#hash"');
    expect(dotenvQuote('a"b')).toBe("'a\"b'");
    expect(dotenvQuote("a\\path")).toBe('"a\\path"');
    expect(() => dotenvQuote("line\nINJECT=1")).toThrow();
    expect(() => dotenvQuote("\"'`")).toThrow();
  });

  it("refuses env synchronization when destination is not ignored or is tracked", () => {
    const run = vi.fn<Run>().mockImplementation(() => { throw new Error("not ignored"); });
    expect(() => syncToolkitEnv([], { run })).toThrow("not ignored");
    expect(run).toHaveBeenCalledTimes(1);
    const tracked = vi.fn<Run>((_command, args) => args[0] === "ls-files" ? "env/.env.dev\n" : "");
    expect(() => syncToolkitEnv([], { run: tracked })).toThrow("tracked");
    expect(tracked).toHaveBeenCalledTimes(2);
  });
});

describe("Explicit WSL Terraform execution", () => {
  it("routes init, validate, plan and approved apply through Ubuntu with POSIX config paths", () => {
    const run = vi.fn<Run>().mockReturnValue("");
    provision([
      "--wsl", "--wsl-data-dir", "/tmp/pilot-tf", "--init",
      "--backend-config", "/home/operator/backend config.hcl",
      "--var-file", "/home/operator/pilot config.tfvars", "--apply",
    ], { run, log: quiet });
    expect(run.mock.calls.map((call) => call[1][5])).toEqual(["init", "validate", "plan", "apply"]);
    for (const [command, args, options] of run.mock.calls) {
      expect(command).toBe("wsl.exe");
      expect(args.slice(0, 5)).toEqual(["--distribution", "Ubuntu", "--exec", "terraform", "-chdir=infra"]);
      expect(args).not.toContain("-c");
      expect(args).not.toContain("-auto-approve");
      expect(options).toMatchObject({ env: { TF_DATA_DIR: "/tmp/pilot-tf" } });
    }
    expect(run.mock.calls[0]?.[1]).toContain("-backend-config=/home/operator/backend config.hcl");
    expect(run.mock.calls[2]?.[1]).toContain("-var-file=/home/operator/pilot config.tfvars");
    expect(run.mock.calls[2]?.[2]).toMatchObject({ allowedStatuses: [0, 2] });
  });

  it("maps Windows paths using argument arrays and isolates the default cache", () => {
    const run = vi.fn<Run>((_command, args) => {
      if (args[3] === "wslpath") return args[6] === "C:\\config dir\\pilot;echo.tfvars"
        ? "/mnt/c/config dir/pilot;echo.tfvars\n" : "/mnt/c/project\n";
      return "";
    });
    const execute = terraformRunner({ "--wsl": true }, run);
    execute("terraform", ["-chdir=infra", "plan", "-var-file=C:\\config dir\\pilot;echo.tfvars"]);
    const call = run.mock.calls.at(-1);
    expect(call?.[0]).toBe("wsl.exe");
    expect(call?.[1]).toContain("-var-file=/mnt/c/config dir/pilot;echo.tfvars");
    expect(call?.[2]).toMatchObject({ env: { TF_DATA_DIR: "/mnt/c/project/infra/.terraform-wsl" } });
    expect(run.mock.calls.filter((entry) => entry[1][3] === "wslpath")).toHaveLength(2);
    expect(run.mock.calls.some((entry) => entry[1].includes("sh"))).toBe(false);
  });

  it("forwards only a child cache override and preserves the caller environment", () => {
    vi.stubEnv("TF_DATA_DIR", "C:\\native-cache");
    vi.stubEnv("WSLENV", "SHARED/p:TF_DATA_DIR/p");
    try {
      const run = vi.fn<Run>().mockReturnValue("");
      const execute = terraformRunner({ "--wsl": true, "--wsl-data-dir": "/tmp/isolated" }, run);
      execute("terraform", ["-chdir=infra", "validate"]);
      expect(run.mock.calls[0]?.[2]).toMatchObject({
        env: { TF_DATA_DIR: "/tmp/isolated", WSLENV: "SHARED/p:TF_DATA_DIR/u" },
      });
      expect(process.env.TF_DATA_DIR).toBe("C:\\native-cache");
    } finally { vi.unstubAllEnvs(); }
  });

  it("routes sync output through WSL before attempting any environment write", () => {
    const run = vi.fn<Run>((command) => command === "git" ? "" : "{}");
    expect(() => syncToolkitEnv(["--wsl", "--wsl-data-dir", "/tmp/pilot-tf"], { run })).toThrow("schema");
    expect(run.mock.calls.at(-1)?.slice(0, 2)).toEqual([
      "wsl.exe", ["--distribution", "Ubuntu", "--exec", "terraform", "-chdir=infra", "output", "-json", "deployment"],
    ]);
  });

  it("reads release outputs in WSL without changing the native Azure CLI runner", async () => {
    const deps = releaseMock();
    const native = deps.run.getMockImplementation()!;
    deps.run.mockImplementation((command, args, options) => {
      if (command === "wsl.exe") return native("terraform", args.slice(4), options);
      return native(command, args, options);
    });
    await deploy(["--deploy", "--verify-only", "--wsl", "--wsl-data-dir", "/tmp/pilot-tf"], deps);
    expect(deps.run.mock.calls[0]?.[0]).toBe("wsl.exe");
    expect(deps.run.mock.calls[0]?.[1].slice(0, 4)).toEqual(["--distribution", "Ubuntu", "--exec", "terraform"]);
    expect(deps.run.mock.calls[1]?.[0]).toBe("az");
    expect(deps.health).toHaveBeenCalled();
  });

  it("rejects ambiguous cache options and does not implicitly switch native execution", () => {
    const run = vi.fn<Run>().mockReturnValue("");
    expect(() => terraformRunner({ "--wsl-data-dir": "/tmp/cache" }, run)).toThrow("requires --wsl");
    expect(() => terraformRunner({ "--wsl": true, "--wsl-data-dir": "C:\\cache" }, run)).toThrow("POSIX");
    expect(() => terraformRunner({ "--wsl": true, "--wsl-data-dir": "/mnt/c/repo/infra/.terraform" }, run)).toThrow("separate");
    expect(terraformRunner({}, run)).toBe(run);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("Release command construction and stage gates", () => {
  it("runs no command without explicit deployment authorization", async () => {
    const deps = releaseMock();
    await expect(deploy([], deps)).rejects.toThrow("--deploy");
    expect(deps.run).not.toHaveBeenCalled();
    await expect(deploy(["--deploy", "--prepare-runtime", "--verify-only"], deps)).rejects.toThrow("already enabled");
  });

  it("builds a unique Linux image, sets managed identity registry, then updates/verifies", async () => {
    const deps = releaseMock();
    await deploy(["--deploy"], deps);
    const commands = deps.run.mock.calls;
    expect(commands[0]?.[1]).toEqual(["-chdir=infra", "output", "-json", "deployment"]);
    const acr = commands.find((call) => call[1][0] === "acr");
    expect(acr?.[1]).toContain("teams-agent:release-test");
    expect(acr?.[1]).toContain("linux/amd64");
    const registry = commands.find((call) => call[1][1] === "registry");
    expect(registry?.[1]).toContain(deployment.runtime_identity_id);
    expect(registry?.[1]).not.toContain("--username");
    const update = commands.find((call) => call[1][1] === "update");
    expect(update?.[1]).toContain("pilotacr.azurecr.io/teams-agent:release-test");
    expect(update?.[1]).not.toContain("--set-env-vars");
    expect(commands.some((call) => call[1].includes("secret"))).toBe(false);
    expect(deps.health).toHaveBeenCalledWith(deployment.container_app_url, { bootstrap: false });
  });

  it("requires staging while bootstrap and never reports it as runtime ready", async () => {
    const deps = releaseMock(false);
    await expect(deploy(["--deploy"], deps)).rejects.toThrow("Runtime is disabled");
    expect(deps.run).toHaveBeenCalledTimes(1);
    deps.run.mockClear();
    await deploy(["--deploy", "--prepare-runtime"], deps);
    expect(deps.health).toHaveBeenCalledWith(deployment.container_app_url, { bootstrap: true });
    await expect(deploy(["--deploy", "--prepare-runtime"], releaseMock())).rejects.toThrow("already enabled");
  });

  it("verify-only performs no build or configuration change", async () => {
    const deps = releaseMock();
    await deploy(["--deploy", "--verify-only"], deps);
    expect(deps.run.mock.calls).toHaveLength(2);
    expect(deps.health).toHaveBeenCalledWith(deployment.container_app_url, { bootstrap: false });
  });

  it("verifies a staged image without rebuilding or enabling runtime", async () => {
    const deps = releaseMock(false);
    const base = deps.run.getMockImplementation()!;
    deps.run.mockImplementation((command, args, options) => {
      const result = base(command, args, options);
      return args[1] === "show"
        ? JSON.stringify({ ...JSON.parse(result), image: "pilotacr.azurecr.io/teams-agent:release-staged" })
        : result;
    });
    await deploy(["--deploy", "--prepare-runtime", "--verify-only"], deps);
    expect(deps.run.mock.calls).toHaveLength(2);
    expect(deps.health).toHaveBeenCalledWith(deployment.container_app_url, { bootstrap: true });
    await expect(deploy(["--deploy", "--prepare-runtime", "--verify-only"], releaseMock(false)))
      .rejects.toThrow("expected release repository");
  });

  it("waits for the newly deployed revision instead of failing during normal warmup", async () => {
    const deps = releaseMock();
    const base = deps.run.getMockImplementation()!;
    let shows = 0;
    deps.run.mockImplementation((command, args, options) => {
      const result = base(command, args, options);
      if (args[1] === "show" && ++shows === 2) {
        return JSON.stringify({ ...JSON.parse(result), readyRevision: "previous" });
      }
      return result;
    });
    const sleep = vi.fn().mockImplementation(async () => {
      expect(deps.health).not.toHaveBeenCalled();
    });
    await deploy(["--deploy"], { ...deps, sleep });
    expect(sleep).toHaveBeenCalledWith(10000);
    expect(shows).toBe(3);
    expect(deps.run.mock.calls.filter((call) => call[1][0] === "acr")).toHaveLength(1);
  });

  it("rejects a stale ready revision rather than trusting the old healthy app", () => {
    expect(() => assertRevisionReady({ revision: "new", readyRevision: "old", provisioning: "Succeeded" })).toThrow("older serving revision");
    expect(() => assertRevisionReady({ revision: "new", readyRevision: "new", provisioning: "Failed" })).toThrow("not ready");
    expect(() => assertRevisionReady({ revision: "new", readyRevision: "new", provisioning: "Succeeded" })).not.toThrow();
  });

  it("fails before any upload if ignore rules are unsafe", async () => {
    const deps = { ...releaseMock(), readFile: () => ".git\n" };
    await expect(deploy(["--deploy"], deps)).rejects.toThrow("Build context");
    expect(deps.run.mock.calls.some((call) => call[1][0] === "acr")).toBe(false);
    expect(() => validateBuildIgnore(`${ignore}!env/.env.dev\n`)).toThrow("negation");
  });

  it("excludes repository planning artifacts before uploading an ACR build", async () => {
    const deps = { ...releaseMock(), readFile: () => ignore.replace("plan\n", "") };
    await expect(deploy(["--deploy"], deps)).rejects.toThrow("Build context must exclude plan");
    expect(deps.run.mock.calls.some((call) => call[1][0] === "acr")).toBe(false);
    expect(() => validateBuildIgnore(readFileSync(new URL("../.dockerignore", import.meta.url), "utf8"))).not.toThrow();
  });

  it("does not update the app if ACR build fails", async () => {
    const deps = releaseMock();
    const base = deps.run.getMockImplementation()!;
    deps.run.mockImplementation((command, args, options) => {
      if (args[0] === "acr") throw new Error("build failed");
      return base(command, args, options);
    });
    await expect(deploy(["--deploy"], deps)).rejects.toThrow("build failed");
    expect(deps.run.mock.calls.some((call) => call[1][1] === "update")).toBe(false);
    expect(deps.health).not.toHaveBeenCalled();
  });

  it("produces registry-valid collision-resistant tags", () => {
    expect(makeImageTag()).toMatch(/^release-[a-z0-9]+-[a-f0-9]{12}$/);
    expect(makeImageTag()).not.toBe(makeImageTag());
  });
});

describe("Bounded revision readiness", () => {
  const pending = {
    image: "pilotacr.azurecr.io/teams-agent:release-test",
    command: null, revision: "new", readyRevision: "old", provisioning: "Succeeded",
  };

  it("fails after the bounded wait when only an older revision is ready", async () => {
    const read = vi.fn().mockReturnValue(pending);
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(waitForRevision(read, pending, { attempts: 2, sleep })).rejects.toThrow("older serving revision");
    expect(read).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("does not retry terminal provisioning errors", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(waitForRevision(vi.fn(), { ...pending, provisioning: "Failed" }, { sleep }))
      .rejects.toThrow("provisioning Failed");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("rejects a changed image or runtime stage during the wait", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(waitForRevision(() => ({ ...pending, image: "unexpected" }), pending, { attempts: 2, sleep }))
      .rejects.toThrow("requested unique image");
    await expect(waitForRevision(() => ({
      ...pending, command: ["node", "-e", "status:'bootstrap'"],
    }), pending, { attempts: 2, sleep })).rejects.toThrow("runtime stage disagree");
  });
});

describe("Health validation", () => {
  it("rejects healthy placeholder as production readiness", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: "bootstrap", ready: false }) });
    await expect(verifyHealth(deployment.container_app_url, { fetchImpl, attempts: 1 })).rejects.toThrow("NOT ready");
    await expect(verifyHealth(deployment.container_app_url, { fetchImpl, attempts: 1, bootstrap: true })).resolves.toBeUndefined();
  });

  describe("Terraform enabled-provider configuration contract (offline)", () => {
    const terraform = readFileSync(new URL("../infra/main.tf", import.meta.url), "utf8");
    const variables = readFileSync(new URL("../infra/variables.tf", import.meta.url), "utf8");
    const example = readFileSync(new URL("../infra/terraform.tfvars.example", import.meta.url), "utf8");

    it("preserves the historical default and rejects empty, duplicate, and unknown lists", () => {
      expect(variables).toMatch(/variable "enabled_providers" \{[\s\S]*?default\s*=\s*\["claude", "gemini"\]/);
      expect(variables).toContain("length(var.enabled_providers) > 0");
      expect(variables).toContain("length(distinct(var.enabled_providers)) == length(var.enabled_providers)");
      expect(variables).toContain('contains(["claude", "gemini", "azure-openai"], provider)');
      expect(example).toMatch(/runtime_enabled\s*=\s*false/);
    });

    it.each([
      ["ANTHROPIC_BASE_URL", "anthropic_base_url", "CLAUDE_MODEL", "claude_model"],
      ["GEMINI_BASE_URL", "gemini_base_url", "GEMINI_MODEL", "gemini_model"],
      ["AZURE_OPENAI_BASE_URL", "azure_openai_base_url", "AZURE_OPENAI_DEPLOYMENT", "azure_openai_deployment"],
    ])("injects nonsecret settings for %s", (baseEnv, baseVar, modelEnv, modelVar) => {
      expect(variables).toContain(`variable "${baseVar}"`);
      expect(variables).toContain(`variable "${modelVar}"`);
      expect(terraform).toMatch(new RegExp(`${baseEnv}\\s*=\\s*trim\\(trimspace\\(var\\.${baseVar}\\), "/"\\)`));
      expect(terraform).toMatch(new RegExp(`${modelEnv}\\s*=\\s*var\\.${modelVar}`));
      expect(terraform).toMatch(/ENABLED_PROVIDERS\s*=\s*join\(",", var\.enabled_providers\)/);
    });

    it("gates required endpoint/model validation on runtime activation and enabled providers", () => {
      expect(terraform).toContain("condition     = !var.runtime_enabled || local.live_provider_config_valid");
      expect(terraform).toContain("for provider, config in local.provider_config :");
      expect(terraform).toContain("!contains(var.enabled_providers, provider) || (");
      expect(terraform).toContain('regex("^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$", trimspace(config.model))');
      expect(terraform).toContain('regex("(?i)^https://');
      expect(terraform).toContain('!can(regex("(?i)/api/projects(/|$)", trimspace(config.base_url)))');
      expect(terraform).toContain('!can(regex("(?i)${config.operation_suffix}"');
      expect(terraform).toContain('"/v1(/messages|/models)?$"');
      expect(terraform).toContain('"/v1(beta|alpha)?(/models)?$"');
      expect(terraform).toContain('"/(chat/completions|responses)$"');
      expect(terraform).not.toContain("claude-opus-");
    });

    it("checks the declared endpoint and model patterns against synthetic input without Terraform or Azure calls", () => {
      // Read the actual HCL string literals, not a second copy of the policy regex.
      // These patterns use syntax shared by Terraform RE2 and JavaScript.
      const pattern = (field: string): RegExp => {
        const literal = terraform.match(new RegExp(
          `can\\(regex\\(("(?:\\\\.|[^"\\\\])*"), trimspace\\(config\\.${field}\\)\\)\\)`,
        ))?.[1];
        if (!literal) throw new Error(`Missing Terraform ${field} pattern`);
        const value: string = JSON.parse(literal);
        return new RegExp(value.replace(/^\(\?i\)/, ""), value.startsWith("(?i)") ? "i" : "");
      };
      const base = pattern("base_url");
      for (const value of [
        "https://claude.example.test/anthropic",
        "https://gemini.example.test",
        "https://azure.example.test/prefix/openai/v1/",
      ]) expect(base.test(value)).toBe(true);
      for (const value of [
        "", "http://example.test", "https://", "https://user:key@example.test/anthropic",
        "https://example.test/anthropic?key=wrong", "https://example.test/#fragment",
        "https://example.test/anthropic?", "https://example.test/anthropic#",
        "https://example.test/has space", "https://example.test/back\\slash",
      ]) expect(base.test(value)).toBe(false);
      const model = pattern("model");
      for (const value of ["my-deployment", "model.v2_1", "a".repeat(200)]) {
        expect(model.test(value)).toBe(true);
      }
      for (const value of ["", "models/gemini", "alias?query", "alias\nbad", "a".repeat(201)]) {
        expect(model.test(value)).toBe(false);
      }
    });

    it("always retains the bot reference but conditionally references each provider key", () => {
      expect(terraform).toContain('{ CLIENT_SECRET = "bot-client-secret" }');
      expect(terraform).toContain("{ bot-client-secret = var.secret_names.bot_client_secret }");
      for (const [provider, env, secret, field] of [
        ["claude", "ANTHROPIC_API_KEY", "anthropic-api-key", "anthropic_api_key"],
        ["gemini", "GEMINI_API_KEY", "gemini-api-key", "gemini_api_key"],
        ["azure-openai", "AZURE_OPENAI_API_KEY", "azure-openai-api-key", "azure_openai_api_key"],
      ]) {
        expect(terraform).toContain(`contains(var.enabled_providers, "${provider}") ? { ${env} = "${secret}" } : {}`);
        expect(terraform).toContain(`contains(var.enabled_providers, "${provider}") ? { ${secret} = var.secret_names.${field} } : {}`);
      }
      expect(terraform).toContain("for_each = var.runtime_enabled ? local.secret_references : {}");
      expect(terraform).toContain("for_each = var.runtime_enabled ? local.secret_env : {}");
      expect(terraform).toContain("for_each = var.runtime_enabled ? local.runtime_env : {}");
    });

    it("keeps old secret-name objects compatible and never declares secret values or data reads", () => {
      expect(variables).toMatch(/azure_openai_api_key\s*=\s*optional\(string, "azure-openai-api-key"\)/);
      expect(terraform).toMatch(/key_vault_secret_id\s*=\s*"\$\{azurerm_key_vault\.secrets\.vault_uri\}secrets\/\$\{secret\.value\}"/);
      expect(terraform).not.toMatch(/(?:data|resource)\s+"azurerm_key_vault_secret"/);
      expect(terraform).not.toMatch(/resource\s+"azuread_application_password"/);
      expect(variables).not.toMatch(/variable "(?:anthropic_api_key|gemini_api_key|azure_openai_api_key|bot_client_secret)"/);
    });
  });

  it("retries transient failures, disallows redirects and requires runtime JSON", async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "healthy" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ready" }) });
    const sleep = vi.fn().mockResolvedValue(undefined);
    await verifyHealth(deployment.container_app_url, { fetchImpl, sleep, attempts: 2 });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
    const notReady = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: "healthy", ready: false }) });
    await expect(verifyHealth(deployment.container_app_url, { fetchImpl: notReady, attempts: 1 })).rejects.toThrow("NOT ready");
  });

  it("rejects a healthy but draining runtime", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "healthy" }) })
      .mockResolvedValueOnce({ ok: false, json: async () => ({ status: "busy" }) });
    await expect(verifyHealth(deployment.container_app_url, { fetchImpl, attempts: 1 })).rejects.toThrow("NOT ready");
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(`${deployment.container_app_url}/readyz`);
  });

  it("configures sufficient drain grace and separate runtime readiness", () => {
    const terraform = readFileSync(new URL("../infra/main.tf", import.meta.url), "utf8");
    expect(terraform).toMatch(/termination_grace_period_seconds\s*=\s*120/);
    expect(terraform).toMatch(/path\s*=\s*var\.runtime_enabled \? "\/readyz" : "\/healthz"/);
  });

  it("wires Entra-only telemetry routing and scopes ingestion rights to App Insights", () => {
    const terraform = readFileSync(new URL("../infra/main.tf", import.meta.url), "utf8");
    expect(terraform).toMatch(/APPLICATIONINSIGHTS_CONNECTION_STRING\s*=\s*azapi_resource\.insights\.output\.properties\.ConnectionString/);
    expect(terraform).toMatch(/DisableLocalAuth\s*=\s*true/);
    expect(terraform).toContain('response_export_values = ["properties.ConnectionString"]');
    expect(terraform).toMatch(/resource "azurerm_role_assignment" "telemetry_publisher" \{\s*scope\s*=\s*azapi_resource\.insights\.id\s*role_definition_name\s*=\s*"Monitoring Metrics Publisher"\s*principal_id\s*=\s*azurerm_user_assigned_identity\.runtime\.principal_id/);
  });
});
