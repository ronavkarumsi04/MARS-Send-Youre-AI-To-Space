/**
 * Live end-to-end verified bug-fix run through the real MARS workbench:
 * - Real hosted coding model via OpenRouter (configured through MARS model registry)
 * - Isolated private workspace (source checkout stays untouched)
 * - Host-defined protected test suite overlaid into a disposable --network=none Docker container
 * - Exact patch export & verification receipt bound to workspace revision and patch_sha256
 *
 * Run with --help for preflight and live usage.
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
import { createDockerSandbox } from "../packages/workspaces/src/index";

const DEFAULT_IMAGE =
  "oven/bun@sha256:5148f6742ac31fac28e6eab391ab1f11f6dfc0c8512c7a3679b374ec470f5982";
const DEFAULT_MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    help: { type: "boolean" },
    preflight: { type: "boolean" },
    model: { type: "string" },
    image: { type: "string" },
    "out-json": { type: "string" },
    "out-txt": { type: "string" },
  },
  strict: true,
});

const modelId = values.model ?? DEFAULT_MODEL;
const dockerImage = values.image ?? DEFAULT_IMAGE;

if (values.help) {
  console.log(`Usage: bun scripts/live-verified-bugfix.ts [options]

  --preflight       Run the buggy baseline in Docker without calling a model
  --model ID        Free OpenRouter model (default: ${DEFAULT_MODEL})
  --image IMAGE     Locally available Docker image pinned to sha256
                    Default: ${DEFAULT_IMAGE}
  --out-json FILE   Write a machine-readable live receipt
  --out-txt FILE    Write the live report
  --help            Show this message

Set OPENROUTER_API_KEY in the environment for a live run.`);
  process.exit(0);
}

if (modelId !== "openrouter/free" && !modelId.endsWith(":free")) {
  console.error(
    `Refusing non-free OpenRouter model "${modelId}"; pass "openrouter/free" or a ":free" model ID.`,
  );
  process.exit(1);
}
if (!values.preflight && !process.env.OPENROUTER_API_KEY?.trim()) {
  console.error(
    "Set OPENROUTER_API_KEY for a live run, or use --preflight without a key.",
  );
  process.exit(1);
}

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
    `${JSON.stringify({ name: "csv-fixture", private: true }, null, 2)}\n`,
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
            protected_files: [
              { path: "tests/csv.test.ts", source: "csv.test.ts" },
            ],
            timeout_ms: 60_000,
          },
        ],
      },
      null,
      2,
    ),
  );

  const baseline = await runBaseline();
  if (values.preflight) {
    console.log(
      `${baseline.output}\n\nPreflight passed: expected buggy baseline, model_requests=0.`,
    );
  } else {
    await runLive(baseline);
  }
} finally {
  await rm(base, { recursive: true, force: true });
}

async function runBaseline() {
  const sandbox = createDockerSandbox({ image: dockerImage });
  try {
    await sandbox.verify();
  } catch (cause) {
    throw new Error(`Start Docker and run: docker pull ${dockerImage}`, {
      cause,
    });
  }
  const result = await sandbox.run({
    workspaceDir: source,
    argv: ["bun", "test", "tests/csv.test.ts"],
    timeoutMs: 60_000,
    maxOutputBytes: 64_000,
    signal: new AbortController().signal,
    runId: randomUUID(),
    labels: {},
  });
  const decoder = new TextDecoder();
  const output =
    `${decoder.decode(result.stdout)}\n${decoder.decode(result.stderr)}`.trim();
  if (
    result.exitCode !== 1 ||
    result.stdoutTruncated ||
    result.stderrTruncated ||
    !/^\s*3 pass\s*$/m.test(output) ||
    !/^\s*3 fail\s*$/m.test(output)
  ) {
    throw new Error(
      `Expected the buggy CSV baseline to exit 1 with 3 passing and 3 failing tests; got exit ${result.exitCode}.\n${output}`,
    );
  }
  return { exitCode: result.exitCode, output };
}

async function runLive(baseline: Awaited<ReturnType<typeof runBaseline>>) {
  if (
    ![
      "openrouter/free",
      "google/gemma-4-31b-it:free",
      "nvidia/nemotron-3.5-super-vl:free",
    ].includes(modelId)
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
            id: modelId,
            providerId: "openrouter",
            model: modelId,
            capabilities: { tools: true, vision: false, contextWindow: 128000 },
            pricing: { free: true },
          },
        ],
        routes: { default: [modelId] },
      }),
    );
  }

  const registry = await loadModelRegistry({
    cwd: source,
    home: marsHome,
    env: { ...process.env, MARS_HOME: join(marsHome, ".mars") },
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
    image: dockerImage,
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
        "Fix all RFC-4180 parsing bugs in src/csv.ts so that tests/csv.test.ts passes (escaped double quotes, embedded newlines inside quoted fields, and trailing/consecutive empty fields). Read src/csv.ts and tests/csv.test.ts, edit only src/csv.ts, and run bun test tests/csv.test.ts to confirm.",
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
      modelId,
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
    const patch =
      exported?.verified && exported.artifact
        ? await client.artifact(created.task_id, exported.artifact)
        : null;
    const success =
      settled.status === "completed" &&
      requestStatuses.some((status) => status >= 200 && status < 300) &&
      sourceAfter === BUGGY_CSV &&
      diff.files.length === 1 &&
      diff.files[0]?.path === "src/csv.ts" &&
      verification.state === "verified" &&
      patch !== null &&
      patch.bytes.byteLength > 0 &&
      patch.ref.sha256 === verification.patch_sha256;
    const durationMs = Date.now() - startedAt;

    const receipt = {
      label: "live-openrouter-verified-bugfix",
      recorded_at: new Date().toISOString(),
      model_id: modelId,
      resolved_models: resolvedModels,
      provider: "openrouter (free tier, $0.00)",
      docker_image: dockerImage,
      network_policy: "docker --network=none",
      task_id: created.task_id,
      task_status: settled.status,
      success,
      model_requests: modelRequests,
      http_statuses: requestStatuses,
      duration_ms: durationMs,
      source_untouched: sourceAfter === BUGGY_CSV,
      source_csv_sha256: sha256(BUGGY_CSV),
      baseline_docker_exit_code: baseline.exitCode,
      baseline_docker_output: baseline.output,
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
      `exit_code=${baseline.exitCode}`,
      baseline.output,
      "",
      `$ OPENROUTER_API_KEY=[redacted] bun scripts/live-verified-bugfix.ts --model ${receipt.model_id}`,
      `task_status=${settled.status}`,
      `live_acceptance=${success ? "passed" : "failed"}`,
      ...(settled.status !== "completed"
        ? [
            `task_detail=${JSON.stringify({
              summary: (settled as Record<string, unknown>).summary,
              failure_reason: (settled as Record<string, unknown>)
                .failure_reason,
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
      patch ? new TextDecoder().decode(patch.bytes) : "(no patch exported)",
      "",
      "Honest Limits",
      "- Single self-contained TypeScript RFC-4180 CSV bug-fix fixture (6 unit tests, 3 distinct bugs) run on OpenRouter free tier ($0.00).",
      "- A passing run exercises live-model editing, workspace isolation, no-network Docker host verification with protected test overlay, and exact patch export via the typed client, not a VS Code window.",
      "- Does not prove general benchmark superiority over other agents; see mars bench edit-formats for matched multi-repo evaluation.",
      "",
    ].join("\n");

    if (values["out-json"]) {
      await writeFile(
        values["out-json"],
        `${JSON.stringify(receipt, null, 2)}\n`,
      );
    }
    if (values["out-txt"]) {
      await writeFile(values["out-txt"], textReport);
    }

    console.log(textReport);
    process.exitCode = success ? 0 : 1;
  } finally {
    await service.close();
  }
}
