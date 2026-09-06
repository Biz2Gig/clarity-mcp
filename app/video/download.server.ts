/**
 * Hardened downloader for remotely supplied URLs. Applies the SSRF policy on
 * the initial URL and again after every redirect, enforces byte and time
 * limits, validates the response content type, streams to a sanitized temp
 * file, and never logs credentials.
 */

import { createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { config } from "../config.server";
import { SecurityError } from "../errors";
import { assertSafeUrl, sanitizeFilename } from "./ssrf";

export type DownloadKind = "video" | "csv";

const VIDEO_MIME_ALLOW = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-matroska",
  "video/mpeg",
  "video/x-msvideo",
  "video/3gpp",
  "video/ogg",
  "application/mp4",
  "application/octet-stream",
  "binary/octet-stream",
  "",
]);

const CSV_MIME_ALLOW = new Set([
  "text/csv",
  "application/csv",
  "text/plain",
  "application/vnd.ms-excel",
  "application/octet-stream",
  "",
]);

export interface DownloadResult {
  path: string;
  bytes: number;
  contentType: string;
  filename: string;
  finalUrl: string;
  /** Call to remove the temp file (and its parent dir if empty). */
  cleanup: () => Promise<void>;
}

export interface DownloadOptions {
  kind: DownloadKind;
  maxBytes?: number;
  allowInsecure?: boolean;
  /** DNS override for tests. */
  resolve?: (hostname: string) => Promise<string[]>;
  /** fetch override for tests. */
  fetchImpl?: typeof fetch;
}

function mimeAllowed(kind: DownloadKind, ct: string): boolean {
  const base = ct.split(";")[0]!.trim().toLowerCase();
  return (kind === "video" ? VIDEO_MIME_ALLOW : CSV_MIME_ALLOW).has(base);
}

export async function downloadToTempFile(
  rawUrl: string,
  opts: DownloadOptions,
): Promise<DownloadResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const allowInsecure = opts.allowInsecure ?? config.allowInsecureUrls;
  const maxBytes =
    opts.maxBytes ??
    (opts.kind === "video" ? config.videoMaxBytes : config.clarityCsvMaxBytes);
  const maxRedirects = config.downloadMaxRedirects;

  const totalController = new AbortController();
  const totalTimer = setTimeout(
    () => totalController.abort(new Error("total download timeout")),
    config.downloadTotalTimeoutMs,
  );

  let currentUrl = rawUrl;
  let response: Response | undefined;

  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      // Re-validate on every hop (defends against redirect-to-internal SSRF).
      const { url } = await assertSafeUrl(currentUrl, {
        allowInsecure,
        resolve: opts.resolve,
      });

      const connectController = new AbortController();
      const connectTimer = setTimeout(
        () => connectController.abort(new Error("connect timeout")),
        config.downloadConnectTimeoutMs,
      );
      const signal = AbortSignal.any([
        totalController.signal,
        connectController.signal,
      ]);

      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: "GET",
          redirect: "manual",
          signal,
          headers: {
            accept:
              opts.kind === "video"
                ? "video/*,application/octet-stream;q=0.9,*/*;q=0.1"
                : "text/csv,text/plain;q=0.9,*/*;q=0.1",
            "user-agent": "clarity-mcp/1.0 (+video-ingest)",
          },
        });
      } finally {
        clearTimeout(connectTimer);
      }

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) {
          throw new SecurityError(
            `Redirect (${res.status}) without a Location header.`,
          );
        }
        if (hop === maxRedirects) {
          throw new SecurityError(
            `Too many redirects (limit ${maxRedirects}).`,
          );
        }
        currentUrl = new URL(location, url).toString();
        // discard body and continue
        await res.body?.cancel().catch(() => {});
        continue;
      }

      if (!res.ok) {
        throw new SecurityError(
          `Upstream returned HTTP ${res.status} for the supplied URL.`,
        );
      }

      response = res;
      currentUrl = url.toString();
      break;
    }

    if (!response) {
      throw new SecurityError("Download failed: no final response.");
    }

    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    if (!mimeAllowed(opts.kind, contentType)) {
      throw new SecurityError(
        `Response Content-Type "${contentType}" is not an allowed ${opts.kind} type.`,
      );
    }

    const declaredLength = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new SecurityError(
        `Declared size ${declaredLength} exceeds limit ${maxBytes}.`,
      );
    }

    const dir = path.join(os.tmpdir(), "clarity-mcp", randomUUID());
    await mkdir(dir, { recursive: true });
    const filename = sanitizeFilename(
      new URL(currentUrl).pathname,
      opts.kind === "video" ? "video.bin" : "recordings.csv",
    );
    const filePath = path.join(dir, filename);

    const cleanup = async () => {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    };

    if (!response.body) {
      await cleanup();
      throw new SecurityError("Upstream response had no body.");
    }

    const sink = createWriteStream(filePath);
    let received = 0;
    try {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new SecurityError(
            `Download exceeded the ${maxBytes}-byte limit.`,
          );
        }
        await new Promise<void>((resolve, reject) => {
          sink.write(Buffer.from(value), (err) => (err ? reject(err) : resolve()));
        });
      }
      await new Promise<void>((resolve, reject) =>
        sink.end((err?: Error | null) => (err ? reject(err) : resolve())),
      );
    } catch (e) {
      sink.destroy();
      await cleanup();
      throw e;
    }

    const finalStat = await stat(filePath);
    return {
      path: filePath,
      bytes: finalStat.size,
      contentType,
      filename,
      finalUrl: currentUrl,
      cleanup,
    };
  } finally {
    clearTimeout(totalTimer);
  }
}
