export type SpanEvent = {
  type: "span";
  schemaVersion: 1;
  sourceId: string;

  traceId: string;
  spanId: string;
  parentSpanId?: string;

  name: string;
  kind: "SERVER" | "INTERNAL";

  startTimeMs: number;
  endTimeMs: number;
  status: "OK" | "ERROR";

  attributes: Record<string, string | number | boolean | null | undefined>;
  error?: { message: string; type?: string };
};

export type IngestPayload = {
  schemaVersion: 1;
  sourceId: string;
  events: SpanEvent[];
};
