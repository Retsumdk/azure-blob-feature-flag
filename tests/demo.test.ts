import { describe, test, expect } from "bun:test";
import { runDemo } from "../src/demo.js";
import { runCli } from "../src/cli-run.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("demo", () => {
  test("walks the full lifecycle", async () => {
    const lines: string[] = [];
    await runDemo((line: string) => lines.push(line));
    const text = lines.join("\n");
    expect(text).toContain("seeded 3 flags");
    expect(text).toContain("evaluate");
    expect(text.toLowerCase()).toContain("rollback");
    expect(text).toContain("audit trail");
    expect(text).toContain("real-time");
  });

  test("runCli exposes the demo", async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (l: string): void => { lines.push(l); };
    try {
      expect(await runCli(["demo"])).toBe(0);
    } finally {
      console.log = original;
    }
    expect(lines.join("\n")).toContain("seeded 3 flags");
  });
});

describe("cli uri validation", () => {
  test("rejects unsupported schemes", async () => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (l: string): void => { lines.push(l); };
    try {
      expect(await runCli(["list", "s3://bucket"])).toBe(1);
    } finally {
      console.error = original;
    }
    expect(lines[0]).toContain("unsupported blob store URI");
  });
});

describe("storage layout", () => {
  test("flag blobs land under flags/ with .json suffix", async () => {
    const root = await mkdtemp(join(tmpdir(), "abff-layout-"));
    const store = new (await import("../src/flags/store.js")).FlagStore(
      new (await import("../src/blob/index.js")).LocalBlobStore(root),
    );
    await store.put({ key: "checkout.new-flow", description: "", enabled: true, rollout: 0 }, { actor: "t" });
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(join(root, "flags", "checkout.new-flow.json"), "utf8");
    expect(JSON.parse(raw).definition.key).toBe("checkout.new-flow");
    await rm(root, { recursive: true });
  });
});
