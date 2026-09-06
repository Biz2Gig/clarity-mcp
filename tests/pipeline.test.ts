/**
 * End-to-end pipeline test. Requires BOTH a database (TEST_DATABASE_URL) and
 * ffmpeg/ffprobe on PATH. A tiny synthetic video is generated at runtime -
 * no binary fixture is committed. Providers are the deterministic mocks.
 */

import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, expect, it as vitestIt } from "vitest";

import {
  answerVideoQuestion,
  getVideoAnalysis,
  getVideoFrameImage,
} from "../app/video/analysis.server";
import { claimNextJob, createVideoJob } from "../app/video/jobs.server";
import { processJob } from "../app/video/pipeline.server";
import { FilesystemStorage } from "../app/storage/filesystem.server";
import { __setStorage } from "../app/storage/index.server";
import { describeDb, prisma, resetDb } from "./helpers/db";
import { hasFfmpeg, makeSyntheticVideo } from "./helpers/synthVideo";

const ffmpegOk = await hasFfmpeg();
const it = ffmpegOk ? vitestIt : vitestIt.skip;

if (!ffmpegOk) {
  // eslint-disable-next-line no-console
  console.warn("[tests] ffmpeg not found - skipping the end-to-end pipeline test.");
}

describeDb("video pipeline (end-to-end)", () => {
  let server: http.Server;
  let baseUrl = "";
  let videoPath = "";
  let storageDir = "";

  beforeAll(async () => {
    process.env.ALLOW_INSECURE_URLS = "true";
    videoPath = (await makeSyntheticVideo(3)) ?? "";
    storageDir = await mkdtemp(path.join(os.tmpdir(), "clarity-mcp-store-"));
    __setStorage(new FilesystemStorage(storageDir));

    server = http.createServer(async (req, res) => {
      try {
        const s = await stat(videoPath);
        res.writeHead(200, {
          "content-type": "video/mp4",
          "content-length": String(s.size),
        });
        createReadStream(videoPath).pipe(res);
      } catch {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server?.close();
    __setStorage(undefined);
    delete process.env.ALLOW_INSECURE_URLS;
    if (storageDir) await rm(storageDir, { recursive: true, force: true });
    if (videoPath) await rm(path.dirname(videoPath), { recursive: true, force: true });
  });

  beforeEach(resetDb);

  it("downloads, transcribes, extracts frames, analyzes and answers questions", async () => {
    const { videoId, jobId } = await createVideoJob({
      videoUrl: `${baseUrl}/sample.mp4`,
      title: "Synthetic clip",
      analysisPrompt: "describe the test pattern",
    });

    const claimed = await claimNextJob("test-worker");
    expect(claimed?.id).toBe(jobId);
    await processJob(claimed!);

    const job = await prisma.processingJob.findUnique({ where: { id: jobId } });
    expect(job?.stage).toBe("completed");

    const video = await prisma.videoAsset.findUnique({
      where: { id: videoId },
      include: { _count: { select: { segments: true, frames: true } } },
    });
    expect(video?.status).toBe("completed");
    expect(video?.durationSec).toBeGreaterThan(0);
    expect(video?._count.segments).toBeGreaterThan(0);
    expect(video?._count.frames).toBeGreaterThan(0);
    expect(video?.synthesisProvider).toBe("mock");
    expect(video?.storageKey).toBeTruthy();

    const analysis = await getVideoAnalysis({ videoId, detail: "detailed" });
    expect(analysis.executiveSummary).toBeTruthy();
    expect(analysis.provenance.synthesisProvider).toBe("mock");

    const qa = await answerVideoQuestion({
      videoId,
      question: "Mock transcript?",
    });
    expect(qa).toHaveProperty("citations");
    expect(typeof qa.insufficientEvidence).toBe("boolean");

    const frame = await getVideoFrameImage({ videoId, timestamp: "1s" });
    expect(frame.image.mimeType).toBe("image/jpeg");
    expect(frame.image.base64.length).toBeGreaterThan(0);
    expect(frame.frame).toHaveProperty("timestampMs");
  });
});
