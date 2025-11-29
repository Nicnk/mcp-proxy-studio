import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const indexHtml = path.join(publicDir, "index.html");

const MAX_EVENTS = 1000;
let nextId = 1;
const events = []; // {id, ts, payload}
const clients = new Set(); // {res, heartbeat}

function pushEvent(payload) {
  const entry = { id: nextId++, ts: Date.now(), payload };
  events.push(entry);
  if (events.length > MAX_EVENTS) events.shift();
  broadcast(entry);
}

function formatSse(event) {
  return `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
}

function broadcast(event) {
  const data = formatSse(event);
  for (const client of clients) {
    try {
      client.res.write(data);
    } catch {
      cleanupClient(client);
    }
  }
}

function cleanupClient(client) {
  try {
    if (client.heartbeat) clearInterval(client.heartbeat);
    client.res.end();
  } catch {}
  clients.delete(client);
}

function handleSse(req, res) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });

  const client = { res, heartbeat: null };
  clients.add(client);

  // snapshot initial
  const lastId = Number(req.headers["last-event-id"] || NaN);
  const snapshot =
    Number.isFinite(lastId) && lastId > 0 ? events.filter((e) => e.id > lastId) : events.slice(-200);
  for (const ev of snapshot) res.write(formatSse(ev));

  // heartbeat
  client.heartbeat = setInterval(() => {
    try {
      res.write(":ping\n\n");
    } catch {
      cleanupClient(client);
    }
  }, 25000);

  req.on("close", () => cleanupClient(client));
}

const server = http.createServer((req, res) => {
  const { url: rawUrl = "/", method = "GET" } = req;

  if (rawUrl.startsWith("/ingest") && method === "POST") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(body || "{}");
      } catch {
        parsed = body;
      }
      pushEvent(parsed);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", stored: events.length }));
    });
    return;
  }

  if (rawUrl.startsWith("/events")) {
    const isSse = (req.headers.accept || "").includes("text/event-stream") || rawUrl.includes("stream=1");
    if (isSse) {
      return handleSse(req, res);
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ events }));
    return;
  }

  // serve simple UI
  try {
    const html = fs.readFileSync(indexHtml, "utf-8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("UI missing: " + String(e));
  }
});

server.listen(4000, "0.0.0.0", () => {
  console.log("analytics server listening on :4000 (/ingest, /events, /)");
});
