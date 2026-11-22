import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { RequestContext, Scope } from "@mars/contracts";
import {
  createHostMcpControlPlane,
  type HostMcpControlPlane,
  type McpServerConfig,
  verifyMcpConfig,
} from "@mars/mcp-client";
import { type Operation, SkillStore } from "@mars/skills";
import { CATALOG, type CatalogEntry, findExtension } from "./extension-catalog";

const hash = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");

// Created by the managed workbench. Neither the project nor the renderer supplies a
// path, executable, permission manifest, or signing proof.
export function projectExtensions(
  source: string,
  state: string,
  scope: Scope,
  dir = join(import.meta.dir, "catalog"),
) {
  const store = new SkillStore(join(state, "skills"));
  let opening: Promise<HostMcpControlPlane> | undefined;
  const plane = () => {
    opening ??= createHostMcpControlPlane({
      scope,
      stateDir: join(state, "extension-trust"),
      workspaceRoots: [source, join(state, "workspaces")],
      approvers: [
        {
          approver_id: "desktop-operator",
          owner_id: scope.owner_id,
          project_ids: [scope.project_id],
        },
      ],
    }).catch((error) => {
      opening = undefined;
      throw error;
    });
    return opening;
  };
  const context = (): RequestContext => ({
    schema_version: 1,
    scope,
    request_id: randomUUID(),
  });

  async function artifacts(entry: CatalogEntry) {
    return Promise.all(
      entry.assets.map(async ({ file, sha256 }) => {
        const bytes = await readFile(join(dir, file));
        if (hash(bytes) !== sha256)
          throw new Error("Bundled extension failed verification.");
        return { name: basename(file, ".md"), content: bytes.toString("utf8") };
      }),
    );
  }

  function config(entry: CatalogEntry): McpServerConfig {
    const artifact = entry.assets[0];
    if (!artifact || entry.kind !== "mcp")
      throw new Error("Missing MCP entrypoint.");
    const script = join(dir, artifact.file);
    return {
      schema_version: 1,
      id: entry.id,
      registered_at: new Date().toISOString(),
      transport: {
        type: "stdio",
        command: process.execPath,
        args: ["--no-env-file", script],
        cwd: dir,
        entrypoint: script,
        env_allowlist: [],
      },
      permissions: [{ capability: "tool.invoke", resource: "utc_now" }],
      credential_bindings: [],
    };
  }

  async function installedMcp(cp: HostMcpControlPlane, entry: CatalogEntry) {
    const registered = await cp.registry.get(entry.id);
    if (
      !registered ||
      !isDeepStrictEqual(registered, {
        ...config(entry),
        registered_at: registered.registered_at,
      })
    )
      return false;
    const { grants } = await cp.admin.inspect(context(), {
      kind: "mcp",
      integration_id: entry.id,
    });
    const grant = grants.findLast((g) => g.state !== "superseded");
    if (
      grant?.state !== "approved" ||
      Date.parse(grant.expires_at) <= Date.now()
    )
      return false;
    try {
      await artifacts(entry);
      await verifyMcpConfig(registered, grant.evidence);
      return true;
    } catch {
      return false;
    }
  }

  async function list() {
    const skills = await store.list();
    const installed: string[] = [];
    for (const entry of CATALOG) {
      if (
        entry.kind === "mcp"
          ? await installedMcp(await plane(), entry)
          : entry.assets.every((asset) =>
              skills.some(
                (skill) =>
                  skill.name === basename(asset.file, ".md") &&
                  skill.status !== "archived" &&
                  hash(skill.content) === asset.sha256,
              ),
            )
      )
        installed.push(entry.id);
    }
    return installed;
  }

  async function install(id: string) {
    const entry = findExtension(id);
    if (!entry) throw new Error("Not in the bundled catalog.");
    const contents = await artifacts(entry);
    if (entry.kind !== "mcp") {
      const expectedRevision = await store.getRevision();
      const skills = await store.list();
      const ops: Operation[] = [];
      for (const { name, content } of contents) {
        const existing = skills.find((skill) => skill.name === name);
        if (!existing) ops.push({ op: "create", name, content });
        else if (existing.content !== content)
          throw new Error("A different skill already uses that name.");
        else if (existing.status === "archived")
          ops.push({ op: "restore", name });
      }
      if (ops.length)
        await store.applyBatch(ops, {
          actor: "desktop-operator",
          source: `catalog:${id}@${entry.version}`,
          expectedRevision,
        });
      return;
    }
    const cp = await plane();
    if (await installedMcp(cp, entry)) return;
    const ctx = context();
    const server = config(entry);
    const evidence = await cp.probe.observeServer(ctx, server, {
      allowUnapprovedStdioProbe: true,
    });
    const review = await cp.admin.submitCandidate(ctx, {
      evidence,
      permissions: server.permissions,
      credential_bindings: [],
    });
    await cp.registry.upsert(server);
    await cp.admin.approve(ctx, {
      review_id: review.review_id,
      expected_revision: review.revision,
      proof: cp.signHostProof({
        review_id: review.review_id,
        review_revision: review.revision,
        binding_sha256: review.binding_sha256,
        scope,
        decision: "approve",
        expires_at: review.expires_at,
      }),
    });
  }

  return {
    list,
    install,
    async runtime(_cwd: string, taskScope: Scope) {
      if (!isDeepStrictEqual(scope, taskScope))
        throw new Error("Project scope mismatch.");
      const cp = await plane();
      return {
        loader: cp.createLoader(),
        async listServerIds() {
          const ids = [];
          for (const entry of CATALOG) {
            if (entry.kind === "mcp" && (await installedMcp(cp, entry)))
              ids.push(entry.id);
          }
          return ids;
        },
      };
    },
  };
}
