import { join } from "node:path";
import { parseArgs } from "node:util";
import type {
  SkillMutationOptions,
  SkillProposal,
  SkillRecord,
} from "@mars/contracts";
import { SkillError, SkillStore } from "@mars/skills";
import { CliUsageError } from "./cli-errors";
import { resolveWorkbenchLocation } from "./workbench-location";

export const SKILLS_USAGE = [
  "Usage: mars skills <command> [ARGS] [--state PRIVATE_DIR] [--source DIR] [--project ID] [--actor ID] [--json]",
  "  list [--all]                          live skills (--all includes archived) and the store revision",
  "  show NAME                             one skill with its content",
  "  versions NAME                         saved versions of a skill",
  "  restore-version NAME VERSION_ID       bring back a saved version (the current one is versioned first)",
  "  pin NAME | unpin NAME                 exempt a skill from curation, or stop exempting it",
  "  archive NAME | restore NAME           archive a skill (nothing is deleted) or bring it back",
  "  proposals [--status pending|accepted|rejected]  proposals from background review",
  "  accept PROPOSAL_ID                    apply a pending proposal; fails if a skill it targets changed since it was made",
  "  reject PROPOSAL_ID --reason TEXT      close a pending proposal without writing skills",
  "  undo REVIEW_ID                        undo every skill change one background review made; fails if a touched skill changed since",
  "  curate                                mark idle skills stale (14 days) and archive them (30 days); pinned skills are exempt",
  "  Changes are recorded with --actor (default: local). Defaults match mars serve: --project project-<sha256(source)>, --state ~/.mars/workbench/<project>.",
].join("\n");

export class SkillsUsageError extends CliUsageError {}

const COMMANDS: Record<string, number> = {
  list: 0,
  show: 1,
  versions: 1,
  "restore-version": 2,
  pin: 1,
  unpin: 1,
  archive: 1,
  restore: 1,
  proposals: 0,
  accept: 1,
  reject: 1,
  undo: 1,
  curate: 0,
};
const STATUSES = ["pending", "accepted", "rejected"] as const;

function renderSkill(skill: SkillRecord): string {
  const flags = [skill.status, skill.pinned ? "pinned" : null]
    .filter(Boolean)
    .join(", ");
  return `${skill.name} [${flags}] used ${skill.useCount}×, last activity ${new Date(skill.lastActivity).toISOString()}`;
}

// Keeps proposed text from moving the cursor or recoloring the operator's terminal.
function isControl(char: string): boolean {
  const code = char.charCodeAt(0);
  return (
    (code < 0x20 && char !== "\n" && char !== "\t") ||
    (code >= 0x7f && code <= 0x9f)
  );
}

export function renderSkillProposal(proposal: SkillProposal): string {
  // Operators must see the exact instructions they would accept.
  const ops = proposal.ops.map((op) =>
    "content" in op && typeof op.content === "string"
      ? [
          `    ${op.op} ${op.name}:`,
          ...op.content
            .split("")
            .map((c) => (isControl(c) ? "\uFFFD" : c))
            .join("")
            .split("\n")
            .map((line) => `      | ${line}`),
        ].join("\n")
      : `    ${op.op} ${"name" in op ? op.name : ""}`,
  );
  return [
    `${proposal.id} [${proposal.status}] ${proposal.rationale}`,
    `    from ${proposal.source}; store revision ${proposal.expectedRevision.slice(0, 12)}${proposal.reason ? `; reason: ${proposal.reason}` : ""}`,
    ...ops,
  ].join("\n");
}

