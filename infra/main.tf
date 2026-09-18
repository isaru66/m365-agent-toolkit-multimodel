data "azurerm_location" "primary" {
  location = var.location
}

locals {
  tags = merge({ application = "teams-multimodel-agent" }, var.tags)
  # This server never authenticates a bot, handles messages or receives credentials.
  # The release image must include Node.js so it can run this command until activation.
  bootstrap_command = [
    "node", "-e",
    "require('node:http').createServer((q,s)=>{s.setHeader('content-type','application/json');s.statusCode=q.url==='/healthz'?200:503;s.end(JSON.stringify({status:'bootstrap',ready:false}));}).listen(3978,'0.0.0.0')"
  ]
  runtime_env = {
    NODE_ENV                              = "production"
    PORT                                  = "3978"
    CLIENT_ID                             = azuread_application.bot.client_id
    TENANT_ID                             = var.tenant_id
    AZURE_CLIENT_ID                       = azurerm_user_assigned_identity.runtime.client_id
    CLAUDE_MODEL                          = var.claude_model
    GEMINI_MODEL                          = var.gemini_model
    COSMOS_ENDPOINT                       = azapi_resource.cosmos.output.properties.documentEndpoint
    COSMOS_DATABASE                       = "teams-agent"
    COSMOS_CONTAINER                      = "conversations"
    STATE_STORE                           = "cosmos"
    PROVIDER_MODE                         = "live"
    APPLICATIONINSIGHTS_CONNECTION_STRING = azapi_resource.insights.output.properties.ConnectionString
  }
  secret_env = {
    CLIENT_SECRET     = "bot-client-secret"
    ANTHROPIC_API_KEY = "anthropic-api-key"
    GEMINI_API_KEY    = "gemini-api-key"
  }
  secret_references = {
    bot-client-secret = var.secret_names.bot_client_secret
    anthropic-api-key = var.secret_names.anthropic_api_key
    gemini-api-key    = var.secret_names.gemini_api_key
  }
}

resource "azurerm_resource_group" "agent" {
  name     = "${var.name_prefix}-rg"
  location = var.location
  tags     = merge(local.tags, var.resource_group_tags)
}

resource "azuread_application" "bot" {
  display_name     = "${var.name_prefix}-bot"
  sign_in_audience = "AzureADMyOrg"
}

resource "azuread_service_principal" "bot" {
  client_id = azuread_application.bot.client_id
}

resource "azurerm_user_assigned_identity" "runtime" {
  name                = "${var.name_prefix}-runtime"
  location            = var.location
  resource_group_name = azurerm_resource_group.agent.name
  tags                = local.tags
}

resource "azurerm_container_registry" "images" {
  name                = "${var.name_prefix}acr"
  location            = var.location
  resource_group_name = azurerm_resource_group.agent.name
  sku                 = "Basic"
  admin_enabled       = false
  tags                = local.tags
}

resource "azurerm_role_assignment" "image_pull" {
  scope                = azurerm_container_registry.images.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.runtime.principal_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_key_vault" "secrets" {
  name                       = "${var.name_prefix}-kv"
  location                   = var.location
  resource_group_name        = azurerm_resource_group.agent.name
  tenant_id                  = var.tenant_id
  sku_name                   = "standard"
  rbac_authorization_enabled = true
  purge_protection_enabled   = true
  soft_delete_retention_days = 90
  tags                       = local.tags
}

resource "azurerm_role_assignment" "secret_reader" {
  scope                = azurerm_key_vault.secrets.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.runtime.principal_id
  principal_type       = "ServicePrincipal"
}

# AzAPI exports only selected public metadata. In particular, do not use the
# AzureRM Cosmos/workspace resources that read account/shared keys into state.
resource "azapi_resource" "logs" {
  type      = "Microsoft.OperationalInsights/workspaces@2023-09-01"
  name      = "${var.name_prefix}-logs"
  parent_id = azurerm_resource_group.agent.id
  location  = var.location
  tags      = local.tags
  body = {
    properties = {
      sku             = { name = "PerGB2018" }
      retentionInDays = 30
    }
  }
  response_export_values = []
}

resource "azapi_resource" "insights" {
  type      = "Microsoft.Insights/components@2020-02-02"
  name      = "${var.name_prefix}-insights"
  parent_id = azurerm_resource_group.agent.id
  location  = var.location
  tags      = local.tags
  body = {
    kind = "web"
    properties = {
      Application_Type    = "web"
      WorkspaceResourceId = azapi_resource.logs.id
      DisableLocalAuth    = true
    }
  }
  # This is routing metadata, not an authentication credential: local/key-based
  # ingestion remains disabled. Only the UAMI's Entra token authorizes ingestion.
  response_export_values = ["properties.ConnectionString"]
}

resource "azurerm_role_assignment" "telemetry_publisher" {
  scope                = azapi_resource.insights.id
  role_definition_name = "Monitoring Metrics Publisher"
  principal_id         = azurerm_user_assigned_identity.runtime.principal_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_container_app_environment" "agent" {
  name                = "${var.name_prefix}-env"
  location            = var.location
  resource_group_name = azurerm_resource_group.agent.name
  logs_destination    = "azure-monitor"
  tags                = local.tags
  workload_profile {
    name                  = "Consumption"
    workload_profile_type = "Consumption"
  }
}

resource "azurerm_monitor_diagnostic_setting" "container_logs" {
  name                       = "agent-logs"
  target_resource_id         = azurerm_container_app_environment.agent.id
  log_analytics_workspace_id = azapi_resource.logs.id
  enabled_log {
    category_group = "allLogs"
  }
  enabled_metric {
    category = "AllMetrics"
  }
}

