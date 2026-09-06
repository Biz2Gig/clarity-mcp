import { describe, expect, it } from "vitest";

import {
  clampWindow,
  msToShortTimecode,
  msToTimecode,
  nearestFrame,
  parseTimestampToMs,
} from "../app/video/timestamps";

describe("parseTimestampToMs", () => {
  it("parses numeric seconds", () => {
    expect(parseTimestampToMs(12)).toBe(12_000);
    expect(parseTimestampToMs(12.5)).toBe(12_500);
    expect(parseTimestampToMs("12")).toBe(12_000);
    expect(parseTimestampToMs("12.25")).toBe(12_250);
  });

  it("parses clock strings", () => {
    expect(parseTimestampToMs("01:02")).toBe(62_000);
    expect(parseTimestampToMs("1:02:03")).toBe(3_723_000);
    expect(parseTimestampToMs("00:00:01.500")).toBe(1_500);
    expect(parseTimestampToMs("00:00:01,5")).toBe(1_500);
  });

  it("parses unit strings and ms suffix", () => {
    expect(parseTimestampToMs("1h2m3s")).toBe(3_723_000);
    expect(parseTimestampToMs("90s")).toBe(90_000);
    expect(parseTimestampToMs("2m")).toBe(120_000);
    expect(parseTimestampToMs("1500ms")).toBe(1_500);
  });

  it("rejects malformed input", () => {
    expect(() => parseTimestampToMs("")).toThrow();
    expect(() => parseTimestampToMs("later")).toThrow();
    expect(() => parseTimestampToMs(-1)).toThrow();
    expect(() => parseTimestampToMs("99:99")).toThrow();
  });
});

describe("msToTimecode", () => {
  it("formats HH:MM:SS.mmm", () => {
    expect(msToTimecode(0)).toBe("00:00:00.000");
    expect(msToTimecode(1_500)).toBe("00:00:01.500");
    expect(msToTimecode(3_723_045)).toBe("01:02:03.045");
  });
  it("round-trips with parseTimestampToMs", () => {
    for (const ms of [0, 999, 60_000, 3_661_250]) {
      expect(parseTimestampToMs(msToTimecode(ms))).toBe(ms);
    }
  });
  it("msToShortTimecode drops the hour under 1h", () => {
    expect(msToShortTimecode(62_000)).toBe("1:02");
    expect(msToShortTimecode(3_723_000)).toBe("1:02:03");
  });
});

describe("nearestFrame", () => {
  const frames = [
    { timestampMs: 0, id: "a" },
    { timestampMs: 1000, id: "b" },
    { timestampMs: 2000, id: "c" },
    { timestampMs: 5000, id: "d" },
  ];

  it("returns the closest frame", () => {
    expect(nearestFrame(frames, 900)?.id).toBe("b");
    expect(nearestFrame(frames, 2400)?.id).toBe("c");
    expect(nearestFrame(frames, 9999)?.id).toBe("d");
  });

  it("resolves ties to the earlier frame", () => {
    expect(nearestFrame(frames, 1500)?.id).toBe("b");
  });

  it("handles the empty list", () => {
    expect(nearestFrame([], 100)).toBeUndefined();
  });
});

describe("clampWindow", () => {
  it("clamps to [0, duration] and keeps start <= end", () => {
    expect(clampWindow(-100, 999_999, 10_000)).toEqual({ startMs: 0, endMs: 10_000 });
    expect(clampWindow(8000, 2000, 10_000)).toEqual({ startMs: 8000, endMs: 8000 });
    expect(clampWindow(undefined, undefined, 10_000)).toEqual({
      startMs: 0,
      endMs: 10_000,
    });
  });
});
