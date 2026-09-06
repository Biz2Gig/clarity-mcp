/**
 * Video processing pipeline. Invoked by the worker for one claimed job.
 * Stages: downloading -> probing -> extracting_audio -> transcribing ->
 * extracting_frames -> analyzing_frames -> synthesizing -> completed.
 * All temp files are removed in `finally`.
 */

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { JobStage, type Prisma } from "@prisma/client";

import { config } from "../config.server";
import prisma from "../db.server";
import { NotFoundError, ValidationError } from "../errors";
import {
  getSttProvider,
  getSynthesisProvider,
  getVisionProvider,
} from "../providers";
import type {
  FrameAnalysisResult,
  TranscriptSegmentResult,
} from "../providers/types";
import { getStorage, frameKey, videoSourceKey } from "../storage/index.server";
import { downloadToTempFile } from "./download.server";
import {
  assertFfmpegAvailable,
  extractAudio,
  extractKeyframes,
  probe,
} from "./ffmpeg.server";
import type { ClaimedJob } from "./jobs.server";
import { completeJob, heartbeat, setStage } from "./jobs.server";
import { clampWindow } from "./timestamps";

export async function processJob(job: ClaimedJob): Promise<void> {
  const video = job.video;
  const storage = getStorage();
  const workDir = await mkdtemp(path.join(os.tmpdir(), "clarity-mcp-job-"));
  let downloadCleanup: (() => Promise<void>) | undefined;
  const beat = () => heartbeat(job.id, job.lockedBy ?? config.workerId);

  try {
    await assertFfmpegAvailable();

    // --- downloading -------------------------------------------------------
    await setStage(job.id, JobStage.downloading);
    if (!video.sourceUrl) throw new ValidationError("Video has no source URL.");
    const dl = await downloadToTempFile(video.sourceUrl, {
      kind: "video",
      maxBytes: config.videoMaxBytes,
    });
    downloadCleanup = dl.cleanup;
    await beat();

    // --- probing ---------------------------------------------------------
    await setStage(job.id, JobStage.probing);
    const info = await probe(dl.path);
    if (info.durationSec > config.videoMaxDurationSec) {
      throw new ValidationError(
        `Video duration ${info.durationSec.toFixed(0)}s exceeds the limit ` +
          `of ${config.videoMaxDurationSec}s.`,
      );
    }
    const durationMs = Math.round(info.durationSec * 1000);
    const storageKey = videoSourceKey(video.id, dl.filename);
    await storage.putFile(storageKey, dl.path, { contentType: dl.contentType });
    await prisma.videoAsset.update({
      where: { id: video.id },
      data: {
        storageKey,
        mimeType: dl.contentType || video.mimeType,
        fileSize: dl.bytes,
        durationSec: info.durationSec,
        width: info.width ?? null,
        height: info.height ?? null,
        fps: info.fps ?? null,
        status: "processing",
      },
    });
    await beat();

    // --- extracting_audio + transcribing --------------------------------
    let transcript: TranscriptSegmentResult[] = [];
    let sttProvName: string | null = null;
    let sttModel: string | null = null;
    if (info.hasAudio) {
      await setStage(job.id, JobStage.extracting_audio);
      const wavPath = path.join(workDir, "audio.wav");
      await extractAudio(dl.path, wavPath);
      await beat();

      await setStage(job.id, JobStage.transcribing);
      const stt = getSttProvider();
      const result = await stt.transcribe({
        audioPath: wavPath,
        language: video.language ?? undefined,
      });
      transcript = result.segments;
      sttProvName = result.provider;
      sttModel = result.model;

      await prisma.transcriptSegment.deleteMany({ where: { videoId: video.id } });
      if (transcript.length > 0) {
        await prisma.transcriptSegment.createMany({
          data: transcript.map((s, idx) => ({
            videoId: video.id,
            idx,
            startMs: s.startMs,
            endMs: s.endMs,
            text: s.text,
            speaker: s.speaker ?? null,
            confidence: s.confidence ?? null,
          })),
        });
      }
      await beat();
    } else {
      await setStage(job.id, JobStage.extracting_audio);
      await setStage(job.id, JobStage.transcribing);
    }

    // --- extracting_frames + analyzing_frames --------------------------
    let frames: FrameAnalysisResult[] = [];
    let visionProvName: string | null = null;
    let visionModel: string | null = null;
    if (video.extractVisuals) {
      await setStage(job.id, JobStage.extracting_frames);
      const framesDir = path.join(workDir, "frames");
      const kf = await extractKeyframes(dl.path, {
        outDir: framesDir,
        durationSec: info.durationSec,
      });
      await prisma.extractedFrame.deleteMany({ where: { videoId: video.id } });
      for (const f of kf) {
        await storage.putFile(frameKey(video.id, f.index), f.path, {
          contentType: "image/jpeg",
        });
      }
      await prisma.extractedFrame.createMany({
        data: kf.map((f) => ({
          videoId: video.id,
          idx: f.index,
          timestampMs: f.timestampMs,
          storageKey: frameKey(video.id, f.index),
          sceneChange: f.sceneChange,
        })),
      });
      await beat();

      await setStage(job.id, JobStage.analyzing_frames);
      if (kf.length > 0) {
        const vision = getVisionProvider();
        const analysis = await vision.analyzeFrames({
          frames: kf.map((f) => ({ timestampMs: f.timestampMs, imagePath: f.path })),
          prompt: video.analysisPrompt ?? undefined,
        });
        frames = analysis.results;
        visionProvName = analysis.provider;
        visionModel = analysis.model;
        for (let i = 0; i < kf.length; i++) {
          const r = analysis.results[i];
          if (!r) continue;
          await prisma.extractedFrame.update({
            where: { videoId_idx: { videoId: video.id, idx: kf[i].index } },
            data: {
              description: r.description,
              ocrText: r.ocrText ?? null,
              objects: (r.objects ?? []) as unknown as Prisma.InputJsonValue,
            },
          });
        }
      }
      await beat();
    } else {
      await setStage(job.id, JobStage.extracting_frames);
      await setStage(job.id, JobStage.analyzing_frames);
    }

    if (transcript.length === 0 && frames.length === 0) {
      throw new ValidationError(
        "No usable audio or visual content was extracted from the video.",
      );
    }

    // --- synthesizing --------------------------------------------------
    await setStage(job.id, JobStage.synthesizing);
    const synth = getSynthesisProvider();
    const result = await synth.synthesize({
      title: video.title ?? undefined,
      analysisPrompt: video.analysisPrompt ?? undefined,
      durationMs,
      transcript,
      frames,
    });

    const analysisRow = {
      executiveSummary: result.executiveSummary,
      fullDescription: result.fullDescription,
      transcriptSummary: result.transcriptSummary,
      importantEvents: result.importantEvents as unknown as Prisma.InputJsonValue,
      visibleText: result.visibleText as unknown as Prisma.InputJsonValue,
      detectedObjects: result.detectedObjects as unknown as Prisma.InputJsonValue,
      problems: result.problems as unknown as Prisma.InputJsonValue,
      recommendations: result.recommendations as unknown as Prisma.InputJsonValue,
      citations: result.citations as unknown as Prisma.InputJsonValue,
      raw: result as unknown as Prisma.InputJsonValue,
      provider: result.provider,
      model: result.model,
    };
    await prisma.videoAnalysis.upsert({
      where: { videoId: video.id },
      create: { videoId: video.id, ...analysisRow },
      update: analysisRow,
    });

    await prisma.videoAsset.update({
      where: { id: video.id },
      data: {
        sttProvider: sttProvName,
        sttModel,
        visionProvider: visionProvName,
        visionModel,
        synthesisProvider: result.provider,
        synthesisModel: result.model,
      },
    });

    await completeJob(job.id, video.id);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
    if (downloadCleanup) await downloadCleanup().catch(() => {});
  }
}

