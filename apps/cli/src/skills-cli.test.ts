import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SkillStore } from "@mars/skills";

const entrypoint = resolve(import.meta.dir, "main.ts");
const skill = (name: string, body: string) =>
  `---\nname: ${name}\ndescription: How to ${name}.\n---\n${body}\n`;

async function run(state: string, args: string[]) {
  const child = Bun.spawn(
    [process.execPath, entrypoint, "skills", ...args, "--state", state],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exit };
}

test("mars skills drives the proposal, undo, pin, archive and version lifecycle", async () => {
  const state = mkdtempSync(join(tmpdir(), "mars-skills-cli-"));
  try {
    const store = new SkillStore(join(state, "skills"));
    const proposal = await store.submitProposal({
      source: "background_review:session-1:review-1",
      rationale: "Release notes lesson",
      ops: [
        {
          op: "create",
          name: "release-notes",
          content: skill("release-notes", "1. Collect merged PRs."),
        },
      ],
    });
    const rejected = await store.submitProposal({
      source: "background_review:session-1:review-2",
      rationale: "Unhelpful lesson",
      ops: [{ op: "create", name: "noise", content: skill("noise", "Noise.") }],
    });

    const listed = await run(state, [
      "proposals",
      "--status",
      "pending",
      "--json",
    ]);
    expect(listed.exit).toBe(0);
    expect(
      (JSON.parse(listed.stdout) as { id: string }[]).map((p) => p.id).sort(),
    ).toEqual([proposal.id, rejected.id].sort());

    expect((await run(state, ["reject", rejected.id])).exit).not.toBe(0);
    expect(
      (await run(state, ["reject", rejected.id, "--reason", "not supported"]))
        .exit,
    ).toBe(0);
    const accepted = await run(state, [
      "accept",
      proposal.id,
      "--actor",
      "tanay",
    ]);
    expect(accepted.stderr).toBe("");
    expect(accepted.exit).toBe(0);
    expect((await store.get("release-notes"))?.status).toBe("active");
    expect(await store.get("noise")).toBeNull();
    expect(
      (await store.listProposals()).find((p) => p.id === rejected.id)?.reason,
    ).toBe("not supported");

    const shown = await run(state, ["show", "release-notes"]);
    expect(shown.stdout).toContain("1. Collect merged PRs.");

    await store.update(
      "release-notes",
      skill("release-notes", "1. Collect merged PRs since the last tag."),
      { actor: "tanay", source: "operator" },
    );
    const versions = JSON.parse(
      (await run(state, ["versions", "release-notes", "--json"])).stdout,
    ) as { id: string }[];
    expect(versions.length).toBe(1);
    expect(
      (
        await run(state, [
          "restore-version",
          "release-notes",
          versions[0]?.id ?? "",
        ])
      ).exit,
    ).toBe(0);
    expect((await store.get("release-notes"))?.content).toContain(
      "1. Collect merged PRs.\n",
    );

    expect((await run(state, ["pin", "release-notes"])).exit).toBe(0);
    expect((await store.get("release-notes"))?.pinned).toBe(true);
    expect((await run(state, ["archive", "release-notes"])).exit).not.toBe(0);
    expect((await run(state, ["unpin", "release-notes"])).exit).toBe(0);
    expect((await run(state, ["archive", "release-notes"])).exit).toBe(0);
    expect(
      JSON.parse((await run(state, ["list", "--json"])).stdout).skills,
    ).toEqual([]);
    expect(
      JSON.parse((await run(state, ["list", "--all", "--json"])).stdout).skills
        .length,
    ).toBe(1);
    expect((await run(state, ["restore", "release-notes"])).exit).toBe(0);
    expect((await store.get("release-notes"))?.status).toBe("active");

    const reviewed = await store.submitProposal({
      source: "background_review:session-1:review-9",
      rationale: "Triage lesson",
      ops: [
        {
          op: "create",
          name: "triage",
          content: skill("triage", "Reproduce first."),
        },
      ],
    });
    // Idle curation of an unrelated skill must not invalidate this proposal.
    await store.runCurator({ actor: "curator", source: "curator" });
    const pending = await run(state, ["proposals", "--status", "pending"]);
    expect(pending.stdout).toContain("create triage:");
    expect(pending.stdout).toContain("      | Reproduce first.");
    expect((await run(state, ["accept", reviewed.id])).exit).toBe(0);
    expect((await store.get("triage"))?.status).toBe("active");
    expect((await run(state, ["undo", "review-9"])).exit).toBe(0);
    expect((await store.get("triage"))?.status).toBe("archived");
    expect((await run(state, ["curate"])).stdout).toContain(
      "Nothing to change.",
    );

    const unknown = await run(state, ["frobnicate"]);
    expect(unknown.exit).not.toBe(0);
    expect(unknown.stderr).toContain("Unknown skills command");
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
}, 60_000);
