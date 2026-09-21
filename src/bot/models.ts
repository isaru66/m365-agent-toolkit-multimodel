import { PROVIDER_LABELS, type ProviderId } from "../core/contracts.js";

export function modelCard(enabledProviders: readonly ProviderId[]) {
  return {
    type: "AdaptiveCard", version: "1.5",
    body: [
      { type: "TextBlock", text: "Choose your model", weight: "Bolder", size: "Medium" },
      { type: "TextBlock", wrap: true, text:
        "Your prompt and recent history go to the selected model endpoint. Each provider has a separate history (24 hours, 20 exchanges). Incomplete replies are excluded." },
      { type: "TextBlock", wrap: true, text:
        `Commands: ${enabledProviders.map((id) => `model ${id}`).join(", ")}, model, reset, help. Text only. Stop a stream using the Teams Stop button.` },
    ],
    actions: enabledProviders.map((id) => ({
      type: "Action.Submit", title: PROVIDER_LABELS[id], data: { command: "model", provider: id },
    })),
  };
}
