# Teams multi-model agent

A TypeScript **custom-engine agent** developed with Microsoft 365 Agents Toolkit.
It runs in **Azure Container Apps (ACA)** and calls **Claude on Azure**, **Gemini**,
or **Azure OpenAI** through independently configured inference endpoints and
standard native API-key authentication. All Terraform is in [`infra`](infra).

## Included

- Personal 1:1 Teams chat in one Microsoft 365 tenant.
- Explicit model selection by card or command, with no automatic provider fallback.
- Native Teams streaming, including the built-in Stop button.
- Separate model histories: the latest 20 completed exchanges, expiring after
  24 hours, with a reset command.
- Cosmos-backed leases and duplicate suppression for multiple ACA replicas.
- Authenticated Teams requests over public HTTPS, Key Vault secret references,
  managed identity for Azure services, and redacted operational telemetry.
- One warm ACA replica, up to three; provisioning is separate from image release.

This is not a declarative Copilot agent. Agents Toolkit handles local development,
Teams registration, and packaging; the Teams SDK handles the bot protocol, and the
application selects the model. No Microsoft Graph permissions, document upload,
tools, RAG, group chats, or channel chats are implemented.

**The ACA API is active with Claude, Gemini, and Azure OpenAI enabled.**
Gemini uses `gemini-3.8-flash` through the Gemini Developer API with its key
referenced from Key Vault. The current healthy revision is
`tmma79e118-app--0000005` (2026-09-21). The approved pilot
[website](https://tmma79e118-app.blackdesert-f956b6ef.southeastasia.azurecontainerapps.io),
[privacy notice](https://tmma79e118-app.blackdesert-f956b6ef.southeastasia.azurecontainerapps.io/privacy),
and [terms](https://tmma79e118-app.blackdesert-f956b6ef.southeastasia.azurecontainerapps.io/terms)
are publicly available. Bot messages remain authenticated. The application health endpoint is
https://tmma79e118-app.blackdesert-f956b6ef.southeastasia.azurecontainerapps.io/healthz.
Terraform state is stored in Azure Blob Storage with separate bootstrap and main
keys. Teams installation/publication and end-to-end Teams conversations have not
been verified by this deployment; tenant app-upload policy still applies.

Manual Claude/Gemini/Azure OpenAI API requests are in [tests/http](tests/http/README.md).
They use VS Code REST Client and the same ignored root `.env` as the local app;
generation requests are opt-in and can incur provider charges.
The Gemini HTTP file uses the same Gemini Developer API/key as the application.
Separate `gemini-vertex.http` requests use project-based Vertex AI/OAuth.
See the HTTP setup for the separate Vertex settings.

## Local development without credentials

Use Node.js 22.12 or newer in the Node 22 LTS line.

```powershell
npm ci
if (-not (Test-Path -LiteralPath '.env')) {
  Copy-Item -LiteralPath '.env.example' -Destination '.env'
}
npm run dev
```

In a second terminal:

```powershell
npm run playground
```

This follows the quickstart's two-terminal workflow: `npm run dev` runs the bot;
`npm run playground` starts Microsoft 365 Agents Playground, opens its browser
UI (normally `http://localhost:56150`), and connects to
`http://127.0.0.1:3978/api/messages` using the Teams simulation. Playground
telemetry is disabled. The installed package provides both `agentsplayground`
and the quickstart's `teamsapptester` command; no additional package is needed.

If your existing `.env` is configured for live or production use, first set
`NODE_ENV=development`, `LOCAL_PLAYGROUND=true`, `PROVIDER_MODE=mock`, and
`STATE_STORE=memory` for mock local testing. Do not change production ACA settings.
Send `help`, then `model claude` (or another enabled provider), then `Hello`.
The response is a mock, not a paid model call. Stop both terminals with Ctrl+C.

If you change the bot's `PORT` in the root `.env`, pass the matching endpoint:

```powershell
npm run playground -- --app-endpoint http://127.0.0.1:3979/api/messages
```

Open the local URL printed by Agents Playground if it does not open automatically.
If port 56150 is occupied, Playground may choose another port. In VS Code, install the
recommended **Microsoft 365 Agents Toolkit** extension and use the included debug
configuration or tasks. The project was initialized from the Toolkit blank-app
scaffold and customized for the current Teams SDK rather than importing an
OpenAI-specific sample runtime.

The sample environment enables **mock providers**, in-memory state, and an
explicit local-only authentication bypass. The server binds to loopback in this
mode, accepts only loopback callback URLs, and requires explicit opt-in for live providers. Never put
this mode behind a public tunnel. Local process restarts clear in-memory history.

### Local Playground with real models

To make billable model calls from Playground, configure the ignored root `.env`:

```dotenv
NODE_ENV=development
LOCAL_PLAYGROUND=true
ALLOW_LOCAL_LIVE_PROVIDERS=true
PROVIDER_MODE=live
STATE_STORE=memory
ENABLED_PROVIDERS=claude,azure-openai
```

Keep each enabled provider's API key, inference base URL, and model/deployment
settings populated. Restart `npm run dev` after changing `.env`; run
`npm run playground` in a second terminal, then send `model claude` or
`model azure-openai` followed by a prompt. No bot identity is needed locally.
For VS Code debugging, stop the current session and start **Debug local agent (.env)**.
Both local entry points preload the saved root `.env` over inherited environment
values, including stale API keys in the shell or VS Code process.
Editing `.env` does not replace credentials already held by a running bot.
Prompts and recent history are sent to the selected endpoint and incur charges.
Gemini can also be enabled with its Developer API configuration; the Vertex OAuth
settings used by the manual HTTP fixture do not configure the runtime adapter.

This opt-in does not enable authentication: loopback binding and callback
restrictions remain enforced. Use only on a trusted development machine, never
through a tunnel or public proxy. Production rejects this opt-in. To return to
mock responses, set `PROVIDER_MODE=mock` and `ALLOW_LOCAL_LIVE_PROVIDERS=false`
and restart the bot.

### Shared configuration and authenticated development

Keep local configuration in the root `.env` only. `npm run dev` and the VS Code
debugger load it explicitly; REST Client's `{{$dotenv NAME}}` searches up from
`tests\http` to find it. Do not create a nested `.env` that would shadow it.
HTTP requests call the real providers independently of the application's mock
mode. See the [manual test setup](tests/http/README.md) for environment selection
and credential precautions. ACA continues to use injected environment variables
and Key Vault references, not this local file.

For authenticated development against real Teams, configure bot credentials,
tenant ID, enabled providers, explicit inference bases, API keys, and
model/deployment names in your ignored `.env`, set
`LOCAL_PLAYGROUND=false`, `ALLOW_LOCAL_LIVE_PROVIDERS=false`, and
`PROVIDER_MODE=live`. Use an approved bot
registration and HTTPS development endpoint. Set `STATE_STORE=cosmos` to exercise
persistent state using your Azure identity. Do not post credentials in chat or
commit environment files.

## Chat commands

| Input | Behavior |
| --- | --- |
| `help` | Show the model card, limitations, and processing notice |
| `model claude` | Select the configured Claude deployment |
| `model gemini` | Select the configured Gemini model |
| `model azure-openai` | Select the configured Azure OpenAI deployment |
| `model` | Show the selection and model chooser |
| `reset` | Clear all app-held provider histories and model selection |
| Any other text | Send to the selected provider with only its unexpired context |

A model must be selected before a prompt is processed. Only enabled providers
appear in the chooser; disabled providers cannot receive prompts. Switching models resumes
that model's history, not another provider's conversation. Model changes are
refused while a response is active. Reset invalidates the active lease, preventing
late output from being stored; another replica detects that change on renewal.

## Streaming behavior

The server consumes provider streams and sends cumulative native streaming
activities through the Teams SDK's authenticated conversation API. There is no
public browser SSE endpoint and no WebSocket requirement.

Initial status is followed by buffered answer updates, normally every 1.8 seconds.
Only answer text is forwarded; provider thinking blocks are not displayed or
logged. An idle stream sends a periodic update so Teams can report cancellation.

Teams supports streaming in **1:1 chats on desktop, web, and mobile**, with one
stream per chat and a strict **two-minute lifetime**. Generation defaults to
90 seconds, reserving time for final delivery. Output is limited to 2,048 model
tokens and 24,000 UTF-8 answer bytes. Token-, size-, or deadline-limited responses
are marked incomplete rather than saved as complete context.

The app owns the native send loop instead of the SDK's automatic background
stream flush: this makes send errors observable, limits retries to explicit 429
responses, and prevents attempts to overwrite a stopped stream. The protocol,
authentication, and activity types remain the supported Teams APIs.

**Stop and failure:** abort inference when cancellation is detected, preserve
already displayed text, and exclude the unfinished prompt/answer pair from future
context. Teams does not permit editing a user-stopped bubble, so the app sends a
separate incomplete notice. Detection occurs through Teams' cancellation response
to an outbound update; it is not an instantaneous provider-side stop guarantee.
Already-performed generation can still be billed.
For Gemini specifically, cancellation is client-side; Google may continue
server-side generation and billing after the app stops consuming the response.

## Configuration

See [`.env.example`](.env.example). Production requires bot credentials,
`STATE_STORE=cosmos`, `PROVIDER_MODE=live`, and no local auth bypass.

| Variable | Meaning / default |
| --- | --- |
| `CLIENT_ID`, `CLIENT_SECRET`, `TENANT_ID` | Single-tenant bot identity |
| `ENABLED_PROVIDERS` | Comma-separated unique IDs: `claude`, `gemini`, `azure-openai`; absent defaults to `claude,gemini` |
| `ANTHROPIC_BASE_URL` | Explicit Claude inference base; Azure resource root plus `/anthropic` |
| `GEMINI_BASE_URL` | Explicit Gemini API root, e.g. `https://generativelanguage.googleapis.com` |
| `AZURE_OPENAI_BASE_URL` | Explicit Azure OpenAI v1 base: resource root plus `/openai/v1` |
| `CLAUDE_MODEL` | Accessible Claude model/deployment alias; no required `claude-opus-` prefix |
| `GEMINI_MODEL` | Accessible Gemini model ID without `models/` |
| `AZURE_OPENAI_DEPLOYMENT` | Accessible Azure OpenAI deployment name |
| `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `AZURE_OPENAI_API_KEY` | Separate provider credentials, injected through Key Vault in ACA |
| `COSMOS_ENDPOINT` | HTTPS Cosmos endpoint |
| `COSMOS_DATABASE`, `COSMOS_CONTAINER` | `teams-agent`, `conversations` |
| `AZURE_CLIENT_ID` | Managed identity used for Azure data access, not the bot client ID |
| `MAX_OUTPUT_TOKENS` | `2048`, configurable within 1-8192 |
| `MAX_INPUT_CHARS` | `12000` |
| `MAX_CONTEXT_BYTES` | `80000`, conservative UTF-8 budget for prompt and retained exchanges |
| `STREAM_TIMEOUT_MS` | `90000`, at most `100000` |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | Enables sanitized operational telemetry |

Live mode requires a key, explicit base URL, and model/deployment name **only for
enabled providers**. Missing live configuration is a startup error, never a reason
to silently disable a provider or fall back to another endpoint. Existing live
configurations must now supply explicit bases; there is no implicit public
Anthropic or Google destination. Empty, duplicate, and unknown provider IDs are
rejected. Mock Playground stays credential-free and cannot run live clients.

For Claude-only, set `ENABLED_PROVIDERS=claude`; for all three, use
`ENABLED_PROVIDERS=claude,gemini,azure-openai`. Set each enabled provider's three
settings independently. This example illustrates route shapes for the supplied
resource, **not verified live access**:

```dotenv
ENABLED_PROVIDERS=claude
ANTHROPIC_BASE_URL=https://aif-isaru66-mcap.services.ai.azure.com/anthropic
ANTHROPIC_API_KEY=
CLAUDE_MODEL=
GEMINI_BASE_URL=https://generativelanguage.googleapis.com
GEMINI_API_KEY=
GEMINI_MODEL=
AZURE_OPENAI_BASE_URL=https://aif-isaru66-mcap.services.ai.azure.com/openai/v1
AZURE_OPENAI_API_KEY=
AZURE_OPENAI_DEPLOYMENT=
```

The Foundry project URL ending in `/api/projects/proj-default` is **not** an
inference base. Claude appends `/v1/messages`; Gemini appends
`/v1beta/models/{model}:streamGenerateContent?alt=sse`; Azure OpenAI appends
`/chat/completions`. Do not duplicate these segments. Bases must be HTTPS and
contain no credentials, query, fragment, or project path. The runtime normalizes
trailing slashes; omit them in `.env` for literal REST Client substitution.
Authentication is native `x-api-key` plus `anthropic-version` for Claude,
`x-goog-api-key` for Gemini, and `api-key` for Azure OpenAI. No gateway mode,
custom-header mechanism, or provider Entra authentication is included.

Model/deployment names are intentionally not guessed. Claude deployment aliases
do not establish model family: verify the intended Opus deployment in Azure
details if that is the desired model. Model listing is optional and not assured
on Foundry. Confirm access and supported generation limits with your provider
accounts. Choose a context budget below the selected model's actual context
capacity, including room for system instructions and output. Older exchanges are
omitted as necessary, with a visible context-reduction notice. Input-byte budgeting
is conservative, not a promise of an exact provider tokenizer count.

The response-token cap is **not a monetary spending cap**: input, reasoning, and
already-generated cancelled tokens can be billed. Configure provider-side budgets
and quota alerts before wider distribution.

## Azure and Teams deployment

See [`infra/README.md`](infra/README.md) for the Terraform backend, variables,
first-deployment ordering, secure credential setup, release flags, and rollback.

The sequence is:

1. Confirm subscription, region, tenant, permissions, remote-state backend,
   model access, provider data policies, and expected costs.
2. Initialize the Terraform backend and review a plan under `infra`.
3. Explicitly approve/apply provisioning. The first ACA image is a bootstrap,
   **not a functioning agent**.
4. Populate Key Vault secrets outside Terraform and activate the runtime
   configuration according to the infrastructure guide.
5. Explicitly build and deploy the application image, then verify health.
6. Sync non-secret infrastructure outputs, set developer/privacy/terms metadata,
   and use Toolkit to register and package the personal Teams app.
7. Sideload in the approved tenant, verify real model streaming and Stop, then
   separately decide whether to submit to the tenant app catalog.

Terraform owns Azure resources and Entra identity metadata. Toolkit must **not**
create a duplicate bot or Entra application. The release script owns the image
and registry attachment, with narrowly scoped Terraform drift exclusions.
`m365agents.yml` connects Toolkit to the release and output-sync scripts; Azure
provisioning itself remains an explicitly reviewed Terraform operation.

Terraform is run in **Ubuntu WSL**, not with the Windows Terraform executable.
Ubuntu already has Terraform and Azure CLI; use its own Linux provider cache and
Azure login. Do not copy credential caches between Windows and WSL. The
[deployment plan](.azure/deployment-plan.md) includes the assistant-run apply
sequence. Subscription, region, backend, and the saved plan's resource changes
must be confirmed before any apply; no cloud resources have been created.

Create `env\.env.dev` from its example and preserve the generated identifiers.
Replace the example developer website, privacy URL, and terms URL with your actual
organization's HTTPS pages before registering or publishing the app.
The app includes static pilot information pages at `/`, `/privacy`, and `/terms`,
published as `isaru66`. Review their content in `src\http\pilot-pages.ts` before
deploying or reusing this project. They are public information pages, not an
anonymous chat interface. They use no browser scripts, external resources, or
application cookies. Set `WEBSITE_URL`, `PRIVACY_URL`, and `TERMS_URL` to their
actual deployed HTTPS URLs only after approval and a successful page release.
Run `npm run toolkit:sync -- --wsl` **before** invoking Toolkit `provision`, so Toolkit loads
the Terraform outputs when it reads the environment file. The provision stage
first verifies the live ACA revision rather than registering a bootstrap image.

```powershell
# Local-only package example: no registration or publication
npx atk package --env test --env-file tests\fixtures\manifest.env --output-package-file appPackage\build\appPackage.test.zip --telemetry false
```

Toolkit `provision` creates/updates a Teams app, `deploy` changes ACA, and `publish`
submits to tenant administrators. These are **state-changing operations**; do not
run them as part of a routine local check.

For personal sideloading, Developer Portal registration and Toolkit sign-in are
not required just to build the ZIP. Set `TEAMS_APP_ID` once to a fresh UUID in
ignored `env\.env.dev`, distinct from `BOT_ID`, and keep it stable for updates.
This ID identifies the Teams package; generating it does not register a new
Entra application or create a Developer Portal record.

```powershell
# Build the real pilot package from approved live URLs and the existing bot ID.
node .\node_modules\@microsoft\m365agentstoolkit-cli\cli.js package --env dev --env-file env\.env.dev --output-package-file appPackage\build\appPackage.dev.zip --telemetry false
```

The pilot package is `appPackage\build\appPackage.dev.zip`. Validate the resolved
manifest against its Microsoft Teams schema and check package contents, icons,
personal scope, bot ID, and live publisher URLs before installing. Schema checks
do not replace actual Teams installation and conversation verification. If you
later adopt a Developer Portal-managed lifecycle, import the existing package
rather than assuming its locally generated ID is already registered there.

For a personal-upload pilot, sign into Teams with a native member
account in the bot's tenant and an enabled core Teams service plan. Guest accounts
cannot browse/add apps from the Teams app store even when custom-app policies are
enabled. A license explicitly named "no Teams" does not provide core Teams access.
Verify the user's assigned plan, not just the tenant's purchased subscriptions.
Do not weaken bot authentication or broaden organization-wide policies to
work around a guest-account or licensing limitation.

In Teams, use **Apps > Manage your apps > Upload an app > Upload a custom app**,
select the validated development package (not `appPackage.test.zip`), and add it
for personal use. Send `help`, then `model`; installation alone does not generate
a welcome response. Verify each enabled provider with a short nonsensitive
prompt, then streaming, Stop, and `reset`. Model prompts incur provider charges.

## Security, retention, and operational limits

Public ACA ingress is required for the bot channel, but it is not anonymous chat
access. The SDK validates channel JWTs **before** dispatch; the app then checks
tenant, Teams channel, personal scope, and user identity before state access.
Only the static pilot information pages and minimal health/readiness responses
are anonymous. No interactive ACA login redirect is placed in front of
`/api/messages`.

The prompt and selected provider's history are sent to that provider's configured
endpoint (Azure-hosted inference or the configured external service).
Confirm the endpoint's data boundary, your organization's policy, and the provider account's retention/training
terms. The app's 24-hour expiry does not control provider retention or delete
messages from Teams. Expiry is enforced on reads regardless of Cosmos TTL cleanup
timing. No prompt bodies, authorization headers, or raw SDK payloads are logged.
Application Insights collects sanitized console events; automatic HTTP/DB payload
instrumentation is deliberately disabled. Its exporter uses Azure identity, not
local instrumentation-key authentication.

Reset/start a fresh conversation before changing a provider endpoint across data
boundaries. Histories are isolated by provider ID, not by endpoint hostname.
Legacy Claude/Gemini state is upgraded with an empty Azure OpenAI history bucket;
it is not a bulk migration. Before a later rollout enables Azure OpenAI, drain
old application revisions that do not understand its provider ID. Do not route
Azure OpenAI conversations to a mixed old/new revision fleet.

Long-running turns are acknowledged after authentication and tracked until
completion, not left as unobserved promises. Shutdown stops admission, aborts
generation, and drains tracked turns. Leases coordinate ownership across replicas.
An abrupt process kill can interrupt a visible stream; it is not automatically
replayed or billed again. Its lease expires and incomplete output is not reused.
This pilot is not a durable background-job queue.
Duplicate suppression covers the latest 256 acquired activities within 24 hours,
not indefinite replay protection. Keep replica clocks synchronized for lease and
expiry comparisons.

The local per-replica admission limit is 32 tracked turns. ACA's HTTP scaler sees
short acknowledged requests rather than the full model-generation duration;
high-volume deployments should evaluate workload-aware scaling and durable queues.
This pilot keeps at least one replica warm and limits replicas to three.

## Development checks

```powershell
npm run check
npm run build
docker build --tag teams-multimodel-agent:local .
wsl --distribution Ubuntu --exec terraform -chdir=infra fmt -check -recursive
wsl --distribution Ubuntu --exec env TF_DATA_DIR=.terraform-wsl terraform -chdir=infra init -backend=false -input=false -lockfile=readonly
wsl --distribution Ubuntu --exec env TF_DATA_DIR=.terraform-wsl terraform -chdir=infra validate
```

Tests use mock model clients and an in-process HTTP connector, including actual
Teams SDK ingress/authentication and native streaming payloads. They do not
create cloud resources or incur model charges.

Real tenant installation, service-token exchange, provider model availability,
Teams client Stop behavior, Azure identity/RBAC propagation, restart persistence,
and release rollback still require an approved live environment.

## References

- [Agents Toolkit](https://learn.microsoft.com/en-us/microsoftteams/platform/toolkit/overview-agents-toolkit)
- [Teams native streaming](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/streaming-ux)
- [Anthropic streaming](https://platform.claude.com/docs/en/build-with-claude/streaming)
- [Google GenAI SDK](https://ai.google.dev/gemini-api/docs/libraries)
