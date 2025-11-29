import { z } from "zod";
import fs from "node:fs";

const ListenerSchema = z.object({
  type: z.enum(["mcp_http", "mcp_sse", "openapi"]),
  host: z.string(),
  port: z.union([z.string(), z.number()]).transform((v) => Number(v)),
  target_port: z.union([z.string(), z.number()]).transform((v) => Number(v)),
  target_host: z.string().optional(),
  name: z.string().optional()
});

const ProxyConfigSchema = z.record(ListenerSchema);

export type ProxyConfig = Record<string, ListenerConfig>;
export type ListenerConfig = z.infer<typeof ListenerSchema>;

export function loadConfig(configPath: string): ProxyConfig {
  const raw = fs.readFileSync(configPath, "utf-8");
  const parsed = JSON.parse(raw);
  const base = ProxyConfigSchema.parse(parsed);
  const normalized: ProxyConfig = {};
  for (const [key, cfg] of Object.entries(base)) {
    normalized[key] = { ...cfg, name: cfg.name ?? key };
  }
  return normalized;
}
