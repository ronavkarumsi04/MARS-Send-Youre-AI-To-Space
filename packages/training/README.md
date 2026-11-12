# `@mars/training`

Milestone 6 SFT job: implements the `TrainingService` contract
(`validate` / `estimate` / `submit` / `inspect` / `cancel`) from
`@mars/contracts`. One job = one TRL `SFTTrainer` + PEFT LoRA (or QLoRA, CUDA
only) run in a bounded, pinned Python worker. Outputs are hash-addressed
artifacts plus a signed `mars.specialist-dataset-lineage/v1` record that the
`@mars/specialists` registry accepts.

**A completed job is not a specialist.** Every run report carries
`PLUMBING_LIMITATION`; promotion still needs a signed held-out agent-level
evaluation report through the specialists evidence gate, which this package
does not produce.

## Input: `mars.training-manifest/v1`

`TrainingManifestSchema` (`src/schemas.ts`). `@mars/datasets`
(`documentation/DATASETS.md`) produces the JSONL files and a
`mars.training-dataset/v1` manifest; its `splits` entries are copied as-is into
`datasets` (`datasetsFromDatasetManifest`). Optionally pin that manifest with
`dataset_manifest: {dataset_id, sha256}`: preflight then fetches it by digest
and refuses `dataset_manifest_missing` / `_invalid` / `_splits_mismatch`, and the
run report records `dataset_manifest_sha256`.

- `base_model`, `tokenizer`: `{repo, revision}` — revision must be an exact
  40-hex commit (branches/tags refused: `*_revision_not_pinned`).
- `chat_template`: `{repo, revision, path, sha256}` — read from the pinned
  snapshot and refused unless its bytes hash to `sha256`.
- `datasets`: exactly one `train` and one `validation` entry, each
  `{dataset_id, split, sha256, example_count, task_ids}`. Files are JSONL, one
  `{"messages":[{"role":"system"|"user"|"assistant","content":string}]}` per
  line. Bytes are resolved by sha256 (default: the artifact store's
  `getByDigest`, or an injected `resolveDataset`) and refused on any hash,
  UTF-8, format or count mismatch.
- `heldout`: optional `{split_sha256, task_ids}` the training data must not touch.
- `method` (`lora` | `qlora`), `lora`, `sft`, `generation`, `provenance.synthetic_fixture`.

`fixtures/synthetic/` holds a SYNTHETIC 9 + 3 example fixture and a manifest
pinned to the tiny test model; it exists only to exercise plumbing.

## Checks before any compute (`validate` lists all; `submit` refuses on any)

Manifest digest/schema, revision pins, dataset bytes, leakage
(`leakage:train_validation_task_overlap`, `…_identical`, `…_example_overlap`,
`leakage:heldout_task_overlap`, `leakage:heldout_split_reused`), base model /
tokenizer / chat template present in the offline HF cache, worker venv present
and its reported versions equal `TRAINING_PINS` (`worker_pin_mismatch:*`),
QLoRA only with CUDA **and** bitsandbytes (`qlora_requires_cuda`,
`qlora_requires_bitsandbytes`), and `submit` also refuses
`budget_tokens_exceeded` when `trainingTokenBound` (training steps × batch ×
grad_accum × max_length, plus one validation pass and the reload/generation
proof) exceeds `budget.max_tokens`. The registry repeats the leakage check against the
signed evaluation report (`lineage_leakage`).

## Worker boundary

`python -m mars_training_worker` (`python/mars_training_worker/worker.py`),
newline-delimited JSON: host sends one `start`; worker emits `ready`
(installed versions), `progress` (step/loss), then `done` (metrics + reload
proof) or `error`. Library output goes to stderr (bounded tail kept in the job
record). The worker:

- is launched via `setsid` so it leads its own process group; cancel and the
  wall-clock deadline (`min(budget.max_duration_ms, maxDeadlineMs)`) SIGTERM
  the group, then SIGKILL after `killGraceMs`; leftovers in the group are
  reaped when the worker exits. A worker-side watchdog also kills the group if
  the host process dies or the deadline (plus grace) passes;
- gets a minimal environment (no host secrets), `HF_HUB_OFFLINE=1`, and loads
  models with `local_files_only=True` — it never downloads or installs;
- after training, loads a fresh base, attaches the saved adapter, checks the
  logits against the trained model and the base, and generates.

`estimate` returns `estimated_usd: null` (local hardware is unmetered; no
dollar figure is invented) and hardware strings from the worker probe
(`cpu:N-logical-cores` or `cuda:<device>`, the method, the token bound).

## Outputs (`JobResult.artifacts`, in order)

1. `mars.peft-adapter/v1` bundle (JSON) — the ref to register as `adapter`
2. `adapter_model.safetensors`
3. `adapter_config.json` (pins `base_model_name_or_path` + `revision`)
4. `mars.tokenizer-refs/v1` (tokenizer repo@revision, per-file sha256, chat template ref)
5. chat template bytes
6. signed `mars.specialist-dataset-lineage/v1` (`application/json`)
7. `mars.training-run/v1` report: metrics, reload proof, worker versions,
   `config_sha256`, and a `registration` block with the exact `base_model`,
   `tokenizer`, `chat_template`, `adapter`, `dataset_lineage` and
   `adapter_spec` a specialist registration needs to pass the registry's
   compatibility checks.

The lineage signer and `producerId` are injected by the host (never a
hardcoded key); `producerId` must differ from the evaluator id or the
registry reports `evidence_not_independent`.

## Setup

```sh
cd packages/training/python
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python --only-binary :all: \
  --index-strategy unsafe-best-match -r requirements.lock
# provisioning (network): fetch one pinned snapshot into the offline cache
.venv/bin/python -m mars_training_worker.fetch \
  trl-internal-testing/tiny-Qwen2ForCausalLM-2.5 edca82771e1fad8f0b7ce110ffe770c682043fec
```

The cache defaults to `~/.cache/mars-training-hf` (`MARS_TRAINING_HF_CACHE`).

## Tests

- `bun test packages/training` — offline, fake worker (`tests/fake-worker.ts`),
  no torch, no network, no model requests. Includes process-group kill on
  cancel and deadline, and registry acceptance of the produced lineage.
- `python3 -m unittest discover -s packages/training/python/tests` — stdlib-only
  worker protocol and dataset parsing tests (CI).
- `MARS_TRAINING_LIVE=1 bun test packages/training/src/live.acceptance.test.ts`
  — opt-in genuine tiny CPU run; never in CI. Evidence:
  `documentation/evidence/training-tiny-cpu-run.md`.

## Not done / blocked

- Held-out agent-level evaluation comparing an adapter with its base:
  **BLOCKED** on live acceptance (no model API key or real serving host;
  the vLLM-backed evaluation path is implemented and offline-tested — Milestone 7).
- No useful specialist has been trained; the only real run is the plumbing proof.
- QLoRA is implemented but unverified: no CUDA device exists here, and the
  CPU lock does not include bitsandbytes.
- Jobs run in-process; a host restart marks running jobs `failed`/`interrupted`.
