import { CliUsageError } from "./cli-errors";

const SUBCOMMANDS: Record<string, readonly string[]> = {
  doctor: [],
  smoke: [],
  models: ["list", "providers", "add-provider", "add", "discover", "test"],
  serve: [],
  session: [],
  render: [],
  commands: ["list", "expand"],
  vault: ["export", "import", "status"],
  mcp: ["list", "review", "approve", "revoke", "test"],
  memory: ["proposals"],
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

export function requestsHelp(
  command: string | undefined,
  args: string[],
): boolean {
  const end = args.indexOf("--");
  const options = end < 0 ? args : args.slice(0, end);
  if (!options.some((arg) => arg === "--help" || arg === "-h")) return false;
  const subcommands = command ? SUBCOMMANDS[command] : undefined;
  if (!subcommands) return false;
  const subcommand = options[0];
  if (subcommand && !subcommand.startsWith("-") && subcommands.length > 0) {
    if (!subcommands.includes(subcommand))
      throw new CliUsageError(`Unknown ${command} command "${subcommand}".`);
    if (
      command === "memory" &&
      options[1] &&
      !options[1].startsWith("-") &&
      !["list", "accept", "reject", "revert"].includes(options[1])
    )
      throw new CliUsageError(
        `Unknown memory proposals command "${options[1]}".`,
      );
  }
  return true;
}
