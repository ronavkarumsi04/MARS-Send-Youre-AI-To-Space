import {
  type AgentServerClient,
  type AgentServerInfo,
  PINNED_AGENT_SERVER,
} from "./client";

/**
 * What a remote workspace actually guarantees. MARS cannot observe the
 * Agent Server host, so anything the server says about its own runtime is
 * reported as untrusted evidence and never upgrades the isolation level.
 */
export interface IsolationReport {
  provider: "openhands-agent-server";
  server_url: string;
  server_version: string;
  server_build_sha: string | null;
  pinned_revision: string;
  transport: AgentServerClient["transport"];
  authenticated: boolean;
  remote_root: string;
  /** Established by MARS itself. Always "none": see `statement`. */
  os_isolation: "none";
  /** Self-reported by the server; untrusted, informational only. */
  untrusted_server_runtime: string | null;
  statement: string;
  warnings: string[];
}

export const ISOLATION_STATEMENT =
  "A remote Agent Server interface is not an OS isolation guarantee. Commands run with the privileges of the Agent Server process on its host; MARS confines paths client-side and verifies every tree by hash, but cannot stop a command from reaching outside its workspace on that host.";

export function describeIsolation(
  info: AgentServerInfo,
  client: Pick<AgentServerClient, "url" | "transport" | "authenticated">,
  remoteRoot: string,
): IsolationReport {
  const warnings: string[] = [];
  if (!client.authenticated)
    warnings.push(
      "No X-Session-API-Key configured: anyone who can reach the server can run commands on it.",
    );
  if (client.transport === "http-insecure")
    warnings.push(
      "Plain HTTP to a non-loopback host: traffic and the session key travel unencrypted.",
    );
  return {
    provider: "openhands-agent-server",
    server_url: client.url,
    server_version: info.version,
    server_build_sha: info.build_git_sha ?? null,
    pinned_revision: PINNED_AGENT_SERVER.revision,
    transport: client.transport,
    authenticated: client.authenticated,
    remote_root: remoteRoot,
    os_isolation: "none",
    untrusted_server_runtime: info.conversation_runtime ?? null,
    statement: ISOLATION_STATEMENT,
    warnings,
  };
}
