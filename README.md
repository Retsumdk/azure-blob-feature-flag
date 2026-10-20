# azure-blob-feature-flag

Feature flag management over Azure Blob Storage: versioned definitions with
one-command rollback, percentage rollout, attribute targeting rules, weighted
variants, and a poll-based watcher that surfaces changes the moment they land.

## The problem

Most teams bolt feature flags onto Redis or Postgres, which means the flag
service is yet another stateful thing to operate. If you already run Azure,
Blob Storage is a boring, durable, effectively-free backend — but it has no
push channel, no transactions, and no query API. Existing flag SDKs assume a
server you can subscribe to, so they don't fit a blob container.

## The solution

`azure-blob-feature-flag` treats a blob container as an append-only flag
ledger and rebuilds everything a flag service needs on top of it:

- **Every change is a version.** `put` writes an immutable history snapshot
  (`history/<key>/v<N>.json`) and then moves the current pointer
  (`flags/<key>.json`). Rollback is just "copy an old snapshot forward" — it
  appends as a *new* version, so history never rewinds and every change is
  auditable.
- **Deterministic rollout.** A flag/subject pair hashes (FNV-1a) to a stable
  0–99 bucket, so `evaluate` returns the same answer for the same subject on
  every call, in every process, with zero shared state.
- **Targeting and variants without a DSL.** Rules are plain
  `{attribute, operator, values}` objects (`equals`, `equals-any`,
  `not-equals`, `exists`) that AND together; variants carry weights and
  optional payloads and are assigned from the same stable bucket.
- **Honest "real-time".** Blob Storage can't push, so a `FlagWatcher` polls
  the container at a configurable interval, diffs version numbers against its
  last snapshot, and emits `created`/`updated`/`deleted` events. The interval
  is the worst-case staleness, stated up front instead of hidden.
- **Three backends, one interface.** `memory://` for tests, `file://` for
  local runs and CLI lifecycles, and real Azure (`azure://<account>/<container>`,
  SharedKey or SAS auth, Azurite-friendly) via a from-scratch REST client —
  no SDK dependency.

An audit trail (`audit/<timestamp>-<seq>.json`) records every create, update,
rollback, and delete with actor, versions, and timestamps.

## How it works

```
FlagDefinition ──put──▶ history/<key>/v1.json   (immutable snapshot)
                     └─current─▶ flags/<key>.json   (pointer: version, updatedAt, updatedBy)

evaluate(flag, context)
  ├─ 1. rules: attribute predicates, ANDed — fail → "rule-no-match"
  ├─ 2. rollout %: bucketFor(key, subjectId) ∈ [0,99] vs rollout — fail → "rollout-excluded"
  └─ 3. variants: weightedSlot(variants, bucket) — stable per subject

FlagWatcher.start()
  └─ every intervalMs: list flags/ → diff versions vs snapshot
       → emit created | updated | deleted to onChange listeners
```

Storage layout (all JSON, all inspectable with any blob tool):

| Path | Contents |
| --- | --- |
| `flags/<key>.json` | Current `FlagRecord` (version + definition) |
| `history/<key>/v<N>.json` | Immutable snapshot per version |
| `audit/<stamp>-<seq>.json` | Append-only audit entry |

## Getting started

```bash
npm install github:Retsumdk/azure-blob-feature-flag
```

Bun users: Bun blocks lifecycle scripts of git dependencies by default, so
trust the package after installing — `bun pm trust azure-blob-feature-flag`
— or use `npm install` which runs the `prepare` build automatically.

Evaluate a flag against an Azure container:

```ts
import { FeatureFlagClient, createBlobStore } from "azure-blob-feature-flag";

const blobs = createBlobStore(
  "azure://myaccount/flags?sas=<sas-token>",
);
const client = new FeatureFlagClient(blobs, { pollIntervalMs: 30_000 });
await client.refresh(); // pull the latest snapshot

const result = client.evaluate("checkout.new-flow", { id: "user-42", attributes: { plan: "pro" } });
console.log(result.enabled, result.reason, result.variant);
```

Publish a flag change:

```ts
await client.admin().put(
  { key: "checkout.new-flow", description: "One-page checkout", enabled: true, rollout: 25 },
  { actor: "ci" },
);
// 100% kill switch, then roll back when it goes wrong:
await client.admin().put({ key: "checkout.new-flow", description: "One-page checkout", enabled: true, rollout: 100 }, { actor: "ops" });
await client.admin().rollback("checkout.new-flow", { actor: "ops" });
```

Watch for changes (the CLI does this live):

```bash
npx abff list "memory://"
npx abff set "file://./flags" my-flag --enabled true --rollout 50
npx abff eval "file://./flags" my-flag --id user-42 --attr plan=pro
npx abff rollback "file://./flags" my-flag
npx abff audit "file://./flags"
npx abff watch "azure://myaccount/flags?sas=<token>" --interval 5000
```

## Examples

The demo walks the entire lifecycle against an in-memory store:

```bash
bun run demo
```

```text
seeded 3 flags in an in-memory store

-- evaluate: checkout.new-flow at 50% rollout --
u-001: off (rollout-excluded, bucket 53, stable across calls)
u-003: evaluate -> on (enabled, bucket 15, stable across calls)
...

-- targeting: search.ranker is for paid plans, split control/ml-ranker --
u-001 (plan=pro): variant=ml-ranker (enabled)
u-001 (plan=free): off (rule-no-match)

-- rollback: checkout.new-flow goes to 100%, then rolls back one version --
bumped to v2 (rollout 100)
rollback restored the previous definition as v3 (rollout 50)

-- audit trail --
1. create checkout.new-flow v0->v1 by demo
...
```

Run the test suite (73 tests across 8 files):

```bash
bun test
```

`evaluate` errors never throw — flags that don't exist come back
`{ enabled: false, reason: "flag-not-found" }` so callers can apply their own
fallback. Validation and storage errors do throw typed
`FeatureFlagError`s (`VALIDATION`, `NOT_FOUND`, `CONFLICT`, `AUTH`, …) with
`retriable` hints for the storage codes.

## License

[MIT](./LICENSE)
