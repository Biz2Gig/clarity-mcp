# clarity-mcp

A production-capable **MCP server** (Model Context Protocol, official
`@modelcontextprotocol/sdk`, Streamable HTTP transport) that exposes:

1. **Microsoft Clarity aggregate analytics** — cached, quota-managed access to
   the [Clarity Data Export API](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-data-export-api).
2. **Clarity recording metadata** — import from the CSV you export in the
   Clarity dashboard (metadata only; see the limitation below).
3. **Video analysis** — ingest a video from an HTTPS URL, transcribe it,
   extract and analyze keyframes, and answer timestamp-grounded questions.

Stack (unchanged from the prototype): **React Router 7 + TypeScript + Prisma +
PostgreSQL**, plus a separate **worker** process and **FFmpeg** for video.

---

## Critical limitation: Clarity session replays are NOT available

Microsoft's documented Clarity Data Export API exposes **aggregate metrics
only**. It does **not** return session replays, and Clarity "recordings" are
DOM/event reconstructions, not MP4 files. This server:

- **Does not** scrape Clarity, call undocumented endpoints, or bypass auth.
- Imports recording **metadata** from the CSV a user exports in the Clarity
  dashboard (**Recordings → Export**). Each `recordingUrl` is the Clarity
  **dashboard deep-link**, preserved as-is — not a downloadable media file.
- Never claims a replay can be retrieved through the API.

To analyze actual video, use the video tools with a real video URL (a screen
recording, an uploaded MP4, etc.) — not a Clarity link.

---

## Architecture

```
        ┌──────────────┐        POST /mcp (JSON-RPC 2.0, Streamable HTTP)
 MCP ───▶  React Router │◀─── bearer auth, Origin/Host check, body limit
 client │  app/routes   │
        │   /mcp.ts     │──▶ @modelcontextprotocol/sdk  (McpServer, stateless
        └──────┬───────┘      WebStandard transport, JSON responses)
               │
       ┌───────┴───────────────────────────────────────────┐
       │ tools                                             │
       │  • Clarity aggregate  → app/clarity.server.ts      │
       │      cache + atomic quota ledger + snapshots       │
       │  • Clarity recordings → app/clarity/*              │
       │      tolerant CSV parser + Prisma                  │
       │  • Video               → app/video/*, enqueue only │
       └───────────────┬───────────────────────────────────┘
                       │  ProcessingJob rows (PostgreSQL)
                       ▼
              ┌──────────────────┐   FOR UPDATE SKIP LOCKED
              │  worker (npm run │   claims one job at a time
              │  worker)         │   stages: downloading → probing →
              │                  │   extracting_audio → transcribing →
              │  FFmpeg + providers│  extracting_frames → analyzing_frames →
              └────────┬─────────┘   synthesizing → completed
                       ▼
        storage (filesystem volume)   +   Prisma models
        source video, JPEG keyframes      TranscriptSegment, ExtractedFrame,
                                          VideoAnalysis, provenance
```

**Providers** are behind interfaces (`app/providers/types.ts`):
speech-to-text, vision, synthesis/QA. The shipped implementation is OpenAI
(`OPENAI_API_KEY`). Missing credentials produce a **clear configuration
error** — never a fabricated transcript or analysis. A `mock` provider exists
for tests only.

**Storage** is behind `StorageProvider` (`app/storage/types.ts`). Only a
filesystem driver ships; an S3-compatible driver can be added without touching
callers. Full video binaries are never stored in PostgreSQL.

### MCP protocol notes

- Transport: the SDK's `WebStandardStreamableHTTPServerTransport` in
  **stateless JSON mode**. `POST /mcp` is preserved. `GET /mcp` returns `405`
  (no standalone SSE stream in stateless mode — permitted by the spec).
  `DELETE /mcp` is accepted.
- **Protocol version is negotiated by the SDK** (currently up to
  `2025-11-25`). The server never falsely advertises `2024-11-05`.
- Provided by the SDK: protocol negotiation, tool discovery/among invocation,
  JSON-RPC framing and error codes, input validation against each tool's Zod
  schema, structured tool results (`structuredContent`), and text/image content
  blocks (`get_video_frame` returns an image block).
- Added by this server: bearer auth (`MCP_BRIDGE_SECRET`, constant-time
  compare), Origin/Host allow-lists, request-body size limit, and a
  compatibility shim that normalizes a lenient `Accept` header for simple
  one-shot JSON-RPC clients (disable with `MCP_STRICT_ACCEPT=true`).

