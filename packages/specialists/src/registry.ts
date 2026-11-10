import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  type ArtifactRef,
  ArtifactRefSchema,
  type Budget,
  type EvaluationService,
  type JobRef,
  type ModelRegistry,
  type RequestContext,
  type SpecialistManifest,
  type Task,
  type VersionRef,
} from "@mars/contracts";
import type { z } from "zod";
import {
  assertPublishable,
  candidateDigest,
  canonicalJson,
  decisionDigest,
  sameJson,
  scopeKey,
  sha256,
} from "./canonical";
import {
  type BindingCompatibility,
  baselineCompatibility,
  type CompatibilityOptions,
  checkServingReadiness,
  checkSpecialistBindings,
  compatibleBase,
  firstPassingBinding,
  type ModelCatalog,
  type ServingAttestor,
} from "./compat";
import { SpecialistRegistryError } from "./errors";
import {
  type ArtifactLoader,
  type EvidenceVerdict,
  type EvidenceVerifier,
  type TripleGate,
  verifyEvidence,
} from "./evidence";
import {
  makeRoutingDecision,
  normalizeReasons,
  rankCandidates,
  resolveFallbackChain,
} from "./routing";
import {
  type BaselineProfile,
  BaselineProfileSchema,
  ComparisonVerdictRecordSchema,
  type Complexity,
  type EvaluationReport,
  EvaluationReportSchema,
  EvidenceVerdictSchema,
  type ReasonCode,
  RequestContextSchema,
  type RoutingDecision,
  RoutingDecisionSchema,
  type RoutingRequest,
  RoutingRequestSchema,
  type SelectedTarget,
  type SpecialistProfile,
  type SpecialistRegistration,
  SpecialistRegistrationSchema,
  type TaskRoutingState,
  TaskRoutingStateSchema,
} from "./schemas";
import {
  type BaselineRow,
  type EvaluationVerdictRow,
  type ProductionRow,
  type SpecialistRevisionRow,
  SpecialistStore,
} from "./store";

export interface EvaluationArtifacts {
  put(
    context: RequestContext,
    data: Uint8Array,
    mediaType: string,
  ): Promise<ArtifactRef>;
}

export interface SpecialistEvaluationOptions {
  service: EvaluationService;
  artifacts: EvaluationArtifacts;
  defaultBudget: Budget;
}

export interface SpecialistRegistryOptions {
  rootDir: string;
  artifacts: ArtifactLoader;
  catalog: ModelCatalog;
  evidenceVerifier?: EvidenceVerifier;
  servingAttestor?: ServingAttestor;
  hostPrivateRoots?: readonly string[];
  maxArtifactBytes?: number;
  allowSyntheticFixtures?: boolean;
  evaluation?: SpecialistEvaluationOptions;
  taskRouting?: (task: Task) => RoutingRequest;
  contractProfiles?: (
    context: RequestContext,
    manifest: SpecialistManifest,
  ) => SpecialistProfile | undefined | Promise<SpecialistProfile | undefined>;
}

export interface SpecialistPointerView {
  specialist_id: string;
  production_revision: string | null;
  history: string[];
  retired: boolean;
  pointer_version: number;
}

export interface SpecialistRevisionView {
  registration: SpecialistRegistration;
  status: "proposed" | "evaluated" | "rejected" | "archived" | "invalidated";
  candidate_sha256: string;
  verdict: EvidenceVerdict;
  deployment: "production" | "previous" | "none";
  rolled_back: boolean;
  invalidated_reason: string | null;
  evaluation_jobs: JobRef[];
}

export interface EvaluationVerdictView {
  job_id: string;
  specialist_id: string;
  revision: string;
  outcome: "improved" | "no_improvement" | "regressed";
  simulated: boolean;
  report: ArtifactRef;
  verdict: ArtifactRef;
  evidence: EvidenceVerdict;
  recorded_at: string;
}

export interface SpecialistInspection {
  pointer: SpecialistPointerView;
  revisions: SpecialistRevisionView[];
}

export interface BaselineView {
  profile: BaselineProfile;
  status: "active" | "retired";
}

export type SpecialistRef =
  | { kind: "specialist"; id: string; revision: string }
  | { kind: "baseline"; id: string; revision: string };

export function formatRef(
  kind: "specialist" | "baseline",
  id: string,
  revision: string,
): string {
  return `${kind}:${id}@${revision}`;
}

export function parseRef(value: string): SpecialistRef | null {
  const match =
    /^(specialist|baseline):([a-z0-9][a-z0-9._:-]{0,127})@([a-z0-9][a-z0-9._:-]{0,127})$/.exec(
      value,
    );
  if (!match || match[3] === "none") return null;
  return {
    kind: match[1] as "specialist" | "baseline",
    id: match[2] as string,
    revision: match[3] as string,
  };
}

function contractRef(value: string): { id: string; revision: string } {
  const match =
    /^([a-z0-9][a-z0-9._:-]{0,127})@([a-z0-9][a-z0-9._:-]{0,127})$/.exec(value);
  if (!match || match[2] === "none") {
    throw new SpecialistRegistryError("invalid_input", "ref_invalid");
  }
  return { id: match[1] as string, revision: match[2] as string };
}

type ScopeValue = {
  owner_id: string;
  project_id: string;
  workspace_id?: string | undefined;
};

function scopeEquals(left: ScopeValue, right: ScopeValue): boolean {
  return sameJson(
    {
      owner_id: left.owner_id,
      project_id: left.project_id,
      workspace_id: left.workspace_id ?? null,
    },
    {
      owner_id: right.owner_id,
      project_id: right.project_id,
      workspace_id: right.workspace_id ?? null,
    },
  );
}

function visible(scope: ScopeValue, context: RequestContext): boolean {
  return (
    scope.owner_id === context.scope.owner_id &&
    scope.project_id === context.scope.project_id &&
    (scope.workspace_id === undefined ||
      scope.workspace_id === context.scope.workspace_id)
  );
}

function parseRegistration(value: unknown): SpecialistRegistration {
  const parsed = SpecialistRegistrationSchema.safeParse(value);
  if (!parsed.success) {
    throw new SpecialistRegistryError("invalid_input", "schema_invalid");
  }
  return parsed.data as SpecialistRegistration;
}

function parseBaseline(value: unknown): BaselineProfile {
  const parsed = BaselineProfileSchema.safeParse(value);
  if (!parsed.success) {
    throw new SpecialistRegistryError("invalid_input", "schema_invalid");
  }
  return parsed.data;
}

function assertContext(context: RequestContext): RequestContext {
  const parsed = RequestContextSchema.safeParse(context);
  if (!parsed.success) {
    throw new SpecialistRegistryError("invalid_input", "context_invalid");
  }
  return parsed.data;
}

/** Report-integrity failures: such a verdict is refused, never stored. */
/** Report id `@mars/evaluation` signs into the report of a comparison job. */
export function comparisonReportId(jobId: string): string {
  return `report-${jobId}`;
}

const UNTRUSTED_VERDICT_CODES = new Set<string>([
  "evidence_missing",
  "evidence_digest_mismatch",
  "evidence_malformed",
  "evidence_subject_mismatch",
  "evidence_unauthorized",
  "evidence_unverified",
  "evidence_synthetic_fixture",
  "evidence_not_independent",
]);

function parseStored<S extends z.ZodTypeAny>(
  json: string,
  schema: S,
): z.output<S> {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new SpecialistRegistryError("corrupt_record");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new SpecialistRegistryError("corrupt_record");
  return parsed.data;
}

function parseVerdict(value: string): EvidenceVerdict {
  return parseStored(value, EvidenceVerdictSchema);
}

function parseHistory(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !Array.isArray(parsed) ||
      parsed.some((item) => typeof item !== "string")
    ) {
      throw new Error();
    }
    return parsed as string[];
  } catch {
    throw new SpecialistRegistryError("corrupt_record");
  }
}

function parseContractRevision(value: string | null): string | null {
  return value === "none" ? null : value;
}

function noReasonDuplicates(reasons: ReasonCode[]): ReasonCode[] {
  return normalizeReasons(reasons);
}

function makeSelectedSpecialist(
  registration: SpecialistRegistration,
  revisionRow: {
    record_sha256: string;
  },
  verdict: EvidenceVerdict,
  binding: BindingCompatibility,
  triple: TripleGate,
): SelectedTarget {
  return {
    kind: "specialist",
    ref: formatRef(
      "specialist",
      registration.specialist_id,
      registration.revision,
    ),
    specialist_id: registration.specialist_id,
    baseline_id: null,
    revision: registration.revision,
    model_id: binding.binding.model_id,
    provider_id: binding.binding.provider_id,
    provider_model: binding.binding.provider_model,
    base_model: registration.base_model,
    adapter_sha256: registration.adapter?.sha256 ?? null,
    manifest_sha256: revisionRow.record_sha256,
    evidence:
      verdict.report_id === null || verdict.report_sha256 === null
        ? null
        : {
            report_id: verdict.report_id,
            report_sha256: verdict.report_sha256,
            pass_rate: triple.pass_rate,
            base_pass_rate: triple.base_pass_rate,
            prompt_optimized_pass_rate: triple.prompt_optimized_pass_rate,
            current_pass_rate: triple.current_pass_rate,
            cost_usd_per_task: triple.cost_usd_per_task,
            runtime_ms_p95: triple.runtime_ms_p95,
            synthetic_fixture: verdict.synthetic_fixture,
          },
    cost_basis: "measured",
    serving_attestation: binding.serving_attestation,
  };
}

function makeSelectedBaseline(
  baseline: BaselineProfile,
  binding: BindingCompatibility,
  recordSha: string,
): SelectedTarget {
  return {
    kind: "baseline",
    ref: formatRef("baseline", baseline.baseline_id, baseline.revision),
    specialist_id: null,
    baseline_id: baseline.baseline_id,
    revision: baseline.revision,
    model_id: baseline.model_id,
    provider_id: baseline.provider_id,
    provider_model: baseline.provider_model,
    base_model: null,
    adapter_sha256: null,
    manifest_sha256: recordSha,
    evidence: null,
    cost_basis: binding.cost_basis,
    serving_attestation: "absent",
  };
}

interface CandidateResult {
  ref: string;
  specialist_id: string;
  revision: string;
  registration: SpecialistRegistration;
  candidate_sha256: string;
  verdict: EvidenceVerdict;
  reasons: ReasonCode[];
  target: SelectedTarget | null;
  pass_rate: number;
  cost_usd_per_task: number | null;
  runtime_ms_p95: number | null;
  covering: boolean;
  production: ProductionRow;
}

interface RouteMeta {
  retry_of: string | null;
  attempt: number;
}

export class SpecialistRegistry implements ModelRegistry {
  readonly options: SpecialistRegistryOptions;
  readonly store: SpecialistStore;
  private readonly compatibilityOptions: CompatibilityOptions;
  /** Submissions whose job row is not written yet, by input manifest sha256. */
  private readonly pendingEvaluations = new Map<string, Set<Promise<void>>>();
  private readonly rootDir: string;

  constructor(options: SpecialistRegistryOptions) {
    if (
      !options ||
      typeof options.rootDir !== "string" ||
      !Array.isArray(options.hostPrivateRoots ?? [])
    ) {
      throw new SpecialistRegistryError("unsafe_path", "options_invalid");
    }
    for (const root of options.hostPrivateRoots ?? []) {
      if (
        typeof root !== "string" ||
        !path.isAbsolute(root) ||
        path.resolve(root) === path.parse(path.resolve(root)).root
      ) {
        throw new SpecialistRegistryError(
          "invalid_input",
          "private_root_invalid",
        );
      }
    }
    this.options = options;
    this.store = new SpecialistStore({
      rootDir: options.rootDir,
      ...(options.hostPrivateRoots
        ? { hostPrivateRoots: options.hostPrivateRoots }
        : {}),
    });
    this.rootDir = this.store.rootDir;
    this.compatibilityOptions = {
      catalog: options.catalog,
      ...(options.servingAttestor
        ? { servingAttestor: options.servingAttestor }
        : {}),
    };
  }

  private assertOpen(): void {
    this.store.assertOpen();
  }

  private checkContext(context: RequestContext): RequestContext {
    this.assertOpen();
    return assertContext(context);
  }

  private publish(value: unknown): void {
    assertPublishable(value, {
      rootDir: this.rootDir,
      ...(this.options.hostPrivateRoots
        ? { hostPrivateRoots: this.options.hostPrivateRoots }
        : {}),
    });
  }

