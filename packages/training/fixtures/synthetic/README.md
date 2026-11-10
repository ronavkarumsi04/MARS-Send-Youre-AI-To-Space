# SYNTHETIC FIXTURE — not training data

`train.jsonl` (9 examples) and `validation.jsonl` (3 examples) are hand-written
TRL conversational examples used only to exercise the `@mars/training` plumbing
(manifest validation, dataset hashing, leakage checks, the worker protocol and
the opt-in tiny CPU run). Every system message starts with `SYNTHETIC FIXTURE`.
They are not produced by the dataset builder, carry no real task data, and a
model trained on them is not a useful specialist. `manifest.json` pins them by
sha256 and is marked `provenance.synthetic_fixture: true`.