// --------------------------------------------------------------------------
// Read helpers used by the MCP video tools
// --------------------------------------------------------------------------

export async function getTranscript(opts: {
  videoId: string;
  startMs?: number;
  endMs?: number;
  limit?: number;
  offset?: number;
}) {
  const video = await prisma.videoAsset.findUnique({
    where: { id: opts.videoId },
    select: { id: true, durationSec: true },
  });
  if (!video) throw new NotFoundError(`No video with id ${opts.videoId}.`);

  const durationMs = Math.round((video.durationSec ?? 0) * 1000);
  const window =
    opts.startMs !== undefined || opts.endMs !== undefined
      ? clampWindow(opts.startMs, opts.endMs, durationMs || Number.MAX_SAFE_INTEGER)
      : undefined;

  const where: Prisma.TranscriptSegmentWhereInput = { videoId: opts.videoId };
  if (window) {
    where.startMs = { lt: window.endMs };
    where.endMs = { gt: window.startMs };
  }

  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);

  const [total, rows] = await Promise.all([
    prisma.transcriptSegment.count({ where }),
    prisma.transcriptSegment.findMany({
      where,
      orderBy: { idx: "asc" },
      skip: offset,
      take: limit,
    }),
  ]);

  return {
    videoId: opts.videoId,
    total,
    count: rows.length,
    offset,
    limit,
    nextOffset: offset + rows.length < total ? offset + rows.length : null,
    window: window ?? null,
    segments: rows.map((s) => ({
      idx: s.idx,
      startMs: s.startMs,
      endMs: s.endMs,
      text: s.text,
      speaker: s.speaker,
      confidence: s.confidence,
    })),
  };
}

export async function loadEvidence(videoId: string, window?: { startMs: number; endMs: number }) {
  const [segments, frames] = await Promise.all([
    prisma.transcriptSegment.findMany({
      where: {
        videoId,
        ...(window
          ? { startMs: { lt: window.endMs }, endMs: { gt: window.startMs } }
          : {}),
      },
      orderBy: { idx: "asc" },
    }),
    prisma.extractedFrame.findMany({
      where: {
        videoId,
        ...(window
          ? { timestampMs: { gte: window.startMs, lte: window.endMs } }
          : {}),
      },
      orderBy: { idx: "asc" },
    }),
  ]);

  return {
    transcript: segments.map<TranscriptSegmentResult>((s) => ({
      startMs: s.startMs,
      endMs: s.endMs,
      text: s.text,
      speaker: s.speaker ?? undefined,
      confidence: s.confidence ?? undefined,
    })),
    frames: frames.map<FrameAnalysisResult>((f) => ({
      timestampMs: f.timestampMs,
      description: f.description ?? "(frame not yet analyzed)",
      ocrText: f.ocrText ?? undefined,
      objects:
        (f.objects as unknown as FrameAnalysisResult["objects"]) ?? undefined,
    })),
  };
}
