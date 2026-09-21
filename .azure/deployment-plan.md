# Teams multi-model agent deployment plan

Status: Deployed; approved pilot pages live on ACA. Teams installation pending user sign-in.

## Current request: Teams personal pilot and public information pages

- Approved plan: use native member `cat001` with an available existing E7 seat;
  keep the original guest account and global Teams policies unchanged.
- Publisher: `isaru66`. Add public website, privacy, and terms routes on the
  existing ACA application. Draft content requires user approval before release.
- Preserve authentication on `/api/messages`, all three providers, secrets,
  Cosmos state, managed identity, health probes, scaling, and bot registration.
- Reuse subscription `79e1d757-ecdb-4dc3-b0b4-035bac76053d`, tenant
  `ddcbdc96-6162-4d91-bb0d-066343049ce1`, and Southeast Asia resources.
- Recipe: retain existing Terraform ownership and WSL-aware ACR/image release
  tooling. No new infrastructure or Terraform apply is expected.
- Baseline: ready revision `tmma79e118-app--0000004`; image
  `tmma79e118acr.azurecr.io/teams-agent:release-20260918t145822118z-a47fc46c0ce3`.
- Before release: review the exact upload/source scope, including previously
  modified files not yet deployed; do not silently include unrelated changes.
- Gates: focused HTTP tests, typecheck/lint/build, user content approval,
  azure-validate, then azure-deploy. Previous validation evidence below applies
  only to the historical Gemini configuration update, not this new release.
- Acceptance: public information pages return HTML over HTTPS, probes remain
  healthy, unauthenticated bot activities still return 401, then a validated
  personal Teams package is installed and exercised by the pilot user.
- Rollback: use the prior image/revision through the existing release mechanism;
  preserve secrets, identity, and conversation data. No destructive reset.
- No tenant-wide app publication, license purchase, credentials, role grants,
  commits, or pushes are authorized by this change.

### Pilot-page deployment outcome

- User approved content; azure-validate workflow completed before deployment.
- Existing release command `node scripts\deploy.mjs --wsl --deploy` succeeded.
  ACR build `cm3` produced image
  `tmma79e118acr.azurecr.io/teams-agent:release-20260921t071638204z-8d71da5ae501`,
  digest `sha256:2cd6d1a53e5043fd2ef506d841f1056ed10d7b547304457bbfba21f77f888101`.
- Latest and ready revision: `tmma79e118-app--0000005`, serving 100 percent of
  traffic. Previous image/revision remain recorded above for rollback.
- Live website, privacy, and terms pages return HTTP 200 and match the approved
  local preview byte for byte. HTML content type and stylesheet CSP hash verified.
- `/healthz` and `/readyz` return HTTP 200. Missing and invalid tokens on
  `/api/messages` still return HTTP 401. No authenticated model calls were made.
- Production live configuration remains Cosmos-backed with all three providers:
  Claude `claude-sonnet-5`, Gemini `gemini-3.8-flash`, Azure OpenAI `gpt-5.6-luna`.
  Neither local-playground flag is enabled in ACA.
- Live role checks passed: runtime UAMI retains scoped AcrPull, Key Vault Secrets
  User, Monitoring Metrics Publisher, and Cosmos data contributor permissions.
  No identities, secrets, roles, policies, licenses, or infrastructure changed.
- Populated approved publisher and live page URLs in ignored `env\.env.dev`.
  Root `.env` and its credentials are unchanged.
- Teams registration, personal package installation, and actual Teams chat
  remain pending user sign-in; page deployment does not prove those outcomes.

### Personal sideload package

- Built `appPackage\build\appPackage.dev.zip` with the installed Agents Toolkit
  from approved live metadata. Persisted stable Teams manifest app ID
  `91321a3d-b79d-4803-80f1-81f3edbdb74e` in ignored `env\.env.dev`; existing bot
  ID is unchanged. This is offline packaging, not a Developer Portal registration
  or tenant-wide catalog upload.
- Toolkit's separate validation-rules command exited with native process code
  -1073741189 on two attempts. Used the existing local AJV draft-04 validator
  against Microsoft's fetched Teams v1.27 schema as an independent alternative.
  No packages were installed or dependency versions changed.
- Schema PASS; ZIP contains exactly manifest.json, color.png, and outline.png;
  all placeholders resolved; personal bot scope and app/bot IDs match settings;
  live publisher URLs return HTML with HTTP 200.
- Icons: 192x192 color, 32x32 outline; packaged bytes match repository assets.
  Outline has 474 visible white pixels, 550 transparent pixels, no nonwhite
  visible pixels.
- Package SHA-256:
  `98ecfd54357d29c72ecdb4b1b8ea2ec679102b50e1eb2578e31c4ae97d8b76f4`.
- These are package/schema checks, not Microsoft Store certification or proof
  of installation. Personal installation and actual Teams replies remain gated
  on authenticating as cat001.

### Preparation progress

- License preflight found E7 already assigned to cat001 by an external action.
  The account is an enabled Member; its TEAMS1 plan reports Success. No license
  assignment or removal was performed by this implementation.
- Implemented static `/`, `/privacy`, and `/terms` pages for publisher isaru66,
  using explicit SDK-adapter GET routes and compiled TypeScript. Page-local CSP
  permits only the hashed inline stylesheet; no scripts, tracking, or input.
- Updated stale Teams manifest provider/reset wording and related README steps.
- Local validation passed: 67 tests across pilot-pages, app, and deployment suites;
  typecheck, lint, and production build. Windows-aware whitespace check passed.
  This is preparation evidence, not complete azure-validate release approval.
- A separate loopback-only mock preview is running at http://127.0.0.1:3981.
  All three pages and health return HTTP 200. It does not load root `.env`.
- User explicitly approved the pilot page content for ACA on 2026-09-21.
  No image was built in ACR or deployed,
  and no Teams package was registered, installed, or published in this step.
