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
  description = "Operator-verified Anthropic model ID, required for runtime activation."
}

variable "gemini_model" {
  type        = string
  default     = ""
  description = "Operator-verified Gemini model ID, required for runtime activation."
}

variable "secret_names" {
  type = object({
    bot_client_secret = string
    anthropic_api_key = string
    gemini_api_key    = string
  })
  default = {
    bot_client_secret = "bot-client-secret"
    anthropic_api_key = "anthropic-api-key"
    gemini_api_key    = "gemini-api-key"
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
