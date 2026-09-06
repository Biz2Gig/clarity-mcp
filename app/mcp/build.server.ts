/**
 * Builds the MCP server from the official @modelcontextprotocol/sdk.
 * A fresh instance is created per HTTP request (stateless transport).
 *
 * Tool groups:
 *   - Clarity aggregate analytics (14 pre-existing tools, unchanged behavior)
 *   - Clarity recording metadata (import / search / get)
 *   - Video ingestion + analysis (submit / status / analysis / transcript /
 *     query / frame)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import packageJson from "../../package.json" with { type: "json" };
import {
  DIMENSIONS,
  METRICS,
  getHistory,
  getLiveInsights,
  pickMetric,
  quotaStatus,
} from "../clarity.server";
import {
  getClarityRecording,
  importClarityRecordings,
  searchClarityRecordings,
} from "../clarity/recordings.server";
import { isAppError } from "../errors";
import {
  answerVideoQuestion,
  getVideoAnalysis,
  getVideoFrameImage,
} from "../video/analysis.server";
import { createVideoJob, getVideoStatus } from "../video/jobs.server";
import { getTranscript } from "../video/pipeline.server";
import { parseTimestampToMs } from "../video/timestamps";

const dimensionEnum = z.enum(DIMENSIONS as unknown as [string, ...string[]]);
const metricEnum = z.enum(METRICS as unknown as [string, ...string[]]);

const insightsShape = {
  numOfDays: z
    .number()
    .int()
    .min(1)
    .max(3)
    .optional()
    .describe("Rolling window: last 24 / 48 / 72 hours (UTC). Default 3."),
  dimension1: dimensionEnum.optional(),
  dimension2: dimensionEnum.optional(),
  dimension3: dimensionEnum.optional(),
};

function ok(structured: unknown, extraContent: CallToolResult["content"] = []): CallToolResult {
  return {
    content: [
      { type: "text", text: JSON.stringify(structured, null, 2) },
      ...extraContent,
    ],
    structuredContent: structured as Record<string, unknown>,
  };
}

function fail(err: unknown): CallToolResult {
  const code = isAppError(err) ? err.code : "internal_error";
  const message = err instanceof Error ? err.message : String(err);
  const details = isAppError(err) ? err.details : undefined;
  return {
    isError: true,
    content: [{ type: "text", text: `${code}: ${message}` }],
    structuredContent: { error: { code, message, details } },
  };
}

/** Wrap a tool handler so domain errors become structured, non-throwing results. */
function guard<A>(fn: (args: A) => Promise<CallToolResult>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return await fn(args);
    } catch (err) {
      return fail(err);
    }
  };
}

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

