# Teams multi-model agent deployment plan

Status: Application image staged and verified; activation blocked on human credentials/login.

## Current application image staging result

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
