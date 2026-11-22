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

export function explicitConnection(
  argv = process.argv.slice(1),
  env = process.env,
): string | undefined {
  const argument = argv.find((value) => value.startsWith("--connection="));
  return argument?.slice("--connection=".length) || env.MARS_SHELL_CONNECTION;
}

export async function resolveConnection(
  options: ConnectionOptions = {},
): Promise<ConnectionResult> {
  let filePath = explicitConnection(
    options.argv ? [...options.argv] : undefined,
    options.env,
  );
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
