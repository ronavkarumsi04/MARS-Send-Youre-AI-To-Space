import { createHmac, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type ArtifactRef,
  ArtifactRefSchema,
  type Budget,
  BudgetSchema,
  type EvaluationService,
  exceedsUsd,
  type JobRef,
  type JobResult,
  type RequestContext,
  type VersionRef,
  VersionRefSchema,
} from "@mars/contracts";
import { canonicalJson, sha256 } from "@mars/contracts/canonical";
import { z } from "zod";

/** What `SpecialistRegistry.requestEvaluation` submits. */
export const SPECIALIST_COMPARISON_REQUEST_SCHEMA =
  "mars.specialist-comparison-request/v1";
export const SPECIALIST_COMPARISON_JOB_SCHEMA =
  "mars.specialist-comparison-job/v1";
export const SPECIALIST_COMPARISON_VERDICT_SCHEMA =
  "mars.specialist-comparison-verdict/v1";
export const SPECIALIST_EVALUATION_REPORT_SCHEMA =
  "mars.specialist-evaluation-report/v1";
export const SIMULATED_EVALUATION_NOTICE =
  "SIMULATED EVALUATOR — synthetic fixture, not a quality claim (model_requests: 0).";

export const SPECIALIST_ARMS = [
  "base",
  "prompt_optimized_baseline",
  "current_specialist",
  "candidate",
] as const;
export type SpecialistArm = (typeof SPECIALIST_ARMS)[number];

export type SpecialistComparisonErrorCode =
  | "invalid_request"
  | "subject_mismatch"
  | "heldout_empty"
  | "heldout_leakage"
  | "lineage_missing"
  | "lineage_mismatch"
  | "evaluator_not_independent"
  | "not_found"
  | "not_settled";

export class SpecialistComparisonError extends Error {
  constructor(
    readonly code: SpecialistComparisonErrorCode,
    readonly detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "SpecialistComparisonError";
  }
}

const Id = z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,127}$/);
const Sha = z.string().regex(/^[a-f0-9]{64}$/);
const Role = z.enum(["lead", "worker", "reviewer"]);
const Complexity = z.enum(["light", "medium", "heavy"]);
const Domain = z.string().regex(/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/);

const AcceptanceSchema = z
  .object({
    min_heldout_tasks_per_coverage: z.number().int().min(1),
    min_pass_rate_delta_vs_base: z.number().finite().min(-1).max(1),
    min_pass_rate_delta_vs_prompt_optimized: z.number().finite().min(-1).max(1),
    min_pass_rate_delta_vs_current: z.number().finite().min(-1).max(1),
    max_regressions: z.number().int().nonnegative(),
    max_cost_usd_per_task: z.number().finite().nonnegative().nullable(),
    max_runtime_ms_p95: z.number().int().positive().nullable(),
  })
  .strict();
export type ComparisonAcceptance = z.infer<typeof AcceptanceSchema>;

export const SpecialistComparisonRequestSchema = z
  .object({
    schema: z.literal(SPECIALIST_COMPARISON_REQUEST_SCHEMA),
    subject: z
      .object({
        specialist_id: Id,
        revision: Id,
        candidate_sha256: Sha,
      })
      .strict(),
    required_arms: z
      .array(z.enum(SPECIALIST_ARMS))
      .min(1)
      .refine((arms) => arms.includes("base") && arms.includes("candidate")),
    current_production_revision: Id.nullable(),
    tested_task_coverage: z.array(Domain).min(1),
    acceptance: AcceptanceSchema,
    roles: z.array(Role).min(1),
    complexity: z.array(Complexity).min(1),
  })
  .strict();
export type SpecialistComparisonRequest = z.infer<
  typeof SpecialistComparisonRequestSchema
>;

/** The fields of a dataset lineage this service needs to enforce exclusion. */
const LineageViewSchema = z.object({
  schema: z.literal("mars.specialist-dataset-lineage/v1"),
  subject: z.object({ specialist_id: Id, base_model: VersionRefSchema }),
  datasets: z.array(z.object({ sha256: Sha })).min(1),
  training: z.object({ producer_id: Id }),
  train_task_ids: z.array(Id),
  validation_task_ids: z.array(Id),
});

/** A registered revision as the registry exposes it (`SpecialistRegistry.inspect`). */
export interface SpecialistSubjectView {
  registration: {
    specialist_id: string;
    revision: string;
    scope: { owner_id: string; project_id: string };
    base_model: VersionRef;
    adapter: ArtifactRef | null;
    dataset_lineage: ArtifactRef | null;
  };
  candidate_sha256: string;
}

export interface SpecialistSubjectResolver {
  resolve(
    context: RequestContext,
    specialistId: string,
    revision: string,
  ): Promise<SpecialistSubjectView | undefined>;
}

