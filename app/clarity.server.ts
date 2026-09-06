import { config } from "./config.server";
import prisma from "./db.server";
import { QuotaError, ValidationError } from "./errors";

const CLARITY_BASE =
  "https://www.clarity.ms/export-data/api/v1/project-live-insights";

/** Clarity hard limit: API calls per project per UTC day. */
export const DAILY_LIMIT = 10;

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
    throw new ValidationError(
      `Invalid dimension "${d}". Valid values: ${DIMENSIONS.join(", ")}`,
    );
  }
  return match;
}

/**
 * Normalize + de-duplicate the requested dimensions (fix: prevent duplicate
 * dimensions in Clarity requests). Order is preserved; a case-insensitive
 * repeat is dropped. More than 3 distinct dimensions is rejected.
 */
export function resolveDimensions(
  raw: (string | undefined)[],
): { dimensions: Dimension[]; droppedDuplicates: string[] } {
  const seen = new Set<string>();
  const dimensions: Dimension[] = [];
  const droppedDuplicates: string[] = [];
  for (const r of raw) {
    const dim = normalizeDim(r);
    if (!dim) continue;
    if (seen.has(dim)) {
      droppedDuplicates.push(dim);
      continue;
    }
    seen.add(dim);
    dimensions.push(dim);
  }
  if (dimensions.length > 3) {
    throw new ValidationError(
      `At most 3 distinct dimensions are allowed (got ${dimensions.length}).`,
    );
  }
  return { dimensions, droppedDuplicates };
}

function utcDayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

