import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ArtifactRef, RequestContext } from "@mars/contracts";
import { sha256 } from "@mars/contracts/canonical";
import {
  createEvaluationService,
  createHarborRunner,
  parseComparisonManifest,
} from "@mars/evaluation";
import { createHarborEvaluator } from "./evaluators";
import { LIVE_ACCEPTANCE_EVIDENCE } from "./live-evidence";
import { createScriptedProposer } from "./proposers";
import { createProcessSandbox } from "./sandbox";
import { EvolutionService } from "./service";

/**
 * LIVE acceptance (never run in CI; BLOCKED without a model key, Harbor venv
 * and pinned Docker images). See HANDOFF.md for the exact command.
 *
 * PARTIAL PATH: real Harbor evaluation, but a scripted proposer and
 * host-process builds. A pass does not establish model-driven proposing or
 * Docker-isolated builds; see LIVE_ACCEPTANCE_EVIDENCE.
 */
const live = process.env.MARS_EVOLUTION_LIVE === "1";

class Artifacts {
  readonly items = new Map<string, Uint8Array>();
  async put(
    _context: RequestContext,
    data: Uint8Array,
    media_type: string,
  ): Promise<ArtifactRef> {
    const digest = sha256(data);
    this.items.set(digest, data);
    return {
      artifact_id: `art-${digest.slice(0, 12)}`,
      sha256: digest,
      media_type,
      byte_length: data.byteLength,
    };
  }
  async get(_context: RequestContext, ref: ArtifactRef): Promise<Uint8Array> {
    const data = this.items.get(ref.sha256);
    if (!data) throw new Error(`missing artifact ${ref.artifact_id}`);
    return data;
  }
}

test.skipIf(!live)(
  "live (partial: Harbor evaluation; scripted proposer, host-process builds): a harness candidate is compared, promoted or refused, and rollback survives reopen",
  async () => {
    const env = (name: string) => {
      const value = process.env[name];
      if (!value) throw new Error(`${name} is required for live acceptance`);
      return value;
    };
    const root = await mkdtemp(join(tmpdir(), "mars-evolution-live-"));
    await writeFile(
      join(root, "live-evidence.json"),
      `${JSON.stringify(LIVE_ACCEPTANCE_EVIDENCE, null, 2)}\n`,
    );
    console.log(
      `live evidence scope: ${LIVE_ACCEPTANCE_EVIDENCE.scope}; not established: ${LIVE_ACCEPTANCE_EVIDENCE.does_not_establish.join("; ")}`,
    );
    const template = parseComparisonManifest(
      JSON.parse(
        await readFile(resolve(env("MARS_EVOLUTION_TEMPLATE")), "utf8"),
      ),
    );
    const runner = createHarborRunner({
      pythonPath: env("MARS_HARBOR_PYTHON"),
      harborPath: env("MARS_HARBOR_PATH"),
      agentPythonPath: resolve(
        import.meta.dir,
        "..",
        "..",
        "evaluation",
        "python",
      ),
      jobsDir: join(root, "jobs"),
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        MARS_EVAL_API_KEY: env("MARS_EVAL_API_KEY"),
      },
    });
    const artifacts = new Artifacts();
    const context: RequestContext = {
      schema_version: 1,
      scope: { owner_id: "live", project_id: "evolution" },
      request_id: "live-1",
    };
    const evaluator = createHarborEvaluator({
      service: createEvaluationService({
        stateDir: join(root, "eval"),
        runner,
        artifacts,
      }),
      artifacts,
      context,
      template,
    });
    const open = () =>
      EvolutionService.open({
        storeDir: join(root, "store"),
        workDir: join(root, "work"),
        evaluator,
        proposer: createScriptedProposer(
          "live-prompt-mutation",
          (proposal) => ({
            hypothesis:
              "ask the agent to run the task's tests before finishing",
            prompts: {
              ...proposal.parent.manifest.prompts,
              system_prompt: `${proposal.parent.manifest.prompts.system_prompt ?? ""}\nRun the tests before you finish.`,
            },
          }),
        ),
        sandbox: createProcessSandbox(),
      });
    const half = Math.max(1, Math.floor(template.tasks.length / 2));
    const service = await open();
    await service.startRun({
      config: {
        schema: "mars.evolution-run/v1",
        run_id: "live-run",
        seed: "live",
        generations: 1,
        children_per_generation: 1,
        selection: {
          stages: [{ tasks: template.tasks.slice(0, half) }],
          repeats: template.repeats,
        },
        final_test: {
          tasks: template.tasks.slice(half),
          repeats: Math.max(2, template.repeats),
        },
        evaluation_budget: template.budget,
        budget: {
          ...template.budget,
          max_usd: template.budget.max_usd * 10,
          max_tokens: template.budget.max_tokens * 10,
          max_duration_ms: template.budget.max_duration_ms * 10,
          max_depth: 5,
        },
        harness: {
          mutable_paths: ["harness/**"],
          protected_paths: [],
          build: {
            argv: ["/bin/sh", "build.sh"],
            timeout_ms: 600_000,
            bundle_dir: "dist",
          },
        },
      },
      scope_key: "live",
      base_dir: resolve(env("MARS_EVOLUTION_BASE")),
      base_ref: "live-base",
      model: {
        id: template.model.id,
        provider: "openai-compatible",
        revision: "pinned",
      },
      prompts: {
        system_prompt:
          template.arms.candidate.candidate.components.system_prompt ??
          "You are MARS.",
      },
      skills: { store_revision: "live" },
      tools: [],
      retrieval: {
        repo_map_tokens: 0,
        memory_top_k: 0,
        context_window_tokens: template.model.context_window,
        research: false,
      },
    });
    await service.run("live-run");
    const decision = await service.promote({
      run_id: "live-run",
      idempotency_key: "live-promotion",
    });
    expect(["accepted", "no_improvement", "rejected"]).toContain(
      decision.verdict,
    );
    expect(decision.simulated).toBe(false);
    if (decision.verdict === "accepted") {
      const champion = service.champion("live");
      service.rollback({
        scope_key: "live",
        to_entry_seq: 1,
        expected_pointer_version: champion?.pointer_version ?? 0,
      });
    }
    service.close();
    const reopened = await open();
    expect((await reopened.verify("live-run")).ok).toBe(true);
    expect(reopened.champion("live")?.candidate_id).toBe("initial");
    reopened.close();
  },
  24 * 60 * 60 * 1000,
);
