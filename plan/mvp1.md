# Teams multi-model agent implementation plan

## Status and objective

Fleet implementation is complete. The initially empty repository now contains the
application, Toolkit configuration, tests, and Terraform. All 209 tests, typecheck,
lint, production build, container build, local HTTP/streaming integration, and
Toolkit package validation pass. Main and bootstrap Terraform validate under
Ubuntu WSL (Linux ARM64). No cloud resources, commits, pushes, or Teams publication
have been performed.

The assistant-run WSL apply plan is in `.azure\deployment-plan.md`. Azure validation
has been started but is gated on target subscription/region/backend confirmation.
The user was unavailable to provide that confirmation. Do not treat local
validation or the CLI's selected subscription as permission to apply.

Build a Microsoft Teams personal-chat agent using Microsoft 365 Agents Toolkit,
Node.js/TypeScript, and Azure Container Apps (ACA). Users explicitly choose Claude
Opus or Gemini. Call the Anthropic and Google Gemini APIs directly. Provision
infrastructure using Terraform, with all Terraform files under `infra\`.

This session plan remains outside the repository during plan mode. After approval,
create the deployment companion at `.azure\deployment-plan.md` before preparing
Azure artifacts; keep it aligned with this plan.

## Confirmed requirements

- Microsoft 365 Agents Toolkit plus TypeScript; no Python implementation.
- Custom-engine agent with application-owned model routing, not a declarative
  agent that delegates model selection to Microsoft 365 Copilot.
- Personal 1:1 chat within one Microsoft 365 tenant.
- Direct Anthropic and Google Gemini APIs; model inference is not hosted in ACA.
- Public ACA HTTPS ingress, but authenticated bot traffic and tenant restrictions.
- A model selection is required before the first prompt; no implicit default.
- Persistent, separate conversation histories for Claude and Gemini.
- History expires after 24 hours and retains at most the latest 20 exchanges per
  model. Provide a reset command.
- One active response per conversation, with a configurable 2,048-output-token cap.
- Stream both providers' answers progressively into one Teams message bubble.
- Stopped or failed partial answers stay visible and are identified as incomplete,
  but the unfinished exchange is excluded from future model context.
- Provider errors are explicit; never fall back to the other provider automatically.
- Responsive pilot: one warm ACA replica, scaling to a maximum of three.
- All Terraform configuration belongs in the repository's `infra\` directory.
- The user subsequently requested a plan for assistant-run Terraform apply in
  Ubuntu WSL. Offline WSL validation proceeds now; applying is gated on confirming
  subscription/tenant, region, backend, resource scope, and costs. The user was
  unavailable to confirm the detected subscription, so billable resource creation
  must wait. See `.azure\deployment-plan.md` for the WSL execution sequence.

## Architecture

Request path:

Teams personal chat -> Microsoft bot channel -> ACA HTTPS `/api/messages`
-> authenticated Teams handler -> selected provider adapter
-> Anthropic Messages API or Google Gemini API -> reply in Teams.

The application also accesses Cosmos DB for conversation state and Azure Key Vault
for secrets, using Azure managed identity where supported.

### Toolkit and runtime

Use Microsoft 365 Agents Toolkit for scaffolding, VS Code tasks/debugging, local
Agents Playground, environment configuration, Teams manifest validation, and app
packaging. Use the maintained Teams SDK TypeScript runtime for this Teams-only
scope. Toolkit is developer tooling; it is distinct from the runtime SDK and from
the model provider SDKs. Do not combine two bot runtimes or introduce legacy
Bot Framework/TeamsFx application dependencies.

Start from a current compatible Toolkit custom-engine/Teams agent scaffold after
checking its package requirements. Pin compatible dependencies and use a supported
Node.js LTS runtime consistently in development, CI, and the container.

Use the official `@anthropic-ai/sdk` and `@google/genai` clients behind a small
typed streaming provider interface with cancellation and terminal status/usage.
Do not add a general orchestration framework for this
chat-only scope. Model IDs are deployment configuration, not user-supplied API
parameters. Verify an available Claude Opus model and Gemini model against the
operator's provider accounts before live rollout; do not assume preview models,
invent model IDs, or expose arbitrary provider endpoints.

### Azure resources and ownership

| Component | Role and ownership |
| --- | --- |
| Resource group | Terraform-owned pilot resources and tags |
| ACA environment and app | Public HTTPS, managed TLS, health probes, 1-3 replicas |
| Azure Container Registry | Private application images; admin credentials disabled |
| Azure Bot registration and Teams channel | Terraform-owned routing to ACA; single-tenant bot identity |
| Microsoft Entra application/service principal | Terraform-owned identity metadata, using the AzureAD provider |
| Cosmos DB for NoSQL | Serverless pilot database with TTL and partitioned state |
| Key Vault | Secret storage and scoped runtime access |
| Managed identity and RBAC | ACR pull, Cosmos data access, and Key Vault secret access |
| Log Analytics and Application Insights | Redacted operational telemetry |
| Azure Storage state backend | Entra-authenticated Terraform remote state and locking |
| Teams app/package | Toolkit-owned; uses Terraform outputs rather than duplicating registrations |

Prefer standard public Azure service endpoints for the pilot, protected by identity
and authorization. No private endpoints, custom domain, APIM, Front Door, or VNet
are required for the initial scope. Public networking does not mean anonymous
access to the bot, database, registry, or secrets.

Production bot authentication must validate channel tokens using the supported
SDK, then enforce the configured tenant and personal-chat scope before any data
access or model call. Do not put an interactive ACA login redirect in front of the
bot endpoint. Expose only minimal non-sensitive health responses anonymously.

Use SDK-supported single-tenant bot credentials, referenced from Key Vault.
Create/rotate credential values outside Terraform, through an explicit secure
operator step; never manage passwords or provider API key values as Terraform
resources, variables, outputs, or data-source reads. Terraform creates identity
metadata, vault resources, RBAC, and secret URI references, not secret values.
Managed identity handles application access to Azure services.

## Chat behavior and persistence

1. Welcome/help presents a model-selection Adaptive Card and text command
   alternatives: `model claude`, `model gemini`, `model`, `reset`, and `help`.
2. Before selection, a normal prompt produces selection guidance without calling
   either provider or persisting that prompt as an answered exchange.
3. Selection persists per authenticated tenant/user/conversation. The chosen
   provider and configured model name are visible in the UI.
4. Each provider has its own history. Switching resumes that provider's unexpired
   context; no other provider's messages are copied across. Welcome/help explicitly
   explains the selected provider receives the prompt and its own recent history.
5. Store timestamps/expiry for exchanges and filter expired data at read time.
   Cosmos TTL handles eventual physical cleanup, but its timing must not determine
   whether expired content is sent to a provider. Do not keep old exchanges alive
   indefinitely merely by updating a conversation document.
6. Bound stored history to 20 completed exchanges per provider and enforce the
   selected model's context budget. Trim oldest context when necessary and make
   context reduction visible rather than silently misrepresenting full recall.
7. `reset` clears both providers' application-held histories and the selection for
   this conversation. Explain that it does not delete Teams messages or data
   already retained by external providers under their policies.
8. Use conditional writes and expiring distributed leases so three replicas still
   allow only one active response per conversation. Deduplicate incoming activity
   IDs. Prevent reset/model-switch races and stale response writes.
9. Stream answers by default using Teams SDK `stream.update` for initial status and
   `stream.emit` for answer chunks, followed by the supported finalization flow.
   Bound provider timeouts and same-provider transient retries, with retries only
   before answer content has been emitted. Validate long-response delivery against
   Teams/channel request deadlines; do not rely on an untracked fire-and-forget
   promise after HTTP acknowledgment.
10. Enforce output-token and input/context budgets. Render long replies safely for
    Teams message size limits, flag truncation, and handle refusal, safety blocking,
    empty output, quota exhaustion, timeout, and authentication errors explicitly.

Only send prompts/history to the provider explicitly selected by the user. No
automatic cross-provider retry, comparison mode, or background dual inference.
Record sanitized correlation IDs, latency, provider/model, and token usage when
available; do not log message bodies, authorization headers, or API credentials.
The output-token cap is not a monetary spending cap, particularly for reasoning
models; expose relevant model-specific limits and document billing implications.

## Streaming implementation

Teams streaming is generally available for personal 1:1 chats on web, desktop,
and mobile. It permits one concurrent stream per chat and enforces a two-minute
stream lifetime. These constraints match the selected scope and concurrency model.

- Consume Anthropic and Gemini streaming APIs server-side. Normalize visible
  answer-text deltas, terminal status, and available usage into a typed async
  stream. Never display thinking/reasoning blocks or log raw provider events.
- Keep conversation history application-controlled. Send the bounded, unexpired
  context explicitly; do not use provider-hosted conversation chaining that could
  restore expired, reset, or incomplete exchanges.
- Start with a meaningful status such as "Generating with Claude Opus..." and then
  stream answer content. Do not simulate token streaming by waiting for a full
  provider answer and splitting it afterward.
- Use SDK-managed cumulative content and ordering. Buffer/coalesce model deltas
  around the documented 1.5-2 second update cadence, respecting SDK pacing rather
  than adding a competing send loop. Serialize sends, handle backpressure, and
  honor rate-limit retry instructions only within the remaining stream deadline.
- Maintain a deadline measured from stream creation that reserves time for final
  delivery before the two-minute platform maximum. Bound provider generation and
  retries by this deadline. A deadline-limited or token-truncated answer is clearly
  marked incomplete and is not stored as a completed conversation exchange.
- Stream finalization includes the accumulated answer and supported AI-generated
  labeling. Only completed, successfully delivered exchanges enter model history;
  retain sanitized operational status for failed delivery without treating partial
  text as conversation context.
- Recognize built-in Stop using the selected SDK's supported signal or the documented
  cancellation response (`ContentStreamNotAllowed` with user-cancelled detail).
  The same error code can mean other failures: classify the specific reason rather
  than interpreting every 403 as cancellation.
- On Stop, timeout, or failure, abort the provider request as soon as detected,
  stop forwarding chunks, release the distributed lease, and exclude both prompt
  and partial answer from subsequent context. Late provider events must not revive
  the exchange or overwrite a reset.
- Preserve partial text that Teams already displayed. If the stream is still
  writable, append an incomplete notice through the supported finalization path.
  After Stop, Teams forbids editing streamed content: send a concise separate
  notice identifying the partial answer as incomplete and excluded from context.
  Do not attempt to overwrite or finalize a user-stopped stream.
- Persist enough stream identity/status for cancellation handling across ACA
  replicas. The owning request aborts its provider call; a control request landing
  on another replica cannot depend on that replica's process-local AbortController.
  Renew leases during generation and stop delivery if ownership is lost.
- If Teams denies streaming for the user/app, report the limitation explicitly.
  Do not silently reissue paid inference, switch providers, or duplicate an answer.
- Track time to first visible answer chunk, overall duration, throttling, and
  cancellation separately from text content. Cancellation can still incur provider
  charges for work already performed.

ACA does not need a browser-facing SSE endpoint or WebSocket for this flow:
the server consumes provider streams and forwards updates through the authenticated
Teams messaging channel. Terraform resources and public-ingress design are unchanged.

## Provisioning and deployment workflow

Toolkit's documented built-in code deployment targets do not include ACA.
Customize lifecycle script hooks instead of using App Service zip deployment.

Use direct Terraform orchestration from Toolkit-compatible scripts; avoid adding
a second lifecycle manager for this single-service project. Scripts must work from
the repository on Windows and pass arguments safely without embedding secrets.

1. Run preflight for tools, tenant policy, Azure access, chosen region, provider
   model access, and required permissions. Confirm subscription, region, resource
   naming, state backend, and expected costs with the operator before provisioning.
2. Initialize an existing Entra-authenticated remote state backend, or explicitly
   bootstrap one using configuration under `infra\bootstrap\`. Document separate
   bootstrap state ownership and protection; never commit local state.
3. Produce a reviewable Terraform plan. Apply only after deployment approval.
   Terraform creates infrastructure and exports non-secret names, IDs, ACA URL,
   and identity information for Toolkit.
4. Handle first deployment explicitly: provision ACA with a known public bootstrap
   image without a private registry link, then build/push the real application
   image to ACR and configure managed-identity image pull. The bootstrap is not a
   functioning agent and must not be reported or published as ready.
5. Keep ownership explicit: Terraform owns infrastructure and runtime settings;
   the release script owns the image and registry attachment, with narrowly scoped
   Terraform drift exclusions. Repeated Terraform applies must not revert a
   release or mask unrelated configuration drift.
6. Supply secret values securely outside Terraform and consume Key Vault references.
   Fail clearly for missing secrets or unavailable model configurations.
7. Deploy a uniquely tagged application image, verify health and bot authentication,
   and support rollback to a known prior image/revision.
8. Import non-secret Terraform outputs into Toolkit environment configuration.
   Validate and build the Teams app package, then install in the approved tenant
   only after the deployed app is ready.

No cloud resources, identity objects, secrets, Teams registrations, app publication,
or paid provider requests are created during planning. Implementation approval is
not permission to deploy or publish; collect deployment-specific approval later.

## Expected repository layout

```text
src\
  index.ts
  config\
  bot\
  providers\
    anthropic.ts
    gemini.ts
  state\
  telemetry\
