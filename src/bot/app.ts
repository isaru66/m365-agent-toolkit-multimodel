import http from "node:http";
import { App, ExpressAdapter } from "@microsoft/teams.apps";
import { MessageActivityInput } from "@microsoft/teams.api";
import type { Config } from "../config/index.js";
import type { ChatProvider, ConversationStore, ProviderId } from "../core/contracts.js";
import { logEvent, SafeSdkLogger } from "../telemetry/logger.js";
import { acceptMessage } from "./access.js";
import { ChatController, type ChatOutput } from "./controller.js";
import { TeamsReplyStream } from "./stream.js";
import { TurnTasks } from "./tasks.js";

export function createApp(config: Config, store: ConversationStore, providers: Record<ProviderId, ChatProvider>) {
  const logger = new SafeSdkLogger();
  const server = http.createServer();
  const adapter = new ExpressAdapter(server, { logger });
  const tasks = new TurnTasks();
  const controller = new ChatController(config, store, providers);
  const app = new App({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    tenantId: config.localPlayground ? undefined : config.tenantId,
    dangerouslyAllowUnauthenticatedRequests: config.localPlayground,
    httpServerAdapter: adapter,
    logger,
    client: { timeout: 10000, logger },
    telemetry: { agent365: false },
  });
  adapter.get("/healthz", (_request, response) => response.status(200).json({ status: "healthy" }));
  adapter.get("/readyz", (_request, response) => response.status(tasks.accepting ? 200 : 503).json({
    status: tasks.accepting ? "ready" : "busy",
  }));
  app.on("message", async (context) => {
    const message = acceptMessage(context.activity, config);
    if (!message) {
      logEvent("activity_rejected");
      return;
    }
    const output: ChatOutput = {
      send: async (text) => { await context.send(text); },
      chooseModel: async () => {
        await context.send(new MessageActivityInput().addAttachments({
          contentType: "application/vnd.microsoft.card.adaptive",
          content: {
            type: "AdaptiveCard", version: "1.5",
            body: [
              { type: "TextBlock", text: "Choose your model", weight: "Bolder", size: "Medium" },
              { type: "TextBlock", wrap: true, text:
                "Your prompt and recent history go to the selected external provider. Claude and Gemini have separate histories (24 hours, 20 exchanges). Incomplete replies are excluded." },
              { type: "TextBlock", wrap: true, text:
                "Commands: model claude, model gemini, model, reset, help. Text only. Stop a stream using the Teams Stop button." },
            ],
            actions: [
              { type: "Action.Submit", title: "Claude Opus", data: { command: "model", provider: "claude" } },
              { type: "Action.Submit", title: "Gemini", data: { command: "model", provider: "gemini" } },
            ],
          },
        }));
      },
      stream: (onFailure) => new TeamsReplyStream(
        async (activity) => context.api.conversations.createActivity(context.ref.conversation.id, {
          ...activity,
          replyToId: context.ref.activityId,
        }),
        onFailure,
      ),
    };
    try {
      await controller.handle(message, output);
    } catch {
      logEvent("chat_processing_failed");
      await output.send("The agent could not process this request or save its state. Please try again. No alternate model was selected.");
    }
  });

  return {
    app, server, tasks,
    async start(): Promise<void> {
      await app.initialize();
      const dispatch = app.server.onRequest;
      if (!dispatch) throw new Error("Teams SDK did not initialize its request dispatcher");
      // This callback runs only AFTER the SDK's channel JWT validation.
      app.server.onRequest = async (event) => {
        if (event.body.type !== "message") return { status: 200 };
        if (!acceptMessage(event.body, config)) {
          logEvent("activity_rejected");
          return { status: 403 };
        }
        const accepted = tasks.run(async () => {
          const response = await dispatch(event);
          if (response.status >= 400) logEvent("sdk_turn_failed", { status: response.status });
        });
        return { status: accepted ? 200 : 503 };
      };
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.localPlayground ? "127.0.0.1" : "0.0.0.0", () => {
          server.off("error", reject);
          resolve();
        });
      });
      logEvent("app_started", { port: config.port, mode: config.providerMode });
    },
    async stop(): Promise<void> {
      tasks.stopAccepting();
      await controller.stop();
      await tasks.drain();
      await app.stop();
    },
  };
}
