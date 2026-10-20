export interface BlobMeta {
  readonly key: string;
  readonly size: number;
  readonly contentType: string;
  readonly etag: string;
  readonly lastModified: string;
}

export interface BlobContents {
  readonly data: Uint8Array;
  readonly meta: BlobMeta;
}

export interface PutOptions {
  readonly contentType?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface BlobStore {
  put(key: string, data: Uint8Array, opts?: PutOptions): Promise<BlobMeta>;
  get(key: string): Promise<BlobContents>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<boolean>;
  list(prefix?: string): Promise<BlobMeta[]>;
}

export type TargetingOperator = "equals" | "equals-any" | "not-equals" | "exists";

export interface TargetingRule {
  readonly attribute: string;
  readonly operator: TargetingOperator;
  readonly values: readonly string[];
}

export interface FlagVariant {
  readonly name: string;
  readonly weight: number;
  readonly payload?: Readonly<Record<string, unknown>>;
}

export interface FlagDefinition {
  readonly key: string;
  readonly description: string;
  readonly enabled: boolean;
  /** Integer 0-100: percentage of the population that receives the flag. */
  readonly rollout: number;
  readonly rules?: readonly TargetingRule[];
  readonly variants?: readonly FlagVariant[];
}

export interface FlagRecord {
  readonly definition: FlagDefinition;
  readonly version: number;
  readonly updatedAt: string;
  readonly updatedBy?: string;
}

export type FlagChangeType = "created" | "updated" | "deleted";

export interface FlagChange {
  readonly type: FlagChangeType;
  readonly key: string;
  readonly record: FlagRecord | null;
  readonly at: number;
}

export type AuditAction = "create" | "update" | "rollback" | "delete";

export interface AuditEntry {
  readonly action: AuditAction;
  readonly flagKey: string;
  readonly actor: string;
  readonly at: string;
  readonly fromVersion: number | null;
  readonly toVersion: number | null;
  readonly detail?: string;
}

export interface EvalContext {
  /** Stable subject identity: user id, agent id, session id... */
  readonly id: string;
  readonly attributes?: Readonly<Record<string, string>>;
}

export type EvalReason =
  | "enabled"
  | "flag-not-found"
  | "flag-disabled"
  | "rule-no-match"
  | "rollout-excluded"
  | "invalid-variant-weights";

export interface EvalResult {
  readonly flagKey: string;
  readonly enabled: boolean;
  readonly reason: EvalReason;
  readonly variant: string | null;
  readonly payload: Readonly<Record<string, unknown>> | null;
  readonly bucket: number;
}
