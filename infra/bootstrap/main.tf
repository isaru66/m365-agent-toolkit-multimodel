# Optional, separately owned one-time bootstrap. Protect local state and migrate
# it to the newly created backend immediately; see ../README.md.
terraform {
  required_version = ">= 1.9, < 2.0"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    azapi = {
      source  = "Azure/azapi"
      version = "~> 2.0"
    }
  }
}

provider "azurerm" {
  features {}
  subscription_id                 = var.subscription_id
  tenant_id                       = var.tenant_id
  storage_use_azuread             = true
  resource_provider_registrations = "none"
}

provider "azapi" {
  subscription_id = var.subscription_id
  tenant_id       = var.tenant_id
}

variable "subscription_id" { type = string }
variable "tenant_id" { type = string }
variable "location" { type = string }
variable "storage_account_name" {
  type = string
  validation {
    condition     = can(regex("^[a-z0-9]{3,24}$", var.storage_account_name))
    error_message = "Storage account name must be globally unique, 3-24 lowercase letters/digits."
  }
}
variable "state_operator_object_id" {
  type        = string
  description = "Object ID of operator or federated CI identity, not its client/application ID."
}
variable "tags" {
  type        = map(string)
  default     = {}
  description = "Tags required by the target subscription's governance policies."
}
variable "resource_group_tags" {
  type        = map(string)
  default     = {}
  description = "Additional tags applied only to the resource group, overriding shared tags."
}

resource "azurerm_resource_group" "state" {
  name     = "${var.storage_account_name}-rg"
  location = var.location
  tags     = merge(var.tags, var.resource_group_tags)
  lifecycle { prevent_destroy = true }
}

# Do not use azurerm_storage_account: it exports storage keys to state even
# when shared-key authentication is disabled.
resource "azapi_resource" "state" {
  type      = "Microsoft.Storage/storageAccounts@2023-05-01"
  name      = var.storage_account_name
  parent_id = azurerm_resource_group.state.id
  location  = var.location
  tags      = var.tags
  body = {
    kind = "StorageV2"
    sku  = { name = "Standard_LRS" }
    properties = {
      minimumTlsVersion            = "TLS1_2"
      supportsHttpsTrafficOnly     = true
      allowSharedKeyAccess         = false
      defaultToOAuthAuthentication = true
      allowBlobPublicAccess        = false
      publicNetworkAccess          = "Enabled"
    }
  }
  response_export_values = []
  lifecycle { prevent_destroy = true }
}

resource "azapi_update_resource" "blob_service" {
  type        = "Microsoft.Storage/storageAccounts/blobServices@2023-05-01"
  resource_id = "${azapi_resource.state.id}/blobServices/default"
  body = {
    properties = {
      isVersioningEnabled            = true
      deleteRetentionPolicy          = { enabled = true, days = 30 }
      containerDeleteRetentionPolicy = { enabled = true, days = 30 }
    }
  }
  response_export_values = []
}

resource "azapi_resource" "container" {
  type      = "Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01"
  name      = "tfstate"
  parent_id = azapi_update_resource.blob_service.id
  body = {
    properties = { publicAccess = "None" }
  }
  response_export_values = []
  lifecycle { prevent_destroy = true }
}

resource "azurerm_role_assignment" "state_operator" {
  scope                = azapi_resource.container.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = var.state_operator_object_id
}

output "backend" {
  value = {
    resource_group_name  = azurerm_resource_group.state.name
    storage_account_name = azapi_resource.state.name
    container_name       = azapi_resource.container.name
    key                  = "teams-agent/dev.tfstate"
    use_azuread_auth     = true
  }
}
