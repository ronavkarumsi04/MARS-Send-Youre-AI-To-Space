import { join } from "node:path";
import { parseArgs } from "node:util";
import type {
  MemoryProposal,
  MemoryProposalStatus,
  RequestContext,
} from "@mars/contracts";
import { createMemoryStore, MemoryStoreError } from "@mars/memory";
import { CliUsageError } from "./cli-errors";
import { resolveWorkbenchLocation } from "./workbench-location";

export const MEMORY_USAGE = [
  "Usage: mars memory proposals <list|accept|reject|revert> [PROPOSAL_ID] [--state PRIVATE_DIR] [--source DIR] [--owner ID] [--project ID] [--workspace ID] [--actor ID] [--json]",
  "  list    [--status pending|accepted|rejected|reverted] [--task TASK_ID]  show proposals and the current memory revision",
  "  accept  PROPOSAL_ID                                apply a pending proposal through the memory writer",
  "  reject  PROPOSAL_ID --reason TEXT                  close a pending proposal without writing memory",
  "  revert  PROPOSAL_ID --expected-revision N [--reason TEXT]  restore what an accepted proposal changed; fails if memory moved past N or a touched entry changed since",
  "  Decisions are recorded with --actor (default: the --owner). Defaults match mars serve: --owner local, --project project-<sha256(source)>, --state ~/.mars/workbench/<project>.",
].join("\n");

export class MemoryUsageError extends CliUsageError {}

const STATUSES: readonly MemoryProposalStatus[] = [
  "pending",
  "accepted",
  "rejected",
  "reverted",
];

export function renderProposal(proposal: MemoryProposal): string {
  const facts = proposal.operations.map((op) =>
    op.operation === "add"
      ? `    + ${op.entry.fact}`
      : op.operation === "patch"
        ? `    ~ ${op.entry_id}: ${op.fact}`
        : `    - ${op.entry_id}`,
  );
  const trail = [
    `submitted ${proposal.submitted_at} by ${proposal.source}`,
    proposal.task_id ? `task ${proposal.task_id}` : null,
    proposal.resolved_at
      ? `resolved ${proposal.resolved_at}${proposal.resolved_by ? ` by ${proposal.resolved_by}` : ""}`
      : null,
    proposal.applied_revision !== undefined
      ? `applied at revision ${proposal.applied_revision}`
      : null,
    proposal.reverted_at
      ? `reverted ${proposal.reverted_at}${proposal.reverted_by ? ` by ${proposal.reverted_by}` : ""} at revision ${proposal.reverted_revision}`
      : null,
    proposal.reason ? `reason: ${proposal.reason}` : null,
    proposal.revert_reason ? `revert reason: ${proposal.revert_reason}` : null,
  ].filter((part): part is string => part !== null);
  return [
    `${proposal.proposal_id} [${proposal.status}] ${proposal.rationale}`,
    `    ${trail.join("; ")}`,
    ...facts,
  ].join("\n");
}

function proposalId(positionals: string[], subcommand: string): string {
  const [id, ...extra] = positionals;
  if (!id || extra.length)
    throw new MemoryUsageError(
      `mars memory proposals ${subcommand} takes exactly one PROPOSAL_ID.\n${MEMORY_USAGE}`,
    );
  return id;
}

export async function runMemory(args: string[]): Promise<void> {
  const [group, subcommand, ...rest] = args;
  if (!group || group === "help" || group === "--help") {
    console.log(MEMORY_USAGE);
    return;
  }
  if (group !== "proposals")
    throw new MemoryUsageError(
      `Unknown memory command "${group}".\n${MEMORY_USAGE}`,
    );
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    console.log(MEMORY_USAGE);
    return;
  }
  if (!["list", "accept", "reject", "revert"].includes(subcommand))
    throw new MemoryUsageError(
      `Unknown memory proposals command "${subcommand}".\n${MEMORY_USAGE}`,
    );
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(rest);
  } catch (error) {
    throw new MemoryUsageError(
      `${error instanceof Error ? error.message : "Invalid options."}\n${MEMORY_USAGE}`,
    );
  }
  const { values, positionals } = parsed;
  if (values.help) {
    console.log(MEMORY_USAGE);
    return;
  }
  const status = values.status as MemoryProposalStatus | undefined;
  if (status !== undefined && !STATUSES.includes(status))
    throw new MemoryUsageError(
      `--status must be one of ${STATUSES.join(", ")}.`,
    );
  if (subcommand === "list" && positionals.length)
    throw new MemoryUsageError(
      `mars memory proposals list takes no PROPOSAL_ID.\n${MEMORY_USAGE}`,
    );
  const id = subcommand === "list" ? "" : proposalId(positionals, subcommand);
  if (subcommand === "reject" && !values.reason)
    throw new MemoryUsageError(
      `mars memory proposals reject requires --reason.\n${MEMORY_USAGE}`,
    );
  const expected = values["expected-revision"];
  if (
    subcommand === "revert" &&
    (expected === undefined || !/^\d+$/.test(expected))
  )
    throw new MemoryUsageError(
      `mars memory proposals revert requires --expected-revision N (the current memory revision shown by list).\n${MEMORY_USAGE}`,
    );
  const { source, project, state } = await resolveWorkbenchLocation({
    source: values.source,
    project: values.project,
    state: values.state,
  });
  const memoryRoot = join(state, "memory");
  const ctx: RequestContext = {
    schema_version: 1,
    scope: {
      owner_id: values.owner ?? "local",
      project_id: project,
      ...(values.workspace ? { workspace_id: values.workspace } : {}),
    },
    request_id: `memory-proposals-${subcommand}-${Date.now().toString(36)}`,
  };
  const resolution = { resolved_by: values.actor ?? ctx.scope.owner_id };
  const memory = createMemoryStore({
    rootDir: memoryRoot,
    hostPrivateRoots: [source, state, memoryRoot],
  });
  try {
    if (subcommand === "list") {
      const proposals = await memory.listProposals(
        ctx,
        status,
        values.task ? { task_id: values.task } : undefined,
      );
      const revision = (await memory.snapshot(ctx)).revision;
      console.log(
        values.json
          ? JSON.stringify({ memory_revision: revision, proposals }, null, 2)
          : [
              `memory revision ${revision}; ${proposals.length} proposal(s)`,
              ...proposals.map(renderProposal),
            ].join("\n"),
      );
      return;
    }
    const proposal =
      subcommand === "accept"
        ? await memory.acceptProposal(ctx, id, resolution)
        : subcommand === "reject"
          ? await memory.rejectProposal(
              ctx,
              id,
              values.reason as string,
              resolution,
            )
          : await memory.revertProposal(ctx, id, Number(expected), {
              ...resolution,
              ...(values.reason ? { reason: values.reason } : {}),
            });
    console.log(
      values.json
        ? JSON.stringify(proposal, null, 2)
        : renderProposal(proposal),
    );
  } catch (error) {
    if (error instanceof MemoryStoreError)
      throw new MemoryUsageError(
        `Memory proposal ${subcommand} failed: ${error.code}${error.code === "conflict" && error.details ? ` ${JSON.stringify(error.details)}` : ""}.`,
      );
    throw error;
  } finally {
    await memory.close();
  }
}

function parse(args: string[]) {
  return parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: {
      state: { type: "string" },
      source: { type: "string" },
      owner: { type: "string" },
      project: { type: "string" },
      workspace: { type: "string" },
      actor: { type: "string" },
      status: { type: "string" },
      task: { type: "string" },
      reason: { type: "string" },
      "expected-revision": { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
}
