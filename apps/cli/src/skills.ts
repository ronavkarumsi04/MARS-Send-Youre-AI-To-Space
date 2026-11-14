import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type {
  SkillMutationOptions,
  SkillProposal,
  SkillRecord,
} from "@mars/contracts";
import {
  acceptWithGate,
  describeGate,
  discoverSkills,
  evaluateSkillGate,
  GATE_POLICY,
  GateTrialsSchema,
  SkillError,
  type SkillEvidenceEntry,
  type SkillGateResult,
  SkillOutcomeLedger,
  type SkillProvenance,
  SkillStore,
  skillEvidenceReport,
} from "@mars/skills";
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
  "  gate PROPOSAL_ID --trials FILE --evidence ID[,ID...]  run the held-out A/B gate on a JSON trials file and save the verdict",
  "  gates PROPOSAL_ID                     saved gate verdicts and overrides for a proposal",
  "  trials NAME --trials FILE [--scope KEY]  save held-out pairs for any skill",
  "  report [NAME] [--scope KEY] [--json]   verified solve-rate and cost evidence",
  "  accept PROPOSAL_ID [--without-gate --reason TEXT]  apply a pending proposal; one that creates or updates a skill needs a passing gate verdict (or --without-gate with a reason, which is recorded); fails if a skill it targets changed since it was made (proposals saved before per-skill checks: if any skill changed)",
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
  gate: 1,
  gates: 1,
  trials: 1,
  report: 0,
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

function renderGate(result: SkillGateResult): string {
  return [
    `${result.passed ? "passed" : `failed (${result.reasons.join(", ")})`}: ${result.wins} won, ${result.losses} lost, ${result.ties} tied of ${result.trials} held-out task(s)`,
    `    pass rate ${(result.baseline_rate * 100).toFixed(1)}% -> ${(result.candidate_rate * 100).toFixed(1)}%; p=${result.p_value.toPrecision(3)} (alpha ${result.options?.alpha ?? "?"}); cost ratio ${result.cost_ratio.toFixed(2)}; digest ${result.digest}`,
  ].join("\n");
}

function renderEvidence(entry: SkillEvidenceEntry): string {
  const number = (value: number | null) =>
    value === null ? "unknown" : value.toPrecision(4);
  const side = (label: string, value: SkillEvidenceEntry["with"]) =>
    `  ${label}: tasks=${value.tasks}, verified=${value.verified}, rate=${number(value.rate)} Wilson 95% [${number(value.interval.lower)}, ${number(value.interval.upper)}]; cost per verified solve=${number(value.cost_per_verified_solve)}`;
  const h = entry.held_out;
  const p = entry.policy;
  return [
    `${entry.skill} scope=${JSON.stringify(entry.scope_key)} provenance=${JSON.stringify(entry.provenance)}`,
    side("with", entry.with),
    side("without", entry.without),
    `  difference=${number(entry.difference)}`,
    `  held-out trials=${h.trials}, wins=${h.wins}, losses=${h.losses}, ties=${h.ties}, discordant=${h.discordant}; p (helps)=${number(h.p_value)}, p (hurts)=${number(h.p_value_hurts)}, cost ratio=${h.cost_ratio_infinite ? "Infinity" : number(h.cost_ratio)}`,
    `  verdict=${entry.verdict}; reasons=${h.reasons.join(", ") || "none"}`,
    `  policy: alpha=${p.alpha}, min_trials=${p.min_trials}, max_regressions=${p.max_regressions}, max_cost_ratio=${p.max_cost_ratio}`,
  ].join("\n");
}

