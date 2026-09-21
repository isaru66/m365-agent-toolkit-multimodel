variable "subscription_id" {
  type        = string
  description = "Explicit target Azure subscription UUID."
}

variable "tenant_id" {
  type        = string
  description = "Single Microsoft Entra tenant UUID for both Azure and Teams."
}

variable "location" {
  type        = string
  description = "Operator-approved Azure region supporting Cosmos serverless and ACA."
}

variable "name_prefix" {
  type        = string
  description = "Globally unique lowercase prefix; resource names derive from it."
  validation {
    condition     = can(regex("^[a-z][a-z0-9]{4,15}$", var.name_prefix))
    error_message = "Use 5-16 lowercase letters/digits, starting with a letter."
  }
}

variable "runtime_enabled" {
  type        = bool
  default     = false
  description = "Persist true after staging the application image and prepopulating all KV secrets. Never reset on a live app."
}

variable "claude_model" {
  type        = string
  default     = ""
  nullable    = false
  description = "Operator-verified Claude model/deployment alias; required only when Claude is enabled at runtime."
}

variable "gemini_model" {
  type        = string
  default     = ""
  nullable    = false
  description = "Operator-verified Gemini model ID without models/; required only when Gemini is enabled at runtime."
}

variable "enabled_providers" {
  type        = list(string)
  default     = ["claude", "gemini"]
  nullable    = false
  description = "Nonempty unique provider IDs. Claude-only: [\"claude\"]. All three: [\"claude\", \"gemini\", \"azure-openai\"]."
  validation {
    condition = (
      length(var.enabled_providers) > 0 &&
      length(distinct(var.enabled_providers)) == length(var.enabled_providers) &&
      alltrue([for provider in var.enabled_providers : contains(["claude", "gemini", "azure-openai"], provider)])
    )
    error_message = "enabled_providers must be a nonempty, unique list of claude, gemini, azure-openai."
  }
}

variable "anthropic_base_url" {
  type        = string
  default     = ""
  nullable    = false
  description = "Explicit Claude inference base, e.g. https://YOUR-RESOURCE.services.ai.azure.com/anthropic. Not /v1/messages or a Foundry project URL."
}

variable "gemini_base_url" {
  type        = string
  default     = ""
  nullable    = false
  description = "Explicit Gemini inference root, e.g. https://generativelanguage.googleapis.com. Do not append /v1beta."
}

variable "azure_openai_base_url" {
  type        = string
  default     = ""
  nullable    = false
  description = "Explicit Azure OpenAI v1 inference base, e.g. https://YOUR-RESOURCE.services.ai.azure.com/openai/v1. Not /chat/completions or a Foundry project URL."
}

variable "azure_openai_deployment" {
  type        = string
  default     = ""
  nullable    = false
  description = "Operator-verified Azure OpenAI deployment name; required only when Azure OpenAI is enabled at runtime."
}

variable "secret_names" {
  type = object({
    bot_client_secret    = string
    anthropic_api_key    = string
    gemini_api_key       = string
    azure_openai_api_key = optional(string, "azure-openai-api-key")
  })
  default = {
    bot_client_secret    = "bot-client-secret"
    anthropic_api_key    = "anthropic-api-key"
    gemini_api_key       = "gemini-api-key"
    azure_openai_api_key = "azure-openai-api-key"
  }
  description = "Names of operator-populated Key Vault secrets. Never supply their values to Terraform."
  validation {
    condition     = alltrue([for name in values(var.secret_names) : can(regex("^[a-zA-Z0-9-]{1,127}$", name))])
    error_message = "Key Vault secret names must be 1-127 letters, digits or hyphens."
  }
}

variable "tags" {
  type    = map(string)
  default = {}
}

variable "resource_group_tags" {
  type        = map(string)
  default     = {}
  description = "Additional tags applied only to the resource group, overriding shared tags."
}
