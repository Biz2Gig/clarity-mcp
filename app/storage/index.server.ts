import { config } from "../config.server";
import { ConfigurationError } from "../errors";
import { FilesystemStorage } from "./filesystem.server";
import type { StorageProvider } from "./types";

export type { StorageProvider } from "./types";

let cached: StorageProvider | undefined;

export function getStorage(): StorageProvider {
  if (cached) return cached;
  switch (config.storageDriver) {
    case "filesystem":
      cached = new FilesystemStorage(config.storageDir);
      return cached;
    // case "s3": return new S3Storage(...)  // future
    default:
      throw new ConfigurationError(
        `Unknown STORAGE_DRIVER "${config.storageDriver}" (supported: filesystem).`,
      );
  }
}

/** Test hook. */
export function __setStorage(s: StorageProvider | undefined): void {
  cached = s;
}

export function videoSourceKey(videoId: string, filename: string): string {
  return `videos/${videoId}/source/${filename}`;
}

export function frameKey(videoId: string, index: number): string {
  return `videos/${videoId}/frames/frame_${String(index).padStart(5, "0")}.jpg`;
}
