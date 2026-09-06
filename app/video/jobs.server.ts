/**
 * Durable video job lifecycle backed by PostgreSQL. Job claiming uses
 * `FOR UPDATE SKIP LOCKED` so multiple workers never process the same job.
 * Failed jobs keep their error message and are retried up to `maxAttempts`.
 */

import { JobStage, VideoStatus, type Prisma } from "@prisma/client";

import { config } from "../config.server";
import prisma from "../db.server";
import { NotFoundError } from "../errors";
import { assertSafeUrl } from "./ssrf";

export const PENDING_STAGES: JobStage[] = [
  JobStage.queued,
  JobStage.downloading,
  JobStage.probing,
  JobStage.extracting_audio,
  JobStage.transcribing,
  JobStage.extracting_frames,
  JobStage.analyzing_frames,
  JobStage.synthesizing,
];

const STAGE_PROGRESS: Record<JobStage, number> = {
  queued: 0,
  downloading: 10,
  probing: 20,
  extracting_audio: 30,
  transcribing: 50,
  extracting_frames: 65,
  analyzing_frames: 80,
  synthesizing: 92,
  completed: 100,
  failed: 100,
};

const STAGE_STEP: Record<JobStage, number> = {
  queued: 0,
  downloading: 1,
  probing: 2,
  extracting_audio: 3,
  transcribing: 4,
  extracting_frames: 5,
  analyzing_frames: 6,
  synthesizing: 7,
  completed: 8,
  failed: 8,
};

const SIGNED_URL_HINTS = [
  "x-amz-signature",
  "x-amz-credential",
  "signature=",
  "sig=",
  "token=",
  "se=", // azure sas
  "sp=",
  "sr=",
  "goog-signature",
];

/** True when the URL looks presigned/credentialed and must not be persisted verbatim. */
export function looksPresigned(url: string): boolean {
  const lower = url.toLowerCase();
  return SIGNED_URL_HINTS.some((h) => lower.includes(h));
}

/** Origin + path only, for display. */
export function redactUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return looksPresigned(url) ? `${u.origin}${u.pathname} (query redacted)` : url;
  } catch {
    return null;
  }
}

export interface CreateVideoInput {
  videoUrl: string;
  title?: string;
  language?: string;
  analysisPrompt?: string;
  extractVisuals?: boolean;
}

export async function createVideoJob(input: CreateVideoInput): Promise<{
  videoId: string;
  jobId: string;
  status: VideoStatus;
  stage: JobStage;
}> {
  // Fast fail on an obviously unsafe URL; the worker re-validates every hop.
  await assertSafeUrl(input.videoUrl, {
    allowInsecure: config.allowInsecureUrls,
  });

  const video = await prisma.videoAsset.create({
    data: {
      title: input.title ?? null,
      sourceUrl: input.videoUrl,
      language: input.language ?? null,
      analysisPrompt: input.analysisPrompt ?? null,
      extractVisuals: input.extractVisuals ?? true,
      status: VideoStatus.queued,
    },
  });

  const job = await prisma.processingJob.create({
    data: {
      videoId: video.id,
      stage: JobStage.queued,
      stepsTotal: 8,
      maxAttempts: 3,
    },
  });

  return {
    videoId: video.id,
    jobId: job.id,
    status: video.status,
    stage: job.stage,
  };
}

export type ClaimedJob = Prisma.ProcessingJobGetPayload<{ include: { video: true } }>;

/**
 * Atomically claim the next runnable job for `workerId`. A job is runnable if
 * it is not finished, its `runAfter` has passed, and it is either unlocked or
 * its lock is stale (previous worker crashed). The inner SELECT ... FOR UPDATE
 * SKIP LOCKED ensures two workers cannot grab the same row.
 */