---

## Environment variables

See [`.env.example`](./.env.example) for the annotated full list. Summary:

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | — | Postgres connection string (**required**) |
| `MCP_BRIDGE_SECRET` | — | Bearer secret for every MCP call (**required**) |
| `MCP_ALLOWED_ORIGINS` | *(all)* | Comma list of allowed browser Origins |
| `MCP_ALLOWED_HOSTS` | *(all)* | Comma list of allowed Host headers |
| `MCP_STRICT_ACCEPT` | `false` | Require spec-strict `Accept` header |
| `MCP_MAX_BODY_BYTES` | `5242880` | Max JSON-RPC body size |
| `CLARITY_API_TOKEN` | — | Clarity Data Export API JWT |
| `CLARITY_CACHE_TTL_MS` | `21600000` | Freshness window for cached responses |
| `CLARITY_REFRESH_POLICY` | `revalidate` | `revalidate` \| `stale` (see below) |
| `CLARITY_CSV_MAX_BYTES` / `_MAX_ROWS` | `25MiB` / `200000` | CSV import limits |
| `STORAGE_DRIVER` / `STORAGE_DIR` | `filesystem` / `./storage` | Object storage |
| `VIDEO_MAX_BYTES` | `524288000` | Max downloaded video size |
| `VIDEO_MAX_DURATION_SEC` | `10800` | Max video duration |
| `VIDEO_KEYFRAME_INTERVAL_SEC` | `15` | Forced max interval between keyframes |
| `VIDEO_MAX_KEYFRAMES` | `120` | Hard cap on keyframes per video |
| `VIDEO_SCENE_THRESHOLD` | `0.4` | FFmpeg scene-change sensitivity |
| `DOWNLOAD_CONNECT_TIMEOUT_MS` / `_TOTAL_TIMEOUT_MS` | `15000` / `600000` | Download timeouts |
| `DOWNLOAD_MAX_REDIRECTS` | `3` | Redirect limit (re-validated each hop) |
| `ALLOW_INSECURE_URLS` | off-prod: `true` | Permit `http://` + private IPs (dev) |
| `FFMPEG_PATH` / `FFPROBE_PATH` | `ffmpeg` / `ffprobe` | Binary locations |
| `WORKER_ID` | `worker-<pid>` | Worker identity in job locks |
| `WORKER_POLL_INTERVAL_MS` | `3000` | Idle poll interval |
| `WORKER_JOB_TIMEOUT_MS` | `1800000` | Per-job wall-clock timeout |
| `WORKER_STALE_LOCK_MS` | `900000` | Reclaim a crashed worker's job after |
| `STT_PROVIDER` / `VISION_PROVIDER` / `SYNTHESIS_PROVIDER` | `openai` | `openai` \| `mock` |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` | — | OpenAI credentials |
| `STT_MODEL` / `VISION_MODEL` / `SYNTHESIS_MODEL` | `whisper-1` / `gpt-4o-mini` / `gpt-4o-mini` | Model IDs |
| `PROVIDERS_ALLOW_MOCK` | `false` | Force mock providers outside tests |
| `TEST_DATABASE_URL` | — | Enables DB-backed test suites |

---

## Local development

Requires **Node 20** (`.nvmrc`), **PostgreSQL**, and **FFmpeg** (for video).

```bash
npm install
cp .env.example .env          # fill DATABASE_URL, MCP_BRIDGE_SECRET, CLARITY_API_TOKEN
npx prisma migrate deploy      # or: npx prisma migrate dev
npm run dev                    # http://localhost:3000  (MCP at POST /mcp)

