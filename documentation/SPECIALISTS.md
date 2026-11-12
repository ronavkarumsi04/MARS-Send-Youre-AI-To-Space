# Specialist profiles and deterministic routing

`@mars/specialists` is an isolated, provider-independent registry for
specialist and baseline profiles, signed evaluation evidence, serving
compatibility, lifecycle state, and routing decisions. It does not train or
evaluate models, execute models, schedule work, or reproduce private routing
logic from other products. The registry returns auditable selections; MARS'
existing execution and provider layers remain responsible for using them.

## Conceptual references

This package uses documented product concepts only:

- Factory's [custom Droid configuration](https://docs.factory.ai/cli/configuration/custom-droids)
  documents per-subagent model pinning or inheritance and optional
  light/medium/heavy complexity mapped to configured models. Its documented
  behavior for a disallowed pinned model falls back to the parent model. MARS
  instead records a stable reason and tries an explicit eligible baseline.
- Devin's [Fusion](https://docs.devin.ai/desktop/fusion) describes a lead
  planning and reviewing work, delegating execution to cheaper sidekicks,
  while retaining one user-facing owner. MARS' `routeTeam` maps lead, worker,
  and independent-reviewer roles to deterministic selections; it does not
  recreate Devin's private routing or orchestration logic.

These are conceptual mappings, not claims of compatibility or identical
behavior.

## Integration seams

1. The host constructs a registry synchronously with `createSpecialistRegistry`
   and `catalog = await
   loadModelRegistry(...)` (structurally compatible with `ModelCatalog`),
   `artifacts = taskStore.artifacts`, and an HMAC verifier whose keys remain
   host-side. Pass environment variable names through host configuration;
   never put key values in source, reports, or documentation. A host may add a
   serving attestor or an evaluation-service importer.
   Contract `register` can receive a plain `SpecialistManifest` when the host
   configures `contractProfiles`; the resolver provides roles, serving
   bindings, and acceptance policy, which are required by the evidence gate
   but absent from the contract manifest type.
2. At a task/session boundary, call `route` or `routeTeam` and persist the
   returned `decision_id`. For a specialist outcome, write
   `Task.specialist_revision` via `taskStore.update(...)`.
   The local workbench does this when configured with
   `specialists: { router, domain, complexity?, paid_consent? }`: `start`
   routes once as role `worker` before any workspace or runtime exists,
   freezes `{decision_id, outcome, ref, specialist_revision, model_id}` into
   private launch metadata, sets `Task.specialist_revision` in the same
   revision step that marks the task running, and pins the selected model for
   that session and every resume. An explicit `model_id` on `start` skips
   routing. Baseline, unavailable and rejected outcomes use the ordinary
   free-only registry default; a registry error leaves the task pending with
   `unavailable`.
   For per-step routing, wrap the registry in `SpecialistTaskRouter` and pass
   it as `specialists.steps`. `routeStep(context, { request, usage?,
   deadline_at? })` routes against the task budget minus durable `usage` and
   the time left before the fixed deadline. The first step routes normally
   and pins its target. Every later step re-checks the pin with an override
   route, so evidence, serving attestation and budget gates are evaluated
   again. A pin that was rolled back, superseded, retired or rejected (for
   example `serving_unattested` or `budget_cost_exceeded`) goes into
   `lost_refs` and is never selected again for that task. The step then walks
   the pin's `fallback_specialist_revision` chain (`resolveFallbackChain`
   rules) before the ordinary baseline fallback. An adapter target without
   `serving_attestation: "verified"` is refused even if a registry returns
   one. Exhausted tokens, USD or deadline give `budget_exhausted` without
   routing. Per-task state is stored in SQLite (`task_routing_state`),
   committed with a step compare-and-set, and serialized per task and role
   in-process. Each step returns a `mars.specialist-routing-step/v1` record
   with mode, decision ids, selected target, `fallback_from`, rejected refs
   and reasons, `step_reasons` and remaining budget. With `steps` configured,
   the workbench routes launches and children through it and appends each
   step as an `operation: "routing"` task event (`phase` `launch`, `child` or
   `resume`). On resume of a specialist launch it re-routes with the task's
   durable usage (event usage, committed holds and the foreground ledger)
   and its fixed deadline. A pin that is still verified resumes unchanged.
   A pin that is no longer a verified target (rolled back, superseded,
   retired, or rejected for `serving_unattested` or another `serving_*` /
   binding reason, including an unreachable attestor) resumes on the routed
   fallback: the `fallback_specialist_revision` chain, then the baseline,
   which runs on the free-only default model. Before the task is marked
   running the host rewrites the launch (`model_id`, `routing`, and an
   append-only `model_rebinds` entry with both refs, models, the decision id
   and `step_reasons`), the task store records the new
   `Task.specialist_revision` (null for base) in the same revision step as
   the resume, and the runtime rebinds the saved journal to the fallback
   model (`mars.model_rebind` + a new `mars.binding`), keeping its
   conversation, budget ledger and deadline. The resume routing event
   carries a `resume` record: `action` (`pinned`, `fallback` or
   `refused`), the invalidation or refusal `reason`, and the from/to refs
   and models. Resume never starts an adapter without verified attestation,
   and a free session never falls back to a paid model
   (`fallback_paid_refused`); a paid fallback needs a paid launch and
   `paid_consent`. A pin dropped only for budget or capability
   (`pinned_not_invalidated`), an exhausted budget, a changed serving binding
   for the same pin, or a routing error leaves the task paused with
   `unavailable` and the launch unchanged.
