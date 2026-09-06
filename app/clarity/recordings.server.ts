/**
 * Import / search / fetch for imported Clarity recording METADATA.
 * The Data Export API does not expose replay data; `recordingUrl` is the
 * Clarity dashboard deep-link only.
 */

import type { Prisma } from "@prisma/client";

import { config } from "../config.server";
import prisma from "../db.server";
import { NotFoundError, ValidationError } from "../errors";
import { downloadToTempFile } from "../video/download.server";
import { dedupeParsed, parseClarityCsv, type ParsedRecording } from "./csv";
import { readFile } from "node:fs/promises";

export const METADATA_ONLY_NOTE =
  "Imported metadata only. Microsoft Clarity's Data Export API does not expose " +
  "session replays; `recordingUrl` is the Clarity dashboard link, not a media file.";

export interface ImportInput {
  csvText?: string;
  csvUrl?: string;
  replaceExisting?: boolean;
}

export interface ImportResult {
  inserted: number;
  updated: number;
  skipped: number;
  invalidRows: number;
  duplicatesInFile: number;
  totalRows: number;
  replacedExisting: boolean;
  headerMap: Record<string, string | null>;
  invalidSamples: { row: number; reason: string }[];
  note: string;
}

function recordToRow(r: ParsedRecording): Prisma.ClarityRecordingCreateManyInput {
  const n = r.normalized;
  return {
    dedupeKey: r.dedupeKey,
    recordingUrl: n.recordingUrl ?? null,
    sessionId: n.sessionId ?? null,
    clarityUserId: n.clarityUserId ?? null,
    startTime: n.startTime ?? null,
    durationMs: n.durationMs ?? null,
    entryUrl: n.entryUrl ?? null,
    exitUrl: n.exitUrl ?? null,
    referrer: n.referrer ?? null,
    device: n.device ?? null,
    browser: n.browser ?? null,
    os: n.os ?? null,
    country: n.country ?? null,
    pageCount: n.pageCount ?? null,
    clickCount: n.clickCount ?? null,
    rageClicks: n.rageClicks ?? null,
    deadClicks: n.deadClicks ?? null,
    scriptErrors: n.scriptErrors ?? null,
    raw: r.raw as Prisma.InputJsonValue,
  };
}

export async function importClarityRecordings(
  input: ImportInput,
): Promise<ImportResult> {
  const hasText = typeof input.csvText === "string" && input.csvText.length > 0;
  const hasUrl = typeof input.csvUrl === "string" && input.csvUrl.length > 0;
  if (hasText === hasUrl) {
    throw new ValidationError(
      "Provide exactly one of `csvText` or `csvUrl` (not both, not neither).",
    );
  }

  let csvText: string;
  if (hasText) {
    const bytes = Buffer.byteLength(input.csvText!, "utf8");
    if (bytes > config.clarityCsvMaxBytes) {
      throw new ValidationError(
        `csvText is ${bytes} bytes, exceeding CLARITY_CSV_MAX_BYTES ` +
          `(${config.clarityCsvMaxBytes}).`,
      );
    }
    csvText = input.csvText!;
  } else {
    const dl = await downloadToTempFile(input.csvUrl!, {
      kind: "csv",
      maxBytes: config.clarityCsvMaxBytes,
    });
    try {
      csvText = await readFile(dl.path, "utf8");
    } finally {
      await dl.cleanup();
    }
  }

  const parsed = parseClarityCsv(csvText, { maxRows: config.clarityCsvMaxRows });
  const { unique, duplicatesRemoved } = dedupeParsed(parsed.records);

  const replacedExisting = input.replaceExisting === true;
  if (replacedExisting) {
    await prisma.clarityRecording.deleteMany({});
  }

  const keys = unique.map((r) => r.dedupeKey);
  const existing = replacedExisting
    ? new Set<string>()
    : new Set(
        (
          await prisma.clarityRecording.findMany({
            where: { dedupeKey: { in: keys } },
            select: { dedupeKey: true },
          })
        ).map((x) => x.dedupeKey),
      );

  const toInsert = unique.filter((r) => !existing.has(r.dedupeKey));
  const toUpdate = unique.filter((r) => existing.has(r.dedupeKey));

  if (toInsert.length > 0) {
    await prisma.clarityRecording.createMany({
      data: toInsert.map(recordToRow),
      skipDuplicates: true,
    });
  }
  for (const r of toUpdate) {
    const row = recordToRow(r);
    await prisma.clarityRecording.update({
      where: { dedupeKey: r.dedupeKey },
      data: { ...row, updatedAt: new Date() },
    });
  }

  return {
    inserted: toInsert.length,
    updated: toUpdate.length,
    skipped: duplicatesRemoved,
    invalidRows: parsed.invalid.length,
    duplicatesInFile: duplicatesRemoved,
    totalRows: parsed.totalRows,
    replacedExisting,
    headerMap: parsed.headerMap,
    invalidSamples: parsed.invalid.slice(0, 10),
    note: METADATA_ONLY_NOTE,
  };
}

