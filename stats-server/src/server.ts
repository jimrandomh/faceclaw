import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Pool } from "pg";
import { saveReport } from "./db.ts";
import { parseReport, ReportError } from "./report.ts";

/**
 * Receives the phone app's daily analytics reports (PROTOCOL.md) and stores
 * them in Postgres. Runs behind nginx, which terminates TLS and rate-limits;
 * the database connection comes from the standard PG* environment variables.
 *
 * Nothing about the request itself is stored or logged: no IP address, no
 * headers, only the report body.
 */

const PORT = Number(process.env.PORT ?? 8290);
const HOST = process.env.HOST ?? "127.0.0.1";
const MAX_BODY_BYTES = 64 * 1024;

const pool = new Pool({ max: 4 });
pool.on("error", (error) => console.error("idle database client failed:", error.message));

const server = createServer((request, response) => {
  handle(request, response).catch((error: unknown) => {
    console.error("request failed:", error instanceof Error ? error.message : error);
    if (!response.headersSent) reply(response, 500, { error: "internal error" });
  });
});

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const path = (request.url ?? "/").split("?")[0];
  if (path === "/v1/report") {
    if (request.method !== "POST") return reply(response, 405, { error: "POST only" });
    if (Number(request.headers["content-length"] ?? 0) > MAX_BODY_BYTES) {
      response.setHeader("connection", "close");
      return reply(response, 413, { error: "too large" });
    }
    const body = await readBody(request);
    if (body === null) return reply(response, 413, { error: "too large" });
    let report;
    try {
      report = parseReport(JSON.parse(body));
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof ReportError) {
        return reply(response, 400, { error: error.message });
      }
      throw error;
    }
    await saveReport(pool, report);
    // Room for more later (e.g. the latest released version, for update checks).
    return reply(response, 200, { ok: true });
  }
  if (path === "/healthz" && request.method === "GET") {
    await pool.query("select 1");
    return reply(response, 200, { ok: true });
  }
  reply(response, 404, { error: "not found" });
}

/**
 * The request body as text, or null if it is over MAX_BODY_BYTES. An
 * oversized body is still read to the end (and dropped) so the client gets
 * the 413 instead of a reset connection; nginx caps it before it gets here.
 */
function readBody(request: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    request.on("end", () => resolve(size > MAX_BODY_BYTES ? null : Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function reply(response: ServerResponse, status: number, body: object): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function shutdown(): void {
  server.close(() => {
    void pool.end().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

server.listen(PORT, HOST, () => console.log(`faceclaw-stats listening on ${HOST}:${PORT}`));
