import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RequestContext } from "@mars/contracts";
import {
  createHmacEvidenceSigner,
  DatasetLineageSchema,
} from "@mars/specialists";
import {
  AdapterBundleSchema,
  createFileArtifactStore,
  createFileJobStore,
  createTrainingService,
  TrainingManifestSchema,
  TrainingRunReportSchema,
} from "./index";

/**
 * LIVE acceptance (never run in CI): one genuine tiny CPU TRL + PEFT LoRA run
 * on the pinned `trl-internal-testing/tiny-Qwen2ForCausalLM-2.5` revision and
 * the SYNTHETIC fixture. Needs the pinned worker venv and a pre-fetched HF
 * cache (see packages/training/README.md). A pass proves plumbing only: the
 * adapter is saved, reloads on a fresh base and generates. It is not a useful
 * specialist and says nothing about held-out agent-level quality.
 */
const live = process.env.MARS_TRAINING_LIVE === "1";
const FIXTURES = path.join(import.meta.dir, "..", "fixtures", "synthetic");

test.skipIf(!live)(
  "LIVE: tiny CPU LoRA SFT saves an adapter that reloads on the base and generates",
  async () => {
    const root =
      process.env.MARS_TRAINING_LIVE_ROOT ??
      (await mkdtemp(path.join(tmpdir(), "mars-training-live-")));
    await mkdir(root, { recursive: true });
    const context: RequestContext = {
      schema_version: 1,
      scope: { owner_id: "live-owner", project_id: "live-project" },
      request_id: "training-live",
    };
    const artifacts = createFileArtifactStore(path.join(root, "store"));
    const manifestBytes = new Uint8Array(
      await readFile(path.join(FIXTURES, "manifest.json")),
    );
    const manifest = TrainingManifestSchema.parse(
      JSON.parse(new TextDecoder().decode(manifestBytes)),
    );
    for (const file of ["train.jsonl", "validation.jsonl"]) {
      await artifacts.put(
        context,
        new Uint8Array(await readFile(path.join(FIXTURES, file))),
        "application/jsonl",
      );
    }
    const manifestRef = await artifacts.put(
      context,
      manifestBytes,
      "application/json",
    );
    // Ephemeral per-run key: this proves the record is signed and verifiable, not that a production authority signed it.
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const service = createTrainingService({
      artifacts,
      jobs: createFileJobStore(path.join(root, "store")),
      workRoot: path.join(root, "work"),
      lineageSigner: createHmacEvidenceSigner({
        key_id: "live-ephemeral",
        secret,
      }),
      producerId: "mars-training-live",
    });
    const validation = await service.validate(context, manifestRef);
    expect(validation).toEqual({ ready: true, missing: [] });
    const estimate = await service.estimate(context, manifestRef);
    const job = await service.submit(context, manifestRef, {
      max_tokens: 1_000_000,
      max_usd: 0,
      max_duration_ms: 15 * 60 * 1000,
      max_depth: 0,
      max_concurrency: 1,
    });
    const result = await service.wait(context, job.job_id);
    const record = await service.inspectRecord(context, job.job_id);
    expect(record.error).toBeNull();
    expect(result.status).toBe("completed");
    if (!record.report) throw new Error("report missing");
    const decode = async (ref: typeof manifestRef) =>
      JSON.parse(new TextDecoder().decode(await artifacts.get(context, ref)));
    const report = TrainingRunReportSchema.parse(await decode(record.report));
    const bundle = AdapterBundleSchema.parse(
      await decode(report.artifacts.adapter_bundle),
    );
    const lineage = DatasetLineageSchema.parse(
      await decode(report.artifacts.dataset_lineage),
    );
    const adapterConfig = await decode(bundle.adapter_config);
    expect(report.metrics.device).toBe("cpu");
    expect(report.metrics.global_steps).toBe(manifest.sft.max_steps);
    expect(report.reload.loaded).toBe(true);
    expect(report.reload.max_abs_logit_diff_vs_trained).toBeLessThan(1e-4);
    expect(report.reload.max_abs_logit_diff_vs_base).toBeGreaterThan(0);
    expect(report.reload.generated_tokens).toBeGreaterThan(0);
    expect(adapterConfig.base_model_name_or_path).toBe(
      manifest.base_model.repo,
    );
    expect(adapterConfig.revision).toBe(manifest.base_model.revision);
    expect(lineage.provenance.synthetic_fixture).toBe(true);
    const evidence = {
      note: "PLUMBING PROOF ONLY — tiny test model, synthetic fixture; not a useful specialist and no held-out evaluation.",
      manifest: manifestRef,
      validation,
      estimate,
      job: result,
      report,
      bundle,
      adapter_config: adapterConfig,
      lineage,
    };
    await writeFile(
      path.join(root, "live-evidence.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
    console.log(`live evidence: ${path.join(root, "live-evidence.json")}`);
  },
  15 * 60 * 1000,
);
