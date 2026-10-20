import type { BlobStore } from "../types.js";
import { FeatureFlagError } from "../errors.js";
import { MemoryBlobStore } from "./memory.js";
import { LocalBlobStore } from "./local.js";
import { AzureBlobStore } from "./azure.js";

export type { BlobStore } from "../types.js";
export { MemoryBlobStore } from "./memory.js";
export { LocalBlobStore, contentTypeForExtension, sanitizeKey } from "./local.js";
export { AzureBlobStore, buildSharedKeyAuth, parseListBlobsXml } from "./azure.js";

/**
 * Builds a blob store from a URI.
 *
 * Supported schemes:
 * - `memory://` — in-memory store (tests, demos)
 * - `file://<root>` — local filesystem store (atomic writes, etags)
 * - `azure://<account>/<container>?key=<base64-key>` — real Azure Storage
 *   (SharedKey auth). Query alternatives: `sas=<token>`; optional
 *   `endpoint=<url>` for Azurite or sovereign clouds.
 */
export function createBlobStore(uri: string): BlobStore {
  if (uri === "memory://") return new MemoryBlobStore();
  if (uri.startsWith("file://")) {
    return new LocalBlobStore(uri.slice("file://".length));
  }
  if (uri.startsWith("azure://")) {
    const url = new URL(uri);
    const account = url.host;
    const container = url.pathname.replace(/^\//, "").split("/")[0] ?? "";
    const query: Record<string, string> = {};
    for (const [k, v] of url.searchParams) query[k] = v;
    const key = query.key;
    const sasToken = query.sas;
    if (key === undefined && sasToken === undefined) {
      throw new FeatureFlagError("VALIDATION", 'azure:// URI requires a "key" or "sas" query parameter');
    }
    if (account.length === 0 || container.length === 0) {
      throw new FeatureFlagError("VALIDATION", 'azure:// URI must be "azure://<account>/<container>?key=..."');
    }
    return new AzureBlobStore({
      account,
      container,
      ...(key === undefined ? {} : { key }),
      ...(sasToken === undefined ? {} : { sasToken }),
      ...(query.endpoint === undefined ? {} : { endpoint: query.endpoint }),
    });
  }
  throw new FeatureFlagError("VALIDATION", `unsupported blob store URI "${uri}" (expected memory://, file://, or azure://)`);
}
