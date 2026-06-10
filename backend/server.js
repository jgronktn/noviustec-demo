// server.js
import Fastify from "fastify";
import cors from "@fastify/cors";
import { promises as fs, existsSync } from "node:fs";
import * as path from "node:path";

// Auto-load backend/.env for local dev (`node server.js`). In production,
// systemd loads the same file via EnvironmentFile= — both paths converge.
const ENV_PATH = path.resolve(import.meta.dirname, ".env");
if (existsSync(ENV_PATH)) {
  process.loadEnvFile(ENV_PATH);
}

const { processReceiptPayload } = await import("./src/processor.js");

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const HOST = process.env.HOST ?? "127.0.0.1";  // loopback only — nginx fronts it
const LOG_DIR = process.env.LOG_DIR ?? "./inbound-log";

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
  },
  bodyLimit: 30 * 1024 * 1024,  // 30MB to match nginx client_max_body_size
  trustProxy: true,             // honor X-Forwarded-* from nginx
});

// Register CORS — must come before route registrations
await app.register(cors, {
  origin: [
    "https://demo.noviustec.com",
    "http://localhost:5500",   // VS Code Live Server default port
    "http://localhost:5173",   // Vite default port
    "http://localhost:3000",   // Other common dev ports
  ],
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
});

// Make sure the log directory exists
await fs.mkdir(LOG_DIR, { recursive: true });

// ────────────────────────────────────────────────────────────────────────────
// Health check — hit this from the browser or curl to confirm the chain works
// ────────────────────────────────────────────────────────────────────────────
app.get("/health", async () => ({
  ok: true,
  service: "bookkeeping-api",
  time: new Date().toISOString(),
  uptime_seconds: Math.round(process.uptime()),
  node_version: process.version,
}));

// ────────────────────────────────────────────────────────────────────────────
// /api/* routes (auth-gated via bearer token). Registered as a Fastify
// plugin so the auth preHandler is scoped to /api/* only — /webhooks/* and
// /health stay open.
// ────────────────────────────────────────────────────────────────────────────
const { default: apiRoutes } = await import("./src/api/routes.js");
await app.register(apiRoutes, { logDir: LOG_DIR });

// ────────────────────────────────────────────────────────────────────────────
// Echo endpoint — verifies that nginx is forwarding headers correctly
// Hit this and inspect the response to confirm X-Forwarded-* are passing through
// ────────────────────────────────────────────────────────────────────────────
app.get("/debug/echo", async (req) => ({
  method: req.method,
  url: req.url,
  ip: req.ip,                       // should be the real client IP via trustProxy
  headers: req.headers,
  query: req.query,
  hostname: req.hostname,
  protocol: req.protocol,           // should be "https" if nginx forwarded correctly
}));

// ────────────────────────────────────────────────────────────────────────────
// Postmark inbound webhook receiver
// Logs to console AND saves the JSON payload to disk for replay/inspection
// ────────────────────────────────────────────────────────────────────────────
app.post("/webhooks/postmark-inbound", async (req, reply) => {
  const body = req.body;

  // Save full payload to disk for later inspection
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `inbound-${stamp}.json`;
  const filepath = path.join(LOG_DIR, filename);
  try {
    await fs.writeFile(filepath, JSON.stringify(body, null, 2));
  } catch (err) {
    req.log.error({ err }, "failed to write inbound log");
  }

  // Pull a few interesting fields for the log line
  req.log.info({
    file: filename,
    from: body?.From,
    to: body?.To,
    subject: body?.Subject,
    messageId: body?.MessageID,
    attachments: body?.Attachments?.length ?? 0,
    bodyBytes: JSON.stringify(body).length,
  }, "inbound email received");

  // Kick off parsing in the background. Don't await — Claude vision calls take
  // seconds and we must return 200 fast (Postmark retries non-200 responses).
  // Errors are logged and persisted to disk inside processReceiptPayload;
  // we still need the .catch() here so the rejection doesn't become unhandled.
  processReceiptPayload({
    payload: body,
    logger: req.log,
    logDir: LOG_DIR,
    sourceFilename: filename,
  }).catch(() => {});

  return reply.code(200).send({ ok: true, stored: filename });
});

// ────────────────────────────────────────────────────────────────────────────
// Generic POST sink — useful for testing arbitrary webhook setups
// ────────────────────────────────────────────────────────────────────────────
app.post("/debug/sink", async (req) => {
  req.log.info({ body: req.body, headers: req.headers }, "sink received");
  return { ok: true };
});

// ────────────────────────────────────────────────────────────────────────────
// Root — just so you don't get a 404 on /
// ────────────────────────────────────────────────────────────────────────────
app.get("/", async () => ({
  service: "bookkeeping-api",
  endpoints: ["/health", "/debug/echo", "/debug/sink", "/webhooks/postmark-inbound"],
}));

// ────────────────────────────────────────────────────────────────────────────
// Graceful shutdown — systemd sends SIGTERM on `systemctl stop` or restart
// Cleanly close in-flight requests rather than dropping them
// ────────────────────────────────────────────────────────────────────────────
const shutdown = async (signal) => {
  app.log.info(`received ${signal}, shutting down`);
  try {
    await app.close();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, "error during shutdown");
    process.exit(1);
  }
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ────────────────────────────────────────────────────────────────────────────
// Start
// ────────────────────────────────────────────────────────────────────────────
try {
  await app.listen({ port: PORT, host: HOST });
  app.log.info(`listening on http://${HOST}:${PORT}`);
} catch (err) {
  app.log.error({ err }, "failed to start");
  process.exit(1);
}
