/**
 * Test environment defaults. Real secrets are never required: provider calls
 * are mocked and the Clarity/OpenAI endpoints are never contacted.
 *
 * Database-backed suites run only when TEST_DATABASE_URL points at a reachable
 * Postgres (see tests/helpers/db.ts). Everything else runs with no services.
 */

process.env.NODE_ENV = "test";
process.env.TZ = "UTC";

process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://clarity:clarity@localhost:5432/clarity_mcp_test?schema=public";

process.env.MCP_BRIDGE_SECRET ??= "test-secret";
process.env.CLARITY_API_TOKEN ??= "test-clarity-token";
process.env.PROVIDERS_ALLOW_MOCK ??= "true";
process.env.STT_PROVIDER ??= "mock";
process.env.VISION_PROVIDER ??= "mock";
process.env.SYNTHESIS_PROVIDER ??= "mock";
process.env.ALLOW_INSECURE_URLS ??= "false";

// Use the bundled static ffmpeg/ffprobe (devDependencies) for the pipeline
// test when the OS doesn't have them on PATH.
try {
  if (!process.env.FFMPEG_PATH) {
    const { createRequire } = await import("node:module");
    const req = createRequire(import.meta.url);
    process.env.FFMPEG_PATH = req("ffmpeg-static") as string;
    process.env.FFPROBE_PATH = (
      req("ffprobe-static") as { path: string }
    ).path;
  }
} catch {
  // static binaries not installed - pipeline test will self-skip
}
