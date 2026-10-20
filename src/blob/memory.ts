import type { BlobContents, BlobMeta, BlobStore, PutOptions } from "../types.js";
import { FeatureFlagError } from "../errors.js";
import { fnv1a32Hex } from "../hash.js";
import { sanitizeKey } from "./local.js";

function metaFor(key: string, size: number, contentType: string): BlobMeta {
  return { key, size, contentType, etag: `"${fnv1a32Hex(new TextEncoder().encode(key))}"`, lastModified: new Date().toISOString() };
}

export class MemoryBlobStore implements BlobStore {
  private readonly blobs = new Map<string, { data: Uint8Array; contentType: string }>();

  async put(key: string, data: Uint8Array, opts?: PutOptions): Promise<BlobMeta> {
    sanitizeKey(key);
    this.blobs.set(key, { data: data.slice(), contentType: opts?.contentType ?? "application/octet-stream" });
    return metaFor(key, data.byteLength, opts?.contentType ?? "application/octet-stream");
  }

  async get(key: string): Promise<BlobContents> {
    sanitizeKey(key);
    const entry = this.blobs.get(key);
    if (entry === undefined) throw new FeatureFlagError("NOT_FOUND", `blob not found: ${key}`, { blobKey: key });
    return { data: entry.data.slice(), meta: metaFor(key, entry.data.byteLength, entry.contentType) };
  }

  async exists(key: string): Promise<boolean> {
    return this.blobs.has(key);
  }

  async delete(key: string): Promise<boolean> {
    return this.blobs.delete(key);
  }

  async list(prefix = ""): Promise<BlobMeta[]> {
    const out: BlobMeta[] = [];
    for (const key of [...this.blobs.keys()].sort()) {
      if (key.startsWith(prefix)) {
        const entry = this.blobs.get(key) as { data: Uint8Array; contentType: string };
        out.push(metaFor(key, entry.data.byteLength, entry.contentType));
      }
    }
    return out;
  }
}
