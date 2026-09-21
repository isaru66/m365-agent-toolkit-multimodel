import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

it("starts the installed Playground in Teams mode with telemetry disabled and a loopback bot endpoint", () => {
  const packageJson: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  expect(packageJson).toMatchObject({
    scripts: {
      playground: "agentsplayground --disable-telemetry --app-endpoint http://127.0.0.1:3978/api/messages --channel-id msteams",
    },
    devDependencies: {
      "@microsoft/m365agentsplayground": "0.2.28",
    },
  });
});

it("loads current root dotenv values into the debugger instead of stale inherited credentials", () => {
  const launch: unknown = JSON.parse(readFileSync(new URL("../.vscode/launch.json", import.meta.url), "utf8"));
  expect(launch).toMatchObject({
    configurations: expect.arrayContaining([expect.objectContaining({
      name: "Debug local agent (.env)",
      cwd: "${workspaceFolder}",
      envFile: "${workspaceFolder}\\.env",
      runtimeArgs: ["--import", "./scripts/load-local-env.mjs", "--import", "tsx"],
    })]),
  });

});

it("overrides stale inherited local settings without reading real credentials", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-local-env-"));
  try {
    mkdirSync(join(directory, "scripts"));
    const loader = join(directory, "scripts", "load-local-env.mjs");
    copyFileSync(new URL("../scripts/load-local-env.mjs", import.meta.url), loader);
    writeFileSync(join(directory, ".env"), [
      "GEMINI_API_KEY=saved-test-key",
      "LOCAL_PLAYGROUND=true",
      "PROVIDER_MODE=mock",
    ].join("\n"));
    const child = spawnSync(process.execPath, [
      "--import", pathToFileURL(loader).href, "--input-type=module", "-e",
      "console.log(JSON.stringify({key:process.env.GEMINI_API_KEY,local:process.env.LOCAL_PLAYGROUND,mode:process.env.PROVIDER_MODE,untouched:process.env.TEST_UNTOUCHED}))",
    ], {
      cwd: directory,
      env: {
        ...process.env, NODE_OPTIONS: "",
        GEMINI_API_KEY: "stale-test-key", LOCAL_PLAYGROUND: "false",
        PROVIDER_MODE: "live", TEST_UNTOUCHED: "keep",
      },
      encoding: "utf8",
    });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({
      key: "saved-test-key", local: "true", mode: "mock", untouched: "keep",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
