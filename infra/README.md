# Infrastructure and releases

All Terraform lives here, including optional backend bootstrap. Terraform owns
Azure resources, identity metadata, RBAC, runtime settings, secrets **references**,
probes, and scaling. Release tooling owns only the ACA image and managed-identity
registry attachment. Toolkit packages the existing bot; **do not create another
Entra application, service principal, bot or bot password in Toolkit**.

Implementation is not deployment approval. No provisioning, Azure authentication,
secret creation, Teams publication or live provider calls were performed as part
of implementation.

## Current pilot deployment status

The approved WSL apply created the dedicated backend in `tmmastate79e118-rg`.
After the approved exception tag, its public endpoint was restored with Entra-only
authentication. Bootstrap state is now migrated to `bootstrap/state.tfstate`
in the private `tfstate` container of `tmmastate79e118`, using the default workspace.
Lineage and all five resources were preserved, and its remote-backed plan has no
drift. The main root uses the separate `teams-agent/dev.tfstate` key.
**Main infrastructure is deployed:** 20 managed resources in `tmma79e118-rg`,
Southeast Asia. Both roots have no pending resource changes.
The public bootstrap health endpoint is
https://tmma79e118-app.blackdesert-f956b6ef.southeastasia.azurecontainerapps.io/healthz.
It returns `{"status":"bootstrap","ready":false}`; the model-serving application
is not activated. The real application image is staged as
`teams-agent:release-20260918t014444560z-96f3405d14db` in `tmma79e118acr`,
on ready revision `tmma79e118-app--0000001`, still running the bootstrap command.
Credential entry and Teams login/metadata remain human gates.
See `.azure/deployment-plan.md` for phase-specific evidence and the image digest.
Retained local backups are not active state.

Inherited policies also restrict public access to Key Vault and Cosmos DB.
The user subsequently approved `SecurityControl=Ignore` at resource-group level
for this pilot. It is applied to both project resource groups. Both ignored tfvars
configure it through `resource_group_tags`; this optional map defaults to empty
and is merged only into resource-group tags.
It overrides matching shared tags without copying the exception onto resources.
Only configure governance exceptions with explicit approval for the target groups.
An exception tag does not itself re-enable an already-disabled endpoint.
A subscription-only policy listing is insufficient: inspect inherited
management-group policies and verify actual data-plane connectivity.

## Prerequisites and approval gates

- Node 22 LTS; Terraform >=1.9 and <2; Azure CLI with `containerapp` and ACR build
  support. The locked provider versions have been validated against this pilot's
  live Azure provisioning. Cosmos uses the canonical region display name and ACA
  declares the Consumption profile explicitly to avoid normalization-only drift.
- Terraform provider binaries must exist for your platform. On this Windows ARM64
  workstation, use native **Ubuntu WSL2**: `/usr/bin/terraform` is version **1.15.3**
  for **linux_arm64**, and both Terraform roots validate successfully there.
  The lockfiles include signed Linux ARM64, Linux AMD64 and Windows AMD64
  checksums. Native Windows ARM64 lacks required provider packages; the attempted
  Linux AMD64 Docker fallback crashes under emulation. Do not bypass checksum
  verification or weaken host security.
- Explicitly confirm subscription, tenant, region, unique resource prefix,
  availability/capacity, pilot costs, external-provider processing policy,
  provider model access, custom Teams app policy and change approval.
- Azure provisioning identity: Contributor plus permission to create the listed
  RBAC assignments (e.g. appropriately scoped RBAC Administrator). Microsoft
  Graph permission to create application/service-principal metadata is separate;
  use least-privilege application-management rights permitted by your tenant.
- Register `Microsoft.App`, `Microsoft.ContainerRegistry`, `Microsoft.ManagedIdentity`,
  `Microsoft.KeyVault`, `Microsoft.DocumentDB`, `Microsoft.OperationalInsights`,
  `Microsoft.Insights`, `Microsoft.BotService`, and `Microsoft.Storage` beforehand.
  Terraform does not implicitly register providers.
