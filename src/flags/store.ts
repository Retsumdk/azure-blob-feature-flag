import type { AuditEntry, BlobStore, FlagDefinition, FlagRecord } from "../types.js";
import { FeatureFlagError } from "../errors.js";
import { isValidFlagKey, validateDefinition } from "./eval.js";

const DEFAULT_FLAGS_PREFIX = "flags";
const DEFAULT_HISTORY_PREFIX = "history";
const DEFAULT_AUDIT_PREFIX = "audit";

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value, null, 2));
}

function decodeJson<T>(data: Uint8Array): T {
  return JSON.parse(new TextDecoder().decode(data)) as T;
}

function parseRecord(raw: unknown, source: string): FlagRecord {
  const rec = raw as FlagRecord;
  if (typeof rec !== "object" || rec === null || typeof rec.version !== "number" || typeof rec.definition !== "object") {
    throw new FeatureFlagError("STORAGE", `corrupt flag record at ${source}`);
  }
  return rec;
}

/**
 * Versioned flag store over any BlobStore.
 *
 * Layout (prefixes configurable):
 * - `<flags>/<key>.json` — current record (version + definition)
 * - `<history>/<key>/v<N>.json` — immutable snapshot per version
 * - `<audit>/<timestamp>-<seq>.json` — append-only audit trail
 *
 * Every mutation bumps the version and writes a history snapshot first, which
 * is what makes rollback exact: rolling back replays a historical definition
 * as a new version, so the flag's timeline stays append-only and a rollback
 * can itself be rolled back.
 */
export class FlagStore {
  private auditSeq = 0;

  constructor(
    private readonly blobs: BlobStore,
    private readonly flagsPrefix: string = DEFAULT_FLAGS_PREFIX,
    private readonly historyPrefix: string = DEFAULT_HISTORY_PREFIX,
    private readonly auditPrefix: string = DEFAULT_AUDIT_PREFIX,
  ) {}

  async list(): Promise<FlagRecord[]> {
    const metas = await this.blobs.list(`${this.flagsPrefix}/`);
    const out: FlagRecord[] = [];
    for (const meta of metas) {
      if (!meta.key.endsWith(".json")) continue;
      const contents = await this.blobs.get(meta.key);
      out.push(parseRecord(decodeJson<unknown>(contents.data), meta.key));
    }
    return out.sort((a, b) => a.definition.key.localeCompare(b.definition.key));
  }

  async get(key: string): Promise<FlagRecord | null> {
    validateFlagKey(key);
    const blobKey = this.flagBlob(key);
    if (!(await this.blobs.exists(blobKey))) return null;
    const contents = await this.blobs.get(blobKey);
    return parseRecord(decodeJson<unknown>(contents.data), blobKey);
  }

  /** Creates or updates a flag. Bumps the version and snapshots history. */
  async put(
    definition: FlagDefinition,
    opts?: { actor?: string; expectedVersion?: number; recordKey?: string; audit?: boolean },
  ): Promise<FlagRecord> {
    validateDefinition(definition);
    const recordKey = opts?.recordKey ?? definition.key;
    if (recordKey !== definition.key) {
      throw new FeatureFlagError(
        "VALIDATION",
        `record key "${recordKey}" must match the definition key "${definition.key}"`,
      );
    }
    validateFlagKey(recordKey);
    const current = await this.get(recordKey);
    if (current !== null && opts?.expectedVersion !== undefined && current.version !== opts.expectedVersion) {
      throw new FeatureFlagError(
        "CONFLICT",
        `write to "${recordKey}" is stale: expected version ${opts.expectedVersion}, current is ${current.version}`,
      );
    }
    const next: FlagRecord = {
      version: (current?.version ?? 0) + 1,
      updatedAt: new Date().toISOString(),
      ...(opts?.actor === undefined ? {} : { updatedBy: opts.actor }),
      definition,
    };
    await this.blobs.put(this.historyBlob(recordKey, next.version), encodeJson(next), { contentType: "application/json" });
    await this.blobs.put(this.flagBlob(recordKey), encodeJson(next), { contentType: "application/json" });
    if (opts?.audit !== false) {
      await this.appendAudit({
        action: current === null ? "create" : "update",
        flagKey: recordKey,
        actor: opts?.actor ?? "unknown",
        at: next.updatedAt,
        fromVersion: current === null ? null : current.version,
        toVersion: next.version,
      });
    }
    return next;
  }

