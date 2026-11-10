import { type AgentServerClient, createAgentServerClient } from "./client";
import {
  describeIsolation,
  ISOLATION_STATEMENT,
  type IsolationReport,
} from "./isolation";

export const DEFAULT_AGENT_SERVER_KEY_ENV = "MARS_AGENT_SERVER_API_KEY";
export const DEFAULT_AGENT_SERVER_ROOT = "/workspace/mars";

export interface RemoteWorkspaceFlags {
  provider?: string;
  agentServer?: string;
  keyEnv?: string;
  remoteRoot?: string;
  allowInsecureHttp?: boolean;
}

/** Resolved remote workspace configuration. `apiKey` is never printed. */
export interface RemoteWorkspaceConfig {
  url: string;
  apiKey?: string;
  apiKeyEnv: string;
  remoteRoot: string;
  allowInsecureHttp: boolean;
}

const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;

/** null means the local provider; throws on an incomplete remote selection. */
export function remoteWorkspaceFromFlags(
  flags: RemoteWorkspaceFlags,
  env: Record<string, string | undefined>,
): RemoteWorkspaceConfig | null {
  const provider = flags.provider ?? (flags.agentServer ? "remote" : "local");
  if (provider === "local") {
    if (flags.agentServer)
      throw new Error("--agent-server requires --workspace-provider remote");
    return null;
  }
  if (provider !== "remote")
    throw new Error("--workspace-provider must be local or remote");
  if (!flags.agentServer)
    throw new Error("--workspace-provider remote requires --agent-server URL");
  const apiKeyEnv = flags.keyEnv ?? DEFAULT_AGENT_SERVER_KEY_ENV;
  if (!ENV_NAME.test(apiKeyEnv))
    throw new Error(
      "--agent-server-key-env must be an environment variable name",
    );
  const apiKey = env[apiKeyEnv];
  const config: RemoteWorkspaceConfig = {
    url: flags.agentServer,
    apiKeyEnv,
    remoteRoot: flags.remoteRoot ?? DEFAULT_AGENT_SERVER_ROOT,
    allowInsecureHttp: flags.allowInsecureHttp === true,
    ...(apiKey ? { apiKey } : {}),
  };
  clientFor(config);
  return config;
}

export function clientFor(config: RemoteWorkspaceConfig): AgentServerClient {
  return createAgentServerClient({
    url: config.url,
    allowInsecureHttp: config.allowInsecureHttp,
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
  });
}

export interface RemoteWorkspaceDoctorReport {
  enabled_by: string;
  statement: string;
  configured: boolean;
  api_key_env: string;
  credential_present: boolean;
  /** Present only after a successful identity/version probe. */
  isolation: IsolationReport | null;
  error: string | null;
  verified: string;
  live_verified: false;
}

/** One GET /server_info; never sends a command, never prints the key. */
export async function remoteWorkspaceDoctor(
  flags: RemoteWorkspaceFlags,
  env: Record<string, string | undefined>,
): Promise<RemoteWorkspaceDoctorReport> {
  const apiKeyEnv = flags.keyEnv ?? DEFAULT_AGENT_SERVER_KEY_ENV;
  const base: RemoteWorkspaceDoctorReport = {
    enabled_by: "mars serve --workspace-provider remote --agent-server URL",
    statement: ISOLATION_STATEMENT,
    configured: Boolean(flags.agentServer),
    api_key_env: apiKeyEnv,
    credential_present: ENV_NAME.test(apiKeyEnv) && Boolean(env[apiKeyEnv]),
    isolation: null,
    error: null,
    verified:
      "offline only (FAKE Agent Server speaking the pinned wire protocol)",
    live_verified: false,
  };
  if (!flags.agentServer) return base;
  try {
    const config = remoteWorkspaceFromFlags(
      { ...flags, provider: "remote" },
      env,
    );
    if (!config) return base;
    const client = clientFor(config);
    const info = await client.verify();
    return {
      ...base,
      isolation: describeIsolation(info, client, config.remoteRoot),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const key = env[apiKeyEnv];
    return {
      ...base,
      error: key ? message.split(key).join("[redacted]") : message,
    };
  }
}
