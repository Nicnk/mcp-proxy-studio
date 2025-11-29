import { newSpanId, newTraceId } from "./ids.js";

export type TraceContext = {
  traceId: string;
  parentSpanId?: string;
};

export function parseTraceparent(header: string | undefined): TraceContext | null {
  if (!header) return null;
  const parts = header.trim().split("-");
  if (parts.length !== 4) return null;
  const [, traceId, spanId] = parts;
  if (!/^[0-9a-f]{32}$/i.test(traceId)) return null;
  if (!/^[0-9a-f]{16}$/i.test(spanId)) return null;
  return { traceId: traceId.toLowerCase(), parentSpanId: spanId.toLowerCase() };
}

export function ensureTraceContext(existing: TraceContext | null): { traceId: string; parentSpanId?: string } {
  return existing ?? { traceId: newTraceId() };
}

export function makeTraceparent(traceId: string, spanId: string, sampled = true): string {
  const flags = sampled ? "01" : "00";
  return `00-${traceId}-${spanId}-${flags}`;
}

export function nextSpan(traceId?: string) {
  return { traceId: traceId ?? newTraceId(), spanId: newSpanId() };
}
