import { logEvent } from "../telemetry/logger.js";

export class TurnTasks {
  private readonly pending = new Set<Promise<void>>();
  private stopping = false;
  constructor(private readonly capacity = 32) {}

  get size(): number { return this.pending.size; }
  get accepting(): boolean { return !this.stopping && this.pending.size < this.capacity; }

  stopAccepting(): void { this.stopping = true; }

  run(task: () => Promise<void>): boolean {
    if (!this.accepting) return false;
    const tracked = Promise.resolve().then(task).catch(() => {
      logEvent("turn_failed");
    }).finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
    return true;
  }

  async drain(): Promise<void> {
    this.stopAccepting();
    await Promise.all(this.pending);
  }
}
