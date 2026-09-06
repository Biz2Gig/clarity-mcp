import { describe, expect, it } from "vitest";

import { DIMENSIONS } from "../app/clarity.server";
import { TOOL_NAMES } from "../app/mcp/build.server";
import { handleMcpRequest } from "../app/mcp/http.server";

const URL = "http://localhost:3000/mcp";
const TOKEN = process.env.MCP_BRIDGE_SECRET!;

async function rpc(
  body: unknown,
  init: { token?: string | null; method?: string; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    ...(init.headers ?? {}),
  };
  if (init.token !== null) headers.authorization = `Bearer ${init.token ?? TOKEN}`;
  const res = await handleMcpRequest(
    new Request(URL, {
      method: init.method ?? "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = { _raw: text };
  }
  return { status: res.status, json, res };
}

const init = (protocolVersion = "2025-06-18") => ({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: "vitest", version: "1.0.0" },
  },
});

describe("MCP transport - auth & method", () => {
  it("401 without a bearer token", async () => {
    const { status } = await rpc(init(), { token: null });
    expect(status).toBe(401);
  });

  it("401 with the wrong bearer token", async () => {
    const { status, json } = await rpc(init(), { token: "nope" });
    expect(status).toBe(401);
    expect(json.error.code).toBe(-32001);
  });

  it("405 for GET", async () => {
    const { status } = await rpc(undefined, { method: "GET" });
    expect(status).toBe(405);
  });

  it("400 / -32700 for invalid JSON", async () => {
    const res = await handleMcpRequest(
      new Request(URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${TOKEN}`,
        },
        body: "{ not json",
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32700);
  });
});

describe("MCP initialization & discovery", () => {
  it("negotiates a protocol version (never falsely 2024-11-05)", async () => {
    const { status, json } = await rpc(init("2025-06-18"));
    expect(status).toBe(200);
    expect(json.result.serverInfo.name).toBe("clarity-mcp");
    expect(json.result.protocolVersion).toBe("2025-06-18");
    expect(json.result.protocolVersion).not.toBe("2024-11-05");
  });

  it("lists every tool - 14 existing + 9 new", async () => {
    const { status, json } = await rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    expect(status).toBe(200);
    const names: string[] = json.result.tools.map((t: any) => t.name);
    for (const expected of TOOL_NAMES) expect(names).toContain(expected);
    for (const preserved of [
      "clarity_live_insights",
      "get_traffic",
      "get_engagement_time",
      "get_scroll_depth",
      "get_popular_pages",
      "get_dead_clicks",
      "get_rage_clicks",
      "get_quickback_clicks",
      "get_excessive_scroll",
      "get_script_errors",
      "get_error_clicks",
      "clarity_history",
      "clarity_quota_status",
      "list_dimensions",
    ]) {
      expect(names).toContain(preserved);
    }
    expect(names.length).toBe(23);
  });
});

describe("MCP tool invocation", () => {
  it("calls list_dimensions and returns structured content", async () => {
    const { status, json } = await rpc({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "list_dimensions", arguments: {} },
    });
    expect(status).toBe(200);
    expect(json.result.structuredContent.dimensions).toEqual([...DIMENSIONS]);
  });

  it("returns a JSON-RPC error for an unknown tool", async () => {
    const { json } = await rpc({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "does_not_exist", arguments: {} },
    });
    const errored = Boolean(json.error) || json.result?.isError === true;
    expect(errored).toBe(true);
  });

  it("rejects bad arguments (schema validation)", async () => {
    const { json } = await rpc({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "get_video_status", arguments: {} },
    });
    const errored = Boolean(json.error) || json.result?.isError === true;
    expect(errored).toBe(true);
  });

  it("import_clarity_recordings rejects neither/both input sources", async () => {
    const { json } = await rpc({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "import_clarity_recordings", arguments: {} },
    });
    expect(json.result.isError).toBe(true);
    expect(json.result.structuredContent.error.code).toBe("validation_error");
  });
});
