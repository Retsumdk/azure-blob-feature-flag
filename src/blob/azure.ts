import { createHmac } from "node:crypto";
import type { BlobContents, BlobMeta, BlobStore, PutOptions } from "../types.js";
import { FeatureFlagError } from "../errors.js";

export interface AzureBlobConfig {
  readonly account: string;
  readonly container: string;
  /** Storage account shared key (base64). Required unless a sasToken is given. */
  readonly key?: string;
  /** SAS token beginning with "?". Used instead of SharedKey signing when present. */
  readonly sasToken?: string;
  /** Override for Azurite / sovereign clouds. Default: https://${account}.blob.core.windows.net */
  readonly endpoint?: string;
}

const HEADER_NAMES = [
  "content-encoding",
  "content-language",
  "content-length",
  "content-md5",
  "content-type",
  "if-modified-since",
  "if-match",
  "if-none-match",
  "if-unmodified-since",
  "range",
] as const;

/**
 * Builds the string-to-sign for Azure Storage SharedKey authorization and
 * returns the "SharedKey account:signature" header value. Pure and unit-testable.
 */
export function buildSharedKeyAuth(
  method: string,
  url: { readonly path: string; readonly query: Readonly<Record<string, string>> },
  headers: Readonly<Record<string, string>>,
  account: string,
  accountKey: string,
): string {
  const canonicalHeaders: string[] = [];
  for (const name of Object.keys(headers)
    .map((h) => h.toLowerCase())
    .filter((h) => h.startsWith("x-ms-"))
    .sort()) {
    canonicalHeaders.push(`${name}:${headers[name] ?? headers[name.toUpperCase()] ?? ""}`);
  }

  const headerLines = HEADER_NAMES.map((name) => {
    const value = headers[name] ?? headers[name.toUpperCase()] ?? "";
    return name === "content-length" && value === "0" ? "" : value;
  });

  const queryParts = Object.keys(url.query)
    .map((k) => k.toLowerCase())
    .sort()
    .map((k) => {
      const value = url.query[Object.keys(url.query).find((orig) => orig.toLowerCase() === k) ?? k] ?? "";
      return `\n${k}:${decodeURIComponent(value)}`;
    });

  const stringToSign = [
    method.toUpperCase(),
    ...headerLines,
    ...canonicalHeaders,
    `/${account}${url.path}${queryParts.join("")}`,
  ].join("\n");

  const signature = createHmac("sha256", Buffer.from(accountKey, "base64")).update(stringToSign, "utf8").digest("base64");
  return `SharedKey ${account}:${signature}`;
}

export interface ListedBlob {
  readonly name: string;
  readonly size: number;
  readonly etag: string;
  readonly lastModified: string;
}

export interface ListBlobsResult {
  readonly blobs: readonly ListedBlob[];
  readonly nextMarker?: string;
}

/** Minimal parser for the List Blobs XML response. Pure and unit-testable. */
export function parseListBlobsXml(xml: string): ListBlobsResult {
  const blobs: ListedBlob[] = [];
  const blobRegex = /<Blob>([\s\S]*?)<\/Blob>/g;
  let match: RegExpExecArray | null;
  while ((match = blobRegex.exec(xml)) !== null) {
    const body = match[1] ?? "";
    const name = /<Name>([\s\S]*?)<\/Name>/.exec(body)?.[1] ?? "";
    const size = Number(/<Content-Length>([\s\S]*?)<\/Content-Length>/.exec(body)?.[1] ?? "0");
    const etag = /<Etag>([\s\S]*?)<\/Etag>/.exec(body)?.[1] ?? "";
    const lastModified = /<Last-Modified>([\s\S]*?)<\/Last-Modified>/.exec(body)?.[1] ?? "";
    blobs.push({ name, size, etag, lastModified });
  }
  const nextMarker = /<NextMarker>([\s\S]*?)<\/NextMarker>/.exec(xml)?.[1];
  return nextMarker && nextMarker.length > 0 ? { blobs, nextMarker } : { blobs };
}

export class AzureBlobStore implements BlobStore {
  private readonly cfg: AzureBlobConfig;
  private readonly baseUrl: string;

  constructor(cfg: AzureBlobConfig) {
    if (cfg.account.length === 0) throw new FeatureFlagError("VALIDATION", "account is required");
    if (cfg.container.length === 0) throw new FeatureFlagError("VALIDATION", "container is required");
    if (!cfg.key && !cfg.sasToken) {
      throw new FeatureFlagError("VALIDATION", "either a storage account key or a SAS token is required");
    }
    this.cfg = cfg;
    this.baseUrl = cfg.endpoint ?? `https://${cfg.account}.blob.core.windows.net`;
  }