function cacheKey(numOfDays: NumOfDays, dims: Dimension[]): string {
  return `${numOfDays}::${dims.join("|")}`;
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

/**
 * Atomically reserve one slot of today's quota. A single conditional UPSERT
 * guarantees that concurrent refreshes cannot push `count` past DAILY_LIMIT:
 * the row is only incremented when it is still below the limit, and the new
 * value is returned. `ok:false` means the limit was already reached.
 */
export async function reserveQuotaSlot(): Promise<{ ok: boolean; count: number }> {
  const day = utcDayKey();
  const rows = await prisma.$queryRaw<{ count: number }[]>`
    INSERT INTO "ApiCallLog" ("day", "count", "updatedAt")
    VALUES (${day}, 1, now())
    ON CONFLICT ("day") DO UPDATE
      SET "count" = "ApiCallLog"."count" + 1, "updatedAt" = now()
      WHERE "ApiCallLog"."count" < ${DAILY_LIMIT}
    RETURNING "count"
  `;
  return rows.length > 0
    ? { ok: true, count: Number(rows[0].count) }
    : { ok: false, count: DAILY_LIMIT };
}

/** Give back a reserved slot when the API call itself failed. Best effort. */
export async function releaseQuotaSlot(): Promise<void> {
  const day = utcDayKey();
  await prisma.$executeRaw`
    UPDATE "ApiCallLog" SET "count" = "count" - 1, "updatedAt" = now()
    WHERE "day" = ${day} AND "count" > 0
  `;
}

async function pinQuotaToLimit(): Promise<void> {
  const day = utcDayKey();
  await prisma.apiCallLog.upsert({
    where: { day },
    create: { day, count: DAILY_LIMIT },
    update: { count: DAILY_LIMIT },
  });
}

export interface LiveInsightsMeta {
  source: "live" | "cache";
  stale: boolean;
  ageMs: number | null;
  asOf: string;
  cacheTtlMs: number;
  refreshPolicy: "revalidate" | "stale";
  numOfDays: NumOfDays;
  dimensions: Dimension[];
  droppedDuplicateDimensions: string[];
  quota: QuotaStatus;
  /** Present only when returning data that is NOT current. */
  warning?: string;
}

export interface LiveInsightsResult {
  data: unknown;
  meta: LiveInsightsMeta;
}

export interface LiveInsightsOptions {
  numOfDays?: number;
  dimension1?: string;
  dimension2?: string;
  dimension3?: string;
  /** Spend one of the 10 daily API calls even if a fresh cache exists. */
  forceRefresh?: boolean;
}

/**
 * Fetch project-live-insights with a documented, quota-safe refresh policy:
 *
 *   1. Fresh cache (age < CLARITY_CACHE_TTL_MS)  -> returned immediately.
 *   2. Stale cache + quota remaining:
 *        - CLARITY_REFRESH_POLICY=revalidate (default): refresh now, return fresh.
 *        - CLARITY_REFRESH_POLICY=stale: return stale data with an explicit
 *          `meta.warning`; refresh only on forceRefresh.
 *   3. Stale cache + quota exhausted -> stale data with an explicit warning.
 *   4. No cache + quota exhausted    -> QuotaError.
 *   5. forceRefresh -> always attempts a live call (spends quota) if any remains.
 *
 * Stale data is NEVER returned with `meta.stale=false`.
 */
export async function getLiveInsights(
  opts: LiveInsightsOptions = {},
): Promise<LiveInsightsResult> {
  if (!config.clarityApiToken) {
    throw new ValidationError(
      "CLARITY_API_TOKEN is not set. Add it to the environment or .env file.",
    );
  }

  const numOfDays = clampDays(opts.numOfDays);
  const { dimensions, droppedDuplicates } = resolveDimensions([
    opts.dimension1,
    opts.dimension2,
    opts.dimension3,
  ]);
  const key = cacheKey(numOfDays, dimensions);
  const ttl = config.clarityCacheTtlMs;
  const policy = config.clarityRefreshPolicy;

  const cached = await prisma.insightsCache.findUnique({ where: { key } });
  const ageMs = cached ? Date.now() - cached.fetchedAt.getTime() : null;
  const fresh = cached != null && ageMs != null && ageMs < ttl;

  const makeMeta = (
    over: Partial<LiveInsightsMeta> & Pick<LiveInsightsMeta, "source" | "stale" | "asOf">,
  ): LiveInsightsMeta => ({
    ageMs,
    cacheTtlMs: ttl,
    refreshPolicy: policy,
    numOfDays,
    dimensions,
    droppedDuplicateDimensions: droppedDuplicates,
    quota: over.quota as QuotaStatus,
    ...over,
  });

  const serveCache = async (warning?: string): Promise<LiveInsightsResult> => ({
    data: cached!.payload,
    meta: makeMeta({
      source: "cache",
      stale: !fresh,
      asOf: cached!.fetchedAt.toISOString(),
      warning: fresh ? undefined : warning,
      quota: await quotaStatus(),
    }),
  });

  // 1. Fresh cache and not explicitly forced.
  if (cached && fresh && !opts.forceRefresh) {
    return serveCache();
  }

  // Decide whether a live call should be attempted.
  const wantLive =
    opts.forceRefresh === true ||
    !cached ||
    (!fresh && policy === "revalidate");

  if (!wantLive && cached) {
    // Stale, policy=stale, not forced.
    return serveCache(
      `Served STALE cache (age ${Math.round((ageMs ?? 0) / 1000)}s). ` +
        `CLARITY_REFRESH_POLICY=stale, so it was not auto-refreshed. ` +
        `Pass forceRefresh:true to spend one of the ${DAILY_LIMIT} daily API calls.`,
    );
  }

  // 2/3/4. Try to reserve a quota slot atomically.
  const reservation = await reserveQuotaSlot();
  if (!reservation.ok) {
    const q = await quotaStatus();
    if (cached) {
      return serveCache(
        `Served STALE cache (age ${Math.round((ageMs ?? 0) / 1000)}s). ` +
          `Clarity daily API quota is exhausted (${q.used}/${q.limit}); ` +
          `it resets at ${q.resetsAt}.`,
      );
    }
    throw new QuotaError(
      `Clarity daily API limit reached (${q.used}/${q.limit} for ${q.day} UTC) ` +
        `and nothing is cached for "${key}". Resets at ${q.resetsAt}.`,
    );
  }

  const url = new URL(CLARITY_BASE);
  url.searchParams.set("numOfDays", String(numOfDays));
  dimensions.forEach((d, i) => url.searchParams.set(`dimension${i + 1}`, d));

  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.clarityApiToken}`,
        "Content-Type": "application/json",
      },
    });
  } catch (e) {
    await releaseQuotaSlot();
    if (cached) {
      return serveCache(
        `Served STALE cache: the Clarity API request failed (${
          e instanceof Error ? e.message : String(e)
        }).`,
      );
    }
    throw e;
  }

  if (!res.ok) {
    if (res.status === 429) {
      await pinQuotaToLimit();
      if (cached) {
        return serveCache(
          "Served STALE cache: Clarity returned 429 (daily limit exceeded).",
        );
      }
      throw new QuotaError(
        "Clarity returned 429 (daily limit exceeded) and no cache is available.",
      );
    }
    await releaseQuotaSlot();
    const body = await res.text().catch(() => "");
    if (cached) {
      return serveCache(
        `Served STALE cache: Clarity API error ${res.status}${
          body ? ` - ${body.slice(0, 200)}` : ""
        }.`,
      );
    }
    throw new Error(
      `Clarity API error ${res.status}${body ? `: ${body.slice(0, 300)}` : ""}`,
    );
  }

  const payload = (await res.json()) as unknown;
  const fetchedAt = new Date();
  const dimensionsCsv = dimensions.join(",");

  await prisma.insightsCache.upsert({
    where: { key },
    create: {
      key,
      numOfDays,
      dimensions: dimensionsCsv,
      payload: payload as object,
      fetchedAt,
    },
    update: {
      numOfDays,
      dimensions: dimensionsCsv,
      payload: payload as object,
      fetchedAt,
    },
  });
  await prisma.insightsSnapshot.create({
    data: {
      key,
      numOfDays,
      dimensions: dimensionsCsv,
      payload: payload as object,
      fetchedAt,
    },
  });

  return {
    data: payload,
    meta: makeMeta({
      source: "live",
      stale: false,
      asOf: fetchedAt.toISOString(),
      ageMs: 0,
      quota: await quotaStatus(),
    }),
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

/**
 * Read locally stored snapshots. Never calls the Clarity API.
 *
 * IMPORTANT: each snapshot is a ROLLING aggregate window (the last 1-3 days as
 * of `fetchedAt`). Successive snapshots overlap heavily - they are point-in-
 * time captures, NOT additive per-day buckets. Do not sum them.
 */
export async function getHistory(opts: HistoryOptions = {}) {
  const where: { fetchedAt?: { gte?: Date; lte?: Date } } = {};
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

  const note =
    "Each snapshot is a rolling 1-3 day aggregate window as of `fetchedAt`. " +
    "Snapshots overlap; do not sum them as daily data.";

  if (!opts.metricName) {
    return { note, snapshots: rows.map(({ payload: _p, ...rest }) => rest) };
  }

  return {
    note,
    snapshots: rows.map((r) => ({
      id: r.id,
      key: r.key,
      numOfDays: r.numOfDays,
      dimensions: r.dimensions,
      fetchedAt: r.fetchedAt,
      metric: pickMetric(r.payload, opts.metricName as string),
    })),
  };
}