export async function claimNextJob(
  workerId: string,
): Promise<ClaimedJob | null> {
  const staleSeconds = config.workerStaleLockMs / 1000;
  // Enum values below are from a fixed server-side enum, not user input, so
  // they are inlined as literals; only `workerId` and the interval are bound.
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "ProcessingJob" AS j
    SET "lockedBy" = ${workerId},
        "lockedAt" = now(),
        "attempts" = j."attempts" + 1,
        "startedAt" = COALESCE(j."startedAt", now()),
        "stage" = 'downloading'::"JobStage",
        "error" = NULL,
        "updatedAt" = now()
    WHERE j."id" = (
      SELECT c."id" FROM "ProcessingJob" c
      WHERE c."stage" NOT IN ('completed'::"JobStage", 'failed'::"JobStage")
        AND c."runAfter" <= now()
        AND (
          c."lockedAt" IS NULL
          OR c."lockedAt" < now() - make_interval(secs => ${staleSeconds})
        )
      ORDER BY c."createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING j."id"
  `;
  if (rows.length === 0) return null;
  return prisma.processingJob.findUnique({
    where: { id: rows[0].id },
    include: { video: true },
  });
}

export async function setStage(
  jobId: string,
  stage: JobStage,
  extra: { note?: string } = {},
): Promise<void> {
  await prisma.processingJob.update({
    where: { id: jobId },
    data: {
      stage,
      progress: STAGE_PROGRESS[stage],
      stepsDone: STAGE_STEP[stage],
      ...(extra.note ? { error: null } : {}),
    },
  });
}

export async function heartbeat(jobId: string, workerId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "ProcessingJob" SET "lockedAt" = now(), "updatedAt" = now()
    WHERE "id" = ${jobId} AND "lockedBy" = ${workerId}
  `;
}

export async function completeJob(jobId: string, videoId: string): Promise<void> {
  await prisma.$transaction([
    prisma.processingJob.update({
      where: { id: jobId },
      data: {
        stage: JobStage.completed,
        progress: 100,
        stepsDone: 8,
        finishedAt: new Date(),
        lockedBy: null,
        lockedAt: null,
        error: null,
      },
    }),
    prisma.videoAsset.update({
      where: { id: videoId },
      data: { status: VideoStatus.completed, error: null },
    }),
  ]);
}

/** Record a failure. Retries with backoff until `maxAttempts` is exhausted. */
export async function failJob(
  jobId: string,
  videoId: string,
  message: string,
): Promise<{ willRetry: boolean }> {
  const job = await prisma.processingJob.findUnique({ where: { id: jobId } });
  if (!job) return { willRetry: false };

  const willRetry = job.attempts < job.maxAttempts;
  const backoffMs = Math.min(60_000 * 2 ** (job.attempts - 1), 15 * 60_000);

  if (willRetry) {
    await prisma.processingJob.update({
      where: { id: jobId },
      data: {
        stage: JobStage.queued,
        error: message.slice(0, 4000),
        lockedBy: null,
        lockedAt: null,
        runAfter: new Date(Date.now() + backoffMs),
      },
    });
  } else {
    await prisma.$transaction([
      prisma.processingJob.update({
        where: { id: jobId },
        data: {
          stage: JobStage.failed,
          error: message.slice(0, 4000),
          lockedBy: null,
          lockedAt: null,
          finishedAt: new Date(),
        },
      }),
      prisma.videoAsset.update({
        where: { id: videoId },
        data: { status: VideoStatus.failed, error: message.slice(0, 4000) },
      }),
    ]);
  }
  return { willRetry };
}

export async function getVideoStatus(videoId: string) {
  const video = await prisma.videoAsset.findUnique({
    where: { id: videoId },
    include: {
      jobs: { orderBy: { createdAt: "desc" }, take: 1 },
      _count: { select: { segments: true, frames: true } },
    },
  });
  if (!video) throw new NotFoundError(`No video with id ${videoId}.`);
  const job = video.jobs[0];

  return {
    videoId: video.id,
    status: video.status,
    stage: job?.stage ?? JobStage.queued,
    progressPercent: job?.progress ?? 0,
    stepsDone: job?.stepsDone ?? 0,
    stepsTotal: job?.stepsTotal ?? 8,
    attempts: job?.attempts ?? 0,
    maxAttempts: job?.maxAttempts ?? 3,
    error: job?.error ?? video.error ?? null,
    video: {
      title: video.title,
      sourceUrl: redactUrl(video.sourceUrl),
      mimeType: video.mimeType,
      fileSize: video.fileSize,
      durationSec: video.durationSec,
      width: video.width,
      height: video.height,
      fps: video.fps,
      language: video.language,
      extractVisuals: video.extractVisuals,
      transcriptSegments: video._count.segments,
      extractedFrames: video._count.frames,
    },
    createdAt: video.createdAt.toISOString(),
    updatedAt: (job?.updatedAt ?? video.updatedAt).toISOString(),
  };
}
