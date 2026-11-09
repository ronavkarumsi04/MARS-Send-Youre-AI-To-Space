import {
  type LocalConnection,
  loadConnectionFile,
} from "@mars/contracts/connection-file";

export type { LocalConnection } from "@mars/contracts/connection-file";

/** Reads `connection.json` with the shared strict reader, throwing on rejection. */
export async function readConnectionFileOrThrow(
  path: string,
  platform: NodeJS.Platform = process.platform,
): Promise<LocalConnection> {
  const result = await loadConnectionFile(path, platform);
  if (!result.ok) throw new Error(`${result.reason} (${path})`);
  return result.connection;
}
