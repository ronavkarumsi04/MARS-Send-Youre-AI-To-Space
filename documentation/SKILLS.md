# Skills and background review (`@mars/skills`, `@mars/review`)

Milestone 3 brings the OpenClaw Skill Workshop lifecycle and the Hermes-style
proposal-only background review into this repository as two packages:
`packages/skills` (the single writer of skill files) and `packages/review`
(the single background reviewer, which can only propose). Both are ports of
the `mars-platform` reference implementation; attribution lives in each
package's `NOTICE` and in [`SOURCE_REGISTER.md`](SOURCE_REGISTER.md).

**Status: implemented and verified offline only.** `bun run check` exercises
the store and the runner with fixtures and an injected fake model gateway; no
review has been run against a live model, no skill has been learned from a
real session, and no real VS Code window has shown a skill. Treat every claim
below as a description of code and offline tests, not of field behaviour.

## What a skill is

A skill is a directory `skills/<name>/` holding one `SKILL.md`. The file must
start with YAML frontmatter whose `name` equals the directory name and whose
`description` is nonempty; the rest of the file is free Markdown read by the
model as untrusted evidence.

```md
---
name: release-notes
description: How this project writes release notes.
---
1. Collect merged PR titles since the last tag.
2. ...
```

- Names match `^[a-z0-9][a-z0-9-]{0,63}$`; `constructor` and `prototype` are
  rejected.
- The store/command frontmatter parser (`packages/skills/src/frontmatter.ts`) is a
  dependency-free **flat subset of YAML**: unindented `key: value` lines, keys
  matching `^[A-Za-z_][A-Za-z0-9_-]{0,63}$` (never `__proto__`), no duplicate
  keys, values either JSON double-quoted, single-quoted, or plain. Plain values
  starting with `& * ! | > { } [ ] % @` or a backtick (anchors, aliases, tags,
  block/folded scalars, flow collections) are rejected, so nested structures,
  multi-line descriptions and billion-laughs constructs cannot be expressed.
- Every piece of content is passed through `scanThreat` from `@mars/memory`
  before it is stored (see "Threat scanning").

## Skills from skills.sh

Run `npx skills add owner/repo` in the project checkout, then restart MARS so
the next session snapshots the installed skills. MARS does not run the installer,
fetch sources, execute bundled scripts, or read global (`-g`) installs.
The CLI's default project symlink mode copies files into
`.agents/skills/<name>/` and links `.claude/skills/<name>` to
`../../.agents/skills/<name>`; Codex reads `.agents/skills` directly. Copy-mode
installs in supported convention folders work too. Existing source precedence
is unchanged; aliases of the same real `SKILL.md` load once, while distinct
copies with the same frontmatter name still appear in `shadowed`.

- **Confinement:** discovery resolves links component by component inside the
  checkout (including symlinked ancestor folders), never outside it. Broken,
  cyclic and escaping links are ignored. Reads use Linux directory-fd traversal
  with `O_NOFOLLOW`, failing closed if `/proc/self/fd` is unavailable; other
  platforms remain unverified, as does the product runtime. No linked code runs.
- **Integrity, not trust:** discovered skills carry `provenance` with the lock's
  `source` (for GitHub, `owner/repo`), `sourceType`, `lockedHash`, locally computed
  `computedHash`, and `status`: `match`, `modified`, `unpinned`, or `unverified`.
  `skills-lock.json` **v2** is read-only, keyed by installed folder name. A hash
  mismatch warns and marks `modified` without blocking discovery. Missing
  entries/empty migrated hashes are `unpinned`; invalid/unsupported locks and
  bounded-hash failures warn and are `unverified`, never a partial match.
  The lock is a local, unauthenticated source claim, not a signature. Neither
  a matching hash nor a lock entry grants tools, changes ranking, or sets the
  lifecycle `pinned` flag.
