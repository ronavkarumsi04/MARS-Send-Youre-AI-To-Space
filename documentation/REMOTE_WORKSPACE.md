# Remote workspace provider (Milestone 5a)

`@mars/workspaces-remote` runs a task's workspace operations — shell, files and
task artifacts — on an **OpenHands Agent Server**, behind the same
`LocalWorkspaceProvider` contract that `@mars/workspaces` implements locally.
Planning, model calls, task state, verification verdicts and export decisions
stay in the MARS host. Only workspace bytes and command execution go remote.

```
mars serve --workspace-provider remote --agent-server https://agent.example:8000 \
  [--agent-server-key-env MARS_AGENT_SERVER_API_KEY] [--agent-server-root /workspace/mars] \
  [--agent-server-allow-insecure-http]
mars doctor --agent-server https://agent.example:8000   # one GET /server_info, no command
```

## Pinned upstream

- Repository: `OpenHands/software-agent-sdk`, revision
  `c048a1eb82353b0586f3ce600708394a68ebb246` (the existing `openhands-workspace`
  entry in `sources/manifest.json` / `documentation/SOURCE_REGISTER.md`;
  Agent Server version `1.59.0`). No upstream code is copied; MARS speaks the
  HTTP API only, so no new NOTICE is needed.
- Routes used (read from `openhands-agent-server/openhands/agent_server/` at the
  pin: `server_details_router.py`, `bash_router.py`, `file_router.py`,
  `models.py`, `dependencies.py`):

| Operation | Route | Retried? |
| --- | --- | --- |
| Identity/version | `GET /server_info` (title `OpenHands Agent Server`, `version`, `build_git_sha`, `conversation_runtime`) | yes (idempotent read) |
| Start command | `POST /api/bash/start_bash_command` `{command, cwd, timeout}` → `BashCommand{id}` | **never** (non-idempotent) |
| Read output | `GET /api/bash/bash_events/search?kind__eq=BashOutput&command_id__eq=…&order__gt=…` → `BashOutput{order, exit_code, stdout, stderr}` pages | yes |
| Stop command | `POST /api/bash/bash_commands/{id}/stop` | yes (stopping twice is harmless) |
| Upload | `POST /api/file/upload?path=<abs>` multipart `file` | yes (same bytes to the same path converge) |
| Download | `GET /api/file/download?path=<abs>` | yes |

Authentication is the `X-Session-API-Key` header. The key is read from the
environment variable named by `--agent-server-key-env` (default
`MARS_AGENT_SERVER_API_KEY`), held in memory only, never written to state,
connection files, events, artifacts, doctor output or error messages (errors
are scrubbed of the key value). URLs with embedded credentials are refused.
Plain `http://` is refused for non-loopback hosts unless
`--agent-server-allow-insecure-http` is given, and then reported as
`transport: http-insecure`.

## Design

- **MARS owns the state machine.** A durable SQLite store
  (`<state>/remote-workspaces/remote-workspaces.sqlite`, WAL, `synchronous=FULL`,
  single-process lease) holds each workspace's identity, owner/project scope,
  revision (`<counter>.<tree-digest>`, same format as local), the current
  hash manifest, skipped entries, checkpoint lineage and the restore journal.
  The Agent Server holds bytes under `<remoteRoot>/ws/<workspace_id>/tree` and
  runs commands; it is never trusted to report state.
- **Every remote tree is verified.** After each mutation the provider scans the
  remote tree (`find -printf` + `sha256sum`, run through the bash route),
  parses it client-side with the local path policy (secrets, ignored dirs,
  symlinks, special files, unsupported names, limits), and computes the same
  tree digest as the local provider. Changed files are downloaded and checked
  against their SHA-256 and byte length before the manifest is accepted.
  Operations other than `execute` refuse a tree whose digest no longer matches
  the stored revision (`workspace_modified`).
- **Local mirror.** The workbench runtime and repository map need a local
  `cwd`, so the provider keeps a derived mirror rebuilt only from hash-verified
  remote bytes. It is a cache, never a source of truth; if it is missing (e.g.
  a crash between the staging renames) it is rebuilt on the next operation.
- **The remote root is created at startup** by uploading
  `<remoteRoot>/.mars-remote-root` (upload creates parents), because the bash
  route requires an existing `cwd`.
- **Path confinement is re-checked client-side.** Upstream file routes accept
  any absolute path, so every remote path is built from a relative path that
  passed `validateRelativePath`, then checked by `assertRemotePath` (absolute,
  normalized, no `..`/`.`/empty segments, no control characters) and by prefix
  under the workspace root. Symlinks discovered remotely (and anything below
  them) are refused for read/write/remove.
