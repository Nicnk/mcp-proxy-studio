#!/bin/sh
set -e

CONFIG="${MCP_PROXY_CONFIG:-/app/mcp-proxy/config.json}"
ANALYTICS_URL="${MCP_ANALYTICS_URL:-http://localhost:4000}"
PORT="${PORT:-8000}"

mkdir -p "$(dirname "${CONFIG}")"
if [ ! -f "${CONFIG}" ]; then
  if [ -f /app/mcp-proxy/config.example.json ]; then
    cp /app/mcp-proxy/config.example.json "${CONFIG}"
    echo "[start] no config found, copied default config to ${CONFIG}"
  else
    echo "[start] no config found at ${CONFIG} and no example available; writing empty config"
    echo "{}" > "${CONFIG}"
  fi
fi

echo "[start] launching analytics server on :4000"
node /app/mcp-proxy/analytics-server.mjs &
echo $! > /tmp/analytics.pid

echo "[start] launching proxy with config=${CONFIG} analytics=${ANALYTICS_URL}"
npx tsx watch --tsconfig tsconfig.proxy.json /app/mcp-proxy/cli.ts proxy --config "${CONFIG}" --server-url "${ANALYTICS_URL}" --hot-reload &
echo $! > /tmp/proxy.pid

term() {
  echo "[start] stopping services..."
  kill $(cat /tmp/analytics.pid /tmp/proxy.pid 2>/dev/null) 2>/dev/null || true
  wait
}
trap term INT TERM

echo "[start] launching dashboard on port ${PORT}"
exec uvicorn backend.app:app --host 0.0.0.0 --port "${PORT}"
