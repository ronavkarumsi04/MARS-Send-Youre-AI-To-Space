# Independent evaluation and prompt optimisation (Milestone 4)

This document describes how MARS measures itself against an independent
harness and how prompt changes are proposed. It follows
[`MASTER_SPECIFICATION.md`](MASTER_SPECIFICATION.md) sections 8, 9, 11 and 16:
learning claims are measured by an independent verifier, candidates are
compared with a pinned baseline under matched conditions, costs and
regressions are recorded, and nothing is promoted automatically.

Everything below is either **verified** (actually executed in this
repository's history, with the command and output recorded) or
**unverified** (implemented and tested offline with fixtures, but not run
against the real external system). Simulated and fixture-driven results are
labelled `simulated: true` in their records and are never acceptance
evidence.

## Ownership (one owner per responsibility)

| Responsibility | Owner | Notes |
| --- | --- | --- |
| Live agent loop, tools, model calls | Oh My Pi via `@mars/execution` `openRuntimeSession` | The Harbor agent adapter drives this runtime; it does not add a second loop. |
| Benchmark harness, task environments, verifiers | Harbor 0.25.0 (pinned Python 3.12 venv) | Launched and bounded by `@mars/evaluation`; result/reward/error records are parsed, exit codes are not trusted. |
| Task set | Terminal-Bench 2 (`terminal-bench@2.0`, `terminal-bench-sample@2.0`) | Pinned per task to a git commit by the Harbor registry (see [`SOURCE_REGISTER.md`](SOURCE_REGISTER.md)). |
| Baseline agent | mini-swe-agent 2.4.6 via Harbor's installed adapter | Same task, environment, verifier and model endpoint as the candidate. |
| Comparison, repeatability, regressions, trajectories | `@mars/evaluation` | Implements `EvaluationService` and `PromptScoringBackend` from `@mars/contracts`. |
| Prompt optimisation | GEPA 0.1.4 in a separate pinned Python worker, driven by `@mars/optimization` | Implements `OptimizationService`; scores only through `PromptScoringBackend`; candidates are proposals. |

`PromptScoringBackend.score(context, request, { signal })` carries an optional `AbortSignal`: when an optimisation job is cancelled or reaches its deadline the Harbor run behind the score is killed (process group), so no evaluation outlives the job that requested it. The seed candidate is re-scored under every `evaluate` request (same repeats and backend as the candidate); earlier baselines are never compared against a new candidate. Inside the task container the credential never enters any process environment or argv: the adapter uploads it as a file, `chown`s it (from a root exec, since `docker cp` creates root-owned files) to the uid/gid the trial actually runs as, `chmod 0600`s it and verifies `test -r` as that user (all adapter commands run with a fixed `PATH=/usr/sbin:/usr/bin:/sbin:/bin`, so a task-controlled PATH entry cannot shadow them; a hostile task image that replaces `/bin` itself is outside this boundary; each of these commands carries its own 60 s `timeout_sec`). `trial_timeout_ms` bounds the adapter's `run()` — instruction upload, credential handover and the bundle exec (whole seconds of the remaining budget, refused under 1 s); Harbor's `upload_file`/`download_file` take no timeout, so they are wrapped in `asyncio.wait_for` on the remaining budget — independently of Harbor's per-task agent timeout, which is unset for tasks without one. Usage collection after the bundle exits gets the larger of the remaining budget and a 10 s grace window; a slow or missing usage file is recorded as `usage_available: false` / `usage_error` and never turns a completed trial into an agent error. `setup()` (bundle, addon and config upload) is bounded by Harbor's agent setup timeout (`DEFAULT_SETUP_TIMEOUT_SEC` × `--agent-setup-timeout-multiplier`), not by `trial_timeout_ms`. — an unreadable credential fails the trial before it starts instead of surfacing as a model authentication error — and the bundle reads and unlinks it (`MARS_AGENT_CREDENTIAL`) before any task command runs — deleting a variable from `process.env` alone would leave it readable in `/proc/<pid>/environ`. `MARS_AGENT_*` is a reserved prefix and rejected as a model `api_key_env` name. `EvaluationJobStore` serializes writes per job (each write uses a unique temp file and waits for the previous one), so the `onSpawn` pid update cannot race the completion update that follows a short Harbor run.
| Model configuration | `@mars/providers` registry (`~/.mars/models.json` or `$MARS_HOME/models.json`) | Includes the built-in `ollama` provider for local models. |

## Packages

- [`packages/evaluation`](../packages/evaluation/README.md) — Harbor adapter,
  `mars.evaluation-comparison/v1` manifests, result parsing, grader
  repeatability, regressions, trajectory artifacts, Harbor scoring backend,
  Python `mars_harbor_agent` custom agent.
- [`packages/optimization`](../packages/optimization/README.md) — bounded GEPA
  worker, train/validation/final-holdout splits, candidate lifecycle and
  proposal reports.

Workbench wiring is read-only: `WorkbenchHostOptions.optimization` (a
`candidates`/`report` view of `@mars/optimization` plus the target ids a
workbench may read) adds the host-bound `mars_proposals` tool, which renders
candidates and proposal reports as bounded, labelled untrusted text. Sessions
cannot propose, decide, publish, or see the final holdout through it.

The package READMEs carry the detailed architecture, setup commands, test
inventory and their own verified/unverified sections. This document records
the cross-cutting rules and the evidence produced in this increment.

## Rules that every run must satisfy

1. **Matched conditions.** Baseline and candidate run the same task ids at the
   same pinned task commit, the same Harbor version, the same Docker images
   (recorded by digest), the same model name and base URL, the same timeouts
   and the same number of repeats. A manifest that does not pin these is
   rejected before anything runs.
2. **Records, not exit codes.** Harbor can exit 0 with errored trials
   ([`MILESTONE_0.md`](MILESTONE_0.md)). A trial counts only when its
   `result.json` has `verifier_result.rewards` and no reward-invalidating
   exception; every exception is recorded with the trial.
3. **Repeatability.** Each trial is run N times (`repeats`); the report
   stores mean, variance, min and max per task and arm and flags tasks whose
   identical repeats disagree, so grader noise is visible before any claim.
4. **Regressions are first-class.** Any task where the candidate scores below
   the baseline is listed; a report with regressions cannot be summarised as
   an improvement.
5. **Holdout isolation.** Optimisation only ever sees `train` and
   `validation` instance ids (the `ScoringRequest.split` type has no holdout
   value). `final_holdout` ids live in a separate record read only by the
   final-report path. Verifier files never reach the candidate: the agent
   receives `instruction.md` only.
6. **Proposals only.** Optimised prompts are stored as `PromptCandidate`
   records with a `draft -> proposed -> accepted | rejected | archived`
   lifecycle. Nothing writes to the live `SYSTEM_PROMPT` or any production
   target. A result of "no improvement" is a valid, expected outcome and is
   reported as such.
7. **Bounds at the boundary.** `Budget.max_duration_ms`, `max_usd` and
   `max_concurrency` are enforced by the TypeScript side, which kills the
   Harbor or GEPA process tree on deadline or cancel. Python workers are
   untrusted; their pins are verified before launch.
8. **Untrusted evidence.** Anything shown to a model (verifier output,
   trajectories, feedback for reflection) is rendered as bounded text labelled
   as untrusted evidence with secrets scrubbed.

## Python environment (exact pins)

```sh
curl -LsSf https://astral.sh/uv/install.sh | sh
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python harbor==0.25.0 mini-swe-agent==2.4.6 gepa==0.1.4
```

DSPy is intentionally **not** installed: DSPy 3.4.1 pins GEPA 0.1.4 while the
audited GEPA HEAD differs, so GEPA runs in its own worker. Package READMEs
record the full `uv pip freeze` lock files they rely on. Harbor needs Docker;
there is no host-shell fallback.

Verified in this increment (no model):

```text
$ harbor dataset list --legacy        # terminal-bench 2.0 (89), terminal-bench-sample 2.0 (10)
$ harbor run -d terminal-bench-sample@2.0 -a nop --dry-run -o jobs --job-name dryrun-sample -y
Dry run OK — 10 trial(s); nothing was run.
$ harbor run -d terminal-bench-sample@2.0 -i regex-log -a nop    -k 2 -n 2 -o jobs --job-name nop-regex-log-k2 -y     # 2 completed, 0 errored, reward 0.0 x2, 27 s
$ harbor run -d terminal-bench-sample@2.0 -i regex-log -a oracle -k 2 -n 2 -o jobs --job-name oracle-regex-log-k2 -y  # 2 completed, 0 errored, reward 1.0 x2, 26 s
```

The two Docker runs (parsed records in
[`evidence/harbor-live-runs.txt`](evidence/harbor-live-runs.txt)) show the
grader discriminating (`nop` 0.0 vs `oracle` 1.0) with zero variance over two
identical trials on a deterministic task. This is grader-repeatability evidence
for one task without any model, not an agent comparison.

## Local model path: Ollama with Qwen3-Coder

Ollama is a built-in `openai-compatible` provider (`id: ollama`, base URL
`http://localhost:11434/v1`, no API key). Register a Qwen3-Coder model with the
existing `models` command; nothing is added to the built-in model list because
the default route would then try an unreachable local endpoint on machines
without Ollama.

```sh
curl -fsSL https://ollama.com/install.sh | sh      # CPU-only works; 18 GB download for the 30B MoE model
ollama pull qwen3-coder:30b
export MARS_HOME=~/.mars                           # or any private directory holding models.json
bun apps/cli/src/main.ts models add --provider ollama --model qwen3-coder:30b \
  --id ollama/qwen3-coder --tools --context 32768 --free
bun apps/cli/src/main.ts models test ollama/qwen3-coder
bun scripts/local-model-run.ts ollama/qwen3-coder  # tiny real Oh My Pi runtime run, write approval only
```

For Harbor runs the same endpoint is passed as `--base-url` (reachable from
the task container, e.g. `http://host.docker.internal:11434/v1` or the Docker
bridge address) with `--api-format openai_chat_completions`; the API-key
environment variable may hold any placeholder because Ollama ignores it.

### Evidence (live model, CPU-only VM, 8 vCPU / 31 GiB, no GPU)

Full transcript: [`evidence/local-model-run.txt`](evidence/local-model-run.txt).

| Step | Result |
| --- | --- |
| Direct `/v1/chat/completions`, 16-token prompt | `MARS-OK`, 26.4 s cold (model load), **verified** |
| `mars models test ollama/qwen3-coder` | `MARS model test OK`, 16 in / 6 out tokens, 2.5 s warm, **verified** |
| `scripts/local-model-run.ts` (real runtime session, 3 identical runs) | status `completed`, 1 model request, but `greet.txt` **not written**: the model returned its tool call as text, **verified failure** |
| Replay of the exact request without the MARS system prompt | structured `tool_calls` for `mars_write`, **verified** |
| MARS agent (`mars_harbor_agent.agent:MarsAgent`, compiled bundle) inside a real TB2 container on `regex-log`, two variants (default prompt, minimal prompt candidate) | both ran end to end, reward 0.0, `status: failed`, 2 model requests each cut at the 60 s per-request cap; **verified failure** ([`evidence/harbor-mars-agent-live.txt`](evidence/harbor-mars-agent-live.txt)) |
| mini-swe-agent 2.4.6 baseline inside a TB2 container with this model | **unverified**: Harbor's installed adapter started it but `litellm` failed to import (`No module named 'mcp'`) in a retry loop; no request reached the model |

Interpretation: with `qwen3-coder:30b` through Ollama, the fixed MARS system
prompt in `packages/execution/src/runtime.ts` deterministically (temperature 0)
makes the model emit a malformed native XML tool call that Ollama's
OpenAI-compatible parser does not convert, so the runtime sees prose instead of
a tool call. Removing the `i` intent parameter or the `<system-reminder>`
preamble does not change this; removing the system prompt does. The system
prompt is precisely the explicit prompt target that `@mars/optimization`
treats as a proposal, so it was **not** changed here. Inside Harbor task
containers a second limit dominates on this CPU-only machine: the runtime caps
each provider request at 60 s (`packages/execution/src/model-bridge.ts`), and
qwen3-coder:30b on CPU does not finish a ~2k-token TB2 request in that time,
so both live MARS trials failed before any tool call. A real-model comparison
therefore needs a faster endpoint (GPU) or a configurable per-request timeout,
plus an accepted prompt proposal or a different model; all remain unverified.
The per-request timeout is now configurable per model with `requestTimeoutMs`
in `models.json` (1 000 ms to 1 h; default 60 000 ms, always bounded by the
task deadline), and a failed run reports a `failure_code` (`provider_timeout`,
`deadline_exceeded`, `budget_exhausted`, `provider_error`, `no_response`) in its
error and in the workbench `runtime.result` event.

## What is verified and what is not (this increment)

Verified (commands and outputs recorded above or in the package READMEs):

- Harbor 0.25.0, mini-swe-agent 2.4.6 and GEPA 0.1.4 install into a pinned
  Python 3.12 venv; `harbor run --dry-run` resolves the pinned
  `terminal-bench-sample@2.0` trials.
- Ollama + Qwen3-Coder answers through the existing providers registry with
  no API key; the runtime-level tool-calling failure above is reproducible.
- Offline test suites of both packages (fixtures, fake workers, injected
  responses) with `model_requests: 0`.

Unverified:

- A full baseline-vs-candidate Terminal-Bench 2 comparison with a real model
  (the MARS arm ran live but failed at the 60 s request cap; the
  mini-swe-agent arm did not start).
- Grader repeatability on real TB2 containers beyond the single `regex-log`
  nop/oracle check above and what the package README reports.
- A GEPA optimisation run with a real reflection model producing an improved
  validation score; a run that shows no improvement is an equally valid
  outcome and must be reported as such.
- Harbor separate-verifier (`no-network`) isolation on this VM
  ([`MILESTONE_0.md`](MILESTONE_0.md)).

Milestone 4 acceptance (spec section 16) is therefore **not claimed**.

## Milestone 7 — held-out specialist adapter-vs-base evaluation

`SpecialistRegistry.requestEvaluation` stores a
`mars.specialist-comparison-request/v1` manifest and submits it through
`EvaluationService.submitComparison`. `createSpecialistComparisonService`
(`packages/evaluation/src/specialist-comparison.ts`) is that service for
specialists:

- **Request → job.** Submission parses the request, resolves the registered
  revision (`subjectResolverFromRegistry` over `SpecialistRegistry.inspect`)
  and refuses with a `SpecialistComparisonError` unless the scope and
  `candidate_sha256` match. Refusals happen before a job exists, so the
  registry records no evaluation job for them.
- **Held-out exclusion.** The held-out split is a `mars.held-out-split/v1`
  file served by `createHeldOutGuard` from `@mars/datasets`. The candidate's
  dataset lineage (train + validation task ids and dataset digests) goes
  through `findHeldOutLeakage`: any held-out task id, normalized request digest
  or the split's own digest in the lineage refuses the job with
  `heldout_leakage`. Lineage `request_sha256s` (SHA-256 of each normalized
  training/validation request) are checked to catch matching request text
  across different task ids. Every held-out task must carry its `request` text.
  A lineage without this field (or with an empty list) is refused with
  `lineage_requests_unverifiable`, since request overlap cannot be ruled out.
  `packages/training` writes the digest of every user turn in its train and
  validation examples into the lineage it signs. An adapter without lineage
  is refused (`lineage_missing`), and an evaluator whose id equals the
  lineage's training producer is refused (`evaluator_not_independent`). Only
  split tasks covered by the request's domains, roles and complexities run.
- **Matched conditions.** Every arm (`base` and `prompt_optimized_baseline`
  on the registered base model, `current_specialist` when a production
  revision exists, `candidate`) runs the same tasks, repeats, seed (derived
  from the candidate digest and split digest) and an equal share of the job
  budget; an arm that overspends its share fails the job. A task passes when a
  strict majority of its repeats score 1.
- **Job → verdict.** The service writes a signed
  `mars.specialist-evaluation-report/v1` (HMAC, exactly as
  `createHmacEvidenceVerifier` checks it) and a
  `mars.specialist-comparison-verdict/v1` whose `outcome` is `improved` only
  when every gate passes with a positive delta vs base. Equal pass rates are
  recorded as `no_improvement` (`no_delta_vs_base`); a lower rate is
  `regressed`. Both artifacts are returned by `inspect` and handed to the
  `SpecialistVerdictSink`. In integration the sink is
  `verdictSinkFromRegistry(registry)`: `SpecialistRegistry.recordEvaluationVerdict`
  accepts the verdict only for a job it delegated (job id, input manifest,
  subject and candidate digest must match), re-runs `verifyEvidence` on the
  signed report, refuses reports that fail integrity (signature, digest,
  subject, scope, independence, or synthetic evidence the registry does not
  allow) so the job fails, and otherwise stores the verdict against the
  revision. The newest recorded report becomes the revision's gating
  evidence, so an authentic `regressed` verdict demotes it to `rejected`.
  Jobs persist under
  `<stateDir>/specialist-comparisons/`; a job left running by a restarted
  process is marked failed, never resumed silently.
- **CLI.** `runSpecialistsEvaluate` in `apps/cli/src/specialists-eval.ts`
  (`mars specialists evaluate`) refuses with `SpecialistsEvalRefusal`
  when `--model-key-env NAME` is unset, `--serving URL` is absent or does not
  answer `GET /v1/models`, or live configuration is absent. Messages
  name flags and variable names, never the key.

Offline-verified: the round trip, leakage refusals, no-improvement and
regressed verdicts, budget overrun, restart, scope isolation and every CLI
refusal, with `createFixtureArmEvaluator` (simulated, `model_requests: 0`)
and the registry's own `verifyEvidence` accepting the signed report.
Simulated reports carry `synthetic_fixture: true`, so a registry without
`allowSyntheticFixtures` rejects them. The serving-backed evaluator is now wired
and separately tested against loopback fake completions (`simulated: false`);
real vLLM with base + adapter, a GPU host and a model key remain blocked.

### Serving-backed CLI

```sh
mars specialists evaluate --specialist specialist-1@1 --held-out HELDOUT.json \
  --model-key-env MARS_EVAL_KEY --serving http://127.0.0.1:8000 \
  --registry /private/specialists --trust TRUST.json --signing-key-id local-key \
  --vllm-profile PROFILE.json --expectations EXPECTATIONS.json \
  --owner local --project my-project \
  --max-tokens 100000 --max-duration-ms 30000
```

The original `--specialist`, `--held-out`, `--model-key-env` and `--serving`
preconditions retain their order. With none of the live configuration flags,
the command still refuses `live_evaluation_unavailable` after key and serving
checks. For the default live implementation, `--registry`, `--trust`,
`--signing-key-id`, `--vllm-profile`, `--expectations` and `--project` are required.
`--owner` defaults to `local`. Optional `--max-tokens` (100000) is the total job
budget divided equally among runnable arms; `--max-duration-ms` (30000) bounds
the job. Both must be positive integers. `--prompt-optimized FILE` supplies a
UTF-8 system prompt for the prompt-optimized baseline arm only.

`--serving` is the loopback vLLM origin; this CLI has no remote-serving opt-in.
The named model key is used for the models probe and serving requests. The
profile pins the base, tokenizer and chat template as in
[SERVING.md](SERVING.md). The model catalog is extended with the base and loaded
sha256-named adapters; the registry gets a profile-backed serving attestor.
`--signing-key-id` selects an authority authorizing the owner and the fixed
evaluator id `mars-serving-evaluator`. The strict trust schema and UTF-8 secret
environment-variable semantics are in [SPECIALISTS.md](SPECIALISTS.md).

`--expectations` is strict JSON with one entry for **every** held-out split task
and a matching `split_id`:

```json
{
  "schema": "mars.held-out-expectations/v1",
  "split_id": "my-heldout-split",
  "tasks": {
    "heldout-task-1": {
      "must_include": ["expected answer"],
      "must_not_include": ["forbidden answer"]
    }
  }
}
```

Both arrays are optional. Grade is 1 exactly when all includes are present and
all excludes absent (case-sensitive substring matching), otherwise 0. An empty
rule passes every response, so it is not a meaningful quality test. Invalid or
incomplete files refuse `expectations_invalid`; invalid trust or signing
authorization refuses `trust_invalid` without printing secret values.

`createServingArmEvaluator` uses the existing OpenAI-compatible adapter. Base
and prompt-optimized arms use the profile's base served name; candidate/current
require `target.adapter.sha256`, refusing `adapter_missing` before any request
when it is absent rather than silently evaluating the base. It sends
temperature **0**, bounds each completion by the remaining per-arm token budget
and per-request cap (1024 by default), counts actual requests and reported input
and output tokens, honors cancellation, and rejects missing usage or overspend.
Every request of every arm in a job forwards the same integer `seed` in the
OpenAI-compatible body: `servingSeed(job.seed)` is the seed itself when it is
a decimal safe integer, otherwise `parseInt(sha256(seed)[0..8], 16)`. The
forwarded seed is also an input of each arm's `agent_manifest_sha256`. vLLM
applies it per request on a best-effort basis (batching, kernels and hardware
can still change outputs), so this is not a claim of bit-exact server-side
determinism. `createOpenAICompatibleAdapter` sends `seed` only when the request
sets one, and refuses a negative or non-safe-integer seed before any request.
Without `--prompt-optimized`, the prompt-optimized arm is identical to base.
Self-hosted cost is recorded as **$0**, not a measurement of GPU or host costs.

Before completions, a candidate adapter absent from `/v1/models` refuses
`candidate_not_served`. Held-out leakage is rejected by comparison planning and
surfaced as `evaluation_refused`. Both paths make **zero completions**. Missing
attestation, unloaded adapters or off-pin serving cannot authorize adapter
routing; serve falls back to an eligible baseline (or refuses initial attach).

Artifacts use `<registry>/artifacts/<sha256>` with file mode `0600`, directory
mode `0700`, and SHA-256/byte-length checks on reads. Jobs are stored under
`<registry>/evaluations/specialist-comparisons/`. The registry delegates the job,
waits for completion, re-verifies its signed report, and stores its verdict on
the revision (`evaluationVerdicts`). Output includes `outcome`, `codes`,
`triples`, `report_sha256`, `simulated: false`, and `model_requests` equal to the
completion count, including the base and prompt-optimized arms. No-improvement
is stored honestly rather than relabeled as improvement.

Offline-verified: authenticated fake vLLM with opt-in fake completions;
improved and no-improvement verdict persistence; candidate-not-served and leakage
with zero completions; invalid trust, expectations and budgets; evaluator
cancellation, malformed responses, missing usage and token overruns; and a CLI
spawn round trip. Real attestor code against fake endpoints and injected fake
attestor paths are offline checks, as are simulated fixture evaluators (zero
model requests). **Blocked/unverified:** GPU host, real pinned vLLM, real model
key, live adapter serving/completions and any resulting quality improvement.

## Edit-format benchmark: MARS harness vs stock Oh My Pi

`packages/evaluation/src/edit-benchmark/` measures whether MARS's harness
improves small models more than stock Oh My Pi (omp), and supplies the
evidence for per-model edit-format selection.

### Pre-registered success bar (written before any live run)

> MARS's best edit format beats `omp-stock` on host-verified solve rate for
> small models with **p < 0.05 on the paired exact two-sided sign test** over
> tasks (a task counts as solved when a strict majority of its repeats
> solved), **and** its cost per verified solve is **not worse** (USD when
> either arm is priced, otherwise total input + output tokens per verified
> solve). Results are published whichever way they go.

The bar is encoded as `PREREGISTERED_BAR` (`mars-vs-omp-stock/v1`) in
`report.ts` and every report carries the verdict (`met`, `significant`,
`cost_not_worse`, summary). Nothing is "proven better than omp" until this
benchmark has run live on real small models; as of this writing it has not.

### Arms (same tasks, model, seed and per-task budget)

- `mars:<format>` for every format in `MARS_EDIT_FORMATS` (`@mars/execution`);
  today only `apply_patch`. A new format plugs in by adding it there and a
  `MarsEditFormatDriver` in `arms.ts` (which tool it binds and how). MARS arms
  run `openRuntimeSession` with only `mars_*` tools (read + write approval, no
  execute), workspace-confined file tools and the given format.
- `omp-stock`: the same model through Oh My Pi's `createAgentSession` with its
  own built-in `read`, `edit`, `write`, `grep` and its default, model-resolved
  edit mode (`edit.mode` default `hashline`, with omp's per-model fallback to
  `replace`; recorded per trial as `edit_mode`). Tools that spawn processes or
  reach the network are excluded so both arms run without commands. The model
  is reached through the same MARS model bridge (budget ledger, seed); tool
  calls are re-emitted with one `toolcall_delta` because omp's streamed `edit`
  consumes argument text.
- Each trial runs in a fresh throwaway copy of the task tree; process-wide
  `fetch` is replaced by a refusing guard for the trial (refusals are counted),
  and only the injected model transport reaches the endpoint. Verification is
  on the host: the copy must equal the expected tree byte for byte.

Per arm the report records solve rate with Wilson 95% interval
(`wilsonInterval` from `@mars/skills`), edit-call failure rate, mean turns
(model requests), input/output tokens, cost and tokens per verified solve with
a seeded task-bootstrap 95% interval, and wall time; plus a paired comparison
(best MARS arm vs `omp-stock`: both/neither/discordant tasks, exact sign test).
The forwarded integer seed per (task, repeat) is `servingSeed` (PR #219) of a
job seed derived like the specialist comparison's; the suite is a
`mars.held-out-split/v1` and `--training-lineage` files are checked with
`findHeldOutLeakage` (refused as `heldout_leakage`).

Outputs under `--out`: `report.json` (`mars.edit-benchmark-report/v1`,
`report_sha256` over canonical JSON, HMAC `attestation` with a signing key),
`report.md`, `trials.jsonl` and raw journals under `transcripts/`.

### Task set

`packages/evaluation/fixtures/edit-benchmark/v1`: ten tasks authored for this
benchmark on 2026-11-14 (not copied from public benchmarks, MARS datasets or
training lineages): multi-site edits (rename across two files, one constant in
JSON + Python), whitespace-sensitive files (tab-indented Python, Makefile
recipes, YAML, Markdown hard breaks), large files (~1.3k and ~800 lines, one
change deep inside) and repeated similar lines (identical guard blocks, Go
`if err != nil`). Each task has `task.json` (instruction, category,
provenance), `before/` and `after/`. Third-party base models' pretraining data
cannot be inspected, so contamination is unlikely but not provable.

### Commands

```sh
# CI / offline: scripted fake models, zero real model calls
bun apps/cli/src/main.ts bench edit-formats --offline --profile small-model --out /tmp/edit-bench

# Live (NOT run in this repository yet): refuses without --live, --model and --max-usd
bun apps/cli/src/main.ts bench edit-formats --live --model ollama/qwen3-coder \
  --max-usd 0 --repeats 3 --out ./edit-bench-qwen3 \
  --signing-key-env MARS_BENCH_KEY --signing-key-id local
```

The model comes from the MARS model registry (`~/.mars/models.json` or
`$MARS_HOME/models.json`: Ollama, OpenRouter free/cheap models, Kimi or any
OpenAI-compatible endpoint). The run is refused up front unless
`trials × --max-usd-per-task` (default `--max-usd / trials`) fits under
`--max-usd`; each trial's ledger enforces its own token/USD/time budget.

Offline profiles (`SCRIPTED_PROFILES`) emit each format deterministically from
the forwarded seed, with failure modes per format: malformed patches and wrong
whitespace (`apply_patch`), wrong whitespace and ambiguous matches
(`replace`), stale anchors (`hashline`). `patch-fluent` and `patch-hostile`
exercise both verdict directions; these reports are `simulated: true`.

### Evidence-based per-model edit-format selection

`selectEditFormat` (`@mars/execution`) takes `mars.edit-format-evidence/v1`
records (from `editFormatEvidenceFromReport` on a verified report) and picks,
for the session's model on this repository, the newest report's format with
the best verified solve rate (ties: lower cost per verified solve in USD, then
tokens). Without such a report, or when no available format solved anything,
it falls back to the static default (`DEFAULT_MARS_EDIT_FORMAT`). Simulated
reports never decide. The workbench (`WorkbenchHostOptions.editFormats`,
`mars serve --edit-format-evidence DIR [--edit-format-repository NAME]
[--edit-format-key-env NAME --edit-format-key-id ID]`) applies it on launch and
resume, passes `editFormat` to the runtime and records an
`operation: "edit_format"` task event with the decision and `report_sha256`,
like routing evidence. Delegated children use the static default.
