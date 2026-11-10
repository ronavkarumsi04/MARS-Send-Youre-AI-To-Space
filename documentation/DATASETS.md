# Training datasets from verified runs

`@mars/datasets` builds the Milestone 6 supervised fine-tuning dataset. It
reads only host evidence and writes deterministic, hash-pinned files for a
training job; it trains nothing and calls no model.

## What becomes an example

`collectVerifiedExamples(store, context)` reads the durable task store and
keeps a task only when all of these hold:

- the task is `completed`;
- its **newest** `verification.verdict` record from `@mars/workbench` is
  `verified` (a newer failing verdict supersedes an older pass) and carries a
  `patch_sha256`;
- a `patch.exported` artifact exists whose bytes hash to exactly that digest,
  so the example is the exact patch the protected checks ran against, and
  that export recorded a passing round trip (the patch rebuilds the verified
  candidate; exports from before the round trip was recorded do not count).

Agent-produced records, Watch evidence, unexported patches and patches that
differ from the tested bytes are skipped with a stable reason
(`not-completed`, `unverified`, `latest-verdict-not-verified`,
`verdict-not-patch-bound`, `no-exported-tested-patch`,
`export-round-trip-failed`). Each example is one
request → patch pair: the task request as the user turn and the verified
unified diff as the assistant turn, under a fixed system turn whose digest is
in the manifest.

## Leakage and hygiene

`buildDataset({ dataset_id, examples, held_out, private_patterns })`:

- excludes every task listed in a held-out set (gate trials, Terminal-Bench,
  optimisation final holdouts, evolution held-out tasks) by id, and by
  normalized request text so a renamed copy of a held-out task is caught
  (the request texts of held-out tasks present among the examples are held
  out automatically; pass `requests` for held-out tasks MARS never ran);
- re-checks the kept examples for leakage and fails with
  `DatasetError("leakage")` rather than writing a contaminated dataset;
- requires `private_patterns` (the host's state, workspace and home roots)
  and refuses to build without them;
- drops examples whose patch bytes no longer match their digest, that contain
  a secret shape (`secretShapeRegexes`) or a host-private root, that exceed
  `max_example_chars`, or that duplicate another example;
- splits by groups of examples sharing a task id or normalized request (so
  neither appears in both splits) with a seeded hash, so the
  same inputs in any order give byte-identical files and manifest.

## Output

Two JSONL files in TRL conversational format
(`{"messages":[{"role":"system"|"user"|"assistant","content":...}]}` per
line) and a `mars.training-dataset/v1` manifest: per split
`{dataset_id, split, sha256, example_count, task_ids}`, every source
(scope, task, verdict run, patch digest, check manifest digest), the source
scopes, a digest of each held-out set, every exclusion with its reason, and
the split policy. The training job and the specialist lineage record pin the
split digests.

## Limits

Offline-verified only. Examples are request → patch pairs, not full
tool-use trajectories. No verified runs exist yet without a model key, so no
real dataset has been built.
