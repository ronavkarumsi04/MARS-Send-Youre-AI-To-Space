# Live Edit-Formats Benchmark Evidence (`mars` vs `omp-stock`, OpenRouter `:free`, $0.00)

## Summary

- **Model**: `nvidia/nemotron-3.5-super-vl:free` (`openrouter`, `pricing.free = true`)
- **Total Spend**: **$0.000000** (`--max-usd 0 --max-usd-per-task 0`; strictly free-tier OpenRouter models only)
- **Arms Tested**: `mars:hashline` (confirmatory static default), `mars:apply_patch` (verifying >50 KiB truncation fix), `omp-stock` (Oh My Pi built-in baseline)
- **Key Constraint Observed**: OpenRouter's uncredited free-tier account quota is **50 free model requests per day** (`HTTP 429`, `limit_source: "openrouter_free_tier_daily"`, `X-RateLimit-Limit: 50`, `X-RateLimit-Remaining: 0`, `X-RateLimit-Reset: 1795305600000`). That daily quota was exhausted mid-run during the 32-task stratified v2 benchmark after completing real live inference on all 3 arms of the v1 smoke task plus the first 2 v2 tasks (`click-rename-1` and `click-indent-1`).
- **Sealed Machine-Readable Report**: `documentation/evidence/live-edit-formats-benchmark.json`

---

## 1. Live Run A — v1 Smoke (`makefile-race-flag`, 1 task × 3 arms = 3 trials)

- **Suite**: `mars-edit-heldout-v1@1` (`makefile-race-flag`, sha256 `c60e5fe8a99b7fbe3417c12be757800ffd0a57546c047453478542a1a7360382`)
- **Report SHA-256**: `0b53a764db03ad8755c6d45de4eb60c285588392a6fc106fab88a97175634273`
- **Repeats / Seed**: 1 repeat, job seed `9f6ef36790e1c6dacfebb95b311f1bb56b4ba6fecd93b430583ede1d9136911f`, serving seed `3808783544`
- **Budget per task**: `1,000,000` tokens, `$0`, `300,000` ms
- **Total Model Requests (Turns)**: `13` (`5 + 4 + 4`), **Cost**: `$0.000000`

| Arm | Edit mode | Verified Solves | Edit Calls (Failures) | Turns | Input / Output Tokens | Wall Time | Cost |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `mars:hashline` | `hashline` | **1/1 (100%)** | 2 (1) | 5 | 8,010 / 1,012 | 8.18 s | $0.000000 |
| `mars:apply_patch` | `apply_patch` | **1/1 (100%)** | 1 (0) | 4 | 5,504 / 351 | 3.50 s | $0.000000 |
| `omp-stock` | `hashline` | **1/1 (100%)** | 2 (1) | 4 | 15,185 / 311 | 3.35 s | $0.000000 |

All three arms solved `makefile-race-flag` cleanly on the live endpoint; `mars:apply_patch` solved on the first edit call with zero edit failures and ~64% fewer input tokens than `omp-stock`.

---

## 2. Live Run B — v2 Stratified Subset (32 tasks × 3 arms = 96 trials)

- **Suite**: `mars-edit-heldout-v2@2` stratified across all 8 pinned repositories (`click`, `cobra`, `express`, `ky`, `requests`, `sds`, `toml`, `walkdir`) × all 4 categories (`rename-1`, `indent-1`, `large-1`, `repeat-1`), including both >50 KiB fixtures (`cobra-large-1`, `ky-large-1`); subset sha256 `5a46ef8cc3b6d1df…`
- **Report SHA-256**: `7d42f8930d4d548704e6c1d867784a22ab79d97ecd71b95023a3e65a5000d7fa`
- **Repeats / Seed**: 1 repeat, job seed `347f33e222773930…`, serving seed `2265257368`
- **Budget per task**: `1,000,000` tokens, `$0`, `120,000` ms
- **Total Model Requests (Turns Recorded)**: `119` (`37` `mars:hashline`, `44` `mars:apply_patch`, `38` `omp-stock`), **Cost**: `$0.000000`
- **Verdict**: **EXPLORATORY (no verdict)** — 32 tasks is below the pre-registered power-analysis minimum of 129, and 90 of 96 trials failed with `provider_error` after OpenRouter's 50 req/day free-tier account cap was reached.

### Aggregate Arm Table (All 96 Trials)

| Arm | Edit mode | Verified Solves | Edit Calls (Failures) | Mean Turns | Total In / Out Tokens | Wall Time | Cost |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `mars:hashline` | `hashline` | 1/32 (3.1%) | 2 (1) | 1.2 | 21,595 / 4,758 | 497.1 s | $0.000000 |
| `mars:apply_patch` | `apply_patch` | 1/32 (3.1%) | 4 (4) | 1.4 | 38,102 / 9,608 | 549.6 s | $0.000000 |
| `omp-stock` | `hashline` | 1/32 (3.1%) | 2 (1) | 1.2 | 36,486 / 1,117 | 485.4 s | $0.000000 |