  private evidenceOptions(
    extra: {
      currentProductionRevision?: string | null;
      checkCurrentFreshness?: boolean;
    } = {},
  ) {
    return {
      artifacts: this.options.artifacts,
      ...(this.options.evidenceVerifier
        ? { evidenceVerifier: this.options.evidenceVerifier }
        : {}),
      ...(this.options.allowSyntheticFixtures !== undefined
        ? { allowSyntheticFixtures: this.options.allowSyntheticFixtures }
        : {}),
      ...(this.options.maxArtifactBytes !== undefined
        ? { maxArtifactBytes: this.options.maxArtifactBytes }
        : {}),
      ...extra,
    };
  }

  /**
   * The registration whose evidence gates this revision: the latest held-out
   * comparison report received via `recordEvaluationVerdict` supersedes the
   * evaluation report the revision was registered with.
   */
  private latestVerdictJob(
    scope: string,
    id: string,
    revision: string,
  ): string | null {
    return (
      this.store.listEvaluationVerdicts(scope, id, revision).at(-1)?.job_id ??
      null
    );
  }

  private evidenceRegistration(
    registration: SpecialistRegistration,
  ): SpecialistRegistration {
    const latest = this.store
      .listEvaluationVerdicts(
        scopeKey(registration.scope),
        registration.specialist_id,
        registration.revision,
      )
      .at(-1);
    if (!latest) return registration;
    return {
      ...registration,
      evaluation: parseStored(latest.report_json, ArtifactRefSchema),
    };
  }

  private verifiedRegistration(row: {
    record_json: string;
    record_sha256: string;
  }): SpecialistRegistration {
    return this.store.parseRecord(
      row.record_json,
      row.record_sha256,
      parseRegistration,
    );
  }

  private specialistRow(context: RequestContext, id: string, revision: string) {
    const row = this.store.readSpecialist(
      scopeKey(context.scope),
      id,
      revision,
    );
    if (!row) throw new SpecialistRegistryError("not_found");
    const registration = this.verifiedRegistration(row);
    if (!visible(registration.scope, context)) {
      throw new SpecialistRegistryError("not_found");
    }
    return { row, registration };
  }

  private visibleSpecialist(
    context: RequestContext,
    id: string,
    revision: string,
  ) {
    const keys = [
      scopeKey(context.scope),
      scopeKey({
        owner_id: context.scope.owner_id,
        project_id: context.scope.project_id,
      }),
    ];
    const uniqueKeys = [...new Set(keys)];
    const rows = this.store.db
      .query(
        `SELECT scope_key, specialist_id, revision, record_json, record_sha256,
          candidate_sha256, status, verdict_json, invalidated_reason,
          rolled_back_at, created_at, updated_at
         FROM specialist_revisions
         WHERE specialist_id = ? AND revision = ? AND scope_key IN (${uniqueKeys
           .map(() => "?")
           .join(", ")})`,
      )
      .all(id, revision, ...uniqueKeys) as SpecialistRevisionRow[];
    const ordered = rows.sort(
      (left, right) =>
        Number(right.scope_key === scopeKey(context.scope)) -
        Number(left.scope_key === scopeKey(context.scope)),
    );
    for (const row of ordered) {
      const registration = this.verifiedRegistration(row);
      if (visible(registration.scope, context)) {
        return { row, registration };
      }
    }
    throw new SpecialistRegistryError("not_found");
  }

  private visibleSpecialistByTarget(
    context: RequestContext,
    target: SelectedTarget,
  ) {
    if (
      target.kind !== "specialist" ||
      !target.specialist_id ||
      !target.manifest_sha256
    ) {
      throw new SpecialistRegistryError("corrupt_record");
    }
    const keys = [
      ...new Set([
        scopeKey(context.scope),
        scopeKey({
          owner_id: context.scope.owner_id,
          project_id: context.scope.project_id,
        }),
      ]),
    ];
    const rows = this.store.db
      .query(
        `SELECT scope_key, specialist_id, revision, record_json, record_sha256,
          candidate_sha256, status, verdict_json, invalidated_reason,
          rolled_back_at, created_at, updated_at
         FROM specialist_revisions WHERE specialist_id = ? AND revision = ?
          AND scope_key IN (${keys.map(() => "?").join(", ")})`,
      )
      .all(
        target.specialist_id,
        target.revision,
        ...keys,
      ) as SpecialistRevisionRow[];
    const row = rows.find(
      (candidate) =>
        candidate.record_sha256 === target.manifest_sha256 &&
        visible(this.verifiedRegistration(candidate).scope, context),
    );
    if (!row) throw new SpecialistRegistryError("corrupt_record");
    return { row, registration: this.verifiedRegistration(row) };
  }

  private assertSpecialistScope(
    context: RequestContext,
    specialistId: string,
  ): void {
    const projectKey = scopeKey({
      owner_id: context.scope.owner_id,
      project_id: context.scope.project_id,
    });
    if (context.scope.workspace_id !== undefined) {
      const found = this.store.db
        .query(
          "SELECT 1 FROM specialist_revisions WHERE specialist_id = ? AND scope_key = ? LIMIT 1",
        )
        .get(specialistId, projectKey);
      if (found)
        throw new SpecialistRegistryError(
          "conflict",
          "shadows_project_specialist",
        );
      return;
    }
    const rows = this.store.db
      .query(
        "SELECT record_json, record_sha256 FROM specialist_revisions WHERE specialist_id = ?",
      )
      .all(specialistId) as Array<
      Pick<SpecialistRevisionRow, "record_json" | "record_sha256">
    >;
    if (
      rows.some((row) => {
        const scope = this.verifiedRegistration(row).scope;
        return (
          scope.owner_id === context.scope.owner_id &&
          scope.project_id === context.scope.project_id &&
          scope.workspace_id !== undefined
        );
      })
    ) {
      throw new SpecialistRegistryError(
        "conflict",
        "shadowed_by_workspace_specialist",
      );
    }
  }

  private assertBaselineScope(
    context: RequestContext,
    baselineId: string,
  ): void {
    const projectKey = scopeKey({
      owner_id: context.scope.owner_id,
      project_id: context.scope.project_id,
    });
    if (context.scope.workspace_id !== undefined) {
      const found = this.store.db
        .query(
          "SELECT 1 FROM baselines WHERE baseline_id = ? AND scope_key = ? LIMIT 1",
        )
        .get(baselineId, projectKey);
      if (found)
        throw new SpecialistRegistryError(
          "conflict",
          "shadows_project_baseline",
        );
      return;
    }
    const rows = this.store.db
      .query(
        "SELECT record_json, record_sha256 FROM baselines WHERE baseline_id = ?",
      )
      .all(baselineId) as Array<
      Pick<BaselineRow, "record_json" | "record_sha256">
    >;
    if (
      rows.some((row) => {
        const scope = this.store.parseRecord(
          row.record_json,
          row.record_sha256,
          parseBaseline,
        ).scope;
        return (
          scope.owner_id === context.scope.owner_id &&
          scope.project_id === context.scope.project_id &&
          scope.workspace_id !== undefined
        );
      })
    ) {
      throw new SpecialistRegistryError(
        "conflict",
        "shadowed_by_workspace_baseline",
      );
    }
  }

  private visibleBaseline(
    context: RequestContext,
    id: string,
    revision: string,
  ) {
    const keys = [
      scopeKey(context.scope),
      scopeKey({
        owner_id: context.scope.owner_id,
        project_id: context.scope.project_id,
      }),
    ];
    const uniqueKeys = [...new Set(keys)];
    const rows = this.store.db
      .query(
        `SELECT scope_key, baseline_id, revision, record_json, record_sha256,
          status, created_at FROM baselines
         WHERE baseline_id = ? AND revision = ? AND scope_key IN (${uniqueKeys
           .map(() => "?")
           .join(", ")})`,
      )
      .all(id, revision, ...uniqueKeys) as BaselineRow[];
    rows.sort(
      (left, right) =>
        Number(right.scope_key === scopeKey(context.scope)) -
        Number(left.scope_key === scopeKey(context.scope)),
    );
    for (const row of rows) {
      const profile = this.store.parseRecord(
        row.record_json,
        row.record_sha256,
        parseBaseline,
      );
      if (visible(profile.scope, context)) return { row, profile };
    }
    throw new SpecialistRegistryError("not_found");
  }

  private baselineRow(context: RequestContext, id: string, revision: string) {
    const row = this.store.readBaseline(scopeKey(context.scope), id, revision);
    if (!row) throw new SpecialistRegistryError("not_found");
    const profile = this.store.parseRecord(
      row.record_json,
      row.record_sha256,
      parseBaseline,
    );
    if (!visible(profile.scope, context)) {
      throw new SpecialistRegistryError("not_found");
    }
    return { row, profile };
  }

  private assertRegistrationStructure(
    context: RequestContext,
    registration: SpecialistRegistration,
  ): void {
    if (!scopeEquals(registration.scope, context.scope)) {
      throw new SpecialistRegistryError("scope_denied");
    }
    const adapterSpec = registration.profile.adapter_spec;
    if (registration.adapter) {
      if (!adapterSpec) {
        throw new SpecialistRegistryError(
          "invalid_input",
          "adapter_spec_required",
        );
      }
      if (!registration.dataset_lineage) {
        throw new SpecialistRegistryError("invalid_input", "lineage_required");
      }
      if (!sameJson(adapterSpec.base_model, registration.base_model)) {
        throw new SpecialistRegistryError(
          "invalid_input",
          "adapter_base_mismatch",
        );
      }
      if (!sameJson(adapterSpec.tokenizer, registration.tokenizer)) {
        throw new SpecialistRegistryError(
          "invalid_input",
          "adapter_tokenizer_mismatch",
        );
      }
      if (
        adapterSpec.chat_template_sha256 !== registration.chat_template.sha256
      ) {
        throw new SpecialistRegistryError(
          "invalid_input",
          "adapter_chat_template_mismatch",
        );
      }
      if (
        registration.profile.serving.some(
          (binding) => binding.adapter_format !== adapterSpec.format,
        )
      ) {
        throw new SpecialistRegistryError(
          "invalid_input",
          "serving_format_mismatch",
        );
      }
    } else if (
      adapterSpec !== null ||
      registration.profile.serving.some(
        (binding) => binding.adapter_format !== null,
      )
    ) {
      throw new SpecialistRegistryError(
        "invalid_input",
        "serving_format_mismatch",
      );
    }
    const fallback = parseRef(registration.fallback_specialist_revision);
    if (!fallback) {
      throw new SpecialistRegistryError(
        "invalid_input",
        "fallback_ref_invalid",
      );
    }
    if (
      fallback.kind === "specialist" &&
      fallback.id === registration.specialist_id &&
      fallback.revision === registration.revision
    ) {
      throw new SpecialistRegistryError(
        "invalid_input",
        "fallback_self_reference",
      );
    }
    const sameScopeKey = scopeKey(registration.scope);
    const found =
      fallback.kind === "specialist"
        ? this.store.readSpecialist(
            sameScopeKey,
            fallback.id,
            fallback.revision,
          )
        : this.store.readBaseline(sameScopeKey, fallback.id, fallback.revision);
    if (!found) {
      throw new SpecialistRegistryError(
        "invalid_input",
        "fallback_target_missing",
      );
    }
    const fallbackScope =
      fallback.kind === "specialist"
        ? this.store.parseRecord(
            found.record_json,
            found.record_sha256,
            parseRegistration,
          ).scope
        : this.store.parseRecord(
            found.record_json,
            found.record_sha256,
            parseBaseline,
          ).scope;
    if (!scopeEquals(fallbackScope, registration.scope)) {
      throw new SpecialistRegistryError(
        "invalid_input",
        "fallback_target_missing",
      );
    }
    this.publish(registration);
  }

