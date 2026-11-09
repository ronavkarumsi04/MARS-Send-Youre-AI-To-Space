import {
  type FileRead,
  type LocalConnection,
  parseConnectionFile,
} from "@mars/contracts/connection-file";

export interface ImportHost {
  pickFile(): Promise<string | undefined>;
  readFile(fsPath: string): Promise<FileRead>;
  /** `mars.serverUrl` from global (user) settings only; undefined when unset. */
  globalServerUrl(): string | undefined;
  getToken(): Promise<string | undefined>;
  storeToken(token: string): Promise<void>;
  deleteToken(): Promise<void>;
  storeGlobalServerUrl(url: string): Promise<void>;
  confirm(message: string, detail: string, action: string): Promise<boolean>;
  /**
   * Drops the live connection and blocks reconnects until the returned resume
   * is called, so neither token is ever paired with the other server's URL.
   */
  suspendConnections(): () => void;
}

export type ImportOutcome =
  | { status: "imported"; url: string; scope: LocalConnection["scope"] }
  | { status: "cancelled" }
  | { status: "rejected"; reason: string }
  | { status: "failed"; reason: string };

/**
 * Imports a local connection file: token to SecretStorage, URL to global
 * settings, after explicit confirmation when either would replace existing
 * configuration. Outcome messages never contain the token.
 */
export async function importConnection(
  host: ImportHost,
): Promise<ImportOutcome> {
  const fsPath = await host.pickFile();
  if (!fsPath) return { status: "cancelled" };
  const read = await host.readFile(fsPath);
  if (!read.ok) return { status: "rejected", reason: read.reason };
  const parsed = parseConnectionFile(read.bytes);
  if (!parsed.ok) return { status: "rejected", reason: parsed.reason };
  const { connection } = parsed;
  const previousUrl = host.globalServerUrl();
  const previousToken = await host.getToken();
  const urlChanges =
    previousUrl !== undefined &&
    previousUrl.replace(/\/+$/, "") !== connection.url;
  if (previousToken !== undefined || urlChanges) {
    const detail = [
      `Server URL: ${previousUrl ?? "(default)"} → ${connection.url}`,
      previousToken !== undefined
        ? "The stored MARS token will be replaced."
        : "A MARS token will be stored in Secret Storage.",
      `Owner: ${connection.scope.owner_id}`,
      `Project: ${connection.scope.project_id}`,
    ].join("\n");
    if (
      !(await host.confirm(
        "Replace your MARS connection settings?",
        detail,
        "Replace",
      ))
    )
      return { status: "cancelled" };
  }
  const resume = host.suspendConnections();
  try {
    return await storeConnection(host, connection, previousToken);
  } finally {
    resume();
  }
}

async function storeConnection(
  host: ImportHost,
  connection: LocalConnection,
  previousToken: string | undefined,
): Promise<ImportOutcome> {
  try {
    await host.storeToken(connection.token);
  } catch {
    return { status: "failed", reason: "Could not save the token." };
  }
  try {
    await host.storeGlobalServerUrl(connection.url);
  } catch {
    return {
      status: "failed",
      reason: `Could not save the server URL; ${await rollBackToken(host, previousToken)}`,
    };
  }
  return { status: "imported", url: connection.url, scope: connection.scope };
}

async function rollBackToken(
  host: ImportHost,
  previousToken: string | undefined,
): Promise<string> {
  try {
    if (previousToken !== undefined) {
      await host.storeToken(previousToken);
      return "the previous token was restored.";
    }
    await host.deleteToken();
    return "the new token was removed.";
  } catch {
    return "the stored token could not be rolled back, re-import the connection file.";
  }
}
