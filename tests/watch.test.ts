import { describe, test, expect } from "bun:test";
import { FlagWatcher } from "../src/watch/watcher.js";
import { FlagStore } from "../src/flags/store.js";
import { MemoryBlobStore } from "../src/blob/index.js";
import type { FlagChange, FlagDefinition } from "../src/types.js";

const def = (key: string, overrides: Partial<FlagDefinition> = {}): FlagDefinition => ({
  key,
  description: "",
  enabled: true,
  rollout: 0,
  ...overrides,
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

describe("flag watcher", () => {
  test("emits created, updated, deleted changes", async () => {
    const blobs = new MemoryBlobStore();
    const store = new FlagStore(blobs);
    const watcher = new FlagWatcher(store, { intervalMs: 10 });
    const events: FlagChange[] = [];
    const gotFirst = deferred();
    const gotSecond = deferred();
    const gotThird = deferred();
    let phase = 0;
    const unsubscribe = watcher.onChange((changes) => {
      events.push(...changes);
      if (phase === 0 && changes.some((c) => c.type === "created")) gotFirst.resolve();
      if (phase === 1 && changes.some((c) => c.type === "updated")) gotSecond.resolve();
      if (phase === 2 && changes.some((c) => c.type === "deleted")) gotThird.resolve();
    });

    await store.put(def("watch.one"), { actor: "t" });
    watcher.start();
    await gotFirst.promise;
    phase = 1;
    await store.put(def("watch.one", { rollout: 50 }), { actor: "t" });
    await gotSecond.promise;
    phase = 2;
    await store.delete("watch.one", { actor: "t" });
    await gotThird.promise;
    watcher.stop();
    unsubscribe();

    const created = events.find((c) => c.type === "created");
    const updated = events.find((c) => c.type === "updated");
    const deleted = events.find((c) => c.type === "deleted");
    expect(created?.key).toBe("watch.one");
    expect(updated?.record?.version).toBe(2);
    expect(deleted?.key).toBe("watch.one");
    expect(events.every((c) => c.at > 0)).toBe(true);
  });

  test("start is idempotent", async () => {
    const watcher = new FlagWatcher(new FlagStore(new MemoryBlobStore()), { intervalMs: 10 });
    watcher.start();
    watcher.start();
    expect(watcher.running()).toBe(true);
    watcher.stop();
    expect(watcher.running()).toBe(false);
    watcher.stop();
  });

  test("change events are dropped for stopped watchers", async () => {
    const blobs = new MemoryBlobStore();
    const store = new FlagStore(blobs);
    const watcher = new FlagWatcher(store, { intervalMs: 10 });
    const events: FlagChange[] = [];
    watcher.onChange((changes) => events.push(...changes));
    await store.put(def("quiet"), { actor: "t" });
    await new Promise((r) => setTimeout(r, 40));
    expect(events).toEqual([]);
  });
});
