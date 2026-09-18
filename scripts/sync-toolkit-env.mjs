import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isMain, parseFlags, readDeployment, repoRoot, runCommand, terraformRunner } from './provision.mjs';

export const toolkitAllowlist = Object.freeze({
  AZURE_SUBSCRIPTION_ID: 'subscription_id',
  AZURE_TENANT_ID: 'tenant_id',
  AZURE_RESOURCE_GROUP_NAME: 'resource_group_name',
  BOT_ID: 'bot_id',
  BOT_AAD_APP_OBJECT_ID: 'bot_application_object_id',
  BOT_DOMAIN: 'bot_domain',
  BOT_ENDPOINT: 'bot_endpoint',
  BOT_TENANT_ID: 'tenant_id',
  CONTAINER_APP_NAME: 'container_app_name',
  CONTAINER_APP_URL: 'container_app_url',
  ACR_NAME: 'acr_name',
  ACR_LOGIN_SERVER: 'acr_login_server',
  AZURE_CLIENT_ID: 'runtime_identity_client_id',
  COSMOS_ENDPOINT: 'cosmos_endpoint',
  COSMOS_DATABASE: 'cosmos_database',
  COSMOS_CONTAINER: 'cosmos_container',
});

export function dotenvQuote(value) {
  if (typeof value !== 'string' || /[\0\r\n]/.test(value)) throw new Error('Dotenv values must be single-line strings.');
  // Standard dotenv has no general backslash escaping for quotes. Select a
  // delimiter that is absent, preserving URL/backslash/hash values literally.
  for (const quote of ['"', "'", '`']) if (!value.includes(quote)) return `${quote}${value}${quote}`;
  throw new Error('Dotenv value contains every supported quote delimiter.');
}

export function mergeToolkitEnv(existing, output) {
  const updates = new Map(Object.entries(toolkitAllowlist).map(([key, field]) => [key, dotenvQuote(output[field])]));
  const seen = new Set();
  const lines = existing.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const merged = [];
  // Leave unknown keys, comments, local credentials and Teams IDs untouched.
  // Remove duplicate managed keys; do not reinterpret multiline unknown values.
  let quoteOpen = null;
  for (const line of lines) {
    if (quoteOpen) {
      merged.push(line);
      if (line.includes(quoteOpen)) quoteOpen = null;
      continue;
    }
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match || !updates.has(match[1])) {
      merged.push(line);
      if (match && /^["'`]/.test(match[2]) && !match[2].slice(1).includes(match[2][0])) quoteOpen = match[2][0];
      continue;
    }
    const key = match[1];
    if (!seen.has(key)) merged.push(`${key}=${updates.get(key)}`);
    seen.add(key);
    if (/^["'`]/.test(match[2]) && !match[2].slice(1).includes(match[2][0])) {
      throw new Error(`Refusing to replace multiline managed variable: ${key}`);
    }
  }
  if (quoteOpen) throw new Error('Existing dotenv file has an unterminated quoted value.');
  for (const [key, value] of updates) if (!seen.has(key)) merged.push(`${key}=${value}`);
  return `${merged.join('\n')}\n`;
}

export function syncToolkitEnv(args = process.argv.slice(2), { run = runCommand, log = console.log } = {}) {
  const flags = parseFlags(args, ['--help', '--wsl'], ['--wsl-data-dir']);
  if (flags['--help']) {
    log('sync-toolkit-env.mjs [--wsl [--wsl-data-dir /absolute/posix/path]]\nReads only Terraform deployment output; updates allowlisted nonsecret values in ignored env/.env.dev.');
    return;
  }
  const execute = terraformRunner(flags, run);
  // Fail closed if the parent repository has not yet installed ignore rules.
  run('git', ['check-ignore', '--quiet', '--', 'env/.env.dev'], { capture: true });
  const tracked = run('git', ['ls-files', '--', 'env/.env.dev'], { capture: true });
  if (tracked.trim()) throw new Error('env/.env.dev is tracked; refusing to write environment configuration.');
  const output = readDeployment(execute);
  const destination = join(repoRoot, 'env', '.env.dev');
  if ((existsSync(dirname(destination)) && lstatSync(dirname(destination)).isSymbolicLink())
    || (existsSync(destination) && lstatSync(destination).isSymbolicLink())) throw new Error('Refusing symlink environment destination.');
  const existing = existsSync(destination) ? readFileSync(destination, 'utf8') : '';
  const merged = mergeToolkitEnv(existing, output);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, merged, { encoding: 'utf8', mode: 0o600 });
  log('Updated nonsecret Terraform values in env/.env.dev; preserved other environment variables. No identity registration performed.');
}

if (isMain(import.meta.url)) {
  try { syncToolkitEnv(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
