import { Database } from "bun:sqlite";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import path from "node:path";
import type { ArtifactRef, EvaluationService } from "@mars/contracts";
import { sha256 } from "@mars/contracts/canonical";
import { SpecialistRegistryError } from "../src";
import {
  context,
  createRegistry,
  createTempRoot,
  installNoNetworkStub,
  MemoryArtifacts,
  makeBaseline,
  makeSpecialistFixture,
  removeTempRoot,
} from "./helpers";

const roots: string[] = [];
let restoreFetch: (() => void) | undefined;
beforeAll(() => {
  restoreFetch = installNoNetworkStub();
});
afterAll(() => restoreFetch?.());
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

const budget = {
  max_tokens: 1000,
  max_usd: 1,
  max_duration_ms: 1000,
  max_depth: 1,
  max_concurrency: 1,
};

async function expectCode(
  callback: () => Promise<unknown>,
  code: SpecialistRegistryError["code"],
  detail?: string | RegExp,
): Promise<void> {
  const error = await callback().then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(SpecialistRegistryError);
  const registryError = error as SpecialistRegistryError;
  expect(registryError.code).toBe(code);
  if (typeof detail === "string") expect(registryError.detail).toBe(detail);
  if (detail instanceof RegExp) expect(registryError.detail).toMatch(detail);
}

async function setup(root?: string) {
  const rootDir = root ?? (await createTempRoot());
  if (!root) roots.push(rootDir);
  const artifacts = new MemoryArtifacts();
  let jobs = 0;
  const service: EvaluationService = {
    async submitComparison(_ctx, input_manifest) {
      jobs += 1;
      return { job_id: `job-${jobs}`, input_manifest };
    },
    async inspect() {
      throw new Error("not used");
    },
    async cancel() {},
  };
  const registry = createRegistry(rootDir, artifacts, {
    evaluation: {
      service,
      artifacts: {
        async put(_ctx, bytes, media_type) {
          return {
            artifact_id: `evaluation-request-${jobs + 1}`,
            sha256: sha256(bytes),
            media_type,
            byte_length: bytes.byteLength,
          };
        },
      },
      defaultBudget: budget,
    },
  });
  await registry.registerBaseline(context, makeBaseline());
  const fixture = await makeSpecialistFixture(artifacts);
  await registry.registerSpecialist(context, fixture.registration);
  return { root: rootDir, artifacts, registry, fixture };
}

function entry(
  job: { job_id: string; input_manifest: ArtifactRef },
  report: ArtifactRef,
  candidateSha256: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    job,
    report,
    verdict: { ...report, artifact_id: `verdict-${job.job_id}` },
    value: {
      schema: "mars.specialist-comparison-verdict/v1",
      job_id: job.job_id,
      subject: {
        specialist_id: "specialist-1",
        revision: "1",
        candidate_sha256: candidateSha256,
      },
      report,
      outcome: "improved",
      codes: [],
      simulated: true,
      model_requests: 0,
      ...overrides,
    },
  };
}

