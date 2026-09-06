import { describe } from "vitest";

import prisma from "../../app/db.server";

/**
 * DB-backed suites run only when TEST_DATABASE_URL is set (CI / Docker).
 * Locally, without Postgres, they are skipped with a visible notice rather
 * than failing.
 */
export const HAS_DB = Boolean(process.env.TEST_DATABASE_URL);

export const describeDb: typeof describe = HAS_DB
  ? describe
  : (describe.skip as typeof describe);

if (!HAS_DB) {
  // eslint-disable-next-line no-console
  console.warn(
    "[tests] TEST_DATABASE_URL not set - skipping database-backed suites " +
      "(quota reservation, stale cache, job state, transcript pagination, pipeline).",
  );
}

const TABLES = [
  "VideoAnalysis",
  "ExtractedFrame",
  "TranscriptSegment",
  "ProcessingJob",
  "VideoAsset",
  "ClarityRecording",
  "InsightsSnapshot",
  "InsightsCache",
  "ApiCallLog",
];

export async function resetDb(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`,
  );
}

export { prisma };