3. Execution passes `{ model: selected.model_id }` to the existing
   `ModelRouter` through the execution/model-bridge, keeping the selected
   model pinned for that attempt. The specialist package does not perform
   provider calls or route hops.
4. For independent routing, requests use `independence.from_decision_ids`.
   The registry loads hash-verified, caller-scope decisions and checks their
   task IDs before comparing selected targets.
5. After a provider failure, a host may explicitly call
   `fallbackAfterFailure` only if no output or tool side effect occurred. The
   call drops any override and re-routes automatically; otherwise surface the
   failure because the registry refuses a live retry.
6. A memory deletion affecting training manifests can call
   `invalidateDependency` with the affected artifact digest or component
   revision. It applies only to records in the exact caller scope.
7. Workbench, CLI, and VS Code panels can read `inspect`, `list`, `audit`, and
   `decision`. Do not expose registry roots or session-private paths over RPC.
8. A future coordinator can consume `routeTeam` output. `routeTeam` returns
   selections only and never starts a team.

## CLI registry and trust files

`mars serve --specialists-registry DIR --specialists-trust FILE
--specialists-domain AREA/KIND [--specialists-complexity light|medium|heavy]`
constructs the registry and per-step router. It
cannot be combined with `--omniroute`: the gateway creates a separate model
catalog that specialist routing cannot currently share. This combination is
refused as a usage error.
Complexity defaults to `medium`;
paid consent is false. It uses the workbench catalog, including attached vLLM
models. `--vllm` plus `--vllm-profile FILE` is required for adapter attestation;
without an attestor adapters never route. Unattested, unloaded or off-pin targets
fall back to an eligible baseline with recorded reasons. Baseline execution uses
the ordinary free-only default route. See [SERVING.md](SERVING.md) for startup
versus mid-task fail-closed behavior.

Both serve and evaluate use `createFileArtifactStore(DIR/artifacts)`:
content-addressed bytes live at `DIR/artifacts/<sha256>` (files `0600`, artifact
directory `0700`). `put` derives `artifact_id` from the hash; `get` checks SHA-256
and byte length and throws on mismatch. Registry SQLite state remains under
`DIR`; comparisons are under `DIR/evaluations/specialist-comparisons/`.

The strict trust JSON schema is `mars.specialist-trust/v1`:

```json
{
  "schema": "mars.specialist-trust/v1",
  "authorities": [{
    "key_id": "local-key",
    "authority_id": "local-authority",
    "secret_env": "MARS_SPECIALIST_SECRET",
    "owner_ids": ["local"],
    "evaluator_ids": ["mars-serving-evaluator"]
  }]
}
```

`loadSpecialistTrust(FILE, env)` reads **UTF-8**, not hex-decoded, secret bytes
from each named variable; unset, empty or whitespace-only values, duplicate key
ids and unknown JSON fields are refused. Authorities and authorization lists
must be nonempty. Never put secret values in the file. HMAC verification checks
owner and evaluator authorization. For evaluate, `--signing-key-id` must name an
authority authorizing both `--owner` and the evaluator `mars-serving-evaluator`.
Production CLI registries do not enable `allowSyntheticFixtures`.

`mars specialists evaluate` loads this registry and trust file, checks held-out
expectations, runs serving-backed arms, and records signed verdicts through
`recordEvaluationVerdict`. See [EVALUATION.md](EVALUATION.md) for its flags and
expectations schema. A candidate adapter absent from serving and held-out
leakage both refuse before any completion (zero completions).

Offline verification covers fake vLLM control endpoints and opt-in fake
completions, real attestor code against that fake, injected fake attestor paths,
fixture evaluators, and serve/evaluate spawn tests. Fixture evaluators are
simulated with zero requests; serving-backed tests are `simulated: false` but
only contact loopback fakes and count those completions. GPU host, real pinned
vLLM, model key and live adapter serving remain blocked, not quality claims.

## Boundaries and limitations

Evaluation and training are not performed here (training lives in
`@mars/training`, whose run report carries the exact `registration` fields and
signed lineage this registry checks); this package only submits an
immutable comparison request when an `EvaluationService` is injected. The
included evaluation fixtures are synthetic and make no quality claim. HMAC
attestation proves origin and byte integrity, not result truth. Hosted base
models may drift without a serving attestor. Persistence is local, single-host
SQLite; there is no distributed coordination. Cost and runtime decisions are
only as good as the signed report. The registry does not alter existing apps,
contracts, the provider router, or task execution.

## Held-out comparison verdicts (Milestone 7)

`requestEvaluation` delegates a `mars.specialist-comparison-request/v1` to
`@mars/evaluation`; the verdict comes back through
`recordEvaluationVerdict(context, { job, report, verdict, value })`
(wrapped by `verdictSinkFromRegistry`). The registry only trusts what it can
re-verify: the job must be one it delegated in the caller's scope, the
verdict's subject and candidate digest must match the stored revision, and
the signed report must pass `verifyEvidence` and carry this job's report id
(`comparisonReportId(job_id)`, so an older report cannot be replayed), and the
verdict's `outcome`/`simulated` must agree with the signed per-triple results
and `synthetic_fixture`; failures throw (nothing is stored, the evaluation job
fails). A verdict that arrives before `submitComparison` returns waits for the
job row, and `reverify` retries if a verdict is recorded while it runs. An accepted report is stored
in `evaluation_verdicts` (store format v2; a v1 store is migrated in place)
with an `evaluation.recorded` audit event, and becomes the evidence that
`reverify`, `promote`, rollback and routing gate on, so `no_improvement` and
`regressed` outcomes are recorded honestly and may demote the revision.
`evaluationVerdicts(context, id, revision)` lists them.
