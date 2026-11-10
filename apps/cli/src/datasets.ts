import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { RequestContext } from "@mars/contracts";
import {
  buildDataset,
  collectVerifiedExamples,
  DatasetError,
  type HeldOutSet,
} from "@mars/datasets";
import { createTaskStore } from "@mars/tasks";
import { z } from "zod";
import { CliUsageError } from "./cli-errors";
import { resolveWorkbenchLocation } from "./workbench-location";

export const DATASETS_USAGE = [
  "Usage: mars datasets build --id DATASET_ID --out DIR [--held-out FILE ...] [--validation-fraction F] [--seed S] [--state PRIVATE_DIR] [--source DIR] [--project ID] [--owner ID] [--json]",
  "  Builds an SFT dataset from tasks whose newest host verdict passed on the exact exported patch.",
  "  --held-out FILE   tasks never trained on: a gate trials file, an optimization holdout record",
  "                    ({final_holdout}), or {source?, task_ids, requests?}; repeatable",
  "  Writes DIR/train.jsonl, DIR/validation.jsonl and DIR/manifest.json; existing files are never overwritten.",
  "  Defaults match mars serve: --project project-<sha256(source)>, --state ~/.mars/workbench/<project>, --owner local.",
].join("\n");

export class DatasetsUsageError extends CliUsageError {}

const HeldOutFileSchema = z.union([
  z
    .array(z.object({ task_id: z.string().min(1) }).passthrough())
    .transform((trials) => ({
      source: "gate-trials",
      task_ids: trials.map((t) => t.task_id),
      requests: [] as string[],
    })),
  z
    .object({ final_holdout: z.array(z.string().min(1)).min(1) })
    .passthrough()
    .transform((record) => ({
      source: "optimization-holdout",
      task_ids: record.final_holdout,
      requests: [] as string[],
    })),
  z
    .object({
      source: z.string().min(1).optional(),
      task_ids: z.array(z.string().min(1)),
      requests: z.array(z.string()).optional(),
    })
    .strict()
    .transform((set) => ({
      source: set.source ?? "held-out",
      task_ids: set.task_ids,
      requests: set.requests ?? [],
    })),
]);

async function readHeldOut(path: string): Promise<HeldOutSet> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new DatasetsUsageError(`Cannot read held-out file ${path}.`);
  }
  const set = HeldOutFileSchema.safeParse(parsed);
  if (!set.success)
    throw new DatasetsUsageError(`Unrecognized held-out file ${path}.`);
  return { ...set.data, source: `${set.data.source}:${path}` };
}

export async function runDatasets(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (!command || command === "help" || command === "--help") {
    console.log(DATASETS_USAGE);
    return;
  }
  if (command !== "build")
    throw new DatasetsUsageError(
      `Unknown datasets command "${command}".\n${DATASETS_USAGE}`,
    );
  let values: ReturnType<typeof parse>["values"];
  try {
    const parsed = parse(rest);
    if (parsed.positionals.length > 0) throw new Error("Unexpected arguments.");
    values = parsed.values;
  } catch (error) {
    throw new DatasetsUsageError(
      `${error instanceof Error ? error.message : "Invalid options."}\n${DATASETS_USAGE}`,
    );
  }
  if (values.help) {
    console.log(DATASETS_USAGE);
    return;
  }
  if (!values.id?.trim() || !values.out?.trim())
    throw new DatasetsUsageError(
      `mars datasets build requires --id and --out.\n${DATASETS_USAGE}`,
    );
  const fraction =
    values["validation-fraction"] === undefined
      ? undefined
      : Number(values["validation-fraction"]);
  const { source, project, state } = await resolveWorkbenchLocation({
    source: values.source,
    project: values.project,
    state: values.state,
  });
  const held_out = await Promise.all(
    (values["held-out"] ?? []).map((path) => readHeldOut(path)),
  );
  const context: RequestContext = {
    schema_version: 1,
    scope: { owner_id: values.owner ?? "local", project_id: project },
    request_id: `datasets-build-${Date.now()}`,
  };
  const store = await createTaskStore({
    rootDir: join(state, "tasks"),
    workspaceRoots: [source],
    hostPrivateRoots: [state],
  });
  try {
    const collected = await collectVerifiedExamples(store, context);
    const built = buildDataset({
      dataset_id: values.id,
      examples: collected.examples,
      held_out,
      private_patterns: [state, source, homedir()],
      ...(fraction === undefined ? {} : { validation_fraction: fraction }),
      ...(values.seed === undefined ? {} : { seed: values.seed }),
    });
    const out = resolve(values.out);
    await mkdir(out, { recursive: true });
    const write = (name: string, bytes: Uint8Array | string) =>
      writeFile(join(out, name), bytes, { flag: "wx", mode: 0o600 });
    await write("train.jsonl", built.files.train);
    await write("validation.jsonl", built.files.validation);
    await write(
      "manifest.json",
      `${JSON.stringify(built.manifest, null, 2)}\n`,
    );
    const summary = {
      out,
      manifest: built.manifest,
      skipped: collected.skipped,
    };
    const [train, validation] = built.manifest.splits;
    console.log(
      values.json
        ? JSON.stringify(summary, null, 2)
        : [
            `dataset ${built.manifest.dataset_id} written to ${out}`,
            `  train: ${train?.example_count ?? 0} example(s), sha256 ${train?.sha256}`,
            `  validation: ${validation?.example_count ?? 0} example(s), sha256 ${validation?.sha256}`,
            `  excluded: ${built.manifest.excluded.length}; not eligible: ${collected.skipped.length}`,
            ...built.manifest.excluded.map(
              (e) => `    ${e.task_id}: ${e.reason}`,
            ),
            ...collected.skipped.map((s) => `    ${s.task_id}: ${s.reason}`),
          ].join("\n"),
    );
  } catch (error) {
    if (error instanceof DatasetError)
      throw new DatasetsUsageError(`${error.code}: ${error.message}`);
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new DatasetsUsageError(
        "Output files already exist; choose another --out.",
      );
    throw error;
  } finally {
    await store.close();
  }
}

function parse(args: string[]) {
  return parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      id: { type: "string" },
      out: { type: "string" },
      "held-out": { type: "string", multiple: true },
      "validation-fraction": { type: "string" },
      seed: { type: "string" },
      state: { type: "string" },
      source: { type: "string" },
      project: { type: "string" },
      owner: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
}
