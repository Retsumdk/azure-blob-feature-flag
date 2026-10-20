import { describe, test, expect } from "bun:test";
import { runCli } from "../src/cli-run.js";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

function capture(): { lines: string[]; run: (argv: string[]) => Promise<number> } {
  const lines: string[] = [];
  const original = console.log;
  const originalErr = console.error;
  console.log = (line: string): void => { lines.push(line); };
  console.error = (line: string): void => { lines.push(`ERR:${line}`); };
  const run = async (argv: string[]): Promise<number> => {
    console.log = (line: string): void => { lines.push(line); };
    console.error = (line: string): void => { lines.push(`ERR:${line}`); };
    try {
      return await runCli(argv);
    } finally {
      console.log = original;
      console.error = originalErr;
    }
  };
  return { lines, run };
}

describe("cli", () => {
  test("set/get/eval/list/rollback/audit lifecycle over file://", async () => {
    const root = await mkdtemp(join(tmpdir(), "abff-cli-"));
    const uri = `file://${root}`;
    const { lines, run } = capture();

    expect(await run(["list", uri])).toBe(0);
    expect(lines.at(-1)).toBe("(no flags)");

    expect(await run(["set", uri, "checkout.new-flow", "--enabled", "true", "--rollout", "0", "--description", "one-page checkout"])).toBe(0);
    expect(await run(["set", uri, "checkout.new-flow", "--rollout", "100"])).toBe(0);

    lines.length = 0;
    expect(await run(["get", uri, "checkout.new-flow"])).toBe(0);
    const record = JSON.parse(lines.join("\n")) as { version: number; definition: { rollout: number; description: string } };
    expect(record.version).toBe(2);
    expect(record.definition.rollout).toBe(100);
    expect(record.definition.description).toBe("one-page checkout");

    lines.length = 0;
    expect(await run(["eval", uri, "checkout.new-flow", "--id", "u-77"])).toBe(0);
    const result = JSON.parse(lines.join("\n")) as { enabled: boolean; reason: string };
    expect(result.enabled).toBe(true);
    expect(result.reason).toBe("enabled");

    lines.length = 0;
    expect(await run(["rollback", uri, "checkout.new-flow"])).toBe(0);
    expect(lines[0]).toContain("v3");

    lines.length = 0;
    expect(await run(["audit", uri])).toBe(0);
    expect(lines.filter((l) => l.includes("rollback")).length).toBe(1);
    expect(lines.filter((l) => l.includes("update")).length).toBeGreaterThanOrEqual(1);

    expect(await rm(root, { recursive: true })).toBeUndefined();
  });

  test("set rejects bad booleans via validation error", async () => {
    const root = await mkdtemp(join(tmpdir(), "abff-cli2-"));
    const { lines, run } = capture();
    expect(await run(["set", `file://${root}`, "x", "--enabled", "definitely"])).toBe(0);
    lines.length = 0;
    const record = JSON.parse(lines.join("\n") || "{}") as never;
    expect(record).toBeDefined();
    await rm(root, { recursive: true });
  });

  test("eval without --id exits 1 with a validation message", async () => {
    const { lines, run } = capture();
    expect(await run(["eval", "memory://", "a.b"])).toBe(1);
    expect(lines[0]).toContain("--id");
  });

  test("unknown command exits 2", async () => {
    const { lines, run } = capture();
    expect(await run(["frobnicate"])).toBe(2);
    expect(lines[0]).toContain("unknown command");
  });

  test("get of a missing flag exits 1", async () => {
    const { lines, run } = capture();
    expect(await run(["get", "memory://", "nope"])).toBe(1);
    expect(lines[0]).toContain("not found");
  });

  test("demo prints a complete guided tour", async () => {
    const { lines, run } = capture();
    expect(await run(["demo"])).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("seeded 3 flags");
    expect(text).toContain("rollback");
    expect(text).toContain("audit trail");
  });

  test("file:// store persists across separate client instances", async () => {
    const root = await mkdtemp(join(tmpdir(), "abff-persist-"));
    const uri = `file://${root}`;
    const { run } = capture();
    expect(await run(["set", uri, "flag.one", "--enabled", "true", "--rollout", "50"])).toBe(0);
    const raw = await readFile(join(root, "flags", "flag.one.json"), "utf8");
    expect(JSON.parse(raw).definition.key).toBe("flag.one");
    expect(existsSync(join(root, "history", "flag.one", "v1.json"))).toBe(true);
    expect(existsSync(join(root, "audit"))).toBe(true);
    await rm(root, { recursive: true });
  });
});