  private urlFor(key: string, query?: Record<string, string>): URL {
    const url = new URL(`${this.baseUrl}/${this.cfg.container}/${key.split("/").map(encodeURIComponent).join("/")}`);
    if (this.cfg.sasToken) {
      const sas = this.cfg.sasToken.startsWith("?") ? this.cfg.sasToken.slice(1) : this.cfg.sasToken;
      for (const [k, v] of new URLSearchParams(sas)) url.searchParams.set(k, v);
    }
    if (query) {
      for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    }
    return url;
  }

  private authHeaders(method: string, url: URL, headers: Record<string, string>): Record<string, string> {
    const date = new Date().toUTCString();
    const all: Record<string, string> = { ...headers, "x-ms-date": date, "x-ms-version": "2023-11-03" };
    if (this.cfg.key && !this.cfg.sasToken) {
      const path = url.pathname;
      const query: Record<string, string> = {};
      for (const [k, v] of url.searchParams) query[k] = v;
      all.authorization = buildSharedKeyAuth(method, { path, query }, all, this.cfg.account, this.cfg.key);
    }
    return all;
  }

  private async request(method: string, url: URL, headers: Record<string, string>, body?: Uint8Array): Promise<Response> {
    const res = await fetch(url, {
      method,
      headers: this.authHeaders(method, url, headers),
      body: body === undefined ? undefined : Buffer.from(body),
    });
    if (res.status === 404) throw new FeatureFlagError("NOT_FOUND", `blob not found: ${decodeURIComponent(url.pathname)}`);
    if (res.status === 401) throw new FeatureFlagError("AUTH", "azure storage rejected the authorization");
    if (res.status === 409) throw new FeatureFlagError("CONFLICT", "blob conflict (lease or pending copy)");
    if (res.status >= 400) {
      throw new FeatureFlagError("STORAGE", `azure storage request failed with status ${res.status}`, { retriable: res.status >= 500 });
    }
    return res;
  }

  async put(key: string, data: Uint8Array, opts?: PutOptions): Promise<BlobMeta> {
    const url = this.urlFor(key);
    const contentType = opts?.contentType ?? "application/octet-stream";
    const res = await this.request("PUT", url, {
      "x-ms-blob-type": "BlockBlob",
      "content-type": contentType,
      "content-length": String(data.length),
      ...(opts?.metadata === undefined ? {} : Object.fromEntries(Object.entries(opts.metadata).map(([k, v]) => [`x-ms-meta-${k}`, v]))),
    }, data);
    return {
      key,
      size: data.length,
      contentType,
      etag: res.headers.get("etag") ?? '""',
      lastModified: res.headers.get("last-modified") ?? new Date().toUTCString(),
    };
  }

  async get(key: string): Promise<BlobContents> {
    const res = await this.request("GET", this.urlFor(key), {});
    const buf = new Uint8Array(await res.arrayBuffer());
    return {
      data: buf,
      meta: {
        key,
        size: buf.length,
        contentType: res.headers.get("content-type") ?? "application/octet-stream",
        etag: res.headers.get("etag") ?? '""',
        lastModified: res.headers.get("last-modified") ?? new Date().toUTCString(),
      },
    };
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.request("HEAD", this.urlFor(key), {});
      return true;
    } catch (err) {
      if (err instanceof FeatureFlagError && err.code === "NOT_FOUND") return false;
      throw err;
    }
  }

  async delete(key: string): Promise<boolean> {
    try {
      await this.request("DELETE", this.urlFor(key), { "x-ms-delete-snapshots": "include" });
      return true;
    } catch (err) {
      if (err instanceof FeatureFlagError && err.code === "NOT_FOUND") return false;
      throw err;
    }
  }

  async list(prefix?: string): Promise<BlobMeta[]> {
    const out: BlobMeta[] = [];
    let marker: string | undefined;
    do {
      const query: Record<string, string> = { restype: "container", comp: "list" };
      if (prefix !== undefined) query.prefix = prefix;
      if (marker !== undefined) query.marker = marker;
      const res = await this.request("GET", this.urlFor("", query), {});
      const parsed = parseListBlobsXml(await res.text());
      for (const b of parsed.blobs) {
        out.push({ key: b.name, size: b.size, contentType: "application/json", etag: b.etag, lastModified: b.lastModified });
      }
      marker = parsed.nextMarker;
    } while (marker !== undefined);
    return out;
  }
}
