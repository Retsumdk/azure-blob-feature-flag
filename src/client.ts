import type { BlobStore, EvalContext, EvalResult, FlagChange, FlagRecord } from "./types.js";
import { createBlobStore } from "./blob/index.js";
import { FlagStore } from "./flags/store.js";
import { evaluateFlag } from "./flags/eval.js";
import { FlagWatcher } from "./watch/watcher.js";

export interface ClientOptions {
  /** Background refresh interval in milliseconds. Default 5000. 0 disables it. */
  readonly pollIntervalMs?: number;
}

type Listener = (changes: readonly FlagChange[]) => void;

/**
 * Read-side client with a local cache.
 *
 * Flags are refreshed from the store (explicitly, or by the background
 * watcher) and every `evaluate()` call runs against the in-memory snapshot —
 * zero-latency, zero-network evaluation with deterministic bucketing, so a
 * service can hold one client for its whole lifetime. `onChange` listeners
 * fire whenever a refresh observes created/updated/deleted flags, whether the
 * refresh was triggered by the background poll or called directly.
 */
export class FeatureFlagClient {
  private readonly store: FlagStore;
  private readonly watcher: FlagWatcher | null;
  private readonly listeners = new Set<Listener>();
  private cache = new Map<string, FlagRecord>();

  constructor(blobs: BlobStore | string, opts?: ClientOptions) {
    const resolved: BlobStore = typeof blobs === "string" ? createBlobStore(blobs) : blobs;
    this.store = new FlagStore(resolved);
    const interval = opts?.pollIntervalMs ?? 5000;
    if (interval < 0) {
      throw new Error("pollIntervalMs must be 0 (disabled) or a positive number");
    }
    this.watcher = interval === 0 ? null : new FlagWatcher(this.store, { intervalMs: interval });
    this.watcher?.onChange(() => {
      void this.refresh();
    });
  }

  /**
   * Pulls all current flags into the cache, diffs against the previous
   * snapshot, and emits created/updated/deleted to onChange listeners.
   * Resolves with the flag count.
   */
  async refresh(): Promise<number> {
    const records = await this.store.list();
    const next = new Map<string, FlagRecord>();
    for (const record of records) next.set(record.definition.key, record);

    const changes: FlagChange[] = [];
    for (const [key, record] of next) {
      const prev = this.cache.get(key);
      if (prev === undefined) {
        changes.push({ type: "created", key, record, at: Date.now() });
      } else if (prev.version !== record.version) {
        changes.push({ type: "updated", key, record, at: Date.now() });
      }
    }
    for (const key of this.cache.keys()) {
      if (!next.has(key)) changes.push({ type: "deleted", key, record: null, at: Date.now() });
    }

    this.cache = next;
    if (changes.length > 0) {
      for (const listener of this.listeners) {
        try {
          listener(changes);
        } catch (err) {
          console.error("[flag-client] listener threw:", err);
        }
      }
    }
    return records.length;
  }

  /** Starts background polling (no-op when pollIntervalMs is 0). */
  start(): void {
    this.watcher?.start();
  }

  stop(): void {
    this.watcher?.stop();
  }

  /** True while background polling is active. */
  isWatching(): boolean {
    return this.watcher?.running() ?? false;
  }

  /** Subscribes to change events; returns an unsubscribe function. */
  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Evaluates against the local cache. Refresh once, evaluate forever. */
  evaluate(key: string, context: EvalContext): EvalResult {
    const record = this.cache.get(key);
    return evaluateFlag(record?.definition, context);
  }

  /** Fetches the latest definition from the store, then evaluates. */
  async evaluateFresh(key: string, context: EvalContext): Promise<EvalResult> {
    const record = await this.store.get(key);
    if (record !== null) this.cache.set(key, record);
    return evaluateFlag(record?.definition, context);
  }

  /** Cached records, sorted by key. */
  flags(): readonly FlagRecord[] {
    return [...this.cache.values()].sort((a, b) => a.definition.key.localeCompare(b.definition.key));
  }

  /** Direct store access for admin operations (put/rollback/audit). */
  admin(): FlagStore {
    return this.store;
  }
}
