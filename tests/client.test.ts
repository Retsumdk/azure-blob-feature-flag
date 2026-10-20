import { describe, test, expect } from "bun:test";
import { FeatureFlagClient } from "../src/client.js";
import { MemoryBlobStore } from "../src/blob/index.js";
import type { FlagDefinition } from "../src/types.js";

const def = (key: string, overrides: Partial<FlagDefinition> = {}): FlagDefinition => ({
  key,
  description: "",
  enabled: true,
  rollout: 0,
  ...overrides,
});

describe("feature flag client", () => {
  test("evaluate reads from the last snapshot", async () => {
    const client = new FeatureFlagClient(new MemoryBlobStore(), { pollIntervalMs: 0 });
    const out = client.evaluate("anything", { id: "u-1" });
    expect(out.enabled).toBe(false);
    expect(out.reason).toBe("flag-not-found");
    await client.admin().put(def("flag.a", { rollout: 100 }), { actor: "t" });
    expect(client.evaluate("flag.a", { id: "u-1" }).enabled).toBe(false);
    await client.refresh();
    expect(client.evaluate("flag.a", { id: "u-1" }).enabled).toBe(true);
  });

  test("evaluate is usable before the first refresh", () => {
    const client = new FeatureFlagClient(new MemoryBlobStore(), { pollIntervalMs: 0 });
    expect(client.evaluate("x", { id: "u" }).reason).toBe("flag-not-found");
  });

  test("snapshot reflects updates after refresh", async () => {
    const client = new FeatureFlagClient(new MemoryBlobStore(), { pollIntervalMs: 0 });
    await client.admin().put(def("flag.a", { rollout: 25 }), { actor: "t" });
    await client.refresh();
    const flags = client.flags();
    expect(flags.length).toBe(1);
    expect(flags[0]?.definition.rollout).toBe(25);
    expect(flags[0]?.version).toBe(1);
  });

  test("onChange listeners receive refresh-driven changes", async () => {
    const client = new FeatureFlagClient(new MemoryBlobStore(), { pollIntervalMs: 0 });
    const seen: string[] = [];
    client.onChange((changes) => { for (const c of changes) seen.push(`${c.type}:${c.key}`); });
    await client.admin().put(def("flag.a"), { actor: "t" });
    await client.refresh();
    expect(seen).toEqual(["created:flag.a"]);
    client.stop();
  });

  test("start/stop controls background polling", async () => {
    const client = new FeatureFlagClient(new MemoryBlobStore(), { pollIntervalMs: 10 });
    expect(client.isWatching()).toBe(false);
    client.start();
    expect(client.isWatching()).toBe(true);
    client.stop();
    expect(client.isWatching()).toBe(false);
  });
});
