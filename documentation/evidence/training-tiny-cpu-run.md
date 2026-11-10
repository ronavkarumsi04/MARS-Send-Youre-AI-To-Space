# Milestone 6 — tiny CPU SFT run (PLUMBING PROOF, not a useful specialist)

**What this proves:** the `@mars/training` `TrainingService` validated a pinned
`mars.training-manifest/v1`, launched the pinned Python worker under
`setsid` with a wall-clock deadline, ran a genuine TRL `SFTTrainer` + PEFT
LoRA job on CPU, saved `adapter_model.safetensors` + `adapter_config.json`,
reloaded the adapter onto a freshly loaded base, reproduced the trained
logits exactly, generated 8 tokens, stored every output as a hash-addressed
artifact and wrote an HMAC-signed `mars.specialist-dataset-lineage/v1` record.

**What this does not prove:** anything about quality. The base is
`trl-internal-testing/tiny-Qwen2ForCausalLM-2.5` (2,440,232 parameters,
hidden size 8, random-init test weights); the data is the 9 + 3 example
SYNTHETIC fixture in `packages/training/fixtures/synthetic/`. Loss stayed at
~11.93 (≈ ln(vocab)); the generated text is noise
(`Sugar𝔅(mysqli.Nullable(mysqli(…`). No held-out agent-level evaluation was
run: no model API key is configured on this VM, so that acceptance item stays
**BLOCKED**. The lineage was signed with an ephemeral per-run key
(`live-ephemeral`), not a production authority.

## Environment

- VM: 8 vCPU, 31 GiB RAM, no GPU (`cuda_available: false`, `bitsandbytes: null`)
- Worker venv: Python 3.12.16, torch 2.15.0+cpu, transformers 5.22.1, trl 1.17.1,
  peft 0.21.2, datasets 5.1.0, accelerate 1.15.0 (`packages/training/python/requirements.lock`)
- Model snapshot fetched once beforehand (provisioning, not part of the run):
  `.venv/bin/python -m mars_training_worker.fetch trl-internal-testing/tiny-Qwen2ForCausalLM-2.5 edca82771e1fad8f0b7ce110ffe770c682043fec`
  The run itself is offline (`HF_HUB_OFFLINE=1`, `local_files_only=True`).

## Command

```
MARS_TRAINING_LIVE=1 MARS_TRAINING_LIVE_ROOT=/tmp/mars-training-live \
  bun test packages/training/src/live.acceptance.test.ts
```

## Output

```
bun test v1.4.4 (38afee6c8)

packages/training/src/live.acceptance.test.ts:
live evidence: /tmp/mars-training-live/live-evidence.json
(pass) LIVE: tiny CPU LoRA SFT saves an adapter that reloads on the base and generates [13090.68ms]

 1 pass
 0 fail
 12 expect() calls
Ran 1 test across 1 file. [13.12s]

real	0m13.122s
user	0m18.124s
sys	0m2.940s
```

## Key results (full record: `training-tiny-cpu-run.json`)

| Field | Value |
| --- | --- |
| validate | `{ ready: true, missing: [] }` |
| estimate | `estimated_usd: null` (local, unmetered); hardware `cpu:8-logical-cores`, `method:lora-fp32`, `token_bound:5896` |
| job status | `completed`, `cost_usd: null`, 7 artifacts |
| steps / train_seconds | 8 / 0.952 s |
| train_loss / eval_loss | 11.9256 / 11.9219 |
| trainable / total params | 3,968 / 2,440,232 (LoRA r=8, all-linear) |
| reload: max \|logit diff\| vs trained | 0 |
| reload: max \|logit diff\| vs base | 0.0535 (adapter changes the base) |
| generated tokens | 8 |
| adapter weights | `8fa8e29f…` (19,320 bytes) |
| adapter_config | `0b23d0cb…` (pins `base_model_name_or_path` + `revision`) |
| chat template | `cd8e9439…` (matches manifest pin) |
| lineage | `eec2c428…`, `provenance.synthetic_fixture: true` |
| dataset_manifest_sha256 | `None` (the fixture manifest pins no `@mars/datasets` manifest) |
