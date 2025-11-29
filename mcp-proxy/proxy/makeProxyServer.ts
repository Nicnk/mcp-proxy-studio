import http from "node:http";
import httpProxy from "http-proxy";
import { PassThrough } from "node:stream";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import type { ListenerConfig } from "../config.js";
import {
  parseTraceparent,
  ensureTraceContext,
  nextSpan,
  makeTraceparent
} from "../telemetry/traceparent.js";
import type { TelemetryClient } from "../telemetry/client.js";

export type ProxyKind = "mcp_sse" | "mcp_http" | "openapi";

type CaptureBuffer = {
  requestBody?: string;
  responseBody?: string;
};

type InflightToolCall = {
  startedAt: number;
  traceId: string;
  spanId: string; // internal request span id (parent for response span)
  parentSpanId?: string;
  kind: ProxyKind;
  transport: "mcp_sse" | "mcp_http" | "openapi";
  sessionKey: string;
  rpcId: string | number;
  toolName?: string;
  requestBody: string;
  httpMethod: string;
  urlPath: string;
  urlQuery: string;
  upstreamUrl: string;
};

function stableKey(s: string) {
  try {
    return Buffer.from(s).toString("base64url");
  } catch {
    return s;
  }
}

function deriveConnectionKey(req: http.IncomingMessage) {
  const forwarded =
    (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ??
    req.socket.remoteAddress ??
    "na";
  const host = req.headers.host ?? "";
  return stableKey(`${forwarded}|${host}`);
}

function deriveSessionKey(req: http.IncomingMessage) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  const headerSid =
    (req.headers["mcp-session-id"] as string | undefined) ||
    (req.headers["x-mcp-session-id"] as string | undefined);

  const querySid = url.searchParams.get("sessionId") || url.searchParams.get("session_id");

  const cookieSid = req.headers.cookie?.match(/(?:^|;\s*)(?:mcp_session|session)=([^;]+)/)?.[1];

  // note: fallback connection-based key (important for GET /sse)
  return stableKey(headerSid ?? querySid ?? cookieSid ?? deriveConnectionKey(req));
}

function isJsonRpcToolCall(msg: any) {
  return msg && msg.jsonrpc === "2.0" && msg.id != null && msg.method === "tools/call";
}

function safeJsonParse(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function parseJsonMessages(raw: string) {
  const messages: any[] = [];
  const parsed = safeJsonParse(raw);
  if (parsed !== null) {
    if (Array.isArray(parsed)) messages.push(...parsed);
    else messages.push(parsed);
    return messages;
  }

  raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      const item = safeJsonParse(line);
      if (item !== null) messages.push(item);
    });

  return messages;
}

function decodeCompressedBody(buf: Buffer, encoding: string | number | string[] | undefined) {
  const enc = Array.isArray(encoding) ? encoding[0] : encoding;
  const value = typeof enc === "string" ? enc.toLowerCase() : "";
  try {
    if (value.includes("gzip")) return gunzipSync(buf);
    if (value.includes("deflate")) return inflateSync(buf);
    if (value.includes("br")) return brotliDecompressSync(buf);
  } catch {
    // fallback to original buffer if decompression fails
  }
  return buf;
}

export type MakeProxyServerParams = {
  kind: ProxyKind;
  listener: ListenerConfig;
  telemetry: TelemetryClient;
  proxyId: string;
};

