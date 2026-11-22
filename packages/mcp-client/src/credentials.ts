import {
  type AuthorizedArtifact,
  IntegrationTrustError,
} from "@mars/integration-trust";
import {
  type McpCredentialResolver,
  type McpServerConfig,
  normalizeOrigin,
} from "./schemas";

export interface McpAuthentication {
  ref: string;
  headers: Record<string, string>;
}

export function buildCredentialHeaders(
  server: McpServerConfig,
  value: string,
): Record<string, string> {
  if (server.transport.type !== "streamable-http") {
    throw new IntegrationTrustError("credential_denied");
  }
  const header = server.transport.credential_header ?? "Authorization";
  const prefix = server.transport.credential_prefix ?? "Bearer ";
  return { [header]: `${prefix}${value}` };
}

export async function selectMcpAuthentication(
  server: McpServerConfig,
  resolver: McpCredentialResolver | undefined,
  grantId: string,
  authorization?: Pick<
    AuthorizedArtifact,
    "permissions" | "credential_bindings"
  >,
  requestedRef?: string,
): Promise<McpAuthentication | undefined> {
  if (server.transport.type !== "streamable-http" || !resolver) return;
  const origin = normalizeOrigin(new URL(server.transport.url).origin);
  for (const binding of server.credential_bindings) {
    if (
      normalizeOrigin(binding.allowed_origin) !== origin ||
      (requestedRef !== undefined && requestedRef !== binding.ref_id)
    )
      continue;
    if (
      authorization &&
      (!authorization.credential_bindings.some(
        (approved) =>
          approved.ref_id === binding.ref_id &&
          approved.allowed_origin === origin,
      ) ||
        !authorization.permissions.some(
          (p) =>
            p.capability === "credential.use" && p.resource === binding.ref_id,
        ))
    )
      continue;
    const value = await resolver.resolve({
      ref_id: binding.ref_id,
      target_origin: origin,
      server_id: server.id,
      grant_id: grantId,
    });
    if (value)
      return {
        ref: binding.ref_id,
        headers: buildCredentialHeaders(server, value),
      };
  }
}
