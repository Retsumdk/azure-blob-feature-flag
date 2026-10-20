import { describe, test, expect } from "bun:test";
import * as api from "../src/index.js";

describe("public api", () => {
  test("exports the core surface", () => {
    expect(typeof api.FeatureFlagClient).toBe("function");
    expect(typeof api.createBlobStore).toBe("function");
    expect(typeof api.MemoryBlobStore).toBe("function");
    expect(typeof api.LocalBlobStore).toBe("function");
    expect(typeof api.AzureBlobStore).toBe("function");
    expect(typeof api.FlagStore).toBe("function");
    expect(typeof api.FlagWatcher).toBe("function");
    expect(typeof api.evaluateFlag).toBe("function");
    expect(typeof api.bucketFor).toBe("function");
    expect(typeof api.validateDefinition).toBe("function");
    expect(api.FeatureFlagError).toBeDefined();
    expect(api.errorCodeNames().length).toBeGreaterThan(0);
  });

  test("error taxonomy is stable and ordered", () => {
    expect(api.errorCodeNames()).toEqual([
      "VALIDATION",
      "NOT_FOUND",
      "CONFLICT",
      "STORAGE",
      "AUTH",
      "IO_ERROR",
      "INVALID_KEY",
    ]);
  });

  test("errors carry codes and details", () => {
    const err = new api.FeatureFlagError("VALIDATION", "bad input", { retriable: false });
    expect(err.code).toBe("VALIDATION");
    expect(err.name).toBe("FeatureFlagError");
    expect(err.retriable).toBe(false);
    expect(String(err)).toContain("VALIDATION");
  });
});