resource "azapi_resource" "cosmos" {
  type      = "Microsoft.DocumentDB/databaseAccounts@2024-05-15"
  name      = "${var.name_prefix}-cosmos"
  parent_id = azurerm_resource_group.agent.id
  location  = var.location
  tags      = local.tags
  body = {
    kind = "GlobalDocumentDB"
    properties = {
      databaseAccountOfferType = "Standard"
      capabilities             = [{ name = "EnableServerless" }]
      consistencyPolicy        = { defaultConsistencyLevel = "Session" }
      locations                = [{ locationName = data.azurerm_location.primary.display_name, failoverPriority = 0, isZoneRedundant = false }]
      disableLocalAuth         = true
      publicNetworkAccess      = "Enabled"
      minimalTlsVersion        = "Tls12"
    }
  }
  response_export_values = ["properties.documentEndpoint"]
}

resource "azapi_resource" "database" {
  type      = "Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-05-15"
  name      = "teams-agent"
  parent_id = azapi_resource.cosmos.id
  body = {
    properties = { resource = { id = "teams-agent" }, options = {} }
  }
  response_export_values = []
}

resource "azapi_resource" "conversations" {
  type      = "Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-05-15"
  name      = "conversations"
  parent_id = azapi_resource.database.id
  body = {
    properties = {
      resource = {
        id           = "conversations"
        partitionKey = { paths = ["/id"], kind = "Hash", version = 2 }
        defaultTtl   = 86400
      }
      options = {}
    }
  }
  response_export_values = []
}

resource "azapi_resource" "cosmos_data_role" {
  type      = "Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-05-15"
  name      = uuidv5("url", "${azapi_resource.cosmos.id}/${azurerm_user_assigned_identity.runtime.principal_id}/conversations")
  parent_id = azapi_resource.cosmos.id
  body = {
    properties = {
      principalId      = azurerm_user_assigned_identity.runtime.principal_id
      roleDefinitionId = "${azapi_resource.cosmos.id}/sqlRoleDefinitions/00000000-0000-0000-0000-000000000002"
      scope            = "${azapi_resource.cosmos.id}/dbs/teams-agent/colls/conversations"
    }
  }
  response_export_values = []
  depends_on             = [azapi_resource.conversations]
}

resource "azurerm_container_app" "agent" {
  name                         = "${var.name_prefix}-app"
  container_app_environment_id = azurerm_container_app_environment.agent.id
  resource_group_name          = azurerm_resource_group.agent.name
  revision_mode                = "Single"
  workload_profile_name        = "Consumption"
  tags                         = local.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.runtime.id]
  }

  dynamic "secret" {
    for_each = var.runtime_enabled ? local.secret_references : {}
    content {
      name                = secret.key
      identity            = azurerm_user_assigned_identity.runtime.id
      key_vault_secret_id = "${azurerm_key_vault.secrets.vault_uri}secrets/${secret.value}"
    }
  }

  ingress {
    external_enabled           = true
    allow_insecure_connections = false
    target_port                = 3978
    transport                  = "http"
    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    termination_grace_period_seconds = 120
    min_replicas                     = 1
    max_replicas                     = 3
    container {
      name    = "agent"
      image   = "node:22-alpine"
      cpu     = 0.5
      memory  = "1Gi"
      command = var.runtime_enabled ? null : local.bootstrap_command
      dynamic "env" {
        for_each = var.runtime_enabled ? local.runtime_env : {}
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = var.runtime_enabled ? local.secret_env : {}
        content {
          name        = env.key
          secret_name = env.value
        }
      }
      liveness_probe {
        transport        = "HTTP"
        port             = 3978
        path             = "/healthz"
        initial_delay    = 10
        interval_seconds = 30
      }
      readiness_probe {
        transport        = "HTTP"
        port             = 3978
        path             = var.runtime_enabled ? "/readyz" : "/healthz"
        interval_seconds = 10
      }
      startup_probe {
        transport               = "HTTP"
        port                    = 3978
        path                    = "/healthz"
        interval_seconds        = 5
        failure_count_threshold = 30
      }
    }
    http_scale_rule {
      name                = "http"
      concurrent_requests = "10"
    }
  }

  lifecycle {
    ignore_changes = [template[0].container[0].image, registry]
    precondition {
      condition     = !var.runtime_enabled || (length(trimspace(var.claude_model)) > 0 && length(trimspace(var.gemini_model)) > 0)
      error_message = "Runtime requires operator-verified claude_model and gemini_model IDs."
    }
  }
  depends_on = [azurerm_role_assignment.image_pull, azurerm_role_assignment.secret_reader, azurerm_role_assignment.telemetry_publisher, azapi_resource.cosmos_data_role]
}

resource "azurerm_bot_service_azure_bot" "agent" {
  name                    = "${var.name_prefix}-bot"
  location                = "global"
  resource_group_name     = azurerm_resource_group.agent.name
  sku                     = "F0"
  microsoft_app_id        = azuread_application.bot.client_id
  microsoft_app_type      = "SingleTenant"
  microsoft_app_tenant_id = var.tenant_id
  endpoint                = "https://${azurerm_container_app.agent.ingress[0].fqdn}/api/messages"
  tags                    = local.tags
}

resource "azurerm_bot_channel_ms_teams" "agent" {
  bot_name            = azurerm_bot_service_azure_bot.agent.name
  location            = azurerm_bot_service_azure_bot.agent.location
  resource_group_name = azurerm_resource_group.agent.name
}