# in a second terminal, for video jobs:
npm run worker
```

## Database migrations

A real initial migration is committed at
`prisma/migrations/20260906000000_init/`. On a **fresh database**:

```bash
npx prisma migrate deploy      # creates every table + enum
```

All `DateTime` columns are `timestamptz` so job scheduling and quota logic are
correct regardless of the DB server's local time zone.

## Docker

```bash
export MCP_BRIDGE_SECRET=$(openssl rand -hex 32)
export CLARITY_API_TOKEN=...          # Clarity Data Export token
export OPENAI_API_KEY=...             # only needed for real video analysis
docker compose up --build
```

Brings up `db` (Postgres), `app` (web/MCP, runs `prisma migrate deploy` on
start), and `worker`. They share a `clarity_storage` volume mounted at
`/data/storage`. Scale workers:

```bash
docker compose up --scale worker=3
```

The Dockerfile is a **multi-stage** build: a full `npm ci` for the build
stage, then `npm prune --omit=dev`; the runtime image is `node:20-bookworm-slim`
with `ffmpeg` installed, prod dependencies only, running as the non-root `node`
user. `NODE_ENV=production` is set only in the runtime stage.

## Worker

```bash
npm run worker            # tsx app/worker.ts
```

- Claims jobs with `SELECT ... FOR UPDATE SKIP LOCKED` — **run as many as you
  like**; a job is processed by exactly one worker.
- A crashed worker's job is reclaimed after `WORKER_STALE_LOCK_MS`.
- Failures keep their error message and retry with exponential backoff up to
  `maxAttempts` (3), then the job and video are marked `failed`.
- Graceful `SIGINT`/`SIGTERM` (waits briefly for an in-flight job).

## MCP client configuration

Streamable HTTP endpoint, bearer auth:

```jsonc
{
  "mcpServers": {
    "clarity": {
      "type": "http",
      "url": "https://your-host.example/mcp",
      "headers": { "Authorization": "Bearer <MCP_BRIDGE_SECRET>" }
    }
  }
}
```

---

## Tools

### Clarity aggregate analytics (unchanged from the prototype)

`clarity_live_insights`, `get_traffic`, `get_engagement_time`,
`get_scroll_depth`, `get_popular_pages`, `get_dead_clicks`, `get_rage_clicks`,
`get_quickback_clicks`, `get_excessive_scroll`, `get_script_errors`,
`get_error_clicks`, `clarity_history`, `clarity_quota_status`,
`list_dimensions`.

- The 10 metric tools share **one cached fetch** per `(numOfDays + dimensions)`
  — asking for all of them costs 0 extra API calls.
- Dimensions are de-duplicated (a repeated dimension is dropped;
  `meta.droppedDuplicateDimensions` reports it). Max 3 distinct.
- **Quota reservation is atomic**: a single conditional `UPDATE` increments the
  per-UTC-day counter only while it is below 10, so concurrent refreshes can
  never exceed the daily allowance.

**Cache refresh policy** (`CLARITY_REFRESH_POLICY`):

| Situation | Result |
| --- | --- |
| Fresh cache (age < TTL) | returned immediately, `meta.stale=false` |
| Stale + quota remains, `revalidate` (default) | refresh now, return fresh data |
| Stale + quota remains, `stale` | stale data + `meta.warning`; refresh only with `forceRefresh` |
| Stale + quota exhausted | stale data + `meta.warning` naming the reset time |
| No cache + quota exhausted | `quota_exhausted` error |
| `forceRefresh: true` | always calls the API if any quota remains |

Stale data is **never** returned with `meta.stale=false`.

**`clarity_history`** returns snapshots of **rolling** 1–3 day aggregate
windows (`fetchedAt` labels each). Overlapping snapshots are point-in-time
captures — **do not sum them** as daily data. Every response repeats this note.

### Clarity recording metadata

**`import_clarity_recordings`** — provide **exactly one** of `csvText` /
`csvUrl` (both or neither is rejected). `csvUrl` gets the same SSRF and
size checks as video URLs. Rows are deduplicated by recording URL, else
session ID, else a hash of the row. `replaceExisting: true` wipes the table
first. Returns `{ inserted, updated, skipped, invalidRows, duplicatesInFile,
totalRows, headerMap, note }`. The parser tolerates Clarity column-name
variations (e.g. `Recording link` / `Recording URL` / `Replay URL`;
`Duration` / `Duration (s)` / `Duration ms`; `Country` / `Country/Region` /
`Geo`). The complete original row is stored in a JSON `raw` field.

**`search_clarity_recordings`** — filters: `from`/`to` (start time),
`entryUrl`, `exitUrl`, `url` (either), `device`, `browser`, `country`,
`minDurationMs`, `hasRageClicks`, `hasDeadClicks`, `hasScriptErrors`; paginate
with `limit`/`offset` (returns `nextOffset`). Each result carries the original
`recordingUrl`.

**`get_clarity_recording`** — by `id`, `sessionId`, or `recordingUrl` (exactly
one). Includes the full original CSV row.

### Video

| Tool | Purpose |
| --- | --- |
| `submit_video` | Queue a video from an HTTPS `videoUrl`. Returns `{ videoId, jobId, status }` immediately. Options: `title`, `language`, `analysisPrompt`, `extractVisuals`. |
| `get_video_status` | Stage (`queued`…`completed`/`failed`), progress %, step count, error, video metadata, timestamps. |
| `get_video_analysis` | Executive summary, full description, transcript summary, important events, visible text/OCR, detected objects/interfaces, problems, recommendations, timestamp citations, model provenance. `detail: "compact" \| "detailed"`. |
| `get_video_transcript` | Paginated segments (`startMs`, `endMs`, `text`, `speaker?`, `confidence?`). Optional `startTime`/`endTime` window (seconds, `MM:SS`, `HH:MM:SS.mmm`, `1m30s`, `1500ms`). |
| `query_video` | Answers **only** from stored transcript + keyframes + analysis. Every claim carries supporting timestamps; states explicitly when evidence is insufficient. Optional `startTime`/`endTime`. |
| `get_video_frame` | Nearest extracted JPEG keyframe to `timestamp`, returned as an MCP **image content block** plus exact timestamp + description. |

Video is **never** sent inline as base64. `submit_video` returns before any
processing; the worker does the work.

### Supported formats & limits

- Video containers: whatever the target FFmpeg build accepts (mp4/mov/webm/
  mkv/mpeg/avi/…). Response `Content-Type` must be a video type or
  `application/octet-stream`; FFprobe must find a positive duration.
- Size ≤ `VIDEO_MAX_BYTES` (500 MB default), duration ≤
  `VIDEO_MAX_DURATION_SEC` (3 h default).
- Keyframes: scene-change detection combined with a forced maximum interval;
  hard cap `VIDEO_MAX_KEYFRAMES` (interval auto-widens so the cap holds).
- CSV ≤ `CLARITY_CSV_MAX_BYTES` (25 MB), ≤ `CLARITY_CSV_MAX_ROWS`.

---

## Security & privacy

**Remote URLs** (`videoUrl`, `csvUrl`):

- HTTPS required (plain `http://` only for `localhost` when
  `ALLOW_INSECURE_URLS=true`).
