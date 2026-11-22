# @mars/memory-vault

Obsidian-compatible mirror of MARS curated memory: plain Markdown, YAML
frontmatter, `[[wikilinks]]`.

## Ownership

This package owns **no persistent store**.

- `@mars/memory` (SQLite) owns memory facts, their history, revisions and
  proposals.
- `@mars/skills` (`SkillStore`, files) owns skill content, versions,
  lifecycle and proposals.
- `@mars/knowledge-graph` owns graph artifacts.

The vault is a derived view that is fully rebuildable from those stores with
`exportVault`. It never writes to SQLite or to skill files. Vault edits only
become `pending` proposals through the existing proposal APIs
(`DurableMemoryStore.submitProposal`, `SkillStore.submitProposal`); the store
owners accept or reject them. Graph and project notes are read-only mirrors.

Every changed note body and rationale is scanned with `scanThreat` from
`@mars/memory` at the vault boundary and refused when flagged; the stores scan
again on acceptance.

## API

- `exportVault(ctx, { vaultDir, memory, skills, graph? })`
- `importVault(ctx, { vaultDir, memory, skills, actor, source: "memory-vault", allowRemove?, strict? })`
- `vaultStatus(ctx, { vaultDir, memory, skills })`

CLI: `mars vault export|import|status` (see `apps/cli/src/vault.ts`).

Exports and imports serialize per real vault path, including across processes
using a private exclusive lock file. Dead PID locks are reclaimed; incomplete
lock records are reclaimed after 60 seconds. Live owners are never evicted
just because they are old. Waiting times out after 30 seconds with
`vault_locked`. Imports hold the same lock while submitting proposals so
concurrent imports do not duplicate them.

Atomic replacements sync the temporary file before rename and the parent
directory afterward (directory sync is best effort on unsupported platforms).
Note and manifest reads are limited to 16 MiB, including files that grow while
being read. Oversized notes are reported as invalid; an oversized manifest
fails with `file_too_large`.

Opened note, manifest, temporary-file, lock and directory handles are checked
before use. Each operation pins the canonical vault root and its device/inode;
helpers retain that boundary and reject a replaced or rebound root. Root
symlink aliases are resolved only at entry. Linux checks `/proc/self/fd`
containment and anchors replacement
and deletion paths to verified directory handles. Other platforms recheck
resolved parents and device/inode identity; pathname races after that final
check remain possible there. An unlink can still race a same-name replacement.

Full documentation: `documentation/MEMORY_VAULT.md`. Tests are offline
(`bun test packages/memory-vault`), `model_requests: 0`; no live Obsidian or
model run was performed.