export function buildMcpServer(): McpServer {
  const server = new McpServer(
    { name: "clarity-mcp", version: packageJson.version },
    {
      capabilities: { tools: {}, logging: {} },
      instructions:
        "Microsoft Clarity analytics + recording-metadata + video-analysis MCP " +
        "server. Clarity aggregate calls are capped at 10/day and cached. " +
        "Clarity recordings are METADATA imported from the dashboard CSV export " +
        "- replay data is not available via the API. Videos are ingested from " +
        "HTTPS URLs and processed asynchronously by a worker.",
    },
  );

  // --- Clarity aggregate analytics -------------------------------------------

  server.registerTool(
    "clarity_live_insights",
    {
      title: "Clarity live insights (raw)",
      description:
        "Raw Microsoft Clarity project-live-insights response (every metric). " +
        "Cache-first; `forceRefresh` spends one of the 10 daily API calls. " +
        "Stale data is always labelled `meta.stale=true` with a `meta.warning`.",
      inputSchema: {
        ...insightsShape,
        forceRefresh: z
          .boolean()
          .optional()
          .describe("Bypass a fresh cache and call the Clarity API."),
      },
    },
    guard(async (a) => ok(await getLiveInsights(a))),
  );

  for (const [tool, metricName] of Object.entries(METRIC_TOOLS)) {
    server.registerTool(
      tool,
      {
        title: `Clarity: ${metricName}`,
        description: `The "${metricName}" metric from project-live-insights. Shares one cached fetch with the other metric tools (0 extra API calls).`,
        inputSchema: insightsShape,
      },
      guard(async (a: z.objectOutputType<typeof insightsShape, z.ZodTypeAny>) => {
        const res = await getLiveInsights(a);
        return ok({
          metric: metricName,
          data: pickMetric(res.data, metricName),
          meta: res.meta,
        });
      }),
    );
  }

  server.registerTool(
    "clarity_history",
    {
      title: "Clarity snapshot history",
      description:
        "Locally stored snapshots of past responses. No API call. Each snapshot " +
        "is a ROLLING 1-3 day aggregate window as of `fetchedAt`; snapshots " +
        "overlap and must NOT be summed as per-day data.",
      inputSchema: {
        metricName: metricEnum.optional(),
        from: z.string().optional().describe("ISO lower bound on fetchedAt."),
        to: z.string().optional().describe("ISO upper bound on fetchedAt."),
        limit: z.number().int().min(1).max(500).optional(),
      },
    },
    guard(async (a) => ok(await getHistory(a))),
  );

  server.registerTool(
    "clarity_quota_status",
    {
      title: "Clarity API quota",
      description:
        "How many of today's 10 Clarity API calls have been used (UTC) and when the limit resets.",
      inputSchema: {},
    },
    guard(async () => ok(await quotaStatus())),
  );

  server.registerTool(
    "list_dimensions",
    {
      title: "List Clarity dimensions",
      description: "Valid dimension names for the insight tools.",
      inputSchema: {},
    },
    guard(async () => ok({ dimensions: DIMENSIONS })),
  );

  // --- Clarity recording metadata -----------------------------------------

  server.registerTool(
    "import_clarity_recordings",
    {
      title: "Import Clarity recordings CSV",
      description:
        "Import recording METADATA from the CSV exported in the Clarity " +
        "dashboard (Recordings -> Export). Provide EXACTLY ONE of `csvText` or " +
        "`csvUrl`. Rows are deduplicated by recording URL or session ID. This " +
        "does NOT import replay data - the Data Export API does not expose it.",
      inputSchema: {
        csvText: z.string().optional().describe("Raw CSV content."),
        csvUrl: z
          .string()
          .url()
          .optional()
          .describe("HTTPS URL to a CSV (SSRF-checked, size-limited)."),
        replaceExisting: z
          .boolean()
          .optional()
          .describe("Delete all previously imported recordings first."),
      },
    },
    guard(async (a) => ok(await importClarityRecordings(a))),
  );

  server.registerTool(
    "search_clarity_recordings",
    {
      title: "Search Clarity recordings",
      description:
        "Query imported recording metadata. Returns structured fields plus the " +
        "original Clarity `recordingUrl` for each match.",
      inputSchema: {
        from: z.string().optional().describe("ISO start-time lower bound."),
        to: z.string().optional().describe("ISO start-time upper bound."),
        entryUrl: z.string().optional().describe("Substring match on entry URL."),
        exitUrl: z.string().optional().describe("Substring match on exit URL."),
        url: z
          .string()
          .optional()
          .describe("Substring match on entry OR exit URL."),
        device: z.string().optional(),
        browser: z.string().optional(),
        country: z.string().optional(),
        minDurationMs: z.number().int().min(0).optional(),
        hasRageClicks: z.boolean().optional(),
        hasDeadClicks: z.boolean().optional(),
        hasScriptErrors: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
        includeRaw: z
          .boolean()
          .optional()
          .describe("Include the full original CSV row per record."),
      },
    },
    guard(async (a) => ok(await searchClarityRecordings(a))),
  );

  server.registerTool(
    "get_clarity_recording",
    {
      title: "Get one Clarity recording",
      description:
        "Fetch a single imported recording by local `id`, `sessionId` or " +
        "`recordingUrl` (exactly one). Includes the complete original CSV row.",
      inputSchema: {
        id: z.string().optional(),
        sessionId: z.string().optional(),
        recordingUrl: z.string().optional(),
      },
    },
    guard(async (a) => ok(await getClarityRecording(a))),
  );

  // --- Video ingestion + analysis --------------------------------------

  server.registerTool(
    "submit_video",
    {
      title: "Submit a video for analysis",
      description:
        "Queue a video for asynchronous analysis. Provide a public or presigned " +
        "HTTPS `videoUrl` (NOT a base64 payload). Returns immediately with " +
        "`videoId` / `jobId` / `status`; poll `get_video_status`.",
      inputSchema: {
        videoUrl: z.string().url().describe("HTTPS URL to the video file."),
        title: z.string().optional(),
        language: z
          .string()
          .optional()
          .describe("BCP-47 hint for transcription (e.g. 'en', 'es')."),
        analysisPrompt: z
          .string()
          .optional()
          .describe("Focus/instructions for frame analysis and synthesis."),
        extractVisuals: z
          .boolean()
          .optional()
          .describe("Extract + analyze keyframes (default true)."),
      },
    },
    guard(async (a) => ok(await createVideoJob(a))),
  );

  server.registerTool(
    "get_video_status",
    {
      title: "Video processing status",
      description:
        "Current stage (queued, downloading, probing, extracting_audio, " +
        "transcribing, extracting_frames, analyzing_frames, synthesizing, " +
        "completed, failed), progress, any error, and video metadata.",
      inputSchema: { videoId: z.string() },
    },
    guard(async (a) => ok(await getVideoStatus(a.videoId))),
  );

  server.registerTool(
    "get_video_analysis",
    {
      title: "Video analysis",
      description:
        "Executive summary, description, transcript summary, important events, " +
        "visible text/OCR, detected objects/interfaces, problems, " +
        "recommendations, timestamp citations, and model provenance. " +
        "`detail` = 'compact' | 'detailed' (default).",
      inputSchema: {
        videoId: z.string(),
        detail: z.enum(["compact", "detailed"]).optional(),
      },
    },
    guard(async (a) => ok(await getVideoAnalysis(a))),
  );

  server.registerTool(
    "get_video_transcript",
    {
      title: "Video transcript",
      description:
        "Paginated transcript segments (start/end ms, text, speaker and " +
        "confidence when available). Optional `startTime`/`endTime` window " +
        "(seconds, `MM:SS`, `HH:MM:SS.mmm`, `1m30s`, or `1500ms`).",
      inputSchema: {
        videoId: z.string(),
        startTime: z.union([z.string(), z.number()]).optional(),
        endTime: z.union([z.string(), z.number()]).optional(),
        limit: z.number().int().min(1).max(500).optional(),
        offset: z.number().int().min(0).optional(),
      },
    },
    guard(async (a) =>
      ok(
        await getTranscript({
          videoId: a.videoId,
          startMs: a.startTime !== undefined ? parseTimestampToMs(a.startTime) : undefined,
          endMs: a.endTime !== undefined ? parseTimestampToMs(a.endTime) : undefined,
          limit: a.limit,
          offset: a.offset,
        }),
      ),
    ),
  );

  server.registerTool(
    "query_video",
    {
      title: "Ask a question about a video",
      description:
        "Answer a question using ONLY the stored transcript, keyframes and " +
        "analysis for this video. Every factual claim carries supporting " +
        "timestamps; insufficient evidence is stated explicitly.",
      inputSchema: {
        videoId: z.string(),
        question: z.string().min(3),
        startTime: z.union([z.string(), z.number()]).optional(),
        endTime: z.union([z.string(), z.number()]).optional(),
      },
    },
    guard(async (a) => ok(await answerVideoQuestion(a))),
  );

  server.registerTool(
    "get_video_frame",
    {
      title: "Get a video keyframe",
      description:
        "Return the nearest extracted JPEG keyframe to `timestamp` as an MCP " +
        "image content block, plus its exact timestamp and visual description.",
      inputSchema: {
        videoId: z.string(),
        timestamp: z
          .union([z.string(), z.number()])
          .describe("Seconds, `MM:SS`, `HH:MM:SS.mmm`, `1m30s`, or `1500ms`."),
      },
    },
    guard(async (a) => {
      const r = await getVideoFrameImage(a);
      const { image, ...meta } = r;
      return ok(meta, [
        { type: "image", data: image.base64, mimeType: image.mimeType },
      ]);
    }),
  );

  return server;
}

/** Static tool metadata (name + description) - used by tests and docs. */
export const TOOL_NAMES = [
  "clarity_live_insights",
  ...Object.keys(METRIC_TOOLS),
  "clarity_history",
  "clarity_quota_status",
  "list_dimensions",
  "import_clarity_recordings",
  "search_clarity_recordings",
  "get_clarity_recording",
  "submit_video",
  "get_video_status",
  "get_video_analysis",
  "get_video_transcript",
  "query_video",
  "get_video_frame",
] as const;
