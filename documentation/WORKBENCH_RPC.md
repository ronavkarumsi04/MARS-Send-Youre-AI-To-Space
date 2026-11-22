# Local workbench RPC transport

## Task workspace file reads

`tasks.file {task_id, path}` returns `{path, data_base64, media_type, size,
sha256}` inside the standard `{result}` envelope. `path` is relative to the
task's existing private workspace, never the source checkout or a host root;
`size` is the decoded byte length and `sha256` is the content SHA-256.
The local provider returns `application/octet-stream` (no MIME sniffing).
Empty files return empty base64 and size zero. The method uses the same bearer
authentication, context scope and task access checks as `tasks.diff`, plus
provider read validation: no absolute/traversal, secret, ignored or symlink
paths, and provider file-size limits. Raw bytes and response metadata are
checked for host-private roots; matching content is rejected, not redacted.
Base64 plus envelope must fit the 4 MiB response limit, otherwise `too_large`;
there is no paging or truncation. Hosts without this optional operation return
`unavailable`. There is no directory-tree/list RPC.

`@mars/workbench` provides `serveWorkbench({ api, token, port? })`. `api` implements the exported `WorkbenchOperations` interface. This package is the HTTP boundary, **not** a task runner: it does not open a database, create workspaces, approve integrations, or start a second agent loop. The durable-task/workspace/Oh My Pi host adapter and CLI startup remain separate integration work.

The server binds only `127.0.0.1` (default port 7331, `0` selects an ephemeral port). Supply a cryptographically random, URL-safe bearer token of 32–256 characters from host-owned state, outside any agent workspace. Length validation does not establish entropy. Never put the token in a workspace file, query string, or log. There is no unauthenticated health route.

Only `POST /v1/rpc` with `Content-Type: application/json` and `Authorization: Bearer <token>` is accepted. Browser-origin requests, non-loopback Host headers, query strings, redirects, and other routes are not supported. Requests are limited to 512 KiB and responses to 4 MiB; there is no chunked artifact API yet. Errors use fixed messages rather than propagating provider, filesystem, or validation details. Responses use `Cache-Control: no-store` and do not enable CORS.

The frozen VS Code wire methods are:

`tasks.events` returns the earliest ordered prefix after `after_event_id`, capped at 1,000 events and the 4 MiB serialized response limit (including UTF-8 metadata and the result envelope). Continue from the last returned `event_id` until an empty batch. Injected operations must preserve ordering and should page their storage reads too; the transport also bounds callbacks that return an entire backlog. An individual oversized event fails with 413, never silently skipped. Other oversized results still fail with 413.

```text
workbench.describe
tasks.create / tasks.list / tasks.inspect
tasks.start / tasks.resume / tasks.steer / tasks.cancel
tasks.events / tasks.artifact / tasks.diff
tasks.checkpoint / tasks.restore
tasks.verification
tasks.evidence                      (additive, Team Chat PR 6)
tasks.journal                       (additive, UI §8.3)
memory.proposals.list / .accept / .reject / .revert   (additive, Milestone 2)
```

### Additive changes to the frozen protocol

#### Milestone 2 memory proposal methods

New methods only; no existing request or result changed. Each takes the strict host-bound `context` and returns the stored proposal (`MemoryProposalViewSchema`: `proposal_id`, `scope`, `source`, `operations`, `rationale`, `expected_revision`, `status: pending|accepted|rejected|reverted`, optional `task_id`, `reason`, `submitted_at`, `resolved_at`, `resolved_by`, `applied_revision`, `reverted_at`, `reverted_by`, `reverted_revision`, `revert_reason`).

- `memory.proposals.list {status?, task_id?}` returns the scope's proposals; the transport rejects results outside the scope or the requested filter.
- `memory.proposals.accept {proposal_id, resolved_by?}` applies a pending proposal through the normal memory batch writer (revision fence unchanged).
- `memory.proposals.reject {proposal_id, reason, resolved_by?}` closes it without writing memory.
- `memory.proposals.revert {proposal_id, expected_revision, reason?, resolved_by?}` restores every entry an accepted proposal touched to its pre-accept revision (entries it added are tombstoned) in one new memory revision. It fails `conflict` if the scope's memory revision is not `expected_revision` or if any touched entry changed or was erased since acceptance; unrelated writes are fine once the caller re-reads the revision.

