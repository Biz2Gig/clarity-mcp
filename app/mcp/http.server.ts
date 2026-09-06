/**
 * Streamable HTTP transport for the MCP server, built on the official SDK's
 * Fetch-native `WebStandardStreamableHTTPServerTransport` in stateless JSON
 * mode. `POST /mcp` is preserved. Protocol negotiation, tool discovery /
 * invocation, JSON-RPC framing and input validation are handled by the SDK -
 * this module adds bearer auth, Origin/Host validation, a body-size limit and
 * a small backwards-compat shim for clients that send a lenient Accept header.
 *
 * GET /mcp returns 405 (no server-initiated SSE stream in stateless mode,
 * which the spec permits). The server never advertises protocol version
 * "2024-11-05" while using this transport - the SDK negotiates the version.
 */

import { timingSafeEqual } from "node:crypto";

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { config } from "../config.server";
import { buildMcpServer } from "./build.server";

function jsonRpc(
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message } }),
    { status, headers: { "content-type": "application/json", ...headers } },
  );
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function checkAuth(request: Request): Response | null {
  const secret = config.mcpBridgeSecret;
  if (!secret) {
    return jsonRpc(500, -32001, "Server misconfigured: MCP_BRIDGE_SECRET is not set.");
  }
  const header = request.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m || !safeEqual(m[1].trim(), secret)) {
    return jsonRpc(401, -32001, "Missing or invalid bearer token.", {
      "WWW-Authenticate": 'Bearer realm="clarity-mcp"',
    });
  }
  return null;
}

function checkOriginAndHost(request: Request): Response | null {
  const allowedOrigins = config.mcpAllowedOrigins;
  const origin = request.headers.get("origin");
  if (allowedOrigins.length > 0 && origin && !allowedOrigins.includes(origin)) {
    return jsonRpc(403, -32001, `Origin "${origin}" is not allowed.`);
  }
  const allowedHosts = config.mcpAllowedHosts;
  if (allowedHosts.length > 0) {
    const host = request.headers.get("host");
    if (!host || !allowedHosts.includes(host)) {
      return jsonRpc(403, -32001, `Host "${host ?? "(none)"}" is not allowed.`);
    }
  }
  return null;
}

class PayloadTooLargeError extends Error {}

async function readBodyLimited(request: Request, maxBytes: number): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new PayloadTooLargeError();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Normalize headers so lenient legacy clients satisfy the strict transport. */
function normalizedHeaders(request: Request): Headers {
  const headers = new Headers(request.headers);
  if (!config.mcpStrictAccept) {
    const accept = headers.get("accept") ?? "";
    if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
      headers.set("accept", "application/json, text/event-stream");
    }
    const ct = headers.get("content-type") ?? "";
    if (request.method === "POST" && !/application\/json/i.test(ct)) {
      headers.set("content-type", "application/json");
    }
  }
  // The transport does not need the auth header; do not forward the secret.
  headers.delete("authorization");
  return headers;
}

/**
 * Handle one MCP HTTP request. Wired to both `loader` (GET) and `action`
 * (POST/DELETE) of the `/mcp` route.
 */
export async function handleMcpRequest(request: Request): Promise<Response> {
  const method = request.method.toUpperCase();

  if (method === "GET") {
    return jsonRpc(
      405,
      -32000,
      "This endpoint is a stateless Streamable HTTP MCP server; use POST for JSON-RPC.",
      { Allow: "POST, DELETE" },
    );
  }
  if (method !== "POST" && method !== "DELETE") {
    return jsonRpc(405, -32000, `Method ${method} not allowed.`, {
      Allow: "POST, DELETE",
    });
  }

  const authErr = checkAuth(request);
  if (authErr) return authErr;
  const originErr = checkOriginAndHost(request);
  if (originErr) return originErr;

  let parsedBody: unknown;
  if (method === "POST") {
    let raw: string;
    try {
      raw = await readBodyLimited(request, config.mcpMaxBodyBytes);
    } catch (e) {
      if (e instanceof PayloadTooLargeError) {
        return jsonRpc(
          413,
          -32000,
          `Request body exceeds MCP_MAX_BODY_BYTES (${config.mcpMaxBodyBytes}).`,
        );
      }
      throw e;
    }
    if (raw.trim() === "") {
      return jsonRpc(400, -32700, "Parse error: empty request body.");
    }
    try {
      parsedBody = JSON.parse(raw);
    } catch {
      return jsonRpc(400, -32700, "Parse error: request body is not valid JSON.");
    }
  }

  const proxyRequest = new Request(request.url, {
    method,
    headers: normalizedHeaders(request),
  });

  const server = buildMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    return await transport.handleRequest(
      proxyRequest,
      method === "POST" ? { parsedBody } : undefined,
    );
  } finally {
    await transport.close().catch(() => {});
    await server.close().catch(() => {});
  }
}
