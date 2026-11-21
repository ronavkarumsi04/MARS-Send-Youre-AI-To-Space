import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { RequestContext } from "@mars/contracts";
import {
  canonicalJSON,
  type EvidenceProbe,
  type Identity,
  IntegrationTrustError,
  type SourceEvidence,
  sha256,
} from "@mars/integration-trust";
import type { McpServerRegistry } from "./registry";
import {
  type McpServerConfig,
  type McpServerDescriptor,
  normalizeOrigin,
  type StdioTransportConfig,
} from "./schemas";
import { createMcpTransport } from "./transports";

export interface McpEvidenceProbeOptions {
  registry: McpServerRegistry;
  clock?: () => Date;
  probeTimeoutMs?: number;
}

async function hashFileOrSpec(
  filePath: string | undefined,
  fallbackSpec: unknown,
): Promise<string> {
  if (filePath) {
    const abs = resolve(filePath);
    const bytes = await readFile(abs);
    return sha256(bytes.toString("base64"));
  }
  return sha256(canonicalJSON(fallbackSpec));
}

function buildConfigHash(server: McpServerConfig): string {
  if (server.transport.type === "stdio") {
    return sha256(
      canonicalJSON({
        type: "stdio",
        command: server.transport.command,
        args: server.transport.args,
        cwd: server.transport.cwd ?? null,
        env_allowlist: [...server.transport.env_allowlist].sort(),
      }),
    );
  }
  return sha256(
    canonicalJSON({
      type: "streamable-http",
      url: server.transport.url,
      credential_header: server.transport.credential_header ?? null,
      credential_prefix: server.transport.credential_prefix ?? null,
    }),
  );
}

function buildToolEvidence(descriptor: McpServerDescriptor) {
  return descriptor.tools.map((tool) => ({
    name: tool.name,
    input_schema_sha256: sha256(
      canonicalJSON({
        description: tool.description ?? null,
        inputSchema: tool.inputSchema,
      }),
    ),
    output_schema_sha256: tool.outputSchema
      ? sha256(canonicalJSON(tool.outputSchema))
      : null,
  }));
}

function buildDescriptorHash(descriptor: McpServerDescriptor): string {
  return sha256(
    canonicalJSON({
      protocolVersion: descriptor.protocolVersion,
      serverInfo: descriptor.serverInfo,
      capabilities: descriptor.capabilities,
      tools: descriptor.tools,
    }),
  );
}

function deriveStdioRevision(contentHash: string): string {
  // SourceEvidence requires a 40-char hex git revision or semver.
  return contentHash.slice(0, 40);
}

export async function probeMcpServerDescriptor(
  server: McpServerConfig,
  timeoutMs = 5_000,
): Promise<McpServerDescriptor> {
  const transport = createMcpTransport(server.transport);
  try {
    return await transport.initialize({ timeoutMs });
  } finally {
    await transport.close();
  }
}

/**
 * Live MCP EvidenceProbe for `@mars/integration-trust`.
 *
 * Looks up servers exclusively from the host-owned registry (default-deny:
 * unknown servers fail with `evidence_unavailable`) and re-probes live tool
 * descriptors on every admission and every dispatch so descriptor drift is
 * detected and old grants are superseded.
 */
export class McpEvidenceProbe implements EvidenceProbe {
  private readonly registry: McpServerRegistry;
  private readonly clock: () => Date;
  private readonly probeTimeoutMs: number;

  constructor(options: McpEvidenceProbeOptions) {
    this.registry = options.registry;
    this.clock = options.clock ?? (() => new Date());
    this.probeTimeoutMs = options.probeTimeoutMs ?? 4_000;
  }

  async observe(
    _ctx: RequestContext,
    identity: Identity,
  ): Promise<SourceEvidence> {
    if (identity.kind !== "mcp") {
      throw new IntegrationTrustError("evidence_unavailable");
    }
    const server = await this.registry.get(identity.integration_id);
    if (!server) {
      throw new IntegrationTrustError("evidence_unavailable");
    }

    const descriptor = await probeMcpServerDescriptor(
      server,
      this.probeTimeoutMs,
    );
    const tools = buildToolEvidence(descriptor);
    const descriptorSha = buildDescriptorHash(descriptor);
    const configSha = buildConfigHash(server);
    const observedAt = this.clock().toISOString();

    if (server.transport.type === "streamable-http") {
      const canonicalOrigin = normalizeOrigin(
        new URL(server.transport.url).origin,
      );
      return {
        schema_version: 1,
        kind: "mcp",
        integration_id: server.id,
        source: {
          type: "remote-endpoint",
          locator: canonicalOrigin,
          revision: descriptorSha.slice(0, 40),
          content_sha256: descriptorSha,
        },
        dependency_sha256: sha256(
          canonicalJSON({
            protocolVersion: descriptor.protocolVersion,
            serverInfo: descriptor.serverInfo,
          }),
        ),
        config_sha256: configSha,
        endpoint: {
          origin: canonicalOrigin,
          descriptor_sha256: descriptorSha,
        },
        tools,
        observed_at: observedAt,
      };
    }

    const stdio: StdioTransportConfig = server.transport;
    const contentSha = await hashFileOrSpec(stdio.entrypoint, {
      command: stdio.command,
      args: stdio.args,
      descriptor_sha256: descriptorSha,
    });
    const dependencySha = await hashFileOrSpec(stdio.dependency_manifest, {
      command: stdio.command,
      serverInfo: descriptor.serverInfo,
    });
    // Mix descriptorSha into content_sha256 so even if entrypoint bytes didn't
    // change (e.g. dynamic tool list), descriptor drift always changes the binding.
    const combinedContentSha = sha256(
      canonicalJSON({
        artifact_sha256: contentSha,
        descriptor_sha256: descriptorSha,
      }),
    );

    return {
      schema_version: 1,
      kind: "mcp",
      integration_id: server.id,
      source: {
        type: "local-artifact",
        locator: stdio.entrypoint ?? stdio.command,
        revision: deriveStdioRevision(combinedContentSha),
        content_sha256: combinedContentSha,
      },
      dependency_sha256: dependencySha,
      config_sha256: configSha,
      endpoint: null,
      tools,
      observed_at: observedAt,
    };
  }
}
