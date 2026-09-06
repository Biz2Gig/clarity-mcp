import type { ActionFunctionArgs } from "react-router";
import {
  DIMENSIONS,
  METRICS,
  getHistory,
  getLiveInsights,
  pickMetric,
  quotaStatus,
} from "../clarity.server";

const MCP_SECRET = process.env.MCP_BRIDGE_SECRET;

const j = (v: unknown) => ({
  content: [{ type: "text", text: JSON.stringify(v, null, 2) }],
});

const insightsProps = {
  numOfDays: {
    type: "number",
    enum: [1, 2, 3],
    default: 3,
    description: "Rolling window: last 24 / 48 / 72 hours (UTC).",
  },
  dimension1: { type: "string", enum: DIMENSIONS as unknown as string[] },
  dimension2: { type: "string", enum: DIMENSIONS as unknown as string[] },
  dimension3: { type: "string", enum: DIMENSIONS as unknown as string[] },
} as const;

const insightsInputSchema = {
  type: "object",
  properties: insightsProps,
} as const;

/** MCP tool name -> Clarity metricName. All of these share one cached fetch. */
const METRIC_TOOLS: Record<string, string> = {
  get_traffic: "Traffic",
  get_engagement_time: "Engagement Time",
  get_scroll_depth: "Scroll Depth",
  get_popular_pages: "Popular Pages",
  get_dead_clicks: "Dead Click Count",
  get_rage_clicks: "Rage Click Count",
  get_quickback_clicks: "Quickback Click",
  get_excessive_scroll: "Excessive Scroll",
  get_script_errors: "Script Error Count",
  get_error_clicks: "Error Click Count",
};

const TOOLS = [
  {
    name: "clarity_live_insights",
    description:
      "Raw Microsoft Clarity project-live-insights response (every metric in one payload). " +
      "Served from cache; pass forceRefresh to spend one of the 10 daily API calls. " +
      "Up to 3 dimensions.",
    inputSchema: {
      type: "object",
      properties: {
        ...insightsProps,
        forceRefresh: {
          type: "boolean",
          default: false,
          description:
            "Bypass cache and call the Clarity API (counts against the 10/day limit).",
        },
      },
    },
  },
  {
    name: "get_traffic",
    description:
      "Traffic metric: session counts, bot sessions, distinct users, pages/session.",
    inputSchema: insightsInputSchema,
  },
  {
    name: "get_engagement_time",
    description: "Engagement time metric.",
    inputSchema: insightsInputSchema,
  },
  {
    name: "get_scroll_depth",
    description: "Scroll depth metric.",
    inputSchema: insightsInputSchema,
  },
  {
    name: "get_popular_pages",
    description: "Popular pages metric.",
    inputSchema: insightsInputSchema,
  },
  {
    name: "get_dead_clicks",
    description: "Dead click count metric (clicks with no effect).",
    inputSchema: insightsInputSchema,
  },
  {
    name: "get_rage_clicks",
    description: "Rage click count metric (rapid repeated clicks).",
    inputSchema: insightsInputSchema,
  },
  {
    name: "get_quickback_clicks",
    description: "Quickback click metric (navigate in, then immediately back).",
    inputSchema: insightsInputSchema,
  },
  {
    name: "get_excessive_scroll",
    description: "Excessive scroll metric.",
    inputSchema: insightsInputSchema,
  },
  {
    name: "get_script_errors",
    description: "Script error count metric (JS errors).",
    inputSchema: insightsInputSchema,
  },
  {
    name: "get_error_clicks",
    description: "Error click count metric (clicks that triggered a JS error).",
    inputSchema: insightsInputSchema,
  },
  {
    name: "clarity_history",
    description:
      "Query locally stored snapshots of past responses. No API call. " +
      "Use for date ranges older than Clarity's rolling 3-day window.",
    inputSchema: {
      type: "object",
      properties: {
        metricName: {
          type: "string",
          enum: METRICS as unknown as string[],
          description: "Optional: return only this metric from each snapshot.",
        },
        from: { type: "string", description: "ISO lower bound on fetchedAt." },
        to: { type: "string", description: "ISO upper bound on fetchedAt." },
        limit: { type: "number", default: 50 },
      },
    },
  },
  {
    name: "clarity_quota_status",
    description:
      "How many of today's 10 Clarity API calls have been used (UTC), and when the limit resets.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_dimensions",
    description: "Valid dimension names for the insight tools.",
    inputSchema: { type: "object", properties: {} },
  },
];

async function callTool(name: string, a: Record<string, unknown> = {}) {
  switch (name) {
    case "clarity_live_insights":
      return j(await getLiveInsights(a));

    case "clarity_history":
      return j(await getHistory(a));

    case "clarity_quota_status":
      return j(await quotaStatus());

    case "list_dimensions":
      return j({ dimensions: DIMENSIONS });
  }

  const metric = METRIC_TOOLS[name];
  if (metric) {
    const res = await getLiveInsights({
      numOfDays: a.numOfDays as number | undefined,
      dimension1: a.dimension1 as string | undefined,
      dimension2: a.dimension2 as string | undefined,
      dimension3: a.dimension3 as string | undefined,
    });
    return j({ metric, data: pickMetric(res.data, metric), meta: res.meta });
  }

  throw new Error(`Unknown tool: ${name}`);
}

export async function action({ request }: ActionFunctionArgs) {
  const authHeader = request.headers.get("authorization");
  if (!MCP_SECRET || authHeader !== `Bearer ${MCP_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const body = await request.json();
  const { method, params, id } = body;

  try {
    if (method === "initialize") {
      return Response.json({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "clarity-mcp", version: "1.0.0" },
        },
      });
    }
    if (method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    if (method === "tools/list") {
      return Response.json({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    }
    if (method === "tools/call") {
      return Response.json({
        jsonrpc: "2.0",
        id,
        result: await callTool(params.name, params.arguments),
      });
    }
    return Response.json(
      { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } },
      { status: 404 },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json(
      { jsonrpc: "2.0", id, error: { code: -32000, message } },
      { status: 500 },
    );
  }
}

export async function loader() {
  return new Response("Method Not Allowed", { status: 405 });
}