- State operator: Storage Blob Data Contributor on the state container. Release
  operator: ACR Tasks build permissions, ACA read/update/registry permissions and
  Managed Identity Operator on the runtime UAMI as applicable. The runtime UAMI
  receives AcrPull, Key Vault Secrets User on this dedicated vault, and Cosmos
  built-in Data Contributor scoped to this application's container, plus Monitoring
  Metrics Publisher scoped only to its Application Insights component.
- Authenticate separately using approved Azure CLI/Entra access or federated CI.
  No script runs `az login`, selects a global subscription, creates credentials or
  installs tooling. Every release Azure command supplies `--subscription`.
- Windows scripts use the Azure CLI's bundled `python.exe -IBm azure.cli`, not
  `cmd.exe`/`shell:true`. Set `AZURE_CLI_PYTHON` to its absolute path if automatic
  discovery beside the installed `az.cmd` cannot find it.

## Windows Node scripts with Ubuntu Terraform

All three scripts accept **`--wsl`**, explicitly opting Terraform into the default
project-supported distribution **Ubuntu**. Omitting this flag retains native
Terraform execution. Windows Node remains the script runtime; no Node installation
inside Ubuntu is required.

Each Terraform invocation is a child process argument array:
`wsl.exe --distribution Ubuntu --exec terraform -chdir=infra ...`.
There is no shell, shell command interpolation, or embedded PowerShell/Bash
expression. WSL maps the inherited repository working directory. Windows
`--backend-config` and `--var-file` paths are converted with `wslpath -a -u`;
absolute POSIX paths are preserved as files inside Ubuntu. Relative configuration
paths are resolved against the repository root before mapping.

The default WSL provider/backend metadata directory is **`infra/.terraform-wsl/`**,
ignored by Git and excluded from the build context, separate from native
`infra/.terraform/`. The wrapper forwards its mapped POSIX path through child-only
`TF_DATA_DIR`/`WSLENV`; it does not modify the parent process environment.
Optionally pass **`--wsl-data-dir /absolute/posix/path`** to use an operator-owned,
persistent directory inside Ubuntu. This option requires `--wsl` and rejects
native `.terraform` cache paths. Use the **same directory and WSL flag on every
provision, sync and release invocation**; backend initialization belongs to that
directory. Do not use disposable offline-validation caches for real provisioning.

After the parent/operator completes target/backend confirmation and authorization:

```text
node scripts/provision.mjs --wsl --init --backend-config infra/backend.hcl
node scripts/provision.mjs --wsl --var-file /home/operator/config/pilot.tfvars
node scripts/provision.mjs --wsl --apply --var-file /home/operator/config/pilot.tfvars
node scripts/sync-toolkit-env.mjs --wsl
node scripts/deploy.mjs --wsl --deploy --verify-only
```

The first two commands **plan only**, but can access Azure/the backend; they are
not offline validation. `--apply` still requires explicit operator authorization
and Terraform interactive confirmation. No target subscription has been implicitly
selected or approved by adding WSL support.

For npm wrappers, append options after `--`, e.g.
`npm run infra:plan -- --wsl` or
`npm run toolkit:sync -- --wsl --wsl-data-dir /home/operator/.cache/teams-agent-tf`.
`deploy.mjs --wsl` moves **only its Terraform output read** into Ubuntu; ACR/ACA
release commands still use the caller platform's Azure CLI and explicit
subscription from validated output. Therefore confirm the relevant CLI identities
separately: Windows and Ubuntu Azure login caches are not interchangeable. The
wrapper forwards only `TF_DATA_DIR` automatically; any federated authentication
environment forwarding must be configured explicitly by the operator via
`WSLENV` according to policy, not assumed or inferred.

## Remote state: existing backend preferred

Copy `backend.hcl.example` to ignored `infra/backend.hcl` and fill identifiers
only. Configure a dedicated blob key for this application/environment. Use Entra
authentication (`use_azuread_auth=true`), never storage account keys, SAS tokens or
client secrets in backend files. For federated automation use the Terraform
Azure backend's supported `ARM_USE_OIDC`, `ARM_CLIENT_ID`, `ARM_TENANT_ID` and
`ARM_SUBSCRIPTION_ID` environment configuration; obtain assertions via your CI
platform, never commit them. Existing Azure CLI authentication is suitable for
an interactive operator. Restrict state access, review state access logs, and
retain blob versions; even secret-free state contains security-relevant metadata.

