import { afterAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMPARISON_MANIFEST_MEDIA_TYPE,
  createEvaluationService,
  createHarborRunner,
} from "@mars/evaluation";
import {
  context,
  FAKE_HARBOR,
  FIXTURES,
  MemoryArtifacts,
  sampleManifest,
} from "../../evaluation/src/test-support";
import { EvolutionError } from "./errors";
import { createHarborEvaluator } from "./evaluators";
import { AgentManifestSchema } from "./schemas";

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

/** FAKE Harbor (fixtures/fake-harbor.py): no Docker, no model; exercises the real @mars/evaluation service path. */
test("createHarborEvaluator runs a candidate as the MARS arm against the mini-swe baseline through @mars/evaluation", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-evolution-harbor-"));
  roots.push(root);
  const python = join(root, "python");
  await writeFile(
    python,
    `#!/bin/sh\nprintf '%s\\n' '{"python":[3,12,13],"harbor":"0.25.0","mini_swe_agent":"2.4.6"}'\n`,
  );
  await chmod(python, 0o755);
  const harborFixtures = join(FIXTURES, "harbor");
  const dispatcher = join(root, "harbor-dispatch.sh");
  await writeFile(
    dispatcher,
    `#!/bin/sh\nif [ "$MARS_EVALUATION_ARM" = "baseline" ]; then export FAKE_HARBOR_FIXTURE='${join(harborFixtures, "synthetic-baseline")}'; else export FAKE_HARBOR_FIXTURE='${join(harborFixtures, "synthetic-candidate")}'; fi\nexec python3 '${FAKE_HARBOR}' "$@"\n`,
  );
  await chmod(dispatcher, 0o755);
  const runner = createHarborRunner({
    pythonPath: python,
    harborPath: dispatcher,
    agentPythonPath: join(FIXTURES, "..", "python"),
    jobsDir: join(root, "jobs"),
    dockerPath: null,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
  await mkdir(join(root, "bundle"));
  await writeFile(join(root, "bundle", "mars-agent"), "#!/bin/sh\nexit 0\n");
  await chmod(join(root, "bundle", "mars-agent"), 0o755);
  const artifacts = new MemoryArtifacts();
  const service = createEvaluationService({
    stateDir: join(root, "state"),
    runner,
    artifacts,
  });
  const template = await sampleManifest();
  const evaluator = createHarborEvaluator({
    service,
    artifacts,
    context,
    template,
  });
  const manifest = AgentManifestSchema.parse({
    schema: "mars.agent-manifest/v1",
    model: {
      id: template.model.id,
      provider: "openai-compatible",
      revision: "pinned",
    },
    prompts: { system_prompt: "You are MARS." },
    skills: { store_revision: "r1" },
    tools: [],
    retrieval: {
      repo_map_tokens: 0,
      memory_top_k: 0,
      context_window_tokens: 32_000,
      research: false,
    },
    harness: {
      base: { ref: "base", tree_sha256: "a".repeat(64) },
      patches: [],
      tree_sha256: "a".repeat(64),
    },
  });
  const request = {
    run_id: "run-h",
    subject_id: "g1-c0",
    manifest,
    manifest_sha256: "b".repeat(64),
    bundle_dir: join(root, "bundle"),
    bundle_sha256: "c".repeat(64),
    split: "final" as const,
    family: null,
    tasks: template.tasks,
    repeats: template.repeats,
    seed: "s",
    budget: template.budget,
    deadline_ms: Date.now() + 60_000,
  };
  const outcome = await evaluator.evaluate(
    request,
    AbortSignal.timeout(60_000),
  );
  expect(outcome.simulated).toBe(false);
  expect(outcome.evaluator_digest).toBe(evaluator.digest);
  expect(outcome.per_task.map((row) => row.task_id)).toEqual(template.tasks);
  for (const row of outcome.per_task) {
    expect(row.rewards).toHaveLength(template.repeats);
    expect(row.baseline_rewards).toHaveLength(template.repeats);
  }
  expect(outcome.report?.media_type).toContain("json");
  expect(outcome).toHaveProperty("baseline_cost_usd");
  const comparison = [...artifacts.items.values()]
    .filter((item) => item.mediaType === COMPARISON_MANIFEST_MEDIA_TYPE)
    .map((item) => JSON.parse(new TextDecoder().decode(item.data)))[0];
  const settings = JSON.parse(
    comparison.arms.candidate.candidate.components.mars_agent_settings,
  );
  expect(settings).toMatchObject({
    tools: [],
    skills: { store_revision: "r1" },
    model: { id: template.model.id },
  });
  expect(comparison.arms.candidate.candidate.components.system_prompt).toBe(
    "You are MARS.",
  );
  const mismatched = {
    ...request,
    manifest: { ...manifest, model: { ...manifest.model, id: "other-model" } },
  };
  const error = await evaluator
    .evaluate(mismatched, AbortSignal.timeout(5000))
    .catch((caught) => caught);
  expect(error).toBeInstanceOf(EvolutionError);
  expect((error as EvolutionError).code).toBe("evaluator_mismatch");
  const unbundled = { ...request, bundle_dir: join(root, "missing") };
  const missing = await evaluator
    .evaluate(unbundled, AbortSignal.timeout(5000))
    .catch((caught) => caught);
  expect((missing as EvolutionError).code).toBe("build_failed");
}, 60_000);
