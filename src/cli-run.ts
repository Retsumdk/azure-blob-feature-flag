import type { FlagDefinition, TargetingOperator } from "./types.js";
import { createBlobStore } from "./blob/index.js";
import { FeatureFlagClient } from "./client.js";
import { runDemo } from "./demo.js";
import { FeatureFlagError } from "./errors.js";

export const USAGE = `abff — feature flag management over Azure Blob Storage (memory:// and file:// stores included)

Usage:
  abff demo
  abff set    <uri> <key> --enabled <bool> [--rollout <0-100>] [--description <text>]
              [--rule <attr>:<op>:<csv-values>]... [--variant <name>:<weight>]...
  abff get    <uri> <key>
  abff eval   <uri> <key> --id <subject-id> [--attr <key>=<value>]...
  abff list   <uri>
  abff rollback <uri> <key> [--to <version>]
  abff audit  <uri> [--tail <n>]
  abff watch  <uri> [--interval <ms>] [--max <ticks>]

Store URIs:
  memory://                                   in-memory (demos, tests)
  file://<root>                               local directory
  azure://<account>/<container>?key=<base64>  Azure Blob Storage (SharedKey)
  azure://<account>/<container>?sas=<token>   Azure Blob Storage (SAS)`;

function parseAttrPairs(values: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of values) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new FeatureFlagError("VALIDATION", `--attr expects key=value, got "${pair}"`);
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

function parseRules(rules: readonly string[]): FlagDefinition["rules"] {
  if (rules.length === 0) return undefined;
  return rules.map((spec) => {
    const parts = spec.split(":");
    if (parts.length < 3) throw new FeatureFlagError("VALIDATION", `--rule expects attr:op:values, got "${spec}"`);
    const [attribute, operator, csv] = parts;
    const values = csv.split(",").filter((v) => v.length > 0);
    const op = (operator ?? "") as TargetingOperator;
    if (!["equals", "equals-any", "not-equals", "exists"].includes(op)) {
      throw new FeatureFlagError("VALIDATION", `--rule operator must be equals|equals-any|not-equals|exists, got "${operator}"`);
    }
    return { attribute: attribute ?? "", operator: op, values };
  });
}

function parseVariants(variants: readonly string[]): FlagDefinition["variants"] {
  if (variants.length === 0) return undefined;
  const parsed = variants.map((spec) => {
    const colon = spec.lastIndexOf(":");
    if (colon <= 0) throw new FeatureFlagError("VALIDATION", `--variant expects name:weight, got "${spec}"`);
    return { name: spec.slice(0, colon), weight: Number(spec.slice(colon + 1)) };
  });
  let payload: Record<string, string> | undefined;
  for (const spec of variants) {
    const pipe = spec.indexOf("|");
    if (pipe > 0) {
      const name = spec.slice(0, spec.lastIndexOf(":")).slice(0, pipe);
      const json = spec.slice(spec.lastIndexOf(":") + 1);
      try {
        payload = JSON.parse(json) as Record<string, string>;
      } catch {
        throw new FeatureFlagError("VALIDATION", `--variant payload must be JSON: ${spec}`);
      }
      const target = parsed.find((v) => v.name === name);
      if (target !== undefined) Object.assign(target, { payload });
    }
  }
  return parsed;
}

