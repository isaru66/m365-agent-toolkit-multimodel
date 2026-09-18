import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMain, parseFlags, readDeployment, repoRoot, runCommand, terraformRunner } from './provision.mjs';

export function makeImageTag(now = new Date(), nonce = randomUUID()) {
  return `release-${now.toISOString().replace(/[-:.]/g, '').toLowerCase()}-${nonce.replace(/-/g, '').slice(0, 12)}`;
}

export function validateBuildIgnore(text) {
  const rules = new Set(text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#')));
  // Deliberately conservative: negations can re-include excluded secret files.
  if ([...rules].some((rule) => rule.startsWith('!'))) throw new Error('Build context guard does not allow .dockerignore negation rules.');
  for (const name of ['.env', '.env.*', 'env', 'infra', '.azure', '.git', 'node_modules', 'plan']) {
    if (![name, `${name}/`, `/${name}`, `/${name}/`, `**/${name}`, `**/${name}/`].some((rule) => rules.has(rule))) {
      throw new Error(`Build context must exclude ${name} in .dockerignore.`);
    }

  }
}

function revisionIsReady(app) {
  return app.provisioning === 'Succeeded' && typeof app.revision === 'string' && Boolean(app.revision)
    && app.revision === app.readyRevision;
}

function isBootstrapCommand(command) {
  return Array.isArray(command) && command[0] === 'node'
    && command.some((part) => typeof part === 'string' && part.includes("status:'bootstrap'"));
}

export function assertRevisionReady(app) {
  if (!revisionIsReady(app)) {
    throw new Error('Latest ACA revision is not ready. No success claimed from an older serving revision; retry --deploy --verify-only after investigating (add --prepare-runtime for staging).');
  }
}

export async function waitForRevision(read, initial, {
  expectedImage = initial.image,
  bootstrap = false,
  attempts = 30,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let app = initial;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (app.image !== expectedImage) throw new Error('ACA did not retain the requested unique image.');
    if (bootstrap !== isBootstrapCommand(app.command)) {
      throw new Error('Live ACA command and Terraform runtime stage disagree. Reconcile Terraform before releasing.');
    }
    if (['Failed', 'Canceled'].includes(app.provisioning)) {
      throw new Error(`Latest ACA revision provisioning ${app.provisioning}. Inspect redacted ACA logs before retrying.`);
    }
    if (revisionIsReady(app)) return app;
    if (attempt + 1 < attempts) {
      await sleep(10_000);
      app = read();
    }
  }
  assertRevisionReady(app);
}

const revisionQuery = '{image:properties.template.containers[0].image,command:properties.template.containers[0].command,revision:properties.latestRevisionName,readyRevision:properties.latestReadyRevisionName,provisioning:properties.provisioningState}';

export async function verifyHealth(url, {
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  attempts = 30,
  bootstrap = false,
} = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetchImpl(`${url}/healthz`, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
      const body = await response.json();
      // A 200 alone is not readiness: the credential-free placeholder is healthy.
      if (response.ok && bootstrap && body?.status === 'bootstrap' && body?.ready === false) return;
      if (response.ok && !bootstrap && body?.status === 'healthy' && body?.ready !== false) {
        const readiness = await fetchImpl(`${url}/readyz`, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
        const readyBody = await readiness.json();
        if (readiness.ok && readyBody?.status === 'ready') return;
      }
    } catch { /* bounded retries; never print response bodies */ }
    if (attempt + 1 < attempts) await sleep(10_000);
  }
  throw new Error(bootstrap ? 'Staged image did not pass bootstrap health.' : 'Runtime health failed; release is NOT ready. Inspect redacted ACA logs; no automatic rollback performed.');
}

export async function deploy(args = process.argv.slice(2), {
  run = runCommand, log = console.log, health = verifyHealth,
  tag = makeImageTag, hasFile = existsSync, readFile = readFileSync,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const flags = parseFlags(args, ['--deploy', '--prepare-runtime', '--verify-only', '--help', '--wsl'], ['--wsl-data-dir']);
  if (flags['--help']) {
    log('deploy.mjs --deploy [--prepare-runtime] [--verify-only] [--wsl [--wsl-data-dir /absolute/posix/path]]\nCombine --prepare-runtime --verify-only to verify an already-staged image without rebuilding or activating runtime. Requires explicit --deploy. --wsl reads Terraform outputs in Ubuntu; Azure release commands still use the caller platform Azure CLI. Never provisions infrastructure, creates secrets or publishes Teams.');
    return;
  }
  if (!flags['--deploy']) throw new Error('No deployment authorized. Pass --deploy explicitly.');
  const output = readDeployment(terraformRunner(flags, run));
  const prepare = Boolean(flags['--prepare-runtime']);
  if (prepare && output.runtime_enabled) throw new Error('Runtime already enabled; do not run --prepare-runtime on a live agent.');
  if (!prepare && !output.runtime_enabled) throw new Error('Runtime is disabled. Stage with --prepare-runtime, populate secrets, then enable runtime_enabled via Terraform.');
  const scope = ['--subscription', output.subscription_id];
  const target = ['--name', output.container_app_name, '--resource-group', output.resource_group_name, ...scope];
  // Read only explicitly selected public fields, never "show" all app secrets.
  const readRevision = () => JSON.parse(run('az', [
    'containerapp', 'show', ...target,
    '--query', revisionQuery,
    '--output', 'json', '--only-show-errors',
  ], { capture: true }));
  const current = readRevision();
  if (prepare !== isBootstrapCommand(current.command)) throw new Error('Live ACA command and Terraform runtime stage disagree. Reconcile Terraform before releasing.');
  if (flags['--verify-only']) {
    if (!String(current.image).startsWith(`${output.acr_login_server}/teams-agent:`)) throw new Error('Live image is not from the expected release repository.');
    await waitForRevision(readRevision, current, { bootstrap: prepare, sleep });
    await health(output.container_app_url, { bootstrap: prepare });
    log(prepare
      ? 'Staged image bootstrap health verified; runtime remains disabled. No build or configuration change performed.'
      : 'Runtime health verified. Teams authentication/streaming still require separate end-to-end validation.');
    return;
  }
  if (!hasFile(join(repoRoot, 'Dockerfile'))) throw new Error('Root Dockerfile is required.');
  if (!hasFile(join(repoRoot, '.dockerignore'))) throw new Error('.dockerignore is required to keep secrets/state out of the remote build context.');
  validateBuildIgnore(readFile(join(repoRoot, '.dockerignore'), 'utf8'));
  const imageTag = tag();
  if (!/^[a-z0-9][a-z0-9.-]{0,127}$/.test(imageTag)) throw new Error('Invalid generated image tag.');
  const image = `${output.acr_login_server}/teams-agent:${imageTag}`;
  // Build uploads only the Docker-filtered context. The parent-owned
  // .dockerignore MUST exclude .env*, env/, .azure/, infra/, .git/, node_modules/, plan/.
  run('az', ['acr', 'build', '--registry', output.acr_name, ...scope,
    '--image', `teams-agent:${imageTag}`, '--file', 'Dockerfile', '--platform', 'linux/amd64',
    '--only-show-errors', '.']);
  run('az', ['containerapp', 'registry', 'set', ...target,
    '--server', output.acr_login_server, '--identity', output.runtime_identity_id,
    '--output', 'none', '--only-show-errors'], { capture: true });
  run('az', ['containerapp', 'update', ...target, '--container-name', output.container_name,
    '--image', image, '--output', 'none', '--only-show-errors'], { capture: true });
  log(`Image: ${image}`);
  log(`Previous image (rollback reference): ${String(current.image ?? 'unknown')}`);
  await waitForRevision(readRevision, readRevision(), { expectedImage: image, bootstrap: prepare, sleep });
  await health(output.container_app_url, { bootstrap: prepare });
  log(prepare
    ? 'Image staged; bootstrap only, NOT a ready agent. Populate Key Vault, persist runtime_enabled=true and verified models in tfvars, review/apply Terraform, then run --deploy --verify-only.'
    : 'Runtime health passed. No Teams publication performed; authentication, streaming and provider access require separate validation.');
}

if (isMain(import.meta.url)) {
  try { await deploy(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
