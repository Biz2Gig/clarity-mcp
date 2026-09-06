import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { assertValidKey, type PutOptions, type StorageProvider } from "./types";

/**
 * Persists objects under a single root directory. In Docker this directory is
 * a mounted volume (STORAGE_DIR, e.g. /data/storage) so data survives
 * container restarts.
 */
export class FilesystemStorage implements StorageProvider {
  readonly driver = "filesystem";
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private resolve(key: string): string {
    assertValidKey(key);
    const full = path.resolve(this.root, key);
    if (full !== this.root && !full.startsWith(this.root + path.sep)) {
      throw new Error(`Storage key escapes root: ${key}`);
    }
    return full;
  }

  async put(key: string, data: Buffer | string, _opts?: PutOptions): Promise<void> {
    const full = this.resolve(key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, data);
  }

  async putFile(key: string, sourcePath: string, _opts?: PutOptions): Promise<void> {
    const full = this.resolve(key);
    await mkdir(path.dirname(full), { recursive: true });
    await pipeline(createReadStream(sourcePath), createWriteStream(full));
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.resolve(key));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await access(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }

  async deletePrefix(prefix: string): Promise<void> {
    const full = this.resolve(prefix);
    await rm(full, { recursive: true, force: true });
  }
}
