import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RequestContext } from "@mars/contracts";
import { createMemoryStore } from "@mars/memory";

const entrypoint = resolve(import.meta.dir, "main.ts");
const ctx: RequestContext = {
  schema_version: 1,
  scope: { owner_id: "local", project_id: "demo" },
  request_id: "memory-cli-seed",
};

async function run(args: string[]) {
  const child = Bun.spawn([process.execPath, entrypoint, "memory", ...args], {
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

async function seed(state: string, facts: string[]) {
  const memory = createMemoryStore({ rootDir: join(state, "memory") });
  const ids: string[] = [];
  for (const fact of facts)
    ids.push(
      (
        await memory.submitProposal(ctx, {
          source: "background_review:session:review-1",
          rationale: `Lesson: ${fact}`,
          expected_revision: 0,
          task_id: "task-1",
          operations: [
            {
              operation: "add",
              entry: {
                entry_id: fact.replaceAll(" ", "-"),
                scope: ctx.scope,
                target: "project",
                fact,
                revision: 0,
                source_event_ids: ["review:review-1"],
                observed_at: "2026-01-01T00:00:00.000Z",
                verified_at: null,
                supersedes: null,
                deleted: false,
              },
            },
          ],
        })
      ).proposal_id,
    );
  await memory.close();
  return ids;
}

async function facts(state: string) {
  const memory = createMemoryStore({ rootDir: join(state, "memory") });
  try {
    const snapshot = await memory.snapshot(ctx);
    return {
      revision: snapshot.revision,
      facts: snapshot.entries.map((e) => e.fact),
    };
  } finally {
    await memory.close();
  }
}

test("mars memory proposals list/accept/reject/revert drive the reviewed-lesson lifecycle", async () => {
  const root = mkdtempSync(join(tmpdir(), "mars-memory-cli-"));
  const state = join(root, "state");
  try {
    const [keep, drop] = await seed(state, ["Run bun test", "Use npm"]);
    const base = ["--state", state, "--project", "demo"];

    const listed = await run([
      "proposals",
      "list",
      ...base,
      "--task",
      "task-1",
    ]);
    expect(listed.stderr).toBe("");
    expect(listed.exit).toBe(0);
    expect(listed.stdout).toContain("memory revision 0; 2 proposal(s)");
    expect(listed.stdout).toContain(`${keep} [pending] Lesson: Run bun test`);
    expect(listed.stdout).toContain("task task-1");
    expect(listed.stdout).toContain("+ Run bun test");

    const accepted = await run([
      "proposals",
      "accept",
      keep as string,
      ...base,
      "--actor",
      "alice",
      "--json",
    ]);
    expect(accepted.exit).toBe(0);
    expect(JSON.parse(accepted.stdout)).toMatchObject({
      proposal_id: keep,
      status: "accepted",
      resolved_by: "alice",
      task_id: "task-1",
      applied_revision: 1,
    });
    const rejected = await run([
      "proposals",
      "reject",
      drop as string,
      ...base,
      "--reason",
      "Wrong tool",
    ]);
    expect(rejected.exit).toBe(0);
    expect(rejected.stdout).toContain("[rejected]");
    expect(rejected.stdout).toContain("by local");
    expect(await facts(state)).toEqual({
      revision: 1,
      facts: ["Run bun test"],
    });

    const stale = await run([
      "proposals",
      "revert",
      keep as string,
      ...base,
      "--expected-revision",
      "0",
    ]);
    expect(stale.exit).toBe(1);
    expect(stale.stdout).toBe("");
    expect(stale.stderr).toContain('failed: conflict {"current_revision":1}');
    const reverted = await run([
      "proposals",
      "revert",
      keep as string,
      ...base,
      "--expected-revision",
      "1",
      "--reason",
      "Superseded",
      "--actor",
      "alice",
    ]);
    expect(reverted.exit).toBe(0);
    expect(reverted.stdout).toContain("[reverted]");
    expect(reverted.stdout).toContain("by alice at revision 2");
    expect(reverted.stdout).toContain("revert reason: Superseded");
    expect(await facts(state)).toEqual({ revision: 2, facts: [] });

    const json = JSON.parse(
      (
        await run([
          "proposals",
          "list",
          ...base,
          "--status",
          "reverted",
          "--json",
        ])
      ).stdout,
    );
    expect(json.memory_revision).toBe(2);
    expect(
      json.proposals.map((p: { proposal_id: string }) => p.proposal_id),
    ).toEqual([keep]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test("mars memory proposals rejects malformed invocations before opening the store", async () => {
  for (const [args, message] of [
    [["proposals", "accept"], "exactly one PROPOSAL_ID"],
    [["proposals", "reject", "p1"], "requires --reason"],
    [["proposals", "revert", "p1"], "requires --expected-revision"],
    [
      ["proposals", "revert", "p1", "--expected-revision", "1.5"],
      "requires --expected-revision",
    ],
    [["proposals", "list", "--status", "maybe"], "--status must be one of"],
    [["proposals", "list", "--bogus"], "Unknown option"],
    [["proposals", "erase", "p1"], 'Unknown memory proposals command "erase"'],
    [["skills"], 'Unknown memory command "skills"'],
  ] as const) {
    const result = await run([...args]);
    expect(result.exit).toBe(1);
    expect(result.stderr).toContain(message);
  }
  const help = await run([]);
  expect(help.exit).toBe(0);
  expect(help.stdout).toContain("mars memory proposals");
}, 60_000);
