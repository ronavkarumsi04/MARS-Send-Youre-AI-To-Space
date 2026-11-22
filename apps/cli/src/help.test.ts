import { expect, test } from "bun:test";
import { join } from "node:path";
import { requestsHelp } from "./help";

const groups: Record<string, string[]> = {
  doctor: [],
  smoke: [],
  serve: [],
  session: [],
  render: [],
  models: ["list", "providers", "add-provider", "add", "discover", "test"],
  commands: ["list", "expand"],
  vault: ["export", "import", "status"],
  mcp: ["list", "review", "approve", "revoke", "test"],
  memory: [
    "proposals",
    ...["list", "accept", "reject", "revert"].map((s) => `proposals ${s}`),
  ],
  skills: [
    "list",
    "show",
    "versions",
    "restore-version",
    "pin",
    "unpin",
    "archive",
    "restore",
    "proposals",
    "gate",
    "gates",
    "trials",
    "report",
    "accept",
    "reject",
    "undo",
    "curate",
  ],
  team: [
    "serve",
    "enable",
    "disable",
    "stats",
    "export",
    "import",
    "revoke",
    "readmit",
    "grant",
    "rotate-tokens",
  ],
  evolution: [
    "demo",
    "live-smoke",
    "status",
    "lineage",
    "metrics",
    "verify",
    "champion",
    "history",
    "rollback",
  ],
  datasets: ["build"],
  specialists: ["evaluate"],
  bench: ["edit-formats"],
};
const paths = Object.entries(groups).flatMap(([group, subs]) => [
  group,
  ...subs.map((s) => `${group} ${s}`),
]);

test("help recognition preserves unknown commands and literal arguments", () => {
  expect(requestsHelp(undefined, [])).toBe(false);
  expect(requestsHelp("models", ["list", "--", "--help"])).toBe(false);
  expect(requestsHelp("unknown", ["--help"])).toBe(false);
  expect(() => requestsHelp("models", ["unknown", "--help"])).toThrow(
    "Unknown models command",
  );
  expect(() => requestsHelp("memory", ["proposals", "unknown", "-h"])).toThrow(
    "Unknown memory proposals command",
  );
});

test("every group and subcommand resolves both help flags without setup", () => {
  for (const path of paths) {
    const [command, ...args] = path.split(" ");
    for (const flag of ["--help", "-h"])
      expect(requestsHelp(command, [...args, flag])).toBe(true);
  }
});

for (const args of [
  ["--help"],
  ["-h"],
  ["help"],
  ["models", "list", "-h"],
  ["mcp", "test", "--help"],
]) {
  test(`CLI ${args.join(" ")} prints help successfully without setup`, async () => {
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "main.ts"), ...args],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          PATH: process.env.PATH,
          HOME: "/nonexistent-mars-help-home",
          MARS_HOME: "/nonexistent-mars-help-home",
        },
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Usage:");
  }, 30_000);
}