`resolved_by` defaults to the requesting scope owner. The transport checks that the returned proposal has the requested id and the status the method implies. A host without a memory owner answers `unavailable`. Background review still only submits pending proposals; nothing here runs automatically.

#### UI §8.3 read-only additions

`workbench.describe` optionally includes `connectors: []`, `image: {digest} | null` (SHA-256 only), `conventions: {instructions, hooks, commands}` counts, `policy: {allow_paid, allow_screen_capture}`, `graph`, `vault: {pending_proposals, last_export_at} | null`, and `providers: [{id, kind, health, catalog_stale, policy_owner: "mars"}]`. Provider kinds are `local`, `omniroute`, `direct`; health is `unknown`, `available`, `unavailable`, from configuration availability and cached startup discovery only, never a describe-time probe. Unknown health is not a successful live check. Vault status uses an optional host-configured existing vault; absent configuration returns null. Screen capture remains disabled. Graph is null without an unambiguous workspace binding (the current service has none); clients render per-task state from existing `graph.build`/`graph.query` event cards, not an inspect graph field or a latest-task heuristic.

`tasks.inspect` optionally includes `model_tier: free | paid | local | null` (null before launch), `usage_totals: {input_tokens, output_tokens, cost_usd}`, `pinned: [{path, bytes, trust: "untrusted"}]` for frozen instruction files with recorded byte metadata, and `context_rows: [{tokens, cost_usd, source, remedy}]`. Usage is cumulative durable event accounting, not live context occupancy. Unknown costs and per-source token counts are null; no second estimator is introduced. Older launches without file byte metadata have no pinned records. Existing VS Code behavior ignores these fields.

`tasks.journal {task_id, entry_ids}` accepts at most 100 opaque IDs (256 characters each), never a path. It returns `[{entry_id, kind, text, usage?}]` from only the task's host-bound Oh My Pi session, with the same scope/ownership checks as events. Unknown, foreign, and non-display metadata IDs return `{entry_id, kind: "not_found", text: ""}`. Duplicate requested IDs are resolved once. Kinds are `user`, `assistant`, `reasoning`, `tool_result`, `compaction`, `not_found`; an assistant entry with both thinking and text yields two rows sharing its ID, with usage on the first only. All text remains untrusted data. Reads never call a model or rewrite the journal. Journals are scanned in 64 KiB chunks up to their initial file size, retaining only requested records; total journal size is not capped. Individual JSONL records and the aggregate retained records are each limited to 32 MiB, text rows to 128 KiB, and the existing 4 MiB response cap applies; oversized records/results fail rather than truncate. Missing journals resolve as not_found; invalid ownership fails closed.

Changelog: UI §8.3 adds the optional describe/inspect projections and the bounded read-only journal method. Evidence is offline fixtures with injected model responses, not live provider/model or real-window verification. The spec's per-source context breakdown is not recorded by the existing runtime; unknown values are explicitly null.

New launches pin model tier and free classification in host-private launch metadata, so historical inspect/journal projections survive model removal or reclassification. Legacy launches fall back to the current registry; if the model is no longer known, their tier and journal cost are null rather than guessed.

The protocol above was frozen with the VS Code client. Changes since then are **additive only** (`tasks.verification` / `required_checks` from the host verification verdict PR, and the Team Chat PR 6 items below); every pre-existing request and result is byte-for-byte unchanged, and both the server (`packages/workbench/src/protocol.ts`) and the client (`apps/vscode/src/protocol.ts`) strict schemas were updated together:

