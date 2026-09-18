import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// No shell is used, including on Windows. az.cmd cannot safely be passed to
// exec/spawn with shell:true; invoke the Azure CLI's bundled Python instead.
export function runCommand(command, args, { capture = false, allowedStatuses = [0], cwd = repoRoot, env = process.env } = {}) {
  let executable = command;
  let argv = [...args];
  if (command === 'az' && process.platform === 'win32') {
    let python = process.env.AZURE_CLI_PYTHON;
    if (!python) {
      const found = spawnSync('where.exe', ['az'], { encoding: 'utf8', shell: false });
      const paths = (found.stdout ?? '').split(/\r?\n/).filter(Boolean);
      for (const path of paths) {
        python = [join(dirname(path), '..', 'python.exe'), join(dirname(path), 'python.exe')].find(existsSync);
        if (python) break;
      }
    }
    if (!python || !isAbsolute(python) || !existsSync(python)) {
      throw new Error('Azure CLI bundled Python not found. Set AZURE_CLI_PYTHON to its absolute python.exe path.');
    }
    executable = python;
    argv = ['-IBm', 'azure.cli', ...args];
  }
  const result = spawnSync(executable, argv, {
    cwd, env, shell: false, encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    maxBuffer: 4 * 1024 * 1024,
  });
  // Do not include captured stdout/stderr: provider diagnostics can contain
  // sensitive configuration. Operators may rerun a failed command privately.
  if (result.error) throw new Error(`Unable to start ${command}: ${result.error.code ?? 'process error'}`);
  if (!allowedStatuses.includes(result.status)) throw new Error(`${command} failed (exit ${result.status ?? 'signal'}).`);
  return result.stdout ?? '';
}

export function parseFlags(args, booleanFlags, valueFlags = []) {
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!booleanFlags.includes(flag) && !valueFlags.includes(flag)) throw new Error(`Unknown argument: ${flag}`);
    if (Object.hasOwn(parsed, flag)) throw new Error(`Duplicate argument: ${flag}`);
    if (booleanFlags.includes(flag)) parsed[flag] = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith('--') || /[\0\r\n]/.test(value)) throw new Error(`Missing or invalid value for ${flag}`);
      parsed[flag] = value;
    }
  }
  return parsed;
}

// Windows Node may drive native Ubuntu Terraform without installing Node in WSL.
// WSL maps the inherited repository cwd; every Terraform argv remains an array.
export function terraformRunner(flags, run = runCommand) {
  if (flags['--wsl-data-dir'] && !flags['--wsl']) throw new Error('--wsl-data-dir requires --wsl.');
  if (!flags['--wsl']) return run;
  const suppliedDataDir = flags['--wsl-data-dir'];
  if (suppliedDataDir && (!suppliedDataDir.startsWith('/') || suppliedDataDir === '/'
    || /[\0\r\n]/.test(suppliedDataDir) || /(?:^|\/)\.terraform\/?$/.test(suppliedDataDir))) {
    throw new Error('--wsl-data-dir must be an absolute POSIX path separate from native .terraform caches.');
  }
  const paths = new Map();
  function toWslPath(path) {
    if (path.startsWith('/')) return path;
    if (!paths.has(path)) {
      const mapped = run('wsl.exe', ['--distribution', 'Ubuntu', '--exec', 'wslpath', '-a', '-u', path], { capture: true }).trim();
      if (!mapped.startsWith('/') || /[\0\r\n]/.test(mapped)) throw new Error('WSL could not map the Terraform configuration path.');
      paths.set(path, mapped);
    }
    return paths.get(path);
  }
  let dataDir = suppliedDataDir;
  return (command, args, options = {}) => {
    if (command !== 'terraform') return run(command, args, options);
    dataDir ??= `${toWslPath(repoRoot)}/infra/.terraform-wsl`;
    const argv = args.map((arg) => {
      const match = /^(-backend-config=|-var-file=)(.*)$/.exec(arg);
      return match ? `${match[1]}${toWslPath(match[2])}` : arg;
    });
    // /u forwards this POSIX value Windows -> WSL without translating it again.
    // Override only the child's TF_DATA_DIR; never change the caller's caches.
    const wslEnv = (process.env.WSLENV ?? '').split(':')
      .filter((entry) => entry && entry.split('/')[0] !== 'TF_DATA_DIR');
    wslEnv.push('TF_DATA_DIR/u');
    return run('wsl.exe', ['--distribution', 'Ubuntu', '--exec', 'terraform', ...argv], {
      ...options,
      cwd: repoRoot,
      env: { ...process.env, TF_DATA_DIR: dataDir, WSLENV: wslEnv.join(':') },
    });
  };
}

