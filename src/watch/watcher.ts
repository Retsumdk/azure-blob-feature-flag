import type { BlobStore, FlagChange, FlagRecord } from "../types.js";
import { FlagStore } from "../flags/store.js";

export interface WatcherOptions {
  /** Poll interval in milliseconds. Default 5000. */
  readonly intervalMs?: number;
}

type Listener = (changes: readonly FlagChange[]) => void;

/**
 * Poll-based change detector over the flag store.
 *
 * Blob Storage has no push channel, so "real-time updates" here means a
 * version-diff poll at a configurable interval: each tick lists the flag
 * prefix, compares version numbers against the previous snapshot, and emits
 * created/updated/deleted events. Cheap (one list call per tick), correct
 * under restarts, and honest about latency — intervalMs is the worst-case
 * staleness, which the demo and CLI surface explicitly.
 */
export class FlagWatcher {
  private readonly store: FlagStore;
  private readonly intervalMs: number;
  private readonly listeners = new Set<Listener>();
  private snapshot = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active = false;
  private ticking = false;

  constructor(blobs: BlobStore | FlagStore, opts?: WatcherOptions) {
    this.store = blobs instanceof FlagStore ? blobs : new FlagStore(blobs);
    this.intervalMs = opts?.intervalMs ?? 5000;
    if (!Number.isFinite(this.intervalMs) || this.intervalMs <= 0) {
      throw new Error("intervalMs must be a positive finite number");
    }
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.schedule();
  }

  stop(): void {
    this.active = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** True while the background poll loop is scheduled. */
  running(): boolean {
    return this.active;
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Latest known key -> version snapshot. */
  versions(): ReadonlyMap<string, number> {
    return new Map(this.snapshot);
  }

  private schedule(): void {
    if (!this.active) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, this.intervalMs);
  }

  /** One poll cycle; also exposed for tests. Resolves with the emitted changes. */
  async tick(): Promise<readonly FlagChange[]> {
    if (this.ticking) return [];
    this.ticking = true;
    try {
      const records: FlagRecord[] = await this.store.list();
      const next = new Map<string, FlagRecord>();
      for (const rec of records) next.set(rec.definition.key, rec);

      const changes: FlagChange[] = [];
      for (const [key, record] of next) {
        const prev = this.snapshot.get(key);
        if (prev === undefined) {
          changes.push({ type: "created", key, record, at: Date.now() });
        } else if (prev !== record.version) {
          changes.push({ type: "updated", key, record, at: Date.now() });
        }
      }
      for (const key of this.snapshot.keys()) {
        if (!next.has(key)) changes.push({ type: "deleted", key, record: null, at: Date.now() });
      }

      this.snapshot = new Map([...next].map(([key, rec]) => [key, rec.version]));
      if (changes.length > 0) {
        for (const listener of this.listeners) {
          try {
            listener(changes);
          } catch (err) {
            console.error("[flag-watcher] listener threw:", err);
          }
        }
      }
      return changes;
    } finally {
      this.ticking = false;
      if (this.active) this.schedule();
    }
  }
}
