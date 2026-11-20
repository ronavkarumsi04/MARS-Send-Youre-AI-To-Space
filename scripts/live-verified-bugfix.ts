/**
 * Live end-to-end verified bug-fix run through the real MARS workbench:
 * - Real hosted coding model via OpenRouter (configured through MARS model registry)
 * - Isolated private workspace (source checkout stays untouched)
 * - Host-defined protected test suite overlaid into a disposable --network=none Docker container
 * - Exact patch export & verification receipt bound to workspace revision and patch_sha256
 *
 * Usage:
 *   OPENROUTER_API_KEY=... bun scripts/live-verified-bugfix.ts [--model google/gemma-4-31b-it:free] [--out-json FILE] [--out-txt FILE]
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { MarsClient } from "../apps/vscode/src/client";
import { HttpRpcTransport } from "../apps/vscode/src/rpc";
import type { Task } from "../packages/contracts/src/index";
import { openRuntimeSession } from "../packages/execution/src/index";
import { loadModelRegistry } from "../packages/providers/src/index";
import { createWorkbenchService } from "../packages/workbench/src/index";

const DEFAULT_IMAGE =
  "oven/bun@sha256:5148f6742ac31fac28e6eab391ab1f11f6dfc0c8512c7a3679b374ec470f5982";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    model: { type: "string", default: "google/gemma-4-31b-it:free" },
    image: { type: "string", default: DEFAULT_IMAGE },
    "out-json": { type: "string" },
    "out-txt": { type: "string" },
  },
  strict: true,
});

const BUGGY_CSV = `/**
 * Parse RFC-4180 CSV text into rows of string fields.
 */