export function makeProxyServer(params: MakeProxyServerParams) {
  const { kind, listener, telemetry, proxyId } = params;
  const listenHost = listener.target_host ?? "0.0.0.0";
  const listenPort = listener.target_port;
  const targetBase = `http://${listener.host}:${listener.port}`;
  const defaultTransport: InflightToolCall["transport"] =
    kind === "mcp_sse" ? "mcp_sse" : kind === "openapi" ? "openapi" : "mcp_http";

  const inflight = new Map<string, InflightToolCall>(); // key: `${sessionKey}:${rpcId}`
  const connectionSessions = new Map<string, string>(); // connectionKey -> sessionKey (learned from POSTs)
  const lastResponses = new Map<string, string>(); // key -> last response JSON (dedupe)
  const completed = new Set<string>(); // key -> response already recorded

  const findInflight = (sessionKey: string, rpcId: string | number) => {
    let key = `${sessionKey}:${String(rpcId)}`;
    let call = inflight.get(key);

    if (!call) {
      const suffix = `:${String(rpcId)}`;
      const matches = Array.from(inflight.entries()).filter(([k]) => k.endsWith(suffix));
      if (matches.length === 1) {
        key = matches[0][0];
        call = matches[0][1];
      }
    }

    return { key, call };
  };

  const recordToolResponseSpan = (call: InflightToolCall, respJSON: string, statusCode: number, errorObj?: any) => {
    const now = Date.now();
    const duration = now - call.startedAt;
    const respSize = Buffer.byteLength(respJSON, "utf8");
    const { spanId: responseSpanId } = nextSpan(call.traceId);
    const transport = call.transport ?? defaultTransport;
    const callKind = call.kind ?? kind;

    telemetry.record({
      traceId: call.traceId,
      spanId: responseSpanId,
      parentSpanId: call.spanId,
      name: `mcp.tool/${call.toolName ?? "call"}`,
      kind: "SERVER",
      startTimeMs: call.startedAt,
      endTimeMs: now,
      status: errorObj ? "ERROR" : "OK",
      attributes: {
        "mcp.transport": transport,
        "mcp.kind": callKind,
        "mcp.rpc.id": call.rpcId,
        "mcp.tool.name": call.toolName ?? "",
        "mcp.session_id": call.sessionKey,
        "mcp.proxy_id": proxyId,
        "http.request.method": call.httpMethod,
        "http.request.body": call.requestBody,
        "http.response.body": respJSON,
        "http.response.status_code": statusCode,
        "http.response.size": respSize,
        "url.path": call.urlPath,
        "url.query": call.urlQuery,
        "upstream.url": call.upstreamUrl,
        "mcp.response.duration_ms": duration
      },
      error: errorObj ? { message: errorObj?.message ?? "tool_error" } : undefined
    });

    try {
      const maybeFlush = (telemetry as any).flush;
      if (typeof maybeFlush === "function") {
        maybeFlush().catch((e: any) => console.warn("[proxy]", proxyId, "telemetry.flush error", e?.message));
      }
    } catch {}
  };

  const proxy = httpProxy.createProxyServer({
    target: targetBase,
    changeOrigin: false,
    xfwd: false,
    ws: true
  });

  proxy.on("proxyRes", (proxyRes, _req, res) => {
    // keep track of upstream encoding for proper body decoding
    (res as any).__contentEncoding = proxyRes.headers["content-encoding"];
  });

  proxy.on("error", (_err, _req, res) => {
    try {
      if (res && "writeHead" in res) {
        (res as http.ServerResponse).writeHead(502, { "content-type": "application/json" });
        (res as http.ServerResponse).end(JSON.stringify({ error: "Bad Gateway" }));
      }
    } catch {}
  });

  //
  // PROXY REQ HEADER REWRITING
  //
  proxy.on("proxyReq", (proxyReq, req) => {
    if ((proxyReq as any).headersSent) return;

    // forward session id in headers too
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const sid =
      (req.headers["mcp-session-id"] as string | undefined) ||
      (req.headers["x-mcp-session-id"] as string | undefined) ||
      url.searchParams.get("sessionId") ||
      url.searchParams.get("session_id");

    if (sid) {
      proxyReq.setHeader("mcp-session-id", sid);
      proxyReq.setHeader("x-mcp-session-id", sid);
    }

    // traceparent
    const incoming = parseTraceparent(req.headers["traceparent"] as string | undefined);
    const ctx = ensureTraceContext(incoming);
    const { spanId } = nextSpan(ctx.traceId);
    proxyReq.setHeader("traceparent", makeTraceparent(ctx.traceId, spanId, true));
  });

  //
  // PROXY RESPONSE (SSE ONLY)
  //
  proxy.on("proxyRes", (proxyRes, req, res) => {
    if (!(res as any).__isSse) return;

    const meta = res as any;
    const respChunks: Buffer[] = meta.__respChunks || [];
    const capture: CaptureBuffer = meta.__capture || {};

    const ct = String(proxyRes.headers["content-type"] || "").toLowerCase();
    console.log("[proxy]", proxyId, "SSE upstream status", proxyRes.statusCode, "content-type", ct);

    if (!ct.includes("text/event-stream")) {
      res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
      proxyRes.pipe(res);
      return;
    }

    let sseBuf = "";

    const recordToolResponse = (msg: any) => {
      try {
        if (!msg || msg.id == null) return;
        if (msg.result == null && msg.error == null) return; // only final

        // IMPORTANT: SSE GET /sse doesn't carry sessionId; use connectionKey->sessionKey mapping
        const connectionKey = deriveConnectionKey(req);
        let sessionKey = connectionSessions.get(connectionKey) ?? deriveSessionKey(req);

        const { key, call } = findInflight(sessionKey, msg.id);
        if (completed.has(key)) return;
        if (key.includes(":")) sessionKey = key.split(":")[0] ?? sessionKey;

        if (!call) {
          // keep noise low: only log if we actually have inflight items
          if (inflight.size > 0) {
            console.log("[proxy]", proxyId, "recordToolResponse: no inflight for", key, "connKey=", connectionKey);
          }
          return;
        }

        const now = Date.now();
        const duration = now - call.startedAt;

        const respJSON = JSON.stringify(msg);

        // dedupe identical response bodies
        const last = lastResponses.get(key);
        if (last && last === respJSON) {
          inflight.delete(key);
          return;
        }
        lastResponses.set(key, respJSON);
        completed.add(key);
        inflight.delete(key);

        console.log(
          "[proxy]",
          proxyId,
          "RECORD TOOL RESPONSE id=",
          msg.id,
          "tool=",
          call.toolName,
          "duration=",
          duration,
          "sessionKey=",
          call.sessionKey
        );

        recordToolResponseSpan(call, respJSON, proxyRes.statusCode ?? 200, msg.error);
      } catch (e) {
        console.error("[proxy]", proxyId, "recordToolResponse unexpected error", (e as Error)?.message);
      }
    };

    const feedSseText = (txt: string) => {
      sseBuf += txt;

      while (true) {
        const nn = sseBuf.indexOf("\n\n");
        const rr = sseBuf.indexOf("\r\n\r\n");
        const sep = nn === -1 ? rr : rr === -1 ? nn : Math.min(nn, rr);
        if (sep === -1) break;

        const raw = sseBuf.slice(0, sep);
        sseBuf = sseBuf.slice(sep + (sep === rr ? 4 : 2));
        if (!raw.trim()) continue;

        const lines = raw.split(/\r?\n/);
        const dataLines = lines
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim());
        if (!dataLines.length) continue;

        const data = dataLines.join("\n");
        const msg = safeJsonParse(data);
        if (msg) console.log("[proxy]", proxyId, "SSE parsed", data.slice(0, 200));
        if (msg) recordToolResponse(msg);
      }

      if (sseBuf.length > 1024 * 1024) sseBuf = sseBuf.slice(-256 * 1024);
    };

    const transform = new PassThrough({
      transform(chunk, _enc, cb) {
        let buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

        // rewrite origin inside SSE frames to avoid MCP SDK origin mismatch
        let txt = buf.toString("utf-8");
        const clientHost = req.headers.host;
        if (clientHost) {
          txt = txt.replace(/http:\/\/(?:0\.0\.0\.0|localhost):\d+/g, `http://${clientHost}`);
        }
        buf = Buffer.from(txt, "utf-8");

        // capture (cap memory in real prod; see review)
        respChunks.push(Buffer.from(buf));
        capture.responseBody = Buffer.concat(respChunks).toString("utf-8");

        try {
          feedSseText(buf.toString("utf-8"));
        } catch (e) {
          console.warn("[proxy]", proxyId, "SSE parse error", (e as Error)?.message);
        }

        cb(null, buf);
      }
    });

    res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
    proxyRes.pipe(transform).pipe(res);
  });

  //
  // HTTP SERVER
  //
  const server = http.createServer((req, res) => {
    const start = Date.now();

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const upstreamPath = url.pathname.startsWith("/") ? url.pathname : `/${url.pathname}`;
    const upstreamUrl = `${targetBase}${upstreamPath}${url.search}`;

    const isSseRequest =
      kind === "mcp_sse" &&
      req.method === "GET" &&
      (upstreamPath.endsWith("/sse") || String(req.headers.accept || "").includes("text/event-stream"));

    (res as any).__isSse = isSseRequest;
    (res as any).__transport = isSseRequest ? "mcp_sse" : defaultTransport;

    const capture: CaptureBuffer = {};
    const tee = new PassThrough();
    req.pipe(tee);

    // trace context
    const incoming = parseTraceparent(req.headers["traceparent"] as string | undefined);
    const ctx = ensureTraceContext(incoming);
    const { spanId } = nextSpan(ctx.traceId);
    const traceId = ctx.traceId;
    const parentSpanId = ctx.parentSpanId;

    const recordMain = (ok: boolean, statusCode?: number) => {
      const end = Date.now();
      telemetry.record({
        traceId,
        spanId,
        parentSpanId,
        name: `mcp.${kind}/${listener.name}`,
        kind: "SERVER",
        startTimeMs: start,
        endTimeMs: end,
        status: ok ? "OK" : "ERROR",
        attributes: {
          "mcp.transport": defaultTransport,
          "mcp.kind": kind,
          "http.method": req.method ?? "",
          "url.path": url.pathname,
          "url.query": url.search || "",
          "upstream.url": upstreamUrl,
          "http.request.body": capture.requestBody ?? "",
          "http.response.body": capture.responseBody ?? "",
          "http.response.status_code": statusCode ?? 0
        }
      });
    };

    // capture request body to detect tools/call in POST /message
    const reqChunks: Buffer[] = [];
    let hasToolCall = false;
    req.on("data", (chunk) => {
      reqChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    req.on("end", () => {
      capture.requestBody = Buffer.concat(reqChunks).toString("utf-8");

      const body = capture.requestBody;
      const parsedMessages = parseJsonMessages(body);

      const sessionKey = deriveSessionKey(req); // for POST /message this is stableKey(sessionId=...)
      const connectionKey = deriveConnectionKey(req);

      const register = (m: any) => {
        if (!isJsonRpcToolCall(m)) return;
        hasToolCall = true;

        const rpcId = m.id;
        const toolName = m.params?.name as string | undefined;
        const callTransport = defaultTransport;

        // Create a spanId that will act as parent for the response span
        const { spanId: toolRequestSpanId } = nextSpan(traceId);

        const key = `${sessionKey}:${String(rpcId)}`;
        lastResponses.delete(key);
        completed.delete(key);

        // CRITICAL: teach mapping so SSE GET can find the same sessionKey as POST
        connectionSessions.set(connectionKey, sessionKey);

        inflight.set(key, {
          traceId,
          spanId: toolRequestSpanId,
          parentSpanId,
          kind,
          transport: callTransport,
          sessionKey,
          rpcId,
          toolName,
          startedAt: start,
          requestBody: body,
          httpMethod: req.method ?? "POST",
          urlPath: url.pathname,
          urlQuery: url.search ? url.search.slice(1) : "",
          upstreamUrl
        });

        // record internal request span (shows request payload, not counted as a “main request”)
        telemetry.record({
          traceId,
          spanId: toolRequestSpanId, // IMPORTANT: use the same id as inflight parent
          parentSpanId,
          name: `mcp.tool_request/${toolName ?? "call"}`,
          kind: "INTERNAL",
          startTimeMs: start,
          endTimeMs: start + 1,
          status: "OK",
          attributes: {
            "mcp.tool.phase": "request",
            "mcp.transport": callTransport,
            "mcp.kind": kind,
            "mcp.rpc.id": String(rpcId),
            "mcp.tool.name": toolName ?? "",
            "mcp.session_id": sessionKey,
            "mcp.proxy_id": proxyId,
            "http.request.method": req.method ?? "POST",
            "http.request.body": body,
            "url.path": url.pathname,
            "url.query": url.search ? url.search.slice(1) : "",
            "upstream.url": upstreamUrl
          }
        });
      };

      parsedMessages.forEach(register);
    });

    // response capture
    const respChunks: Buffer[] = [];
    (res as any).__respChunks = respChunks;
    (res as any).__capture = capture;

    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);

    (res as any).write = function (chunk: any, encoding?: any, cb?: any) {
      if (chunk) {
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        respChunks.push(b);
      }
      return originalWrite(chunk, encoding as any, cb);
    };

    (res as any).end = function (chunk?: any, encoding?: any, cb?: any) {
      if (chunk) {
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        respChunks.push(b);
      }
      const rawBody = Buffer.concat(respChunks);
      const decodedBody = decodeCompressedBody(rawBody, (res as any).__contentEncoding ?? res.getHeader("content-encoding"));
      capture.responseBody = decodedBody.toString("utf-8");

      // For HTTP transports, the tool response is delivered in this response body.
      const maybeHandleHttpToolResponses = () => {
        if (defaultTransport !== "mcp_http") return; // only streamable HTTP flows should emit responses here
        if ((res as any).__toolResponseHandled) return;
        if (!capture.responseBody || inflight.size === 0) return;

        try {
          const messages = parseJsonMessages(capture.responseBody);
          if (!messages.length) return;

          const sessionKey = deriveSessionKey(req);

          for (const msg of messages) {
            if (!msg || msg.id == null) continue;
            if (msg.result == null && msg.error == null) continue;

            const { key, call } = findInflight(sessionKey, msg.id);
            if (completed.has(key)) continue;
            if (!call) {
              if (inflight.size > 0) {
                console.log("[proxy]", proxyId, "http response: no inflight for", key, "session=", sessionKey);
              }
              continue;
            }

            const respJSON = JSON.stringify(msg);
            const last = lastResponses.get(key);
            if (last && last === respJSON) {
              inflight.delete(key);
              continue;
            }

            lastResponses.set(key, respJSON);
            completed.add(key);
            inflight.delete(key);

            recordToolResponseSpan(call, respJSON, res.statusCode ?? 0, msg.error);
          }
          (res as any).__toolResponseHandled = true;
        } catch (e) {
          console.warn("[proxy]", proxyId, "http response parse error", (e as Error)?.message);
        }
      };

      maybeHandleHttpToolResponses();
      return originalEnd(chunk, encoding as any, cb);
    };

    res.on("finish", () => {
      const shouldRecordMain =
        !(
          (req.method === "POST" && (upstreamPath.includes("/message") || url.pathname.includes("/message"))) ||
          isSseRequest ||
          hasToolCall
        );
      if (shouldRecordMain) recordMain((res.statusCode ?? 0) < 500, res.statusCode);
    });

    // forward to upstream
    req.url = upstreamPath + (url.search || "");
    proxy.web(req, res, {
      target: targetBase,
      ws: true,
      buffer: tee,
      selfHandleResponse: isSseRequest
    });
  });

  // WebSocket passthrough
  server.on("upgrade", (req, socket, head) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const upstreamPath = url.pathname.startsWith("/") ? url.pathname : `/${url.pathname}`;
      req.url = upstreamPath + (url.search || "");
      proxy.ws(req, socket, head, { target: targetBase });
    } catch {
      socket.destroy();
    }
  });

  // inflight timeout watcher
  const INFLIGHT_TIMEOUT_MS = 60_000;
  const inflightTicker = setInterval(() => {
    const now = Date.now();
    for (const [key, call] of inflight.entries()) {
      if (now - call.startedAt > INFLIGHT_TIMEOUT_MS) {
        console.warn(`[proxy] ${proxyId} inflight timeout for ${key}`);
        const { spanId: timeoutSpanId } = nextSpan(call.traceId);
        telemetry.record({
          traceId: call.traceId,
          spanId: timeoutSpanId,
          parentSpanId: call.parentSpanId,
          name: `mcp.tool/${call.toolName ?? "call"}`,
          kind: "SERVER",
          startTimeMs: call.startedAt,
          endTimeMs: now,
          status: "ERROR",
          attributes: {
            "mcp.timeout": true,
            "mcp.transport": call.transport ?? defaultTransport,
            "mcp.kind": call.kind ?? kind,
            "mcp.rpc.id": String(call.rpcId),
            "mcp.session_id": call.sessionKey,
            "mcp.proxy_id": proxyId
          },
          error: {
            message:
              (call.kind ?? kind) === "mcp_sse"
                ? "timeout waiting for SSE response"
                : (call.kind ?? kind) === "openapi"
                ? "timeout waiting for OpenAPI response"
                : "timeout waiting for HTTP response"
          }
        });
        inflight.delete(key);
        lastResponses.delete(key);
        completed.delete(key);
      }
    }
  }, 10_000);

  server.listen(listenPort, listenHost, () => {
    console.log(`[proxy:${proxyId}] listening ${listenHost}:${listenPort} -> ${targetBase} (kind=${kind})`);
  });

  return {
    kind,
    host: listener.host,
    port: listener.port,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(inflightTicker);
        server.close(() => resolve());
      })
  };
}
