import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RequestContext, Task } from "@mars/contracts";
import { createTaskStore } from "@mars/tasks";

const entrypoint = resolve(import.meta.dir, "main.ts");
const sha = (text: string | Uint8Array) =>
  createHash("sha256").update(text).digest("hex");
const scope = { owner_id: "local", project_id: "p1" };
const context: RequestContext = { schema_version: 1, scope, request_id: "r" };

async function run(args: string[]) {
  const child = Bun.spawn([process.execPath, entrypoint, "datasets", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exit };
}

const task = (id: string): Task => ({
  schema_version: 1,
  task_id: id,
  session_id: `s-${id}`,
  scope,
  revision: 0,
  request: `Fix ${id}`,
  acceptance_criteria: ["done"],
  budget: {
    max_tokens: 1000,
    max_usd: 1,
    max_duration_ms: 1000,
    max_depth: 1,
    max_concurrency: 1,
  },
  status: "pending",
  specialist_revision: null,
  artifacts: [],
});

test("mars datasets build writes pinned splits from verified tasks and honours held-out files", async () => {
  const root = mkdtempSync(join(tmpdir(), "mars-datasets-cli-"));
  try {
    const state = join(root, "state");
    const source = join(root, "src");
    Bun.spawnSync(["mkdir", "-p", source]);
    const store = await createTaskStore({
      rootDir: join(state, "tasks"),
      workspaceRoots: [source],
    });
    const emit = (id: string, payload: unknown) =>
      store.appendEvent(context, id, {
        event_type: "tool.completed",
        run_id: `run-${id}`,
        producer: "@mars/workbench",
        versions: [{ component: "@mars/workbench", revision: "1" }],
        payload,
      });
    for (const id of ["a", "b", "c", "held"]) {
      const patch = `--- a/${id}\n+++ b/${id}\n@@ -1 +1 @@\n-x\n+y\n`;
      await store.create(context, task(id));
      await store.update(context, id, 0, { status: "running" });
      await store.update(context, id, 1, { status: "completed" });
      await emit(id, {
        schema_version: 1,
        operation: "verification.verdict",
        run_id: `run-${id}`,
        task_id: id,
        task_revision: 1,
        candidate: { workspace_id: "w", provider: "local", revision: "r1" },
        verdict: "passed",
        verified: true,
        checks: [
          {
            kind: "file_content",
            path: "a.txt",
            expected_sha256: sha("x"),
            observed_sha256: sha("x"),
            status: "passed",
            reason: null,
            duration_ms: 1,
          },
        ],
        reasons: [],
        diagnostics: [],
        duration_ms: 1,
        recorded_at: new Date(0).toISOString(),
        patch_sha256: sha(patch),
      });
      await emit(id, {
        operation: "patch.exported",
        round_trip: "passed",
        artifact: await store.artifacts.put(
          context,
          new TextEncoder().encode(patch),
          "text/x-diff",
        ),
      });
    }
    await store.close();
    const heldOut = join(root, "holdout.json");
    writeFileSync(
      heldOut,
      JSON.stringify({ target_id: "t", final_holdout: ["held"] }),
    );
    const out = join(root, "out");
    const args = [
      "build",
      "--id",
      "pilot-1",
      "--out",
      out,
      "--held-out",
      heldOut,
      "--state",
      state,
      "--source",
      source,
      "--project",
      "p1",
      "--json",
    ];
    const built = await run(args);
    expect(built.stderr).toBe("");
    expect(built.exit).toBe(0);
    const manifest = JSON.parse(
      readFileSync(join(out, "manifest.json"), "utf8"),
    );
    expect(manifest.excluded).toEqual([
      { task_id: "held", reason: "held-out-task" },
    ]);
    const ids = manifest.splits.flatMap(
      (s: { task_ids: string[] }) => s.task_ids,
    );
    expect(ids.sort()).toEqual(["a", "b", "c"]);
    for (const split of manifest.splits)
      expect(sha(readFileSync(join(out, `${split.split}.jsonl`)))).toBe(
        split.sha256,
      );
    // Never overwrites an existing dataset.
    const again = await run(args);
    expect(again.exit).not.toBe(0);
    expect(again.stderr).toContain("already exists");
    // A directory holding an unrelated file is refused and left untouched.
    const occupied = join(root, "occupied");
    Bun.spawnSync(["mkdir", "-p", occupied]);
    writeFileSync(join(occupied, "manifest.json"), "{}");
    const blocked = await run([
      ...args.slice(0, 4),
      occupied,
      ...args.slice(5),
    ]);
    expect(blocked.exit).not.toBe(0);
    expect(readdirSync(occupied)).toEqual(["manifest.json"]);
    expect(readdirSync(root).filter((n) => n.startsWith("."))).toEqual([]);
    // A malformed held-out file is refused rather than ignored.
    writeFileSync(heldOut, JSON.stringify({ nope: true }));
    const bad = await run([
      ...args.slice(0, 4),
      join(root, "out2"),
      ...args.slice(5),
    ]);
    expect(bad.exit).not.toBe(0);
    expect(bad.stderr).toContain("Unrecognized held-out file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
