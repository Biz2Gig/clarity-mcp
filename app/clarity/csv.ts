/**
 * Tolerant parser for the "Recordings" CSV a user exports from the Microsoft
 * Clarity dashboard. Pure - no I/O, no database. Clarity has changed column
 * names over time and localizes some headers, so matching is done on a
 * normalized form (lowercased, alphanumerics only) against alias sets.
 *
 * This imports METADATA ONLY. `recordingUrl` is the dashboard deep-link, not a
 * downloadable media file - the Data Export API does not expose replay data.
 */

import { createHash } from "node:crypto";

import { parse } from "csv-parse/sync";

import { ValidationError } from "../errors";

export interface NormalizedRecording {
  recordingUrl?: string;
  sessionId?: string;
  clarityUserId?: string;
  startTime?: Date;
  durationMs?: number;
  entryUrl?: string;
  exitUrl?: string;
  referrer?: string;
  device?: string;
  browser?: string;
  os?: string;
  country?: string;
  pageCount?: number;
  clickCount?: number;
  rageClicks?: number;
  deadClicks?: number;
  scriptErrors?: number;
}

export interface ParsedRecording {
  normalized: NormalizedRecording;
  raw: Record<string, string>;
  dedupeKey: string;
  dedupeSource: "recordingUrl" | "sessionId" | "rowHash";
}

export interface ParseResult {
  records: ParsedRecording[];
  invalid: { row: number; reason: string }[];
  /** canonical field -> the CSV header it was bound to (or null). */
  headerMap: Record<string, string | null>;
  totalRows: number;
}

type Canonical = keyof NormalizedRecording;

/** Alias sets, resolved in this declaration order (specific before generic). */
const ALIASES: Record<Canonical, string[]> = {
  sessionId: ["sessionid", "session", "sessionguid", "sessionkey", "recordingid", "playbackid"],
  clarityUserId: [
    "clarityuserid",
    "clarityid",
    "userid",
    "user",
    "uid",
    "visitorid",
    "anonymoususerid",
  ],
  startTime: [
    "starttime",
    "sessionstarttime",
    "sessionstart",
    "starttimeutc",
    "timestamp",
    "datetime",
    "sessiondate",
    "date",
    "start",
  ],
  durationMs: [
    "durationms",
    "durationmilliseconds",
    "duration",
    "sessionduration",
    "sessionlength",
    "length",
    "totaltime",
    "durationseconds",
    "durationsec",
    "durations",
  ],
  entryUrl: [
    "entryurl",
    "entrypage",
    "landingpage",
    "landingurl",
    "firstpage",
    "firsturl",
    "startpage",
    "starturl",
    "initialurl",
  ],
  exitUrl: ["exiturl", "exitpage", "lastpage", "lasturl", "endpage", "endurl"],
  referrer: [
    "referrer",
    "referer",
    "referrerurl",
    "referralurl",
    "referralsource",
    "trafficsource",
    "source",
  ],
  device: ["device", "devicetype", "formfactor", "platformtype"],
  browser: ["browser", "browsername", "useragentbrowser"],
  os: ["os", "operatingsystem", "osname", "platformos", "platform"],
  country: [
    "country",
    "countryorregion",
    "countryregion",
    "region",
    "geo",
    "geocountry",
    "countryname",
    "location",
  ],
  pageCount: [
    "pagecount",
    "pages",
    "pagesviewed",
    "numpages",
    "pageviews",
    "totalpages",
    "pagespervisit",
    "pagespersession",
  ],
  clickCount: ["clickcount", "clicks", "totalclicks", "numclicks", "clickstotal"],
  rageClicks: ["rageclicks", "rageclickcount", "numrageclicks", "rageclick", "rage"],
  deadClicks: ["deadclicks", "deadclickcount", "numdeadclicks", "deadclick", "dead"],
  scriptErrors: [
    "scripterrors",
    "scripterrorcount",
    "scripterror",
    "jserrors",
    "javascripterrors",
    "errorcount",
    "numerrors",
    "errors",
  ],
  // Generic last so a bare "url"/"link" column does not shadow entry/exit.
  recordingUrl: [
    "recordingurl",
    "recordinglink",
    "replayurl",
    "replaylink",
    "sessionrecordingurl",
    "sessionrecording",
    "sessionreplay",
    "recording",
    "clarityurl",
    "dashboardurl",
    "playbackurl",
    "url",
    "link",
  ],
};

const RESOLUTION_ORDER = Object.keys(ALIASES) as Canonical[];

const SECONDS_ALIASES = new Set(["durationseconds", "durationsec", "durations"]);

export function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function toInt(v: string | undefined): number | undefined {
  if (v == null) return undefined;
  const cleaned = v.replace(/[,\s]/g, "");
  if (cleaned === "" || !/^-?\d+(\.\d+)?$/.test(cleaned)) return undefined;
  const n = Math.round(Number(cleaned));
  return Number.isFinite(n) ? n : undefined;
}

const CLOCK = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.(\d+))?$/;