/** Adapts anything with `SpecialistRegistry.inspect`'s shape. */
export function subjectResolverFromRegistry(registry: {
  inspect(
    context: RequestContext,
    id: string,
  ): Promise<{ revisions: readonly SpecialistSubjectView[] }>;
}): SpecialistSubjectResolver {
  return {
    async resolve(context, specialistId, revision) {
      const inspection = await registry.inspect(context, specialistId);
      return inspection.revisions.find(
        (view) => view.registration.revision === revision,
      );
    },
  };
}

export interface HeldOutTaskView {
  task_id: string;
  domain: string;
  role: "lead" | "worker" | "reviewer";
  complexity: "light" | "medium" | "heavy";
  request?: string | undefined;
}

/** Satisfied by `createHeldOutGuard` from `@mars/datasets`. */
export interface HeldOutGuard {
  split(): {
    split_id: string;
    sha256: string;
    tasks: readonly HeldOutTaskView[];
  };
  findLeakage(training: {
    task_ids: readonly string[];
    requests?: readonly string[];
    dataset_sha256s?: readonly string[];
  }): ReadonlyArray<{ task_id: string; reason: string }>;
}

export interface ArmTarget {
  arm: SpecialistArm;
  model: VersionRef;
  specialist_revision: string | null;
  adapter: ArtifactRef | null;
}

export interface ArmEvaluationInput {
  job_id: string;
  subject: SpecialistComparisonRequest["subject"];
  target: ArmTarget;
  base_model: VersionRef;
  tasks: readonly HeldOutTaskView[];
  repeats: number;
  seed: string;
  budget: Budget;
  signal: AbortSignal;
}

export interface ArmTaskOutcome {
  task_id: string;
  /** One reward in [0, 1] per repeat; 1 is a pass. */
  rewards: number[];
  cost_usd: number | null;
  runtime_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
}

export interface ArmEvaluationResult {
  agent_manifest_sha256: string;
  outcomes: ArmTaskOutcome[];
  model_requests: number;
}

/** Runs one arm over held-out tasks. Live implementations need a model key and serving. */
export interface SpecialistArmEvaluator {
  evaluator_id: string;
  evaluator_revision: string;
  harness: VersionRef;
  suite: { suite_id: string; revision: string };
  /** True for fixture evaluators: the report is marked `synthetic_fixture`. */
  simulated: boolean;
  evaluate(input: ArmEvaluationInput): Promise<ArmEvaluationResult>;
}

export interface EvidenceSigner {
  sign<T extends Record<string, unknown>>(
    unsigned: T,
  ): T & {
    attestation: { alg: "hmac-sha256"; key_id: string; mac_hex: string };
  };
}

/** Signs exactly as `createHmacEvidenceVerifier` in `@mars/specialists` verifies. */
export function createHmacReportSigner(options: {
  key_id: string;
  secret: Uint8Array;
}): EvidenceSigner {
  const secret = Uint8Array.from(options.secret);
  return {
    sign(unsigned) {
      const mac_hex = createHmac("sha256", secret)
        .update(specialistCanonicalJson(unsigned))
        .digest("hex");
      return {
        ...unsigned,
        attestation: {
          alg: "hmac-sha256" as const,
          key_id: options.key_id,
          mac_hex,
        },
      };
    },
  };
}

function specialistCanonicalJson(value: unknown): string {
  return canonicalJson(value, { keyOrder: "integer-keys-first" });
}

export interface SpecialistEvidenceArtifacts {
  get(context: RequestContext, ref: ArtifactRef): Promise<Uint8Array>;
  put(
    context: RequestContext,
    bytes: Uint8Array,
    mediaType: string,
  ): Promise<ArtifactRef>;
}

export const TripleVerdictSchema = z
  .object({
    domain: Domain,
    role: Role,
    complexity: Complexity,
    attempted: z.number().int().positive(),
    pass_rate: z.number(),
    base_pass_rate: z.number(),
    delta_vs_base: z.number(),
    prompt_optimized_pass_rate: z.number().nullable(),
    delta_vs_prompt_optimized: z.number().nullable(),
    current_pass_rate: z.number().nullable(),
    delta_vs_current: z.number().nullable(),
    gate_passed: z.boolean(),
  })
  .strict();

export const SpecialistComparisonVerdictSchema = z
  .object({
    schema: z.literal(SPECIALIST_COMPARISON_VERDICT_SCHEMA),
    job_id: Id,
    subject: SpecialistComparisonRequestSchema.shape.subject,
    request: ArtifactRefSchema,
    report: ArtifactRefSchema,
    heldout: z
      .object({ split_id: Id, split_sha256: Sha, task_count: z.number().int() })
      .strict(),
    seed: z.string(),
    repeats: z.number().int().min(1),
    budget_per_arm: BudgetSchema,
    arms_run: z.array(z.enum(SPECIALIST_ARMS)),
    outcome: z.enum(["improved", "no_improvement", "regressed"]),
    codes: z.array(z.string()),
    triples: z.array(TripleVerdictSchema).min(1),
    regressions: z.number().int().nonnegative(),
    simulated: z.boolean(),
    model_requests: z.number().int().nonnegative(),
    cost_usd: z.number().nonnegative().nullable(),
    produced_at: z.string(),
    note: z.string(),
  })
  .strict();
