import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { RequestContext } from "@mars/contracts";
import {
  createMemoryStore,
  formatSnapshot,
  MemoryStoreError,
  scanThreat,
} from "@mars/memory";
import { SkillStore } from "@mars/skills";
import { runVault } from "../../../apps/cli/src/vault";
import { createDerivedArtifactStore } from "../../context/src/index";
import { createKnowledgeGraphService } from "../../knowledge-graph/src/index";
import { loadModelRegistry } from "../../providers/src/index";
import {
  createRegistryReviewGateway,
  type ReviewModelGateway,
  ReviewRunner,
} from "../../review/src/index";
import {
  type ExportReport,
  type ImportReport,
  parseNote,
  parseYaml,
  type StatusReport,
} from "../src/index";

const LIVE_ENABLED = process.env.MARS_LIVE_E2E === "1";
const GRAPHIFY_BIN = process.env.MARS_GRAPHIFY_BIN?.trim();
const OPENROUTER_KEY = (
  process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY
)?.trim();
const REQUESTED_MODEL = (
  process.env.MARS_LIVE_MODEL ?? "openrouter/free"
).trim();
const EVIDENCE_OUT = process.env.MARS_LIVE_EVIDENCE_OUT?.trim();
const REPO_MEMORY_DIR = resolve(import.meta.dir, "../../memory");

function assertFreeOpenRouterModel(modelId: string): void {
  if (modelId !== "openrouter/free" && !modelId.endsWith(":free")) {
    throw new Error(
      `Refusing non-free OpenRouter model "${modelId}" on $0.00 budget; use "openrouter/free" or a ":free" model ID.`,
    );
  }
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".")) continue;
      out.push(...(await listMarkdownFiles(full)));
    } else if (entry.name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out.sort();
}

