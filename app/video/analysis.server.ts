/**
 * Read-side helpers for the video analysis / QA / frame MCP tools.
 */

import prisma from "../db.server";
import { NotFoundError, ValidationError } from "../errors";
import { getSynthesisProvider } from "../providers";
import { getStorage } from "../storage/index.server";
import { loadEvidence } from "./pipeline.server";
import {
  clampWindow,
  msToShortTimecode,
  msToTimecode,
  nearestFrame,
  parseTimestampToMs,
} from "./timestamps";

function withTimecodes<T extends { timestampMs: number }>(items: T[]) {
  return items.map((i) => ({
    ...i,
    timecode: msToTimecode(i.timestampMs),
  }));
}

export async function getVideoAnalysis(opts: {
  videoId: string;
  detail?: "compact" | "detailed";
}) {
  const video = await prisma.videoAsset.findUnique({
    where: { id: opts.videoId },
    include: { analysis: true, _count: { select: { segments: true, frames: true } } },
  });
  if (!video) throw new NotFoundError(`No video with id ${opts.videoId}.`);
  if (!video.analysis) {
    throw new NotFoundError(
      `Video ${opts.videoId} has no completed analysis yet. Check get_video_status.`,
    );
  }

  const a = video.analysis;
  const provenance = {
    sttProvider: video.sttProvider,
    sttModel: video.sttModel,
    visionProvider: video.visionProvider,
    visionModel: video.visionModel,
    synthesisProvider: a.provider,
    synthesisModel: a.model,
    transcriptSegments: video._count.segments,
    analyzedFrames: video._count.frames,
    analyzedAt: a.updatedAt.toISOString(),
  };

  if ((opts.detail ?? "detailed") === "compact") {
    return {
      videoId: video.id,
      title: video.title,
      durationSec: video.durationSec,
      executiveSummary: a.executiveSummary,
      transcriptSummary: a.transcriptSummary,
      importantEvents: withTimecodes(
        (a.importantEvents as { timestampMs: number; description: string }[]).slice(0, 10),
      ),
      recommendations: (a.recommendations as string[]).slice(0, 5),
      provenance,
    };
  }

  return {
    videoId: video.id,
    title: video.title,
    durationSec: video.durationSec,
    executiveSummary: a.executiveSummary,
    fullDescription: a.fullDescription,
    transcriptSummary: a.transcriptSummary,
    importantEvents: withTimecodes(
      a.importantEvents as { timestampMs: number; description: string }[],
    ),
    visibleText: withTimecodes(
      a.visibleText as { timestampMs: number; text: string }[],
    ),
    detectedObjects: a.detectedObjects,
    problems: a.problems,
    recommendations: a.recommendations,
    citations: a.citations,
    provenance,
  };
}

export async function answerVideoQuestion(opts: {
  videoId: string;
  question: string;
  startTime?: string | number;
  endTime?: string | number;
}) {
  if (!opts.question || opts.question.trim().length < 3) {
    throw new ValidationError("`question` must be a non-empty string.");
  }
  const video = await prisma.videoAsset.findUnique({
    where: { id: opts.videoId },
    include: { analysis: true },
  });
  if (!video) throw new NotFoundError(`No video with id ${opts.videoId}.`);

  const durationMs = Math.round((video.durationSec ?? 0) * 1000);
  const window =
    opts.startTime !== undefined || opts.endTime !== undefined
      ? clampWindow(
          opts.startTime !== undefined ? parseTimestampToMs(opts.startTime) : undefined,
          opts.endTime !== undefined ? parseTimestampToMs(opts.endTime) : undefined,
          durationMs || Number.MAX_SAFE_INTEGER,
        )
      : undefined;

  const evidence = await loadEvidence(video.id, window);
  if (evidence.transcript.length === 0 && evidence.frames.length === 0) {
    return {
      videoId: video.id,
      question: opts.question,
      window: window ?? null,
      answer:
        "There is no stored transcript or keyframe evidence for this video" +
        (window ? " in the requested time window" : "") +
        ", so the question cannot be answered.",
      citations: [],
      insufficientEvidence: true,
      provider: null,
      model: null,
    };
  }

  const synth = getSynthesisProvider();
  const analysisRaw = video.analysis?.raw as
    | Parameters<typeof synth.answerQuestion>[0]["analysis"]
    | undefined;

  const res = await synth.answerQuestion({
    question: opts.question,
    window,
    transcript: evidence.transcript,
    frames: evidence.frames,
    analysis: analysisRaw ?? null,
  });

  return {
    videoId: video.id,
    question: opts.question,
    window: window ?? null,
    answer: res.answer,
    citations: res.citations.map((c) => ({
      ...c,
      timecodes: c.timestampsMs.map(msToShortTimecode),
    })),
    insufficientEvidence: res.insufficientEvidence,
    provider: res.provider,
    model: res.model,
  };
}

export async function getVideoFrameImage(opts: {
  videoId: string;
  timestamp: string | number;
}) {
  const video = await prisma.videoAsset.findUnique({
    where: { id: opts.videoId },
    select: { id: true, durationSec: true },
  });
  if (!video) throw new NotFoundError(`No video with id ${opts.videoId}.`);

  const frames = await prisma.extractedFrame.findMany({
    where: { videoId: opts.videoId },
    orderBy: { idx: "asc" },
  });
  if (frames.length === 0) {
    throw new NotFoundError(
      `Video ${opts.videoId} has no extracted frames (extractVisuals was off or processing is incomplete).`,
    );
  }

  const targetMs = parseTimestampToMs(opts.timestamp);
  const match = nearestFrame(
    frames.map((f) => ({ ...f, timestampMs: f.timestampMs })),
    targetMs,
  )!;

  const bytes = await getStorage().get(match.storageKey);
  return {
    videoId: opts.videoId,
    requestedMs: targetMs,
    frame: {
      idx: match.idx,
      timestampMs: match.timestampMs,
      timecode: msToTimecode(match.timestampMs),
      deltaMs: match.timestampMs - targetMs,
      sceneChange: match.sceneChange,
      description: match.description ?? null,
      ocrText: match.ocrText ?? null,
      objects: match.objects ?? null,
    },
    image: { mimeType: "image/jpeg", base64: bytes.toString("base64") },
  };
}
