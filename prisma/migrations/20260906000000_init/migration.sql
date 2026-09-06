-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "VideoStatus" AS ENUM ('queued', 'processing', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "JobStage" AS ENUM ('queued', 'downloading', 'probing', 'extracting_audio', 'transcribing', 'extracting_frames', 'analyzing_frames', 'synthesizing', 'completed', 'failed');

-- CreateTable
CREATE TABLE "InsightsCache" (
    "key" TEXT NOT NULL,
    "numOfDays" INTEGER NOT NULL,
    "dimensions" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "fetchedAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "InsightsCache_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "InsightsSnapshot" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "numOfDays" INTEGER NOT NULL,
    "dimensions" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "fetchedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InsightsSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiCallLog" (
    "day" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ApiCallLog_pkey" PRIMARY KEY ("day")
);

-- CreateTable
CREATE TABLE "ClarityRecording" (
    "id" TEXT NOT NULL,
    "recordingUrl" TEXT,
    "sessionId" TEXT,
    "clarityUserId" TEXT,
    "startTime" TIMESTAMPTZ(3),
    "durationMs" INTEGER,
    "entryUrl" TEXT,
    "exitUrl" TEXT,
    "referrer" TEXT,
    "device" TEXT,
    "browser" TEXT,
    "os" TEXT,
    "country" TEXT,
    "pageCount" INTEGER,
    "clickCount" INTEGER,
    "rageClicks" INTEGER,
    "deadClicks" INTEGER,
    "scriptErrors" INTEGER,
    "dedupeKey" TEXT NOT NULL,
    "raw" JSONB NOT NULL,
    "importedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ClarityRecording_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VideoAsset" (
    "id" TEXT NOT NULL,
    "title" TEXT,
    "sourceUrl" TEXT,
    "storageKey" TEXT,
    "mimeType" TEXT,
    "fileSize" INTEGER,
    "durationSec" DOUBLE PRECISION,
    "width" INTEGER,
    "height" INTEGER,
    "fps" DOUBLE PRECISION,
    "language" TEXT,
    "analysisPrompt" TEXT,
    "extractVisuals" BOOLEAN NOT NULL DEFAULT true,
    "status" "VideoStatus" NOT NULL DEFAULT 'queued',
    "error" TEXT,
    "sttProvider" TEXT,
    "sttModel" TEXT,
    "visionProvider" TEXT,
    "visionModel" TEXT,
    "synthesisProvider" TEXT,
    "synthesisModel" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "VideoAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessingJob" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'video_analysis',
    "stage" "JobStage" NOT NULL DEFAULT 'queued',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "stepsDone" INTEGER NOT NULL DEFAULT 0,
    "stepsTotal" INTEGER NOT NULL DEFAULT 8,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "lockedBy" TEXT,
    "lockedAt" TIMESTAMPTZ(3),
    "runAfter" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMPTZ(3),
    "finishedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ProcessingJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TranscriptSegment" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "idx" INTEGER NOT NULL,
    "startMs" INTEGER NOT NULL,
    "endMs" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "speaker" TEXT,
    "confidence" DOUBLE PRECISION,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TranscriptSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtractedFrame" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "idx" INTEGER NOT NULL,
    "timestampMs" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "sceneChange" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "ocrText" TEXT,
    "objects" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExtractedFrame_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VideoAnalysis" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "executiveSummary" TEXT NOT NULL,
    "fullDescription" TEXT NOT NULL,
    "transcriptSummary" TEXT NOT NULL,
    "importantEvents" JSONB NOT NULL,
    "visibleText" JSONB NOT NULL,
    "detectedObjects" JSONB NOT NULL,
    "problems" JSONB NOT NULL,
    "recommendations" JSONB NOT NULL,
    "citations" JSONB NOT NULL,
    "compact" JSONB,
    "detailed" JSONB,
    "raw" JSONB,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "VideoAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InsightsSnapshot_key_fetchedAt_idx" ON "InsightsSnapshot"("key", "fetchedAt");

-- CreateIndex
CREATE INDEX "InsightsSnapshot_fetchedAt_idx" ON "InsightsSnapshot"("fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ClarityRecording_dedupeKey_key" ON "ClarityRecording"("dedupeKey");

-- CreateIndex
CREATE INDEX "ClarityRecording_startTime_idx" ON "ClarityRecording"("startTime");

-- CreateIndex
CREATE INDEX "ClarityRecording_entryUrl_idx" ON "ClarityRecording"("entryUrl");

-- CreateIndex
CREATE INDEX "ClarityRecording_exitUrl_idx" ON "ClarityRecording"("exitUrl");

-- CreateIndex
CREATE INDEX "ClarityRecording_device_idx" ON "ClarityRecording"("device");

-- CreateIndex
CREATE INDEX "ClarityRecording_browser_idx" ON "ClarityRecording"("browser");

-- CreateIndex
CREATE INDEX "ClarityRecording_country_idx" ON "ClarityRecording"("country");

-- CreateIndex
CREATE INDEX "ClarityRecording_sessionId_idx" ON "ClarityRecording"("sessionId");

-- CreateIndex
CREATE INDEX "VideoAsset_status_idx" ON "VideoAsset"("status");

-- CreateIndex
CREATE INDEX "VideoAsset_createdAt_idx" ON "VideoAsset"("createdAt");

-- CreateIndex
CREATE INDEX "ProcessingJob_stage_runAfter_idx" ON "ProcessingJob"("stage", "runAfter");

-- CreateIndex
CREATE INDEX "ProcessingJob_lockedAt_idx" ON "ProcessingJob"("lockedAt");

-- CreateIndex
CREATE INDEX "ProcessingJob_videoId_idx" ON "ProcessingJob"("videoId");

-- CreateIndex
CREATE INDEX "TranscriptSegment_videoId_startMs_idx" ON "TranscriptSegment"("videoId", "startMs");

-- CreateIndex
CREATE UNIQUE INDEX "TranscriptSegment_videoId_idx_key" ON "TranscriptSegment"("videoId", "idx");

-- CreateIndex
CREATE INDEX "ExtractedFrame_videoId_timestampMs_idx" ON "ExtractedFrame"("videoId", "timestampMs");

-- CreateIndex
CREATE UNIQUE INDEX "ExtractedFrame_videoId_idx_key" ON "ExtractedFrame"("videoId", "idx");

-- CreateIndex
CREATE UNIQUE INDEX "VideoAnalysis_videoId_key" ON "VideoAnalysis"("videoId");

-- AddForeignKey
ALTER TABLE "ProcessingJob" ADD CONSTRAINT "ProcessingJob_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "VideoAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TranscriptSegment" ADD CONSTRAINT "TranscriptSegment_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "VideoAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractedFrame" ADD CONSTRAINT "ExtractedFrame_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "VideoAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoAnalysis" ADD CONSTRAINT "VideoAnalysis_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "VideoAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

