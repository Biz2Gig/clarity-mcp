/**
 * Thin wrappers around ffprobe / ffmpeg for validation, audio extraction and
 * bounded keyframe extraction. Binaries are resolved from FFMPEG_PATH /
 * FFPROBE_PATH (default `ffmpeg` / `ffprobe` on PATH). A missing binary
 * surfaces as an actionable error - never a silent fallback.
 */

import { execFile } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { config } from "../config.server";
import { AppError } from "../errors";

const run = promisify(execFile);
const BIG = 64 * 1024 * 1024; // 64 MiB stdout/stderr buffer

export class FfmpegError extends AppError {
  constructor(message: string, details?: unknown) {
    super("ffmpeg_error", message, 500, details);
  }
}

async function exec(bin: string, args: string[], timeoutMs = 15 * 60_000) {
  try {
    return await run(bin, args, { maxBuffer: BIG, timeout: timeoutMs });
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === "ENOENT") {
      throw new FfmpegError(
        `Could not execute "${bin}". Install FFmpeg or set ${
          bin === config.ffmpegPath ? "FFMPEG_PATH" : "FFPROBE_PATH"
        }.`,
      );
    }
    throw new FfmpegError(
      `${bin} failed: ${err.message}`,
      err.stderr?.slice(-2000),
    );
  }
}

export interface MediaInfo {
  durationSec: number;
  formatName: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  fps?: number;
  videoCodec?: string;
  hasAudio: boolean;
  audioCodec?: string;
}

function parseFps(rate: string | undefined): number | undefined {
  if (!rate) return undefined;
  const [n, d] = rate.split("/").map(Number);
  if (!n || !d) return undefined;
  return Math.round((n / d) * 1000) / 1000;
}

export async function probe(inputPath: string): Promise<MediaInfo> {
  const { stdout } = await exec(config.ffprobePath, [
    "-v",
    "quiet",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    inputPath,
  ]);

  let json: any;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new FfmpegError("ffprobe returned unparseable output.");
  }

  const streams: any[] = json.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  const durationSec =
    Number(json.format?.duration) ||
    Number(video?.duration) ||
    Number(audio?.duration) ||
    0;

  if (!durationSec || durationSec <= 0) {
    throw new FfmpegError("Could not determine a positive media duration.");
  }

  return {
    durationSec,
    formatName: json.format?.format_name ?? "unknown",
    sizeBytes: Number(json.format?.size) || 0,
    width: video ? Number(video.width) || undefined : undefined,
    height: video ? Number(video.height) || undefined : undefined,
    fps: parseFps(video?.r_frame_rate),
    videoCodec: video?.codec_name,
    hasAudio: Boolean(audio),
    audioCodec: audio?.codec_name,
  };
}

/** Extract mono 16 kHz PCM WAV suitable for speech-to-text. */
export async function extractAudio(
  inputPath: string,
  outWavPath: string,
): Promise<string> {
  await mkdir(path.dirname(outWavPath), { recursive: true });
  await exec(config.ffmpegPath, [
    "-y",
    "-i",
    inputPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    outWavPath,
  ]);
  return outWavPath;
}

export interface Keyframe {
  index: number;
  timestampMs: number;
  path: string;
  sceneChange: boolean;
}

export interface KeyframeOptions {
  outDir: string;
  durationSec: number;
  intervalSec?: number;
  maxFrames?: number;
  sceneThreshold?: number;
}

/**
 * Bounded keyframe extraction: a scene-change selector combined with a forced
 * maximum interval. The interval is widened automatically so the forced pass
 * alone can never exceed `maxFrames`; a hard `-frames:v` ceiling is also set.
 * Timestamps come from ffmpeg's `showinfo` (`pts_time`) in output order.
 */
export async function extractKeyframes(
  inputPath: string,
  opts: KeyframeOptions,
): Promise<Keyframe[]> {
  const maxFrames = Math.max(1, opts.maxFrames ?? config.videoMaxKeyframes);
  const baseInterval = Math.max(
    1,
    opts.intervalSec ?? config.videoKeyframeIntervalSec,
  );
  const sceneThreshold = opts.sceneThreshold ?? config.videoSceneThreshold;
  const effectiveInterval = Math.max(
    baseInterval,
    Math.ceil(opts.durationSec / maxFrames),
  );

  await mkdir(opts.outDir, { recursive: true });
  const pattern = path.join(opts.outDir, "frame_%05d.jpg");

  const select =
    `eq(n\\,0)+gt(scene\\,${sceneThreshold})+` +
    `gte(t-prev_selected_t\\,${effectiveInterval})`;

  const { stderr } = await exec(config.ffmpegPath, [
    "-y",
    "-i",
    inputPath,
    "-vf",
    `select='${select}',showinfo`,
    "-vsync",
    "vfr",
    "-q:v",
    "3",
    "-frames:v",
    String(maxFrames),
    pattern,
  ]);

  // showinfo prints one line per emitted frame with `pts_time:<seconds>`.
  const times: number[] = [];
  const scenes: boolean[] = [];
  const re = /n:\s*(\d+).*?pts_time:\s*([0-9.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stderr)) !== null) {
    times.push(Math.round(Number(m[2]) * 1000));
  }
  // Best-effort scene flag: showinfo doesn't expose the selector result, so
  // mark frames that are not on the regular interval grid as scene changes.
  for (let i = 0; i < times.length; i++) {
    const onGrid =
      Math.abs(
        (times[i] / 1000) % effectiveInterval,
      ) < 0.75 || i === 0;
    scenes.push(!onGrid);
  }

  const files = (await readdir(opts.outDir))
    .filter((f) => /^frame_\d+\.jpg$/.test(f))
    .sort();

  const frames: Keyframe[] = [];
  for (let i = 0; i < files.length; i++) {
    frames.push({
      index: i,
      timestampMs: times[i] ?? Math.round(i * effectiveInterval * 1000),
      path: path.join(opts.outDir, files[i]),
      sceneChange: scenes[i] ?? false,
    });
  }
  return frames;
}

/** Verify ffmpeg + ffprobe are runnable. Throws FfmpegError if not. */
export async function assertFfmpegAvailable(): Promise<void> {
  await exec(config.ffprobePath, ["-version"], 15_000);
  await exec(config.ffmpegPath, ["-version"], 15_000);
}
