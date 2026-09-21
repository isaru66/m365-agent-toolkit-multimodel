# Teams multi-model agent

A TypeScript **custom-engine agent** for personal Microsoft Teams chats, hosted
on **Azure Container Apps (ACA)**. Choose Claude, Gemini, or Azure OpenAI through
independently configured inference endpoints. Microsoft 365 Agents Toolkit
handles local development and app packaging; the Teams SDK handles bot activity
authentication and native response streaming.

This is not a declarative Copilot agent. The current scope is text-only, 1:1 chat
in one tenant: no attachments, RAG, tools, group chats, or channel chats.
The bot does not call Microsoft Graph on behalf of users.

- Explicit provider selection, with no automatic provider fallback.
- Separate recent histories per provider, native streaming, Stop, and reset.
- Production authentication, Key Vault secret references, managed identity,
  and Cosmos-backed state, leases, and duplicate suppression.
- Public HTTPS information pages, not a public anonymous chat endpoint.

## Start here

| Goal | Guide |
| --- | --- |
| Try the conversation flow without credentials or model charges | [Local mock quickstart](#local-mock-quickstart) |
| Call real models from local Playground | [Live providers](#live-providers) |
| Provision or release to Azure | [ACA deployment and operations](#aca-deployment-and-operations) |
| Build and install a personal Teams app | [Teams packaging and installation](#teams-packaging-and-installation) |
| Inspect this repository's existing pilot | [Pilot status](#pilot-status-as-of-2026-09-21) |

## Local mock quickstart

Prerequisite: **Node.js >=22.12.0 and <23**, with npm. Run commands from the
repository root; shell examples use PowerShell.

```powershell
npm ci
if (-not (Test-Path -LiteralPath '.env')) {
  Copy-Item -LiteralPath '.env.example' -Destination '.env'
}
```

The template defaults to mocks. If `.env` already exists, preserve its keys and
other settings, but set these values for credential-free local testing:

```dotenv
NODE_ENV=development
LOCAL_PLAYGROUND=true
ALLOW_LOCAL_LIVE_PROVIDERS=false
PROVIDER_MODE=mock
STATE_STORE=memory
ENABLED_PROVIDERS=claude,gemini
PORT=3978
```

Start the bot, then Playground in a **second terminal**:

```powershell
# Terminal 1
npm run dev
```

```powershell
# Terminal 2
npm run playground
```

Open the URL printed by Playground, normally `http://localhost:56150`. Send
`help`, `model claude`, then `Hello`. Responses are simulated; no provider
credentials, Azure resources, or paid inference are needed. Stop both processes
with Ctrl+C. Restarting the bot clears in-memory history.

Playground simulates Teams and targets `http://127.0.0.1:3978/api/messages`;
its telemetry is disabled. `npm run playground` fixes that port at 3978.
If you change the bot port, invoke the installed CLI directly with a matching
endpoint rather than appending a duplicate flag to the npm script:

```powershell
npx --no-install agentsplayground --disable-telemetry --channel-id msteams --app-endpoint http://127.0.0.1:3979/api/messages
```

Local Playground bypasses bot authentication, binds to loopback, and accepts
only loopback callback URLs. **Never expose it through a public tunnel or proxy.**
It is not proof that a real Teams installation works.

## Live providers

Real inference is opt-in and billable. In the ignored root `.env`, change the
local settings to:

```dotenv
NODE_ENV=development
LOCAL_PLAYGROUND=true
ALLOW_LOCAL_LIVE_PROVIDERS=true
PROVIDER_MODE=live
STATE_STORE=memory
ENABLED_PROVIDERS=claude,gemini,azure-openai
```

Each enabled provider requires its own **key, inference base, and accessible
model/deployment name**. Enable only the providers you have configured.
Use these route shapes, replacing `YOUR-RESOURCE` and model names with verified
values; never commit real credentials:

| Provider | Base URL variable and example | Credential | Model/deployment |
| --- | --- | --- | --- |
| Claude on Azure | `ANTHROPIC_BASE_URL=https://YOUR-RESOURCE.services.ai.azure.com/anthropic` | `ANTHROPIC_API_KEY` | `CLAUDE_MODEL` |
| Gemini Developer API | `GEMINI_BASE_URL=https://generativelanguage.googleapis.com` | `GEMINI_API_KEY` | `GEMINI_MODEL` (without `models/`) |
| Azure OpenAI v1 | `AZURE_OPENAI_BASE_URL=https://YOUR-RESOURCE.services.ai.azure.com/openai/v1` | `AZURE_OPENAI_API_KEY` | `AZURE_OPENAI_DEPLOYMENT` |

Claude is not hard-coded to Opus: the configured deployment determines the model.
Verify access to the intended Opus deployment if you want Opus. A Foundry
`/api/projects/...` URL is a **project endpoint**, not an inference base.
Do not append request routes such as `/messages` or `/chat/completions` to these
bases. Use HTTPS and omit trailing slashes when sharing values with HTTP fixtures.

The app uses provider-native API-key authentication. Its Gemini adapter uses the
**Developer API**, not project-based Vertex AI/OAuth. Selecting Gemini does not
deploy a Google model. Verify model access, billing, and quota in the relevant
provider account; a successful model-list request does not prove generation works.

Restart `npm run dev`, keep Playground running separately, and select the desired
provider before sending a prompt. In VS Code, restart **Debug local agent (.env)**.
Both local entry points load the saved `.env` **over inherited shell variables**,
so stale shell keys do not take precedence. Saving `.env` alone does not update
credentials inside an already-running process.

To return to mocks, set `PROVIDER_MODE=mock` and
`ALLOW_LOCAL_LIVE_PROVIDERS=false`, then restart. Production rejects the local
live opt-in and the Playground authentication bypass.

### Manual provider requests

The [HTTP guide](tests/http/README.md#provider-api-checks) covers VS Code REST
Client requests in `tests\http`: `anthropic.http`, `gemini.http`, and
`azure-openai.http`. `gemini-vertex.http` is a separate Vertex OAuth fixture,
not runtime configuration.

REST Client searches upward for the nearest `.env`; do not add a nested dotenv
file that shadows the root one. **Send Request calls the provider regardless of
`PROVIDER_MODE` or `ENABLED_PROVIDERS`** and generation can incur charges.
Do not batch or automatically retry paid prompts.

## Chat commands and limits

| Input | Behavior |
| --- | --- |
| `help` | Show the model chooser, limitations, and processing notice |
| `model` | Show the current selection, if any, and available providers |
| `model claude` | Select the configured Claude deployment |
| `model gemini` | Select the configured Gemini model |
| `model azure-openai` | Select the configured Azure OpenAI deployment |
| `reset` | Clear all app-held provider histories and selection for this conversation |
| Other text | Prompt the selected provider using only its unexpired history |

Select a model before prompting. Only enabled providers can be selected.
Switching providers resumes that provider's history; changing models is refused
while a response is active. Reset invalidates the active lease so a late answer
cannot be saved into the reset conversation.

Answers stream through Teams' authenticated conversation API, not a browser SSE
endpoint. Updates are normally buffered at 1.8-second intervals. Only answer text
is forwarded, not provider thinking blocks. Use the **Teams Stop button**, not a
text `stop` command.

Defaults are a 90-second generation deadline, 2,048 output tokens, and a fixed
24,000-byte UTF-8 answer ceiling. Native streaming is bounded to fit Teams'
two-minute stream lifetime. Limited, cancelled, failed, or incomplete replies
are excluded from reusable history, even if some text was already displayed.
See [configuration](#configuration-reference) for adjustable limits.

Stop is detected through a Teams response to an outbound update; it is not an
instantaneous provider-side cancellation guarantee. A stopped bubble is not
overwritten; an incomplete notice is sent separately. Gemini may continue
server-side work after the app stops reading. **Already-generated, reasoning,
and input tokens can still be billed.** Response limits are not spending caps;
use provider budgets and quota alerts.

## Configuration reference

These three configuration surfaces have different purposes:

| Surface | Purpose |
| --- | --- |
| Root `.env` (ignored) | Local bot/debugger and manual provider HTTP requests; template: [`.env.example`](.env.example) |
| `env\.env.dev` (ignored) | Teams package IDs, bot domain, publisher name, and website/privacy/terms URLs; template: [`env/.env.dev.example`](env/.env.dev.example) |
| ACA environment and Key Vault | Production runtime settings and secrets; production `npm start` does not load root `.env` |

| Variable | Meaning / default |
| --- | --- |
| `NODE_ENV` | `production` enforces authenticated Teams, Cosmos, and live providers |
| `LOCAL_PLAYGROUND` | Explicit local-only authentication bypass; false outside local Playground |
| `ALLOW_LOCAL_LIVE_PROVIDERS` | Additional opt-in for billable local Playground; invalid if true in production or outside Playground |
| `PROVIDER_MODE`, `STATE_STORE` | `mock` / `memory` for the local quickstart; `live` / `cosmos` required in production |
| `PORT` | `3978`; update the Playground target if changed |
| `CLIENT_ID`, `CLIENT_SECRET`, `TENANT_ID` | Single-tenant bot identity, required outside local Playground |
| `ENABLED_PROVIDERS` | Unique comma-separated provider IDs; if absent, defaults to `claude,gemini` |
| Provider base/key/model variables | See [live providers](#live-providers); required only for enabled live providers |
| `COSMOS_ENDPOINT` | HTTPS endpoint, required when using Cosmos |
| `COSMOS_DATABASE`, `COSMOS_CONTAINER` | `teams-agent`, `conversations` |
| `AZURE_CLIENT_ID` | Azure managed identity client ID; **not** the bot client ID |
| `MAX_OUTPUT_TOKENS` | `2048`; range 1-8192 |
| `MAX_INPUT_CHARS` | `12000`; prompts must also fit the context byte budget |
| `MAX_CONTEXT_BYTES` | `80000`; conservative UTF-8 budget, not a tokenizer count |
| `STREAM_TIMEOUT_MS` | `90000`; range 1000-100000 |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | Enables sanitized operational telemetry |

Missing enabled-provider settings and empty, duplicate, or unknown provider
lists fail startup; they never silently disable a provider or select another one.
Base URLs cannot contain credentials, query/fragment components, or a Foundry
project path. Older history is omitted as needed to fit the context budget.

For authenticated development against real Teams, use
`LOCAL_PLAYGROUND=false`, `ALLOW_LOCAL_LIVE_PROVIDERS=false`, bot credentials,
and an approved HTTPS development endpoint. Cosmos testing uses your configured
Azure identity. Never expose the unauthenticated Playground mode for that purpose.

## ACA deployment and operations

The [infrastructure guide](infra/README.md) covers provisioning, remote state,
runtime activation, secret entry, identity/RBAC, releases, and rollback.
For a **new deployment**, follow that guide's approval gates: choose the target,
initialize the backend, review/apply Terraform, populate Key Vault outside
Terraform, and activate the real runtime. The initial bootstrap image is not a
working bot. Do not rerun initial provisioning just to package an existing bot.

Terraform owns resources, identities, runtime configuration, secret references,
probes, and scale. The release script owns the image and registry attachment.
Secrets must not be stored as values in Terraform or uploaded in build context.
The pilot uses one warm ACA replica with a maximum of three.

On this Windows workflow, run Terraform in **Ubuntu WSL** using the existing
`.terraform-wsl` data directory. The Node wrappers' `--wsl` flag affects Terraform,
not Azure release commands: Windows and WSL Azure login contexts are separate.
Use the same backend/data directory consistently; do not copy credential caches.

After the infrastructure is initialized and runtime enabled:

```powershell
# Read current deployment and probe health; does not build, deploy, or invoke models.
node scripts\deploy.mjs --wsl --deploy --verify-only

# Reads Terraform outputs and updates nonsecret metadata in ignored env\.env.dev.
node scripts\sync-toolkit-env.mjs --wsl
```

An actual release is a separate, approved, state-changing operation:

```powershell
# Uploads the Docker-filtered source to ACR, builds, and changes the ACA image.
node scripts\deploy.mjs --wsl --deploy
```

Review the source upload and `.dockerignore` before release. Keep local secrets,
state, and unrelated assets excluded. Record the previous image for rollback.

| Endpoint | Expected production behavior |
| --- | --- |
| `/`, `/privacy`, `/terms` | Public pilot information pages |
| `/healthz` | HTTP 200 with `status=healthy`, not `status=bootstrap` |
| `/readyz` | HTTP 200 with `status=ready` once startup is complete and turns are accepted |
| `/api/messages` without a valid token | HTTP 401; not a direct provider chat API |

Readiness includes startup's Cosmos container check; it does not continuously
test model billing, provider access, or Teams reply delivery. Do not disable bot
authentication to diagnose a failed request. Public information-page content is
in `src\http\pilot-pages.ts`; review publisher and privacy/terms text before
reusing or publishing it for another deployment.

## Teams packaging and installation

### 1. Prepare the package metadata

Use an existing Azure Bot with its Teams channel enabled and messaging endpoint
set to your ACA HTTPS `/api/messages`. Reuse its Entra identity; do not create a
second bot just to install the Teams app.

Create `env\.env.dev` from its template only if it does not already exist:

```powershell
if (-not (Test-Path -LiteralPath 'env\.env.dev')) {
  Copy-Item -LiteralPath 'env\.env.dev.example' -Destination 'env\.env.dev'
}
```

**Only for a bot managed by this Terraform root**, synchronize its metadata:

```powershell
node scripts\sync-toolkit-env.mjs --wsl
```

This requires initialized Terraform and backend access; it is not an offline
packaging step. It overwrites managed fields including `BOT_ID`, `BOT_DOMAIN`,
`BOT_ENDPOINT`, and `AZURE_CLIENT_ID` from Terraform outputs. For a bot managed
elsewhere, skip synchronization and enter its package metadata manually.

Set or verify these nonsecret fields locally:

| Field | Value |
| --- | --- |
| `TEAMS_APP_ID` | A stable UUID for the **Teams package**, distinct from `BOT_ID`; generate once for a new sideload app, preserve for updates |
| `BOT_ID` | Existing bot's Entra application/client ID |
| `BOT_DOMAIN` | ACA hostname without scheme or path |
| `DEVELOPER_NAME` | Approved publisher name |
| `WEBSITE_URL`, `PRIVACY_URL`, `TERMS_URL` | Approved, working HTTPS pages; never leave example URLs |

Generate a UUID with `[guid]::NewGuid().ToString()` only when no existing Teams app
ID should be reused. Setting this value does **not** register an Entra app or a
Developer Portal record. No API keys or bot client secrets belong in the ZIP.

### 2. Build and validate the personal package

Building locally does **not** require Toolkit sign-in or tenant-wide publication:

```powershell
node .\node_modules\@microsoft\m365agentstoolkit-cli\cli.js package --env dev --env-file env\.env.dev --output-package-file appPackage\build\appPackage.dev.zip --telemetry false
```

Use `appPackage\build\appPackage.dev.zip`, **not** `appPackage.test.zip`.
Generated packages and local metadata are not supplied by a fresh clone.
Check the actual ZIP: resolved manifest values, correct app/bot IDs, personal
scope, working URLs, 192x192 color icon, and 32x32 white-on-transparent outline.
It should contain `manifest.json`, `color.png`, and `outline.png` at its root.
Validate against the manifest's published Microsoft schema before installation.

For Toolkit validation, use:

```powershell
node .\node_modules\@microsoft\m365agentstoolkit-cli\cli.js validate --package-file appPackage\build\appPackage.dev.zip --validate-method validation-rules --telemetry false
```

A validator failure is not a successful validation. If the CLI crashes, retain
the error and use schema/package inspection as partial evidence; real Teams
installation and conversation checks remain necessary.

### 3. Install and exercise the bot

Sign into Teams with a **native member account in the bot's tenant**, with core
Teams access and permission to upload custom apps. Guests cannot browse/add apps
from the Teams store even when upload policies are enabled. A "no Teams" license
does not provide the core Teams entitlement; check the user's actual assigned
service plans. Azure subscription access does not establish Teams app permissions.

In Teams, select **Apps > Manage your apps > Upload an app > Upload a custom app**,
choose the development ZIP, and add it for personal use. Open the bot and send
`help`, then `model`. There is no automatic welcome message on installation.
Try a short nonsensitive prompt with each enabled provider, then streaming,
Stop, reset, and separate context. Model requests are billable.

Manual upload does not require Toolkit authentication. The optional
Toolkit-managed lifecycle in `m365agents.yml` is different:

- `provision` verifies the ACA runtime, creates/updates the Teams app registration,
  packages, and validates; synchronize metadata before invoking it. Its
  `teamsApp/create` action writes `TEAMS_APP_ID` back to `env\.env.dev`. An
  unregistered sideload UUID can be replaced with a new registration ID, so the
  next package would install as a different app rather than update the original.
  Preserve the existing ID and import the sideload package into Developer Portal
  before adopting this workflow if update continuity is required.
- `deploy` builds and releases the application to ACA.
- `publish` submits the package to tenant administrators.

Those lifecycle stages are not routine offline checks. If moving an existing
sideload app into Developer Portal management, import its package; do not assume
the locally generated app ID is already registered. Tenant-wide distribution
needs separate approval.

## Troubleshooting

| Symptom | Check first |
| --- | --- |
| Apps or custom upload is missing | Correct tenant, native member versus guest identity, enabled Teams service, and effective app policy; do not widen global policy blindly |
| HTTP fixture works but the local bot fails | Saved root `.env`, correct provider mode/base/model, then restart dev/debugger; do not dump keys |
| Gemini returns 404 or billing/quota errors | Correct Developer API model ID and endpoint, key restrictions, account billing and quota; Vertex fixture credentials are separate |
| Direct ACA request returns 401 | Expected without a valid inbound token; use Teams, not a provider key or bot secret, to test the conversation |
| Installed app is silent | Send `help`; verify packaged bot ID, Teams channel, endpoint, tenant and sanitized backend logs before blaming a model |
| Answer is incomplete | Output/context limits, timeout, cancellation, upstream error or delivery; try a shorter prompt and inspect sanitized reason codes |

## Data handling and operational boundaries

Prompts and the selected provider's recent history go to that provider's configured
endpoint. Confirm organizational approval and provider account retention,
training, and residency terms; this app does not override them.

Each completed exchange expires logically after 24 hours, with at most 20 retained
per provider. Cosmos physical TTL cleanup is eventual. Reset clears app-held
history and selection for the conversation, **not Teams messages or
provider-retained copies**. Start fresh before changing an endpoint across data
boundaries; isolation is by provider ID, not hostname.

The SDK authenticates before dispatch, then the app checks tenant, Teams channel,
personal scope, and user identity. The public information pages and probes do not
grant chat access. Application logs omit prompt bodies, keys, authorization
headers, and raw SDK payloads; telemetry contains sanitized operational fields.

Production state is Cosmos-backed with no memory fallback on failure. Leases and
bounded duplicate suppression coordinate replicas; shutdown aborts/drains tracked
work. This is not a durable background-job queue or indefinite exactly-once
delivery. The admission cap is 32 tracked turns per replica, and HTTP autoscaling
does not measure full generation duration. See [state details](src/state/README.md)
before changing persistence, concurrency, or scale.

## Development checks

```powershell
npm run check
npm run build

# Optional local container build; requires a running Docker engine.
docker build --tag teams-multimodel-agent:local .
```

Tests use mocks and an in-process connector, including real SDK authentication
and streaming paths; they do not create Azure resources or call paid models.
The commands above are developer checks, not a claim that the current full suite
has passed. Terraform validation and live release checks are documented in the
[infrastructure guide](infra/README.md); they require appropriate tools and,
for plan/backend operations, Azure access.

## Pilot status as of 2026-09-21

This is a **dated record of the existing pilot**, not defaults for a new deployment.
See [deployment evidence](.azure/deployment-plan.md) for release details.

| Area | Last recorded outcome |
| --- | --- |
| ACA | Revision `tmma79e118-app--0000005`, healthy/ready, 100% traffic in Southeast Asia |
| Enabled providers | Claude `claude-sonnet-5`, Gemini `gemini-3.8-flash` (Developer API), Azure OpenAI `gpt-5.6-luna` |
| Public pages | Approved isaru66 content deployed; [website](https://tmma79e118-app.blackdesert-f956b6ef.southeastasia.azurecontainerapps.io), [privacy](https://tmma79e118-app.blackdesert-f956b6ef.southeastasia.azurecontainerapps.io/privacy), [terms](https://tmma79e118-app.blackdesert-f956b6ef.southeastasia.azurecontainerapps.io/terms) |
| Authentication | Missing/invalid tokens rejected with HTTP 401; production local bypass remains disabled |
| Teams ZIP | `appPackage\build\appPackage.dev.zip` built locally; Microsoft v1.27 schema, contents, icons, IDs and live URLs checked independently |
| Toolkit validation | Validation-rules command crashed on this workstation; no successful Toolkit online validation or Store certification claimed |
| Teams installation/chat | **Not yet verified**; requires the pilot member to sign in, install, and exercise the bot |

Enabled provider configuration and healthy probes alone do not prove successful
inference from ACA or end-to-end Teams delivery. Nothing has been published to the
tenant catalog as part of this pilot.

## References

- [Microsoft 365 Agents Toolkit](https://learn.microsoft.com/en-us/microsoftteams/platform/toolkit/overview-agents-toolkit)
- [Upload a custom Teams app](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/deploy-and-publish/apps-upload)
- [Teams apps for guest and external users](https://learn.microsoft.com/en-us/microsoftteams/apps-external-users)
- [Teams native streaming](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/streaming-ux)
- [Anthropic streaming](https://platform.claude.com/docs/en/build-with-claude/streaming)
- [Google GenAI SDK](https://ai.google.dev/gemini-api/docs/libraries)