- Toolkit currently has no signed-in Microsoft 365 account. Same-tenant login
  and direct Teams sign-in as cat001 remain human-input gates.

### Reviewed release scope and validation handoff

- Downloaded only bounded application layers from the existing private ACR image
  using in-memory pull credentials; verified layer digests. No credentials were
  logged or persisted. Compared the actual deployed compiled JavaScript with the
  local production build, rather than assuming Git HEAD represented that image.
- Exact runtime differences: added `http/pilot-pages.js`; `bot/app.js` imports and
  registers those pages; `config/index.js` contains the previously requested local
  live-Playground opt-in, which is explicitly rejected in production. No other
  compiled JavaScript changed or was removed.
- Production dependency declarations are unchanged. Package script differences
  are local dev/Playground entry points only; production remains `node dist/index.js`.
- Added `docs` to `.dockerignore` so diagnostic screenshots are not uploaded to
  ACR. Environment files, Terraform state/settings, session artifacts, tests, app
  packages, and Git history remain outside the build context.
- Revalidated 161 tests covering configuration, provider bootstrap, Playground,
  pilot pages, real SDK HTTP integration, and deployment tooling. Typecheck,
  lint, and build passed during preparation. Current ACA runtime verification
  against Terraform-owned outputs passed without configuration changes.
- Application-image release only; no Terraform apply, provider/secret changes,
  role changes, or new Azure resources. Await azure-validate before deployment.

### All validation checks pass: pilot-page release

- [x] Terraform/CLI installation, authentication and expected subscription.
- [x] Terraform init, format check, validate, read-only plan, and state access
  using the existing Ubuntu WSL data directory.
- [x] Template-variable scan; JSON tfvars check not applicable (HCL configuration).
- [x] Verify no infrastructure changes in the saved plan; never apply it for
  this application-image release.
- [x] Relevant application tests, typecheck, lint, and build.
- [x] Review real deployed-image differences and Docker upload exclusions.
- [x] Static managed-identity role and scope verification.
- [x] Record validation proof and complete the azure-validate workflow.

### Pilot-page release validation proof

- Terraform recipe preflight completed successfully through Ubuntu WSL with
  `TF_DATA_DIR=.terraform-wsl`. Saved-plan inspection reports zero resource
  changes. No apply will be performed.
- Windows and WSL Azure contexts target the approved subscription and tenant;
  the existing application is in Southeast Asia, Single revision mode.
- Current resource policy-state query reports no noncompliant entries for ACA.
  No policies, tags, or existing exemptions were modified.
- Static roles: runtime UAMI has ACR-scoped AcrPull, vault-scoped Key Vault
  Secrets User, Application Insights-scoped Monitoring Metrics Publisher, and
  Cosmos built-in data contributor scoped to teams-agent/conversations.
  The static page routes introduce no new service calls or identity permissions.
- Build and behavior proof: successful typecheck/lint/production build plus
  161 current targeted tests. Real-image comparison confirms the narrow compiled
  runtime change set documented above. New pages use the same running SDK adapter
  tested for missing/invalid-token rejection.

## Historical request: enable Gemini on ACA (2026-09-21)

- Scope: upload the saved root `.env` Gemini API key to `tmma79e118-kv`
  as `gemini-api-key`, without logging it or placing it in Terraform state.
- Preserve Claude and Azure OpenAI; enable `claude,gemini,azure-openai`.
- Gemini: Developer API, `https://generativelanguage.googleapis.com`,
  model `gemini-3.8-flash`. No Vertex OAuth credentials are required.
- Reuse the existing subscription, Southeast Asia resources, managed identity,
  production authentication, Cosmos storage, and Terraform backend.
- Inspect current deployment and permissions. Prefer a configuration-only update
  of the already-deployed Gemini-capable image; do not deploy unrelated local edits.
- Validate and review a fresh WSL Terraform plan, upload the secret securely,
  apply only the intended ACA change, and verify revision health, secret references,
  enabled-provider settings, authentication rejection, and post-apply drift.
- Permission changes, if needed, require separate approval. No Teams publication.
- Validation proof: passed; see Section 7.
- Deployment result: succeeded; see outcome below.

### Gemini deployment outcome (2026-09-21)

- Uploaded `gemini-api-key` to `tmma79e118-kv`; verified the enabled secret matches
  the saved root `.env` value without displaying or persisting the credential.
  Secret version: `5c7545823c18492c8f1df21950af194d`.
- Reviewed WSL Terraform apply: 0 additions, 1 in-place ACA update, 0 deletions.
  Existing deployed image reused; no unrelated local changes were shipped.
- Ready revision: `tmma79e118-app--0000004`, Healthy/Running, 100 percent traffic.
  The previous revision is no longer active.
- Enabled providers: `claude,gemini,azure-openai`; Gemini model `gemini-3.8-flash`,
  Developer API base `https://generativelanguage.googleapis.com`.
  GEMINI_API_KEY uses the managed-identity Key Vault reference.
- Public health/readiness: HTTP 200 with healthy/ready status. Missing and invalid
  channel tokens on `/api/messages`: HTTP 401. Production auth and Cosmos remain.
- Post-apply `terraform plan -detailed-exitcode`: exit 0, no changes.
- Runtime roles verified after apply: AcrPull, Key Vault Secrets User,
  Monitoring Metrics Publisher, container-scoped Cosmos data contributor.
  No new roles granted; existing operator permissions were not changed.
- Gemini worked locally through Playground earlier today. No live Gemini
  inference from inside ACA or end-to-end Teams chat was performed in this update.

### Preparation evidence and authorization

