/**
 * Storage abstraction. The filesystem implementation is the only one shipped
 * today; the interface is intentionally S3-compatible so an object-store
 * driver can be added without touching callers.
 */

export interface PutOptions {
  contentType?: string;
}

export interface StorageProvider {
  readonly driver: string;
  /** Persist bytes (or a file on disk) under `key`. Keys use `/` separators. */
  put(key: string, data: Buffer | string, opts?: PutOptions): Promise<void>;
  putFile(key: string, sourcePath: string, opts?: PutOptions): Promise<void>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  /** Remove every object under a `prefix/`. */
  deletePrefix(prefix: string): Promise<void>;
}

const KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,240}$/;

/** Reject path traversal and absolute keys. */
export function assertValidKey(key: string): void {
  if (!KEY_RE.test(key) || key.includes("..") || key.includes("//")) {
    throw new Error(`Invalid storage key: ${JSON.stringify(key)}`);
  }
}
