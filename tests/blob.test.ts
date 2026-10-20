import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { MemoryBlobStore, LocalBlobStore, AzureBlobStore, createBlobStore, parseListBlobsXml, buildSharedKeyAuth, contentTypeForExtension, sanitizeKey } from "../src/blob/index.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("memory blob store", () => {
  let store: MemoryBlobStore;
  beforeEach(() => { store = new MemoryBlobStore(); });

  test("put/get roundtrip", async () => {
    await store.put("a/b.txt", new TextEncoder().encode("hello"), { contentType: "text/plain" });
    const got = await store.get("a/b.txt");
    expect(new TextDecoder().decode(got.data)).toBe("hello");
    expect(got.meta.contentType).toBe("text/plain");
  });

  test("get of missing key throws NOT_FOUND", async () => {
    expect(async () => await store.get("missing")).toThrow(/not found/);
  });

  test("list filters by prefix", async () => {
    await store.put("flags/a.json", new Uint8Array([1]));
    await store.put("flags/b.json", new Uint8Array([2]));
    await store.put("history/a.json", new Uint8Array([3]));
    const listed = await store.list("flags/");
    expect(listed.map((m) => m.key)).toEqual(["flags/a.json", "flags/b.json"]);
  });

  test("rejects traversal keys", async () => {
    expect(async () => await store.put("../escape", new Uint8Array([1]))).toThrow(/unsafe key/);
    expect(async () => await store.put("a//b", new Uint8Array([1]))).toThrow(/unsafe key/);
    expect(async () => await sanitizeKey("/lead")).toThrow(/unsafe key/);
  });

  test("delete removes and reports absence", async () => {
    await store.put("k", new Uint8Array([1]));
    expect(await store.delete("k")).toBe(true);
    expect(await store.delete("k")).toBe(false);
  });
});

describe("local blob store", () => {
  let root: string;
  let store: LocalBlobStore;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "abff-local-"));
    store = new LocalBlobStore(root);
  });
  afterEach(async () => { await rm(root, { recursive: true }); });

  test("roundtrip with correct content type", async () => {
    await store.put("x/y.json", new TextEncoder().encode("{}"));
    expect((await store.get("x/y.json")).meta.contentType).toBe("application/json");
    expect(contentTypeForExtension("x.md")).toBe("text/markdown");
    expect(contentTypeForExtension("noext")).toBe("application/octet-stream");
  });

  test("persists across instances", async () => {
    await store.put("persist.json", new TextEncoder().encode("v"));
    const again = new LocalBlobStore(root);
    expect(new TextDecoder().decode((await again.get("persist.json")).data)).toBe("v");
  });
});

describe("azure blob store (pure helpers)", () => {
  test("buildSharedKeyAuth produces a deterministic signature", () => {
    const url = { path: "/cont/flags/a.json", query: { comp: "list", restype: "container" } };
    const headers = { "x-ms-date": "Mon, 01 Jan 2024 00:00:00 GMT", "x-ms-version": "2023-11-03" };
    const auth = buildSharedKeyAuth("GET", url, headers, "acct", Buffer.from("key").toString("base64"));
    expect(auth.startsWith("SharedKey acct:")).toBe(true);
    const auth2 = buildSharedKeyAuth("GET", url, headers, "acct", Buffer.from("key").toString("base64"));
    expect(auth).toBe(auth2);
    const other = buildSharedKeyAuth("GET", url, headers, "acct", Buffer.from("other").toString("base64"));
    expect(other).not.toBe(auth);
  });

  test("parseListBlobsXml extracts blobs and continuation marker", () => {
    const xml = `<?xml?><EnumerationResults><Blobs>
      <Blob><Name>flags/a.json</Name><Content-Length>12</Content-Length><Etag>"e1"</Etag><Last-Modified>Mon, 01 Jan 2024</Last-Modified></Blob>
      <Blob><Name>flags/b.json</Name><Content-Length>5</Content-Length><Etag>"e2"</Etag><Last-Modified>Mon, 01 Jan 2024</Last-Modified></Blob>
      </Blobs><NextMarker>m2</NextMarker></EnumerationResults>`;
    const parsed = parseListBlobsXml(xml);
    expect(parsed.blobs.length).toBe(2);
    expect(parsed.blobs[0]).toEqual({ name: "flags/a.json", size: 12, etag: '"e1"', lastModified: "Mon, 01 Jan 2024" });
    expect(parsed.nextMarker).toBe("m2");
    expect(parseListBlobsXml("<EnumerationResults></EnumerationResults>").blobs).toEqual([]);
  });

  test("constructor validates configuration", () => {
    expect(() => new AzureBlobStore({ account: "", container: "c", key: "k" })).toThrow(/account/);
    expect(() => new AzureBlobStore({ account: "a", container: "c" })).toThrow(/account key or a SAS/);
    expect(() => new AzureBlobStore({ account: "a", container: "", key: "k" })).toThrow(/container/);
  });
});

describe("createBlobStore", () => {
  test("selects the right implementation", async () => {
    expect(await createBlobStore("memory://")).toBeInstanceOf(MemoryBlobStore);
    const root = await mkdtemp(join(tmpdir(), "abff-factory-"));
    expect(await createBlobStore(`file://${root}`)).toBeInstanceOf(LocalBlobStore);
    await rm(root, { recursive: true });
    const azure = await createBlobStore("azure://acct/cont?key=abc");
    expect(azure).toBeInstanceOf(AzureBlobStore);
  });

  test("rejects unknown schemes and bare azure URIs", async () => {
    expect(async () => await createBlobStore("s3://x")).toThrow(/unsupported blob store URI/);
    expect(async () => await createBlobStore("azure://acct/cont")).toThrow(/requires a/);
  });
});