Optional new backend setup lives in `bootstrap/`. This is a **separate state
owner**, not a module nested inside application state:

1. Set nonsecret bootstrap variables in ignored `infra/bootstrap/terraform.tfvars`
   (`subscription_id`, `tenant_id`, `location`, globally unique
   `storage_account_name`, and `state_operator_object_id`). Set `tags` in both
   bootstrap and application variables to meet subscription policy; this pilot's
   subscription requires `tags = { env = "dev" }` on taggable resources.
2. With separate explicit approval, run:

   ```text
   terraform -chdir=infra/bootstrap init
   terraform -chdir=infra/bootstrap plan
   terraform -chdir=infra/bootstrap apply
   ```

   Apply prompts interactively; never use `-auto-approve`.
3. Keep its initial local state on an access-controlled encrypted volume. Do not
   share it, add it to source control or leave it on an ephemeral CI runner.
4. After RBAC propagation, copy `bootstrap/backend.tf.example` to
   `infra/bootstrap/backend.tf` and supply a bootstrap backend config under
   `infra/bootstrap/backend.hcl`, using its backend output identifiers but
   **key `bootstrap/state.tfstate`**, not the application's key. Migrate:

   ```text
   terraform -chdir=infra/bootstrap init -migrate-state -backend-config=backend.hcl
   ```

   Review migration prompts and verify remote state before securely disposing of
   local state/backups according to policy. Blob container/account/resource group
   have `prevent_destroy`; storage uses Entra-only access, no public blobs, HTTPS,
   TLS1.2, versioning and 30-day soft deletion.
5. Application state uses `teams-agent/dev.tfstate` (or another separately
   approved key). Never mix bootstrap and application state or run a destructive
   bootstrap teardown as part of application cleanup.

## First deployment: three explicit stages

The missing-image and missing-secret dependencies are independent. Do **not**
activate runtime against an empty vault or a placeholder image. These steps avoid
both failures without placing credentials in Terraform or giving release scripts
ownership of runtime configuration.

### 1. Provision credential-free bootstrap

Copy `terraform.tfvars.example` to ignored `infra/terraform.tfvars`. Set approved
IDs/region/name, leaving `runtime_enabled=false`. Model and endpoint values may
remain empty during bootstrap. Do not change an existing ignored tfvars file
or its runtime state merely to try the new provider configuration.

From the repository root:

```text
node scripts/provision.mjs --init --backend-config infra/backend.hcl
node scripts/provision.mjs --apply
```

The first command initializes the explicitly selected backend, validates and
**plans only**. The second validates/plans again and runs interactive apply.
An optional `--var-file PATH` is resolved relative to the repository root and
passed to both plan and apply; use the same file on every invocation. Terraform
always executes with `-chdir=infra`. `TF_CLI_ARGS*` are rejected to prevent hidden
approval, targeting or destructive flags from overriding the safety gate.

The initial ACA runs public `node:22-alpine` with a tiny inline Node HTTP server
on port 3978. No registry attachment, Key Vault references, runtime environment
variables or application credentials exist in this container configuration.
`/healthz` returns `{"status":"bootstrap","ready":false}`; all other paths return
503. This is deliberately **not a functioning agent** and must not be published
as ready. Ingress is public HTTPS only, with one warm replica and at most three.

The mutable public bootstrap tag is a known limitation, not a production image
pin. Review/allowlist the official Node image in your supply-chain process.

### 2. Populate secrets securely, then stage the real image

Read public IDs with `terraform -chdir=infra output -json deployment`. An approved
operator with temporary access to the Entra application and Key Vault should:

1. In the Entra portal, open the **existing** application identified by `bot_id`
   and `bot_application_object_id`; create an expiring client credential using
   your organization's approved password-management procedure. Do not create a
   second app and do not use Terraform's `azuread_application_password`.
2. Transfer that credential directly to the dedicated vault as `bot-client-secret`
   using the approved secure secret-entry flow. Do not paste values into chat,
   command arguments/history, logs, dotenv files, screenshots, tfvars or tickets.
