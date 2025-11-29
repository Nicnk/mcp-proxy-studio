import chokidar from "chokidar";
import type { ProxyConfig, ListenerConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { makeProxyServer } from "./proxy/makeProxyServer.js";
import { TelemetryClient } from "./telemetry/client.js";

type Running = { close: () => Promise<void> };

export class ProxyRuntime {
  private running: Running[] = [];
  private telemetry: TelemetryClient;

  constructor(private opts: { serverUrl: string; sourceId: string }) {
    this.telemetry = new TelemetryClient({ serverUrl: opts.serverUrl, sourceId: opts.sourceId });
    this.telemetry.start();
  }

  async startFromFile(configPath: string, hotReload: boolean) {
    const config = loadConfig(configPath);
    await this.applyConfig(config);

    if (hotReload) {
      const watcher = chokidar.watch(configPath, { ignoreInitial: true });
      const reload = async () => {
        try {
          const next = loadConfig(configPath);
          await this.applyConfig(next);
          console.log(`[hot-reload] reloaded ${configPath}`);
        } catch (e) {
          console.error("[hot-reload] invalid config, keeping previous config alive");
          // do not throw: keep running with last good config
        }
      };
      watcher.on("change", reload);
      watcher.on("add", reload);
    }
  }

  async applyConfig(config: ProxyConfig) {
    await this.stopAll();

    const logListener = (name: string, listener: ListenerConfig, kind: string) => {
      const listenHost = listener.target_host ?? "0.0.0.0";
      const listenPort = listener.target_port;
      const upstream = `${listener.host}:${listener.port}`;
      console.log(`[config] ${name}: listening ${listenHost}:${listenPort} -> upstream ${upstream} (type=${kind})`);
    };

    for (const [name, cfg] of Object.entries(config)) {
      const kind = cfg.type;
      logListener(name, cfg, kind);
      this.running.push(
        makeProxyServer({
          kind: kind === "openapi" ? "openapi" : kind === "mcp_sse" ? "mcp_sse" : "mcp_http",
          listener: cfg,
          telemetry: this.telemetry,
          proxyId: name
        })
      );
    }

    console.log(`[runtime] started ${this.running.length} proxy listener(s)`);
  }

  async stopAll() {
    const toClose = this.running.splice(0, this.running.length);
    await Promise.all(toClose.map((r) => r.close().catch(() => undefined)));
  }

  async shutdown() {
    await this.stopAll();
    this.telemetry.stop();
  }
}
