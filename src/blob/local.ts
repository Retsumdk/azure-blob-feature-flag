import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BlobContents, BlobMeta, BlobStore, PutOptions } from "../types.js";
import { FeatureFlagError } from "../errors.js";
import { fnv1a32Hex } from "../hash.js";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".json": "application/json",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".md": "text/markdown",
  ".html": "text/html",
  ".xml": "application/xml",
  ".bin": "application/octet-stream",
};

export function contentTypeForExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "application/octet-stream";
  return CONTENT_TYPES[name.slice(dot).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Validates a blob key. Keys are slash-separated relative paths: no leading
 * slash, no empty segments, no "." or ".." traversal segments.
 *
 * Exported because the memory store applies the exact same key rules.
 */
export function sanitizeKey(key: string): string {
  if (key.length === 0 || key.startsWith("/") || key.endsWith("/")) {
    throw new FeatureFlagError("INVALID_KEY", `unsafe key: ${key}`, { blobKey: key });
  }
  for (const segment of key.split("/")) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      throw new FeatureFlagError("INVALID_KEY", `unsafe key: ${key}`, { blobKey: key });
    }
  }
  return key;
}

export class LocalBlobStore implements BlobStore {
  readonly root: string;

  constructor(root: string) {
    if (root.trim().length === 0) throw new FeatureFlagError("INVALID_KEY", "root directory must not be empty");
    this.root = root;
  }

  private path(key: string): string {
    return join(this.root, ...sanitizeKey(key).split("/"));
  }

  /** Validates a blob key against the shared key rules. */
  sanitizeKey(key: string): string {
    return sanitizeKey(key);
  }

  private metaFor(key: string, size: number, contentType: string, lastModified: string): BlobMeta {
    return {
      key,
      size,
      contentType,
      etag: `"${fnv1a32Hex(new TextEncoder().encode(key))}"`,
      lastModified,
    };
  }

  async put(key: string, data: Uint8Array, opts?: PutOptions): Promise<BlobMeta> {
    const target = this.path(key);
    await mkdir(join(target, ".."), { recursive: true });
    const tmp = `${target}.tmp-${Date.now().toString(36)}`;
    await writeFile(tmp, data);
    await rename(tmp, target);
    return {
      key,
      size: data.byteLength,
      contentType: opts?.contentType ?? contentTypeForExtension(key),
      etag: `"${fnv1a32Hex(data)}"`,
      lastModified: new Date().toISOString(),
    };
  }

  async get(key: string): Promise<BlobContents> {
    const target = this.path(key);
    let data: Buffer;
    try {
      data = await readFile(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new FeatureFlagError("NOT_FOUND", `blob not found: ${key}`, { blobKey: key, cause: err });
      }
      throw new FeatureFlagError("IO_ERROR", `read failed for ${key}`, { blobKey: key, cause: err });
    }
    let lastModified = new Date(0).toISOString();
    try {
      lastModified = (await stat(target)).mtime.toISOString();
    } catch {
      // a read that succeeded is not invalidated by a stat failure
    }
    return { data: new Uint8Array(data), meta: this.metaFor(key, data.length, contentTypeForExtension(key), lastModified) };
  }

  async exists(key: string): Promise<boolean> {
    try {
      return (await stat(this.path(key))).isFile();
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<boolean> {
    try {
      await rm(this.path(key));
      return true;
    } catch {
      return false;
    }
  }

  async list(prefix = ""): Promise<BlobMeta[]> {
    const out: BlobMeta[] = [];
    const walk = async (dir: string, rel: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const childRel = rel.length === 0 ? entry.name : `${rel}/${entry.name}`;
        const childPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(childPath, childRel);
        } else if (childRel.startsWith(prefix)) {
          const s = await stat(childPath);
          out.push(this.metaFor(childRel, s.size, contentTypeForExtension(childRel), s.mtime.toISOString()));
        }
      }
    };
    await walk(this.root, "");
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }
}