function configurationPath(path, wsl) {
  // An absolute POSIX path refers to a file inside Ubuntu, not C:\home\...
  return wsl && path.startsWith('/') ? path : resolve(repoRoot, path);
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function parseDeploymentOutput(text) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('Terraform deployment output must be valid JSON.'); }
  if (!value || value.schema_version !== 1 || typeof value.runtime_enabled !== 'boolean') {
    throw new Error('Unsupported Terraform deployment output schema.');
  }
  const fields = [
    'subscription_id', 'tenant_id', 'resource_group_name', 'acr_name', 'acr_login_server',
    'container_app_name', 'container_name', 'container_app_url', 'bot_id',
    'bot_application_object_id', 'bot_service_principal_id', 'bot_domain', 'bot_endpoint',
    'runtime_identity_id', 'runtime_identity_client_id', 'key_vault_name', 'key_vault_uri',
    'cosmos_endpoint', 'cosmos_database', 'cosmos_container',
  ];
  const output = { schema_version: 1, runtime_enabled: value.runtime_enabled };
  for (const field of fields) {
    if (typeof value[field] !== 'string' || !value[field] || /[\0\r\n]/.test(value[field])) {
      throw new Error(`Invalid or missing deployment field: ${field}`);
    }
    output[field] = value[field];
  }
  for (const field of ['subscription_id', 'tenant_id', 'bot_id', 'bot_application_object_id', 'bot_service_principal_id', 'runtime_identity_client_id']) {
    if (!uuid.test(output[field])) throw new Error(`Invalid UUID: ${field}`);
  }
  if (!/^[a-z0-9]{5,50}$/.test(output.acr_name) || output.acr_login_server !== `${output.acr_name}.azurecr.io`) {
    throw new Error('Invalid Azure Container Registry output.');
  }
  for (const field of ['resource_group_name', 'container_app_name', 'container_name', 'key_vault_name']) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._()-]{0,89}$/.test(output[field])) throw new Error(`Invalid resource name: ${field}`);
  }
  if (!/^[a-z0-9.-]+\.azurecontainerapps\.io$/.test(output.bot_domain)
    || output.container_app_url !== `https://${output.bot_domain}`
    || output.bot_endpoint !== `${output.container_app_url}/api/messages`) {
    throw new Error('Invalid public ACA endpoint.');
  }
  if (output.key_vault_uri !== `https://${output.key_vault_name}.vault.azure.net/`
    || !/^https:\/\/[a-z0-9-]+\.documents\.azure\.com:443\/$/.test(output.cosmos_endpoint)
    || output.cosmos_database !== 'teams-agent' || output.cosmos_container !== 'conversations') {
    throw new Error('Invalid Key Vault or Cosmos output.');
  }
  const identityPrefix = `/subscriptions/${output.subscription_id}/resourceGroups/${output.resource_group_name}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/`;
  if (!output.runtime_identity_id.startsWith(identityPrefix)
    || !/^[a-zA-Z0-9_-]+$/.test(output.runtime_identity_id.slice(identityPrefix.length))) {
    throw new Error('Runtime identity does not belong to the output subscription/resource group.');
  }
  return output; // Unknown fields, including any accidental secrets, are dropped.
}

export function readDeployment(run = runCommand) {
  return parseDeploymentOutput(run('terraform', ['-chdir=infra', 'output', '-json', 'deployment'], { capture: true }));
}

export function provision(args = process.argv.slice(2), { run = runCommand, log = console.log } = {}) {
  const flags = parseFlags(args, ['--apply', '--init', '--help', '--wsl'], ['--backend-config', '--var-file', '--wsl-data-dir']);
  if (flags['--help']) {
    log('provision.mjs [--wsl [--wsl-data-dir /absolute/posix/path]] [--init --backend-config PATH] [--var-file PATH] [--apply]\nDefault: plan only. --apply runs interactive Terraform apply (no auto-approve). --wsl runs Terraform in Ubuntu with a separate data directory.');
    return;
  }
  if (flags['--backend-config'] && !flags['--init']) throw new Error('--backend-config requires --init.');
  if (flags['--init'] && !flags['--backend-config']) throw new Error('--init requires an explicit --backend-config file.');
  // Terraform appends TF_CLI_ARGS to our argv; reject hidden approval/destroy/
  // target flags rather than pretending this wrapper's safety gate still holds.
  for (const key of Object.keys(process.env)) {
    if (/^TF_CLI_ARGS(?:_|$)/.test(key) && process.env[key]) throw new Error('Unset TF_CLI_ARGS* before using guarded provisioning.');
  }
  const execute = terraformRunner(flags, run);
  if (flags['--init']) {
    execute('terraform', ['-chdir=infra', 'init', `-backend-config=${configurationPath(flags['--backend-config'], flags['--wsl'])}`]);
  }
  execute('terraform', ['-chdir=infra', 'validate']);
  const config = flags['--var-file'] ? [`-var-file=${configurationPath(flags['--var-file'], flags['--wsl'])}`] : [];
  execute('terraform', ['-chdir=infra', 'plan', '-detailed-exitcode', ...config], { allowedStatuses: [0, 2] });
  if (!flags['--apply']) {
    log('Plan only. No resources changed. Apply requires --apply and Terraform interactive approval.');
    return;
  }
  execute('terraform', ['-chdir=infra', 'apply', ...config]);
  log('Infrastructure applied. Bootstrap is not a ready agent; complete the staged workflow in infra/README.md.');
}

export function isMain(metaUrl) {
  return Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(metaUrl);
}

if (isMain(import.meta.url)) {
  try { provision(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
