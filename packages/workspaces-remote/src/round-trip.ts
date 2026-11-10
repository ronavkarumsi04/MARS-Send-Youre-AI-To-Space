import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  snapshotTree,
  type TreeFile,
  type WorkspaceLimits,
} from "@mars/workspaces";

/**
 * Proves an exported patch reproduces the exact tested candidate: apply it to
 * the baseline with `git apply` in a scratch tree and compare every hash.
 * Mirrors the local provider's export check so both providers mean the same.
 */
export async function roundTripPatch(
  baseFiles: readonly TreeFile[],
  candidate: readonly TreeFile[],
  patch: Uint8Array,
  binary: readonly string[],
  limits: WorkspaceLimits,
  extraIgnores: readonly string[],
): Promise<{
  status: "passed" | "failed" | "unavailable";
  reason: string | null;
}> {
  if (binary.length)
    return {
      status: "unavailable",
      reason: `Binary files have no text patch: ${binary.slice(0, 20).join(", ")}`,
    };
  const scratch = await mkdtemp(join(tmpdir(), "mars-remote-export-"));
  try {
    const tree = join(scratch, "tree");
    await mkdir(tree, { recursive: true });
    for (const file of baseFiles) {
      const target = join(tree, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.data, { mode: file.mode });
      await chmod(target, file.mode);
    }
    if (patch.byteLength > 0) {
      const patchFile = join(scratch, "candidate.patch");
      await writeFile(patchFile, patch);
      for (const args of [["--check"], []]) {
        let proc: ReturnType<typeof Bun.spawnSync>;
        try {
          proc = Bun.spawnSync(
            ["git", "apply", "--unsafe-paths", ...args, patchFile],
            {
              cwd: tree,
              stdout: "pipe",
              stderr: "pipe",
              env: { PATH: process.env.PATH ?? "" },
            },
          );
        } catch {
          return { status: "unavailable", reason: "git is not available" };
        }
        if (proc.exitCode !== 0)
          return {
            status: "failed",
            reason: `git apply ${args.join(" ") || "(apply)"} exited ${proc.exitCode}: ${new TextDecoder().decode(proc.stderr ?? new Uint8Array()).slice(0, 512)}`,
          };
      }
    }
    const rebuilt = await snapshotTree(tree, {
      limits,
      extraIgnores,
      includeData: false,
      tolerateUnsupportedNames: true,
    });
    const expected = new Map(candidate.map((file) => [file.path, file]));
    const mismatches: string[] = [];
    for (const file of rebuilt.files) {
      const want = expected.get(file.path);
      expected.delete(file.path);
      if (!want || want.sha256 !== file.sha256 || want.mode !== file.mode)
        mismatches.push(file.path);
    }
    mismatches.push(...expected.keys());
    return mismatches.length
      ? {
          status: "failed",
          reason: `Reconstructed tree differs at: ${mismatches.slice(0, 20).join(", ")}`,
        }
      : { status: "passed", reason: null };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