export function renderSkillProposal(
  proposal: SkillProposal,
  gate?: string,
): string {
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
    ...(gate === undefined ? [] : [`    gate: ${gate}`]),
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
  if (
    (command === "report"
      ? positionals.length > 1
      : positionals.length !== arity) ||
    positionals.some((p) => !p.trim())
  )
    throw new SkillsUsageError(
      `mars skills ${command} takes ${arity} argument(s).\n${SKILLS_USAGE}`,
    );
  const status = values.status as (typeof STATUSES)[number] | undefined;
  if (status !== undefined && !STATUSES.includes(status))
    throw new SkillsUsageError(
      `--status must be one of ${STATUSES.join(", ")}.`,
    );
  if (
    (command === "reject" || values["without-gate"]) &&
    !values.reason?.trim()
  )
    throw new SkillsUsageError(
      `mars skills ${command}${values["without-gate"] ? " --without-gate" : ""} requires --reason.\n${SKILLS_USAGE}`,
    );
  if (values["without-gate"] && command !== "accept")
    throw new SkillsUsageError(
      `--without-gate only applies to accept.\n${SKILLS_USAGE}`,
    );
  if (command === "gate" && (!values.trials || !values.evidence?.trim()))
    throw new SkillsUsageError(
      `mars skills gate requires --trials and --evidence.\n${SKILLS_USAGE}`,
    );
  if (command === "trials" && !values.trials)
    throw new SkillsUsageError("mars skills trials requires --trials.");
  const { state, source } = await resolveWorkbenchLocation({
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
  let outcomes: SkillOutcomeLedger | undefined;
  // Same private ledger mars serve writes (<state>/skill-outcomes/outcomes.sqlite).
  const ledger = () => {
    outcomes ??= new SkillOutcomeLedger(
      join(state, "skill-outcomes", "outcomes.sqlite"),
    );
    return outcomes;
  };
  try {
    switch (command) {
      case "trials": {
        const knownScopes = [
          ...new Set(
            [...ledger().outcomes(), ...ledger().trials()].map(
              (row) => row.scope_key,
            ),
          ),
        ].sort();
        const scope =
          values.scope ??
          (knownScopes.length === 1 ? knownScopes[0] : undefined);
        if (scope === undefined)
          throw new SkillsUsageError(
            `Specify --scope; known scopes: ${knownScopes.length ? knownScopes.map((key) => JSON.stringify(key)).join(", ") : "(none)"}.`,
          );
        try {
          const trials = GateTrialsSchema.parse(
            JSON.parse(await readFile(values.trials as string, "utf8")),
          );
          ledger().recordTrials(scope, first, trials);
          print(
            { skill: first, scope_key: scope, trials: trials.length },
            `Recorded ${trials.length} held-out trial(s) for ${first} in scope ${JSON.stringify(scope)}.`,
          );
        } catch (error) {
          throw new SkillsUsageError(
            `Invalid trials file ${values.trials}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return;
      }
      case "report": {
        const provenance = new Map<string, SkillProvenance>();
        for (const skill of (await discoverSkills({ root: source })).skills)
          provenance.set(skill.name, {
            origin: skill.source,
            path: skill.path,
          });
        for (const skill of await store.list())
          provenance.set(skill.name, { origin: "store" });
        const entries = skillEvidenceReport({
          outcomes: ledger().outcomes(values.scope),
          trials: ledger().trials(values.scope),
          provenance: [...provenance].map(([skill, provenance]) => ({
            skill,
            provenance,
          })),
        }).filter((entry) => !first || entry.skill === first);
        print(
          entries,
          entries.length
            ? entries.map(renderEvidence).join("\n\n")
            : "No evidence recorded.",
        );
        return;
      }
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
        const gates = proposals.map((p) => describeGate(p, ledger()));
        print(
          proposals.map((p, i) => ({ ...p, gate: gates[i] })),
          [
            `${proposals.length} proposal(s)`,
            ...proposals.map((p, i) => renderSkillProposal(p, gates[i])),
          ].join("\n"),
        );
        return;
      }
      case "gate": {
        const proposal = (await store.listProposals()).find(
          (p) => p.id === first,
        );
        if (!proposal || proposal.status !== "pending")
          throw new SkillsUsageError(`No pending proposal "${first}".`);
        let trials: ReturnType<typeof GateTrialsSchema.parse>;
        try {
          trials = GateTrialsSchema.parse(
            JSON.parse(await readFile(values.trials as string, "utf8")),
          );
        } catch (error) {
          throw new SkillsUsageError(
            `Invalid trials file ${values.trials}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const result = evaluateSkillGate(
          {
            proposal_id: first,
            evidence_task_ids: (values.evidence as string)
              .split(",")
              .map((id) => id.trim()),
            trials,
          },
          GATE_POLICY,
        );
        ledger().recordGate(result);
        print(result, `gate ${first} ${renderGate(result)}`);
        return;
      }
      case "gates": {
        const verdicts = ledger().gates(first);
        const overrides = ledger().gateOverrides(first);
        print(
          { gates: verdicts, overrides },
          [
            `${verdicts.length} gate verdict(s), ${overrides.length} override(s) for ${first}`,
            ...verdicts.map(renderGate),
            ...overrides.map(
              (o) =>
                `override requested by ${o.actor} at ${new Date(o.recorded_at).toISOString()}: ${o.reason}`,
            ),
          ].join("\n"),
        );
        return;
      }
      case "accept": {
        const accepted = await acceptWithGate(
          store,
          ledger(),
          first,
          options,
          values["without-gate"]
            ? { reason: values.reason as string }
            : undefined,
        );
        print(
          accepted,
          `accept ${first}: skill store revision ${accepted.revision.slice(0, 12)}; gate ${
            accepted.gate
              ? `passed (${accepted.gate.digest.slice(0, 12)})`
              : accepted.overridden
                ? "skipped (recorded)"
                : "not required"
          }`,
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
            : await store.restore(first, options);
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
  } finally {
    outcomes?.close();
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
      trials: { type: "string" },
      scope: { type: "string" },
      evidence: { type: "string" },
      "without-gate": { type: "boolean" },
      all: { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
}
