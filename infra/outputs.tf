output "deployment" {
  description = "Versioned non-secret contract consumed by Node scripts. Never add secret material."
  value = {
    schema_version             = 1
    subscription_id            = var.subscription_id
    tenant_id                  = var.tenant_id
    resource_group_name        = azurerm_resource_group.agent.name
    acr_name                   = azurerm_container_registry.images.name
    acr_login_server           = azurerm_container_registry.images.login_server
    container_app_name         = azurerm_container_app.agent.name
    container_name             = "agent"
    container_app_url          = "https://${azurerm_container_app.agent.ingress[0].fqdn}"
    bot_id                     = azuread_application.bot.client_id
    bot_application_object_id  = azuread_application.bot.object_id
    bot_service_principal_id   = azuread_service_principal.bot.object_id
    bot_domain                 = azurerm_container_app.agent.ingress[0].fqdn
    bot_endpoint               = "https://${azurerm_container_app.agent.ingress[0].fqdn}/api/messages"
    runtime_identity_id        = azurerm_user_assigned_identity.runtime.id
    runtime_identity_client_id = azurerm_user_assigned_identity.runtime.client_id
    key_vault_name             = azurerm_key_vault.secrets.name
    key_vault_uri              = azurerm_key_vault.secrets.vault_uri
    cosmos_endpoint            = azapi_resource.cosmos.output.properties.documentEndpoint
    cosmos_database            = "teams-agent"
    cosmos_container           = "conversations"
    runtime_enabled            = var.runtime_enabled
  }
}
