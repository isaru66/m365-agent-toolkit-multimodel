import type { ILogger } from "@microsoft/teams.common";

type Fields = Record<string, string | number | boolean | undefined>;

export function logEvent(event: string, fields: Fields = {}): void {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), event, ...fields }));
}

// SDK arguments can contain activities, HTTP headers, and provider payloads.
export class SafeSdkLogger implements ILogger {
  constructor(private readonly component = "teams") {}
  debug(..._args: unknown[]): void {}
  trace(..._args: unknown[]): void {}
  info(..._args: unknown[]): void {
    logEvent("sdk_info", { component: this.component });
  }
  warn(..._args: unknown[]): void {
    logEvent("sdk_warning", { component: this.component });
  }
  error(..._args: unknown[]): void {
    logEvent("sdk_error", { component: this.component });
  }
  log(level: "error" | "warn" | "info" | "debug" | "trace", ...args: unknown[]): void {
    this[level](...args);
  }
  child(name: string): ILogger {
    return new SafeSdkLogger(`${this.component}.${name.replace(/[^a-zA-Z0-9._-]/g, "")}`);
  }
}