export function parseCsv(input: string): string[][] {
  if (input.length === 0) return [];
  const normalized = input.replace(/\\r\\n/g, "\\n");
  const lines = normalized.split("\\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const rows: string[][] = [];
  for (const line of lines) {
    const fields: string[] = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === "," && !inQuotes) {
        fields.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
    if (current.length > 0) {
      fields.push(current);
    }
    rows.push(fields);
  }
  return rows;
}
`;

const PROTECTED_TEST = `import { describe, expect, test } from "bun:test";
import { parseCsv } from "../src/csv";

describe("parseCsv (RFC-4180)", () => {
  test("parses basic rows and CRLF line endings", () => {
    expect(parseCsv("a,b,c\\r\\n1,2,3\\r\\n")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  test("preserves commas inside quoted fields", () => {
    expect(parseCsv('name,city\\n"Patel, Tanay","Newark, NJ"\\n')).toEqual([
      ["name", "city"],
      ["Patel, Tanay", "Newark, NJ"],
    ]);
  });

  test("unescapes doubled quotes inside quoted fields", () => {
    expect(parseCsv('id,quote\\n1,"He said ""hello"" loudly"\\n')).toEqual([
      ["id", "quote"],
      ["1", 'He said "hello" loudly'],
    ]);
  });

  test("keeps embedded newlines inside quoted fields on the same row", () => {
    expect(parseCsv('id,note\\n1,"line one\\nline two"\\n2,"ok"\\n')).toEqual([
      ["id", "note"],
      ["1", "line one\\nline two"],
      ["2", "ok"],
    ]);
  });

  test("preserves trailing and consecutive empty fields", () => {
    expect(parseCsv("a,b,c\\n1,,\\n,2,\\n")).toEqual([
      ["a", "b", "c"],
      ["1", "", ""],
      ["", "2", ""],
    ]);
  });

  test("handles empty input", () => {
    expect(parseCsv("")).toEqual([]);
  });
});
`;

async function eventually<T>(
  fn: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 180_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (done(value)) return value;
    await Bun.sleep(250);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for task to settle`);
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const base = await mkdtemp(join(tmpdir(), "mars-live-bugfix-"));
const source = join(base, "source");
const checksDir = join(base, "checks");
const stateRoot = join(base, "state");
const marsHome = join(base, "mars-home");

try {
  await mkdir(join(source, "src"), { recursive: true });
  await mkdir(join(source, "tests"), { recursive: true });
  await mkdir(checksDir, { recursive: true });
  await mkdir(marsHome, { recursive: true });

  await writeFile(
    join(source, "package.json"),
    JSON.stringify({ name: "csv-fixture", private: true }, null, 2) + "\n",
  );
  await writeFile(join(source, "src", "csv.ts"), BUGGY_CSV);
  await writeFile(join(source, "tests", "csv.test.ts"), PROTECTED_TEST);
  await writeFile(join(checksDir, "csv.test.ts"), PROTECTED_TEST);
  await writeFile(
    join(checksDir, "checks.json"),
    JSON.stringify(
      {
        schema_version: 1,
        checks: [
          {
            id: "csv-suite",
            label: "RFC-4180 CSV parser unit tests (protected)",
            argv: ["bun", "test", "tests/csv.test.ts"],
            protected_files: [{ path: "tests/csv.test.ts", source: "csv.test.ts" }],
            timeout_ms: 60_000,
          },
        ],
      },
      null,
      2,
    ),
  );

  // Run baseline check in Docker before the agent touches anything.
  const baselineProc = Bun.spawnSync({
    cmd: [
      "docker",
      "run",
      "--rm",
      "--network=none",
      "--read-only",
      "-v",
      `${source}:/workspace:ro`,
      "-w",
      "/workspace",
      values.image!,
      "bun",
      "test",
      "tests/csv.test.ts",
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  const baselineOutput =
    new TextDecoder().decode(baselineProc.stdout) +
    new TextDecoder().decode(baselineProc.stderr);

  if (
    values.model &&
    ![
      "openrouter/free",
      "google/gemma-4-31b-it:free",
      "nvidia/nemotron-3.5-super-vl:free",
    ].includes(values.model)
  ) {
    await mkdir(join(marsHome, ".mars"), { recursive: true });
    await writeFile(
      join(marsHome, ".mars", "models.json"),
      JSON.stringify({
        version: 1,
        providers: [
          {
            id: "openrouter",
            kind: "openai-compatible",
            baseUrl: "https://openrouter.ai/api/v1",
            apiKeyEnv: "OPENROUTER_API_KEY",
          },
        ],
        models: [
          {
            id: values.model,
            providerId: "openrouter",
            model: values.model,
            capabilities: { tools: true, vision: false, contextWindow: 128000 },
            pricing: { free: true },
          },
        ],
        routes: { default: [values.model] },
      }),
    );
  }

  const registry = await loadModelRegistry({
    cwd: source,
    home: marsHome,
    env: process.env,
  });

  const scope = {
    owner_id: "live-evidence",
    project_id: "csv-bugfix",
  };

  let modelRequests = 0;
  const requestStatuses: number[] = [];
  const resolvedModels: string[] = [];
  const startedAt = Date.now();

  const service = await createWorkbenchService({
    sourceRoot: source,
    stateRoot,
    scope,
    registry,
    port: 0,
    image: values.image!,
    checksFile: join(checksDir, "checks.json"),
    runtimeFactory: (runtime) =>
      openRuntimeSession({
        ...runtime,
        fetch: async (input, init) => {
          modelRequests += 1;
          const res = await fetch(input, init);
          requestStatuses.push(res.status);
          const clone = res.clone();
          clone
            .text()
            .then((body) => {
              const m = body.match(/"model"\s*:\s*"([^"]+)"/);
              if (m?.[1] && !resolvedModels.includes(m[1])) {
                resolvedModels.push(m[1]);
              }
            })
            .catch(() => undefined);
          return res;
        },
      }),
  });

  try {
    const connection = JSON.parse(
      await readFile(service.connectionFile, "utf8"),
    ) as { token: string };
    const client = new MarsClient(
      new HttpRpcTransport({
        rpcUrl: `${service.url}/v1/rpc`,
        getToken: async () => connection.token,
      }),
    );
    await client.describe();

    const task: Task = {
      schema_version: 1,
      task_id: randomUUID(),
      session_id: randomUUID(),
      scope,
      revision: 0,
      request:
        "Fix all RFC-4180 parsing bugs in src/csv.ts so that tests/csv.test.ts passes (escaped double quotes, embedded newlines inside quoted fields, and trailing/consecutive empty fields). Read src/csv.ts and tests/csv.test.ts, edit src/csv.ts, and run bun test tests/csv.test.ts to confirm.",
      acceptance_criteria: [
        "All 6 tests in tests/csv.test.ts pass under host verification in Docker with --network=none",
        "Source checkout remains untouched outside the isolated workspace",
      ],
      budget: {
        max_tokens: 200_000,
        max_usd: 0,
        max_duration_ms: 180_000,
        max_depth: 0,
        max_concurrency: 1,
      },
      status: "pending",
      specialist_revision: null,
      artifacts: [],
    };

    const created = await client.create(task);
    await client.start(created.task_id, {
      expectedRevision: 0,
      modelId: values.model!,
      approvals: { read: true, write: true, execute: true },
      requiredChecks: [{ kind: "host_test", check_id: "csv-suite" }],
    });

    const settled = await eventually(
      () => client.inspect(created.task_id),
      (t) => t.status !== "running" && t.status !== "pending",
    );
    const verification = await client.verification(created.task_id);
    const evidence = await client.evidence(created.task_id);
    const diff = await client.diff(created.task_id);
    const exported =
      verification.state === "verified" &&
      verification.candidate?.revision &&
      verification.patch_sha256
        ? await client.exportPatch(created.task_id, {
            revision: verification.candidate.revision,
            patchSha256: verification.patch_sha256,
          })
        : null;
    const sourceAfter = await readFile(join(source, "src", "csv.ts"), "utf8");
    const durationMs = Date.now() - startedAt;

    const receipt = {
      label: "live-openrouter-verified-bugfix",
      recorded_at: new Date().toISOString(),
      model_id: values.model!,
      resolved_models: resolvedModels,
      provider: "openrouter (free tier, $0.00)",
      docker_image: values.image!,
      network_policy: "docker --network=none",
      task_id: created.task_id,
      task_status: settled.status,
      model_requests: modelRequests,
      http_statuses: requestStatuses,
      duration_ms: durationMs,
      source_untouched: sourceAfter === BUGGY_CSV,
      source_csv_sha256: sha256(BUGGY_CSV),
      baseline_docker_exit_code: baselineProc.exitCode,
      baseline_docker_output: baselineOutput.trim(),
      verification_state: verification.state,
      patch_sha256: verification.patch_sha256 ?? null,
      candidate: verification.candidate ?? null,
      verification_record: verification.record ?? null,
      verify_records: evidence.verify_records,
      diff,
      export: exported,
    };

    const textReport = [
      `MARS Live Verified Bug-Fix Evidence (${receipt.recorded_at.slice(0, 10)})`,
      `Model: ${receipt.model_id}${resolvedModels.length ? ` (resolved: ${resolvedModels.join(", ")})` : ""} via OpenRouter (${receipt.provider})`,
      `Sandbox: Docker (${receipt.docker_image}, --network=none, protected host test overlay)`,
      `Task ID: ${receipt.task_id}`,
      "",
      "$ docker run --rm --network=none ... bun test tests/csv.test.ts  # baseline before agent",
      `exit_code=${baselineProc.exitCode}`,
      baselineOutput.trim(),
      "",
      `$ OPENROUTER_API_KEY=[redacted] bun scripts/live-verified-bugfix.ts --model ${receipt.model_id}`,
      `task_status=${settled.status}`,
      ...(settled.status !== "completed"
        ? [
            `task_detail=${JSON.stringify({
              summary: (settled as Record<string, unknown>).summary,
              failure_reason: (settled as Record<string, unknown>).failure_reason,
              stop_reason: (settled as Record<string, unknown>).stop_reason,
            })}`,
          ]
        : []),
      `model_requests=${modelRequests} (http_statuses=${JSON.stringify(requestStatuses)})`,
      `duration_ms=${durationMs}`,
      `source_checkout_untouched=${receipt.source_untouched}`,
      "",
      "Host Verification (independent Docker run against exact candidate revision)",
      `verification_state=${verification.state}`,
      `verified=${verification.record?.verified ?? false}`,
      `workspace_revision=${verification.candidate?.revision ?? "n/a"}`,
      `patch_sha256=${verification.patch_sha256 ?? "n/a"}`,
      `export_verified=${exported?.verified ?? false}`,
      `changed_files=${diff.files.map((f) => f.path).join(", ") || "(none)"}`,
      "",
      "Exported Patch (exact verified bytes)",
      diff.files.map((f) => f.patch).filter(Boolean).join("\n").trim() ||
        "(no patch exported)",
      "",
      "Honest Limits",
      "- Single self-contained TypeScript RFC-4180 CSV bug-fix fixture (6 unit tests, 3 distinct bugs) run on OpenRouter free tier ($0.00).",
      "- Proves end-to-end live-model editing, workspace isolation, no-network Docker host verification with protected test overlay, and exact patch export.",
      "- Does not prove general benchmark superiority over other agents; see mars bench edit-formats for matched multi-repo evaluation.",
      "",
    ].join("\n");

    if (values["out-json"]) {
      await writeFile(values["out-json"], JSON.stringify(receipt, null, 2) + "\n");
    }
    if (values["out-txt"]) {
      await writeFile(values["out-txt"], textReport);
    }

    console.log(textReport);
    process.exitCode = verification.state === "verified" ? 0 : 1;
  } finally {
    await service.close();
  }
} finally {
  await rm(base, { recursive: true, force: true });
}
