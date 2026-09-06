import prisma from "./db.server";

const CLARITY_API_TOKEN = process.env.CLARITY_API_TOKEN;
const CLARITY_BASE =
  "https://www.clarity.ms/export-data/api/v1/project-live-insights";

/** Clarity hard limit: API calls per project per UTC day. */
export const DAILY_LIMIT = 10;

/** How long a cached response is treated as "fresh". Stale cache is still
 *  served without an API call unless the caller forces a refresh. */
const CACHE_TTL_MS = Number(
  process.env.CLARITY_CACHE_TTL_MS ?? 6 * 60 * 60 * 1000,
);

/** Dimensions accepted by project-live-insights (max 3 per request). */
export const DIMENSIONS = [
  "Browser",
  "Device",
  "Country/Region",
  "OS",
  "Source",
  "Medium",
  "Campaign",
  "Channel",
  "URL",
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

/** Metric names as they appear in the Clarity response `metricName` field. */
export const METRICS = [
  "Traffic",
  "Engagement Time",
  "Scroll Depth",
  "Popular Pages",
  "Dead Click Count",
  "Rage Click Count",
  "Quickback Click",
  "Excessive Scroll",
  "Script Error Count",
  "Error Click Count",
] as const;

type NumOfDays = 1 | 2 | 3;

function clampDays(n: number | undefined): NumOfDays {
  const x = Math.round(Number(n ?? 3));
  if (!Number.isFinite(x) || x <= 1) return 1;
  if (x >= 3) return 3;
  return 2;
}

function normalizeDim(d: string | undefined): Dimension | undefined {
  if (!d) return undefined;
  const match = DIMENSIONS.find(
    (x) => x.toLowerCase() === String(d).trim().toLowerCase(),
  );
  if (!match) {
    throw new Error(
      `Invalid dimension "${d}". Valid values: ${DIMENSIONS.join(", ")}`,
    );
  }
  return match;
}

function utcDayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

function cacheKey(numOfDays: NumOfDays, dims: (Dimension | undefined)[]): string {
  return `${numOfDays}::${dims.filter(Boolean).join("|")}`;
}

export interface QuotaStatus {
  day: string;
  used: number;
  limit: number;
  remaining: number;
  resetsAt: string;
}

export async function quotaStatus(): Promise<QuotaStatus> {
  const day = utcDayKey();
  const row = await prisma.apiCallLog.findUnique({ where: { day } });
  const used = row?.count ?? 0;
  const reset = new Date();
  reset.setUTCHours(24, 0, 0, 0);
  return {
    day,
    used,
    limit: DAILY_LIMIT,
    remaining: Math.max(0, DAILY_LIMIT - used),
    resetsAt: reset.toISOString(),
  };
}

async function incrementQuota(): Promise<number> {
  const day = utcDayKey();
  const row = await prisma.apiCallLog.upsert({
    where: { day },
    create: { day, count: 1 },
    update: { count: { increment: 1 } },
  });
  return row.count;
}

async function pinQuotaToLimit(): Promise<void> {
  const day = utcDayKey();
  await prisma.apiCallLog.upsert({
    where: { day },
    create: { day, count: DAILY_LIMIT },
    update: { count: DAILY_LIMIT },
  });
}

export interface LiveInsightsResult {
  data: unknown;
  meta: {
    source: "live" | "cache";
    stale: boolean;
    fetchedAt: string;
    cacheTtlMs: number;
    numOfDays: NumOfDays;
    dimensions: Dimension[];
    quota: QuotaStatus;
  };
}

export interface LiveInsightsOptions {
  numOfDays?: number;
  dimension1?: string;
  dimension2?: string;
  dimension3?: string;
  /** Spend one of the 10 daily API calls even if a cached response exists. */
  forceRefresh?: boolean;
}

/**
 * Fetch project-live-insights, cache-first.
 *
 * Quota policy (Clarity allows only 10 live calls / project / day):
 *   - forceRefresh=false (default): serve any cached row (fresh or stale)
 *     without an API call. Only hit the API when nothing is cached for
 *     this exact (numOfDays + dimensions) combination.
 *   - forceRefresh=true: hit the API if quota remains; otherwise fall back
 *     to stale cache, or error if there is none.
 */
export async function getLiveInsights(
  opts: LiveInsightsOptions = {},
): Promise<LiveInsightsResult> {
  if (!CLARITY_API_TOKEN) {
    throw new Error(
      "CLARITY_API_TOKEN is not set. Add it to the environment or .env file.",
    );
  }

  const numOfDays = clampDays(opts.numOfDays);
  const dims = [opts.dimension1, opts.dimension2, opts.dimension3].map(
    normalizeDim,
  );
  const dimList = dims.filter((d): d is Dimension => Boolean(d));
  const key = cacheKey(numOfDays, dims);

  const cached = await prisma.insightsCache.findUnique({ where: { key } });
  const fresh =
    !!cached && Date.now() - cached.fetchedAt.getTime() < CACHE_TTL_MS;

  const fromCache = (quota: QuotaStatus): LiveInsightsResult => ({
    data: cached!.payload,
    meta: {
      source: "cache",
      stale: !fresh,
      fetchedAt: cached!.fetchedAt.toISOString(),
      cacheTtlMs: CACHE_TTL_MS,
      numOfDays,
      dimensions: dimList,
      quota,
    },
  });

  // Default path: never spend a call when we already have something cached.
  if (cached && !opts.forceRefresh) {
    return fromCache(await quotaStatus());
  }

  const quota = await quotaStatus();
  if (quota.remaining <= 0) {
    if (cached) return fromCache(quota);
    throw new Error(
      `Clarity daily API limit reached (${quota.used}/${quota.limit} for ` +
        `${quota.day} UTC) and nothing is cached for "${key}". ` +
        `The limit resets at ${quota.resetsAt}.`,
    );
  }

  const url = new URL(CLARITY_BASE);
  url.searchParams.set("numOfDays", String(numOfDays));
  dims.forEach((d, i) => {
    if (d) url.searchParams.set(`dimension${i + 1}`, d);
  });

  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${CLARITY_API_TOKEN}`,
      "Content-Type": "application/json",
    },
  });

  await incrementQuota();

  if (!res.ok) {
    if (res.status === 429) {
      await pinQuotaToLimit();
      if (cached) return fromCache(await quotaStatus());
      throw new Error(
        "Clarity returned 429 (daily limit exceeded) and no cache is available.",
      );
    }
    const body = await res.text().catch(() => "");
    throw new Error(
      `Clarity API error ${res.status}${body ? `: ${body.slice(0, 300)}` : ""}`,
    );
  }

  const payload = (await res.json()) as unknown;
  const fetchedAt = new Date();
  const dimensions = dimList.join(",");

  await prisma.insightsCache.upsert({
    where: { key },
    create: { key, numOfDays, dimensions, payload: payload as object, fetchedAt },
    update: { numOfDays, dimensions, payload: payload as object, fetchedAt },
  });
  await prisma.insightsSnapshot.create({
    data: { key, numOfDays, dimensions, payload: payload as object, fetchedAt },
  });

  return {
    data: payload,
    meta: {
      source: "live",
      stale: false,
      fetchedAt: fetchedAt.toISOString(),
      cacheTtlMs: CACHE_TTL_MS,
      numOfDays,
      dimensions: dimList,
      quota: await quotaStatus(),
    },
  };
}

/** Pull a single metric object out of a project-live-insights payload. */
export function pickMetric(payload: unknown, metricName: string) {
  if (!Array.isArray(payload)) return null;
  const target = metricName.trim().toLowerCase();
  return (
    payload.find(
      (m) =>
        m &&
        typeof m === "object" &&
        String((m as { metricName?: unknown }).metricName ?? "").toLowerCase() ===
          target,
    ) ?? null
  );
}

export interface HistoryOptions {
  metricName?: string;
  from?: string;
  to?: string;
  limit?: number;
}

/** Read locally stored snapshots. Never calls the Clarity API. */
export async function getHistory(opts: HistoryOptions = {}) {
  const where: {
    fetchedAt?: { gte?: Date; lte?: Date };
  } = {};
  if (opts.from || opts.to) {
    where.fetchedAt = {};
    if (opts.from) where.fetchedAt.gte = new Date(opts.from);
    if (opts.to) where.fetchedAt.lte = new Date(opts.to);
  }

  const rows = await prisma.insightsSnapshot.findMany({
    where,
    orderBy: { fetchedAt: "desc" },
    take: Math.min(Math.max(Number(opts.limit ?? 50), 1), 500),
  });

  if (!opts.metricName) {
    return rows.map(({ payload: _payload, ...rest }) => rest);
  }

  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    numOfDays: r.numOfDays,
    dimensions: r.dimensions,
    fetchedAt: r.fetchedAt,
    metric: pickMetric(r.payload, opts.metricName as string),
  }));
}
