export type ErrorCode = "VALIDATION" | "NOT_FOUND" | "CONFLICT" | "STORAGE" | "AUTH" | "IO_ERROR" | "INVALID_KEY";

const CODE_NAMES: readonly ErrorCode[] = ["VALIDATION", "NOT_FOUND", "CONFLICT", "STORAGE", "AUTH", "IO_ERROR", "INVALID_KEY"];

/** Stable ordering of the taxonomy, exported for tests and CLIs. */
export function errorCodeNames(): readonly ErrorCode[] {
  return CODE_NAMES;
}

export class FeatureFlagError extends Error {
  readonly code: ErrorCode;
  readonly retriable: boolean;
  readonly blobKey?: string;

  constructor(code: ErrorCode, message: string, opts: { retriable?: boolean; blobKey?: string; cause?: unknown } = {}) {
    super(`[${code}] ${message}`, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "FeatureFlagError";
    this.code = code;
    this.retriable = opts.retriable ?? false;
    this.blobKey = opts.blobKey;
  }
}

export function isFeatureFlagError(err: unknown): err is FeatureFlagError {
  return err instanceof FeatureFlagError;
}

/** One-line human-readable rendering of any thrown value. */
export function describeError(err: unknown): string {
  if (isFeatureFlagError(err)) return `[${err.code}] ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Exit code convention: 1 for typed domain errors, 2 for unexpected ones. */
export function errorExitCode(err: unknown): number {
  return isFeatureFlagError(err) ? 1 : 2;
}


