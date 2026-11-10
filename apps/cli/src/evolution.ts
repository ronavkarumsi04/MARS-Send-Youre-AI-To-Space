import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  createFixtureEvaluator,
  createProcessSandbox,
  createScriptedProposer,
  EvolutionError,
  EvolutionService,
  runOfflineDemo,
} from "@mars/evolution";
import { CliUsageError } from "./cli-errors";

export const EVOLUTION_USAGE = [
  "Usage: mars evolution <command> --state DIR [options]",
  "  demo                                  offline FAKE end-to-end run (no model requests)",
  "  status|lineage|metrics|verify --run ID",
  "  champion|history --scope KEY",
  "  rollback --scope KEY --to SEQ --expect-version N",
].join("\n");

export class EvolutionUsageError extends CliUsageError {}

/** Opens the durable store read-mostly: evaluator/proposer are inert placeholders. */
async function openStore(state: string): Promise<EvolutionService> {
  return EvolutionService.open({
    storeDir: join(state, "store"),
    workDir: join(state, "work"),
    evaluator: createFixtureEvaluator(),
    proposer: createScriptedProposer("cli-readonly", () => {
      throw new EvolutionError(
        "invalid_state",
        "the CLI does not propose mutations",
      );
    }),
    sandbox: createProcessSandbox(),
  });
}

export async function runEvolution(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  const { values } = parseArgs({
    args: rest,
    options: {
      state: { type: "string" },
      run: { type: "string" },
      scope: { type: "string" },
      to: { type: "string" },
      "expect-version": { type: "string" },
    },
    strict: true,
  });
  if (!command || !values.state) throw new EvolutionUsageError(EVOLUTION_USAGE);
  const state = isAbsolute(values.state) ? values.state : resolve(values.state);
  if (command === "demo") {
    const { service, summary } = await runOfflineDemo(state);
    service.close();
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  const need = (value: string | undefined, flag: string) => {
    if (!value)
      throw new EvolutionUsageError(
        `--${flag} is required\n${EVOLUTION_USAGE}`,
      );
    return value;
  };
  const integer = (value: string | undefined, flag: string) => {
    const parsed = Number(need(value, flag));
    if (!Number.isSafeInteger(parsed) || parsed < 0)
      throw new EvolutionUsageError(`--${flag} must be a non-negative integer`);
    return parsed;
  };
  const service = await openStore(state);
  try {
    let output: unknown;
    if (command === "status") output = service.status(need(values.run, "run"));
    else if (command === "lineage")
      output = service.lineage(need(values.run, "run"));
    else if (command === "metrics")
      output = service.metrics(need(values.run, "run"));
    else if (command === "verify")
      output = await service.verify(need(values.run, "run"));
    else if (command === "champion")
      output = service.champion(need(values.scope, "scope"));
    else if (command === "history")
      output = service.history(need(values.scope, "scope"));
    else if (command === "rollback")
      output = service.rollback({
        scope_key: need(values.scope, "scope"),
        to_entry_seq: integer(values.to, "to"),
        expected_pointer_version: integer(
          values["expect-version"],
          "expect-version",
        ),
      });
    else throw new EvolutionUsageError(EVOLUTION_USAGE);
    console.log(JSON.stringify(output, null, 2));
    if (command === "verify" && !(output as { ok: boolean }).ok)
      process.exitCode = 1;
  } finally {
    service.close();
  }
}