export type SpecialistComparisonVerdict = z.infer<
  typeof SpecialistComparisonVerdictSchema
>;

/** Where verdicts go back to the specialist registry. */
export interface SpecialistVerdictSink {
  record(
    context: RequestContext,
    entry: {
      job: JobRef;
      report: ArtifactRef;
      verdict: ArtifactRef;
      value: SpecialistComparisonVerdict;
    },
  ): Promise<void>;
}

const JobStatus = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
const JobRecordSchema = z
  .object({
    schema: z.literal(SPECIALIST_COMPARISON_JOB_SCHEMA),
    job_id: Id,
    scope: z.object({ owner_id: z.string(), project_id: z.string() }),
    input_manifest: ArtifactRefSchema,
    budget: BudgetSchema,
    status: JobStatus,
    error: z.string().nullable(),
    seed: z.string(),
    heldout: z.object({
      split_id: Id,
      split_sha256: Sha,
      task_ids: z.array(Id),
    }),
    report: ArtifactRefSchema.nullable(),
    verdict: ArtifactRefSchema.nullable(),
    cost_usd: z.number().nonnegative().nullable(),
    model_requests: z.number().int().nonnegative(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .strict();
type JobRecord = z.infer<typeof JobRecordSchema>;

export interface SpecialistComparisonServiceOptions {
  stateDir: string;
  artifacts: SpecialistEvidenceArtifacts;
  subjects: SpecialistSubjectResolver;
  heldOut: HeldOutGuard;
  evaluator: SpecialistArmEvaluator;
  signer: EvidenceSigner;
  verdicts: SpecialistVerdictSink;
  /** Repeats per task, identical for every arm. Default 1. */
  repeats?: number;
  /** Salt for the matched per-job seed. */
  seedSalt?: string;
  now?: () => Date;
}

export type SpecialistComparisonService = EvaluationService & {
  /** Resolves when the job reaches a terminal status. */
  settled(jobId: string): Promise<JobResult>;
  verdict(
    context: RequestContext,
    jobId: string,
  ): Promise<SpecialistComparisonVerdict>;
};

interface Plan {
  request: SpecialistComparisonRequest;
  subject: SpecialistSubjectView;
  targets: ArmTarget[];
  tasks: HeldOutTaskView[];
  split: { split_id: string; sha256: string };
}

/**
 * Held-out specialist comparison behind `EvaluationService`. Submission refuses
 * before any arm runs when the request does not match the registered revision,
 * the held-out split overlaps the candidate's training lineage, or the evaluator
 * is the training producer. Every arm then runs the same tasks, repeats, seed
 * and per-arm budget; the signed report and a verdict that states
 * "no_improvement" when the candidate does not beat base go to the sink.
 */
export function createSpecialistComparisonService(
  options: SpecialistComparisonServiceOptions,
): SpecialistComparisonService {
  const jobsDir = path.join(options.stateDir, "specialist-comparisons");
  const now = options.now ?? (() => new Date());
  const repeats = options.repeats ?? 1;
  if (!Number.isInteger(repeats) || repeats < 1) {
    throw new SpecialistComparisonError("invalid_request", "repeats");
  }
  const active = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();

  const file = (jobId: string) => path.join(jobsDir, `${jobId}.json`);
  async function write(record: JobRecord) {
    await mkdir(jobsDir, { recursive: true });
    const target = file(record.job_id);
    const temp = `${target}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temp, target);
  }
  async function read(jobId: string): Promise<JobRecord | undefined> {
    if (!Id.safeParse(jobId).success) return undefined;
    try {
      return JobRecordSchema.parse(
        JSON.parse(await readFile(file(jobId), "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  async function update(jobId: string, patch: Partial<JobRecord>) {
    const record = await read(jobId);
    if (!record) throw new SpecialistComparisonError("not_found");
    const next = { ...record, ...patch, updated_at: now().toISOString() };
    await write(next);
    return next;
  }
  async function visible(context: RequestContext, jobId: string) {
    let record = await read(jobId);
    if (
      !record ||
      record.scope.owner_id !== context.scope.owner_id ||
      record.scope.project_id !== context.scope.project_id
    ) {
      throw new SpecialistComparisonError("not_found");
    }
    if (
      (record.status === "pending" || record.status === "running") &&
      !active.has(jobId)
    ) {
      record = await update(jobId, {
        status: "failed",
        error: "interrupted: service restarted before the job finished",
      });
    }
    return record;
  }
  const result = (record: JobRecord): JobResult => ({
    job: { job_id: record.job_id, input_manifest: record.input_manifest },
    status: record.status,
    artifacts: [
      ...(record.report ? [record.report] : []),
      ...(record.verdict ? [record.verdict] : []),
    ],
    cost_usd: record.cost_usd,
  });

  async function loadJson(context: RequestContext, ref: ArtifactRef) {
    const bytes = await options.artifacts.get(context, ref);
    if (sha256(bytes) !== ref.sha256) {
      throw new SpecialistComparisonError(
        "invalid_request",
        `artifact ${ref.artifact_id} digest mismatch`,
      );
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  }

  async function plan(
    context: RequestContext,
    manifest: ArtifactRef,
  ): Promise<Plan> {
    const parsed = SpecialistComparisonRequestSchema.safeParse(
      await loadJson(context, manifest),
    );
    if (!parsed.success) {
      throw new SpecialistComparisonError(
        "invalid_request",
        "request manifest",
      );
    }
    const request = parsed.data;
    const { specialist_id, revision } = request.subject;
    const subject = await options.subjects.resolve(
      context,
      specialist_id,
      revision,
    );
    if (
      !subject ||
      subject.candidate_sha256 !== request.subject.candidate_sha256 ||
      subject.registration.specialist_id !== specialist_id ||
      subject.registration.scope.owner_id !== context.scope.owner_id ||
      subject.registration.scope.project_id !== context.scope.project_id
    ) {
      throw new SpecialistComparisonError(
        "subject_mismatch",
        "request does not match a registered revision in scope",
      );
    }
    const registration = subject.registration;

    const lineageRef = registration.dataset_lineage;
    if (registration.adapter !== null && lineageRef === null) {
      throw new SpecialistComparisonError(
        "lineage_missing",
        "an adapter without dataset lineage cannot be proven disjoint from held-out tasks",
      );
    }
    const training = {
      task_ids: [] as string[],
      dataset_sha256s: [] as string[],
    };
    if (lineageRef) {
      const lineage = LineageViewSchema.safeParse(
        await loadJson(context, lineageRef),
      );
      if (
        !lineage.success ||
        lineage.data.subject.specialist_id !== specialist_id ||
        canonicalJson(lineage.data.subject.base_model) !==
          canonicalJson(registration.base_model)
      ) {
        throw new SpecialistComparisonError("lineage_mismatch");
      }
      if (
        lineage.data.training.producer_id === options.evaluator.evaluator_id
      ) {
        throw new SpecialistComparisonError(
          "evaluator_not_independent",
          "the evaluator produced the training run",
        );
      }
      training.task_ids = [
        ...lineage.data.train_task_ids,
        ...lineage.data.validation_task_ids,
      ];
      training.dataset_sha256s = lineage.data.datasets.map((d) => d.sha256);
    }

    const split = options.heldOut.split();
    const leaks = options.heldOut.findLeakage(training);
    if (leaks.length > 0) {
      const sample = leaks
        .slice(0, 5)
        .map((leak) => `${leak.task_id} (${leak.reason})`)
        .join(", ");
      throw new SpecialistComparisonError(
        "heldout_leakage",
        `${leaks.length} held-out task(s) are in the training lineage: ${sample}`,
      );
    }
    const trained = new Set(training.task_ids);
    const tasks = split.tasks.filter(
      (task) =>
        !trained.has(task.task_id) &&
        request.tested_task_coverage.includes(task.domain) &&
        request.roles.includes(task.role) &&
        request.complexity.includes(task.complexity),
    );
    if (tasks.length === 0) {
      throw new SpecialistComparisonError(
        "heldout_empty",
        "no held-out task covers the requested domain/role/complexity",
      );
    }

    let current: SpecialistSubjectView | undefined;
    if (request.current_production_revision !== null) {
      current = await options.subjects.resolve(
        context,
        specialist_id,
        request.current_production_revision,
      );
      if (!current) {
        throw new SpecialistComparisonError(
          "subject_mismatch",
          "current production revision is not registered",
        );
      }
    }
    const specialistModel = (rev: string) => ({
      component: `specialist/${specialist_id}`,
      revision: rev,
    });
    const targets: ArmTarget[] = [];
    for (const arm of SPECIALIST_ARMS) {
      if (!request.required_arms.includes(arm)) continue;
      if (arm === "base" || arm === "prompt_optimized_baseline") {
        targets.push({
          arm,
          model: registration.base_model,
          specialist_revision: null,
          adapter: null,
        });
      } else if (arm === "current_specialist") {
        targets.push({
          arm,
          model: current
            ? specialistModel(current.registration.revision)
            : registration.base_model,
          specialist_revision: current?.registration.revision ?? null,
          adapter: current?.registration.adapter ?? null,
        });
      } else {
        targets.push({
          arm,
          model: specialistModel(revision),
          specialist_revision: revision,
          adapter: registration.adapter,
        });
      }
    }
    return {
      request,
      subject,
      targets,
      tasks,
      split: { split_id: split.split_id, sha256: split.sha256 },
    };
  }

  async function run(
    context: RequestContext,
    record: JobRecord,
    work: Plan,
    signal: AbortSignal,
  ) {
    await update(record.job_id, { status: "running" });
    const runnable = work.targets.filter(
      (target) =>
        target.arm !== "current_specialist" ||
        target.specialist_revision !== null,
    );
    const perArm: Budget = {
      ...record.budget,
      max_usd: record.budget.max_usd / runnable.length,
      max_tokens: Math.floor(record.budget.max_tokens / runnable.length),
    };
    const deadline = AbortSignal.any([
      signal,
      AbortSignal.timeout(record.budget.max_duration_ms),
    ]);
    const outcomes = new Map<SpecialistArm, ArmTaskOutcome[]>();
    const manifests = new Map<SpecialistArm, string>();
    let modelRequests = 0;
    let cost: number | null = 0;
    for (const target of runnable) {
      deadline.throwIfAborted();
      const armResult = await options.evaluator.evaluate({
        job_id: record.job_id,
        subject: work.request.subject,
        target,
        base_model: work.subject.registration.base_model,
        tasks: work.tasks,
        repeats,
        seed: record.seed,
        budget: perArm,
        signal: deadline,
      });
      deadline.throwIfAborted();
      checkArmResult(target.arm, armResult, work.tasks, repeats, perArm);
      modelRequests += armResult.model_requests;
      const armCost = sumOrNull(armResult.outcomes.map((o) => o.cost_usd));
      cost = cost === null || armCost === null ? null : cost + armCost;
      outcomes.set(target.arm, armResult.outcomes);
      manifests.set(target.arm, armResult.agent_manifest_sha256);
    }

    const producedAt = now().toISOString();
    const report = buildReport(context, record, work, {
      outcomes,
      manifests,
      repeats,
      producedAt,
      evaluator: options.evaluator,
    });
    const signed = options.signer.sign(report.unsigned);
    const reportRef = await options.artifacts.put(
      context,
      new TextEncoder().encode(specialistCanonicalJson(signed)),
      "application/json",
    );
    const verdict = SpecialistComparisonVerdictSchema.parse({
      schema: SPECIALIST_COMPARISON_VERDICT_SCHEMA,
      job_id: record.job_id,
      subject: work.request.subject,
      request: record.input_manifest,
      report: reportRef,
      heldout: {
        split_id: work.split.split_id,
        split_sha256: work.split.sha256,
        task_count: work.tasks.length,
      },
      seed: record.seed,
      repeats,
      budget_per_arm: perArm,
      arms_run: runnable.map((target) => target.arm),
      ...judge(work.request, report.groups, outcomes, report.regressions),
      regressions: report.regressions,
      simulated: options.evaluator.simulated,
      model_requests: modelRequests,
      cost_usd: cost,
      produced_at: producedAt,
      note: options.evaluator.simulated
        ? SIMULATED_EVALUATION_NOTICE
        : "Advisory summary; the registry re-verifies the signed report before any status change.",
    });
    const verdictRef = await options.artifacts.put(
      context,
      new TextEncoder().encode(specialistCanonicalJson(verdict)),
      "application/json",
    );
    await update(record.job_id, {
      report: reportRef,
      verdict: verdictRef,
      cost_usd: cost,
      model_requests: modelRequests,
    });
    await options.verdicts.record(context, {
      job: { job_id: record.job_id, input_manifest: record.input_manifest },
      report: reportRef,
      verdict: verdictRef,
      value: verdict,
    });
    await update(record.job_id, { status: "completed" });
  }

  return {
    async submitComparison(context, immutableManifest, budget) {
      const manifest = ArtifactRefSchema.parse(immutableManifest);
      const effective = BudgetSchema.parse(budget);
      const work = await plan(context, manifest);
      const job_id = `spec-eval-${randomUUID()}`;
      const seed = sha256(
        canonicalJson([
          "mars.specialist-comparison-seed/v1",
          options.seedSalt ?? "",
          work.request.subject.candidate_sha256,
          work.split.sha256,
        ]),
      ).slice(0, 16);
      const created = now().toISOString();
      const record: JobRecord = {
        schema: SPECIALIST_COMPARISON_JOB_SCHEMA,
        job_id,
        scope: {
          owner_id: context.scope.owner_id,
          project_id: context.scope.project_id,
        },
        input_manifest: manifest,
        budget: effective,
        status: "pending",
        error: null,
        seed,
        heldout: {
          split_id: work.split.split_id,
          split_sha256: work.split.sha256,
          task_ids: work.tasks.map((task) => task.task_id),
        },
        report: null,
        verdict: null,
        cost_usd: null,
        model_requests: 0,
        created_at: created,
        updated_at: created,
      };
      await write(record);
      const controller = new AbortController();
      const done = run(context, record, work, controller.signal)
        .catch(async (error: unknown) => {
          const cancelled = controller.signal.aborted;
          await update(job_id, {
            status: cancelled ? "cancelled" : "failed",
            error: cancelled
              ? "cancelled"
              : error instanceof Error
                ? error.message
                : "evaluation failed",
          });
        })
        .finally(() => active.delete(job_id));
      active.set(job_id, { controller, done });
      return { job_id, input_manifest: manifest };
    },
    async inspect(context, jobId) {
      return result(await visible(context, jobId));
    },
    async cancel(context, jobId) {
      await visible(context, jobId);
      const job = active.get(jobId);
      if (!job) return;
      job.controller.abort();
      await job.done;
    },
    async settled(jobId) {
      await active.get(jobId)?.done;
      const record = await read(jobId);
      if (!record) throw new SpecialistComparisonError("not_found");
      return result(record);
    },
    async verdict(context, jobId) {
      const record = await visible(context, jobId);
      if (!record.verdict) {
        throw new SpecialistComparisonError(
          "not_settled",
          `job is ${record.status}${record.error ? `: ${record.error}` : ""}`,
        );
      }
      return SpecialistComparisonVerdictSchema.parse(
        await loadJson(context, record.verdict),
      );
    },
  };
}

/** Lists persisted comparison job ids (for operators and recovery). */
export async function listSpecialistComparisonJobs(
  stateDir: string,
): Promise<string[]> {
  try {
    return (await readdir(path.join(stateDir, "specialist-comparisons")))
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function sumOrNull(values: readonly (number | null)[]): number | null {
  let total = 0;
  for (const value of values) {
    if (value === null) return null;
    total += value;
  }
  return total;
}

function checkArmResult(
  arm: SpecialistArm,
  result: ArmEvaluationResult,
  tasks: readonly HeldOutTaskView[],
  repeats: number,
  budget: Budget,
) {
  const fail = (why: string) => {
    throw new Error(`evaluator contract violated on arm ${arm}: ${why}`);
  };
  if (!Sha.safeParse(result.agent_manifest_sha256).success)
    fail("agent manifest");
  if (!Number.isInteger(result.model_requests) || result.model_requests < 0)
    fail("model_requests");
  const expected = new Set(tasks.map((task) => task.task_id));
  if (
    result.outcomes.length !== expected.size ||
    new Set(result.outcomes.map((o) => o.task_id)).size !== expected.size ||
    result.outcomes.some((o) => !expected.has(o.task_id))
  ) {
    fail("outcomes must cover exactly the held-out tasks");
  }
  for (const outcome of result.outcomes) {
    if (
      outcome.rewards.length !== repeats ||
      outcome.rewards.some((r) => !Number.isFinite(r) || r < 0 || r > 1)
    ) {
      fail(`rewards for ${outcome.task_id}`);
    }
    for (const value of [
      outcome.cost_usd,
      outcome.runtime_ms,
      outcome.input_tokens,
      outcome.output_tokens,
    ]) {
      if (value !== null && (!Number.isFinite(value) || value < 0))
        fail(`measurements for ${outcome.task_id}`);
    }
  }
  const cost = sumOrNull(result.outcomes.map((o) => o.cost_usd));
  if (cost !== null && exceedsUsd(cost, budget.max_usd)) {
    throw new Error(`budget exceeded on arm ${arm}: matched per-arm max_usd`);
  }
  const tokens = sumOrNull(
    result.outcomes.map((o) =>
      o.input_tokens === null || o.output_tokens === null
        ? null
        : o.input_tokens + o.output_tokens,
    ),
  );
  if (tokens !== null && tokens > budget.max_tokens) {
    throw new Error(
      `budget exceeded on arm ${arm}: matched per-arm max_tokens`,
    );
  }
}

/** A task passes when a strict majority of its repeats score 1. */
function taskPassed(outcome: ArmTaskOutcome): boolean {
  const passes = outcome.rewards.filter((reward) => reward === 1).length;
  return passes * 2 > outcome.rewards.length;
}

interface Group {
  domain: string;
  role: HeldOutTaskView["role"];
  complexity: HeldOutTaskView["complexity"];
  task_ids: string[];
}

function groupTasks(tasks: readonly HeldOutTaskView[]): Group[] {
  const groups = new Map<string, Group>();
  for (const task of tasks) {
    const key = `${task.domain}\u0000${task.role}\u0000${task.complexity}`;
    const group = groups.get(key) ?? {
      domain: task.domain,
      role: task.role,
      complexity: task.complexity,
      task_ids: [],
    };
    group.task_ids.push(task.task_id);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function p95(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const value = sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 1;
  return Math.max(1, Math.round(value));
}

function buildReport(
  context: RequestContext,
  record: JobRecord,
  work: Plan,
  input: {
    outcomes: Map<SpecialistArm, ArmTaskOutcome[]>;
    manifests: Map<SpecialistArm, string>;
    repeats: number;
    producedAt: string;
    evaluator: SpecialistArmEvaluator;
  },
) {
  const groups = groupTasks(work.tasks);
  const byTask = (arm: SpecialistArm) =>
    new Map((input.outcomes.get(arm) ?? []).map((o) => [o.task_id, o]));
  const results = [];
  for (const group of groups) {
    for (const target of work.targets) {
      const tasks = byTask(target.arm);
      if (tasks.size === 0) continue;
      const rows = group.task_ids.map((id) => tasks.get(id) as ArmTaskOutcome);
      const runtimes = rows.map((row) => row.runtime_ms);
      results.push({
        arm: target.arm,
        domain: group.domain,
        role: group.role,
        complexity: group.complexity,
        task_ids: group.task_ids,
        passed: rows.filter(taskPassed).length,
        attempted: rows.length,
        repeats: input.repeats,
        cost_usd_total: sumOrNull(rows.map((row) => row.cost_usd)),
        runtime_ms_p95: runtimes.some((value) => value === null)
          ? null
          : p95(runtimes as number[]),
        input_tokens: sumOrNull(rows.map((row) => row.input_tokens)),
        output_tokens: sumOrNull(rows.map((row) => row.output_tokens)),
      });
    }
  }
  const candidate = byTask("candidate");
  const domains = new Map(
    work.tasks.map((task) => [task.task_id, task.domain]),
  );
  const regressions: Array<{
    task_id: string;
    domain: string;
    compared_to: Exclude<SpecialistArm, "candidate">;
  }> = [];
  for (const compared_to of [
    "base",
    "prompt_optimized_baseline",
    "current_specialist",
  ] as const) {
    const other = byTask(compared_to);
    for (const [taskId, outcome] of other) {
      const mine = candidate.get(taskId);
      if (mine && taskPassed(outcome) && !taskPassed(mine)) {
        regressions.push({
          task_id: taskId,
          domain: domains.get(taskId) as string,
          compared_to,
        });
      }
    }
  }
  const limitations = [
    `Held-out split ${work.split.split_id} (${work.split.sha256}); tasks in the candidate's training lineage were refused before any arm ran.`,
    `Every arm ran the same ${work.tasks.length} task(s), ${input.repeats} repeat(s), seed ${record.seed} and per-arm budget.`,
    "A task passes when a strict majority of its repeats score 1.",
  ];
  if (input.evaluator.simulated)
    limitations.unshift(SIMULATED_EVALUATION_NOTICE);
  const unsigned = {
    schema: SPECIALIST_EVALUATION_REPORT_SCHEMA,
    report_id: `report-${record.job_id}`,
    subject: work.request.subject,
    authorization: {
      owner_id: context.scope.owner_id,
      project_id: context.scope.project_id,
    },
    suite: {
      suite_id: input.evaluator.suite.suite_id,
      revision: input.evaluator.suite.revision,
      harness: input.evaluator.harness,
    },
    heldout: {
      split_id: work.split.split_id,
      split_sha256: work.split.sha256,
      task_ids: work.tasks.map((task) => task.task_id),
    },
    arms: work.targets.map((target) => ({
      arm: target.arm,
      agent_manifest_sha256:
        input.manifests.get(target.arm) ??
        sha256(canonicalJson(["not-run", target.arm])),
      model: target.model,
      specialist_revision: target.specialist_revision,
    })),
    results,
    regressions,
    uncertainty: [
      input.repeats === 1
        ? "Single repeat per task: pass rates carry no repeatability estimate."
        : `${input.repeats} repeats per task.`,
    ],
    limitations,
    provenance: {
      evaluator_id: input.evaluator.evaluator_id,
      evaluator_revision: input.evaluator.evaluator_revision,
      job_id: record.job_id,
      produced_at: input.producedAt,
      synthetic_fixture: input.evaluator.simulated,
      evidence_artifacts: [record.input_manifest],
    },
  };
  return { unsigned, groups, regressions: regressions.length };
}

/** Mirrors the registry's per-triple gate; "improved" needs a positive delta vs base. */
function judge(
  request: SpecialistComparisonRequest,
  groups: readonly Group[],
  outcomes: Map<SpecialistArm, ArmTaskOutcome[]>,
  regressions: number,
): {
  outcome: SpecialistComparisonVerdict["outcome"];
  codes: string[];
  triples: SpecialistComparisonVerdict["triples"];
} {
  const acceptance = request.acceptance;
  const codes = new Set<string>();
  const rateOf = (arm: SpecialistArm, group: Group) => {
    const rows = outcomes.get(arm);
    if (!rows) return null;
    const ids = new Set(group.task_ids);
    const selected = rows.filter((row) => ids.has(row.task_id));
    return selected.filter(taskPassed).length / selected.length;
  };
  const triples = groups.map((group) => {
    const pass = rateOf("candidate", group) as number;
    const base = rateOf("base", group) as number;
    const prompt = rateOf("prompt_optimized_baseline", group);
    const current = rateOf("current_specialist", group);
    const rows = (outcomes.get("candidate") ?? []).filter((row) =>
      group.task_ids.includes(row.task_id),
    );
    let gate =
      group.task_ids.length >= acceptance.min_heldout_tasks_per_coverage &&
      pass - base >= acceptance.min_pass_rate_delta_vs_base &&
      (prompt === null ||
        pass - prompt >= acceptance.min_pass_rate_delta_vs_prompt_optimized) &&
      (current === null ||
        pass - current >= acceptance.min_pass_rate_delta_vs_current);
    if (group.task_ids.length < acceptance.min_heldout_tasks_per_coverage)
      codes.add("heldout_coverage_insufficient");
    const cost = sumOrNull(rows.map((row) => row.cost_usd));
    if (acceptance.max_cost_usd_per_task !== null) {
      if (cost === null) {
        codes.add("cost_unmeasured");
        gate = false;
      } else if (cost / rows.length > acceptance.max_cost_usd_per_task) {
        codes.add("cost_exceeded");
        gate = false;
      }
    }
    if (acceptance.max_runtime_ms_p95 !== null) {
      const runtimes = rows.map((row) => row.runtime_ms);
      if (runtimes.some((value) => value === null)) {
        codes.add("runtime_unmeasured");
        gate = false;
      } else if (p95(runtimes as number[]) > acceptance.max_runtime_ms_p95) {
        codes.add("runtime_exceeded");
        gate = false;
      }
    }
    return {
      domain: group.domain,
      role: group.role,
      complexity: group.complexity,
      attempted: group.task_ids.length,
      pass_rate: pass,
      base_pass_rate: base,
      delta_vs_base: pass - base,
      prompt_optimized_pass_rate: prompt,
      delta_vs_prompt_optimized: prompt === null ? null : pass - prompt,
      current_pass_rate: current,
      delta_vs_current: current === null ? null : pass - current,
      gate_passed: gate,
    };
  });
  if (regressions > acceptance.max_regressions)
    codes.add("regressions_exceeded");
  if (triples.some((triple) => !triple.gate_passed)) codes.add("gate_failed");
  let outcome: SpecialistComparisonVerdict["outcome"];
  if (triples.some((triple) => triple.delta_vs_base < 0)) {
    outcome = "regressed";
    codes.add("worse_than_base");
  } else if (
    codes.size === 0 &&
    triples.some((triple) => triple.delta_vs_base > 0)
  ) {
    outcome = "improved";
  } else {
    outcome = "no_improvement";
    if (triples.every((triple) => triple.delta_vs_base === 0))
      codes.add("no_delta_vs_base");
  }
  return { outcome, codes: [...codes].sort(), triples };
}

/**
 * Deterministic offline arm evaluator (the `@mars/evolution` fixture pattern):
 * no model requests, `simulated: true`, rewards from `pass(arm, task, repeat,
 * seed)` or, by default, from the matched seed.
 */
export function createFixtureArmEvaluator(
  options: {
    evaluator_id?: string;
    pass?: (input: {
      arm: SpecialistArm;
      task_id: string;
      repeat: number;
      seed: string;
    }) => boolean;
    cost_usd_per_task?: number | null;
    runtime_ms_per_task?: number | null;
  } = {},
): SpecialistArmEvaluator & { calls: ArmEvaluationInput[] } {
  const calls: ArmEvaluationInput[] = [];
  const pass =
    options.pass ??
    (({ arm, task_id, repeat, seed }) =>
      Number.parseInt(
        sha256(canonicalJson([seed, arm, task_id, repeat])).slice(0, 8),
        16,
      ) %
        2 ===
      0);
  return {
    evaluator_id: options.evaluator_id ?? "fixture-evaluator",
    evaluator_revision: "1",
    harness: { component: "harness/fixture", revision: "1" },
    suite: { suite_id: "fixture-heldout", revision: "1" },
    simulated: true,
    calls,
    async evaluate(input) {
      calls.push(input);
      input.signal.throwIfAborted();
      return {
        agent_manifest_sha256: sha256(
          canonicalJson([
            "fixture-agent",
            input.target.arm,
            input.target.model,
          ]),
        ),
        model_requests: 0,
        outcomes: input.tasks.map((task) => ({
          task_id: task.task_id,
          rewards: Array.from({ length: input.repeats }, (_, repeat) =>
            pass({
              arm: input.target.arm,
              task_id: task.task_id,
              repeat,
              seed: input.seed,
            })
              ? 1
              : 0,
          ),
          cost_usd:
            options.cost_usd_per_task === undefined
              ? 0
              : options.cost_usd_per_task,
          runtime_ms:
            options.runtime_ms_per_task === undefined
              ? 100
              : options.runtime_ms_per_task,
          input_tokens: 10,
          output_tokens: 10,
        })),
      };
    },
  };
}
