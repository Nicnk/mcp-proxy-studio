#!/bin/sh
# Start script for the standalone proxy image
CONFIG_PATH="${MCP_PROXY_CONFIG:-/app/config/config.json}"
ANALYTICS_URL="${MCP_ANALYTICS_URL:-http://analytics:4000}"

echo "[start] launching proxy with config=${CONFIG_PATH} analytics=${ANALYTICS_URL}"
exec node dist/cli.js proxy --config "${CONFIG_PATH}" --server-url "${ANALYTICS_URL}" "$@"
