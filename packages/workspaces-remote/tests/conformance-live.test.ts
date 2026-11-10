import { test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemoryArtifactStore } from "@mars/workspaces";
import { createAgentServerClient, createRemoteWorkspaceProvider } from "../src";
import { defineProviderConformance } from "./conformance";
import { makeSource } from "./fixtures";

/*
 * Opt-in LIVE run of the same contract suite against a real OpenHands Agent
 * Server. Skipped unless MARS_AGENT_SERVER_URL is set; never run in CI.
 */
const url = process.env.MARS_AGENT_SERVER_URL;
const remoteRoot =
  process.env.MARS_AGENT_SERVER_ROOT ?? "/workspace/mars-conformance";
if (url) {
  defineProviderConformance(
    "remote provider (LIVE Agent Server)",
    async (options) => {
      const base = await mkdtemp(join(tmpdir(), "mars-conf-live-"));
      const artifacts = createInMemoryArtifactStore();
      const apiKey = process.env.MARS_AGENT_SERVER_API_KEY;
      const client = createAgentServerClient({
        url,
        ...(apiKey ? { apiKey } : {}),
      });
      const provider = await createRemoteWorkspaceProvider({
        rootDir: join(base, "state"),
        sourceRoot: await makeSource(base),
        artifacts,
        client,
        remoteRoot: `${remoteRoot}/${Date.now()}-${Math.random().toString(16).slice(2)}`,
        approveCommand: async () => true,
        ...(options?.limits ? { limits: options.limits } : {}),
      });
      return {
        provider,
        artifacts,
        async tamper(_context, workspace, path, content) {
          const info = provider.isolation();
          await client.upload(
            `${info.remote_root}/ws/${workspace.workspace_id}/tree/${path}`,
            new TextEncoder().encode(content),
          );
        },
        async close() {
          await provider.close();
          await rm(base, { recursive: true, force: true });
        },
      };
    },
  );
} else {
  test.skip("LIVE Agent Server conformance (set MARS_AGENT_SERVER_URL)", () => {});
}