async function runVaultJson<T>(argv: string[]): Promise<T> {
  const lines: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  try {
    await runVault(argv);
  } finally {
    console.log = origLog;
  }
  return JSON.parse(lines.join("\n")) as T;
}

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function runMemoryGraphVaultE2E(options: {
  mode: "live" | "deterministic";
  graphifyBin: string;
  evidenceOut?: string | undefined;
}): Promise<void> {
  if (options.mode === "live") {
    assertFreeOpenRouterModel(REQUESTED_MODEL);
  }

  const base = await mkdtemp(join(tmpdir(), "mars-live-e2e-"));
  dirs.push(base);
  const stateDir = join(base, "state");
  const memoryRoot = join(stateDir, "memory");
  const skillsRoot = join(stateDir, "skills");
  const vaultDir = join(base, "vault");
  const sourceDir = join(base, "source");
  await mkdir(sourceDir, { recursive: true });

  const workspaceId = "ws-memory";
  const ctx: RequestContext = {
    schema_version: 1,
    scope: {
      owner_id: "local",
      project_id: "mars-live-e2e",
      workspace_id: workspaceId,
    },
    request_id: "live-e2e-request",
  };

  // -----------------------------------------------------------------------
  // 1. Real graphifyy==0.9.101 build & query (mars_graph_build / mars_graph_query)
  // -----------------------------------------------------------------------
  const artifacts = createDerivedArtifactStore({
    rootDir: join(base, "artifacts"),
  });
  const kg = createKnowledgeGraphService({
    command: [options.graphifyBin],
    dataRoot: join(base, "kg-data"),
    artifacts,
  });

  const doctor = await kg.doctor();
  expect(doctor.available).toBe(true);
  expect(doctor.version).toBe("0.9.101");

  let revision = "rev-live-1";
  const binding = {
    task_id: "live-graph-task",
    owner_id: ctx.scope.owner_id,
    project_id: ctx.scope.project_id,
    workspace_id: workspaceId,
    cwd: REPO_MEMORY_DIR,
    revision,
    currentRevision: async () => revision,
    approvals: { read: true },
  };

  const built = await kg.build(binding);
  expect(built.status).toBe("built");
  if (built.status !== "built") throw new Error("graph build failed");

  const graphTools = kg.toolsFor(binding);
  const buildText = await graphTools.build();
  expect(buildText).toContain("mars_graph_build · built");

  const communitiesText = await graphTools.query({
    kind: "communities",
    limit: 5,
  });
  expect(communitiesText).toContain("mars_graph_query · communities");

  const neighboursText = await graphTools.query({
    kind: "neighbours",
    node: "DurableMemoryStore",
    depth: 1,
    limit: 8,
  });
  expect(neighboursText).toContain("mars_graph_query · neighbours");
  expect(neighboursText).toContain("DurableMemoryStore");

  const pathsText = await graphTools.query({
    kind: "paths",
    from: "DurableMemoryStore",
    to: "scanThreat",
    max_depth: 4,
    limit: 3,
  });
  expect(pathsText).toContain("mars_graph_query · paths");

  // Write the derived graph artifact JSON for `mars vault export --graph`
  const graphArtifactPath = join(base, "graph-artifact.json");
  await writeFile(
    graphArtifactPath,
    JSON.stringify(built.artifact, null, 2),
    "utf8",
  );

  // Verify stale revision fencing on graph queries
  revision = "rev-live-2";
  const staleGraphText = await graphTools.query({ kind: "communities" });
  expect(staleGraphText).toContain("mars_graph_query · stale");

  // -----------------------------------------------------------------------
  // 2. Live OpenRouter :free model task -> Hermes memory proposal + threat scan + accept
  // -----------------------------------------------------------------------
  const memory = createMemoryStore({
    rootDir: memoryRoot,
    hostPrivateRoots: [base, stateDir, memoryRoot, skillsRoot],
  });
  const skills = new SkillStore(skillsRoot);

  try {
    // Seed one skill so `mars vault export` exports memory + skills + code graph.
    await skills.create(
      "verify-memory-graph",
      [
        "---",
        "name: verify-memory-graph",
        "description: Verify Hermes memory, real graphify code graph, and Obsidian vault round-trips.",
        "---",
        "",
        "## Steps",
        "",
        "1. Run `bun test packages/knowledge-graph`.",
        "2. Run `mars vault export` and `mars vault import`.",
        "",
      ].join("\n"),
      { actor: "live-verifier", source: "live-e2e" },
    );

    // Verify invisible-Unicode threat scanning rejects hidden payloads.
    expect(scanThreat("Safe\u200blesson")).toBe("invisible_unicode");
    let rejectedThreat: unknown;
    try {
      await memory.submitProposal(ctx, {
        task_id: "live-task-1",
        source: "live-threat-check",
        rationale: "verify invisible-Unicode rejection",
        expected_revision: 0,
        operations: [
          {
            operation: "add",
            entry: {
              entry_id: "threat-invisible-1",
              scope: ctx.scope,
              target: "project",
              fact: "Always check\u200b revisions before writing.",
              revision: 0,
              source_event_ids: ["live-threat-check:1"],
              observed_at: new Date().toISOString(),
              verified_at: null,
              supersedes: null,
              deleted: false,
            },
          },
        ],
      });
    } catch (error) {
      rejectedThreat = error;
    }
    expect(rejectedThreat).toBeInstanceOf(MemoryStoreError);
    expect((rejectedThreat as MemoryStoreError).code).toBe("invalid_input");
    expect((rejectedThreat as MemoryStoreError).details).toEqual({
      threat: "invisible_unicode",
    });

    const httpStatuses: number[] = [];
    const resolvedModels: string[] = [];
    let gateway: ReviewModelGateway;
    if (options.mode === "live") {
      // Configure OpenRouter :free provider via built-in ModelProviderRegistry ($0.00 only).
      const registry = await loadModelRegistry({
        cwd: sourceDir,
        env: { OPENROUTER_API_KEY: OPENROUTER_KEY },
      });
      const trackedFetch = async (
        input: string,
        init?: RequestInit,
      ): Promise<Response> => {
        const res = await fetch(input, init);
        httpStatuses.push(res.status);
        const cloned = res.clone();
        try {
          const body = (await cloned.json()) as { model?: string };
          if (typeof body.model === "string") resolvedModels.push(body.model);
        } catch {
          // Non-JSON response; leave resolvedModels as-is.
        }
        return res;
      };
      gateway = createRegistryReviewGateway({
        registry,
        model: REQUESTED_MODEL,
        env: { OPENROUTER_API_KEY: OPENROUTER_KEY },
        fetch: trackedFetch,
      });
    } else {
      gateway = {
        id: "deterministic-review-gateway",
        complete: async () => ({
          model: "deterministic-review-gateway",
          toolCalls: 0,
          finishReason: "stop",
          text: JSON.stringify({
            proposals: [
              {
                tool: "memory.submitProposal",
                rationale:
                  "Prevents ENOENT on out/graphify-out/graph.json when GRAPHIFY_OUT is absolute.",
                ops: [
                  {
                    op: "add",
                    target: "memory",
                    content:
                      "When invoking graphify 0.9.101, always pin GRAPHIFY_OUT to join(dataRoot, 'out', 'graphify-out') so pathlib writes graph.json where the service reads it.",
                  },
                ],
              },
            ],
          }),
        }),
      };
    }

    const reviewTranscript = [
      {
        role: "user" as const,
        content:
          "Fix the real graphifyy 0.9.101 CLI wrapper in packages/knowledge-graph so graph.json is written to out/graphify-out and verify it with bun test.",
      },
      {
        role: "tool" as const,
        content:
          "graphify 0.9.101 failed with ENOENT at out/graphify-out/graph.json because graphify resolves Path(out_root) / GRAPHIFY_OUT and drops out_root when GRAPHIFY_OUT is absolute.",
      },
      {
        role: "assistant" as const,
        content:
          "Fixed packages/knowledge-graph/src/cli.ts by setting GRAPHIFY_OUT to join(dataRoot, 'out', 'graphify-out'). Verified with real graphifyy 0.9.101 (162 nodes, 447 edges, 8 communities) and 16/16 unit tests passing. Durable repo lesson: when invoking graphify 0.9.101, always pin GRAPHIFY_OUT to join(dataRoot, 'out', 'graphify-out') so pathlib writes graph.json where the service reads it.",
      },
    ];

    // Free-tier router models can intermittently rate-limit or emit non-JSON;
    // retry up to 5 times with a fresh runner and short backoff while staying
    // strictly on the $0.00 free model.
    let succeededTaskId = "live-task-1";
    let reviewResult: Awaited<ReturnType<ReviewRunner["reviewNow"]>> = {
      reviewId: "",
      status: "skipped",
      proposals: [],
    };
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      if (attempt > 1) {
        await new Promise((r) => setTimeout(r, 2_000));
      }
      succeededTaskId = `live-task-${attempt}`;
      const runner = new ReviewRunner({
        context: ctx,
        memory,
        skills,
        model: gateway,
        logRoot: join(base, "review-logs"),
        idleMs: 60_000,
        timeoutMs: 60_000,
      });
      try {
        reviewResult = await runner.reviewNow({
          sessionId: `live-session-${attempt}`,
          taskId: succeededTaskId,
          origin: "foreground",
          iterations: 3,
          success: true,
          transcript: reviewTranscript,
        });
      } finally {
        runner.stop();
      }
      if (
        reviewResult.status === "completed" &&
        reviewResult.proposals.length > 0
      ) {
        break;
      }
    }

    if (reviewResult.status !== "completed") {
      throw new Error(
        `Live review failed: ${JSON.stringify({ reviewResult, httpStatuses, resolvedModels })}`,
      );
    }
    expect(reviewResult.status).toBe("completed");
    // Review only proposes: live memory must still be untouched at revision 0.
    const beforeAccept = await memory.snapshot(ctx);
    expect(beforeAccept.revision).toBe(0);
    expect(beforeAccept.entries).toHaveLength(0);

    const pendingProposals = await memory.listProposals(ctx, "pending", {
      task_id: succeededTaskId,
    });
    expect(pendingProposals.length).toBeGreaterThanOrEqual(1);
    const liveProposal = pendingProposals[0];
    if (!liveProposal)
      throw new Error("expected at least one pending proposal");
    expect(liveProposal.operations.length).toBeGreaterThanOrEqual(1);
    const firstAdd = liveProposal.operations.find(
      (op) => op.operation === "add",
    );
    expect(firstAdd).toBeDefined();
    const liveLesson =
      firstAdd && firstAdd.operation === "add" ? firstAdd.entry.fact : "";
    expect(liveLesson.length).toBeGreaterThan(10);
    // Confirm the live-model proposal passed invisible-Unicode threat scanning.
    expect(scanThreat(liveLesson)).toBeUndefined();

    // Accept the live-model proposal through supported memory API.
    const acceptedProposal = await memory.acceptProposal(
      ctx,
      liveProposal.proposal_id,
      { resolved_by: "live-verifier" },
    );
    expect(acceptedProposal.status).toBe("accepted");
    expect(acceptedProposal.applied_revision).toBe(1);

    // ---------------------------------------------------------------------
    // 4a. Confirm accepted lesson appears in follow-up task's frozen memory context
    // ---------------------------------------------------------------------
    const frozenAfterAccept = await memory.snapshot(ctx);
    expect(frozenAfterAccept.revision).toBe(1);
    const frozenPromptAfterAccept = formatSnapshot(frozenAfterAccept);
    expect(frozenPromptAfterAccept).toContain(liveLesson);

    // ---------------------------------------------------------------------
    // 3. Obsidian-compatible vault export -> validate YAML & wikilinks -> edit/add -> import -> status
    // ---------------------------------------------------------------------
    const commonArgs = [
      "--vault",
      vaultDir,
      "--state",
      stateDir,
      "--source",
      sourceDir,
      "--owner",
      ctx.scope.owner_id,
      "--project",
      ctx.scope.project_id,
      "--workspace",
      workspaceId,
      "--actor",
      "live-verifier",
      "--json",
    ];

    const exportReport = await runVaultJson<ExportReport>([
      "export",
      ...commonArgs,
      "--graph",
      graphArtifactPath,
    ]);
    expect(exportReport.memory_revision).toBe(1);
    expect(exportReport.written).toBeGreaterThanOrEqual(4);
    expect(exportReport.notes.memory_fact).toBeGreaterThanOrEqual(1);
    expect(exportReport.notes.skill).toBeGreaterThanOrEqual(1);
    expect(exportReport.notes.graph_index).toBeGreaterThanOrEqual(1);
    expect(exportReport.notes.graph_community).toBeGreaterThanOrEqual(1);
    expect(exportReport.notes.graph_file).toBeGreaterThanOrEqual(1);

    // Validate YAML frontmatter and Obsidian wikilinks across exported Markdown files.
    const exportedMdFiles = await listMarkdownFiles(vaultDir);
    expect(exportedMdFiles.length).toBeGreaterThanOrEqual(4);
    let wikilinkFiles = 0;
    let exportedMemoryNotePath: string | undefined;
    for (const file of exportedMdFiles) {
      const raw = await readFile(file, "utf8");
      const parsed = parseNote(raw);
      expect(parsed.frontmatter).toBeDefined();
      // Also verify strict YAML frontmatter parsing on raw frontmatter block.
      const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
      expect(fmMatch).not.toBeNull();
      const yamlObj = parseYaml(fmMatch?.[1] ?? "");
      expect(yamlObj.mars_kind).toBeDefined();
      if (/\[\[[^\]]+\]\]/.test(raw)) wikilinkFiles += 1;
      if (yamlObj.mars_kind === "memory_fact" && !exportedMemoryNotePath) {
        exportedMemoryNotePath = file;
      }
    }
    expect(wikilinkFiles).toBeGreaterThanOrEqual(2);
    expect(exportedMemoryNotePath).toBeDefined();

    // Edit an exported memory note (inside the body before <!-- mars:related -->) AND add a new note in the vault.
    const originalNote = await readFile(
      exportedMemoryNotePath as string,
      "utf8",
    );
    const editedSuffix = " (verified via Obsidian vault round-trip)";
    const relatedMarker = "\n<!-- mars:related -->";
    const markerIdx = originalNote.lastIndexOf(relatedMarker);
    expect(markerIdx).toBeGreaterThan(0);
    const editedNote =
      originalNote.slice(0, markerIdx) +
      editedSuffix +
      originalNote.slice(markerIdx);
    await writeFile(exportedMemoryNotePath as string, editedNote, "utf8");

    const addedNotePath = join(
      dirname(exportedMemoryNotePath as string),
      "vault-added-lesson.md",
    );
    await writeFile(
      addedNotePath,
      [
        "---",
        "mars_kind: memory_fact",
        "target: project",
        "---",
        "",
        "Always run mars vault status before importing edited Obsidian notes.",
        "",
      ].join("\n"),
      "utf8",
    );

    // Run `mars vault status` before import.
    const statusBefore = await runVaultJson<StatusReport>([
      "status",
      ...commonArgs,
    ]);
    expect(statusBefore.memory.notes.modified).toBe(1);
    expect(statusBefore.memory.notes.added).toBe(1);
    expect(statusBefore.memory.pending_vault_proposals).toBe(0);

    // Run `mars vault import` -> must create revision-fenced pending proposals and NEVER write to SQLite directly.
    const importReport = await runVaultJson<ImportReport>([
      "import",
      ...commonArgs,
    ]);
    expect(importReport.proposals.memory.length).toBeGreaterThanOrEqual(2);

    // Verify SQLite live memory was NOT modified directly by `mars vault import`.
    const afterImportSnapshot = await memory.snapshot(ctx);
    expect(afterImportSnapshot.revision).toBe(1);
    expect(afterImportSnapshot.entries).toHaveLength(
      frozenAfterAccept.entries.length,
    );
    expect(
      afterImportSnapshot.entries.some((e) =>
        e.fact.includes("Always run mars vault status"),
      ),
    ).toBe(false);

    // Run `mars vault status` after import -> shows pending vault proposals.
    const statusAfter = await runVaultJson<StatusReport>([
      "status",
      ...commonArgs,
    ]);
    expect(statusAfter.memory.pending_vault_proposals).toBeGreaterThanOrEqual(
      2,
    );

    // Verify imported proposals are revision-fenced at expected_revision === 1.
    const vaultProposals = await memory.listProposals(ctx, "pending");
    const importedProposals = vaultProposals.filter((p) =>
      importReport.proposals.memory.includes(p.proposal_id),
    );
    expect(importedProposals.length).toBeGreaterThanOrEqual(2);
    for (const p of importedProposals) {
      expect(p.expected_revision).toBe(1);
    }

    // Reject the vault-imported proposals via supported API so we can cleanly test revert of the accepted live proposal.
    for (const p of importedProposals) {
      await memory.rejectProposal(
        ctx,
        p.proposal_id,
        "Verified pending revision-fenced vault import without direct SQLite writes",
        { resolved_by: "live-verifier" },
      );
    }

    // ---------------------------------------------------------------------
    // 4b. Revert the accepted live-model proposal and confirm the lesson disappears from frozen memory context
    // ---------------------------------------------------------------------
    const reverted = await memory.revertProposal(
      ctx,
      acceptedProposal.proposal_id,
      1,
      { resolved_by: "live-verifier" },
    );
    expect(reverted.status).toBe("reverted");

    const frozenAfterRevert = await memory.snapshot(ctx);
    expect(frozenAfterRevert.revision).toBeGreaterThan(1);
    expect(frozenAfterRevert.entries).toHaveLength(0);
    const frozenPromptAfterRevert = formatSnapshot(frozenAfterRevert);
    expect(frozenPromptAfterRevert).not.toContain(liveLesson);

    if (options.evidenceOut) {
      const receipt = {
        recorded_at: new Date().toISOString(),
        mode: options.mode,
        model:
          options.mode === "live"
            ? REQUESTED_MODEL
            : "deterministic-review-gateway",
        resolved_models: resolvedModels,
        http_statuses: httpStatuses,
        budget_usd: 0,
        graphify: {
          version: doctor.version,
          stats: built.artifact.stats,
          content_digest: built.artifact.content_digest,
          queries: {
            communities_preview: communitiesText.slice(0, 400),
            neighbours_preview: neighboursText.slice(0, 400),
            paths_preview: pathsText.slice(0, 400),
            stale_preview: staleGraphText.slice(0, 200),
          },
        },
        hermes_memory: {
          threat_scan_rejected_invisible_unicode: true,
          live_proposal_id: liveProposal.proposal_id,
          live_lesson: liveLesson,
          accepted_revision: acceptedProposal.applied_revision,
          present_in_followup_frozen_context:
            frozenPromptAfterAccept.includes(liveLesson),
          reverted_status: reverted.status,
          revision_after_revert: frozenAfterRevert.revision,
          present_after_revert: frozenPromptAfterRevert.includes(liveLesson),
        },
        obsidian_vault: {
          exported_files: exportedMdFiles.length,
          wikilink_files: wikilinkFiles,
          export_notes: exportReport.notes,
          status_before_import: statusBefore.memory.notes,
          import_pending_memory_proposals: importReport.proposals.memory.length,
          import_expected_revisions: importedProposals.map(
            (p) => p.expected_revision,
          ),
          sqlite_revision_unchanged_after_import:
            afterImportSnapshot.revision === 1,
          status_after_import_pending_proposals:
            statusAfter.memory.pending_vault_proposals,
        },
      };
      await writeFile(
        options.evidenceOut,
        JSON.stringify(receipt, null, 2),
        "utf8",
      );
    }
  } finally {
    await memory.close();
  }
}

describe.skipIf(!GRAPHIFY_BIN)(
  "E2E: Hermes memory + real graphifyy==0.9.101 + Obsidian vault round-trip (deterministic review gateway)",
  () => {
    test("end-to-end verification across real graphify, Hermes proposals, threat scan, vault export/import/status, frozen context, and revert", async () => {
      await runMemoryGraphVaultE2E({
        mode: "deterministic",
        graphifyBin: GRAPHIFY_BIN as string,
        evidenceOut: !LIVE_ENABLED && EVIDENCE_OUT ? EVIDENCE_OUT : undefined,
      });
    }, 120_000);
  },
);

describe.skipIf(!LIVE_ENABLED || !GRAPHIFY_BIN || !OPENROUTER_KEY)(
  "live E2E: Hermes memory + real graphifyy==0.9.101 + Obsidian vault round-trip ($0.00 OpenRouter :free)",
  () => {
    test("end-to-end live verification across graph, live-model memory proposals, vault export/import/status, frozen context, and revert", async () => {
      await runMemoryGraphVaultE2E({
        mode: "live",
        graphifyBin: GRAPHIFY_BIN as string,
        evidenceOut: EVIDENCE_OUT,
      });
    }, 120_000);
  },
);