- **Hash compatibility:** follows the upstream README's v2 algorithm and all
  three published vectors: omit `metadata.json`, `.git`, `__pycache__`, and
  `__pypackages__` directories; dereference only links contained in the skill
  folder, omitting broken/looping/escaping links; normalize CRLF to LF only for
  files without NUL bytes; sort relative `/` paths by UTF-8 bytes; SHA-256 over
  each `path + NUL + decimal byte length + NUL + content`. Verification is
  bounded to 4,096 visited entries, 16 MiB of file content and depth 64 per skill
  (in addition to discovery's existing skill-count/`SKILL.md` byte limits).
- **Import frontmatter decision:** `parseImportedFrontmatter` accepts existing
  flat scalars and folded/literal **description only** (`>`, `>-`, `|`, `|-`),
  with uniformly space-indented lines and paragraph breaks. It ignores opaque
  optional nested keys such as `metadata` and block/flow `allowed-tools` lists;
  these are not permission declarations in MARS. Required fields must be scalar.
  Anchors, aliases, tags, duplicate top-level keys, tab indentation, other block
  scalars, `+`/explicit indentation indicators and more-indented description
  blocks are unsupported; discovery skips them as `frontmatter` with a clear
  warning. No general YAML evaluator or alias expansion is introduced. The
  strict store/command parser is unchanged.
- **Threat scanning:** every imported `SKILL.md`, including ignored metadata,
  passes `scanThreat` before admission, even when its lock hash matches. Blocked
  content is reported as `threat:<pattern>`. Remaining content is still frozen
  as untrusted evidence, not instructions or permission to use tools. Supporting
  files are hashed, not executed or injected into the skill context.

Inspect `mars skills list --source DIR` (or `--json`): repository skills and
their source/hash/status, warnings and skips are shown separately from the
lifecycle store; the store revision does not pretend to cover repository files.

Layout/schema verified against
[`vercel-labs/skills` at b716f9d](https://github.com/vercel-labs/skills/tree/b716f9dc2ba36b6aa8f0080615e5a3a6caeac63b)
(`src/installer.ts`, `src/local-lock.ts`, `src/skill-hash.ts`, and the
[README algorithm/vectors](https://github.com/vercel-labs/skills/blob/b716f9dc2ba36b6aa8f0080615e5a3a6caeac63b/README.md#lock-file-content-hash), MIT).
The synthetic CLI-layout fixture and compatibility tests are offline only;
no live model/provider run has occurred.

## Lifecycle

```
          create / applyDraft / accept(proposal)
 (none) ────────────────────────────────────────▶ active ──recordUse/update──▶ active
                                                    │  ▲
                              curator: ≥14 days idle│  │ update, recordUse, restoreVersion
                                                    ▼  │
                                                  stale
                                                    │
                   curator: ≥30 days idle, or archive│          restore
                                                    ▼  ◀────────────────────── archived
                                                 archived ──────────────────▶ active
```

Statuses are `active`, `stale` and `archived` (`SkillLifecycleStatus`).

- **Draft → accepted.** `saveDraft(name, content, options, rationale)` parks a
  candidate (max 50 drafts) with `baseRevision` = SHA-256 of the current
  content of that skill (or of `null`). `applyDraft(id)` creates or updates the
  skill only if that content is unchanged; otherwise `stale-revision`.
  `viewDraft`, `listDrafts`, `discardDraft` complete the inbox.
- **Proposal → accepted / rejected.** `submitProposal({ source, ops,
  rationale })` dry-runs every operation on a cloned state (so an invalid
  proposal is refused immediately), then stores it `pending` with `targets`:
  a SHA-256 per targeted skill over its content, status, pin and version ids
  (or `null` if it does not exist yet). `accept(id, options)` re-applies the
  operations only while every target still has that digest (`stale-revision`
  otherwise), so curating or editing an unrelated skill never invalidates a
  proposal; proposals stored before `targets` existed keep the whole-store
  `expectedRevision` check. Accepting a `background_review:<session>:<review>`
  proposal journals `<review>` so `undoReview` can revert it. `reject(id,
  reason)` needs a nonempty reason. Pending proposals never touch `SKILL.md`.
- **Active → stale → archived.** `runCurator()` marks an `active` skill
  `stale` after 14 days without activity and archives any non-archived skill
  after 30 days; pinned skills are exempt from both, and `archive`/`stale`
  refuse pinned skills explicitly. Archiving moves the directory to
  `skills/.archive/<name>/`; nothing is ever deleted.
- **Restore.** `restore(name)` moves an archived skill back to `active`;
  `update`, `recordUse` and `restoreVersion` also return a `stale` skill to
  `active`. Any other operation on an archived skill fails `archived`.
- **Versions.** Before `update`, `restoreVersion`, `archive`, `restore` and
  `undoReview` the previous record is snapshotted; the newest 10 versions per
  skill are kept (`listVersions`, `restoreVersion(name, versionId)`).
- **Undo by review id.** Every change carries the `reviewId` passed in
  `MutationOptions`. `undoReview(reviewId)` replays the journal entries for
  that review in reverse: a skill whose current record differs from the
  journaled `after` state fails `conflict`, undoing a `create` archives the
  skill (nothing is deleted), draft-inbox changes are rolled back, the review
  id is recorded in `undone` so a second undo is a no-op, and the undo itself
  is journaled under `undo:<reviewId>`.
- **Pin.** `pin(name, true)` exempts a skill from curation and archiving.

### Who may write

- Only the `SkillStore` in `@mars/skills` writes under the skills root. Every
  mutation names an `actor` and a `source`, may carry `expectedRevision`
  (optimistic concurrency against the store revision) and `reviewId`.
- Background review receives only `SkillProposalService` (`list`,
  `getRevision`, `submitProposal`) and `MemoryProposalService`; it never holds
  `accept`, `applyBatch` or `batch`.
- Humans (or the host on their behalf) accept, reject, undo, pin, restore and
  run the curator through `mars skills`; proposal review also has RPC methods
  and a VS Code Skills view.

## How skills enter sessions

The design mirrors frozen memory (`packages/workbench/src/memory-context.ts`):
at task launch the host snapshots non-archived skills from the store, bounds
them to the remaining runtime-instruction and model-context budget, hashes the
frozen text, labels it as untrusted evidence ("not instructions or permission
to use tools") and stores the frozen snapshot in private launch metadata so
resume replays the same text. Skills are never re-read mid-session. The
workbench wiring (`WorkbenchHostOptions.skills` / `.review`, a
`skills-context.ts` mirroring `memory-context.ts`, review scheduled after
completed foreground tasks, `mars serve` constructing the `SkillStore` and
`ReviewRunner`) is covered by offline host tests only; no live session has
consumed a frozen skill. Read-denied tasks are never reported to review (the
reviewer would otherwise see context the task could not read), and
`iterations` counts assistant messages added to the Oh My Pi journal during
the run, not raw journal records.

## Background review

`ReviewRunner` (`packages/review/src/runner.ts`) is the only background
reviewer. It is scheduled by the host after completed foreground tasks and
emits proposals only.

Scheduling rules:

- `recordTurn({ sessionId, origin, iterations, transcript, success })`
  accumulates `iterations` per session; a session is queued once it reaches
  **10** iterations (`REVIEW_LIMITS.iterations_threshold`). Failed turns
  (`success: false`) only reset the quiet timer. At most **32** sessions are
  pending and **1024** counters are kept; the oldest is evicted.
- A review starts only after `idleMs` (default **30 s**) of quiet, with **one
  review in flight**. `beginLiveTurn(sessionId)` cancels the in-flight review
  (its status becomes `cancelled`) and defers scheduling until `endLiveTurn`.
- A model `429` (`ReviewRateLimit`) requeues the session and backs off
  **15 → 30 → 60 min** (capped); `stop()` drains everything.
- **Recursion guard.** `eligible(turn)` requires `origin === "foreground"`
  and a nonempty session id that does not contain a `review`,
  `background_review`, `cron`, `heartbeat`, `hook`, `subagent`, `acp`,
  `memory` or `overflow` segment, nor `active-memory`, `incognito` or
  `internal:`. The runner never schedules itself and its proposals are
  attributed to `background_review:<sessionId>:<reviewId>`.

Each review:

1. logs `started` with a SHA-256 of the transcript;
2. snapshots memory (`revision`, ≤200 entries) and the skill store revision,
   listing ≤64 non-archived skills truncated to 4000 characters each; the
   whole prompt is capped at 64,000 characters and labelled
   `untrusted_evidence: true`;
3. calls the model once (`max_tokens` 1024, `timeoutMs` default 60 s) and
   rejects replies with tool calls, non-`stop` finish reasons or more than
   64,000 bytes;
4. parses the reply with `parseOutput` (`output.ts`): exactly
   `{"proposals":[...]}`, ≤8 proposals × ≤8 ops, only
   `memory.submitProposal` (`op: "add"`, `target: "memory"` → project scope or
   `"user"` → owner profile scope, ≤2200 characters) and
   `skills.submitProposal` (`create`/`update` only, ≤8000 characters),
   rationale ≤1000 characters, every string threat-scanned, no extra keys;
5. re-checks both revisions before **every** proposal and aborts with
   `Snapshot changed` if either moved; proposals carry `expected_revision` /
   `expectedRevision` so acceptance is fenced again later;
6. logs `proposal` records and a final `completed`, `rejected`
   (schema/threat/store validation failure), `cancelled`, `rate-limited`,
   `error` or `skipped` status.

The audit log is `<logRoot>/review.jsonl` (directory mode 0700, file 0600,
appended under the same directory lock as the skill store): timestamps, actor
`@mars/review`, session and review ids, model id, transcript and output
**hashes**, proposal ids and revisions. It never contains transcripts, prompts
or model text.

Model access goes through `createRegistryReviewGateway({ registry })`, which
calls `selectExecutionModel(registry, model, false)` from `@mars/execution`
and refuses to construct if the selected model is paid, then completes through
the `@mars/providers` `ModelRouter`. There is no OpenAI-compatible endpoint
configuration and no `MARS_REVIEW_*` environment variable in this repository.
Offline tests inject a `ReviewModelGateway` fake; `modelRequests` counts calls.

## Threat scanning

`scanThreat(content)` (`packages/memory/src/threats.ts`, Hermes
`tools/threat_patterns.py` port) runs on every skill body, draft, proposal
operation, review rationale and memory fact. It rejects invisible or
default-ignorable code points both before and after NFKC normalisation
(`INVISIBLE_CODE_POINT_RANGES`: C0 controls except tab/newline/CR, DEL and C1,
soft hyphen, combining grapheme joiner, Arabic letter mark, Hangul fillers,
Khmer inherent vowels, Mongolian selectors, zero-width and bidi controls, line
and paragraph separators, word joiner and invisible operators, bidi isolates,
variation selectors and supplement, BOM, halfwidth Hangul filler, interlinear
annotation, shorthand and musical format controls, tag characters), then
matches prompt-injection, role-hijack, exfiltration, C2, credential-read,
agent/MARS configuration-modification and hardcoded-secret patterns
(`THREAT_PATTERN_IDS`). The scan window is 65,536 code points; longer content
must be bounded by the caller. A hit fails the store operation with code
`threat` (skills) or `invalid_input` (memory). It is a denylist of known
patterns, not a proof of safety.

## Storage layout and recovery

```
<state>/skills/
  skills/<name>/SKILL.md            canonical content of live skills
  skills/.archive/<name>/SKILL.md   archived skills
  .lifecycle.json                   metadata (status, pinned, timestamps, use counts, versions, drafts, proposals, undone), no content
  changes.jsonl                     append-only journal of every change (before/after records, reviewId)
  .skills-transaction.json          pending transaction; present only mid-commit
  .writer.lock/<uuid>.json          cross-process directory lock owner (pid + hostname)
<state>/review/review.jsonl         background-review audit log
```

- Every public method runs under `withDirectoryLock(root)`: an atomic
  `mkdir` of `.writer.lock`, a lock owner file, stale-lock reclaim only when
  the owner pid is dead on the same host, 30 s timeout (`code: "locked"`).
- A commit first writes `.skills-transaction.json` (new state + full journal)
  with write-temp-fsync-rename, then `recover()` applies it: moves directories
  between `skills/` and `skills/.archive/`, rewrites changed `SKILL.md`
  files, writes `.lifecycle.json` and `changes.jsonl`, fsyncs parents and
  removes the transaction file. `recover()` also runs at the start of every
  locked operation, so a crash mid-commit is completed on the next call.
- Paths are resolved inside the root and every component is checked for
  symlinks (`unsafe-path`). A skill directory that exists on disk but not in
  `.lifecycle.json`, or that exists both live and archived, fails `conflict`
  rather than being adopted. Loading re-validates every `SKILL.md`
  (frontmatter, threat scan, name match); a corrupt or missing file fails the
  whole store closed.
- The store revision is the SHA-256 of canonical JSON of skills, versions,
  drafts and undone review ids (pending proposals are excluded), so any
  accepted change invalidates outstanding `expectedRevision`s.

## Limits

| Limit | Value |
| --- | --- |
| Skill name | 1–64 chars, `[a-z0-9-]` |
| Versions per skill | newest 10 |
| Drafts | 50 |
| Curator | stale ≥14 days, archive ≥30 days; pinned exempt |
| Lock wait | 30 s |
| Review trigger | 10 foreground iterations; 30 s quiet; 1 in flight |
| Pending sessions / counters | 32 / 1024 |
| Review prompt | ≤64,000 chars; ≤200 memory entries; ≤64 skills × 4000 chars |
| Review reply | ≤64,000 bytes; max_tokens 1024; 60 s timeout |
| Review output | ≤8 proposals × ≤8 ops; rationale ≤1000; memory op ≤2200; skill op ≤8000 |
| Rate-limit backoff | 15 min → 60 min |
| Memory proposals | 64 pending per scope; 32 operations; rationale ≤2048; reason ≤1024; source ≤128 (`PROPOSAL_LIMITS`) |
| Threat scan window | 65,536 code points |

## Selection and outcome credit

Skills are chosen for a launch, not loaded in name order
(`packages/skills/src/selection.ts`):

- **Relevance:** BM25 over each skill's name, description and body against
  the task request and acceptance criteria, normalized to [0, 1].
- **Helpfulness:** from verified outcomes. A skill's pass rate on tasks that
  loaded it is compared with the pass rate of tasks that did not, using 95%
  Wilson intervals. It is positive only when the lower bound of the skill's
  rate beats the baseline's upper bound, negative only in the reverse case,
  and 0 below 3 loads. Load counts alone never count as helping.
- **Quarantine:** a skill with negative helpfulness, with at least 5 loads and
  5 baseline tasks, is withheld from launches and listed in `quarantined`.
- **Diversity:** maximal marginal relevance (Jaccard over tokens) keeps
  near-duplicates from filling the budget. Stale skills are penalized and
  archived ones never ranked.

The frozen launch record now carries `selection` (name, SHA-256 of the exact
content, relevance, helpfulness, score, and `redundancy`, the overlap penalty
applied when it was picked, so the order is reproducible as
`0.7 * score - 0.3 * redundancy`) and `quarantined`, so each task records why
it saw what it saw. Resume replays the record unchanged.

Every host verdict on a completed task that froze skills (including tasks that
froze none, which form the baseline) is written to `SkillOutcomeLedger`
(`packages/skills/src/outcomes.ts`, `<state>/skill-outcomes/outcomes.sqlite`,
mode 0600). It stores one row per task, so a re-verified task replaces its
verdict rather than counting twice. Outcome credit is advisory: a ledger
failure never changes a task, and ranking falls back to relevance only.

Limits of this evidence: the baseline is every other credited task, not a
matched control, so different task mixes can confound it. A held-out A/B gate
is enforced before applicable proposal acceptance unless explicitly overridden
with a recorded reason. Outcomes are keyed by skill name and count every
content version; `versions` reports how many there were.

## Not implemented or not verified

- **No live-model evidence.** The review runner has only run with an injected
  fake gateway. Whether a free model produces useful, schema-valid proposals
  is unknown.
- **Lexical, not embedding, retrieval.** Selection uses BM25 plus outcome
  evidence; there is no embedding index. The pre-existing `SkillService`
  contract (`discover`/`read`/`propose`/`evaluate`) remains unimplemented;
  `SkillLifecycleService` was added beside it.
- **Curator scheduling is fixed-interval.** `mars serve` runs `runCurator()`
  once at startup and every 6 hours (`SKILL_CURATOR_INTERVAL_MS`); teardown
  waits for an in-flight pass. Hermes' usage-interval/idle rules
  (`should_run_now`) are not ported. `mars skills curate` runs it on demand.
- **Operator surface.** `mars skills <list|show|versions|restore-version|pin|unpin|archive|restore|proposals|gate|gates|trials|report|accept|reject|undo|curate>`
  operates on the same store as `mars serve` (`--state`, `--source`,
  `--project` defaults match it; changes are recorded with `--actor`). Proposal
  review also has RPC methods and a VS Code Skills view; there is no command
  to inspect `review.jsonl`.
- **No live gate trials.** `accept` enforces the held-out gate (below), but
  producing real paired runs needs a live model; until then trials files are
  supplied by hand or the gate is skipped with a recorded reason.
- **Scope.** The skill store is per state directory, unscoped by owner or
  project; memory proposals are scoped and revision-fenced by `@mars/memory`.
- **Not ported from upstream:** OpenClaw's reviewer prompt and `skill_manage`
  tool surface, Hermes `curator_backup`, run reports, and cron-referenced skill
  protection.

## Evidence report

`mars skills report [NAME] [--scope KEY] [--json]` answers, per repository scope
and skill, whether it raised the verified solve rate here and at what cost.
It supports learned and imported skills, even ones never added to the store.
The with/without task split and Wilson 95% intervals are **observational**, not
a matched control, and never decide the verdict. Versions list the distinct
loaded content hashes; difference is the observed with rate minus without rate.

Only held-out baseline/candidate pairs decide the verdict, using `GATE_POLICY`:
at least 10 valid, distinct trials, at most 0 regressions, one-sided sign-test
`p <= 0.05`, and candidate/baseline total spend ratio at most 1.25 establish
`helps`. `hurts` requires at least 10 valid, distinct trials and either a
reverse sign-test `p <= 0.05` or a cost ratio greater than 1.25 without a
significant solve gain (`p > 0.05`). Otherwise the verdict is `no_evidence`,
including insufficient, invalid or duplicate trials. Significant gain alone
does not establish `helps` if the regression or cost gate fails. Reports show
the paired counts, both p-values, cost ratio, gate reasons and policy.
Learning-evidence requirements do not apply to these skill-level reports.

Cost per verified solve is total task spend divided by verified solves. No
verified solves, or any unknown task cost, makes it unknown (`null` in JSON).
The host sums priced usage events; any unpriced event makes that task's spend
unknown. An infinite held-out cost ratio is `null` plus
`cost_ratio_infinite: true` in JSON, and `Infinity` in text.

```sh
mars skills trials NAME --trials pairs.json --scope REPO_KEY
mars skills report NAME --scope REPO_KEY
mars skills report --json
```

`trials` accepts the same `GateTrialsSchema` JSON pairs as `gate`, but needs no
proposal or store entry. Re-recording a task replaces its pair in that scope
and skill. Without `--scope`, it uses the ledger's sole known scope; zero or
multiple scopes require an explicit choice and list the known scopes.

Provenance identifies store skills (`origin: "store"`) or discovered skills
in the resolved `--source` checkout (`origin` such as `.agents/skills`, plus
the relative `path`). Store provenance wins on name collisions. Unknown
provenance is `null`. The API also accepts optional opaque `lock` metadata for
skills.sh lock data; the CLI populates it with discovery's lock claims, content
hashes and integrity status (not a trust grant). Unscoped caller provenance applies across scopes, with scoped
entries taking precedence.

**No live trials exist yet: this feature is offline-verified only.** Operators
must supply actual paired runs before drawing conclusions about a skill.

## Acceptance gate

`evaluateSkillGate(input, options)` (`packages/skills/src/gate.ts`) decides
whether a proposed skill earns acceptance from a held-out A/B run: each trial
is one task run without (`baseline`) and with (`candidate`) the skill. It
passes only when all of these hold:

- the proposal cites the checked runs it was learned from
  (`evidence_task_ids`), and none of them is reused as a held-out trial;
- at least `min_trials` (10) distinct, well-formed trials;
- at most `max_regressions` (0) tasks the baseline passed and the candidate
  failed;
- a one-sided exact sign test over the discordant pairs gives
  `p <= alpha` (0.05), so ties never count as evidence;
- candidate spend is at most `max_cost_ratio` (1.25×) baseline spend.

Every failed condition is listed in `reasons`. The result carries a SHA-256
`digest` of the canonical input and options, so the same trials always produce
the same verdict, and `SkillOutcomeLedger.recordGate` stores each verdict once
per digest (`gates(proposalId)` reads them back).

`harmfulSkillArchivals(skills, stats)` turns quarantined skills into archive
*proposals* with the outcome numbers as rationale. Pinned and archived skills
are skipped, and nothing is deleted; an operator still accepts or rejects.

### Gated acceptance

`acceptWithGate(store, ledger, id, options, override?)`
(`packages/skills/src/gated-accept.ts`) is how operators accept proposals:

- A proposal with a `create` or `update` op (`gateRequired`) is accepted only
  when the newest verdict stored for its id (`decidingGate`; a newer failing
  run supersedes an older pass) passed with thresholds no looser than
  `GATE_POLICY` (`meetsGatePolicy`: `min_trials` ≥ 10,
  `max_regressions` ≤ 0, `alpha` ≤ 0.05, `max_cost_ratio` ≤ 1.25). Verdicts
  record their thresholds in `options`; verdicts stored before that field
  existed do not qualify. Otherwise it fails with `gate-required`.
- `archive`, `restore`, `pin`, `stale` and `restoreVersion`-only proposals
  (including `harmfulSkillArchivals`) need no gate.
- An operator may accept without a passing verdict by giving a reason. The
  override (proposal, actor, reason, time) is written to
  `skill_gate_overrides` before the skill store changes.

CLI:

- `mars skills gate PROPOSAL_ID --trials FILE --evidence ID[,ID...]` checks
  the trials file against `GateTrialsSchema` (a JSON array of `{ task_id,
  baseline: { verified, cost_usd }, candidate: { verified, cost_usd } }`),
  evaluates it under `GATE_POLICY` and stores the verdict.
- `mars skills gates PROPOSAL_ID` lists stored verdicts and overrides, and
  `mars skills proposals` shows each proposal's gate state.
- `mars skills accept PROPOSAL_ID [--without-gate --reason TEXT]`.

The ledger is `<state>/skill-outcomes/outcomes.sqlite`, the one `mars serve`
writes. Held-out runs need a live model to produce real trials.

### VS Code Skills view and RPC

`mars serve` exposes the same operations over workbench RPC
(`packages/workbench/src/skills-operator.ts`), backed by the host's own skill
store and outcome ledger:

- `skills.list`: every skill with status, pin, use count and, once credited,
  its verified-outcome evidence (loads, verified, no-skill baseline,
  helpfulness lower bound, quarantine).
- `skills.proposals.list` (optional `status` filter): proposals with their
  operations, full proposed content, review id and gate state (`required`,
  `cleared`, the `describeGate` summary and the latest verdict).
- `skills.proposals.accept`: goes through `acceptWithGate`. Without a
  policy-strict passing verdict it answers `conflict` unless
  `without_gate_reason` is given, which is recorded with the caller.
- `skills.proposals.reject` (reason required) and `skills.reviews.undo`.

Skill errors map to `not_found`, `invalid_request` or `conflict`; a host
without a skill store answers `unavailable`. The server checks that accept and
reject answers name the requested proposal with the new status.

The VS Code **Skills** view (`mars.skills`) uses the Tasks view's connection.
It shows waiting proposals with their content and gate result, skills with
their evidence, and decided proposals. Accept asks for confirmation when the
gate is cleared and for a recorded reason otherwise; Reject asks for a reason;
accepted review proposals offer Undo review.