- DNS is resolved and **every** answer checked; private, loopback, link-local,
  CGNAT and cloud-metadata ranges (IPv4 + IPv6) are blocked in production.
- The policy is **re-applied after every redirect**; redirects are capped.
- Connection + total-download timeouts; byte cap enforced from both
  `Content-Length` and the live stream.
- Response `Content-Type` is validated; FFprobe validates the actual media.
- Filenames are sanitized; temp files are deleted after processing.
- Authorization headers and secrets are never logged. Bearer comparison is
  constant-time.

**Personal data.** Clarity applies masking to recordings, but imported
metadata, and especially **video transcripts and extracted frames**, may still
contain personal or sensitive information (names, emails on screen, faces,
voices, internal URLs). Treat the database and the storage volume as
sensitive:

- Restrict `MCP_BRIDGE_SECRET` to trusted callers; put the endpoint behind TLS
  and, ideally, network controls.
- Set a retention policy: periodically delete old `VideoAsset` rows (cascades
  to segments/frames/analysis) and their storage prefixes; prune
  `ClarityRecording` and `InsightsSnapshot`.
- Keep presigned `videoUrl` TTLs short. Presigned/credentialed URLs are stored
  to allow asynchronous processing but are **redacted** from all tool output.
- The storage volume holds the original video and JPEG keyframes — encrypt it
  at rest and limit access.

---

## Example JSON-RPC calls

All calls: `POST /mcp`, headers `Content-Type: application/json` and
`Authorization: Bearer $MCP_BRIDGE_SECRET`.

