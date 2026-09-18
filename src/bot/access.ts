import type { Config } from "../config/index.js";
import type { ConversationKey } from "../core/contracts.js";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export interface AcceptedMessage {
  key: ConversationKey;
  activityId: string;
  text: string;
  hasAttachments: boolean;
}

export function acceptMessage(body: unknown, config: Pick<Config, "localPlayground" | "tenantId">): AcceptedMessage | undefined {
  const activity = record(body);
  const conversation = record(activity.conversation);
  const sender = record(activity.from);
  const tenant = record(record(activity.channelData).tenant);
  if (activity.type !== "message") return undefined;
  if (config.localPlayground) {
    if (activity.channelId !== "emulator" && activity.channelId !== "msteams") return undefined;
    try {
      const url = new URL(String(activity.serviceUrl));
      if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
          !["http:", "https:"].includes(url.protocol)) return undefined;
    } catch {
      return undefined;
    }
  } else if (activity.channelId !== "msteams" || conversation.conversationType !== "personal" ||
      tenant.id !== config.tenantId ||
      (conversation.tenantId !== undefined && conversation.tenantId !== config.tenantId)) {
    return undefined;
  }
  const activityId = string(activity.id);
  const conversationId = string(conversation.id);
  const userId = string(config.localPlayground ? sender.id : sender.aadObjectId);
  if (!activityId || !conversationId || !userId) return undefined;
  const value = record(activity.value);
  const model = value.command === "model" && (value.provider === "claude" || value.provider === "gemini")
    ? `model ${value.provider}` : undefined;
  return {
    key: { tenantId: config.tenantId, conversationId, userId },
    activityId,
    text: model ?? string(activity.text)?.trim() ?? "",
    hasAttachments: Array.isArray(activity.attachments) &&
      activity.attachments.some((attachment: unknown) =>
        record(attachment).contentType !== "text/html"),
  };
}