  async registerSpecialist(
    context: RequestContext,
    input: unknown,
  ): Promise<SpecialistRevisionView> {
    const ctx = this.checkContext(context);
    const registration = parseRegistration(input);
    this.assertRegistrationStructure(ctx, registration);
    const key = scopeKey(ctx.scope);
    const recordJson = canonicalJson(registration);
    const recordSha = sha256(recordJson);
    const candidateSha = candidateDigest(registration);
    const existing = this.store.readSpecialist(
      key,
      registration.specialist_id,
      registration.revision,
    );
    if (existing) {
      const existingRegistration = this.verifiedRegistration(existing);
      if (canonicalJson(existingRegistration) !== recordJson) {
        throw new SpecialistRegistryError("conflict", "revision_immutable");
      }
      return this.revisionView(ctx, existing, existingRegistration);
    }
    const production = this.store.readProduction(
      key,
      registration.specialist_id,
    );
    const verdict = await verifyEvidence(
      ctx,
      this.evidenceRegistration(registration),
      candidateSha,
      this.evidenceOptions({
        currentProductionRevision: production?.production_revision ?? null,
      }),
    );
    this.publish({ registration, verdict });
    const now = new Date().toISOString();
    let concurrentView: SpecialistRevisionView | undefined;
    this.store.transaction(() => {
      const concurrent = this.store.readSpecialist(
        key,
        registration.specialist_id,
        registration.revision,
      );
      if (concurrent) {
        const concurrentRegistration = this.verifiedRegistration(concurrent);
        if (canonicalJson(concurrentRegistration) !== recordJson) {
          throw new SpecialistRegistryError("conflict", "revision_immutable");
        }
        concurrentView = this.revisionView(
          ctx,
          concurrent,
          concurrentRegistration,
        );
        return;
      }
      this.assertSpecialistScope(ctx, registration.specialist_id);
      this.store.db
        .query(
          `INSERT INTO specialist_revisions
           (scope_key, specialist_id, revision, record_json, record_sha256,
            candidate_sha256, status, verdict_json, invalidated_reason,
            rolled_back_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
        )
        .run(
          key,
          registration.specialist_id,
          registration.revision,
          recordJson,
          recordSha,
          candidateSha,
          verdict.status,
          canonicalJson(verdict),
          now,
          now,
        );
      this.store.db
        .query(
          `INSERT OR IGNORE INTO production
           (scope_key, specialist_id, production_revision, history_json,
            retired, pointer_version, updated_at)
           VALUES (?, ?, NULL, '[]', 0, 0, ?)`,
        )
        .run(key, registration.specialist_id, now);
      this.store.writeAudit({
        context: ctx,
        scope_key: key,
        action: "specialist.registered",
        subject: formatRef(
          "specialist",
          registration.specialist_id,
          registration.revision,
        ),
        detail: { candidate_sha256: candidateSha, status: verdict.status },
      });
    });
    if (concurrentView) return concurrentView;
    const row = this.store.readSpecialist(
      key,
      registration.specialist_id,
      registration.revision,
    );
    if (!row) throw new SpecialistRegistryError("corrupt_record");
    return this.revisionView(ctx, row, registration);
  }

  async register(
    context: RequestContext,
    manifest: SpecialistManifest,
  ): Promise<void> {
    const ctx = this.checkContext(context);
    const candidate = manifest as SpecialistManifest & {
      profile?: SpecialistProfile;
    };
    const resolved = await this.options.contractProfiles?.(ctx, manifest);
    if (
      candidate.profile !== undefined &&
      resolved !== undefined &&
      canonicalJson(candidate.profile) !== canonicalJson(resolved)
    ) {
      throw new SpecialistRegistryError("invalid_input", "profile_conflict");
    }
    const profile = candidate.profile ?? resolved;
    if (profile === undefined) {
      throw new SpecialistRegistryError("invalid_input", "profile_required");
    }
    await this.registerSpecialist(ctx, {
      ...manifest,
      profile,
    } as SpecialistRegistration);
  }

  async registerBaseline(
    context: RequestContext,
    input: unknown,
  ): Promise<BaselineView> {
    const ctx = this.checkContext(context);
    const profile = parseBaseline(input);
    if (!scopeEquals(profile.scope, ctx.scope)) {
      throw new SpecialistRegistryError("scope_denied");
    }
    this.publish(profile);
    const key = scopeKey(ctx.scope);
    const json = canonicalJson(profile);
    const digest = sha256(json);
    const existing = this.store.readBaseline(
      key,
      profile.baseline_id,
      profile.revision,
    );
    if (existing) {
      const old = this.store.parseRecord(
        existing.record_json,
        existing.record_sha256,
        parseBaseline,
      );
      if (canonicalJson(old) !== json) {
        throw new SpecialistRegistryError("conflict", "revision_immutable");
      }
      return {
        profile: old,
        status: existing.status as BaselineView["status"],
      };
    }
    const now = new Date().toISOString();
    let concurrentView: BaselineView | undefined;
    this.store.transaction(() => {
      const concurrent = this.store.readBaseline(
        key,
        profile.baseline_id,
        profile.revision,
      );
      if (concurrent) {
        const old = this.store.parseRecord(
          concurrent.record_json,
          concurrent.record_sha256,
          parseBaseline,
        );
        if (canonicalJson(old) !== json) {
          throw new SpecialistRegistryError("conflict", "revision_immutable");
        }
        concurrentView = {
          profile: old,
          status: concurrent.status as BaselineView["status"],
        };
        return;
      }
      this.assertBaselineScope(ctx, profile.baseline_id);
      this.store.db
        .query(
          `INSERT INTO baselines
           (scope_key, baseline_id, revision, record_json, record_sha256, status, created_at)
           VALUES (?, ?, ?, ?, ?, 'active', ?)`,
        )
        .run(key, profile.baseline_id, profile.revision, json, digest, now);
      this.store.writeAudit({
        context: ctx,
        scope_key: key,
        action: "baseline.registered",
        subject: formatRef("baseline", profile.baseline_id, profile.revision),
        detail: { status: "active" },
      });
    });
    if (concurrentView) return concurrentView;
    return { profile, status: "active" };
  }

  async retireBaseline(
    context: RequestContext,
    id: string,
    revision: string,
  ): Promise<void> {
    const ctx = this.checkContext(context);
    const { row } = this.baselineRow(ctx, id, revision);
    this.store.transaction(() => {
      this.store.db
        .query(
          "UPDATE baselines SET status = 'retired' WHERE scope_key = ? AND baseline_id = ? AND revision = ?",
        )
        .run(row.scope_key, id, revision);
      this.store.writeAudit({
        context: ctx,
        scope_key: row.scope_key,
        action: "baseline.retired",
        subject: formatRef("baseline", id, revision),
        detail: { status: "retired" },
      });
    });
  }

  async reverify(
    context: RequestContext,
    id: string,
    revision: string,
  ): Promise<SpecialistRevisionView> {
    const ctx = this.checkContext(context);
    const { row, registration } = this.specialistRow(ctx, id, revision);
    if (!scopeEquals(registration.scope, ctx.scope)) {
      throw new SpecialistRegistryError("not_found");
    }
    const basis = this.latestVerdictJob(row.scope_key, id, revision);
    const pointer = this.store.readProduction(row.scope_key, id);
    const verdict = await verifyEvidence(
      ctx,
      this.evidenceRegistration(registration),
      row.candidate_sha256,
      this.evidenceOptions({
        currentProductionRevision: pointer?.production_revision ?? null,
      }),
    );
    this.publish({ registration, verdict });
    let superseded = false;
    this.store.transaction(() => {
      const latest = this.store.readSpecialist(row.scope_key, id, revision);
      if (!latest) throw new SpecialistRegistryError("not_found");
      // A verdict recorded while verifying changed the gating report.
      if (this.latestVerdictJob(row.scope_key, id, revision) !== basis) {
        superseded = true;
        return;
      }
      const updatedAt = new Date().toISOString();
      if (latest.status === "archived" || latest.status === "invalidated") {
        this.store.db
          .query(
            `UPDATE specialist_revisions SET verdict_json = ?, updated_at = ?
             WHERE scope_key = ? AND specialist_id = ? AND revision = ?`,
          )
          .run(canonicalJson(verdict), updatedAt, row.scope_key, id, revision);
      } else {
        this.store.db
          .query(
            `UPDATE specialist_revisions SET status = ?, verdict_json = ?,
             updated_at = ? WHERE scope_key = ? AND specialist_id = ? AND revision = ?`,
          )
          .run(
            verdict.status,
            canonicalJson(verdict),
            updatedAt,
            row.scope_key,
            id,
            revision,
          );
      }
      this.store.writeAudit({
        context: ctx,
        scope_key: row.scope_key,
        action: "specialist.verified",
        subject: formatRef("specialist", id, revision),
        detail: {
          codes: verdict.codes,
          status:
            latest.status === "archived" || latest.status === "invalidated"
              ? latest.status
              : verdict.status,
        },
      });
    });
    if (superseded) return this.reverify(context, id, revision);
    const updated = this.store.readSpecialist(row.scope_key, id, revision);
    if (!updated) throw new SpecialistRegistryError("corrupt_record");
    return this.revisionView(ctx, updated, registration);
  }

  async inspect(
    context: RequestContext,
    id: string,
  ): Promise<SpecialistInspection> {
    const ctx = this.checkContext(context);
    const keys = [
      scopeKey(ctx.scope),
      scopeKey({
        owner_id: ctx.scope.owner_id,
        project_id: ctx.scope.project_id,
      }),
    ];
    const uniqueKeys = [...new Set(keys)];
    const visibleRows = this.store.db
      .query(
        `SELECT scope_key, specialist_id, revision, record_json, record_sha256,
          candidate_sha256, status, verdict_json, invalidated_reason,
          rolled_back_at, created_at, updated_at
         FROM specialist_revisions WHERE specialist_id = ?
          AND scope_key IN (${uniqueKeys.map(() => "?").join(", ")})`,
      )
      .all(id, ...uniqueKeys) as Array<{
      scope_key: string;
      specialist_id: string;
      revision: string;
      record_json: string;
      record_sha256: string;
      candidate_sha256: string;
      status: string;
      verdict_json: string;
      invalidated_reason: string | null;
      rolled_back_at: string | null;
      created_at: string;
      updated_at: string;
    }>;
    const visibleRecord = visibleRows
      .filter((row) => visible(this.verifiedRegistration(row).scope, ctx))
      .sort(
        (left, right) =>
          Number(right.scope_key === scopeKey(ctx.scope)) -
          Number(left.scope_key === scopeKey(ctx.scope)),
      )[0];
    if (!visibleRecord) throw new SpecialistRegistryError("not_found");
    const key = visibleRecord.scope_key;
    const pointer = this.store.readProduction(key, id);
    if (!pointer) throw new SpecialistRegistryError("not_found");
    const rows = this.store.db
      .query(
        `SELECT scope_key, specialist_id, revision, record_json, record_sha256,
          candidate_sha256, status, verdict_json, invalidated_reason,
          rolled_back_at, created_at, updated_at
         FROM specialist_revisions WHERE scope_key = ? AND specialist_id = ?
         ORDER BY created_at, revision`,
      )
      .all(key, id) as Array<{
      scope_key: string;
      specialist_id: string;
      revision: string;
      record_json: string;
      record_sha256: string;
      candidate_sha256: string;
      status: string;
      verdict_json: string;
      invalidated_reason: string | null;
      rolled_back_at: string | null;
      created_at: string;
      updated_at: string;
    }>;
    const history = parseHistory(pointer.history_json);
    return {
      pointer: {
        specialist_id: id,
        production_revision: pointer.production_revision,
        history,
        retired: pointer.retired === 1,
        pointer_version: pointer.pointer_version,
      },
      revisions: rows.map((row) => {
        const registration = this.verifiedRegistration(row);
        return this.revisionView(ctx, row, registration, pointer);
      }),
    };
  }

  async list(context: RequestContext): Promise<SpecialistInspection[]> {
    const ctx = this.checkContext(context);
    const rows = this.store.db
      .query(
        "SELECT DISTINCT specialist_id FROM specialist_revisions ORDER BY specialist_id",
      )
      .all() as Array<{ specialist_id: string }>;
    const output: SpecialistInspection[] = [];
    for (const { specialist_id } of rows) {
      try {
        output.push(await this.inspect(ctx, specialist_id));
      } catch (error) {
        if (
          !(error instanceof SpecialistRegistryError) ||
          error.code !== "not_found"
        ) {
          throw error;
        }
      }
    }
    return output;
  }

  private revisionView(
    context: RequestContext,
    row: {
      scope_key?: string;
      specialist_id: string;
      revision: string;
      candidate_sha256: string;
      status: string;
      verdict_json: string;
      invalidated_reason: string | null;
      rolled_back_at: string | null;
    },
    registration: SpecialistRegistration,
    pointer = this.store.readProduction(
      scopeKey(context.scope),
      row.specialist_id,
    ),
  ): SpecialistRevisionView {
    const history = pointer ? parseHistory(pointer.history_json) : [];
    const deployment =
      pointer?.production_revision === row.revision
        ? "production"
        : history.includes(row.revision)
          ? "previous"
          : "none";
    const jobs = this.store.db
      .query(
        `SELECT job_id, input_manifest_json FROM evaluation_jobs
         WHERE scope_key = ? AND specialist_id = ? AND revision = ?
         ORDER BY submitted_at`,
      )
      .all(
        row.scope_key ?? scopeKey(context.scope),
        row.specialist_id,
        row.revision,
      ) as Array<{
      job_id: string;
      input_manifest_json: string;
    }>;
    const verdict = parseVerdict(row.verdict_json);
    const view = {
      registration,
      status: row.status as SpecialistRevisionView["status"],
      candidate_sha256: row.candidate_sha256,
      verdict,
      deployment,
      rolled_back: row.rolled_back_at !== null,
      invalidated_reason: row.invalidated_reason,
      evaluation_jobs: jobs.map((job) => ({
        job_id: job.job_id,
        input_manifest: parseStored(job.input_manifest_json, ArtifactRefSchema),
      })),
    } satisfies SpecialistRevisionView;
    this.publish(view);
    return view;
  }

  async promote(
    context: RequestContext,
    id: string,
    revision: string,
    expectedProductionRevision: string | null,
  ): Promise<void> {
    const ctx = this.checkContext(context);
    const { row, registration } = this.specialistRow(ctx, id, revision);
    if (!scopeEquals(registration.scope, ctx.scope)) {
      throw new SpecialistRegistryError("not_found");
    }
    const pointerBefore = this.store.readProduction(row.scope_key, id);
    const current = pointerBefore?.production_revision ?? null;
    if (current !== expectedProductionRevision) {
      throw new SpecialistRegistryError("stale_revision");
    }
    const verdict = await verifyEvidence(
      ctx,
      this.evidenceRegistration(registration),
      row.candidate_sha256,
      this.evidenceOptions({
        currentProductionRevision: current,
        checkCurrentFreshness: true,
      }),
    );
    if (
      verdict.status !== "evaluated" ||
      ["proposed", "rejected", "invalidated", "archived"].includes(row.status)
    ) {
      throw new SpecialistRegistryError("invalid_state", "not_evaluated");
    }
    const fallbackTarget = parseRef(registration.fallback_specialist_revision);
    if (!fallbackTarget) {
      throw new SpecialistRegistryError("invalid_state", "fallback_invalid");
    }
    const fallbackCheck = this.lookupFallback(
      ctx,
      registration.fallback_specialist_revision,
    );
    if (fallbackCheck.error) {
      throw new SpecialistRegistryError("invalid_state", fallbackCheck.error);
    }
    const readiness = await checkServingReadiness(
      ctx,
      registration,
      this.compatibilityOptions,
    );
    if (!readiness.some((item) => item.reasons.length === 0)) {
      throw new SpecialistRegistryError(
        "invalid_state",
        readiness[0]?.reasons[0] ?? "model_not_configured",
      );
    }
    const now = new Date().toISOString();
    this.store.transaction(() => {
      const pointer = this.store.readProduction(row.scope_key, id);
      const latest = this.store.readSpecialist(row.scope_key, id, revision);
      if (
        (pointer?.production_revision ?? null) !== expectedProductionRevision
      ) {
        throw new SpecialistRegistryError("stale_revision");
      }
      if (!latest || latest.status !== "evaluated") {
        throw new SpecialistRegistryError("invalid_state", "revision_changed");
      }
      const history = pointer ? parseHistory(pointer.history_json) : [];
      if (pointer?.production_revision)
        history.push(pointer.production_revision);
      this.store.db
        .query(
          `UPDATE production SET production_revision = ?, history_json = ?,
           retired = 0, pointer_version = pointer_version + 1, updated_at = ?
           WHERE scope_key = ? AND specialist_id = ?`,
        )
        .run(revision, canonicalJson(history), now, row.scope_key, id);
      this.store.db
        .query(
          `UPDATE specialist_revisions SET verdict_json = ?, updated_at = ?
           WHERE scope_key = ? AND specialist_id = ? AND revision = ?`,
        )
        .run(canonicalJson(verdict), now, row.scope_key, id, revision);
      this.store.writeAudit({
        context: ctx,
        scope_key: row.scope_key,
        action: "production.deployed",
        subject: formatRef("specialist", id, revision),
        detail: {
          expected_production_revision: expectedProductionRevision,
          production_revision: revision,
        },
      });
    });
  }

  async deploy(
    context: RequestContext,
    specialistId: string,
    expectedProductionRevision: string,
  ): Promise<void> {
    const { id, revision } = contractRef(specialistId);
    await this.promote(
      context,
      id,
      revision,
      parseContractRevision(expectedProductionRevision),
    );
  }

  async rollbackTo(
    context: RequestContext,
    id: string,
    expectedProductionRevision: string | null,
  ): Promise<void> {
    const ctx = this.checkContext(context);
    const pointer = this.store.readProduction(scopeKey(ctx.scope), id);
    if (!pointer) throw new SpecialistRegistryError("not_found");
    const { registration: currentRegistration } =
      pointer.production_revision === null
        ? { registration: null }
        : this.specialistRow(ctx, id, pointer.production_revision);
    if (
      currentRegistration &&
      !scopeEquals(currentRegistration.scope, ctx.scope)
    ) {
      throw new SpecialistRegistryError("not_found");
    }
    const history = parseHistory(pointer.history_json);
    const targetRevision = history.at(-1);
    if (targetRevision === undefined) {
      throw new SpecialistRegistryError("invalid_state", "no_rollback_target");
    }
    const { row, registration } = this.specialistRow(ctx, id, targetRevision);
    const verdict = await verifyEvidence(
      ctx,
      this.evidenceRegistration(registration),
      row.candidate_sha256,
      this.evidenceOptions(),
    );
    if (row.status !== "evaluated" || verdict.status !== "evaluated") {
      throw new SpecialistRegistryError(
        "invalid_state",
        "rollback_target_invalid",
      );
    }
    const now = new Date().toISOString();
    this.store.transaction(() => {
      const latest = this.store.readProduction(row.scope_key, id);
      if (
        (latest?.production_revision ?? null) !== expectedProductionRevision
      ) {
        throw new SpecialistRegistryError("stale_revision");
      }
      if (!latest) throw new SpecialistRegistryError("not_found");
      const latestHistory = parseHistory(latest.history_json);
      if (latestHistory.at(-1) !== targetRevision) {
        throw new SpecialistRegistryError("stale_revision");
      }
      latestHistory.pop();
      if (latest.production_revision !== null) {
        this.store.db
          .query(
            `UPDATE specialist_revisions SET rolled_back_at = ?, updated_at = ?
             WHERE scope_key = ? AND specialist_id = ? AND revision = ?`,
          )
          .run(now, now, row.scope_key, id, latest.production_revision);
      }
      this.store.db
        .query(
          `UPDATE production SET production_revision = ?, history_json = ?,
           retired = 0, pointer_version = pointer_version + 1, updated_at = ?
           WHERE scope_key = ? AND specialist_id = ?`,
        )
        .run(
          targetRevision,
          canonicalJson(latestHistory),
          now,
          row.scope_key,
          id,
        );
      this.store.writeAudit({
        context: ctx,
        scope_key: row.scope_key,
        action: "production.rolled_back",
        subject: formatRef("specialist", id, targetRevision),
        detail: {
          expected_production_revision: expectedProductionRevision,
          production_revision: targetRevision,
        },
      });
    });
  }

  async rollback(
    context: RequestContext,
    specialistId: string,
    expectedProductionRevision: string,
  ): Promise<void> {
    await this.rollbackTo(
      context,
      specialistId,
      parseContractRevision(expectedProductionRevision),
    );
  }

  async retire(
    context: RequestContext,
    specialistId: string,
    expected?: string | null,
  ): Promise<void> {
    const ctx = this.checkContext(context);
    const key = scopeKey(ctx.scope);
    const pointer = this.store.readProduction(key, specialistId);
    if (!pointer) throw new SpecialistRegistryError("not_found");
    const productionRevision = pointer.production_revision;
    if (productionRevision === null) {
      throw new SpecialistRegistryError("invalid_state", "no_production");
    }
    const { registration } = this.specialistRow(
      ctx,
      specialistId,
      productionRevision,
    );
    if (!scopeEquals(registration.scope, ctx.scope)) {
      throw new SpecialistRegistryError("not_found");
    }
    const now = new Date().toISOString();
    this.store.transaction(() => {
      const currentPointer = this.store.readProduction(key, specialistId);
      if (
        expected !== undefined &&
        (currentPointer?.production_revision ?? null) !== expected
      ) {
        throw new SpecialistRegistryError("stale_revision");
      }
      if (
        !currentPointer ||
        currentPointer.production_revision !== productionRevision
      ) {
        throw new SpecialistRegistryError("stale_revision");
      }
      const history = parseHistory(currentPointer.history_json);
      history.push(productionRevision);
      this.store.db
        .query(
          `UPDATE production SET production_revision = NULL, history_json = ?,
           retired = 1, pointer_version = pointer_version + 1, updated_at = ?
           WHERE scope_key = ? AND specialist_id = ?`,
        )
        .run(canonicalJson(history), now, key, specialistId);
      this.store.writeAudit({
        context: ctx,
        scope_key: key,
        action: "production.retired",
        subject: formatRef("specialist", specialistId, productionRevision),
        detail: { retired: true },
      });
    });
  }

  async archive(
    context: RequestContext,
    id: string,
    revision: string,
  ): Promise<void> {
    const ctx = this.checkContext(context);
    const { row } = this.specialistRow(ctx, id, revision);
    if (!scopeEquals(this.verifiedRegistration(row).scope, ctx.scope)) {
      throw new SpecialistRegistryError("not_found");
    }
    const pointer = this.store.readProduction(row.scope_key, id);
    if (pointer?.production_revision === revision) {
      throw new SpecialistRegistryError("invalid_state", "production_revision");
    }
    this.store.transaction(() => {
      this.store.db
        .query(
          `UPDATE specialist_revisions SET status = 'archived', updated_at = ?
           WHERE scope_key = ? AND specialist_id = ? AND revision = ?`,
        )
        .run(new Date().toISOString(), row.scope_key, id, revision);
      this.store.writeAudit({
        context: ctx,
        scope_key: row.scope_key,
        action: "revision.archived",
        subject: formatRef("specialist", id, revision),
        detail: { status: "archived" },
      });
    });
  }

  async requestEvaluation(
    context: RequestContext,
    id: string,
    revision: string,
    budget?: Budget,
  ): Promise<JobRef> {
    const ctx = this.checkContext(context);
    const { row, registration } = this.specialistRow(ctx, id, revision);
    if (!scopeEquals(registration.scope, ctx.scope)) {
      throw new SpecialistRegistryError("not_found");
    }
    if (!this.options.evaluation) {
      throw new SpecialistRegistryError("evaluation_unavailable");
    }
    const pointer = this.store.readProduction(row.scope_key, id);
    const manifest = {
      schema: "mars.specialist-comparison-request/v1",
      subject: {
        specialist_id: id,
        revision,
        candidate_sha256: row.candidate_sha256,
      },
      required_arms: [
        "base",
        "prompt_optimized_baseline",
        "current_specialist",
        "candidate",
      ],
      current_production_revision: pointer?.production_revision ?? null,
      tested_task_coverage: registration.tested_task_coverage,
      acceptance: registration.profile.acceptance,
      roles: registration.profile.roles,
      complexity: registration.profile.complexity,
    };
    this.publish(manifest);
    const bytes = new TextEncoder().encode(canonicalJson(manifest));
    const ref = await this.options.evaluation.artifacts.put(
      ctx,
      bytes,
      "application/json",
    );
    // The service may finish (and call the verdict sink) before
    // submitComparison returns; recordEvaluationVerdict waits on this.
    let settle: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const waiting = this.pendingEvaluations.get(ref.sha256) ?? new Set();
    waiting.add(pending);
    this.pendingEvaluations.set(ref.sha256, waiting);
    try {
      return await this.delegateEvaluation(ctx, row, id, revision, ref, budget);
    } finally {
      waiting.delete(pending);
      if (
        waiting.size === 0 &&
        this.pendingEvaluations.get(ref.sha256) === waiting
      ) {
        this.pendingEvaluations.delete(ref.sha256);
      }
      settle();
    }
  }

  private async delegateEvaluation(
    ctx: RequestContext,
    row: { scope_key: string },
    id: string,
    revision: string,
    ref: ArtifactRef,
    budget: Budget | undefined,
  ): Promise<JobRef> {
    const evaluation = this.options.evaluation;
    if (!evaluation)
      throw new SpecialistRegistryError("evaluation_unavailable");
    const job = await evaluation.service.submitComparison(
      ctx,
      ref,
      budget ?? evaluation.defaultBudget,
    );
    const now = new Date().toISOString();
    this.store.transaction(() => {
      this.store.db
        .query(
          `INSERT INTO evaluation_jobs
           (job_id, scope_key, specialist_id, revision, input_manifest_json, submitted_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          job.job_id,
          row.scope_key,
          id,
          revision,
          canonicalJson(job.input_manifest),
          now,
        );
      this.store.writeAudit({
        context: ctx,
        scope_key: row.scope_key,
        action: "evaluation.delegated",
        subject: formatRef("specialist", id, revision),
        detail: { job_id: job.job_id },
      });
    });
    return job;
  }

  async evaluate(
    context: RequestContext,
    specialistId: string,
  ): Promise<JobRef> {
    const { id, revision } = contractRef(specialistId);
    return this.requestEvaluation(context, id, revision);
  }

  async evaluationJobs(
    context: RequestContext,
    id: string,
    revision: string,
  ): Promise<JobRef[]> {
    const ctx = this.checkContext(context);
    this.specialistRow(ctx, id, revision);
    const rows = this.store.db
      .query(
        `SELECT job_id, input_manifest_json FROM evaluation_jobs
         WHERE scope_key = ? AND specialist_id = ? AND revision = ?
         ORDER BY submitted_at`,
      )
      .all(scopeKey(ctx.scope), id, revision) as Array<{
      job_id: string;
      input_manifest_json: string;
    }>;
    return rows.map((row) => ({
      job_id: row.job_id,
      input_manifest: parseStored(row.input_manifest_json, ArtifactRefSchema),
    }));
  }

  /**
   * Registry-side `SpecialistVerdictSink.record` for `@mars/evaluation`:
   * accepts a comparison verdict only for a job this registry delegated,
   * re-runs `verifyEvidence` on the signed report against the revision, and
   * stores it as the revision's current evaluation evidence. Reports that
   * fail integrity checks are refused; an authentic `no_improvement` or
   * `regressed` report is recorded honestly and its acceptance-gate result
   * (possibly `rejected`) becomes the revision's status.
   */
  async recordEvaluationVerdict(
    context: RequestContext,
    entry: {
      job: JobRef;
      report: ArtifactRef;
      verdict: ArtifactRef;
      value: unknown;
    },
  ): Promise<EvaluationVerdictView> {
    const ctx = this.checkContext(context);
    const parsed = ComparisonVerdictRecordSchema.safeParse(entry);
    if (!parsed.success) {
      throw new SpecialistRegistryError("invalid_input", "verdict_record");
    }
    const record = parsed.data;
    const key = scopeKey(ctx.scope);
    let job = this.store.readEvaluationJob(key, record.job.job_id);
    const waiting = this.pendingEvaluations.get(
      record.job.input_manifest.sha256,
    );
    if (!job && waiting) {
      await Promise.all([...waiting]);
      job = this.store.readEvaluationJob(key, record.job.job_id);
    }
    if (!job) throw new SpecialistRegistryError("not_found", "evaluation_job");
    const { subject } = record.value;
    if (
      !sameJson(
        parseStored(job.input_manifest_json, ArtifactRefSchema),
        record.job.input_manifest,
      ) ||
      record.value.job_id !== job.job_id ||
      subject.specialist_id !== job.specialist_id ||
      subject.revision !== job.revision ||
      !sameJson(record.value.report, record.report)
    ) {
      throw new SpecialistRegistryError("invalid_input", "verdict_mismatch");
    }
    const { row, registration } = this.specialistRow(
      ctx,
      job.specialist_id,
      job.revision,
    );
    if (
      !scopeEquals(registration.scope, ctx.scope) ||
      row.candidate_sha256 !== subject.candidate_sha256
    ) {
      throw new SpecialistRegistryError("invalid_input", "verdict_mismatch");
    }
    const existing = this.store.readEvaluationVerdict(job.job_id);
    if (existing) {
      if (
        !sameJson(
          parseStored(existing.report_json, ArtifactRefSchema),
          record.report,
        )
      ) {
        throw new SpecialistRegistryError("conflict", "verdict_recorded");
      }
      return this.evaluationVerdictView(existing);
    }
    const pointer = this.store.readProduction(row.scope_key, row.specialist_id);
    const evidence = await verifyEvidence(
      ctx,
      { ...registration, evaluation: record.report },
      row.candidate_sha256,
      this.evidenceOptions({
        currentProductionRevision: pointer?.production_revision ?? null,
      }),
    );
    if (evidence.codes.some((code) => UNTRUSTED_VERDICT_CODES.has(code))) {
      throw new SpecialistRegistryError(
        "invalid_input",
        `verdict_evidence_rejected:${evidence.codes.join(",")}`,
      );
    }
    if (evidence.report_id !== comparisonReportId(job.job_id)) {
      throw new SpecialistRegistryError(
        "invalid_input",
        "verdict_report_unbound",
      );
    }
    const signed = await this.signedComparison(ctx, record.report);
    const outcome = record.value.outcome;
    if (
      !signed ||
      record.value.simulated !== signed.simulated ||
      (outcome === "regressed") !== signed.worse ||
      (outcome === "improved" &&
        (!signed.better || evidence.status !== "evaluated"))
    ) {
      throw new SpecialistRegistryError(
        "invalid_input",
        "verdict_outcome_mismatch",
      );
    }
    this.publish({ registration, verdict: evidence });
    const recordedAt = new Date().toISOString();
    this.store.transaction(() => {
      const latest = this.store.readSpecialist(
        row.scope_key,
        row.specialist_id,
        row.revision,
      );
      if (!latest || latest.candidate_sha256 !== row.candidate_sha256) {
        throw new SpecialistRegistryError("stale_revision");
      }
      this.store.db
        .query(
          `INSERT INTO evaluation_verdicts
           (job_id, scope_key, specialist_id, revision, report_json,
            verdict_ref_json, comparison_json, evidence_json, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          job.job_id,
          row.scope_key,
          row.specialist_id,
          row.revision,
          canonicalJson(record.report),
          canonicalJson(record.verdict),
          canonicalJson(record.value),
          canonicalJson(evidence),
          recordedAt,
        );
      const frozen =
        latest.status === "archived" || latest.status === "invalidated";
      this.store.db
        .query(
          `UPDATE specialist_revisions SET status = ?, verdict_json = ?,
           updated_at = ? WHERE scope_key = ? AND specialist_id = ? AND revision = ?`,
        )
        .run(
          frozen ? latest.status : evidence.status,
          canonicalJson(evidence),
          recordedAt,
          row.scope_key,
          row.specialist_id,
          row.revision,
        );
      this.store.writeAudit({
        context: ctx,
        scope_key: row.scope_key,
        action: "evaluation.recorded",
        subject: formatRef("specialist", row.specialist_id, row.revision),
        detail: {
          job_id: job.job_id,
          outcome: record.value.outcome,
          simulated: record.value.simulated,
          codes: evidence.codes,
          status: frozen ? latest.status : evidence.status,
        },
      });
    });
    const stored = this.store.readEvaluationVerdict(job.job_id);
    if (!stored) throw new SpecialistRegistryError("corrupt_record");
    return this.evaluationVerdictView(stored);
  }

  /** Candidate-vs-base direction per triple and simulation flag, from the signed report. */
  private async signedComparison(
    ctx: RequestContext,
    ref: ArtifactRef,
  ): Promise<{ worse: boolean; better: boolean; simulated: boolean } | null> {
    let report: EvaluationReport;
    try {
      const bytes = await this.options.artifacts.get(ctx, ref);
      report = EvaluationReportSchema.parse(
        JSON.parse(new TextDecoder().decode(bytes)),
      );
    } catch {
      return null;
    }
    const key = (item: EvaluationReport["results"][number]) =>
      `${item.domain}|${item.role}|${item.complexity}`;
    const base = new Map(
      report.results
        .filter((item) => item.arm === "base")
        .map((item) => [key(item), item.passed / item.attempted]),
    );
    let worse = false;
    let better = false;
    for (const item of report.results) {
      const baseRate = base.get(key(item));
      if (item.arm !== "candidate" || baseRate === undefined) continue;
      const delta = item.passed / item.attempted - baseRate;
      if (delta < 0) worse = true;
      if (delta > 0) better = true;
    }
    return { worse, better, simulated: report.provenance.synthetic_fixture };
  }

  async evaluationVerdicts(
    context: RequestContext,
    id: string,
    revision: string,
  ): Promise<EvaluationVerdictView[]> {
    const ctx = this.checkContext(context);
    const { row } = this.specialistRow(ctx, id, revision);
    return this.store
      .listEvaluationVerdicts(row.scope_key, id, revision)
      .map((item) => this.evaluationVerdictView(item));
  }

  private evaluationVerdictView(
    row: EvaluationVerdictRow,
  ): EvaluationVerdictView {
    const comparison = parseStored(
      row.comparison_json,
      ComparisonVerdictRecordSchema.shape.value,
    );
    return {
      job_id: row.job_id,
      specialist_id: row.specialist_id,
      revision: row.revision,
      outcome: comparison.outcome,
      simulated: comparison.simulated,
      report: parseStored(row.report_json, ArtifactRefSchema),
      verdict: parseStored(row.verdict_ref_json, ArtifactRefSchema),
      evidence: parseStored(row.evidence_json, EvidenceVerdictSchema),
      recorded_at: row.recorded_at,
    };
  }

  async verifyCompatibility(
    context: RequestContext,
    specialistId: string,
    servingBase: VersionRef,
  ): Promise<{ compatible: boolean; reasons: string[] }> {
    const ctx = this.checkContext(context);
    const { id, revision } = contractRef(specialistId);
    const { registration } = this.visibleSpecialist(ctx, id, revision);
    const compatible = compatibleBase(registration, servingBase);
    return {
      compatible,
      reasons: compatible ? [] : ["serving_base_mismatch"],
    };
  }

  /**
   * The fallback chain starting at `ref` (inclusive), resolved in the scope
   * that owns the specialist (the caller's scope or its project scope) with
   * the same cycle/depth/missing-target rules routing uses.
   */
  async fallbackChain(
    context: RequestContext,
    ref: string,
    ownerScope: RequestContext["scope"] = context.scope,
  ): Promise<ReturnType<typeof resolveFallbackChain>> {
    const ctx = this.checkContext(context);
    const visible =
      ownerScope.owner_id === ctx.scope.owner_id &&
      ownerScope.project_id === ctx.scope.project_id &&
      (ownerScope.workspace_id === undefined ||
        ownerScope.workspace_id === ctx.scope.workspace_id);
    if (!visible) throw new SpecialistRegistryError("scope_denied");
    return this.lookupFallback(ctx, ref, scopeKey(ownerScope));
  }

  async taskRoutingState(
    context: RequestContext,
    taskId: string,
    role: TaskRoutingState["role"],
  ): Promise<TaskRoutingState | null> {
    const ctx = this.checkContext(context);
    const row = this.store.db
      .query(
        `SELECT step, state_json FROM task_routing_state
         WHERE scope_key = ? AND task_id = ? AND role = ?`,
      )
      .get(scopeKey(ctx.scope), taskId, role) as {
      step: number;
      state_json: string;
    } | null;
    if (!row) return null;
    const state = parseStored(row.state_json, TaskRoutingStateSchema);
    if (
      state.step !== row.step ||
      state.task_id !== taskId ||
      state.role !== role
    ) {
      throw new SpecialistRegistryError("corrupt_record");
    }
    return state;
  }

  /**
   * Stores the next step state only if the stored step still equals
   * `expectedStep` (0 when no state exists), so two hosts can never both
   * commit the same step.
   */
  async commitTaskRoutingState(
    context: RequestContext,
    state: TaskRoutingState,
    expectedStep: number,
  ): Promise<void> {
    const ctx = this.checkContext(context);
    const parsed = TaskRoutingStateSchema.safeParse(state);
    if (!parsed.success || parsed.data.step !== expectedStep + 1) {
      throw new SpecialistRegistryError("invalid_input", "task_routing_state");
    }
    this.publish(parsed.data);
    const scope = scopeKey(ctx.scope);
    this.store.transaction(() => {
      const row = this.store.db
        .query(
          `SELECT step FROM task_routing_state
           WHERE scope_key = ? AND task_id = ? AND role = ?`,
        )
        .get(scope, parsed.data.task_id, parsed.data.role) as {
        step: number;
      } | null;
      if ((row?.step ?? 0) !== expectedStep) {
        throw new SpecialistRegistryError("conflict", "task_routing_step");
      }
      this.store.db
        .query(
          `INSERT INTO task_routing_state
           (scope_key, task_id, role, step, state_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (scope_key, task_id, role) DO UPDATE SET
             step = excluded.step, state_json = excluded.state_json,
             updated_at = excluded.updated_at`,
        )
        .run(
          scope,
          parsed.data.task_id,
          parsed.data.role,
          parsed.data.step,
          canonicalJson(parsed.data),
          new Date().toISOString(),
        );
    });
  }

  private lookupFallback(
    context: RequestContext,
    start: string,
    fallbackScopeKey = scopeKey(context.scope),
  ): ReturnType<typeof resolveFallbackChain> {
    return resolveFallbackChain(start, (ref) => {
      const parsed = parseRef(ref);
      if (!parsed) return undefined;
      if (parsed.kind === "baseline") {
        const row = this.store.readBaseline(
          fallbackScopeKey,
          parsed.id,
          parsed.revision,
        );
        return row ? null : undefined;
      }
      const row = this.store.readSpecialist(
        fallbackScopeKey,
        parsed.id,
        parsed.revision,
      );
      if (!row) return undefined;
      const registration = this.verifiedRegistration(row);
      return registration.fallback_specialist_revision;
    });
  }

  async invalidateDependency(
    context: RequestContext,
    dependency:
      | { artifact_sha256: string }
      | { component: string; revision: string },
    reason: string,
  ): Promise<{
    invalidated: Array<{ specialist_id: string; revision: string }>;
  }> {
    const ctx = this.checkContext(context);
    if (
      !/^[a-f0-9]{64}$/.test(reason) &&
      !/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(reason)
    ) {
      throw new SpecialistRegistryError("invalid_input", "reason_invalid");
    }
    const key = scopeKey(ctx.scope);
    const rows = this.store.db
      .query(
        `SELECT scope_key, specialist_id, revision, record_json, record_sha256,
          candidate_sha256, status, verdict_json, invalidated_reason,
          rolled_back_at, created_at, updated_at
         FROM specialist_revisions WHERE scope_key = ?`,
      )
      .all(key) as Array<{
      scope_key: string;
      specialist_id: string;
      revision: string;
      record_json: string;
      record_sha256: string;
      candidate_sha256: string;
      status: string;
      verdict_json: string;
      invalidated_reason: string | null;
      rolled_back_at: string | null;
      created_at: string;
      updated_at: string;
    }>;
    const invalidated: Array<{ specialist_id: string; revision: string }> = [];
    for (const row of rows) {
      const registration = this.verifiedRegistration(row);
      const verdict = parseVerdict(row.verdict_json);
      const matches =
        "artifact_sha256" in dependency
          ? [
              registration.chat_template.sha256,
              registration.adapter?.sha256,
              registration.evaluation.sha256,
              registration.dataset_lineage?.sha256,
              ...verdict.evidence_artifacts,
              ...verdict.lineage_dataset_sha256s,
            ].includes(dependency.artifact_sha256)
          : [
              registration.base_model,
              registration.tokenizer,
              ...registration.tools,
              ...registration.skills,
              ...registration.knowledge,
              ...(registration.profile.adapter_spec
                ? [
                    registration.profile.adapter_spec.base_model,
                    registration.profile.adapter_spec.tokenizer,
                  ]
                : []),
            ].some(
              (ref) =>
                ref.component === dependency.component &&
                ref.revision === dependency.revision,
            );
      if (matches)
        invalidated.push({
          specialist_id: row.specialist_id,
          revision: row.revision,
        });
    }
    this.store.transaction(() => {
      for (const item of invalidated) {
        this.store.db
          .query(
            `UPDATE specialist_revisions SET status = 'invalidated',
             invalidated_reason = ?, updated_at = ?
             WHERE scope_key = ? AND specialist_id = ? AND revision = ?`,
          )
          .run(
            reason,
            new Date().toISOString(),
            key,
            item.specialist_id,
            item.revision,
          );
      }
      this.store.writeAudit({
        context: ctx,
        scope_key: key,
        action: "dependency.invalidated",
        subject: "dependency",
        detail: { dependency, invalidated, reason },
      });
    });
    return { invalidated };
  }

  async audit(
    context: RequestContext,
    filter?: { action?: string; subject?: string },
  ): Promise<
    Array<{
      seq: number;
      at: string;
      actor: string;
      action: string;
      subject: string;
      detail: unknown;
      prev_sha256: string;
      sha256: string;
    }>
  > {
    const ctx = this.checkContext(context);
    const events = this.store.audit(ctx, scopeKey(ctx.scope));
    return events.filter(
      (event) =>
        (filter?.action === undefined || event.action === filter.action) &&
        (filter?.subject === undefined || event.subject === filter.subject),
    );
  }

  close(): void {
    this.store.close();
  }

  private async resolveGate(
    context: RequestContext,
    registration: SpecialistRegistration,
    candidateSha: string,
    recordSha: string,
    storedStatus: string,
    storedVerdict: EvidenceVerdict,
    request: RoutingRequest,
    independenceTargets: SelectedTarget[],
  ): Promise<{
    reasons: ReasonCode[];
    target: SelectedTarget | null;
    triple?: TripleGate;
    pass_rate: number;
    cost_usd_per_task: number | null;
    runtime_ms_p95: number | null;
  }> {
    const reasons = new Set<ReasonCode>();
    if (storedStatus === "invalidated") reasons.add("invalidated");
    if (storedStatus === "archived") reasons.add("archived");
    if (storedStatus !== "evaluated" || storedVerdict.status !== "evaluated") {
      reasons.add("status_not_evaluated");
    }
    const verdict = await verifyEvidence(
      context,
      this.evidenceRegistration(registration),
      candidateSha,
      this.evidenceOptions(),
    );
    verdict.codes.forEach((code) => {
      reasons.add(code);
    });

    const domainMatches = storedVerdict.covered_triples.filter(
      (item) => item.domain === request.domain,
    );
    const roleMatches = domainMatches.filter(
      (item) => item.role === request.role,
    );
    const complexityMatches = roleMatches.filter(
      (item) => item.complexity === request.complexity,
    );
    if (
      !registration.tested_task_coverage.includes(request.domain) ||
      domainMatches.length === 0
    ) {
      reasons.add("domain_not_covered");
    } else if (roleMatches.length === 0) {
      reasons.add("role_not_covered");
    } else if (complexityMatches.length === 0) {
      reasons.add("complexity_not_covered");
    }
    const triple = complexityMatches[0];
    if (triple && !triple.passed) reasons.add("evaluation_gate_failed");
    if (triple) {
      const bindings = await checkSpecialistBindings(
        context,
        registration,
        request,
        {
          cost_usd_per_task: triple.cost_usd_per_task,
          runtime_ms_p95: triple.runtime_ms_p95,
        },
        this.compatibilityOptions,
      );
      let passing: BindingCompatibility | undefined;
      if (request.independence && request.independence.policy !== "none") {
        const independenceReasons = new Set<ReasonCode>();
        for (const binding of bindings.filter(
          (item) => item.reasons.length === 0,
        )) {
          const checked = this.checkIndependence(
            context,
            registration,
            binding.binding.model_id,
            independenceTargets,
            request.independence.policy,
          );
          if (checked.size === 0) {
            passing = binding;
            break;
          }
          for (const reason of checked) independenceReasons.add(reason);
        }
        if (!passing) {
          for (const binding of bindings) {
            for (const reason of binding.reasons) reasons.add(reason);
          }
          for (const reason of independenceReasons) reasons.add(reason);
        }
      } else {
        passing = firstPassingBinding(bindings);
        if (!passing) {
          for (const binding of bindings) {
            for (const reason of binding.reasons) reasons.add(reason);
          }
        }
      }
      if (passing && reasons.size === 0) {
        const target = makeSelectedSpecialist(
          registration,
          { record_sha256: recordSha },
          storedVerdict,
          passing,
          triple,
        );
        return {
          reasons: normalizeReasons(reasons),
          target,
          triple,
          pass_rate: triple.pass_rate,
          cost_usd_per_task: triple.cost_usd_per_task,
          runtime_ms_p95: triple.runtime_ms_p95,
        };
      }
    }
    return {
      reasons: normalizeReasons(reasons),
      target: null,
      ...(triple ? { triple } : {}),
      pass_rate: triple?.pass_rate ?? 0,
      cost_usd_per_task: triple?.cost_usd_per_task ?? null,
      runtime_ms_p95: triple?.runtime_ms_p95 ?? null,
    };
  }

  private checkIndependence(
    context: RequestContext,
    registration: SpecialistRegistration,
    modelId: string,
    from: SelectedTarget[],
    policy: "none" | "distinct_model" | "distinct_lineage",
  ): Set<ReasonCode> {
    const reasons = new Set<ReasonCode>();
    if (policy === "none") return reasons;
    for (const item of from) {
      if (!item || typeof item !== "object") continue;
      const target = item;
      if (target.model_id === modelId) reasons.add("independence_same_model");
      if (policy === "distinct_lineage") {
        const sameBase =
          registration.base_model !== undefined &&
          target.base_model !== null &&
          target.base_model?.component === registration.base_model.component;
        const candidateLineage = registration.dataset_lineage?.sha256 ?? null;
        let targetLineage: string | null = null;
        if (
          target.kind === "specialist" &&
          typeof target.specialist_id === "string" &&
          target.revision
        ) {
          targetLineage =
            this.visibleSpecialistByTarget(context, target).registration
              .dataset_lineage?.sha256 ?? null;
        }
        const baselineIdentity =
          target.kind === "baseline" &&
          target.provider_id !== undefined &&
          target.provider_model !== undefined
            ? `${target.provider_id}/${target.provider_model}`
            : null;
        if (
          sameBase ||
          (candidateLineage !== null && candidateLineage === targetLineage) ||
          (baselineIdentity !== null &&
            registration.base_model.component === baselineIdentity)
        ) {
          reasons.add("independence_same_lineage");
        }
      }
    }
    return reasons;
  }

  private async tryBaseline(
    _context: RequestContext,
    profile: BaselineProfile,
    recordSha: string,
    request: RoutingRequest,
    independenceTargets: SelectedTarget[],
  ): Promise<{ target: SelectedTarget | null; reasons: ReasonCode[] }> {
    if (!profile.roles.includes(request.role)) {
      return { target: null, reasons: ["role_not_covered"] };
    }
    if (!profile.complexity.includes(request.complexity)) {
      return { target: null, reasons: ["complexity_not_covered"] };
    }
    const binding: BindingCompatibility = baselineCompatibility(
      {
        model_id: profile.model_id,
        provider_id: profile.provider_id,
        provider_model: profile.provider_model,
      },
      this.options.catalog,
      request,
    );
    if (request.independence?.policy !== "none") {
      for (const prior of independenceTargets) {
        if (prior.model_id === profile.model_id) {
          binding.reasons.push("independence_same_model");
        }
        if (
          request.independence?.policy === "distinct_lineage" &&
          ((prior.kind === "baseline" &&
            prior.provider_id === profile.provider_id &&
            prior.provider_model === profile.provider_model) ||
            (prior.kind === "specialist" &&
              prior.base_model?.component ===
                `${profile.provider_id}/${profile.provider_model}`))
        ) {
          binding.reasons.push("independence_same_lineage");
        }
      }
    }
    if (binding.reasons.length > 0) {
      return { target: null, reasons: normalizeReasons(binding.reasons) };
    }
    return {
      target: makeSelectedBaseline(profile, binding, recordSha),
      reasons: [],
    };
  }

  private async resolveFallbackTarget(
    context: RequestContext,
    parsed: SpecialistRef,
    fallbackScopeKey: string,
    request: RoutingRequest,
    independenceTargets: SelectedTarget[],
  ): Promise<{ target: SelectedTarget | null; reasons: ReasonCode[] }> {
    const missing = (): { target: null; reasons: ReasonCode[] } => ({
      target: null,
      reasons: ["fallback_target_missing"],
    });
    if (parsed.kind === "specialist") {
      const row = this.store.readSpecialist(
        fallbackScopeKey,
        parsed.id,
        parsed.revision,
      );
      if (!row) return missing();
      const registration = this.verifiedRegistration(row);
      if (!visible(registration.scope, context)) return missing();
      const gate = await this.resolveGate(
        context,
        registration,
        row.candidate_sha256,
        row.record_sha256,
        row.status,
        parseVerdict(row.verdict_json),
        request,
        independenceTargets,
      );
      return { target: gate.target, reasons: gate.reasons };
    }
    const row = this.store.readBaseline(
      fallbackScopeKey,
      parsed.id,
      parsed.revision,
    );
    if (!row || row.status !== "active") return missing();
    const profile = this.store.parseRecord(
      row.record_json,
      row.record_sha256,
      parseBaseline,
    );
    if (!visible(profile.scope, context)) return missing();
    return this.tryBaseline(
      context,
      profile,
      row.record_sha256,
      request,
      independenceTargets,
    );
  }

  async route(
    context: RequestContext,
    request: RoutingRequest,
  ): Promise<RoutingDecision> {
    const ctx = this.checkContext(context);
    return this.routeWithMeta(ctx, request, { retry_of: null, attempt: 0 });
  }

  private async routeWithMeta(
    context: RequestContext,
    input: RoutingRequest,
    meta: RouteMeta,
    forceUnavailable = false,
  ): Promise<RoutingDecision> {
    const parsedRequest = RoutingRequestSchema.safeParse(input);
    if (!parsedRequest.success) {
      throw new SpecialistRegistryError(
        "invalid_input",
        "routing_request_invalid",
      );
    }
    const request = parsedRequest.data;
    const independenceTargets: SelectedTarget[] = [];
    for (const decisionId of request.independence?.from_decision_ids ?? []) {
      let prior: RoutingDecision;
      try {
        prior = await this.decision(context, decisionId);
      } catch (error) {
        if (
          error instanceof SpecialistRegistryError &&
          error.code === "not_found"
        ) {
          throw new SpecialistRegistryError(
            "invalid_input",
            "independence_decision_not_found",
          );
        }
        throw error;
      }
      if (prior.task_id !== request.task_id) {
        throw new SpecialistRegistryError(
          "invalid_input",
          "independence_task_mismatch",
        );
      }
      if (prior.selected) independenceTargets.push(prior.selected);
    }
    this.publish(request);
    const scope = scopeKey(context.scope);
    const rejected: Array<{ ref: string; reasons: ReasonCode[] }> = [];
    const ranking: Array<{
      ref: string;
      pass_rate: number;
      cost_usd_per_task: number | null;
      runtime_ms_p95: number | null;
    }> = [];
    const now = new Date().toISOString();
    const excluded = new Set(request.exclude_refs ?? []);

    const persist = (
      outcome: RoutingDecision["outcome"],
      selected: SelectedTarget | null,
      fallback: RoutingDecision["fallback"],
      explanations: string[],
      override = request.override !== undefined,
    ): RoutingDecision => {
      const decision = makeRoutingDecision({
        schema_version: 1,
        decision_id: randomUUID(),
        task_id: request.task_id,
        role: request.role,
        domain: request.domain,
        complexity: request.complexity,
        outcome,
        override,
        selected,
        fallback,
        rejected: [...rejected]
          .map((item) => ({
            ref: item.ref,
            reasons: noReasonDuplicates(item.reasons),
          }))
          .sort((left, right) => left.ref.localeCompare(right.ref)),
        ranking,
        explanation: explanations,
        retry_of: meta.retry_of,
        attempt: meta.attempt,
        created_at: now,
      });
      this.publish(decision);
      this.publish(decision.explanation);
      this.store.transaction(() => {
        this.store.db
          .query(
            `INSERT INTO routing_decisions
             (decision_id, scope_key, task_id, request_json, decision_json,
              decision_sha256, retry_of, attempt, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            decision.decision_id,
            scope,
            request.task_id,
            canonicalJson(request),
            canonicalJson(decision),
            decision.decision_sha256,
            decision.retry_of,
            decision.attempt,
            decision.created_at,
          );
        this.store.writeAudit({
          context,
          scope_key: scope,
          action: "routing.decided",
          subject: decision.decision_id,
          detail: {
            decision_sha256: decision.decision_sha256,
            outcome: decision.outcome,
            selected_ref: decision.selected?.ref ?? null,
          },
        });
      });
      return decision;
    };

    if (request.override) {
      const parsedRef = parseRef(request.override.ref);
      if (!parsedRef) {
        rejected.push({
          ref: request.override.ref,
          reasons: ["override_not_found"],
        });
        return persist("override_rejected", null, null, ["override_not_found"]);
      }
      if (excluded.has(request.override.ref)) {
        rejected.push({ ref: request.override.ref, reasons: ["excluded"] });
        return persist("override_rejected", null, null, [
          `override_rejected:${request.override.ref}:excluded`,
        ]);
      }
      if (parsedRef.kind === "specialist") {
        let visibleRevision: ReturnType<
          SpecialistRegistry["visibleSpecialist"]
        >;
        try {
          visibleRevision = this.visibleSpecialist(
            context,
            parsedRef.id,
            parsedRef.revision,
          );
        } catch (error) {
          if (
            !(error instanceof SpecialistRegistryError) ||
            error.code !== "not_found"
          ) {
            throw error;
          }
          rejected.push({
            ref: request.override.ref,
            reasons: ["override_not_found"],
          });
          return persist("override_rejected", null, null, [
            "override_not_found",
          ]);
        }
        const { row, registration } = visibleRevision;
        const verdict = parseVerdict(row.verdict_json);
        const gate = await this.resolveGate(
          context,
          registration,
          row.candidate_sha256,
          row.record_sha256,
          row.status,
          verdict,
          request,
          independenceTargets,
        );
        if (gate.target) {
          const explanation = [
            `override_selected:${gate.target.ref}`,
            `candidate_pass_rate:${gate.pass_rate}`,
            `serving_attestation:${gate.target.serving_attestation}`,
          ];
          if (verdict.synthetic_fixture) {
            explanation.push(
              "Evidence is a synthetic fixture; it is not a real evaluation and supports no quality claim.",
            );
          }
          return persist("specialist", gate.target, null, explanation, true);
        }
        rejected.push({
          ref: request.override.ref,
          reasons: gate.reasons,
        });
        return persist(
          "override_rejected",
          null,
          null,
          gate.reasons.map((reason) => `override_rejected:${reason}`),
          true,
        );
      }
      let visibleBaseline: ReturnType<SpecialistRegistry["visibleBaseline"]>;
      try {
        visibleBaseline = this.visibleBaseline(
          context,
          parsedRef.id,
          parsedRef.revision,
        );
      } catch (error) {
        if (
          !(error instanceof SpecialistRegistryError) ||
          error.code !== "not_found"
        ) {
          throw error;
        }
        rejected.push({
          ref: request.override.ref,
          reasons: ["override_not_found"],
        });
        return persist(
          "override_rejected",
          null,
          null,
          ["override_not_found"],
          true,
        );
      }
      const { row, profile } = visibleBaseline;
      if (row.status !== "active") {
        rejected.push({
          ref: request.override.ref,
          reasons: ["override_not_found"],
        });
        return persist(
          "override_rejected",
          null,
          null,
          ["override_not_found"],
          true,
        );
      }
      const result = await this.tryBaseline(
        context,
        profile,
        visibleBaseline.row.record_sha256,
        request,
        independenceTargets,
      );
      if (!result.target) {
        rejected.push({
          ref: request.override.ref,
          reasons: result.reasons,
        });
        return persist(
          "override_rejected",
          null,
          null,
          result.reasons.map((reason) => `override_rejected:${reason}`),
          true,
        );
      }
      return persist(
        "baseline",
        result.target,
        null,
        [`override_selected:${result.target.ref}`],
        true,
      );
    }

    if (forceUnavailable) {
      return persist(
        "unavailable",
        null,
        null,
        [`fallback_attempt_cap:8`],
        false,
      );
    }

    const visibleScopeKeys = [
      scopeKey(context.scope),
      scopeKey({
        owner_id: context.scope.owner_id,
        project_id: context.scope.project_id,
      }),
    ];
    const uniqueVisibleScopeKeys = [...new Set(visibleScopeKeys)];
    const pointerRows = this.store.db
      .query(
        `SELECT scope_key, specialist_id, production_revision, history_json,
          retired, pointer_version, updated_at FROM production
         WHERE production_revision IS NOT NULL AND retired = 0
          AND scope_key IN (${uniqueVisibleScopeKeys.map(() => "?").join(", ")})
         ORDER BY specialist_id`,
      )
      .all(...uniqueVisibleScopeKeys) as ProductionRow[];
    const candidates: CandidateResult[] = [];
    for (const pointer of pointerRows) {
      if (!pointer.production_revision) continue;
      const ref = formatRef(
        "specialist",
        pointer.specialist_id,
        pointer.production_revision,
      );
      const excludedCandidate = excluded.has(ref);
      const row = this.store.readSpecialist(
        pointer.scope_key,
        pointer.specialist_id,
        pointer.production_revision,
      );
      if (!row) {
        throw new SpecialistRegistryError("corrupt_record");
      }
      const registration = this.verifiedRegistration(row);
      if (!visible(registration.scope, context)) continue;
      const verdict = parseVerdict(row.verdict_json);
      const gate = await this.resolveGate(
        context,
        registration,
        row.candidate_sha256,
        row.record_sha256,
        row.status,
        verdict,
        request,
        independenceTargets,
      );
      const exactCoverage = verdict.covered_triples.some(
        (item) =>
          item.domain === request.domain &&
          item.role === request.role &&
          item.complexity === request.complexity,
      );
      const candidateReasons = excludedCandidate
        ? normalizeReasons([...gate.reasons, "excluded"])
        : gate.reasons;
      const candidateTarget = excludedCandidate ? null : gate.target;
      candidates.push({
        ref,
        specialist_id: registration.specialist_id,
        revision: registration.revision,
        registration,
        candidate_sha256: row.candidate_sha256,
        verdict,
        reasons: candidateReasons,
        target: candidateTarget,
        pass_rate: gate.pass_rate,
        cost_usd_per_task: gate.cost_usd_per_task,
        runtime_ms_p95: gate.runtime_ms_p95,
        covering: exactCoverage,
        production: pointer,
      });
      if (candidateTarget) {
        ranking.push({
          ref: candidateTarget.ref,
          pass_rate: gate.pass_rate,
          cost_usd_per_task: gate.cost_usd_per_task,
          runtime_ms_p95: gate.runtime_ms_p95,
        });
      } else {
        rejected.push({
          ref,
          reasons: candidateReasons,
        });
      }
    }
    const eligible = rankCandidates(
      candidates.filter(
        (candidate) =>
          candidate.target !== null && candidate.reasons.length === 0,
      ),
    );
    ranking.splice(
      0,
      ranking.length,
      ...eligible.map((candidate) => ({
        ref: formatRef(
          "specialist",
          candidate.registration.specialist_id,
          candidate.registration.revision,
        ),
        pass_rate: candidate.pass_rate,
        cost_usd_per_task: candidate.cost_usd_per_task,
        runtime_ms_p95: candidate.runtime_ms_p95,
      })),
    );
    if (eligible.length > 0) {
      const chosen = eligible[0];
      if (!chosen?.target) throw new SpecialistRegistryError("corrupt_record");
      const explanation = [
        `selected:${chosen.target.ref}`,
        `candidate_pass_rate:${chosen.pass_rate}`,
        `candidate_cost_usd_per_task:${chosen.cost_usd_per_task ?? "null"}`,
        `candidate_runtime_ms_p95:${chosen.runtime_ms_p95 ?? "null"}`,
        `serving_attestation:${chosen.target.serving_attestation}`,
      ];
      if (chosen.verdict.synthetic_fixture) {
        explanation.push(
          "Evidence is a synthetic fixture; it is not a real evaluation and supports no quality claim.",
        );
      }
      return persist("specialist", chosen.target, null, explanation, false);
    }

    if (forceUnavailable) {
      return persist(
        "unavailable",
        null,
        null,
        ["fallback_attempt_cap:8"],
        false,
      );
    }
    const coverageCandidates = rankCandidates(
      candidates.filter((candidate) => candidate.covering),
    );
    const fallbackReason =
      coverageCandidates.length > 0
        ? "intended_specialist_ineligible"
        : "no_covering_specialist";
    const chainRecords: Array<{ ref: string; reasons: ReasonCode[] }> = [];
    const rejectInChain = (ref: string, reasons: ReasonCode[]) => {
      chainRecords.push({ ref, reasons });
      rejected.push({ ref, reasons });
    };
    const visited = new Set<string>();
    let selectedFallback: SelectedTarget | null = null;
    let fallbackFrom: string | null = null;

    if (coverageCandidates.length > 0) {
      for (const candidate of coverageCandidates.slice(0, 1)) {
        const fromRef = formatRef(
          "specialist",
          candidate.registration.specialist_id,
          candidate.registration.revision,
        );
        const resolved = this.lookupFallback(
          context,
          candidate.registration.fallback_specialist_revision,
          scopeKey(candidate.registration.scope),
        );
        if (resolved.error) {
          const code = resolved.error as ReasonCode;
          rejectInChain(candidate.registration.fallback_specialist_revision, [
            code,
          ]);
          continue;
        }
        for (const ref of resolved.chain) {
          if (visited.has(ref)) {
            chainRecords.push({ ref, reasons: ["fallback_cycle"] });
            continue;
          }
          visited.add(ref);
          if (excluded.has(ref)) {
            rejectInChain(ref, ["excluded"]);
            continue;
          }
          const parsed = parseRef(ref);
          if (!parsed) {
            rejectInChain(ref, ["fallback_target_missing"]);
            continue;
          }
          const result = await this.resolveFallbackTarget(
            context,
            parsed,
            scopeKey(candidate.registration.scope),
            request,
            independenceTargets,
          );
          if (result.target) {
            chainRecords.push({ ref, reasons: result.reasons });
            selectedFallback = result.target;
            fallbackFrom = fromRef;
            break;
          }
          rejectInChain(ref, result.reasons);
        }
        if (selectedFallback) break;
      }
    }

    if (!selectedFallback) {
      const baselineRows = this.store.db
        .query(
          `SELECT scope_key, baseline_id, revision, record_json, record_sha256,
            status, created_at FROM baselines WHERE status = 'active'
            AND scope_key IN (${uniqueVisibleScopeKeys.map(() => "?").join(", ")})`,
        )
        .all(...uniqueVisibleScopeKeys) as BaselineRow[];
      baselineRows.sort(
        (left, right) =>
          Number(right.scope_key === scopeKey(context.scope)) -
          Number(left.scope_key === scopeKey(context.scope)),
      );
      const baselines = baselineRows
        .map((row) => ({
          row,
          profile: this.store.parseRecord(
            row.record_json,
            row.record_sha256,
            parseBaseline,
          ),
        }))
        .filter(
          ({ profile }) =>
            visible(profile.scope, context) &&
            profile.roles.includes(request.role) &&
            profile.complexity.includes(request.complexity),
        )
        .sort((left, right) => {
          const leftModel = this.options.catalog.getModel(
            left.profile.model_id,
          );
          const rightModel = this.options.catalog.getModel(
            right.profile.model_id,
          );
          return (
            left.profile.priority - right.profile.priority ||
            Number(leftModel?.pricing.free !== true) -
              Number(rightModel?.pricing.free !== true) ||
            left.profile.baseline_id.localeCompare(right.profile.baseline_id) ||
            left.profile.revision.localeCompare(right.profile.revision)
          );
        });
      for (const { row, profile } of baselines) {
        const ref = formatRef(
          "baseline",
          profile.baseline_id,
          profile.revision,
        );
        if (excluded.has(ref)) {
          rejectInChain(ref, ["excluded"]);
          continue;
        }
        const result = await this.tryBaseline(
          context,
          profile,
          row.record_sha256,
          request,
          independenceTargets,
        );
        if (result.target) {
          chainRecords.push({ ref, reasons: result.reasons });
          selectedFallback = result.target;
          fallbackFrom = coverageCandidates.length
            ? formatRef(
                "specialist",
                coverageCandidates[0]?.registration.specialist_id ?? "",
                coverageCandidates[0]?.registration.revision ?? "",
              )
            : null;
          break;
        }
        rejectInChain(ref, result.reasons);
      }
    }

    if (selectedFallback) {
      const explanation = [
        `fallback:${fallbackReason}`,
        `fallback_selected:${selectedFallback.ref}`,
      ];
      const fallbackVerdict =
        selectedFallback.kind === "specialist" &&
        selectedFallback.specialist_id !== null
          ? (() => {
              const { row } = this.visibleSpecialistByTarget(
                context,
                selectedFallback,
              );
              return parseVerdict(row.verdict_json);
            })()
          : null;
      if (fallbackVerdict?.synthetic_fixture) {
        explanation.push(
          "Evidence is a synthetic fixture; it is not a real evaluation and supports no quality claim.",
        );
      }
      return persist(
        selectedFallback.kind,
        selectedFallback,
        {
          reason_code: fallbackReason,
          from: fallbackFrom,
          chain: chainRecords,
        },
        explanation,
        false,
      );
    }
    return persist(
      "unavailable",
      null,
      {
        reason_code: fallbackReason,
        from:
          coverageCandidates.length > 0
            ? formatRef(
                "specialist",
                coverageCandidates[0]?.registration.specialist_id ?? "",
                coverageCandidates[0]?.registration.revision ?? "",
              )
            : null,
        chain: chainRecords,
      },
      [`unavailable:${fallbackReason}`],
      false,
    );
  }

  async decision(
    context: RequestContext,
    decisionId: string,
  ): Promise<RoutingDecision> {
    const ctx = this.checkContext(context);
    const row = this.store.db
      .query(
        `SELECT decision_id, scope_key, task_id, request_json, decision_json,
          decision_sha256, retry_of, attempt, created_at
         FROM routing_decisions WHERE decision_id = ?`,
      )
      .get(decisionId) as {
      decision_id: string;
      scope_key: string;
      task_id: string;
      request_json: string;
      decision_json: string;
      decision_sha256: string;
      retry_of: string | null;
      attempt: number;
      created_at: string;
    } | null;
    if (!row || row.scope_key !== scopeKey(ctx.scope)) {
      throw new SpecialistRegistryError("not_found");
    }
    const decision = parseStored(row.decision_json, RoutingDecisionSchema);
    if (
      decision.decision_sha256 !== row.decision_sha256 ||
      decisionDigest(decision as unknown as Record<string, unknown>) !==
        row.decision_sha256
    ) {
      throw new SpecialistRegistryError("corrupt_record");
    }
    this.publish(decision);
    return decision;
  }

  async fallbackAfterFailure(
    context: RequestContext,
    decisionId: string,
    failure: {
      ref: string;
      side_effects: "none" | "output_emitted" | "tools_executed" | "unknown";
    },
  ): Promise<RoutingDecision> {
    const ctx = this.checkContext(context);
    const prior = await this.decision(ctx, decisionId);
    if (!prior.selected || prior.selected.ref !== failure.ref) {
      throw new SpecialistRegistryError(
        "invalid_input",
        "failure_ref_mismatch",
      );
    }
    if (failure.side_effects !== "none") {
      throw new SpecialistRegistryError("fallback_after_side_effects");
    }
    const lineage: Array<{
      decision_id: string;
      request_json: string;
      retry_of: string | null;
      attempt: number;
      selected_ref: string | null;
      rejected_json: string;
    }> = [];
    let currentId: string | null = decisionId;
    const seen = new Set<string>();
    while (currentId && !seen.has(currentId)) {
      seen.add(currentId);
      const row = this.store.db
        .query(
          `SELECT decision_id, request_json, retry_of, attempt, decision_json
           FROM routing_decisions WHERE decision_id = ? AND scope_key = ?`,
        )
        .get(currentId, scopeKey(ctx.scope)) as {
        decision_id: string;
        request_json: string;
        retry_of: string | null;
        attempt: number;
        decision_json: string;
      } | null;
      if (!row) break;
      const decision = parseStored(row.decision_json, RoutingDecisionSchema);
      lineage.push({
        decision_id: row.decision_id,
        request_json: row.request_json,
        retry_of: row.retry_of,
        attempt: row.attempt,
        selected_ref: decision.selected?.ref ?? null,
        rejected_json: JSON.stringify(
          decision.rejected.map((item) => item.ref),
        ),
      });
      currentId = row.retry_of;
    }
    const requestRow = this.store.db
      .query(
        "SELECT request_json, attempt FROM routing_decisions WHERE decision_id = ? AND scope_key = ?",
      )
      .get(decisionId, scopeKey(ctx.scope)) as {
      request_json: string;
      attempt: number;
    } | null;
    if (!requestRow) throw new SpecialistRegistryError("not_found");
    const storedRequest = parseStored(
      requestRow.request_json,
      RoutingRequestSchema,
    );
    const exclusions = new Set(storedRequest.exclude_refs ?? []);
    for (const item of lineage) {
      if (item.selected_ref) exclusions.add(item.selected_ref);
      try {
        for (const ref of JSON.parse(item.rejected_json) as string[]) {
          exclusions.add(ref);
        }
      } catch {
        throw new SpecialistRegistryError("corrupt_record");
      }
    }
    exclusions.add(failure.ref);
    const attempt = requestRow.attempt + 1;
    const { override: _override, ...requestWithoutOverride } = storedRequest;
    const retryRequest = {
      ...requestWithoutOverride,
      exclude_refs: [...exclusions].sort(),
    };
    return this.routeWithMeta(
      ctx,
      retryRequest,
      { retry_of: decisionId, attempt },
      attempt >= 8,
    );
  }

  async routeTeam(
    context: RequestContext,
    input: {
      schema_version: 1;
      task_id: string;
      domain: string;
      complexity: Complexity;
      requires: RoutingRequest["requires"];
      budget: Budget;
      paid_consent: boolean;
      lead?: { complexity?: Complexity; override?: { ref: string } };
      worker?: { complexity?: Complexity; override?: { ref: string } };
      reviewer?: {
        complexity?: Complexity;
        override?: { ref: string };
        independence?: "none" | "distinct_model" | "distinct_lineage";
      };
    },
  ): Promise<{
    lead?: RoutingDecision;
    worker?: RoutingDecision;
    reviewer?: RoutingDecision;
  }> {
    const ctx = this.checkContext(context);
    if (input.schema_version !== 1) {
      throw new SpecialistRegistryError(
        "invalid_input",
        "team_request_invalid",
      );
    }
    const result: {
      lead?: RoutingDecision;
      worker?: RoutingDecision;
      reviewer?: RoutingDecision;
    } = {};
    const shared = {
      schema_version: 1 as const,
      task_id: input.task_id,
      domain: input.domain,
      requires: input.requires,
      budget: input.budget,
      paid_consent: input.paid_consent,
    };
    if (input.lead) {
      result.lead = await this.route(ctx, {
        ...shared,
        role: "lead",
        complexity: input.lead.complexity ?? input.complexity,
        ...(input.lead.override ? { override: input.lead.override } : {}),
      });
    }
    if (input.worker) {
      result.worker = await this.route(ctx, {
        ...shared,
        role: "worker",
        complexity: input.worker.complexity ?? input.complexity,
        ...(input.worker.override ? { override: input.worker.override } : {}),
      });
    }
    if (input.reviewer) {
      result.reviewer = await this.route(ctx, {
        ...shared,
        role: "reviewer",
        complexity: input.reviewer.complexity ?? input.complexity,
        ...(input.reviewer.override
          ? { override: input.reviewer.override }
          : {}),
        independence: {
          policy: input.reviewer.independence ?? "distinct_model",
          from_decision_ids: [
            result.lead?.decision_id,
            result.worker?.decision_id,
          ].filter((id): id is string => id !== undefined),
        },
      });
    }
    return result;
  }

  async select(
    context: RequestContext,
    task: Task,
  ): Promise<{ manifest: SpecialistManifest; reason: string }> {
    if (!this.options.taskRouting) {
      throw new SpecialistRegistryError(
        "invalid_input",
        "task_routing_unconfigured",
      );
    }
    const request = this.options.taskRouting(task);
    const decision = await this.route(context, request);
    if (decision.outcome === "specialist" && decision.selected?.specialist_id) {
      const registration = this.visibleSpecialistByTarget(
        context,
        decision.selected,
      ).registration;
      return {
        manifest: registration,
        reason: decision.explanation.join(" "),
      };
    }
    if (decision.outcome === "baseline") {
      throw new SpecialistRegistryError(
        "baseline_selected",
        undefined,
        decision,
      );
    }
    throw new SpecialistRegistryError(
      "no_eligible_target",
      undefined,
      decision,
    );
  }
}

export function createSpecialistRegistry(
  options: SpecialistRegistryOptions,
): SpecialistRegistry {
  return new SpecialistRegistry(options);
}
