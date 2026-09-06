/**
 * Database-backed integration suites. Run with a reachable Postgres:
 *
 *   TEST_DATABASE_URL=postgres://... npx prisma migrate deploy
 *   TEST_DATABASE_URL=postgres://... npm test
 *
 * Without TEST_DATABASE_URL the whole file is skipped (see tests/helpers/db.ts).
 */

import { afterEach, beforeEach, expect, it } from "vitest";

import {
  getLiveInsights,
  quotaStatus,
  reserveQuotaSlot,
} from "../app/clarity.server";
import {
  getClarityRecording,
  importClarityRecordings,
  searchClarityRecordings,
} from "../app/clarity/recordings.server";
import {
  claimNextJob,
  completeJob,
  createVideoJob,
  failJob,
  getVideoStatus,
} from "../app/video/jobs.server";
import { getTranscript } from "../app/video/pipeline.server";
import { describeDb, prisma, resetDb } from "./helpers/db";

const RECORDINGS_CSV = [
  "Recording link,Session ID,Start time,Duration,Entry URL,Exit URL,Device,Browser,Country,Rage clicks,Dead clicks,Script errors",
  "https://clarity.microsoft.com/player/s1,s1,2026-02-01T10:00:00Z,00:02:00,https://shop/,https://shop/cart,Desktop,Chrome,United States,2,0,1",
  "https://clarity.microsoft.com/player/s2,s2,2026-02-02T10:00:00Z,00:00:30,https://shop/x,https://shop/y,Mobile,Safari,Canada,0,0,0",
  "https://clarity.microsoft.com/player/s3,s3,2026-02-03T10:00:00Z,00:05:00,https://shop/,https://shop/checkout,Desktop,Firefox,United States,0,3,0",
].join("\n");

describeDb("Clarity quota reservation (atomic)", () => {
  beforeEach(resetDb);

  it("never lets concurrent reservations exceed the daily limit", async () => {
    const results = await Promise.all(
      Array.from({ length: 25 }, () => reserveQuotaSlot()),
    );
    const granted = results.filter((r) => r.ok).length;
    expect(granted).toBe(10);

    const q = await quotaStatus();
    expect(q.used).toBe(10);
    expect(q.remaining).toBe(0);

    const extra = await reserveQuotaSlot();
    expect(extra.ok).toBe(false);
  });
});

describeDb("Clarity stale-cache behavior", () => {
  const prev = process.env.CLARITY_REFRESH_POLICY;
  beforeEach(resetDb);
  afterEach(() => {
    if (prev === undefined) delete process.env.CLARITY_REFRESH_POLICY;
    else process.env.CLARITY_REFRESH_POLICY = prev;
  });

  async function seedCache(ageMs: number) {
    await prisma.insightsCache.create({
      data: {
        key: "3::",
        numOfDays: 3,
        dimensions: "",
        payload: [{ metricName: "Traffic", information: [] }],
        fetchedAt: new Date(Date.now() - ageMs),
      },
    });
  }

  it("returns fresh cache immediately, not marked stale", async () => {
    await seedCache(1000);
    const r = await getLiveInsights({ numOfDays: 3 });
    expect(r.meta.source).toBe("cache");
    expect(r.meta.stale).toBe(false);
    expect(r.meta.warning).toBeUndefined();
    expect((await quotaStatus()).used).toBe(0);
  });

  it("policy=stale: serves stale data with an explicit warning, no API call", async () => {
    process.env.CLARITY_REFRESH_POLICY = "stale";
    await seedCache(9 * 60 * 60 * 1000);
    const r = await getLiveInsights({ numOfDays: 3 });
    expect(r.meta.source).toBe("cache");
    expect(r.meta.stale).toBe(true);
    expect(r.meta.warning).toMatch(/stale/i);
    expect((await quotaStatus()).used).toBe(0);
  });

  it("quota exhausted: serves stale data with a quota warning, never as current", async () => {
    process.env.CLARITY_REFRESH_POLICY = "revalidate";
    await seedCache(9 * 60 * 60 * 1000);
    await prisma.apiCallLog.create({
      data: { day: new Date().toISOString().slice(0, 10), count: 10 },
    });
    const r = await getLiveInsights({ numOfDays: 3 });
    expect(r.meta.source).toBe("cache");
    expect(r.meta.stale).toBe(true);
    expect(r.meta.warning).toMatch(/quota/i);
  });
});

