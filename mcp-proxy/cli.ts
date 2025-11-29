import { Command } from "commander";
import { ProxyRuntime } from "./runtime.js";

const program = new Command();

program.name("mcp-studio").description("MCP Studio proxy runner").version("0.1.0");

program
  .command("proxy")
  .requiredOption("--config <path>", "Path to config.json")
  .requiredOption("--server-url <url>", "Analytics server base URL, e.g. http://localhost:4000")
  .option("--hot-reload", "Reload config when file changes", false)
  .option("--source-id <id>", "Telemetry source id", "mcp-studio-proxy")
  .action(async (opts) => {
    const runtime = new ProxyRuntime({ serverUrl: opts.serverUrl, sourceId: opts.sourceId });

    const onExit = async () => {
      await runtime.shutdown();
      process.exit(0);
    };
    process.on("SIGINT", onExit);
    process.on("SIGTERM", onExit);

    await runtime.startFromFile(opts.config, !!opts.hotReload);
  });

await program.parseAsync(process.argv);
