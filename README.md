# Teams multi-model agent

A TypeScript **custom-engine agent** developed with Microsoft 365 Agents Toolkit.
It runs in **Azure Container Apps (ACA)** and calls **Claude Opus** or **Gemini**
through their official provider APIs. All Terraform is in [`infra`](infra).

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

**Azure infrastructure is provisioned and the application image is staged;
the model runtime is not activated and the Teams app is not installed or published.**
The ACA bootstrap health endpoint is
https://tmma79e118-app.blackdesert-f956b6ef.southeastasia.azurecontainerapps.io/healthz.
Terraform state is stored in Azure Blob Storage with separate bootstrap and main
keys. Provider credentials, verified model IDs, runtime activation, tenant
app-upload policy, and real Teams behavior remain prerequisites for rollout.

## Local development without credentials

Use Node.js 22.12 or newer in the Node 22 LTS line.

```powershell
npm ci
Copy-Item .env.example .env
npm run dev
```

In a second terminal:

```powershell
npm run playground
```

Open the local URL printed by Agents Playground. In VS Code, install the
recommended **Microsoft 365 Agents Toolkit** extension and use the included debug
configuration or tasks. The project was initialized from the Toolkit blank-app
scaffold and customized for the current Teams SDK rather than importing an
OpenAI-specific sample runtime.

The sample environment enables **mock providers**, in-memory state, and an
explicit local-only authentication bypass. The server binds to loopback in this
mode, accepts only loopback callback URLs, and refuses live providers. Never put
this mode behind a public tunnel. Local process restarts clear in-memory history.

For authenticated development against real Teams, configure bot credentials,
tenant ID, API keys, and model IDs in your ignored `.env`, set
`LOCAL_PLAYGROUND=false`, and set `PROVIDER_MODE=live`. Use an approved bot
registration and HTTPS development endpoint. Set `STATE_STORE=cosmos` to exercise
persistent state using your Azure identity. Do not post credentials in chat or
commit environment files.

## Chat commands

| Input | Behavior |
| --- | --- |
| `help` | Show the model card, limitations, and processing notice |
| `model claude` | Select the configured Claude Opus model |
| `model gemini` | Select the configured Gemini model |
| `model` | Show the selection and model chooser |
| `reset` | Clear both app-held histories and model selection |
| Any other text | Send to the selected provider with only its unexpired context |

A model must be selected before a prompt is processed. Switching models resumes
that model's history, not the other provider's conversation. Model changes are
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
| `CLAUDE_MODEL` | Accessible model ID beginning with `claude-opus-` |
| `GEMINI_MODEL` | Accessible model ID beginning with `gemini-` |
| `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` | Provider credentials, injected through Key Vault in ACA |
| `COSMOS_ENDPOINT` | HTTPS Cosmos endpoint |
| `COSMOS_DATABASE`, `COSMOS_CONTAINER` | `teams-agent`, `conversations` |
| `AZURE_CLIENT_ID` | Managed identity used for Azure data access, not the bot client ID |
| `MAX_OUTPUT_TOKENS` | `2048`, configurable within 1-8192 |
| `MAX_INPUT_CHARS` | `12000` |
| `MAX_CONTEXT_BYTES` | `80000`, conservative UTF-8 budget for prompt and retained exchanges |
| `STREAM_TIMEOUT_MS` | `90000`, at most `100000` |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | Enables sanitized operational telemetry |

Model IDs are intentionally not guessed or pinned to an unverified model release.
Confirm access and supported generation limits with your Anthropic and Google
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

## Security, retention, and operational limits

Public ACA ingress is required for the bot channel, but it is not anonymous chat
access. The SDK validates channel JWTs **before** dispatch; the app then checks
tenant, Teams channel, personal scope, and user identity before state access.
Only minimal health/readiness responses are anonymous. No interactive ACA login
redirect is placed in front of `/api/messages`.

The prompt and selected provider's history leave Azure for Anthropic or Google.
Confirm your organization's policy and the provider account's retention/training
terms. The app's 24-hour expiry does not control provider retention or delete
messages from Teams. Expiry is enforced on reads regardless of Cosmos TTL cleanup
timing. No prompt bodies, authorization headers, or raw SDK payloads are logged.
Application Insights collects sanitized console events; automatic HTTP/DB payload
instrumentation is deliberately disabled. Its exporter uses Azure identity, not
local instrumentation-key authentication.

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