export interface SearchInput {
  from?: string;
  to?: string;
  entryUrl?: string;
  exitUrl?: string;
  url?: string;
  device?: string;
  browser?: string;
  country?: string;
  minDurationMs?: number;
  hasRageClicks?: boolean;
  hasDeadClicks?: boolean;
  hasScriptErrors?: boolean;
  limit?: number;
  offset?: number;
  includeRaw?: boolean;
}

function boolFilter(flag: boolean | undefined): Prisma.IntNullableFilter | undefined {
  if (flag === undefined) return undefined;
  return flag ? { gt: 0 } : { equals: 0 };
}

export async function searchClarityRecordings(input: SearchInput) {
  const limit = Math.min(Math.max(input.limit ?? 25, 1), 200);
  const offset = Math.max(input.offset ?? 0, 0);

  const where: Prisma.ClarityRecordingWhereInput = {};
  if (input.from || input.to) {
    where.startTime = {};
    if (input.from) where.startTime.gte = new Date(input.from);
    if (input.to) where.startTime.lte = new Date(input.to);
  }
  if (input.entryUrl) where.entryUrl = { contains: input.entryUrl, mode: "insensitive" };
  if (input.exitUrl) where.exitUrl = { contains: input.exitUrl, mode: "insensitive" };
  if (input.url) {
    where.OR = [
      { entryUrl: { contains: input.url, mode: "insensitive" } },
      { exitUrl: { contains: input.url, mode: "insensitive" } },
    ];
  }
  if (input.device) where.device = { equals: input.device, mode: "insensitive" };
  if (input.browser) where.browser = { equals: input.browser, mode: "insensitive" };
  if (input.country) where.country = { equals: input.country, mode: "insensitive" };
  if (input.minDurationMs !== undefined) where.durationMs = { gte: input.minDurationMs };
  const rage = boolFilter(input.hasRageClicks);
  if (rage) where.rageClicks = rage;
  const dead = boolFilter(input.hasDeadClicks);
  if (dead) where.deadClicks = dead;
  const errs = boolFilter(input.hasScriptErrors);
  if (errs) where.scriptErrors = errs;

  const [total, rows] = await Promise.all([
    prisma.clarityRecording.count({ where }),
    prisma.clarityRecording.findMany({
      where,
      orderBy: [{ startTime: "desc" }, { importedAt: "desc" }],
      skip: offset,
      take: limit,
    }),
  ]);

  return {
    total,
    count: rows.length,
    offset,
    limit,
    nextOffset: offset + rows.length < total ? offset + rows.length : null,
    note: METADATA_ONLY_NOTE,
    records: rows.map((r) => shapeRecord(r, input.includeRaw ?? false)),
  };
}

export interface GetInput {
  id?: string;
  sessionId?: string;
  recordingUrl?: string;
}

export async function getClarityRecording(input: GetInput) {
  const provided = [input.id, input.sessionId, input.recordingUrl].filter(
    Boolean,
  );
  if (provided.length !== 1) {
    throw new ValidationError(
      "Provide exactly one of `id`, `sessionId` or `recordingUrl`.",
    );
  }

  const row = await prisma.clarityRecording.findFirst({
    where: input.id
      ? { id: input.id }
      : input.sessionId
        ? { sessionId: input.sessionId }
        : { recordingUrl: input.recordingUrl },
    orderBy: { importedAt: "desc" },
  });

  if (!row) {
    throw new NotFoundError("No imported Clarity recording matches that key.");
  }
  return { ...shapeRecord(row, true), note: METADATA_ONLY_NOTE };
}

function shapeRecord(
  r: Prisma.ClarityRecordingGetPayload<Record<string, never>>,
  includeRaw: boolean,
) {
  const base = {
    id: r.id,
    recordingUrl: r.recordingUrl,
    sessionId: r.sessionId,
    clarityUserId: r.clarityUserId,
    startTime: r.startTime?.toISOString() ?? null,
    durationMs: r.durationMs,
    entryUrl: r.entryUrl,
    exitUrl: r.exitUrl,
    referrer: r.referrer,
    device: r.device,
    browser: r.browser,
    os: r.os,
    country: r.country,
    pageCount: r.pageCount,
    clickCount: r.clickCount,
    rageClicks: r.rageClicks,
    deadClicks: r.deadClicks,
    scriptErrors: r.scriptErrors,
    importedAt: r.importedAt.toISOString(),
  };
  // `raw` is always a key; `undefined` is dropped by JSON.stringify when not requested.
  return { ...base, raw: includeRaw ? (r.raw as unknown) : undefined };
}