The user explicitly requested uploading the Gemini key and enabling it on the
existing ACA deployment. Reuse the previously approved subscription
`79e1d757-ecdb-4dc3-b0b4-035bac76053d`, tenant
`ddcbdc96-6162-4d91-bb0d-066343049ce1`, and `southeastasia`.
Windows and Ubuntu CLI contexts match. Recipe: existing pure Terraform in WSL.
No new Azure resources, compute allocation, or quota increase is planned.

Live revision `tmma79e118-app--0000003` uses the established three-provider image
`release-20260918t145822118z-a47fc46c0ce3`. Existing Terraform conditionally wires
Gemini's environment and Key Vault reference; only ignored deployment tfvars
need updating. Runtime Secrets User access exists, and the operator already has
vault-scoped Key Vault Administrator access; no role changes are needed.
The Gemini secret is currently absent. Existing secret values will not be changed.
Local live Gemini streaming was successfully verified through Playground.

Rollback: restore the prior enabled-provider list and blank Gemini settings,
then review/apply a new Terraform plan; retain the Key Vault secret version.
Do not change image, ingress, scale, Cosmos, bot identity, or existing providers.

Preflight detected the Bot Service streaming endpoint had been enabled outside
Terraform. Explicitly preserve `streaming_endpoint_enabled=true` in `main.tf`
to avoid reverting that existing user setting during this deployment.

### All validation checks pass

- [x] Terraform recipe preflight: CLI tools/authentication, init, format, validate,
  plan, remote state access, template scan, optional JSON tfvars check.
- [x] Review saved plan: exactly one in-place ACA update; no image change,
  replacement, deletion, unrelated infrastructure, or secret values.
- [x] Build/behavior: configuration and provider bootstrap tests; no new image.
- [x] Static role verification: AcrPull, vault Secrets User, Cosmos data access,
  telemetry publisher, managed-identity references.
- [x] Record validation proof and complete azure-validate workflow.

The entries below describe the previous deployment and are historical.

## Active runtime outcome (2026-09-18)

The reviewed WSL Terraform apply completed with 0 additions, 1 in-place ACA
change, and 0 deletions. The real application now runs on ready revision
`tmma79e118-app--0000003` with 100 percent ingress traffic. The bootstrap command
is removed; image `release-20260918t145822118z-a47fc46c0ce3` is unchanged.

- API: https://tmma79e118-app.blackdesert-f956b6ef.southeastasia.azurecontainerapps.io/api/messages
- Enabled providers: `claude,azure-openai`; Gemini disabled.
- Claude deployment: `claude-sonnet-5`; Azure OpenAI deployment: `gpt-5.6-luna`.
- Production live mode, Cosmos persistence, and three managed-identity Key Vault
  references are active. Secret values are not in Terraform or source.
- `/healthz`: HTTP 200, `status=healthy`; `/readyz`: HTTP 200, `status=ready`.
- Missing-token and invalid-token POST requests to `/api/messages`: HTTP 401.
- Bot credential independently authenticated with the approved Entra tenant.
  Its Entra expiry is 2027-09-18; the KV secret has no expiry metadata.
- Post-apply Terraform plan: no changes. Runtime roles remain intact; no new
  credential or permission was created by the assistant during activation.
- No live model inference, Teams installation/publication, or end-to-end Teams
  conversation test was performed during activation.

The preparation, staging, and credential-blocker entries below are historical.

Current scope: activate the already-staged image with Claude and Azure OpenAI.
The operator supplied a screenshot of successful, enabled `bot-client-secret`
creation on 2026-09-18 at 22:37 +07:00. Resume the requested activation after
fresh credential-metadata checks and runtime-plan validation. No credential
creation, new permission grants, image rebuild, or Teams publication is needed.
Earlier staging-only evidence and blockers below are historical.

The live preflight confirmed all three Key Vault secrets are enabled and the
existing bot app has a credential expiring 2027-09-18. The supplied bot secret
successfully acquired a Bot Framework token from the approved tenant; secret
and token values were held only in memory and were not logged or persisted.
`infra/terraform.tfvars` now persists `runtime_enabled=true` with only
`claude,azure-openai`. Reuse ACR build `cm2` without rebuilding. Review and apply
only the in-place ACA change, preserving its image, identity, ingress and scale.

## Current request: activate Claude and Azure OpenAI

The user requested replacing the ACA bootstrap with the real API and enabling
only `claude,azure-openai`. Gemini will remain disabled. Reuse the existing
subscription, tenant, Southeast Asia infrastructure, and Terraform backend.
Validate the current source, stage a new immutable application image, review
the runtime-only Terraform changes, enable runtime, and verify health/readiness
and unauthenticated request rejection. Do not publish or install Teams.

Both provider API keys are now present and verified in Key Vault. The temporary
operator Secrets Officer grant was removed; runtime Secrets User access remains.
The bot application credential is still missing. Determine the required secure
credential handoff before activation; do not weaken bot authentication.
New validation proof and deployment results will be recorded here.

The credential-creation approval question could not be answered because the
user was unavailable. Prepare and validate the requested two-provider settings
and stage the current image under the existing bootstrap command. Activation
remains blocked; no temporary access or bot credential will be created implicitly.
The ignored deployment tfvars now select only Claude and Azure OpenAI, using
the user's tested root-dotenv endpoints and deployments (`claude-sonnet-5` and
`gpt-5.6-luna`). Preserve `runtime_enabled=false` until `bot-client-secret` exists.

Preparation evidence (2026-09-18, approximately 21:50 +07:00):
`npm run check` passed typecheck, lint, and all 392 tests across 10 files;
`npm run build` passed. The HTTP fixtures used a synthetic Google project/location.
WSL Terraform formatting and validation passed. Both Azure CLI contexts match
the approved subscription and tenant. Runtime AcrPull, Secrets User, and telemetry
roles remain present. The bot application still has zero credentials.

## Latest staging result (2026-09-18, after 22:00 +07:00)

