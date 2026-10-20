export { FeatureFlagClient } from "./client.js";
export type { ClientOptions } from "./client.js";
export { FlagStore } from "./flags/store.js";
export { evaluateFlag, validateDefinition, isRuleSatisfied, isValidFlagKey } from "./flags/eval.js";
export { FlagWatcher } from "./watch/watcher.js";
export type { WatcherOptions } from "./watch/watcher.js";
export { runDemo } from "./demo.js";
export { runCli, USAGE } from "./cli-run.js";
export {
  FeatureFlagError,
  isFeatureFlagError,
  errorCodeNames,
  describeError,
  errorExitCode,
} from "./errors.js";
export {
  MemoryBlobStore,
  LocalBlobStore,
  AzureBlobStore,
  buildSharedKeyAuth,
  parseListBlobsXml,
  createBlobStore,
  contentTypeForExtension,
  sanitizeKey,
} from "./blob/index.js";
export type { AzureBlobConfig, ListedBlob, ListBlobsResult } from "./blob/azure.js";
export { bucketFor, weightedSlot, fnv1a32Hex } from "./hash.js";
export type {
  BlobContents,
  BlobMeta,
  BlobStore,
  EvalContext,
  EvalResult,
  FlagChange,
  FlagDefinition,
  FlagRecord,
  FlagVariant,
  PutOptions,
  TargetingRule,
} from "./types.js";
