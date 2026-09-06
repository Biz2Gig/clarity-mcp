import { describe, expect, it } from "vitest";

import {
  buildHeaderMap,
  dedupeParsed,
  parseClarityCsv,
} from "../app/clarity/csv";

const CANONICAL = [
  "Recording link,Session ID,Clarity ID,Start time,Duration,Entry URL,Exit URL,Referrer,Device,Browser,Operating system,Country,Page count,Click count,Rage clicks,Dead clicks,Script errors",
  "https://clarity.microsoft.com/player/p/abc/s1,s1,u1,2026-02-01T10:00:00Z,00:01:30,https://shop.example/,https://shop.example/cart,https://google.com,Desktop,Chrome,Windows,United States,4,12,1,0,2",
  "https://clarity.microsoft.com/player/p/abc/s2,s2,u2,2026-02-01T11:00:00Z,45,https://shop.example/x,https://shop.example/y,,Mobile,Safari,iOS,Canada,2,3,0,1,0",
].join("\n");

describe("parseClarityCsv - canonical headers", () => {
  const res = parseClarityCsv(CANONICAL);

  it("binds every canonical field", () => {
    expect(res.headerMap.recordingUrl).toBe("Recording link");
    expect(res.headerMap.sessionId).toBe("Session ID");
    expect(res.headerMap.clarityUserId).toBe("Clarity ID");
    expect(res.headerMap.startTime).toBe("Start time");
    expect(res.headerMap.durationMs).toBe("Duration");
    expect(res.headerMap.entryUrl).toBe("Entry URL");
    expect(res.headerMap.exitUrl).toBe("Exit URL");
    expect(res.headerMap.os).toBe("Operating system");
    expect(res.headerMap.country).toBe("Country");
  });

  it("normalizes the first row", () => {
    const r = res.records[0].normalized;
    expect(r.recordingUrl).toContain("/player/p/abc/s1");
    expect(r.sessionId).toBe("s1");
    expect(r.durationMs).toBe(90_000); // 00:01:30
    expect(r.startTime?.toISOString()).toBe("2026-02-01T10:00:00.000Z");
    expect(r.device).toBe("Desktop");
    expect(r.rageClicks).toBe(1);
    expect(r.deadClicks).toBe(0);
    expect(r.scriptErrors).toBe(2);
  });

  it("treats a bare numeric duration as seconds", () => {
    expect(res.records[1].normalized.durationMs).toBe(45_000);
  });

  it("keeps the complete original row in raw", () => {
    expect(res.records[0].raw["Recording link"]).toContain("clarity.microsoft.com");
    expect(Object.keys(res.records[0].raw).length).toBe(17);
  });

  it("dedupe source is the recording URL", () => {
    expect(res.records[0].dedupeSource).toBe("recordingUrl");
  });
});

describe("parseClarityCsv - column-name variations", () => {
  it("accepts alternative headers", () => {
    const csv = [
      "Replay URL,SessionId,User Id,Timestamp,Duration (s),Landing Page,Last Page,Traffic Source,Device Type,Browser Name,OS,Geo,Pages Viewed,Clicks,Rage Click Count,Dead Click Count,JS Errors",
      "https://clarity.microsoft.com/player/x/s9,s9,u9,2026-03-03T09:30:00Z,120,https://a.example/,https://a.example/end,https://ref.example,Tablet,Edge,Android,Germany,6,20,3,2,5",
    ].join("\n");
    const res = parseClarityCsv(csv);
    const r = res.records[0].normalized;
    expect(res.headerMap.recordingUrl).toBe("Replay URL");
    expect(res.headerMap.sessionId).toBe("SessionId");
    expect(res.headerMap.country).toBe("Geo");
    expect(res.headerMap.scriptErrors).toBe("JS Errors");
    expect(r.durationMs).toBe(120_000); // "Duration (s)" -> seconds
    expect(r.entryUrl).toBe("https://a.example/");
    expect(r.exitUrl).toBe("https://a.example/end");
    expect(r.pageCount).toBe(6);
    expect(r.scriptErrors).toBe(5);
  });

  it("does not let a bare url/link column shadow entry/exit URLs", () => {
    const csv = [
      "URL,Entry URL,Exit URL,Session ID",
      "https://clarity.microsoft.com/player/z/s1,https://site/,https://site/out,s1",
    ].join("\n");
    const map = buildHeaderMap(csv.split("\n")[0].split(","));
    expect(map.entryUrl).toBe("Entry URL");
    expect(map.exitUrl).toBe("Exit URL");
    expect(map.recordingUrl).toBe("URL");
  });

  it("parses Duration ms alias without a seconds conversion", () => {
    const csv = ["Session ID,Duration ms", "s1,90000"].join("\n");
    expect(parseClarityCsv(csv).records[0].normalized.durationMs).toBe(90_000);
  });
});

describe("parseClarityCsv - dedupe + invalid rows", () => {
  it("dedupes by recording URL then session id, then row hash", () => {
    const csv = [
      "Recording link,Session ID,Device",
      "https://c/r/1,s1,Desktop",
      "https://c/r/1,s1,Desktop", // exact dup by URL
      ",s2,Mobile",
      ",s2,Mobile", // dup by session id
      ",,Tablet", // row-hash key
    ].join("\n");
    const parsed = parseClarityCsv(csv);
    const { unique, duplicatesRemoved } = dedupeParsed(parsed.records);
    expect(parsed.records.length).toBe(5);
    expect(duplicatesRemoved).toBe(2);
    expect(unique.length).toBe(3);
    expect(unique.map((u) => u.dedupeSource).sort()).toEqual([
      "recordingUrl",
      "rowHash",
      "sessionId",
    ]);
  });

  it("counts blank rows as invalid, not as records", () => {
    const csv = ["Session ID,Device", "s1,Desktop", ",", "  ,  "].join("\n");
    const parsed = parseClarityCsv(csv);
    expect(parsed.records.length).toBe(1);
    expect(parsed.invalid.length).toBe(2);
    expect(parsed.invalid[0]).toHaveProperty("row");
  });

  it("throws on empty or header-only input", () => {
    expect(() => parseClarityCsv("")).toThrow();
    expect(() => parseClarityCsv("Session ID,Device")).toThrow();
  });

  it("enforces the row limit", () => {
    const rows = ["Session ID", ...Array.from({ length: 5 }, (_, i) => `s${i}`)];
    expect(() => parseClarityCsv(rows.join("\n"), { maxRows: 3 })).toThrow(/exceeding/);
  });
});
