import crypto from "node:crypto";

export function randomHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString("hex");
}

export function newTraceId(): string {
  return randomHex(16);
}

export function newSpanId(): string {
  return randomHex(8);
}
