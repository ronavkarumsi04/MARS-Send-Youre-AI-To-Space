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
import { join, resolve } from "node:path";
import { createDerivedArtifactStore } from "@mars/context";
import {
  createGraphifyRunner,
  createKnowledgeGraphService,
  sandboxEnvironment,
} from "../src/index";

const GRAPHIFY_BIN = process.env.MARS_GRAPHIFY_BIN?.trim();
const REPO_MEMORY_DIR = resolve(import.meta.dir, "../../memory");

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

describe.skipIf(!GRAPHIFY_BIN)("real graphifyy==0.9.101 integration", () => {
  test.each([
    ["absolute", ["--out", "$OUT"]],
    ["relative", ["--out", "../custom-output"]],
    ["equals", ["--out=$OUT"]],
    ["output alias", ["--output", "$OUT"]],
    ["output equals alias", ["--output=$OUT"]],
    ["last split alias wins", ["--out", "$IGNORED", "--output", "$OUT"]],
    ["last equals wins", ["--output=$IGNORED", "--out=$OUT"]],
    ["last repeated flag wins", ["--out", "$IGNORED", "--out", "$OUT"]],
    ["last equals alias wins", ["--out=$IGNORED", "--output=$OUT"]],
    [
      "no short flags or abbreviations",
      ["--out", "$OUT", "-o", "$IGNORED", "--ou=$IGNORED"],
    ],
    [
      "consumed values are not flags",
      ["--out", "$OUT", "--exclude", "--output=$IGNORED"],
    ],
    ["missing trailing value is ignored", ["--out", "$OUT", "--output"]],
    ["empty equals means cwd", ["--output="]],
  ] as const)(
    "real output parity: runner and no GRAPHIFY_OUT override (%s)",
    async (kind, flags) => {
      const base = await mkdtemp(join(tmpdir(), "mars-real-output-"));
      dirs.push(base);
      await Promise.all(
        ["runner", "baseline"].map(async (mode) => {
          const root = join(base, mode);
          const workspace = join(root, "workspace");
          const dataRoot = join(root, "state");
          await mkdir(workspace, { recursive: true });
          await mkdir(dataRoot);
          await writeFile(
            join(workspace, "tiny.ts"),
            "export function answer() { return 42; }\n",
          );
          const out =
            kind === "empty equals means cwd"
              ? workspace
              : join(root, "custom-output");
          const expectedGraph = join(out, "graphify-out", "graph.json");
          const args = [
            "extract",
            workspace,
            "--code-only",
            "--no-cluster",
            ...flags.map((flag) =>
              flag
                .replaceAll("$OUT", out)
                .replaceAll("$IGNORED", join(root, "ignored-output")),
            ),
          ];
          if (mode === "runner") {
            const runner = createGraphifyRunner({
              command: [GRAPHIFY_BIN as string],
              maxOutputBytes: 65536,
            });
            const result = await runner.run({
              args,
              cwd: workspace,
              dataRoot,
              timeoutMs: 30_000,
            });
            expect(result.exit_code, result.stdout + result.stderr).toBe(0);
            expect(result.timed_out).toBe(false);
            expect(result.spawn_error).toBeNull();
          } else {
            const env = sandboxEnvironment({ dataRoot });
            delete env.GRAPHIFY_OUT;
            const child = Bun.spawn([GRAPHIFY_BIN as string, ...args], {
              cwd: workspace,
              env,
              stdin: "ignore",
              stdout: "pipe",
              stderr: "pipe",
              signal: AbortSignal.timeout(30_000),
            });
            const [code, stdout, stderr] = await Promise.all([
              child.exited,
              new Response(child.stdout).text(),
              new Response(child.stderr).text(),
            ]);
            expect(code, stdout + stderr).toBe(0);
          }
          const graph = JSON.parse(await readFile(expectedGraph, "utf8")) as {
            nodes: unknown[];
          };
          expect(graph.nodes.length).toBeGreaterThan(0);
          const graphFiles = (await readdir(root, { recursive: true })).filter(
            (path) => path.endsWith("graph.json"),
          );
          expect(graphFiles.map((path) => join(root, path))).toEqual([
            expectedGraph,
          ]);
        }),
      );
    },
    60_000,
  );

  test("doctor, build, normalize, and query (communities, neighbours, paths, stale) through the real CLI wrapper", async () => {
    const base = await mkdtemp(join(tmpdir(), "mars-real-kg-"));
    dirs.push(base);

    const artifacts = createDerivedArtifactStore({
      rootDir: join(base, "artifacts"),
    });
    const kg = createKnowledgeGraphService({
      command: [GRAPHIFY_BIN as string],
      dataRoot: join(base, "kg-data"),
      artifacts,
    });

    const doctor = await kg.doctor();
    expect(doctor.available).toBe(true);
    expect(doctor.version).toBe("0.9.101");
    expect(doctor.reason).toBeNull();

    let revision = "rev-1";
    const binding = {
      task_id: "real-graphify-task",
      owner_id: "local",
      project_id: "mars-test",
      workspace_id: "ws-memory",
      cwd: REPO_MEMORY_DIR,
      revision,
      currentRevision: async () => revision,
      approvals: { read: true },
    };

    const built = await kg.build(binding);
    expect(built.status).toBe("built");
    if (built.status !== "built") return;

    expect(built.artifact.producer.version).toBe("0.9.101");
    expect(built.artifact.stats.nodes).toBeGreaterThan(20);
    expect(built.artifact.stats.edges).toBeGreaterThan(20);
    expect(built.artifact.stats.communities).toBeGreaterThan(0);

    // Zero host-path leakage (raw or slugified) across every node and community.
    const serialized = JSON.stringify(built.artifact);
    expect(serialized).not.toContain(REPO_MEMORY_DIR);
    expect(serialized).not.toContain(base);
    const rootSlug = REPO_MEMORY_DIR.toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    expect(serialized.toLowerCase()).not.toContain(rootSlug);

    // Tool wrappers: mars_graph_build and mars_graph_query
    const tools = kg.toolsFor(binding);
    const buildOutput = await tools.build();
    expect(buildOutput).toContain("mars_graph_build · built");
    expect(buildOutput).toContain("graphify 0.9.101");

    const communities = await tools.query({ kind: "communities", limit: 5 });
    expect(communities).toContain("mars_graph_query · communities");
    expect(communities).toContain("DurableMemoryStore");

    const neighbours = await tools.query({
      kind: "neighbours",
      node: "DurableMemoryStore",
      depth: 1,
      limit: 10,
    });
    expect(neighbours).toContain("mars_graph_query · neighbours");
    expect(neighbours).toContain("DurableMemoryStore");
    expect(neighbours).not.toContain("(no neighbours)");

    const paths = await tools.query({
      kind: "paths",
      from: "DurableMemoryStore",
      to: "scanThreat",
      max_depth: 4,
      limit: 3,
    });
    expect(paths).toContain("mars_graph_query · paths");
    expect(paths).not.toContain("(no path within the hop limit)");
    expect(paths).toMatch(/^- DurableMemoryStore → .+ → scanThreat\(\)/m);

    // Stale revision fencing: advancing revision must refuse stale answers.
    revision = "rev-2";
    const stale = await tools.query({ kind: "communities" });
    expect(stale).toContain("mars_graph_query · stale");
    expect(stale).toContain("No stale answer is given");
  }, 60_000);
});