  /** Deletes the current pointer; history snapshots stay for rollback. */
  async delete(key: string, opts?: { actor?: string }): Promise<boolean> {
    validateFlagKey(key);
    const current = await this.get(key);
    if (current === null) return false;
    await this.blobs.delete(this.flagBlob(key));
    await this.appendAudit({
      action: "delete",
      flagKey: key,
      actor: opts?.actor ?? "unknown",
      at: new Date().toISOString(),
      fromVersion: current.version,
      toVersion: null,
    });
    return true;
  }

  /** History snapshots for a key, oldest version first. */
  async history(key: string, limit?: number): Promise<FlagRecord[]> {
    validateFlagKey(key);
    const metas = await this.blobs.list(`${this.historyPrefix}/${key}/`);
    const out: FlagRecord[] = [];
    for (const meta of metas) {
      const contents = await this.blobs.get(meta.key);
      out.push(parseRecord(decodeJson<unknown>(contents.data), meta.key));
    }
    out.sort((a, b) => a.version - b.version);
    if (limit !== undefined) {
      if (limit > out.length) {
        throw new FeatureFlagError(
          "NOT_FOUND",
          `version ${limit} does not exist for flag "${key}" (history holds ${out.length} versions)`,
        );
      }
      return out.slice(0, limit);
    }
    return out;
  }

  /**
   * Re-enables a historical definition as a new version. Default target is
   * the immediately previous version. Rollback is itself versioned, so it can
   * be rolled back in turn.
   */
  async rollback(key: string, opts?: { toVersion?: number; actor?: string }): Promise<FlagRecord> {
    const current = await this.get(key);
    if (current === null) {
      throw new FeatureFlagError("NOT_FOUND", `flag not found: ${key}`);
    }
    const targetVersion = opts?.toVersion ?? current.version - 1;
    if (targetVersion < 1 || targetVersion > current.version) {
      throw new FeatureFlagError(
        "VALIDATION",
        `version ${targetVersion} does not exist for flag "${key}" (current is ${current.version}; rollback targets are in [1, ${current.version}])`,
      );
    }
    const target = await this.getSnapshot(key, targetVersion);
    if (target === null) {
      throw new FeatureFlagError(
        "NOT_FOUND",
        `version ${targetVersion} does not exist for flag "${key}"`,
      );
    }
    const rolled = await this.put(
      { ...target.definition, key },
      { actor: opts?.actor, expectedVersion: current.version, audit: false },
    );
    await this.appendAudit({
      action: "rollback",
      flagKey: key,
      actor: opts?.actor ?? "unknown",
      at: rolled.updatedAt,
      fromVersion: current.version,
      toVersion: rolled.version,
      detail: `restored the definition of v${targetVersion}`,
    });
    return rolled;
  }

  /** Audit entries, oldest first; `tail` returns the last n entries. */
  async audit(tail?: number): Promise<AuditEntry[]> {
    const metas = await this.blobs.list(`${this.auditPrefix}/`);
    const out: AuditEntry[] = [];
    for (const meta of metas) {
      const contents = await this.blobs.get(meta.key);
      out.push(decodeJson<AuditEntry>(contents.data));
    }
    out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    if (tail === undefined) return out;
    if (tail <= 0) return [];
    return out.slice(-tail);
  }

  private flagBlob(key: string): string {
    return `${this.flagsPrefix}/${key}.json`;
  }

  private historyBlob(key: string, version: number): string {
    return `${this.historyPrefix}/${key}/v${version}.json`;
  }

  private async getSnapshot(key: string, version: number): Promise<FlagRecord | null> {
    const blobKey = this.historyBlob(key, version);
    if (!(await this.blobs.exists(blobKey))) return null;
    const contents = await this.blobs.get(blobKey);
    return parseRecord(decodeJson<unknown>(contents.data), blobKey);
  }

  private async appendAudit(entry: AuditEntry): Promise<void> {
    this.auditSeq += 1;
    const stamp = entry.at.replace(/[:.]/g, "-");
    const blobKey = `${this.auditPrefix}/${stamp}-${String(this.auditSeq).padStart(6, "0")}.json`;
    await this.blobs.put(blobKey, encodeJson(entry), { contentType: "application/json" });
  }
}

function validateFlagKey(key: string): void {
  if (!isValidFlagKey(key)) {
    throw new FeatureFlagError("VALIDATION", `invalid flag key "${key}"`);
  }
}
