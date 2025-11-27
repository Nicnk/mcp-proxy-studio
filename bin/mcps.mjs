#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// repoRoot = racine du package (../.. si bin/ est à la racine)
const repoRoot = path.resolve(__dirname, "..");

const PROJECT = "mcp_proxy_studio";
const TMP_DIR = path.join(os.tmpdir(), "mcp-proxy-studio"); // stable
const MARKER = path.join(TMP_DIR, ".mcps-installed");

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.error) {
    console.error(`[error] ${cmd}: ${r.error.message}`);
    process.exit(1);
  }
  process.exitCode = r.status ?? 0;
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function pickComposeFile(baseDir) {
  const candidates = ["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"];
  for (const f of candidates) {
    const p = path.join(baseDir, f);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function syncToTmp() {
  fs.mkdirSync(TMP_DIR, { recursive: true });

  // Copie le repo npx (cache) vers /tmp (stable) pour que stop/status marche à coup sûr
  // (fs.cpSync nécessite Node 16+)
  fs.cpSync(repoRoot, TMP_DIR, {
    recursive: true,
    force: true,
    // évite de copier node_modules si jamais présent
    filter: (src) => !src.includes(`${path.sep}node_modules${path.sep}`),
  });

  fs.mkdirSync(path.join(TMP_DIR, "data"), { recursive: true }); // pour volumes: ./data:/data
  fs.writeFileSync(MARKER, new Date().toISOString(), "utf8");
}

function ensureTmpReady() {
  // Si pas installé, on synchronise
  if (!fs.existsSync(MARKER)) syncToTmp();
}

function composeBaseArgs(composePath) {
  return [
    "compose",
    "--project-directory", TMP_DIR,
    "-f", composePath,
    "-p", PROJECT
  ];
}

function usage() {
  console.log(`Usage:
  npx github:lucasiscovici/MCP-Proxy-Studio start
  npx github:lucasiscovici/MCP-Proxy-Studio status
  npx github:lucasiscovici/MCP-Proxy-Studio stop

Options:
  --refresh   (re-copie le repo dans /tmp)
`);
}

const cmd = process.argv[2];
const refresh = process.argv.includes("--refresh");

if (!cmd || !["start", "status", "stop"].includes(cmd)) {
  usage();
  process.exit(cmd ? 1 : 0);
}

if (refresh) syncToTmp();
else ensureTmpReady();

const composePath = pickComposeFile(TMP_DIR);
if (!composePath) {
  console.error(`Aucun fichier compose trouvé dans ${TMP_DIR} (compose.yaml/docker-compose.yml, etc.)`);
  process.exit(1);
}

const base = composeBaseArgs(composePath);

if (cmd === "start") {
  run("docker", [...base, "up", "-d", "--build"]);
} else if (cmd === "status") {
  run("docker", [...base, "ps"]);
} else if (cmd === "stop") {
  run("docker", [...base, "down"]);
}