- **Execution.** argv is shell-quoted into one command, started with `cwd` at
  the remote root, polled by `order`, and bounded per stream to the provider's
  `maxOutputBytes` (output beyond that is dropped and marked truncated, and the
  per-response body limit bounds each page). Timeouts and cancellation send the
  stop route and map to exit codes 124/130, exactly as locally. A start whose
  HTTP response is lost is not retried: the command may already be running, so
  the call fails `sandbox_unavailable` and the tree is reconciled from what
  actually happened. If polling fails, the stop route is sent before the tree
  is reconciled. Output pages are read with a fixed `order__gt` filter, so no
  event is skipped. A durable `execute` journal entry (with the command id
  once known) is written before the start; if the host dies mid-command, the
  next operation sends stop for that id and adopts the scanned remote tree as
  a new revision instead of stranding the workspace.
- **Failed writes/removes** that may have changed remote bytes (e.g. upload
  succeeded, `chmod` failed) adopt the scanned remote tree as a new revision
  before the error is returned, so the workspace stays usable.
- **Checkpoints** are content-addressed artifacts of the full manifest plus
  every file's bytes (hash-checked on load). **Restore** is revision fenced,
  writes a durable journal first, applies uploads/removals, verifies the
  resulting digest and is rolled forward on the next operation if interrupted.
- **Host-owned checks** (`runCheck`) copy the exact candidate to
  `<remoteRoot>/checks/<token>`, apply the host's protected overlay and
  exclusions, run argv there, then verify the candidate's digest is unchanged
  (`integrity` error otherwise) and delete the copy.
- **Diff/export** are computed host-side from the verified manifest against the
  baseline checkpoint using the same `createWorkspaceDiff`, and `exportPatch`
  round-trips the patch with `git apply` onto a baseline copy and compares
  hashes, so the exported bytes are those of the exact tested revision.

## Isolation actually established

> A remote Agent Server interface is not an OS isolation guarantee. Commands
> run with the privileges of the Agent Server process on its host; MARS
> confines paths client-side and verifies every tree by hash, but cannot stop a
> command from reaching outside its workspace on that host.

The provider therefore reports `os_isolation: "none"`; the server's own
`conversation_runtime` (`local`/`docker`) is shown as
`untrusted_server_runtime`, never as a MARS guarantee. This report appears in
`mars serve` startup output (`workspace_provider`) and in `mars doctor`
(`remote_workspace`). A host check that writes into the candidate through an
absolute path is detected after the fact by digest, not prevented. Operators
who need OS isolation must run the Agent Server itself inside a sandbox they
control (container/VM with no access to secrets).

## Evidence (offline, FAKE server)

All tests run against `startFakeAgentServer` — a **fake** that re-implements
only the pinned routes, fields and status codes listed above with local `sh`
subprocesses. It is not the upstream server.

- `packages/workspaces-remote/tests/conformance.ts` — one contract suite (13
  tests) run by `conformance-local.test.ts` (local provider) and
  `conformance-remote.test.ts` (remote provider): prepare/discover/scope,
  secret and path policy, write/remove/diff, size limits, execute and quoting,
  bounded output, timeout 124 / cancel 130 / stop, revision-fenced
  checkpoint/restore, host checks on a disposable copy, exact export +
  collect, out-of-band tamper detection, symlink refusal, fail-closed after
  close.
- `packages/workspaces-remote/tests/remote.test.ts` — unknown version and
  foreign server fail closed; lost start response is not retried; idempotent
  reads retried on 5xx; key never in errors; transport policy; client-side path
  confinement; corrupted downloads rejected by hash; bounded response bodies;
  host check escaping into the candidate rejected; interrupted restore rolled
  forward from the journal; store lease; isolation report.
- `packages/workspaces-remote/tests/config.test.ts` — flag/env resolution and
  doctor output (no key printed, unknown version reported).
- `packages/workbench/src/remote-service.test.ts` — the real workbench host and
  SDK runtime (injected model responses) run a task whose write, execute and
  host check all go through the fake server over HTTP; verified exact export,
  checkpoint/restore, cancel with the stop route and no extra model request,
  and service startup refusing an unknown server version.

## Not verified / limitations

- **Live acceptance is BLOCKED**: no real Agent Server is available. The run
  that would close it is in `HANDOFF.md`.
- The scan requires GNU `find` (`-printf`) and `sha256sum` on the server
  (present in the upstream Debian-based images; not verified live).
- Only Agent Server `1.59.0` is accepted; any other version fails closed until
  its wire protocol is re-audited and added to `PINNED_AGENT_SERVER.versions`.
- Each mutation costs a full remote tree scan; very large trees are bounded by
  the workspace limits rather than optimized.
- No OS isolation (see above). The isolated harness-candidate comparison and
  lineage/rollback archive of Milestone 5 are a separate piece of work.
