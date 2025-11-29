import type { IngestPayload, SpanEvent } from "./types.js";

export type TelemetryClientOptions = {
  serverUrl: string;
  sourceId: string;
  batchSize?: number;
  flushIntervalMs?: number;
  maxQueue?: number;
};

export class TelemetryClient {
  private readonly ingestUrl: string;
  private readonly sourceId: string;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly maxQueue: number;

  private queue: SpanEvent[] = [];
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private flushing = false;

  constructor(opts: TelemetryClientOptions) {
    this.ingestUrl = new URL("/ingest", opts.serverUrl).toString();
    this.sourceId = opts.sourceId;
    this.batchSize = opts.batchSize ?? 200;
    this.flushIntervalMs = opts.flushIntervalMs ?? 500;
    this.maxQueue = opts.maxQueue ?? 10_000;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.flushIntervalMs);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  record(event: Omit<SpanEvent, "schemaVersion" | "type" | "sourceId">) {
    if (this.stopped) return;

    const full: SpanEvent = {
      type: "span",
      schemaVersion: 1,
      sourceId: this.sourceId,
      ...event
    };

    if (this.queue.length >= this.maxQueue) {
      this.queue.shift();
    }
    this.queue.push(full);

    if (this.queue.length >= this.batchSize) void this.flush();
  }

  flush = async () => {
    if (this.flushing || this.stopped) return;
    if (this.queue.length === 0) return;

    this.flushing = true;
    try {
      const batch = this.queue.splice(0, this.batchSize);
      const payload: IngestPayload = { schemaVersion: 1, sourceId: this.sourceId, events: batch };
      await this.postWithRetry(payload, 3);
    } catch {
    } finally {
      this.flushing = false;
    }
  }

  private async postWithRetry(payload: IngestPayload, attempts: number) {
    let lastErr: unknown;
    const body = JSON.stringify(payload);

    for (let i = 0; i < attempts; i++) {
      try {
        const res = await fetch(this.ingestUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body
        });
        if (res.ok) return;
        lastErr = new Error(`Ingest failed: ${res.status}`);
      } catch (e) {
        lastErr = e;
      }
      await new Promise((r) => setTimeout(r, 200 * (i + 1)));
    }
    throw lastErr;
  }
}
