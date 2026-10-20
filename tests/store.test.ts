import { describe, test, expect, beforeEach } from "bun:test";
import { FlagStore } from "../src/flags/store.js";
import { MemoryBlobStore } from "../src/blob/index.js";
import type { FlagDefinition } from "../src/types.js";

const def = (key: string, overrides: Partial<FlagDefinition> = {}): FlagDefinition => ({
  key,
  description: "",
  enabled: true,
  rollout: 0,
  ...overrides,
});

describe("flag store", () => {
  let blobs: MemoryBlobStore;
  let store: FlagStore;
  beforeEach(() => {
    blobs = new MemoryBlobStore();
    store = new FlagStore(blobs, "flags", "history", "audit");
  });

  test("put stores a definition and returns version 1", async () => {
    const record = await store.put(def("a.b"), { actor: "t" });
    expect(record.version).toBe(1);
    expect(record.definition.key).toBe("a.b");
  });

  test("list returns all flags sorted by key", async () => {
    await store.put(def("c"), { actor: "t" });
    await store.put(def("a"), { actor: "t" });
    await store.put(def("b"), { actor: "t" });
    expect((await store.list()).map((r) => r.definition.key)).toEqual(["a", "b", "c"]);
  });

  test("get returns null for a missing flag", async () => {
    expect(await store.get("missing")).toBeNull();
  });

  test("history records every revision", async () => {
    await store.put(def("a"), { actor: "one" });
    await store.put(def("a", { rollout: 50 }), { actor: "two" });
    await store.put(def("a", { rollout: 100 }), { actor: "three" });
    const history = await store.history("a");
    expect(history.length).toBe(3);
    expect(history[0]?.version).toBe(1);
    expect(history[2]?.definition.rollout).toBe(100);
  });

  test("history of a missing flag is empty", async () => {
    expect(await store.history("nope")).toEqual([]);
  });

  test("rollback without a target reverts to the previous version", async () => {
    await store.put(def("a"), { actor: "t" });
    const v2 = await store.put(def("a", { rollout: 75 }), { actor: "t" });
    const rolled = await store.rollback("a", { actor: "t" });
    expect(rolled.version).toBe(v2.version + 1);
    expect(rolled.definition.rollout).toBe(0);
  });

  test("rollback to a specific version restores exactly that definition", async () => {
    await store.put(def("a", { rollout: 10 }), { actor: "t" });
    await store.put(def("a", { rollout: 20 }), { actor: "t" });
    const target = await store.put(def("a", { rollout: 30 }), { actor: "t" });
    await store.put(def("a", { rollout: 40 }), { actor: "t" });
    const rolled = await store.rollback("a", { toVersion: target.version, actor: "t" });
    expect(rolled.definition.rollout).toBe(30);
  });

  test("rollback to the current version is a no-op that still appends history", async () => {
    const v1 = await store.put(def("a"), { actor: "t" });
    const rolled = await store.rollback("a", { toVersion: v1.version, actor: "t" });
    expect(rolled.definition).toEqual(v1.definition);
    expect(rolled.version).toBe(v1.version + 1);
  });

  test("rollback of a missing flag throws NOT_FOUND", async () => {
    expect(async () => await store.rollback("nope", { actor: "t" })).toThrow(/not found/);
  });

  test("rollback to a nonexistent version throws VALIDATION", async () => {
    await store.put(def("a"), { actor: "t" });
    expect(async () => await store.rollback("a", { toVersion: 99, actor: "t" })).toThrow(/does not exist/);
  });

  test("rollback to a version of a different flag throws VALIDATION", async () => {
    await store.put(def("a"), { actor: "t" });
    await store.put(def("b"), { actor: "t" });
    expect(async () => await store.rollback("a", { toVersion: 2, actor: "t" })).toThrow(/does not exist for flag/);
  });

  test("put with a stale expectedVersion throws CONFLICT", async () => {
    const v1 = await store.put(def("a"), { actor: "t" });
    await store.put(def("a", { rollout: 50 }), { actor: "other" });
    expect(async () => await store.put(def("a", { rollout: 100 }), { actor: "t", expectedVersion: v1.version }))
      .toThrow(/stale/);
  });

  test("put with the current expectedVersion succeeds", async () => {
    const v1 = await store.put(def("a"), { actor: "t" });
    const v2 = await store.put(def("a", { rollout: 50 }), { actor: "t", expectedVersion: v1.version });
    expect(v2.version).toBe(2);
  });

  test("definition keys must match the record key", async () => {
    expect(async () => await store.put(def("other"), { recordKey: "a", actor: "t" })).toThrow(/must match/);
  });

  test("rejects invalid keys", async () => {
    expect(async () => await store.put(def(""), { actor: "t" })).toThrow(/key/);
    expect(async () => await store.put(def("../escape"), { actor: "t" })).toThrow(/key/);
    expect(async () => await store.put(def("/leading"), { actor: "t" })).toThrow(/key/);
    expect(async () => await store.put(def("a//b"), { actor: "t" })).toThrow(/key/);
    expect(async () => await store.put(def("a/b/"), { actor: "t" })).toThrow(/key/);
    expect(async () => await store.put(def("flag key with spaces"), { actor: "t" })).toThrow(/key/);
  });

  test("rejects invalid definitions", async () => {
    expect(async () => await store.put(def("a", { rollout: 101 }), { actor: "t" })).toThrow(/rollout/);
    expect(async () => await store.put(def("a", { rollout: -1 }), { actor: "t" })).toThrow(/rollout/);
    expect(async () => await store.put(def("a", { rollout: Number.NaN }), { actor: "t" })).toThrow(/rollout/);
    expect(async () => await store.put({ key: "a", description: "", enabled: true, rollout: 0, rules: [{ attribute: "", operator: "equals", values: [] }] }, { actor: "t" })).toThrow(/attribute/);
  });

  test("audit trail records actions in order", async () => {
    await store.put(def("a"), { actor: "alice" });
    await store.put(def("a", { rollout: 10 }), { actor: "bob" });
    await store.rollback("a", { actor: "carol" });
    const audit = await store.audit();
    expect(audit.map((e) => `${e.action}:${e.actor}`)).toEqual([
      "create:alice",
      "update:bob",
      "rollback:carol",
    ]);
    expect(audit[0]?.fromVersion).toBeNull();
    expect(audit[1]?.fromVersion).toBe(1);
    expect(audit[1]?.toVersion).toBe(2);
  });

  test("audit tail returns the last n entries", async () => {
    await store.put(def("a"), { actor: "t" });
    await store.put(def("b"), { actor: "t" });
    await store.put(def("c"), { actor: "t" });
    const tail = await store.audit(2);
    expect(tail.map((e) => e.flagKey)).toEqual(["b", "c"]);
    expect(await store.audit(0)).toEqual([]);
  });

  test("history can be fetched for specific versions", async () => {
    await store.put(def("a"), { actor: "t" });
    await store.put(def("a", { rollout: 50 }), { actor: "t" });
    expect((await store.history("a", 1)).length).toBe(1);
    expect(async () => await store.history("a", 99)).toThrow(/does not exist/);
  });

  test("keys longer than 200 characters are rejected", async () => {
    const long = "a".repeat(201);
    expect(async () => await store.put(def(long), { actor: "t" })).toThrow(/key/);
  });
});