- Image: `tmma79e118acr.azurecr.io/teams-agent:release-20260918t145822118z-a47fc46c0ce3`
- Digest: `sha256:f0474b6de86fc9c9d7e02e30f0af78116abd8d8d530ffe906b78478e586fb7e4`
- ACR build `cm2` succeeded; latest and ready revision both
  `tmma79e118-app--0000002`, provisioning succeeded.
- HTTPS `/healthz` returns 200 with `status=bootstrap, ready=false`;
  `/readyz` returns 503. This is NOT an activated API.
- The read-only activation preview changes only the existing ACA resource in
  place: removes the bootstrap command, uses live providers and Cosmos, selects
  `claude,azure-openai`, and references exactly `anthropic-api-key`,
  `azure-openai-api-key`, and `bot-client-secret`. No Gemini secret is referenced.
- The preview was not applied. Its saved artifact was discarded rather than
  leaving a stale, executable activation plan.
- Runtime AcrPull, Secrets User, and telemetry role assignments remain intact.
  No new credential, permission, Teams installation, or model request was made.
- Production build retains the previously reported two moderate dependency
  advisories; no unrelated dependency changes were made.

To finish: obtain approval for secure creation of the existing bot application's
90-day credential and temporary vault-scoped write access, or have the operator
supply its valid credential as `bot-client-secret` in `tmma79e118-kv`.
Then persist `runtime_enabled=true`, revalidate and review a fresh Terraform plan,
apply it, and verify actual API health/readiness and authentication rejection.
Do not replace the missing credential with a placeholder or weaken authentication.

## Earlier application image staging result

The real application was built in ACR and staged on ACA without enabling runtime.

- Image: `tmma79e118acr.azurecr.io/teams-agent:release-20260918t014444560z-96f3405d14db`
- Digest: `sha256:fda8c4f69cf5d81cd5bfa6ff3488135233509911e10fb89f66a8810c088ebf52`
- ACR build run: `cm1`; Linux AMD64; nonroot runtime container.
- Latest and ready revision: `tmma79e118-app--0000001`.
- Previous bootstrap image: `node:22-alpine`.
- ACR pull uses the existing runtime UAMI, not registry credentials.
- `/healthz` returns HTTP 200 bootstrap JSON; `/readyz` remains HTTP 503.
- Post-staging Terraform plan reports no changes and preserves image/registry ownership.

The first staging command exposed a real release-verification race: ACA accepted
the image before the new revision became ready. The script now waits with bounded
read-only polling, rejects changed images/stages and terminal provisioning errors,
and supports `--prepare-runtime --verify-only` without rebuilding. Live verification
with that command succeeded after the fix. Typecheck, lint, and 47 deployment tests
passed, including warmup, bounded failure, stage/image changes, and staged verification.

The build also reported two existing moderate production dependency advisories
in `express`/`qs`; no high or critical production advisories were reported.
Record and assess these before a broader rollout; no unrelated dependency upgrade
or exploitability claim was made during this staging operation.

The user remained unavailable to approve temporary vault-scoped secret-entry
access. No grant, secret creation/read, model call, runtime activation, or Teams
installation was performed. The remaining steps require an approved credential
handoff, verified model IDs/publisher metadata, and interactive Microsoft 365 login.

## Autonomous continuation: stage image independently

The user requested continued implementation. Image staging is independent of
credential entry: validate and stage the real application image while retaining
the bootstrap command and `runtime_enabled=false`. This does not read provider
keys, start model calls, change permissions, or install/publish a Teams app.
Credential entry, interactive Microsoft 365 login, and nonsecret model/publisher
inputs remain prerequisites for subsequent activation, not for staging.

## Approved personal pilot activation: blocked on human prerequisites

The user approved the session activation plan. Scope: install only for their own
Teams account, retain existing tenant-wide authorization, use the current tenant
and infrastructure, and do not publish to the organization or Teams Store.
The user has both provider credentials and will enter them securely into Key Vault.

Preflight findings:

- The current operator lacks Key Vault secret metadata/write permission. No
  temporary Secrets Officer grant was approved while the user was unavailable;
  no role assignment was created.
- The existing bot application has no client credential. An approved operator
  must create an expiring credential and put it into `bot-client-secret`.
- Microsoft 365 Toolkit login is absent and requires interactive user sign-in.
- Publisher name, website, privacy, and terms configuration is missing.
- Verified model IDs remain required before runtime activation.
- The untracked repository `plan` directory is not a runtime input. It is now
  excluded from the ACR upload context, with a pre-upload guard and regression test.

No secret values were read, created, or logged. No image was uploaded, runtime
activated, permission changed, or Teams app created during that initial preflight;
the subsequent image-staging outcome is recorded above.
Next requires user/admin secret entry, approved access for metadata verification,
nonsecret model IDs and publisher metadata, and interactive Microsoft 365 login.
Do not bypass these gates or treat bootstrap health as a functioning chatbot.

## Current deployment outcome

Completed through Ubuntu WSL on 2026-09-18 at approximately 08:09 +07:00.
The existing backend was recovered and migrated without resource recreation.
The main apply created 20 resources with no changes or deletes.

- Backend: `tmmastate79e118`, private container `tfstate`, Entra authentication.
- Bootstrap state: `bootstrap/state.tfstate`, original lineage, five resources.
- Main state: `teams-agent/dev.tfstate`, distinct lineage, 20 managed resources.
- Application group: `tmma79e118-rg`, region `southeastasia`.
- HTTPS endpoint: https://tmma79e118-app.blackdesert-f956b6ef.southeastasia.azurecontainerapps.io
- `/healthz`: HTTP 200 with `{"status":"bootstrap","ready":false}`.
- `/readyz` and `/api/messages`: HTTP 503 as intended while runtime is disabled.
- ACA revision is provisioned and ready, external HTTPS only, 1-3 replicas.
- Cosmos TTL is 86400 with `/id` partitioning and local authentication disabled.
- Key Vault uses RBAC and purge protection; App Insights local auth is disabled.
- Runtime identity's three Azure RBAC assignments and container-scoped Cosmos
  data role were verified live.
