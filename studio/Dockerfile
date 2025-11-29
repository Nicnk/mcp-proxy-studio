FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8000 \
    MCP_DASH_DATA=/data/flows.json \
    PATH="/usr/local/go/bin:/root/go/bin:${PATH}" \
    NODE_ENV=production

WORKDIR /app

# System deps
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates git golang curl gnupg supervisor \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Python deps
COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt && pip install --no-cache-dir uv

# Install Go mcp-proxy CLI (optional)
RUN GO111MODULE=on GOBIN=/usr/local/bin go install github.com/TBXark/mcp-proxy@latest

# Proxy build (Node)
WORKDIR /app
COPY package.json tsconfig.proxy.json ./
COPY mcp-proxy ./mcp-proxy
RUN npm install --include=dev \
    && npm run proxy:build

# Runtime layout
WORKDIR /app
COPY backend ./backend
COPY frontend ./frontend
COPY studio/start-all.sh /app/start-all.sh

RUN chmod +x /app/start-all.sh && mkdir -p /data /app/mcp-proxy/config

EXPOSE 8000 8001 8002 8003 6274 6277 4000 40001 40002 40003

CMD ["/app/start-all.sh"]