- `tasks.create` accepts an optional `launch_key` (`^[A-Za-z0-9_-]{1,128}$`). `(scope, launch_key)` identifies one stored task: the first call creates it, any later call with the same key and a byte-identical canonical task replays the same `Task` regardless of `request_id`, and the same key with a different task (or a second key for an existing task) fails with `conflict`. The `@mars/tasks` store records the binding in a `launch_keys(scope_key, launch_key, task_id, input_sha256)` table inside the same immediate transaction as the task row, so a lost acknowledgement followed by a retry never yields two tasks. Without `launch_key` the request-id idempotency behaves exactly as before. `MarsClient.create(task, { launchKey })` mirrors it.
- `TaskSchema` (`@mars/contracts`) gained an optional `provenance: { source: "team_chat", conversation_id, message_ids (≤ 50), reference_ids (≤ 16) }` of opaque ids (never bodies). It is stored with the task record and echoed by `tasks.inspect`/`tasks.list`; it is part of the canonical task bytes, so it participates in idempotency and launch-key conflict detection.
- `tasks.diff` results carry an optional `digest`: lowercase hex SHA-256 of the canonical diff (`diffDigest` in `@mars/workbench`): files sorted by `path`, each `patch` LF-normalised (`\r\n` and lone `\r` → `\n`), serialised as `JSON.stringify({ files: [[path, status, patch], …] })`. File order and CRLF do not change the digest; any other byte does. Binary patches carry no bytes, so the workspace provider now writes git's `index <old sha256>..<new sha256>` line (all zeros for a missing side) before `Binary files … differ`; two different binaries at one path therefore never share a patch or a digest. The host always sets `digest`; it is optional on the wire only so results from older servers still validate.
- `tasks.evidence { task_id }` (read-only) returns `{ task_revision, workspace: WorkspaceRef, diff_sha256, verify_records }`. `diff_sha256` is the digest of the current diff. Each record is read from the task's `tool.completed` events with `producer: "@mars/watch"`, `operation: "watch.evidence"` and `kind: "verify"`: `{ event_id, verdict, assurance, verified, contract_id?, contract_digest?, recorded_at, workspace_id, workspace_revision, diff_sha256, stale, binding_error? }`. `binding_error` is present only when the host could not stamp the record when it was written (e.g. the workspace diff threw); it is the error class name, never the message, so a `stale` unbound record says why. `verified` is copied from the stored record, never recomputed; `workspace_id`/`workspace_revision`/`diff_sha256` are the host stamps written when the evidence was recorded, taken from the workspace the verifier actually inspected (`null` when the host could not stamp, e.g. the provider refused the diff); `stale` is true unless all three stamps equal the current `workspace.workspace_id`, `workspace.revision` and `diff_sha256`. A delegated child's verify records are stored on the parent task but stamped with the child's private workspace, so they are always `stale` for the parent tree until the parent itself is re-verified. Records whose payload fails `WatchEvidenceRecordSchema` (including a forged `verified: true` on a non-passing verdict) are omitted, and the transport refuses to serialise any record with `verified: true` and a verdict other than `pass`. The result is filtered with the same host-private byte check as `tasks.artifact`/`tasks.diff`; a workspace modified outside the provider (`workspace_modified`) fails with `conflict`, never with a verified record. At most the last 1,000 verify records are returned. A later chat-side card can pin `(task_revision, workspace.revision, diff_sha256, event_id)` and show the result as stale when the candidate moves.

Except for `workbench.describe`, every request includes a strict `context` with `schema_version: 1`, the exact host-bound owner/project/workspace scope, and a bounded `request_id`. `tasks.create` only accepts a fresh pending task with revision 0, no artifacts, and no specialist revision. Start accepts explicit read/write/execute approvals, an optional model ID and optional `required_checks` (host-run file checks frozen at launch; see `documentation/EXECUTION_WORKBENCH.md`); `tasks.verification` returns the host-owned verdict for the task's current candidate revision (`VerificationViewSchema`); expected revisions protect start, resume, and restore operations. The host adapter must enforce the same scope, resource ownership, revisions, budgets, idempotency, and permissions at the service layer. Metadata approval is not an OS sandbox.

Responses have exactly one `result` key; steering/cancellation return `null`. Failures have one `error` with `code` and a fixed `message`. Task-store revision/transition conflicts become HTTP 409 with `code: "conflict"`, which the existing VS Code client recognizes. The transport validates result schemas, task/event identities and scopes, and duplicate list/cursor entries before serialization. Artifact ownership, bytes/hash verification, workspace identity, and safe diff generation remain mandatory responsibilities of the host adapter; the IDE client independently checks received artifacts and paths.

Tests run a real loopback server with fake operation callbacks. They include the actual VS Code `MarsClient` and `HttpRpcTransport` calling every method, plus authentication, scope, request/result validation, error sanitization, and size-limit checks. These tests do **not** demonstrate live task execution, SDK/workspace wiring, a VS Code Extension Host, or Milestone 1 completion. No model requests or third-party integration loads are made.
