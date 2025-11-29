#!/bin/sh
set -e

MCP_PROXY_CONFIG="${MCP_PROXY_CONFIG:-/app/mcp-proxy/config.json}"
ANALYTICS_URL="${MCP_ANALYTICS_URL:-http://localhost:4000}"
PORT="${PORT:-8000}"
export MCP_PROXY_CONFIG

mkdir -p "$(dirname "${MCP_PROXY_CONFIG}")"
if [ ! -f "${MCP_PROXY_CONFIG}" ]; then
  if [ -f /app/mcp-proxy/config.example.json ]; then
    cp /app/mcp-proxy/config.example.json "${MCP_PROXY_CONFIG}"
    echo "[start-dev] no config found, copied default config to ${MCP_PROXY_CONFIG}"
  else
    echo "[start-dev] no config found at ${MCP_PROXY_CONFIG} and no example available; writing empty config"
    echo "{}" > "${MCP_PROXY_CONFIG}"
  fi
fi

echo "[start-dev] launching analytics server on :4000"
node /app/mcp-proxy/analytics-server.mjs &
echo $! > /tmp/analytics.pid

echo "[start-dev] launching proxy (tsx watch) with config=${MCP_PROXY_CONFIG} analytics=${ANALYTICS_URL}"
npx tsx watch --tsconfig tsconfig.proxy.json /app/mcp-proxy/cli.ts proxy --config "${MCP_PROXY_CONFIG}" --server-url "${ANALYTICS_URL}" --hot-reload &
echo $! > /tmp/proxy.pid

term() {
  echo "[start-dev] stopping services..."
  kill $(cat /tmp/analytics.pid /tmp/proxy.pid 2>/dev/null) 2>/dev/null || true
  wait
}
trap term INT TERM

echo "[start-dev] launching dashboard (uvicorn --reload) on port ${PORT}"
exec uvicorn backend.app:app --host 0.0.0.0 --port "${PORT}" --reload
