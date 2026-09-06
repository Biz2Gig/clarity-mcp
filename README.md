# clarity-mcp

An MCP (Model Context Protocol) server that bridges the
[Microsoft Clarity Data Export API](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-data-export-api)
to MCP clients over HTTP (JSON-RPC 2.0).

The architecture mirrors a single-route React Router server: one `POST /mcp`
endpoint, a static bearer secret for auth, and Prisma/Postgres for a
**cache + quota ledger + snapshot history** layer that exists because the
Clarity API is heavily rate limited.

## Why the database layer

The Clarity `project-live-insights` endpoint has hard limits:

| Limit | Value |
| --- | --- |
| API calls | **10 per project per UTC day** (429 after that) |
| Date range | rolling **1–3 days** only (last 24 / 48 / 72 h) |
| Response size | 1,000 rows, no pagination |
| Dimensions | max 3 per request |
| Payload | **all metrics returned in one response** |

So this server:

1. **Caches** every response keyed by `(numOfDays + dimensions)`.
2. **Tracks usage** per UTC day and refuses / serves stale before hitting a 429.
3. **Snapshots** every live response into an append-only table so you can query
   ranges wider than Clarity's 3-day window from local data.
4. Serves the metric-specific tools (`get_traffic`, `get_rage_clicks`, …) from a
   **single shared cached fetch** — asking for 10 metrics costs 0 extra API calls.

### Quota policy

- `forceRefresh: false` (default): if anything is cached for that exact
  `(numOfDays + dimensions)` combo, it is served — fresh or stale — with **no
  API call**.
- `forceRefresh: true`: calls the API if the daily quota remains; otherwise
  falls back to stale cache, or errors if there is none.
- `CLARITY_CACHE_TTL_MS` (default 6 h) only controls the `stale` flag in the
  response `meta`; it does not by itself trigger an API call.

There is **no scheduled/cron pull** — every API call is initiated by a client
request, by design, to protect the 10/day budget.

## Tools

| Tool | API cost | Notes |
| --- | --- | --- |
| `clarity_live_insights` | cache, or 1 call with `forceRefresh` | raw full payload |
| `get_traffic` | shared cache | Traffic metric |
| `get_engagement_time` | shared cache | |
| `get_scroll_depth` | shared cache | |
| `get_popular_pages` | shared cache | |
| `get_dead_clicks` | shared cache | Dead Click Count |
| `get_rage_clicks` | shared cache | Rage Click Count |
| `get_quickback_clicks` | shared cache | Quickback Click |
| `get_excessive_scroll` | shared cache | Excessive Scroll |
| `get_script_errors` | shared cache | Script Error Count |
| `get_error_clicks` | shared cache | Error Click Count |
| `clarity_history` | none (local DB) | snapshots by date range |
| `clarity_quota_status` | none | calls used today (UTC) + reset time |
| `list_dimensions` | none | valid dimension names |

All insight tools accept: `numOfDays` (1–3, default 3), `dimension1`,
`dimension2`, `dimension3` — from
`Browser, Device, Country/Region, OS, Source, Medium, Campaign, Channel, URL`.

## Setup

Requires **Node 20** (`.nvmrc`) and a Postgres database.

```bash
npm install
cp .env.example .env      # then fill in the values
```

`.env`:

- `CLARITY_API_TOKEN` — Clarity project → Settings → Data Export → Generate new
  API token. A long-lived JWT; keep it out of git.
- `MCP_BRIDGE_SECRET` — shared secret clients send as
  `Authorization: Bearer <secret>`. Generate with `openssl rand -hex 32`.
- `DATABASE_URL` — Postgres connection string.
- `CLARITY_CACHE_TTL_MS` — optional, default `21600000` (6 h).

Create the schema:

```bash
npx prisma migrate dev --name init    # local dev
# or, for an existing/managed database:
npx prisma migrate deploy
```

Run:

```bash
npm run dev       # http://localhost:3000  (endpoint: POST /mcp)
npm run build && npm start
```

### Docker

```bash
export CLARITY_API_TOKEN=...
export MCP_BRIDGE_SECRET=...
docker compose up --build
```

Brings up Postgres + the app; the app container runs `prisma migrate deploy`
on start.

## Calling it

```bash
SECRET=your_mcp_bridge_secret

# list tools
curl -s localhost:3000/mcp \
  -H "Authorization: Bearer $SECRET" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq

# traffic for the last 48h, broken down by OS and Country/Region
curl -s localhost:3000/mcp \
  -H "Authorization: Bearer $SECRET" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_traffic","arguments":{"numOfDays":2,"dimension1":"OS","dimension2":"Country/Region"}}}' | jq

# how much of today's quota is left
curl -s localhost:3000/mcp \
  -H "Authorization: Bearer $SECRET" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"clarity_quota_status"}}' | jq
```

## Notes / limitations

- Single Clarity project per deployment (one `CLARITY_API_TOKEN`).
- Clarity returns data in **UTC**; `numOfDays` is a rolling window, not calendar days.
- The Dockerfile is single-stage (dev deps kept for the build). Switch to a
  multi-stage build to slim the image if needed.

## License

MIT — see [LICENSE](./LICENSE).
