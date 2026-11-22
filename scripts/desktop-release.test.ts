import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const workflow = Bun.YAML.parse(
  await Bun.file(
    join(import.meta.dir, "../.github/workflows/desktop.yml"),
  ).text(),
) as { jobs: { release: { steps: { run?: string }[] } } };
const publish = workflow.jobs.release.steps.find((step) => step.run)?.run;
const installers = [
  "installers/MARS-macOS-Apple-Silicon/MARS-0.0.1-macOS-arm64.dmg",
  "installers/MARS-macOS-Intel/MARS-0.0.1-macOS-x64.dmg",
  "installers/MARS-Ubuntu-Debian-x64/MARS-0.0.1-linux-amd64.deb",
];
const repo = "ronavkarumsi04/MARS-Send-Youre-AI-To-Space";
const tag = "v0.0.1";

function runPublish(files: string[], viewStatus: number) {
  const cwd = mkdtempSync(join(tmpdir(), "mars-desktop-release-"));
  try {
    for (const file of files) {
      const path = join(cwd, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "");
    }
    const script = `gh() {
      if [[ "$2" == view ]]; then return ${viewStatus}; fi
      printf '%s\\n' "$@"
    }
    ${publish}`;
    return Bun.spawnSync(["bash", "-euo", "pipefail", "-c", script], {
      cwd,
      env: { ...process.env, GITHUB_REPOSITORY: repo, GITHUB_REF_NAME: tag },
      stdout: "pipe",
      stderr: "pipe",
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test.each([
  [1, "create", ["--verify-tag", "--generate-notes"]],
  [0, "upload", ["--clobber"]],
] as const)(
  "release view status %i: %s uploads every installer",
  (status, command, flags) => {
    const result = runPublish(installers, status);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim().split("\n")).toEqual([
      "release",
      command,
      tag,
      ...installers,
      ...flags,
      "--repo",
      repo,
    ]);
  },
);

test.each(installers)("does not publish when %s is missing", (missing) => {
  const result = runPublish(
    installers.filter((file) => file !== missing),
    1,
  );
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("Missing release installer:");
  expect(result.stdout.toString()).toBe("");
});