describeDb("Clarity recording import / search / get", () => {
  beforeEach(resetDb);

  it("imports, deduplicates on re-import, and reports counts", async () => {
    const first = await importClarityRecordings({ csvText: RECORDINGS_CSV });
    expect(first.inserted).toBe(3);
    expect(first.updated).toBe(0);
    expect(first.note).toMatch(/metadata only/i);

    const second = await importClarityRecordings({ csvText: RECORDINGS_CSV });
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(3);

    const replaced = await importClarityRecordings({
      csvText: RECORDINGS_CSV,
      replaceExisting: true,
    });
    expect(replaced.replacedExisting).toBe(true);
    expect(replaced.inserted).toBe(3);
  });

  it("filters and paginates", async () => {
    await importClarityRecordings({ csvText: RECORDINGS_CSV });

    const desktop = await searchClarityRecordings({ device: "desktop" });
    expect(desktop.total).toBe(2);

    const rage = await searchClarityRecordings({ hasRageClicks: true });
    expect(rage.total).toBe(1);
    expect(rage.records[0].sessionId).toBe("s1");

    const longOnes = await searchClarityRecordings({ minDurationMs: 120_000 });
    expect(longOnes.total).toBe(2); // s1 (120s) and s3 (300s)

    const page1 = await searchClarityRecordings({ limit: 2, offset: 0 });
    expect(page1.count).toBe(2);
    expect(page1.nextOffset).toBe(2);
    const page2 = await searchClarityRecordings({ limit: 2, offset: 2 });
    expect(page2.count).toBe(1);
    expect(page2.nextOffset).toBeNull();
  });

  it("fetches one recording with the full original row", async () => {
    await importClarityRecordings({ csvText: RECORDINGS_CSV });
    const rec = await getClarityRecording({ sessionId: "s2" });
    expect(rec.recordingUrl).toContain("/player/s2");
    expect(rec.raw).toHaveProperty("Browser", "Safari");
  });
});

describeDb("Video job state machine", () => {
  beforeEach(resetDb);

  const VIDEO_URL = "https://example.com/sample.mp4";

  it("claims exclusively and reclaims nothing while locked", async () => {
    const { jobId } = await createVideoJob({ videoUrl: VIDEO_URL });
    const a = await claimNextJob("worker-a");
    expect(a?.id).toBe(jobId);
    expect(a?.stage).toBe("downloading");
    expect(a?.lockedBy).toBe("worker-a");
    expect(a?.attempts).toBe(1);

    const b = await claimNextJob("worker-b");
    expect(b).toBeNull();
  });

  it("two workers claiming three jobs get three distinct jobs", async () => {
    await createVideoJob({ videoUrl: VIDEO_URL });
    await createVideoJob({ videoUrl: VIDEO_URL });
    await createVideoJob({ videoUrl: VIDEO_URL });
    const claims = await Promise.all([
      claimNextJob("w1"),
      claimNextJob("w2"),
      claimNextJob("w3"),
    ]);
    const ids = claims.map((c) => c?.id);
    expect(new Set(ids).size).toBe(3);
  });

  it("retries with backoff then fails permanently", async () => {
    const { jobId, videoId } = await createVideoJob({ videoUrl: VIDEO_URL });

    for (let attempt = 1; attempt <= 3; attempt++) {
      const claimed = await claimNextJob("w1");
      expect(claimed?.id).toBe(jobId);
      const { willRetry } = await failJob(jobId, videoId, `fail ${attempt}`);
      if (attempt < 3) {
        expect(willRetry).toBe(true);
        await prisma.processingJob.update({
          where: { id: jobId },
          data: { runAfter: new Date(Date.now() - 1000) },
        });
      } else {
        expect(willRetry).toBe(false);
      }
    }

    const status = await getVideoStatus(videoId);
    expect(status.stage).toBe("failed");
    expect(status.status).toBe("failed");
    expect(status.error).toMatch(/fail 3/);
  });

  it("completeJob marks video completed", async () => {
    const { jobId, videoId } = await createVideoJob({ videoUrl: VIDEO_URL });
    await claimNextJob("w1");
    await completeJob(jobId, videoId);
    const status = await getVideoStatus(videoId);
    expect(status.stage).toBe("completed");
    expect(status.status).toBe("completed");
    expect(status.progressPercent).toBe(100);
  });
});

describeDb("Transcript pagination + windowing", () => {
  beforeEach(resetDb);

  it("paginates and filters by time window", async () => {
    const video = await prisma.videoAsset.create({
      data: { sourceUrl: "https://example.com/v.mp4", durationSec: 20 },
    });
    await prisma.transcriptSegment.createMany({
      data: Array.from({ length: 10 }, (_, i) => ({
        videoId: video.id,
        idx: i,
        startMs: i * 2000,
        endMs: i * 2000 + 2000,
        text: `segment ${i}`,
      })),
    });

    const p1 = await getTranscript({ videoId: video.id, limit: 3, offset: 0 });
    expect(p1.total).toBe(10);
    expect(p1.count).toBe(3);
    expect(p1.nextOffset).toBe(3);

    const last = await getTranscript({ videoId: video.id, limit: 3, offset: 9 });
    expect(last.count).toBe(1);
    expect(last.nextOffset).toBeNull();

    const windowed = await getTranscript({
      videoId: video.id,
      startMs: 5000,
      endMs: 9000,
    });
    // segments overlapping [5000,9000): idx 2 (4000-6000), 3 (6000-8000), 4 (8000-10000)
    expect(windowed.segments.map((s) => s.idx)).toEqual([2, 3, 4]);
  });
});