### Real-Model Trials Executed Before OpenRouter 50 req/day Quota Exhaustion

| Task | Arm | Status | Failure | Verified Solved | Edit Calls (Failures) | Turns | In / Out Tokens | Wall Time |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `click-rename-1` | `mars:hashline` | `completed` | — | **No** | 0 (0) | 2 | 12,561 / 4,198 | 28.96 s |
| `click-rename-1` | `mars:apply_patch` | `completed` | — | **No** | 0 (0) | 2 | 7,822 / 3,280 | 22.95 s |
| `click-rename-1` | `omp-stock` | `completed` | — | **Yes** | 2 (1) | 7 | 36,486 / 1,117 | 8.39 s |
| `click-indent-1` | `mars:hashline` | `completed` | — | **Yes** | 2 (1) | 5 | 9,034 / 560 | 5.75 s |
| `click-indent-1` | `mars:apply_patch` | `failed` | `provider_error` | **Yes** | 4 (4) | 12 | 30,280 / 6,328 | 64.55 s |
| `click-indent-1` | `omp-stock` | `failed` | `provider_error` | **No** | 0 (0) | 1 | 0 / 0 | 15.34 s |

**Honest Wins & Losses (Non-Rate-Limited Trials)**:
- **`click-rename-1` (loss for MARS, win for `omp-stock`)**: `omp-stock` solved (`7` turns, `36,486` input tokens). Both `mars:hashline` and `mars:apply_patch` stopped after 2 turns without issuing an edit call.
- **`click-indent-1` (win for `mars:hashline`, partial win for `mars:apply_patch`, rate-limited on `omp-stock`)**: `mars:hashline` solved cleanly in `5` turns (`9,034` input tokens). `mars:apply_patch` hit 4 patch failures, then wrote the exact target file (passing byte-for-byte host verification) before the OpenRouter daily 50-request quota hit on turn 12; `omp-stock` then hit the exhausted daily quota on turn 1.
- **Remaining 30 v2 tasks (including `cobra-large-1` and `ky-large-1`)**: All 90 trials returned HTTP 429 `openrouter_free_tier_daily` (`X-RateLimit-Limit: 50`, `X-RateLimit-Remaining: 0`) on turn 1.

---

## 3. Offline >50 KiB Regression Validation (Simulated Oracle, 6 tasks × 4 arms = 24 trials)

Because the daily 50-request free-tier quota was exhausted before `cobra-large-1` (60 KiB) and `ky-large-1` (53 KiB) ran live, all 6 v2 tasks containing files over 50 KiB (`cobra-indent-4`, `cobra-large-1`, `cobra-large-4`, `ky-indent-3`, `ky-large-1`, `ky-large-4`) were additionally verified offline with `--offline --profile oracle` after fixing the Oh My Pi >50 KiB middle-elision bug:

- **Report SHA-256**: `e57daa1e5bc793b311966d6874fd2cff21a70886121a19f61d2a805c74068a74`
- **Result**: **24/24 solved (100%)** across `mars:hashline` (6/6), `mars:replace` (6/6), `mars:apply_patch` (6/6, 0 edit failures), and `omp-stock` (6/6).

---

## 4. Harness & Tooling Fixes Verified

1. **`mars:apply_patch` & `mars_read` >50 KiB Oh My Pi middle-elision fix (`packages/execution/src/runtime.ts`)**:
   - Marked `mars_apply_patch` and unranged non-hashline `mars_read` results with `details: { meta: { pagedSource: true } }` so Oh My Pi's `output-meta` spill path does not middle-elide >50 KiB outputs into unreadable `artifact://` references.
   - Updated `readRows` oversized-row recovery hint to name `mars_apply_patch` when running in `apply_patch` mode.
2. **Transient HTTP 429/5xx retry with daily-quota fail-fast (`packages/evaluation/src/edit-benchmark/arms.ts`)**:
   - Retries transient HTTP `429`/`502`/`503`/`504` responses (up to 4 retries, honoring `Retry-After`, abort signal, and per-task duration budget) without double-counting `turns`.
   - Fails fast without retrying when `x-ratelimit-remaining: 0` and `x-ratelimit-reset` is more than `30 s` away (e.g., OpenRouter's 50 req/day daily quota), avoiding wasted retry backoff across remaining trials.

---

## 5. Reproduction Commands

```sh
# 1. Run focused regression tests (truncation fix + harness retries)
bun test packages/codex-tools/src/apply-patch/apply-patch.test.ts \
  packages/execution/src/runtime.test.ts \
  packages/evaluation/src/edit-benchmark.test.ts

# 2. Run live $0.00 OpenRouter free-tier benchmark (requires OPENROUTER_API_KEY)
bun apps/cli/src/main.ts bench edit-formats --live \
  --model nvidia/nemotron-3.5-super-vl:free \
  --max-usd 0 \
  --max-usd-per-task 0 \
  --repeats 1 \
  --suite /path/to/suite \
  --arms mars:hashline,mars:apply_patch,omp-stock \
  --out /tmp/live-out
```
