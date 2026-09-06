import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

let ffmpegChecked = false;
let ffmpegOk = false;

export async function hasFfmpeg(): Promise<boolean> {
  if (ffmpegChecked) return ffmpegOk;
  ffmpegChecked = true;
  try {
    await run(FFMPEG, ["-version"]);
    await run(FFPROBE, ["-version"]);
    ffmpegOk = true;
  } catch {
    ffmpegOk = false;
  }
  return ffmpegOk;
}

/**
 * Generate a tiny synthetic MP4 (colour bars + tone) so tests never commit a
 * binary fixture. Returns the file path, or null if ffmpeg is unavailable.
 */
export async function makeSyntheticVideo(seconds = 3): Promise<string | null> {
  if (!(await hasFfmpeg())) return null;
  const dir = await mkdtemp(path.join(os.tmpdir(), "clarity-mcp-testvid-"));
  const out = path.join(dir, "sample.mp4");
  await run(FFMPEG, [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc=duration=${seconds}:size=320x240:rate=10`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=440:duration=${seconds}`,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    out,
  ]);
  return out;
}
