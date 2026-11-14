import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SkillOutcomeLedger, SkillStore } from "@mars/skills";

const entrypoint = resolve(import.meta.dir, "main.ts");
const skill = (name: string, body: string) =>
  `---\nname: ${name}\ndescription: How to ${name}.\n---\n${body}\n`;

test("trials and reports support imported skills, scopes, JSON and complete text evidence", async () => {
  const state = mkdtempSync(join(tmpdir(), "mars-evidence-cli-"));
  try {
    const source = join(state, "checkout");
    mkdirSync(join(source, ".agents", "skills", "imported"), {
      recursive: true,
    });
    writeFileSync(
      join(source, ".agents", "skills", "imported", "SKILL.md"),
      skill("imported", "Check fixtures."),
    );
    const cli = (args: string[]) => run(state, [...args, "--source", source]);
    expect((await cli(["report"])).stdout).toContain("No evidence recorded.");
    expect(JSON.parse((await cli(["report", "--json"])).stdout)).toEqual([]);
    const file = join(state, "pairs.json");
    writeFileSync(
      file,
      JSON.stringify(
        Array.from({ length: 10 }, (_, i) => ({
          task_id: `t${i}`,
          baseline: { verified: i >= 6, cost_usd: 1 },
          candidate: { verified: true, cost_usd: 1 },
        })),
      ),
    );
    const emptyScope = await cli(["trials", "imported", "--trials", file]);
    expect(emptyScope.exit).not.toBe(0);
    expect(emptyScope.stderr).toContain("known scopes: (none)");
    expect(
      (await cli(["trials", "imported", "--trials", file, "--scope", "repo"]))
        .exit,
    ).toBe(0);
    expect((await cli(["trials", "imported", "--trials", file])).exit).toBe(0);
    const ledger = new SkillOutcomeLedger(
      join(state, "skill-outcomes", "outcomes.sqlite"),
    );
    ledger.record({
      scope_key: "repo",
      task_id: "observed",
      skills: [{ name: "imported", sha256: "a".repeat(64) }],
      verified: true,
      cost_usd: 2,
      recorded_at: 1,
    });
    ledger.record({
      scope_key: "other",
      task_id: "empty",
      skills: [],
      verified: false,
      recorded_at: 1,
    });
    ledger.close();
    const report = await cli([
      "report",
      "imported",
      "--scope",
      "repo",
      "--json",
    ]);
    expect(report.exit).toBe(0);
    expect(JSON.parse(report.stdout)).toMatchObject([
      {
        skill: "imported",
        scope_key: "repo",
        verdict: "helps",
        provenance: {
          origin: ".agents/skills",
          path: ".agents/skills/imported/SKILL.md",
        },
        with: { cost_per_verified_solve: 2 },
      },
    ]);
    const text = await cli(["report", "imported"]);
    expect(text.exit).toBe(0);
    for (const fragment of [
      ".agents/skills",
      "tasks=1",
      "Wilson 95%",
      "difference=",
      "cost per verified solve=",
      "trials=10, wins=6, losses=0, ties=4, discordant=6",
      "p (helps)=0.01563",
      "p (hurts)=",
      "cost ratio=1.000",
      "verdict=helps",
      "reasons=none",
      "alpha=0.05, min_trials=10, max_regressions=0, max_cost_ratio=1.25",
    ])
      expect(text.stdout).toContain(fragment);
    const ambiguous = await cli(["trials", "imported", "--trials", file]);
    expect(ambiguous.exit).not.toBe(0);
    expect(ambiguous.stderr).toContain('known scopes: "other", "repo"');
    expect(
      JSON.parse((await cli(["report", "missing", "--json"])).stdout),
    ).toEqual([]);
    writeFileSync(file, "{}");
    expect(
      (await cli(["trials", "imported", "--trials", file, "--scope", "repo"]))
        .exit,
    ).not.toBe(0);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
}, 60_000);

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
    const ungated = await run(state, ["accept", proposal.id]);
    expect(ungated.exit).not.toBe(0);
    expect(ungated.stderr).toContain("gate-required");
    expect(
      (await run(state, ["proposals", "--status", "pending"])).stdout,
    ).toContain("    gate: none yet");
    const trials = join(state, "trials.json");
    const pair = (task_id: string, baseline: boolean) => ({
      task_id,
      baseline: { verified: baseline, cost_usd: 1 },
      candidate: { verified: true, cost_usd: 1 },
    });
    writeFileSync(
      trials,
      JSON.stringify([
        ...Array.from({ length: 6 }, (_, i) => pair(`held-${i}`, false)),
        ...Array.from({ length: 4 }, (_, i) => pair(`tie-${i}`, true)),
      ]),
    );
    expect(
      (await run(state, ["gate", proposal.id, "--trials", trials])).exit,
    ).not.toBe(0);
    const overlap = await run(state, [
      "gate",
      proposal.id,
      "--trials",
      trials,
      "--evidence",
      "held-0",
    ]);
    expect(overlap.exit).toBe(0);
    expect(overlap.stdout).toContain("failed (evidence-overlap)");
    expect((await run(state, ["accept", proposal.id])).exit).not.toBe(0);
    const gate = JSON.parse(
      (
        await run(state, [
          "gate",
          proposal.id,
          "--trials",
          trials,
          "--evidence",
          "learned-1,learned-2",
          "--json",
        ])
      ).stdout,
    );
    expect(gate.passed).toBe(true);
    const verdicts = JSON.parse(
      (await run(state, ["gates", proposal.id, "--json"])).stdout,
    );
    expect(verdicts.gates.map((g: { passed: boolean }) => g.passed)).toEqual([
      false,
      true,
    ]);
    const accepted = await run(state, [
      "accept",
      proposal.id,
      "--actor",
      "tanay",
    ]);
    expect(accepted.stderr).toBe("");
    expect(accepted.exit).toBe(0);
    expect(accepted.stdout).toContain(
      `gate passed (${gate.digest.slice(0, 12)})`,
    );
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
    expect(
      (await run(state, ["accept", reviewed.id, "--without-gate"])).exit,
    ).not.toBe(0);
    const forced = await run(state, [
      "accept",
      reviewed.id,
      "--without-gate",
      "--reason",
      "no model key yet",
    ]);
    expect(forced.exit).toBe(0);
    expect(forced.stdout).toContain("gate skipped (recorded)");
    expect(
      JSON.parse((await run(state, ["gates", reviewed.id, "--json"])).stdout)
        .overrides,
    ).toMatchObject([{ actor: "local", reason: "no model key yet" }]);
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

test("mars skills list shows installed repository provenance separately from lifecycle skills", async () => {
  const state = mkdtempSync(join(tmpdir(), "mars-skills-provenance-cli-"));
  const source = resolve(
    import.meta.dir,
    "../../../packages/skills/test/fixtures/discovery/skills-sh",
  );
  try {
    const listed = await run(state, ["list", "--source", source, "--json"]);
    expect(listed.exit).toBe(0);
    const report = JSON.parse(listed.stdout);
    expect(report.skills).toEqual([]);
    expect(report.repository.skills).toHaveLength(1);
    expect(report.repository.skills[0].provenance).toMatchObject({
      source: "example-org/release-skills",
      status: "match",
      computedHash:
        "7887cc385fafb06f6b621c1464cdaca016c852999bb960f9703bf16efcd45be1",
    });
    const text = await run(state, ["list", "--source", source]);
    expect(text.exit).toBe(0);
    expect(text.stdout).toContain("repository skills (untrusted): 1");
    expect(text.stdout).toContain(
      "release-guide [match] source=example-org/release-skills hash=7887cc",
    );
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});