- Both RGs retain the explicitly approved `SecurityControl=Ignore` tag.
- Toolkit nonsecret environment output was synchronized; no Teams app installed
  or published, no credentials created, and no live model calls made.

Post-deployment drift was limited to Azure-normalized defaults: Cosmos returns
the region display name and ACA supplies the Consumption workload profile.
Terraform now uses the provider's canonical region lookup and explicitly declares
the Consumption environment/profile. Revalidation passed, all 20 managed resources
matched, and the final saved-plan apply made 0 additions, 0 changes, and 0 deletions.
Bootstrap also reports no drift. No ignore-changes workaround was added.

## Approved migration and infrastructure deployment (2026-09-18)

The user explicitly requested state migration and Terraform deployment.
Restore the configured storage public endpoint under the approved RG exemption
without changing Entra-only authentication or anonymous-access restrictions.
Validate and apply the reviewed backend recovery plan through WSL, verify
authenticated blob access, then migrate the existing local bootstrap state to
`bootstrap/state.tfstate`. Initialize the main root separately at
`teams-agent/dev.tfstate`, validate/review its plan, and apply the infrastructure
with `runtime_enabled=false`. Preserve state lineage and resource ownership;
do not recreate existing backend resources. No application image deployment,
credential creation, model activation, Teams installation, or publication is
included. Both project groups retain the explicitly approved exception tag.

Backend recovery succeeded. Live storage reports public networking enabled,
shared keys disabled, and anonymous blob access disabled. Authenticated blob
listing succeeded after network-setting propagation. Migration to
`bootstrap/state.tfstate` preserved lineage and all five resources (serial 10).
A subsequent remote-backed bootstrap plan reported no changes. The main root
has been initialized against the separate `teams-agent/dev.tfstate` key.

## Approved exception-tag update (2026-09-18)

The user explicitly requested `SecurityControl=Ignore` at resource-group level.
Add optional `resource_group_tags` to both Terraform roots, leaving its default
empty, and configure the approved tag only in this pilot's ignored tfvars.
Apply a reviewed, tag-only plan to the existing `tmmastate79e118-rg`. Configure
the same tag for `tmma79e118-rg` when that group is eventually created; do not
create the application infrastructure merely to apply a tag.
Preserve all other tags, authentication, network settings, and existing resources.
This exception supersedes the earlier instruction not to add exemption tags for
these two project groups only. It does not authorize changes to policy definitions
or unrelated resource groups. Tagging does not itself re-enable the already
disabled storage endpoint; backend recovery and the main apply remain separate.

Result: the reviewed WSL Terraform apply completed with 0 creates, 1 change, and
0 deletes. Azure reports `SecurityControl=Ignore` and the existing `env=dev` on
`tmmastate79e118-rg`. The storage account itself still has only `env=dev`, with
public networking disabled, shared keys disabled, and anonymous blob access
disabled. The application RG has not been created; its future tag is configured.
Re-plan the backend to restore the previously requested public endpoint before
attempting migration; do not reuse a saved plan from before this tag update.

## Recipe: Terraform

