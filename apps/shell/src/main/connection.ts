import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type ConnectionResult,
  loadConnectionFile,
} from "@mars/contracts/connection-file";

export type ConnectionOptions = {
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
};

export async function resolveConnection(
  options: ConnectionOptions = {},
): Promise<ConnectionResult> {
  const args = options.argv ?? process.argv.slice(2);
  const argument = args.find((value) => value.startsWith("--connection="));
  const explicitPath =
    argument?.slice("--connection=".length) ||
    (options.env ?? process.env).MARS_SHELL_CONNECTION;
  let filePath = explicitPath;
  if (!filePath) {
    const home = options.homeDir ?? process.env.HOME ?? "";
    let paths: string[];
    try {
      const entries = await readdir(join(home, ".mars", "workbench"), {
        withFileTypes: true,
      });
      const candidates = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) =>
          join(home, ".mars", "workbench", entry.name, "connection.json"),
        );
      paths = (
        await Promise.all(
          candidates.map(async (path) => {
            try {
              return (await lstat(path)).isFile() ? path : undefined;
            } catch {
              return undefined;
            }
          }),
        )
      ).filter((path): path is string => path !== undefined);
    } catch {
      paths = [];
    }
    if (paths.length === 0)
      return {
        ok: false,
        reason:
          "No workbench connection file found. Start `mars serve` or pass --connection=PATH.",
      };
    if (paths.length > 1)
      return {
        ok: false,
        reason: "Several workbench connections found; pass --connection=PATH.",
      };
    filePath = paths[0];
  }
  if (!filePath)
    return { ok: false, reason: "Could not open the connection file." };
  return loadConnectionFile(filePath);
}