tests\
appPackage\
  manifest.json
  color.png
  outline.png
infra\
  versions.tf
  providers.tf
  backend.tf
  main.tf
  variables.tf
  outputs.tf
  terraform.tfvars.example
  bootstrap\
scripts\
  provision.*
  deploy.*
  sync-toolkit-env.*
env\
  .env.*.example
.vscode\
m365agents.yml
m365agents.local.yml
Dockerfile
.dockerignore
.gitignore
package.json
package-lock.json
tsconfig.json
README.md
.azure\
  deployment-plan.md
```

Exact scaffold filenames may follow the selected current Toolkit version. Generated
secrets, local environment files, state, plans containing sensitive information, and
build artifacts are ignored. No Bicep files are introduced.

## Implementation todos

1. Scaffold Toolkit TypeScript project and local debugging; establish configuration,
   package scripts, container build, and production authentication guards.
2. Implement typed provider adapters, configurable model IDs, output/context limits,
   streaming deltas, cancellation, error normalization, and mock-based provider tests.
3. Implement Cosmos persistence, expiry filtering, history limits, isolation,
   conditional updates, duplicate suppression, and reset-safe concurrency.
4. Implement Teams handlers, model selection, help/reset, message formatting, and
   streamed reply delivery; integrate the provider and state layers, including
   cancellation across replicas and incomplete-answer exclusion.
5. Author all Terraform under `infra\`, including state bootstrap, identities,
   public ACA hosting, data, secrets references, monitoring, and role assignments.
6. Wire Toolkit lifecycle scripts to Terraform outputs and the ACA image deployment;
   add environment examples, app package validation, and operator documentation.
7. Validate the integrated application and deployment artifacts; record outstanding
   cloud-only checks honestly and hand off for separately approved deployment.

## Verification and acceptance criteria

- TypeScript type-check, lint, unit tests, and container build succeed.
- Provider mocks verify routing, correct model IDs, output caps, normalized errors,
  explicit empty/blocked responses, text-only streaming deltas, abort behavior,
  terminal usage/status, and no cross-provider fallback.
- State tests cover the exact 24-hour cutoff, 20-exchange cap, cross-user/tenant/
  conversation/model isolation, concurrent replicas, duplicate delivery, reset
  races, lease expiry, and trimming under the provider context limit.
- Unauthenticated, invalid-token, wrong-tenant, and non-personal requests make zero
  provider calls and cannot access history. Production cannot enable local auth
  bypass or the development playground.
- Local Playground demonstrates selection, successful responses, provider switching,
  independent context, reset, and useful failures without paid API calls by default.
- Streaming tests use fake clocks and mock transports to verify progressive output
  before provider completion, ordered cumulative chunks, buffered pacing, one stream
  per chat, finalization, and cleanup before the platform's two-minute limit.
- Exercise Stop, mid-stream provider failure, Teams 429 responses, unsupported
  streaming, message-size limits, and final-send failure. Verify no post-cancellation
  chunks, cross-replica races, duplicated inference, incomplete history writes, or
  attempts to edit a stopped bubble.
- Test real Teams streaming on supported clients after deployment; Playground alone
  does not verify the native Stop behavior, channel throttling, or stream deadlines.
- Terraform formatting and validation succeed. A reviewed plan confirms HTTPS-only
  public ingress, 1-3 replicas, managed-identity registry access, appropriate data
  roles, TTL, probes, state protection, and no secret values in Terraform.
- Validate the rendered Teams manifest and package using Toolkit.
- Run Azure validation before any deployment. Real Teams/token validation, provider
  availability, long-latency delivery, replica behavior, restart persistence, and
  re-apply/rollback checks require approved credentials and cloud access; do not
  equate mocks or a bootstrap image with these acceptance checks.
- Deployment acceptance: an allowed tenant user can install the personal app, choose
  either configured model, see a genuine response appear incrementally, stop a
  response without adding partial content to history, switch without leaking
  context, and resume unexpired history after an ACA restart.

## Exclusions and remaining deployment prerequisites

Out of scope: attachments, vision, RAG, web search, tool execution, Microsoft Graph,
SSO for user data, channels/group chats, multi-tenant distribution, Teams Store
publication, a separate web UI, and automated CI/CD cloud deployment.

Before deployment, obtain the target subscription/region/tenant, remote backend
details, Azure and Entra provisioning permissions, custom-app upload approval,
Anthropic/Gemini API credentials with verified model access, and approval for
external-provider processing and costs. Do not request secret values in chat.
Provider retention/training terms are distinct from the app's 24-hour history TTL.

## Sources consulted

- Agents Toolkit overview:
  https://learn.microsoft.com/en-us/microsoftteams/platform/toolkit/overview-agents-toolkit
- Toolkit provisioning and customizable lifecycle:
  https://learn.microsoft.com/en-us/microsoftteams/platform/toolkit/provision
- Toolkit deployment targets and hooks:
  https://learn.microsoft.com/en-us/microsoftteams/platform/toolkit/deploy
- Teams SDK TypeScript quickstart and authentication defaults:
  https://microsoft.github.io/teams-sdk/typescript/getting-started/quickstart/
- Teams registration and local development:
  https://microsoft.github.io/teams-sdk/typescript/getting-started/running-in-teams/
- Official Anthropic SDKs:
  https://platform.claude.com/docs/en/cli-sdks-libraries/overview
- Official Google GenAI SDK guidance:
  https://ai.google.dev/gemini-api/docs/libraries
- Teams streaming support, SDK calls, Stop behavior, pacing, and deadlines:
  https://learn.microsoft.com/en-us/microsoftteams/platform/bots/streaming-ux
- Anthropic streaming:
  https://platform.claude.com/docs/en/build-with-claude/streaming
- Gemini text generation and streaming:
  https://ai.google.dev/gemini-api/docs/text-generation