3. Populate the keys for **enabled providers only** from the approved credential
   source using that same process: `anthropic-api-key` for Claude,
   `gemini-api-key` for Gemini, and `azure-openai-api-key` for Azure OpenAI.
   Alternate secret **names** can be configured with `secret_names`; no secret
   values or Terraform secret reads. The bot credential is always required.
4. Confirm the bot secret and every enabled provider's secret have enabled,
   nonexpired current versions and that
   the runtime UAMI's Key Vault role has propagated. The Terraform identity does
   not need permission to read secret values; give the setup operator temporary
   Key Vault Secrets Officer access according to policy, not broad permanent
   application access.
5. Verify inference bases and model/deployment names against your provider
   accounts and configure enabled providers as described below. Terraform does
   not choose model names, retrieve credentials, or verify inference access.

#### Provider configuration (nonsecret)

`enabled_providers` defaults to `["claude", "gemini"]` for backward compatibility.
It must be a nonempty list of unique IDs from `claude`, `gemini`, `azure-openai`.
Explicit Claude-only: `enabled_providers = ["claude"]`; all three:
`enabled_providers = ["claude", "gemini", "azure-openai"]`.

| Enabled provider | Required base variable | Required model/deployment variable | Key Vault name by default |
| --- | --- | --- | --- |
| `claude` | `anthropic_base_url` | `claude_model` | `anthropic-api-key` |
| `gemini` | `gemini_base_url` | `gemini_model` | `gemini-api-key` |
| `azure-openai` | `azure_openai_base_url` | `azure_openai_deployment` | `azure-openai-api-key` |

Before live activation, set explicit HTTPS bases, without credentials, query,
fragment, whitespace, or Foundry `/api/projects/...` paths. Example route shapes
for the supplied hostname (not verified deployments or reachability):

```hcl
enabled_providers    = ["claude"]
anthropic_base_url   = "https://aif-isaru66-mcap.services.ai.azure.com/anthropic"
gemini_base_url      = "https://generativelanguage.googleapis.com"
azure_openai_base_url = "https://aif-isaru66-mcap.services.ai.azure.com/openai/v1"
# Set claude_model to the exact deployed Claude alias before runtime activation.
```

Claude appends `/v1/messages`; Gemini appends `/v1beta/models/...`; Azure OpenAI
appends `/chat/completions` to its `/openai/v1` base. Do not include those
operations in the base or use the Foundry project endpoint. There is no gateway
mode or custom auth-header option. Native API-key headers are `x-api-key` (with
`anthropic-version`) for Claude, `x-goog-api-key` for Gemini, and `api-key` for
Azure OpenAI.

Live preconditions require only enabled providers' base/model settings. Model
identifiers use letters/digits plus `.`, `_`, `-`, begin with a letter/digit, and
are at most 200 characters. Azure Claude accepts deployment aliases without a
`claude-opus-` prefix; verify the intended underlying model in deployment details.
Model discovery is optional and not assured on Foundry. **Migration:** existing
live tfvars must now supply explicit inference bases before their next approved
plan/apply; no default public endpoint is inferred.

ACA receives `ENABLED_PROVIDERS`, all three `*_BASE_URL` settings, `CLAUDE_MODEL`,
`GEMINI_MODEL`, and `AZURE_OPENAI_DEPLOYMENT` as nonsecret environment variables.
The bot secret reference is unconditional in live mode. Each provider's secret
reference and secret environment entry exists only when that provider is enabled.
Bootstrap receives neither runtime environment nor any secret reference.
`secret_names.azure_openai_api_key` is optional with default
`"azure-openai-api-key"`: existing three-field `secret_names` objects still work.
Only **names** are accepted in Terraform; secret values remain outside state.
Terraform cannot check secret values or versions; ACA resolves references later.

This change does not enable the deployed runtime, provision a model, or verify
provider access. Before a future Azure OpenAI rollout, drain old revisions that
do not understand the third provider/history bucket. Reset conversations when
changing endpoint data boundaries; provider history is not keyed by hostname.

Stage the built application while retaining the harmless bootstrap command:

```text
node scripts/deploy.mjs --deploy --prepare-runtime
```

