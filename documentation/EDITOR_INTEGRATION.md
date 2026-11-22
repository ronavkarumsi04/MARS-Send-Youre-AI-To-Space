# Editor integration groundwork

Decision owner: Tanay. Editor UI in `apps/shell` is David's upstream work;
this fork provides the workbench side only. No shell changes are included.

## Needs versus Workbench today

| Need | Available | Limits |
| --- | --- | --- |
| Project files | New `tasks.file {task_id, path}` reads one file from the task's private workspace, not the source checkout | Tree listing is missing; task must already have a workspace |
| Files touched | `tasks.diff` → `files[].path/status` | Net baseline-to-current changes, not a historical touched ledger; reverted edits disappear |
| Open diff | `tasks.diff` → per-file `patch`; concatenate patches for a unified diff | No per-file request filter or pagination; binary diffs contain markers/hashes, not contents |

Contracts: `packages/workbench/src/protocol.ts`; HTTP dispatch and the **4 MiB
response limit**: `packages/workbench/src/server.ts`; task access, workspace
resolution and host-private byte rejection: `packages/workbench/src/host.ts`.
Provider path/secret/ignore/symlink/size policy lives in
`packages/workspaces/src/provider.ts` and `paths.ts`; net diff generation is
`packages/workspaces/src/diff.ts`. Base64 overhead counts toward the response
limit; oversized file reads fail, rather than returning truncated bytes.

File content should flow through the existing authorized, whitelisted IPC in
`apps/shell/src/preload/preload.ts`, `main/ipc.ts` and `main/bridge.ts`, then the
main-process loopback transport. David must add `tasks.file` to the shell
whitelist and its params/result mappings; `tasks.diff` is already whitelisted
(`apps/shell/src/shared/methods.ts`). Do not give the renderer the bearer token,
raw filesystem access or a generic RPC escape hatch. Treat file/diff contents
as untrusted text, never executable HTML.

## Remaining gaps

- Tree listing: define task-workspace versus source-project semantics first;
  reuse workspace confinement, secret/ignore filtering and bounded results.
- Historical touched ledger: net diffs cannot reconstruct reverted edits.
- Diff per-file filtering/pagination and file-read paging for large content.
- Optional `tasks.changedFiles` metadata-only response: reduces wire size,
  but wrapping the current diff would still compute every patch.

## Embedding options

| Dimension | Monaco in MARS renderer | Full Code OSS build in Electron |
| --- | --- | --- |
| Size | Renderer-only library; selected languages/workers can be bundled. npm `monaco-editor@0.57.0` reports 101,674,083 bytes unpacked (~97 MiB), **not** a shipped/minified bundle estimate | Complete app typically hundreds of MB (approximate; platform/build dependent) |
| Licensing | MIT | Code OSS source is MIT; Microsoft's VS Code product builds, branding and Marketplace have separate Microsoft terms. Forks must not assume Marketplace access; use Open VSX instead |
| Security/CSP | No extension host, terminal or Node runtime supplied. Keep existing IPC boundary. Bundled same-origin workers require `worker-src 'self'` in shell header and HTML metas, not blanket `blob:` | Ships its own Electron app, Node-capable extension host and CSP. Embedding a full workbench is effectively integrating a second app; its privileges and untrusted agent output conflict with MARS's strict-CSP + authorized-IPC model |
| Integration effort | Small read-only file/diff surface using existing RPCs; add worker assets and lifecycle management | Heavy build/distribution/maintenance; app lifecycle, filesystem, permissions and extension-host boundaries must be redesigned |
| Features | Editor, syntax/languages and diff UI; editing persistence and application features are ours to build later | Full workbench, terminals, extensions, debugging and project navigation, with corresponding privilege and maintenance cost |

Current CSP is in `apps/shell/src/main/security.ts` and both renderer HTML
metas. It has `worker-src 'none'` and `style-src 'self'`. Prefer packaged
same-origin worker files over blob workers. Monaco style handling (whether
nonces cover all injected styles or `style-src 'unsafe-inline'` is required)
is **verify in spike**: Monaco is not installed locally and no renderer/CSP
experiment was run. Do not weaken CSP speculatively. The shell's asset route
also needs explicitly permitted worker assets (`main/security.ts`).

Registry measurement: `npm view monaco-editor dist.unpackedSize version`
(read-only; no dependency added). License/product references:
[Monaco](https://github.com/microsoft/monaco-editor),
[VS Code source](https://github.com/microsoft/vscode),
[VS Code differences and Marketplace](https://code.visualstudio.com/docs/supporting/faq#_what-is-the-difference-between-the-vscode-repository-and-the-microsoft-visual-studio-code-distribution),
[Open VSX](https://open-vsx.org/).

**Recommendation:** Monaco read-only diff/file viewer first; editing later.
Keep shell work upstream with David and add only explicit read capabilities
through the existing bridge. Do not embed a second full IDE for this slice.
