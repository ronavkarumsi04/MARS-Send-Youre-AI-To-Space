# skills CLI project-install fixture

Synthetic skill content and source identity; on-disk layout and lock fields
mirror `vercel-labs/skills` at `b716f9dc2ba36b6aa8f0080615e5a3a6caeac63b`:

- `src/installer.ts`: project symlink mode copies into
  `.agents/skills/release-guide/`, and creates
  `.claude/skills/release-guide -> ../../.agents/skills/release-guide`.
  Codex uses `.agents/skills` directly (no `.codex/skills` link).
- `src/local-lock.ts`: project `skills-lock.json` version 2, keyed by installed
  folder name, recording source, sourceType, optional skillPath, computedHash.
- `README.md`, “Lock File Content Hash”, and `src/skill-hash.ts`: hash all
  installed files using path/NUL/decimal-byte-length/NUL/content framing.

The fixed fixture hash was independently generated with Python hashlib. The
tests also cover all three published README test vectors, exclusions, binary
content, CRLF normalization, UTF-8 path ordering, and confined symlink traversal.
No CLI execution, network access, or provider call is required by these tests.