This builds a unique `teams-agent:release-<UTC>-<random>` Linux AMD64 image in ACR,
attaches registry access using the UAMI, updates the ACA image, and verifies the
**bootstrap** health response. It does not activate application code or claim
runtime readiness. Revision verification waits with bounded polling for the
latest revision, never accepting an older healthy revision. To verify an already
staged image without another build or configuration change, run
`node scripts/deploy.mjs --wsl --deploy --prepare-runtime --verify-only`.
The parent-owned Docker image **must include `node` on PATH**
and start normally through its image entrypoint/CMD when the override is removed
(the repository Dockerfile uses `node dist/index.js`).

The root `.dockerignore` must exclude `.env`, `.env.*`, `env`, `infra`, `.azure`,
`.git`, `node_modules`, and repository planning artifacts in `plan`. The release guard refuses missing exclusions or
negations before upload. Do not put unrelated confidential files in the build
context; review what the remote ACR build receives.

### 3. Activate Terraform-owned runtime and verify

Persist `runtime_enabled=true` **in the same ignored tfvars file used for all
subsequent plans/applies**. Do not use a one-off `-var` override and then revert to
the false default. Check the bot and all enabled-provider secret versions exist
before proceeding. Activation still requires separate approval.

```text
node scripts/provision.mjs
node scripts/provision.mjs --apply
node scripts/deploy.mjs --deploy --verify-only
node scripts/sync-toolkit-env.mjs
```

Terraform removes the bootstrap command, attaches versionless Key Vault references
via the runtime UAMI, and sets production configuration. The already-staged image
is preserved by the image-only ignore rule. Missing or invalid enabled-provider
inference bases or model/deployment names block the plan;
missing/disabled secrets or delayed Key Vault RBAC block activation in ACA.
Runtime must fail closed if any required configuration is missing—no local/mock
provider or memory-store fallback in production. Check your application's startup
validation and Cosmos initialization separately.

`--verify-only` checks that runtime is enabled, the bootstrap override is gone,
the image belongs to the expected ACR release repository, and HTTPS `/healthz`
returns 200 JSON `{"status":"healthy"}` (optionally `ready:true`; `ready:false` is rejected).
It also requires `/readyz` to return 200 JSON `{"status":"ready"}`, rejecting
draining instances even when their liveness endpoint is still healthy.
Redirects, arbitrary 200 HTML, and bootstrap health are not runtime success.
Retries are bounded (30 attempts, 10-second timeout per request, 10-second spacing).
ACA uses `/readyz` for runtime readiness, `/healthz` for liveness/startup, and
120 seconds of termination grace so the 90-second stream deadline can drain
after SIGTERM. During bootstrap only, the readiness probe also uses `/healthz`.

## Runtime contract

Terraform configures:

| Variable | Source |
|---|---|
| `NODE_ENV`, `PORT` | `production`, `3978` |
| `CLIENT_ID`, `TENANT_ID` | Existing single-tenant bot Entra application and tenant |
| `CLIENT_SECRET` | UAMI Key Vault reference `bot-client-secret` |
| `ENABLED_PROVIDERS` | Comma-joined `enabled_providers` list |
| `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `AZURE_OPENAI_API_KEY` | UAMI Key Vault references, enabled providers only |
| `ANTHROPIC_BASE_URL`, `GEMINI_BASE_URL`, `AZURE_OPENAI_BASE_URL` | Independent explicit inference bases; required for enabled providers |
| `CLAUDE_MODEL`, `GEMINI_MODEL`, `AZURE_OPENAI_DEPLOYMENT` | Verified model/deployment names; required for enabled providers |
| `AZURE_CLIENT_ID` | Runtime UAMI client ID; **not the bot client ID** |
| `COSMOS_ENDPOINT` | Public account endpoint, local/key authentication disabled |
| `COSMOS_DATABASE`, `COSMOS_CONTAINER` | `teams-agent`, `conversations` |
| `STATE_STORE`, `PROVIDER_MODE` | `cosmos`, `live` |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | App Insights routing metadata; ingestion requires Entra authentication |

Cosmos uses serverless NoSQL, session consistency, `/id` partitioning and
`defaultTtl=86400`. Application access must use `ManagedIdentityCredential` or
appropriately configured `DefaultAzureCredential` with `AZURE_CLIENT_ID`, never
Cosmos connection strings/keys. The bot client ID is a different principal.
Token-based Cosmos operations, including SDK metadata discovery, need an Azure
smoke test before production approval.

Log Analytics receives ACA system/console logs through Azure Monitor diagnostic
settings, avoiding workspace shared keys. App Insights is workspace-linked and
local-auth disabled (`DisableLocalAuth=true`, the ARM equivalent of
`local_authentication_disabled=true`). Terraform exports only its `ConnectionString`
property into `APPLICATIONINSIGHTS_CONNECTION_STRING` for the runtime container.
This string includes endpoints and an instrumentation identifier: **it is routing
metadata, not an ingestion credential while local authentication is disabled**.
It is intentionally present in Terraform state and ACA configuration, but not
the Toolkit dotenv allowlist. No provider API keys, bot passwords, Cosmos keys,
workspace shared keys, or Entra credential values are introduced into state.

The runtime UAMI receives **Monitoring Metrics Publisher scoped to this App Insights
component only**. The parent-owned Azure Monitor OpenTelemetry setup supplies
`DefaultAzureCredential({ managedIdentityClientId: AZURE_CLIENT_ID })` as exporter
credentials. Never re-enable local authentication or remove authenticated exporter
credentials to work around a 401/403; verify role propagation and the UAMI first.
Bootstrap receives no runtime telemetry environment. Live authenticated ingestion
still requires an approved Azure smoke test. Keep logs and exported spans redacted;
never export prompts, provider bodies, authentication headers or secrets.

## Subsequent releases, drift, and rollback

```text
node scripts/deploy.mjs --deploy
```

Every release builds a unique tag, uses managed-identity ACR pull, updates only
the image, checks the live configured image, and verifies runtime health. There
is no `latest` application tag and no registry password/admin account. Neither
release nor provision publishes Teams. Use `--help` for the exact script flags.

Terraform ignores **only** `template[0].container[0].image` and `registry`. Do not
ignore the template, environment variables, command, identities, probes, secrets,
scaling or ingress. Do not remove those two exclusions or a later apply will
revert release ownership. Keep `runtime_enabled=true`; deliberately disabling it
is a maintenance operation that stops the real agent.

Release failures do not automatically roll back; the tool fails rather than
claiming readiness. Record the previous image emitted by a successful release
and preserve its ACR tag/digest. With separate operator approval, set that known
prior image using `az containerapp update --name <app> --resource-group <rg>
--subscription <subscription> --container-name agent --image <prior-image>
--output none`, then rerun `--deploy --verify-only`. Do not roll back runtime code
across incompatible configuration/data changes. ACA Single revision mode handles
traffic activation, but health checks do not prove bot/provider behavior.

Wait for RBAC propagation before retrying an AcrPull/Key Vault authorization
failure; scripts never enable ACR admin access or substitute raw secrets.
Versionless vault references support operator rotation; verify revision health
after rotation and follow ACA's documented refresh timing/restart procedure.

## Nonsecret output schema for Toolkit

`terraform -chdir=infra output -json deployment` returns a single JSON object
(not Terraform's full output envelope). `schema_version` is numeric `1`;
`runtime_enabled` is boolean. All remaining properties are strings:

```text
subscription_id, tenant_id, resource_group_name,
acr_name, acr_login_server, container_app_name, container_name,
container_app_url, bot_id, bot_application_object_id,
bot_service_principal_id, bot_domain, bot_endpoint,
runtime_identity_id, runtime_identity_client_id,
key_vault_name, key_vault_uri, cosmos_endpoint, cosmos_database, cosmos_container
```

`sync-toolkit-env.mjs` validates the schema and writes only this allowlist to
**ignored** UTF-8 `env/.env.dev`, preserving other variables/comments/Teams IDs:

```text
AZURE_SUBSCRIPTION_ID <- subscription_id
AZURE_TENANT_ID <- tenant_id
AZURE_RESOURCE_GROUP_NAME <- resource_group_name
BOT_ID <- bot_id
BOT_AAD_APP_OBJECT_ID <- bot_application_object_id
BOT_DOMAIN <- bot_domain
BOT_ENDPOINT <- bot_endpoint
BOT_TENANT_ID <- tenant_id
CONTAINER_APP_NAME <- container_app_name
CONTAINER_APP_URL <- container_app_url
ACR_NAME <- acr_name
ACR_LOGIN_SERVER <- acr_login_server
AZURE_CLIENT_ID <- runtime_identity_client_id
COSMOS_ENDPOINT <- cosmos_endpoint
COSMOS_DATABASE <- cosmos_database
COSMOS_CONTAINER <- cosmos_container
```

The script requires Git ignore coverage and an untracked destination, rejects
symlinks, quotes dotenv values, collapses duplicate managed keys, and preserves
unknown multiline variables. It never writes `CLIENT_SECRET`, `SECRET_BOT_PASSWORD`,
provider API keys or credentials of any kind. Existing sensitive local variables
are preserved, not read into Terraform or logged.

Toolkit hooks should run plan-only provisioning by default and env sync only
after a separately approved apply; pass `--deploy` only with explicit release
authorization. Toolkit can use `${{BOT_ID}}`, `${{BOT_DOMAIN}}` and
`${{BOT_ENDPOINT}}` for manifest/package configuration; keep an existing
`TEAMS_APP_ID` separate from the bot application ID. No `aadApp/create`,
`botFramework/create`, password generation or App Service deployment action is
needed.

## Local verification and remaining gates

```text
node node_modules/vitest/vitest.mjs run tests/deployment.test.ts
node node_modules/eslint/bin/eslint.js tests/deployment.test.ts
terraform fmt -check -recursive infra
terraform -chdir=infra init -backend=false -input=false
terraform -chdir=infra validate
terraform -chdir=infra/bootstrap init -backend=false -input=false
terraform -chdir=infra/bootstrap validate
```

Provider installation may download binaries; no backend access occurs with
`-backend=false`. The local deployment tests mock every command and network call.
Terraform formatting, script syntax checks and **both Terraform validations pass**.
The successful environment is the default `Ubuntu` WSL2 distribution, native
`linux_arm64`, Terraform **1.15.3** (`/usr/bin/terraform`). Ubuntu has Azure CLI
installed, but validation did not authenticate or invoke Azure CLI. No WSL Node
installation was found; Windows Node continues to run the mocked script tests.

PowerShell, from the repository root, equivalent repeatable offline validation:

```powershell
wsl --distribution Ubuntu --cd (Get-Location).Path --exec sh -lc 'export TF_DATA_DIR=$(mktemp -d /tmp/teams-agent-main.XXXXXX) CHECKPOINT_DISABLE=1; terraform -chdir=infra init -backend=false -input=false -lockfile=readonly && terraform -chdir=infra validate'
wsl --distribution Ubuntu --cd (Get-Location).Path --exec sh -lc 'export TF_DATA_DIR=$(mktemp -d /tmp/teams-agent-bootstrap.XXXXXX) CHECKPOINT_DISABLE=1; terraform -chdir=infra/bootstrap init -backend=false -input=false -lockfile=readonly && terraform -chdir=infra/bootstrap validate'
```

Both commands isolate provider data from Windows `.terraform/` caches and from
each other. The initial WSL run required adding Linux ARM64 archive hashes using
`terraform -chdir=infra providers lock -platform=linux_arm64` and the equivalent
bootstrap command; both lockfiles now include those signed hashes with unchanged
provider versions. No checksum checks were bypassed.

Validation created only disposable Linux provider caches, downloaded public signed
provider packages, and did not access a remote state backend, Azure resources,
or run plan/apply. For real provisioning, the parent/operator must choose and
persist a separate WSL `TF_DATA_DIR` and approved backend configuration; do not
reuse these temporary offline-validation directories as production backend
configuration. Windows Node scripts can explicitly use Ubuntu Terraform through the `--wsl`
integration documented above. Do not assume Windows and WSL Azure
authentication/cache state are interchangeable.

Before any real deployment, the parent/coordinator must complete Azure validation
and explicit deployment approval. Live checks still required: region/API/SKU
availability, permissions and Graph policy, backend/locks, staged bootstrap
transition and no-secret state inspection, Key Vault reference resolution,
UAMI ACR/Cosmos access, redacted telemetry, startup failure behavior, unauthenticated
bot rejection, authorized Teams chat/Stop/streaming, provider access and cost.