export async function runSkills(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (!command || command === "help" || command === "--help") {
    console.log(SKILLS_USAGE);
    return;
  }
  const arity = COMMANDS[command];
  if (arity === undefined || !Object.hasOwn(COMMANDS, command))
    throw new SkillsUsageError(
      `Unknown skills command "${command}".\n${SKILLS_USAGE}`,
    );
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(rest);
  } catch (error) {
    throw new SkillsUsageError(
      `${error instanceof Error ? error.message : "Invalid options."}\n${SKILLS_USAGE}`,
    );
  }
  const { values, positionals } = parsed;
  if (values.help) {
    console.log(SKILLS_USAGE);
    return;
  }
  if (positionals.length !== arity || positionals.some((p) => !p.trim()))
    throw new SkillsUsageError(
      `mars skills ${command} takes ${arity} argument(s).\n${SKILLS_USAGE}`,
    );
  const status = values.status as (typeof STATUSES)[number] | undefined;
  if (status !== undefined && !STATUSES.includes(status))
    throw new SkillsUsageError(
      `--status must be one of ${STATUSES.join(", ")}.`,
    );
  if (command === "reject" && !values.reason?.trim())
    throw new SkillsUsageError(
      `mars skills reject requires --reason.\n${SKILLS_USAGE}`,
    );
  const { state } = await resolveWorkbenchLocation({
    source: values.source,
    project: values.project,
    state: values.state,
  });
  const store = new SkillStore(join(state, "skills"));
  const actor = values.actor ?? "local";
  const options: SkillMutationOptions = { actor, source: "operator" };
  const [first = "", second = ""] = positionals;
  const print = (json: unknown, text: string) =>
    console.log(values.json ? JSON.stringify(json, null, 2) : text);
  try {
    switch (command) {
      case "list": {
        const skills = (await store.list()).filter(
          (skill) => values.all || skill.status !== "archived",
        );
        const revision = await store.getRevision();
        print(
          { revision, skills },
          [
            `skill store revision ${revision.slice(0, 12)}; ${skills.length} skill(s)`,
            ...skills.map(renderSkill),
          ].join("\n"),
        );
        return;
      }
      case "show": {
        const skill = await store.get(first);
        if (!skill) throw new SkillsUsageError(`No skill named "${first}".`);
        print(skill, `${renderSkill(skill)}\n\n${skill.content}`);
        return;
      }
      case "versions": {
        const versions = await store.listVersions(first);
        print(
          versions,
          versions.length
            ? versions
                .map(
                  (v) =>
                    `${v.id} ${v.ts} before ${v.op} (${v.skill.status}, ${v.skill.content.length} chars)`,
                )
                .join("\n")
            : `No saved versions of ${first}.`,
        );
        return;
      }
      case "proposals": {
        const proposals = (await store.listProposals()).filter(
          (p) => status === undefined || p.status === status,
        );
        print(
          proposals,
          [
            `${proposals.length} proposal(s)`,
            ...proposals.map(renderSkillProposal),
          ].join("\n"),
        );
        return;
      }
      case "reject": {
        await store.reject(first, values.reason as string, options);
        const proposal = (await store.listProposals()).find(
          (p) => p.id === first,
        );
        print(proposal, proposal ? renderSkillProposal(proposal) : first);
        return;
      }
      case "undo":
      case "curate": {
        const changes =
          command === "undo"
            ? await store.undoReview(first, options)
            : await store.runCurator({ actor, source: "curator" });
        print(
          changes,
          changes.length
            ? changes.map((c) => `${c.op} ${c.skill ?? ""}`.trim()).join("\n")
            : "Nothing to change.",
        );
        return;
      }
    }
    const revision =
      command === "restore-version"
        ? await store.restoreVersion(first, second, options)
        : command === "pin" || command === "unpin"
          ? await store.pin(first, command === "pin", options)
          : command === "archive"
            ? await store.archive(first, options)
            : command === "restore"
              ? await store.restore(first, options)
              : await store.accept(first, options);
    print(
      { revision },
      `${command} ${first}: skill store revision ${revision.slice(0, 12)}`,
    );
  } catch (error) {
    if (error instanceof SkillError)
      throw new SkillsUsageError(
        `Skills ${command} failed: ${error.code}: ${error.message}.`,
      );
    throw error;
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
      project: { type: "string" },
      actor: { type: "string" },
      status: { type: "string" },
      reason: { type: "string" },
      all: { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
}