function parseDurationMs(v: string | undefined, alias: string | null): number | undefined {
  if (!v) return undefined;
  const s = v.trim();
  const clock = CLOCK.exec(s);
  if (clock) {
    const [, h, m, sec, frac] = clock;
    return (
      (Number(h ?? 0) * 3600 + Number(m) * 60 + Number(sec)) * 1000 +
      (frac ? Number(frac.padEnd(3, "0").slice(0, 3)) : 0)
    );
  }
  const n = Number(s.replace(/[,\s]/g, ""));
  if (!Number.isFinite(n)) return undefined;
  if (alias && SECONDS_ALIASES.has(alias)) return Math.round(n * 1000);
  if (alias === "durationms" || alias === "durationmilliseconds") return Math.round(n);
  // Ambiguous bare number: Clarity exports seconds. Treat < 6h as seconds.
  return n > 0 && n < 21_600 ? Math.round(n * 1000) : Math.round(n);
}

function parseDate(v: string | undefined): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v.trim());
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Build canonical -> header binding. Each header is claimed at most once. */
export function buildHeaderMap(headers: string[]): Record<string, string | null> {
  const norm = headers.map((h) => ({ raw: h, key: normalizeHeader(h) }));
  const taken = new Set<string>();
  const map: Record<string, string | null> = {};
  for (const field of RESOLUTION_ORDER) {
    map[field] = null;
    for (const alias of ALIASES[field]) {
      const hit = norm.find((h) => h.key === alias && !taken.has(h.raw));
      if (hit) {
        map[field] = hit.raw;
        taken.add(hit.raw);
        break;
      }
    }
  }
  return map;
}

function rowHash(raw: Record<string, string>): string {
  const canonical = Object.keys(raw)
    .sort()
    .map((k) => `${k}=${raw[k]}`)
    .join("");
  return "row:" + createHash("sha256").update(canonical).digest("hex");
}

export interface ParseOptions {
  maxRows?: number;
}

export function parseClarityCsv(
  csvText: string,
  opts: ParseOptions = {},
): ParseResult {
  if (typeof csvText !== "string" || csvText.trim() === "") {
    throw new ValidationError("CSV content is empty.");
  }

  let rows: Record<string, string>[];
  try {
    rows = parse(csvText, {
      columns: (hdrs: string[]) => hdrs.map((h) => h.trim()),
      skip_empty_lines: true,
      relax_column_count: true,
      relax_quotes: true,
      bom: true,
      trim: true,
    });
  } catch (e) {
    throw new ValidationError(
      `CSV could not be parsed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (rows.length === 0) {
    throw new ValidationError("CSV has a header but no data rows.");
  }
  const maxRows = opts.maxRows ?? 200_000;
  if (rows.length > maxRows) {
    throw new ValidationError(
      `CSV has ${rows.length} rows, exceeding the limit of ${maxRows}.`,
    );
  }

  const headers = Object.keys(rows[0]);
  const headerMap = buildHeaderMap(headers);
  const durationAlias = headerMap.durationMs
    ? normalizeHeader(headerMap.durationMs)
    : null;

  const records: ParsedRecording[] = [];
  const invalid: { row: number; reason: string }[] = [];

  rows.forEach((raw, i) => {
    const get = (field: Canonical): string | undefined => {
      const header = headerMap[field];
      if (!header) return undefined;
      const val = raw[header];
      return val == null || val === "" ? undefined : String(val).trim();
    };

    const normalized: NormalizedRecording = {
      recordingUrl: get("recordingUrl"),
      sessionId: get("sessionId"),
      clarityUserId: get("clarityUserId"),
      startTime: parseDate(get("startTime")),
      durationMs: parseDurationMs(get("durationMs"), durationAlias),
      entryUrl: get("entryUrl"),
      exitUrl: get("exitUrl"),
      referrer: get("referrer"),
      device: get("device"),
      browser: get("browser"),
      os: get("os"),
      country: get("country"),
      pageCount: toInt(get("pageCount")),
      clickCount: toInt(get("clickCount")),
      rageClicks: toInt(get("rageClicks")),
      deadClicks: toInt(get("deadClicks")),
      scriptErrors: toInt(get("scriptErrors")),
    };

    const hasAnySignal =
      normalized.recordingUrl ||
      normalized.sessionId ||
      normalized.entryUrl ||
      normalized.startTime ||
      Object.values(raw).some((v) => v && v.trim() !== "");

    if (!hasAnySignal) {
      invalid.push({ row: i + 2, reason: "empty row" });
      return;
    }

    let dedupeKey: string;
    let dedupeSource: ParsedRecording["dedupeSource"];
    if (normalized.recordingUrl) {
      dedupeKey = `url:${normalized.recordingUrl}`;
      dedupeSource = "recordingUrl";
    } else if (normalized.sessionId) {
      dedupeKey = `sid:${normalized.sessionId}`;
      dedupeSource = "sessionId";
    } else {
      dedupeKey = rowHash(raw);
      dedupeSource = "rowHash";
    }

    records.push({ normalized, raw: { ...raw }, dedupeKey, dedupeSource });
  });

  return { records, invalid, headerMap, totalRows: rows.length };
}

/** Collapse duplicate dedupeKeys within a single parse, keeping the last. */
export function dedupeParsed(records: ParsedRecording[]): {
  unique: ParsedRecording[];
  duplicatesRemoved: number;
} {
  const byKey = new Map<string, ParsedRecording>();
  let duplicatesRemoved = 0;
  for (const r of records) {
    if (byKey.has(r.dedupeKey)) duplicatesRemoved++;
    byKey.set(r.dedupeKey, r);
  }
  return { unique: [...byKey.values()], duplicatesRemoved };
}
