import { loadConfig } from "./config/index.js";
import { logEvent } from "./telemetry/logger.js";

async function main(): Promise<void> {
  const config = loadConfig();
  let shutdownTelemetry = async () => {};
  if (process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) {
    const monitor = await import("@azure/monitor-opentelemetry");
    const { DefaultAzureCredential } = await import("@azure/identity");
    monitor.useAzureMonitor({
      azureMonitorExporterOptions: {
        connectionString: process.env.APPLICATIONINSIGHTS_CONNECTION_STRING,
        credential: new DefaultAzureCredential({
          managedIdentityClientId: config.managedIdentityClientId,
        }),
      },
      enableLiveMetrics: false,
      instrumentationOptions: {
        http: { enabled: false },
        azureSdk: { enabled: false },
        mongoDb: { enabled: false },
        mySql: { enabled: false },
        postgreSql: { enabled: false },
        redis: { enabled: false },
        redis4: { enabled: false },
        bunyan: { enabled: false },
        winston: { enabled: false },
        console: { enabled: true },
      },
    });
    shutdownTelemetry = monitor.shutdownAzureMonitor;
  }
  const { bootstrap } = await import("./bootstrap.js");
  const runtime = await bootstrap(config);
  await runtime.start();
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    runtime.stop().then(shutdownTelemetry).catch(() => {
      logEvent("shutdown_failed");
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch(() => {
  logEvent("startup_failed", { hint: "Check required configuration, Azure identity, and Cosmos container access." });
  process.exitCode = 1;
});