/** Parses and executes a CLI invocation. Returns the process exit code. */
export async function runCli(argv: readonly string[]): Promise<number> {
  const [cmd = "", ...rest] = argv;
  if (cmd === "" || cmd === "help" || cmd === "--help") {
    console.log(USAGE);
    return 0;
  }

  try {
    if (cmd === "demo") {
      await runDemo();
      return 0;
    }

    const flagsIdx = rest.findIndex((a) => a.startsWith("--") || a === "--");
    const positional = flagsIdx === -1 ? rest : rest.slice(0, flagsIdx);
    const optionArgs = flagsIdx === -1 ? [] : rest.slice(flagsIdx).filter((a) => a !== "--");
    const options = new Map<string, string[]>();
    for (let i = 0; i < optionArgs.length; i++) {
      const arg = optionArgs[i] ?? "";
      if (!arg.startsWith("--")) throw new FeatureFlagError("VALIDATION", `unexpected argument "${arg}"`);
      const key = arg.slice(2);
      const value = optionArgs[i + 1] ?? "";
      if (value.startsWith("--") || value === "") {
        options.set(key, options.get(key) ?? []);
      } else {
        const list = options.get(key) ?? [];
        list.push(value);
        options.set(key, list);
        i++;
      }
    }
    const single = (name: string): string | undefined => options.get(name)?.[0];
    const multiple = (name: string): string[] => options.get(name) ?? [];

    const [uri = "", key = ""] = positional;

    switch (cmd) {
      case "set": {
        const store = createBlobStore(uri);
        const client = new FeatureFlagClient(store, { pollIntervalMs: 0 });
        const existing = await client.admin().get(key);
        const definition: FlagDefinition = {
          key,
          description: single("description") ?? existing?.definition.description ?? "",
          enabled: (single("enabled") ?? String(existing?.definition.enabled ?? false)) === "true",
          rollout: Number(single("rollout") ?? existing?.definition.rollout ?? 100),
          ...(parseRules(multiple("rule")) === undefined ? {} : { rules: parseRules(multiple("rule")) }),
          ...(parseVariants(multiple("variant")) === undefined ? {} : { variants: parseVariants(multiple("variant")) }),
        };
        const record = await client.admin().put(definition, {
          actor: "cli",
          ...(existing === null ? {} : { expectedVersion: existing.version }),
        });
        console.log(JSON.stringify(record, null, 2));
        return 0;
      }
      case "get": {
        const client = new FeatureFlagClient(createBlobStore(uri), { pollIntervalMs: 0 });
        const record = await client.admin().get(key);
        if (record === null) {
          console.error(`flag not found: ${key}`);
          return 1;
        }
        console.log(JSON.stringify(record, null, 2));
        return 0;
      }
      case "eval": {
        const id = single("id");
        if (id === undefined) throw new FeatureFlagError("VALIDATION", "eval requires --id <subject-id>");
        const client = new FeatureFlagClient(createBlobStore(uri), { pollIntervalMs: 0 });
        await client.refresh();
        const result = client.evaluate(key, { id, attributes: parseAttrPairs(multiple("attr")) });
        console.log(JSON.stringify(result, null, 2));
        return 0;
      }
      case "list": {
        const client = new FeatureFlagClient(createBlobStore(uri), { pollIntervalMs: 0 });
        await client.refresh();
        const flags = client.flags();
        if (flags.length === 0) {
          console.log("(no flags)");
          return 0;
        }
        for (const record of flags) {
          const d = record.definition;
          console.log(`${d.key}  v${record.version}  enabled=${String(d.enabled)}  rollout=${d.rollout}${d.description.length > 0 ? `  # ${d.description}` : ""}`);
        }
        return 0;
      }
      case "rollback": {
        const record = await new FeatureFlagClient(createBlobStore(uri), { pollIntervalMs: 0 }).admin().rollback(key, {
          ...(single("to") === undefined ? {} : { toVersion: Number(single("to")) }),
          actor: "cli",
        });
        console.log(`${key} rolled back -> v${record.version}`);
        return 0;
      }
      case "audit": {
        const entries = await new FeatureFlagClient(createBlobStore(uri), { pollIntervalMs: 0 }).admin().audit(
          single("tail") === undefined ? undefined : Number(single("tail")),
        );
        if (entries.length === 0) {
          console.log("(no audit entries)");
          return 0;
        }
        for (const e of entries) {
          console.log(`${e.at}  ${e.action.padEnd(8)} ${e.flagKey}  v${e.fromVersion ?? "-"}->v${e.toVersion ?? "-"}  ${e.actor}`);
        }
        return 0;
      }
      case "watch": {
        const max = single("max") === undefined ? undefined : Number(single("max"));
        const client = new FeatureFlagClient(createBlobStore(uri), {
          pollIntervalMs: Number(single("interval") ?? 1000),
        });
        const unsubscribe = client.onChange((changes) => {
          for (const change of changes) {
            console.log(`${change.type.padEnd(8)} ${change.key}${change.record === null ? "" : ` -> v${change.record.version}`}`);
          }
        });
        await client.refresh();
        client.start();
        let ticks = 0;
        await new Promise<void>((resolve) => {
          const stop = (): void => {
            client.stop();
            unsubscribe();
            resolve();
          };
          if (max !== undefined) {
            const iv = setInterval(() => {
              ticks++;
              if (ticks >= max) {
                clearInterval(iv);
                stop();
              }
            }, Number(single("interval") ?? 1000));
          } else {
            process.on("SIGINT", stop);
          }
        });
        return 0;
      }
      default:
        console.error(`unknown command "${cmd}" — run "abff help"`);
        return 2;
    }
  } catch (err) {
    if (err instanceof FeatureFlagError) {
      console.error(`error: ${err.message}`);
      return 1;
    }
    throw err;
  }
}