```jsonc
// initialize (the SDK negotiates the protocol version)
{"jsonrpc":"2.0","id":1,"method":"initialize",
 "params":{"protocolVersion":"2025-06-18","capabilities":{},
           "clientInfo":{"name":"my-client","version":"1.0.0"}}}

// discover tools
{"jsonrpc":"2.0","id":2,"method":"tools/list"}

// --- Clarity aggregate ---
{"jsonrpc":"2.0","id":3,"method":"tools/call",
 "params":{"name":"get_traffic","arguments":{"numOfDays":2,"dimension1":"OS","dimension2":"Country/Region"}}}

{"jsonrpc":"2.0","id":4,"method":"tools/call",
 "params":{"name":"clarity_live_insights","arguments":{"numOfDays":3,"forceRefresh":true}}}

{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"clarity_quota_status"}}

// --- Clarity recordings ---
{"jsonrpc":"2.0","id":6,"method":"tools/call",
 "params":{"name":"import_clarity_recordings",
           "arguments":{"csvUrl":"https://example.com/exports/clarity-recordings.csv"}}}

{"jsonrpc":"2.0","id":7,"method":"tools/call",
 "params":{"name":"import_clarity_recordings",
           "arguments":{"csvText":"Recording link,Session ID,Duration,Device\nhttps://clarity.microsoft.com/player/p/abc/s1,s1,00:01:30,Desktop","replaceExisting":false}}}

{"jsonrpc":"2.0","id":8,"method":"tools/call",
 "params":{"name":"search_clarity_recordings",
           "arguments":{"from":"2026-02-01T00:00:00Z","device":"Desktop","hasRageClicks":true,"limit":25,"offset":0}}}

{"jsonrpc":"2.0","id":9,"method":"tools/call",
 "params":{"name":"get_clarity_recording","arguments":{"sessionId":"s1"}}}

// --- Video ---
{"jsonrpc":"2.0","id":10,"method":"tools/call",
 "params":{"name":"submit_video",
           "arguments":{"videoUrl":"https://example.com/screen-recording.mp4",
                        "title":"Checkout walkthrough","language":"en",
                        "analysisPrompt":"focus on checkout friction","extractVisuals":true}}}

{"jsonrpc":"2.0","id":11,"method":"tools/call",
 "params":{"name":"get_video_status","arguments":{"videoId":"<videoId>"}}}

{"jsonrpc":"2.0","id":12,"method":"tools/call",
 "params":{"name":"get_video_analysis","arguments":{"videoId":"<videoId>","detail":"detailed"}}}

{"jsonrpc":"2.0","id":13,"method":"tools/call",
 "params":{"name":"get_video_transcript","arguments":{"videoId":"<videoId>","startTime":"1:30","endTime":"2:15","limit":100,"offset":0}}}

{"jsonrpc":"2.0","id":14,"method":"tools/call",
 "params":{"name":"query_video",
           "arguments":{"videoId":"<videoId>","question":"When does the user hit an error at checkout?"}}}

{"jsonrpc":"2.0","id":15,"method":"tools/call",
 "params":{"name":"get_video_frame","arguments":{"videoId":"<videoId>","timestamp":"00:01:42.000"}}}
```

### End-to-end video flow

```bash
SECRET=your_mcp_bridge_secret
call() { curl -s localhost:3000/mcp -H "Authorization: Bearer $SECRET" \
              -H 'Content-Type: application/json' -d "$1"; }

# 1. submit -> returns videoId + jobId, immediately
VID=$(call '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"submit_video","arguments":{"videoUrl":"https://example.com/clip.mp4"}}}' \
      | jq -r '.result.structuredContent.videoId')

# 2. poll status until "completed" (the worker must be running)
call "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"get_video_status\",\"arguments\":{\"videoId\":\"$VID\"}}}" | jq '.result.structuredContent.stage'

# 3. read the analysis
call "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"get_video_analysis\",\"arguments\":{\"videoId\":\"$VID\"}}}" | jq '.result.structuredContent'

# 4. ask a grounded question
call "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"query_video\",\"arguments\":{\"videoId\":\"$VID\",\"question\":\"What products appear on screen?\"}}}" | jq '.result.structuredContent'
```

---

## Testing

```bash
npm test                 # unit + contract suites (no services needed;
                         # DB / ffmpeg suites self-skip with a notice)

npm run test:integration # boots a throwaway embedded Postgres, applies the
                         # migration, and runs EVERY suite including the
                         # end-to-end pipeline (uses bundled static ffmpeg)
```

To run the DB suites against your own Postgres:

```bash
TEST_DATABASE_URL=postgres://... npx prisma migrate deploy
TEST_DATABASE_URL=postgres://... npm test
```

Coverage: MCP init/discovery/list/call, JSON-RPC + auth + origin errors,
existing Clarity tools, CSV parsing + column variations + dedupe, search
filters + pagination, atomic quota reservation under concurrency, stale-cache
behavior, video job state machine (exclusive claim, retry/backoff, permanent
fail), transcript pagination + windowing, timestamp conversion, nearest-frame,
missing provider credentials, download size + MIME enforcement, SSRF + redirect
protection, and a full download→transcribe→frames→analyze→query pipeline. All
provider calls are mocked; no test makes a paid API call. The test video is
generated with ffmpeg at runtime — no binary fixture is committed.

## License

MIT — see [LICENSE](./LICENSE).
