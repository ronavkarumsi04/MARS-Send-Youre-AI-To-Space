import { mkdir } from "node:fs/promises";
import type { EvolutionService } from "./service";
import {
  BETTER_POLICY,
  createFixture,
  policyPatch,
  replaceLine,
  runConfig,
} from "./test-support";

/**
 * Fully offline, FAKE end-to-end run used by `mars evolution demo`: fixture
 * harness, scripted proposer, fake Bernoulli evaluator, host-process builds.
 * No model, Harbor, Docker or network is used (`model_requests: 0`).
 */
export async function runOfflineDemo(
  root: string,
): Promise<{ service: EvolutionService; summary: Record<string, unknown> }> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const fixture = await createFixture(
    (context) =>
      context.child_index === 0
        ? { hypothesis: "raise solve rate", patch: policyPatch(BETTER_POLICY) }
        : {
            hypothesis: "cosmetic prompt edit",
            patch: replaceLine(
              "harness/agent.txt",
              "prompt-v1",
              `prompt-g${context.generation}`,
            ),
          },
    root,
  );
  const service = await fixture.open();
  await fixture.start(
    service,
    runConfig({ run_id: "demo-run", children_per_generation: 2 }),
  );
  const run = await service.run("demo-run");
  const decision = await service.promote({
    run_id: "demo-run",
    idempotency_key: "demo-promotion",
  });
  return {
    service,
    summary: {
      fake: true,
      model_requests: 0,
      run,
      lineage: service.lineage("demo-run"),
      decision,
      champion: service.champion("scope-1")?.candidate_id ?? null,
      history: service.history("scope-1"),
      metrics: service.metrics("demo-run"),
      store: fixture.storeDir,
    },
  };
}
