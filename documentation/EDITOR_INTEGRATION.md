# Decision needed: Monaco vs Code OSS

| Decision factor | Monaco in MARS | Full Code OSS workbench |
| --- | --- | --- |
| Size | npm 0.57.0 unpacked ~97 MiB; `min/vs` is 25,609,317 bytes (24.42 MiB), one minified tree, not the shipped MARS payload | VSCodium Linux x64 archive: 214,776,735 bytes (~204.8 MiB) compressed; ~602.84 MiB extracted file contents, a whole standalone app including Electron |
| License | MIT, with third-party notices | Code OSS source is MIT. Microsoft terms cover its product name, proprietary assets and Visual Studio Marketplace, which alternative products may not use. Open VSX does not clear individual extension rights |
| Security/CSP | Renderer library, no Node/terminal/extension host supplied; requires editor-only worker assets, preload and scoped read handles | Own Electron app, Node-capable extension host and CSP; substantially larger privilege boundary to reconcile with untrusted agent output |
| Effort | Focused read-only viewer and lifecycle; worker/style compatibility inside MARS is unverified | Heavy build, packaging, lifecycle, privilege and ongoing maintenance work |
| v1 features | Unified patch text plus path/status metadata; binary marker only. Side-by-side is not supported by today's patch API | Full workbench, extensions, terminals and debugging; most are unnecessary privileges for a read-only viewer |
| Recommendation for Tanay | Prefer a read-only Monaco file/unified-patch viewer first, editing later, subject to the gates below | Choose only if full IDE features justify the integration and security cost |

**These sizes are not like for like: do not divide them or infer a MARS size
delta.** The honest comparison is the MARS installer and installed bytes before
and after each option on the same platform. That is **not measured yet** and can
only be measured after the build gate. A read-only viewer needs no marketplace.

## Ownership and gates

Tanay chooses; David reviews. This fork will implement later, with the editor PR
landing in **github.com/tanaypatel917-lab/MARS-Send-Youre-AI-To-Space**. Only Tanay
merges upstream. This document requests a technology decision, **not** a merge
of this fork PR. This PR changes documentation only, not editor or shell code.

Cut the implementation branch from upstream `main` after upstream #245 merges,
gated on Tanay confirming the #245/#246 bugs fixed. Get layout touch points from
David first; no rewrites to layout, chat, settings or Extensions without David.
Shell navigation is still changing, including Settings in the sidebar.
Proposed module: `apps/shell/src/editor/` (name is a proposal).

## Workbench availability and gaps

- `tasks.diff {task_id}` returns per-file `{path, status, patch}` and a digest
  (`packages/workbench/src/protocol.ts`, `host.ts`). These are net baseline-to-current
  changes, not a historical touched ledger. v1 displays unified patch text and
  path/status metadata, binary marker only, never binary contents.
- Patches are **not** the two revision-matched full texts Monaco's side-by-side
  diff needs. Side-by-side requires a future base+current text API bound to matched
  revisions; fetching current contents alone cannot supply it.
- The `tasks.file` RPC belongs to [fork PR #21](https://github.com/ronavkarumsi04/MARS-Send-Youre-AI-To-Space/pull/21),
  held pending hardening, not this decision.
  Proposed single-file request: `{task_id, path}`; response:
  `{path, data_base64, media_type, size, sha256}` from the task's private workspace,
  not source checkout. It is not present in this docs-only PR.
- Remaining gaps: tree listing with explicit task-workspace versus source-project
  semantics; historical touched ledger; diff per-file filtering/pagination;
  matched-revision full texts; file paging; optional metadata-only `tasks.changedFiles`.
  Workbench's response limit is 4 MiB including base64/envelope (`server.ts`).

## Requirements for the later editor PR

- Use an editor-only surface and **editor-only preload** with a narrow method
  whitelist (`tasks.diff`, and file reads only after their separate hardening gate).
  Two IPC channel names in one renderer do not separate privileges: #245's
  `apps/shell/src/preload/preload.ts:38–52` also exposes chat/task actions.
- Main issues short-lived handles scoped to the selected project, task, revision
  and permitted files. Invalidate on switch, cap aggregate reads, drop late results,
  and keep the workbench bearer token in main. Validate requests/results and render
  content as untrusted text, never executable HTML. A path denylist is **not a
  secret detector**; do not claim arbitrary file contents are safe to disclose.
- Authorize the exact window, main frame and URL, following upstream #246's
  `apps/shell/src/main/extensions.ts:122–131`; scheme+host matching alone in
  `main/ipc.ts:20–32` is insufficient. Keep editor IPC separate from the chat bridge.
- Upstream #245's CSP and asset routes (`apps/shell/src/main/security.ts:3–20`)
  allow no workers. Serve **enumerated local worker assets on the editor surface
  only**. No global inline-style, blob or network exception for chat or settings.
  Coordinate editor-specific CSP/asset routing and relevant HTML metas; worker
  and style compatibility inside MARS is **not verified**. Verify nonce/style
  support in the spike instead of assuming `unsafe-inline` is needed or acceptable.

## Reference measurements and licenses

Monaco: `npm view monaco-editor dist.unpackedSize version`, and a package extracted
outside the repo with `npm pack monaco-editor@0.57.0`; `du -sb package/min/vs`.
The minified tree includes all published languages/workers and directory overhead,
not a selected-language production bundle. No repo dependencies were installed.
VSCodium: [1.143.17232 full Linux x64 archive](https://github.com/VSCodium/vscodium/releases/download/1.143.17232/VSCodium-linux-x64-1.143.17232.tar.gz),
compressed size from read-only release metadata; extracted-content size supplied
in David's review. Neither measures the incremental cost inside MARS.
Licenses: [Monaco](https://github.com/microsoft/monaco-editor),
[Code OSS](https://github.com/microsoft/vscode),
[Microsoft product/Marketplace FAQ](https://code.visualstudio.com/docs/supporting/faq#_what-is-the-difference-between-the-vscode-repository-and-the-microsoft-visual-studio-code-distribution),
[Open VSX](https://open-vsx.org/). Check third-party and extension notices before distribution.