describe("registry-side comparison verdict receiver", () => {
  test("stores a re-verified verdict against the revision, idempotently", async () => {
    const { registry, fixture } = await setup();
    const job = await registry.requestEvaluation(context, "specialist-1", "1");
    const record = entry(
      job,
      fixture.registration.evaluation,
      fixture.candidateSha256,
    );
    const view = await registry.recordEvaluationVerdict(context, record);
    expect(view).toMatchObject({
      job_id: job.job_id,
      specialist_id: "specialist-1",
      revision: "1",
      outcome: "improved",
      simulated: true,
      evidence: { status: "evaluated", codes: [] },
    });
    expect(await registry.recordEvaluationVerdict(context, record)).toEqual(
      view,
    );
    expect(
      await registry.evaluationVerdicts(context, "specialist-1", "1"),
    ).toEqual([view]);
    const audit = await registry.audit(context);
    expect(
      audit.filter((event) => event.action === "evaluation.recorded"),
    ).toHaveLength(1);
  });

  test("an authentic no-improvement report is recorded and demotes the revision", async () => {
    const { artifacts, registry, fixture } = await setup();
    const worse = await makeSpecialistFixture(artifacts, {
      reportId: "report-heldout-worse",
      candidatePassed: 0,
      basePassed: 1,
    });
    expect(worse.candidateSha256).toBe(fixture.candidateSha256);
    const job = await registry.requestEvaluation(context, "specialist-1", "1");
    const view = await registry.recordEvaluationVerdict(
      context,
      entry(job, worse.registration.evaluation, worse.candidateSha256, {
        outcome: "regressed",
      }),
    );
    expect(view.outcome).toBe("regressed");
    expect(view.evidence.status).toBe("rejected");
    const inspection = await registry.inspect(context, "specialist-1");
    expect(inspection.revisions[0]?.status).toBe("rejected");
    // Later re-verification keeps gating on the recorded held-out report.
    expect((await registry.reverify(context, "specialist-1", "1")).status).toBe(
      "rejected",
    );
  });

  test("refuses verdicts it cannot tie to a delegated job and revision", async () => {
    const { artifacts, registry, fixture } = await setup();
    const job = await registry.requestEvaluation(context, "specialist-1", "1");
    const report = fixture.registration.evaluation;
    await expectCode(
      () =>
        registry.recordEvaluationVerdict(
          context,
          entry(
            { ...job, job_id: "not-delegated" },
            report,
            fixture.candidateSha256,
            { job_id: "not-delegated" },
          ),
        ),
      "not_found",
      "evaluation_job",
    );
    await expectCode(
      () =>
        registry.recordEvaluationVerdict(
          context,
          entry(job, report, "0".repeat(64)),
        ),
      "invalid_input",
      "verdict_mismatch",
    );
    await expectCode(
      () =>
        registry.recordEvaluationVerdict(
          context,
          entry(job, report, fixture.candidateSha256, {
            report: { ...report, artifact_id: "other" },
          }),
        ),
      "invalid_input",
      "verdict_mismatch",
    );
    await expectCode(
      () =>
        registry.recordEvaluationVerdict(context, {
          ...entry(job, report, fixture.candidateSha256),
          value: { outcome: "improved" },
        }),
      "invalid_input",
      "verdict_record",
    );
    const forged = await makeSpecialistFixture(artifacts, {
      reportId: "report-forged",
      tamperSignature: "bad_mac",
    });
    await expectCode(
      () =>
        registry.recordEvaluationVerdict(
          context,
          entry(job, forged.registration.evaluation, fixture.candidateSha256),
        ),
      "invalid_input",
      /^verdict_evidence_rejected:.*evidence_unverified/,
    );
    expect(
      await registry.evaluationVerdicts(context, "specialist-1", "1"),
    ).toEqual([]);

    await registry.recordEvaluationVerdict(
      context,
      entry(job, report, fixture.candidateSha256),
    );
    const other = await makeSpecialistFixture(artifacts, {
      reportId: "report-other",
    });
    await expectCode(
      () =>
        registry.recordEvaluationVerdict(
          context,
          entry(job, other.registration.evaluation, fixture.candidateSha256),
        ),
      "conflict",
      "verdict_recorded",
    );
  });

  test("migrates a format v1 store and refuses unknown formats", async () => {
    const first = await setup();
    first.registry.close();
    const dbPath = path.join(first.root, "specialists.sqlite");
    let db = new Database(dbPath);
    db.exec(
      "DROP TABLE evaluation_verdicts; UPDATE meta SET value = '1' WHERE key = 'format_version';",
    );
    db.close();
    const reopened = await setupExisting(first.root);
    expect(
      await reopened.evaluationVerdicts(context, "specialist-1", "1"),
    ).toEqual([]);
    reopened.close();
    db = new Database(dbPath);
    expect(
      db.query("SELECT value FROM meta WHERE key = 'format_version'").get(),
    ).toEqual({ value: "2" });
    db.exec("UPDATE meta SET value = '3' WHERE key = 'format_version';");
    db.close();
    expect(() => createRegistry(first.root, new MemoryArtifacts())).toThrow(
      SpecialistRegistryError,
    );
  });
});

async function setupExisting(root: string) {
  return createRegistry(root, new MemoryArtifacts());
}
