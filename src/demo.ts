import type { FlagDefinition } from "./types.js";
import { FeatureFlagClient } from "./client.js";
import { FlagWatcher } from "./watch/watcher.js";

const DEMO_FLAGS: readonly FlagDefinition[] = [
  {
    key: "checkout.new-flow",
    description: "New one-page checkout",
    enabled: true,
    rollout: 50,
  },
  {
    key: "search.ranker",
    description: "Search ranking experiment",
    enabled: true,
    rollout: 100,
    rules: [{ attribute: "plan", operator: "equals", values: ["pro", "enterprise"] }],
    variants: [
      { name: "control", weight: 50 },
      { name: "ml-ranker", weight: 50, payload: { model: "v3" } },
    ],
  },
  {
    key: "billing.hard-kill-switch",
    description: "Killed yesterday, waiting for rollback",
    enabled: false,
    rollout: 100,
  },
];

/**
 * Runs the guided demo against an in-memory store: seed, evaluate, target,
 * roll back, watch changes arrive, and print the audit trail.
 */
export async function runDemo(log: (line: string) => void = (line) => console.log(line)): Promise<string[]> {
  const lines: string[] = [];
  const emit = (line: string): void => {
    lines.push(line);
    log(line);
  };

  const client = new FeatureFlagClient("memory://", { pollIntervalMs: 0 });
  for (const definition of DEMO_FLAGS) {
    await client.admin().put(definition, { actor: "demo" });
  }
  emit(`seeded ${DEMO_FLAGS.length} flags in an in-memory store`);
  await client.refresh();

  emit("\n-- evaluate: checkout.new-flow at 50% rollout --");
  for (const id of ["u-001", "u-002", "u-003", "u-004", "u-005", "u-006"]) {
    const result = client.evaluate("checkout.new-flow", { id });
    emit(`${id}: ${result.enabled ? "evaluate -> on" : "off"} (${result.reason}, bucket ${result.bucket}, stable across calls)`);
  }

  emit("\n-- targeting: search.ranker is for paid plans, split control/ml-ranker --");
  for (const id of ["u-001", "u-002"]) {
    const pro = client.evaluate("search.ranker", { id, attributes: { plan: "pro" } });
    emit(`${id} (plan=pro): variant=${pro.variant ?? "off"} (${pro.reason})`);
    const free = client.evaluate("search.ranker", { id, attributes: { plan: "free" } });
    emit(`${id} (plan=free): ${free.enabled ? pro.variant : "off"} (${free.reason})`);
  }

  emit("\n-- rollback: checkout.new-flow goes to 100%, then rolls back one version --");
  await client.admin().put({ ...DEMO_FLAGS[0]!, rollout: 100 }, { actor: "demo", expectedVersion: 1 });
  const before = await client.admin().get("checkout.new-flow");
  emit(`bumped to v${before?.version} (rollout 100)`);
  const rolled = await client.admin().rollback("checkout.new-flow", { actor: "demo" });
  emit(`rollback restored the previous definition as v${rolled.version} (rollout ${rolled.definition.rollout})`);
  await client.refresh();
  const after = client.evaluate("checkout.new-flow", { id: "u-004" });
  emit(`u-004 after rollback: ${after.enabled ? "on" : "off"} (${after.reason})`);

  emit("\n-- real-time updates: a poll-based watcher diffs store versions --");
  const watcher = new FlagWatcher(client.admin(), { intervalMs: 250 });
  watcher.onChange((changes) => {
    for (const change of changes) {
      emit(`watch: ${change.type} ${change.key}${change.record === null ? "" : ` -> v${change.record.version}`}`);
    }
  });
  await watcher.tick();
  await client.admin().put({ ...DEMO_FLAGS[0]!, rollout: 75 }, { actor: "demo" });
  await watcher.tick();
  await client.admin().delete("billing.hard-kill-switch", { actor: "demo" });
  await watcher.tick();
  emit("(the `abff watch` command runs this loop continuously)");

  emit("\n-- audit trail --");
  for (const entry of await client.admin().audit()) {
    emit(`${entry.at} ${entry.action} ${entry.flagKey} v${entry.fromVersion ?? 0}->v${entry.toVersion ?? "-"} by ${entry.actor}`);
  }
  return lines;
}
