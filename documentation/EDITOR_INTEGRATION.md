# Decision needed: Monaco vs Code OSS

Tanay picks the editor and is the only upstream merger. This fork will build
the editor later; David reviews. This PR is workbench groundwork and docs only:
no editor code and no `apps/shell` changes.

| Dimension | Monaco in the MARS renderer | Full Code OSS build in Electron |
| --- | --- | --- |
| Size | `monaco-editor@0.57.0`: npm unpacked 101,674,083 bytes (~97 MiB); published `min/vs` measured 25,609,317 bytes (~24.4 MiB). A shipped bundle selects a subset; neither figure measures a core-plus-selected-languages production bundle | Approximately hundreds of MB. Concrete reference: VSCodium Linux x64 1.143.17232 full-app tarball is 214,776,735 bytes (~205 MiB compressed), not installed size |
| License | MIT | Code OSS source is MIT; Microsoft product builds, branding and Marketplace have separate Microsoft terms. Marketplace is not available to forks under the source license; use Open VSX instead |
| Security/CSP | Renderer-only library: no extension host, terminal or Node runtime supplied. Preserve authorized IPC; explicitly package same-origin workers and resolve style policy in a spike | Own Electron app, Node-capable extension host and CSP. Embedding it is effectively integrating a second app; privileges conflict with MARS's strict-CSP/authorized-IPC boundary and untrusted agent output |
| Effort | Focused read-only file/diff surface, worker packaging and lifecycle; editing persistence later | Heavy build, distribution and maintenance; lifecycle, filesystem, extension-host and permission boundaries need redesign |
| Features | Editor, syntax/languages and diff UI; application navigation and editing workflow remain ours | Full workbench, terminals, extensions and debugging, with their privilege and maintenance costs |
| Recommendation | **Read-only diff/file viewer first; editing later** | Do not integrate a second full IDE for this initial slice |

## Measurement and decision caveats

Monaco measurements: `npm view monaco-editor dist.unpackedSize version`, then
`npm pack monaco-editor@0.57.0` outside the repo, extraction and `du -sb package/min/vs`.
`min/vs` includes all published minified languages/workers and filesystem directory
overhead; it is not an optimized deployment measurement. A realistic selected-language
bundle remains **verify in spike**. No repo dependencies were installed for this research.

VSCodium reference: read-only `gh release view -R VSCodium/vscodium --json assets`;
[full Linux x64 archive](https://github.com/VSCodium/vscodium/releases/download/1.143.17232/VSCodium-linux-x64-1.143.17232.tar.gz).
This is an example Code OSS distribution, not a promise about our eventual build.
Licensing references: [Monaco](https://github.com/microsoft/monaco-editor),
[Code OSS source](https://github.com/microsoft/vscode),
[Microsoft product/Marketplace FAQ](https://code.visualstudio.com/docs/supporting/faq#_what-is-the-difference-between-the-vscode-repository-and-the-microsoft-visual-studio-code-distribution),
[Open VSX](https://open-vsx.org/).

## Planned editor shape — later, not this PR

- This fork implements; David reviews; Tanay decides Monaco versus Code OSS
  and alone merges upstream.
- Proposed module: `apps/shell/src/editor/` (name is a proposal), with its own
  preload-facing API, IPC channel and explicit method whitelist, separate from
  the chat bridge. No generic RPC proxy or renderer filesystem access.
- No rewrites to shell layout, chat, settings or Extensions without David.
  Get layout touch points from David first: navigation is still changing,
  including the Settings page in the sidebar.
- Cut the implementation branch from upstream `main` **after upstream #245
  merges**, and only after Tanay confirms the #245/#246 bugs are fixed.
  These are future gates, not claims that either issue is resolved.

## Workbench calls for our editor

| Need | Call and response | Limits |
| --- | --- | --- |
| Read a file | `tasks.file {task_id, path}` → `{path, data_base64, media_type, size, sha256}` | Existing task's private workspace, not source checkout; no directory tree |
| Files touched | `tasks.diff {task_id}` → `files[].path/status` | Net baseline-to-current changes, not historical ledger; reverted edits disappear |
| Open a diff | `tasks.diff {task_id}` → `files[].patch`; concatenate for unified patch | No per-file request filter or pagination; binary changes are markers/hashes |

Contracts: `packages/workbench/src/protocol.ts`; dispatch and the **4 MiB
response limit**: `packages/workbench/src/server.ts`; authorization, task-workspace
resolution and host-private byte rejection: `packages/workbench/src/host.ts`.
Provider read policy: `packages/workspaces/src/provider.ts` and `paths.ts`;
net diff generation: `packages/workspaces/src/diff.ts`. Base64 overhead counts
toward the limit; oversized reads fail rather than silently truncate.

The editor's own IPC surface needs whitelisted `tasks.file` and `tasks.diff`
params/results, trusted-sender checks, schema validation, task/scope binding,
bounded responses and clear errors. Keep bearer credentials in the main process.
Reuse the security patterns in `apps/shell/src/preload/preload.ts`, `main/ipc.ts`,
`main/bridge.ts` and `main/transport.ts`, not the chat channel itself. The existing
chat/shared whitelist already includes `tasks.diff`; that does not authorize the
new editor channel. Render file/diff bytes as untrusted text, never executable HTML.

### CSP work for a Monaco spike

Current policy in `apps/shell/src/main/security.ts` and both
`apps/shell/src/renderer/{index,settings}.html` metas has `worker-src 'none'`
and `style-src 'self'`. Plan coordinated header/meta updates for bundled
same-origin workers (`worker-src 'self'`, preferably not `blob:`), plus explicit
worker asset routes. Style handling—whether nonces cover injected styles or
`style-src 'unsafe-inline'` is necessary—is **verify in spike**; no renderer/CSP
experiment has been run. Do not weaken policy speculatively. Full Code OSS would
bring its own CSP and privilege model rather than solve this boundary for us.

### Remaining gaps

- Tree listing: choose task-workspace versus source-project semantics, then
  add bounded results with workspace confinement and secret/ignore filtering.
- Historical touched ledger: cannot reconstruct reverted edits from net diffs.
- Diff per-file filtering/pagination and file-read paging for large content.
- Optional `tasks.changedFiles` metadata-only response: reduces wire size;
  a wrapper over today's diff still computes every patch.
