import { describe, test, expect } from "bun:test";
describe("azure-blob-feature-flag", () => {
  test("module loads", async () => { const m = await import("./index"); expect(m).toBeDefined(); });
});