Agents Toolkit drives Teams development and the explicit release scripts. Terraform
provisions Azure resources from `infra\`, executed in Ubuntu WSL. No AZD or Bicep
provisioning path is used.

## Approved architecture

Microsoft 365 Agents Toolkit and TypeScript Teams SDK personal-chat agent on
Azure Container Apps. Direct Anthropic and Gemini APIs with native Teams streaming.
Single-tenant authenticated bot traffic over public HTTPS. One to three replicas.
Separate 24-hour histories, at most 20 exchanges per model, explicit model selection,
2,048 output tokens by default, and no automatic provider fallback. Incomplete or
stopped exchanges are excluded from future context.

Terraform under `infra\` owns Azure resources and identity metadata. Toolkit owns
Teams packaging/local debugging; release scripts own container image deployment.
Secrets are populated outside Terraform and referenced through Key Vault.

## Execution

Implement application, provider adapters, Cosmos persistence, and Terraform in
parallel with exclusive file ownership. Integrate Toolkit lifecycle and validate
locally. Complete Azure validation before any separately approved deployment.

## Deployment gates

Confirm subscription, tenant, region, remote state backend, permissions, custom-app
upload policy, model IDs/access, provider credentials, external processing policy,
and costs before provisioning. No secret values in chat, code, or Terraform state.

The user explicitly approved assistant-run Terraform apply through WSL in the
subscription and tenant below. Region and dedicated backend selection were
delegated to the assistant. This approval covers infrastructure bootstrap only.
Do not deploy the application image, publish Teams, commit, or push implicitly.
Live Teams streaming, Stop behavior, external API access, and Azure behavior remain
unverified until an approved environment is available.

## Assistant-run Terraform apply through WSL

Requested execution environment: Ubuntu WSL, not Windows Terraform.
Detected: Terraform 1.15.3 (`linux_arm64`) and Azure CLI are installed in Ubuntu.
Use an isolated Linux Terraform data directory; do not reuse Windows provider
binaries. Lock provider checksums for `linux_arm64` as well as other supported
developer platforms.

The current Windows and WSL Azure contexts agree:

- Approved subscription: `ME-MngEnvMCAP580211-isarar-1`
  (`79e1d757-ecdb-4dc3-b0b4-035bac76053d`).
- Approved tenant: `ddcbdc96-6162-4d91-bb0d-066343049ce1`.
- Region: `southeastasia` (Singapore).
- Application prefix: `tmma79e118`; dedicated state account: `tmmastate79e118`.
- Separate remote state keys: `bootstrap/state.tfstate` and `teams-agent/dev.tfstate`.

Preflight confirms subscription Owner, Storage Blob Data Contributor, and Entra
permission to register applications. Required resource providers are registered.
Southeast Asia supports ACA and Cosmos DB, with regular Cosmos subscription access.
ACA environments: 3 used of 50; regional storage accounts: 17 used of 250.
Indexed subscription policy requires `env=dev` on taggable resources; both roots
receive this tag. No unrelated resources or existing state backends will be adopted.

Validation and deployment run in two phases: first the separate backend bootstrap
with intentionally empty local state, then the main configuration using the new
remote backend. Each phase requires its own reviewed create-only saved plan.
The backend dependency prevents main remote initialization before bootstrap.
Runtime remains disabled: no provider secrets, model calls, image release, or
Teams installation/publication are part of this apply. ACA's warm replica, ACR,
storage, and telemetry can incur ongoing charges.

Execution sequence once the context is confirmed:

1. Validate the application and Terraform offline in Ubuntu WSL.
2. Confirm subscription/tenant, region, resource naming, budget, and remote-state
   backend; check service availability, quotas, Entra permissions, and RBAC.
3. If necessary, separately review and apply the backend bootstrap in WSL.
4. Initialize the main Terraform configuration against that remote backend.
5. Generate a saved plan with `runtime_enabled=false`, inspect its resource changes,
   and present the exact provisioning scope and costs for approval.
6. After Azure validation, use the Azure deployment workflow to apply that reviewed
   saved plan through WSL. Re-plan if inputs or remote state change.
7. Verify outputs and bootstrap resource health. Explicitly distinguish a bootstrap
   from the functional model-serving app.
8. Populate secrets securely outside Terraform, verify model IDs, stage the image,
   and review the second plan enabling runtime only when separately approved.

Example command shape from PowerShell at the repository root:

```powershell
wsl --distribution Ubuntu --exec env TF_DATA_DIR=.terraform-wsl terraform -chdir=infra init -backend=false -input=false -lockfile=readonly
wsl --distribution Ubuntu --exec env TF_DATA_DIR=.terraform-wsl terraform -chdir=infra validate
# After backend/context confirmation:
wsl --distribution Ubuntu --exec env TF_DATA_DIR=.terraform-wsl terraform -chdir=infra plan '-out=deployment.tfplan'
# Only after approving that exact plan:
wsl --distribution Ubuntu --exec env TF_DATA_DIR=.terraform-wsl terraform -chdir=infra apply deployment.tfplan
```

Saved plans and state are sensitive operational artifacts and remain ignored.
No `-auto-approve`, implicit subscription switch, credential-cache copying, or
automatic Teams publication is part of this plan.

## Local evidence

- TypeScript build, lint, mock-provider tests, Cosmos persistence tests, native
  Teams streaming/HTTP integration, and deployment-script tests pass.
- Docker production image builds; container health/readiness succeed and
  unauthenticated messages are rejected.
- Toolkit packages and validates the Teams manifest with test-only identifiers.
- Terraform main and backend bootstrap configurations validate successfully in
  Ubuntu WSL using Linux ARM64 providers; checksums are locked.
- Windows Node scripts support `--wsl` for all Terraform calls. Toolkit lifecycle
  and VS Code Terraform task explicitly select WSL.
- Managed-identity Application Insights ingestion is wired with scoped access.

These checks do not validate subscription quotas, live RBAC/secret resolution,
provider credentials, Teams publication, or a real Terraform cloud plan.

## Validation checklist

- [x] All validation checks pass
  - [x] Terraform installed in Ubuntu WSL.
  - [x] Azure CLI installed and an authenticated account is present in WSL.
  - [x] Confirm the target subscription/tenant, region, and backend.
  - [x] Run Terraform init against the confirmed remote backend.
  - [x] Terraform formatting passes.
  - [x] Terraform validate passes offline for main and bootstrap configurations.
  - [x] Generate/review a real Terraform plan with confirmed inputs.
  - [x] Inspect state through the confirmed backend.
  - [x] Complete the recipe template-variable/JSON checks where applicable.
  - [x] Validate region availability, quotas, Azure Policy, and required roles.
  - [x] Application tests, build, lint, container, and Teams package checks pass.

Azure validation and deployment completed for both phases. Phase-specific evidence
is recorded below; runtime activation remains a separate deployment.

## Backend bootstrap validation evidence

The Terraform recipe runner passed every applicable check in `infra/bootstrap`
using Ubuntu WSL and the default workspace. Since this is a fresh local backend,
an empty version-4 state was initialized with non-forced `terraform state push`
before verifying state access. No existing resources were imported or overwritten.
`main.tfvars.json` is absent, so its JSON-only check is not applicable.
The exact saved plan `infra/bootstrap/tfplan` contains five creates, no updates,
and no deletes: dedicated resource group, Entra-only storage account, blob
protection settings, private state container, and container-scoped operator role.
The production TypeScript build passed again. Main remote validation remains
pending until the backend exists.

## Role Assignment Verification

Status: Verified statically for both Terraform roots.
The backend operator receives Storage Blob Data Contributor only on `tfstate`.
The application UAMI receives AcrPull on its registry, Key Vault Secrets User on
its vault, Monitoring Metrics Publisher on its App Insights component, and Cosmos
DB Built-in Data Contributor on `teams-agent/conversations`. These match runtime
operations; no application identity receives subscription-wide management roles.
Local development uses mocks and requires no live data-plane grants.

## Section 7: Validation Proof

Approved pilot-page image release (2026-09-21):

- `npm run typecheck`, `npm run lint`, `npm run build`: PASS.
- `vitest run` on config, providers-bootstrap, playground, pilot-pages, app,
  and deployment suites: 161 tests PASS.
- `compare-aca-release.mjs`: bounded authenticated reads of deployed ACR image;
  only new pilot-page module, page route registration, and already-requested
  production-rejected local opt-in differ. Production dependencies unchanged.
- `node scripts\deploy.mjs --wsl --deploy --verify-only`: PASS for baseline.
- Terraform recipe `validate-terraform.sh ./infra` using `.terraform-wsl`:
  all applicable checks PASS; optional JSON tfvars syntax check N/A.
- `terraform show -json tfplan`, projected to resource action counts:
  zero resource changes. No Terraform apply is part of this release.
- `az policy state list` for existing ACA, filtered to NonCompliant: empty.
- Static role review: resource-scoped AcrPull, Key Vault Secrets User,
  Monitoring Metrics Publisher, container-scoped Cosmos data contributor.
- User explicitly approved the displayed local page content for public ACA
  hosting. Local mock preview page/health probes returned HTTP 200. Missing
  and invalid channel tokens are rejected by the real-SDK HTTP tests.
- Docker build context excludes dotenv, environment files, Terraform, Git,
  tests, app packages, plan files, and now unrelated `docs` screenshots.

Gemini configuration-only enablement (2026-09-21, 12:26-12:33 +07:00):

- `upload-gemini-secret.mjs check`: current saved key present; vault read allowed;
  `gemini-api-key` missing. Existing vault-scoped operator access is sufficient.
- WSL Terraform `validate-terraform.sh infra` with `TF_DATA_DIR=.terraform-wsl`:
  all applicable checks PASS (tools, authentication, init, fmt, validate, plan,
  state access, template scan); JSON tfvars check N/A.
- `terraform show -json tfplan` reviewed with in-memory assertions: exactly
  `azurerm_container_app.agent` updated in place. Zero creates/deletes.
  Only ENABLED_PROVIDERS, GEMINI_BASE_URL, GEMINI_MODEL, and GEMINI_API_KEY
  environment entries plus the managed-identity `gemini-api-key` reference change.
- Image, registry, identity, ingress, CPU/memory, replica scale, authenticated
  production mode, Cosmos, and existing provider settings are unchanged.
  Existing secret references are preserved; empty values normalize to null.
  No secret values enter Terraform. Bot streaming state is preserved explicitly.
- `npx vitest run tests/config.test.ts tests/providers-bootstrap.test.ts
  tests/deployment.test.ts`: 146 tests PASS. `npm run build`: PASS.
- Static role review PASS: resource-scoped AcrPull, Key Vault Secrets User,
  Monitoring Metrics Publisher, and container-scoped Cosmos data contributor.
- Reuse deployed image/build `cm2`; no unrelated local changes are shipped.
  Local Gemini Playground streaming was verified earlier today. Cloud model
  access from the new ACA revision remains a post-deployment verification.

Two-provider runtime activation proof (2026-09-18, after 22:41 +07:00):

- Operator-created bot credential verified by acquiring a Bot Framework token;
  token and secret values never logged/persisted. All three KV secrets enabled.
- WSL Terraform validation recipe: all applicable checks PASS; JSON check N/A.
- Saved `infra/tfplan` inspected in memory: exactly one in-place ACA update,
  zero creates/deletes, runtime enabled, only `claude,azure-openai`, live mode,
  Cosmos state, bootstrap command removed, and only the three expected KV refs.
- Image remains validated ACR build `cm2`; identity, ingress, and registry
  configuration are unchanged. No inline secrets exist in the plan.
- Deployment/configuration/authentication/provider-bootstrap tests: 126 PASS.
  Production TypeScript build PASS; earlier complete 392-test suite also passed.
- Static role relationships remain resource/container scoped. Live preflight
  confirmed AcrPull, Secrets User, telemetry publisher, and Cosmos data role.
- Approved subscription/tenant and existing Southeast Asia RG verified.
- No activation gate remains. Teams installation and end-to-end conversation
  testing are separate from this API deployment.

Two-provider image-staging proof (2026-09-18, after 21:47 +07:00):

- `npm run check` and `npm run build`: PASS, including 392 tests in 10 files.
- WSL Terraform recipe runner: all applicable checks PASS (init, formatting,
  validate, plan, state access, template scan); JSON tfvars check N/A.
- `terraform show -json tfplan`, inspected in memory: zero managed-resource
  changes; runtime disabled; enabled providers exactly `claude,azure-openai`.
- Release build-context guard PASS; root dotenv, environment files, Terraform,
  state, and plan artifacts remain excluded from ACR upload.
- Static role review confirms resource-scoped AcrPull, Secrets User, telemetry
  publisher and container-scoped Cosmos data access for the runtime UAMI.
- Both CLI contexts match the approved target. Existing runtime roles were also
  confirmed live before staging; no new resource or permission is needed.
- This validates image staging only. Bot credential creation remains unapproved
  and runtime activation is NOT validated.

Application-image staging proof (2026-09-18T08:43:36+07:00):

- Current WSL Terraform recipe: all applicable checks PASS; JSON check N/A.
  A transient public provider-registry timeout was resolved by retrying with a
  30-second registry timeout; no provider/version/checksum changes were made.
- Plan JSON confirms zero managed-resource changes and `runtime_enabled=false`.
- Typecheck, lint, all 210 tests, and production build PASS.
- Windows release CLI subscription/tenant match the approved WSL target.
- Build context guard includes `plan`; credentials/state/environment directories
  remain excluded. The Dockerfile consumes only package/config/source inputs.
- The already-verified UAMI image-pull role and scoped runtime roles are unchanged.
- This validation covers staging under the bootstrap command only, not model
  runtime activation, secret entry, or Teams installation.

Final post-deployment proof (2026-09-18T08:09:02+07:00):
WSL Terraform recipe passed again after aligning canonical Cosmos location and
Consumption workload profiles. Plan JSON confirmed zero managed-resource changes.
The saved-plan apply persisted state reconciliation with 0 added/changed/destroyed.
Remote state pulls confirmed distinct lineages and counts of 20 main managed
resources and 5 bootstrap resources. HTTPS, provisioning, live RBAC, TTL, and
authentication settings were verified as recorded in the current outcome above.
The production build and 41 deployment-script tests passed. Toolkit sync completed
using `node scripts\sync-toolkit-env.mjs --wsl`.

Pre-apply scope: main infrastructure in disabled-runtime bootstrap mode.
Validated at 2026-09-18T07:55:29+07:00:

- WSL `terraform init -backend-config=backend.hcl`: separate main remote backend
  initialized using Entra authentication.
- Main Terraform recipe: all applicable checks PASS, including remote state
  access; JSON check N/A.
- `terraform show -json tfplan`: reviewed all 20 creates, 0 changes, 0 deletes.
  Target subscription, tenant, region, resource names, RG-only exception, and
  least-privilege role relationships match the approved plan.
- ACA: public HTTPS only, port 3978, 1-3 replicas, no secrets/environment/model
  credentials, public Node bootstrap image, `runtime_enabled=false`.
- Production build already passed in this deployment turn; no application source
  has changed since. ACA environment usage reconfirmed at 3/50.
- Bootstrap migration preserved all five resources and lineage; its remote-backed
  plan reports zero drift.

Earlier scope: backend recovery before remote migration.
Validated at 2026-09-18T07:49:11+07:00:

- WSL Terraform recipe in `infra/bootstrap`: all applicable checks PASS.
- Saved `infra/bootstrap/tfplan`: only `azapi_resource.state` updates in place,
  changing `publicNetworkAccess` from `Disabled` to `Enabled`; no creates/deletes.
- Approved subscription and tenant reconfirmed; live RG exception tag verified.
- Production build PASS; RBAC scope and identity relationships unchanged.
- Main phase will be independently validated after remote state is available.

Previous scope: explicitly requested resource-group tag update only.
Validation completed: 2026-09-18 at approximately 07:14 +07:00.

- Bootstrap Terraform recipe: all applicable checks passed; JSON check N/A.
- Main Terraform: restored locked Linux ARM64 providers with backend disabled;
  syntax validation passed. This is not a main deployment plan.
- Saved `infra/bootstrap/group-tags.tfplan`: 0 creates, 1 in-place resource-group
  update, 0 deletes. Only `SecurityControl=Ignore` is added; `env=dev` is preserved.
- Targeting is used solely for this explicit, exceptional policy-recovery tag
  update so unrelated storage drift is not applied.
- Production build and all 41 deployment tests passed.
- RBAC assignments and authentication configuration are unchanged.
- Both roots accept optional RG-only tags; shared resource tags are unchanged.

Original backend bootstrap validation:
Validation completed: 2026-09-18T00:50:49+07:00.

| Command/check | Result |
| --- | --- |
| WSL `validate-terraform.sh .../infra/bootstrap` with `TF_DATA_DIR=.terraform-wsl` | All applicable checks PASS; JSON check N/A |
| WSL `terraform -chdir=infra/bootstrap show -json tfplan` | Reviewed: 5 creates, 0 changes, 0 destroys; approved target |
| `npm run build` | PASS |
| Azure quota/usage and provider-region queries | ACA 3/50; storage 17/250; requested region available |
| Azure role assignments and Entra authorization policy | Provisioning Owner and app creation permitted |
| Subscription policy inspection | Required `env=dev` configured on taggable resources |
| Static role review | Least-privilege data-plane roles verified |

At the original backend-only validation stage, main application infrastructure
had not yet been validated or deployed; the current outcome supersedes that stage.

## Initial deployment result and governance blocker (resolved)

Backend apply completed on 2026-09-18 at approximately 00:53 +07:00:
five resources added, none changed or destroyed. Resource group:
`tmmastate79e118-rg`; storage account: `tmmastate79e118`; private container:
`tfstate`. The account is provisioned with shared keys and anonymous blob access
disabled, TLS 1.2, versioning and retention protections. The operator's
container-scoped data role exists.

An inherited management-group policy modified the storage PUT during creation:
`StorageAccount_PublicNetwork_Modify`, within assignment `MCAPSGovDeployPolicies`.
The Activity Log records the modify action at 2026-09-17T17:52:02.3410346Z.
The live account reports `publicNetworkAccess=Disabled` despite the requested
`Enabled` setting; authenticated WSL blob/container access is blocked.
Subscription-only policy listing did not reveal this inherited assignment.
The inherited policy definitions also disable ordinary public access to Key Vault
and Cosmos DB. Management-group assignment enumeration is forbidden to this
operator, although the relevant policy definitions and resource activity are readable.

At that initial blocked stage, no policy exclusions, exemption tags, broad access
rules, security overrides, or alternate resources were applied.
Public access through a fully configured,
enforced Network Security Perimeter is explicitly permitted by the relevant
definitions; private endpoints with a reachable execution network are another
possible compliant design. Either requires a revised network plan covering the
state backend and runtime dependencies, not just retrying the current apply.
The public ACA bot endpoint can remain a separate design concern.

The bootstrap still uses the **default workspace and local state**:
`infra/bootstrap/terraform.tfstate`. Preserve it and its protected backup.
Remote migration was not performed. The provisional `backend.tf` was removed
so subsequent bootstrap commands do not incorrectly assume a migrated backend.
Do not initialize the main root or recreate/import the backend resources until
the networking issue is resolved and the existing state is migrated.
The prepared backend HCL files remain ignored, with separate keys.

The application resource group `tmma79e118-rg` does not exist: no ACA app,
bot identity, model runtime, or Teams publication was created. There is no
application HTTPS endpoint yet. Created backend resources remain in place and
may incur small ongoing storage charges; no deletion was attempted.

Post-change production build and all 41 deployment-script tests passed.
This does not resolve the cloud networking blocker.
