/**
 * Timestamp helpers for video transcripts and frames. Pure functions - no I/O.
 * The canonical internal unit is integer milliseconds.
 */

import { ValidationError } from "../errors";

/** Format milliseconds as `HH:MM:SS.mmm` (hours grow past 99 if needed). */
export function msToTimecode(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new ValidationError(`Invalid millisecond value: ${ms}`);
  }
  const total = Math.round(ms);
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const millis = total % 1000;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(millis, 3)}`;
}

/** Format milliseconds as compact `H:MM:SS` (or `M:SS` under an hour). */
export function msToShortTimecode(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

const CLOCK_RE = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/;
const UNIT_RE = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/;

/**
 * Parse a timestamp into integer milliseconds. Accepts:
 *   - a number (seconds) or numeric string: `12`, `12.5`
 *   - a clock string: `SS`, `MM:SS`, `HH:MM:SS`, `HH:MM:SS.mmm`, comma decimals
 *   - a unit string: `1h2m3s`, `90s`, `2m`
 *   - a trailing `ms` suffix: `1500ms`
 */
export function parseTimestampToMs(input: number | string): number {
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 0) {
      throw new ValidationError(`Invalid timestamp: ${input}`);
    }
    return Math.round(input * 1000);
  }

  const raw = input.trim().toLowerCase();
  if (raw === "") throw new ValidationError("Empty timestamp");

  if (raw.endsWith("ms")) {
    const n = Number(raw.slice(0, -2));
    if (!Number.isFinite(n) || n < 0) {
      throw new ValidationError(`Invalid timestamp: ${input}`);
    }
    return Math.round(n);
  }

  if (/^\d+(\.\d+)?$/.test(raw)) {
    return Math.round(Number(raw) * 1000);
  }

  const clock = CLOCK_RE.exec(raw);
  if (clock) {
    const [, h, m, s, frac] = clock;
    const hours = h ? Number(h) : 0;
    const minutes = Number(m);
    const seconds = Number(s);
    if (minutes > 59 || seconds > 59) {
      throw new ValidationError(`Invalid clock timestamp: ${input}`);
    }
    const millis = frac ? Number(frac.padEnd(3, "0")) : 0;
    return (
      hours * 3_600_000 + minutes * 60_000 + seconds * 1000 + millis
    );
  }

  const unit = UNIT_RE.exec(raw);
  if (unit && (unit[1] || unit[2] || unit[3])) {
    const [, h, m, s] = unit;
    return Math.round(
      (Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0)) * 1000,
    );
  }

  throw new ValidationError(`Unrecognized timestamp format: ${input}`);
}

export interface FrameLike {
  timestampMs: number;
}

/**
 * Return the frame whose timestamp is closest to `targetMs`. Ties resolve to
 * the earlier frame. Returns `undefined` for an empty list.
 */
export function nearestFrame<T extends FrameLike>(
  frames: readonly T[],
  targetMs: number,
): T | undefined {
  if (frames.length === 0) return undefined;
  let best = frames[0];
  let bestDelta = Math.abs(best.timestampMs - targetMs);
  for (let i = 1; i < frames.length; i++) {
    const delta = Math.abs(frames[i].timestampMs - targetMs);
    if (delta < bestDelta) {
      best = frames[i];
      bestDelta = delta;
    }
  }
  return best;
}

/** Clamp a [start,end] millisecond window to `[0, durationMs]`, start <= end. */
export function clampWindow(
  startMs: number | undefined,
  endMs: number | undefined,
  durationMs: number,
): { startMs: number; endMs: number } {
  const s = Math.max(0, Math.min(startMs ?? 0, durationMs));
  const e = Math.max(s, Math.min(endMs ?? durationMs, durationMs));
  return { startMs: s, endMs: e };
}
