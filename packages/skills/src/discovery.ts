/**
 * Skill-folder discovery for a trusted project checkout. Loads
 * `skills/<name>/SKILL.md` (plus the vendored `skills/vendor/<vendor>/<name>/SKILL.md`
 * layout used by this repository), `.claude/skills/<name>/SKILL.md`,
 * `.codex/skills/<name>/SKILL.md` and `.agents/skills/<name>/SKILL.md`.
 *
 * Only the file layout and frontmatter keys follow the Claude Code / Codex CLI
 * conventions; no upstream source is used. Discovery is read-only, offline,
 * bounded (skill count and bytes per file) and never executes anything.
 */
import { join } from "node:path";
import type { SkillRecord } from "@mars/contracts";
import { scanThreat } from "@mars/memory";
import { CheckoutFS } from "./checkout-fs";
import type {
  DiscoveredSkill,
  SkillDiscoveryResult,
  SkillSource,
} from "./conventions-types";
import { parseImportedFrontmatter } from "./frontmatter";
import { readSkillsLock, skillProvenance } from "./provenance";

export interface SkillDiscoveryOptions {
  /** Absolute path of the trusted checkout. */
  root: string;
  /** Maximum number of skills loaded; later files are recorded as skipped. */
  maxSkills?: number;
  /** Maximum size of one SKILL.md in bytes; larger files are skipped. */
  maxContentBytes?: number;
}

export interface SkillDiscoveryWarning {
  path: string;
  message: string;
}

/** `SkillDiscoveryResult` plus non-fatal findings (for example a frontmatter name that differs from its folder). */
export interface SkillDiscoveryReport extends SkillDiscoveryResult {
  warnings: SkillDiscoveryWarning[];
}

export const DEFAULT_MAX_SKILLS = 256;
export const DEFAULT_MAX_SKILL_BYTES = 64 * 1024;
export const SKILL_FILE = "SKILL.md";
export const SKILL_SOURCES: readonly SkillSource[] = [
  "skills",
  ".claude/skills",
  ".codex/skills",
  ".agents/skills",
];
/** Same rule as the lifecycle store. */
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const RESERVED_NAMES = new Set(["constructor", "prototype", "__proto__"]);

export function isValidSkillName(name: string): boolean {
  return SKILL_NAME_PATTERN.test(name) && !RESERVED_NAMES.has(name);
}

const posix = (...parts: string[]) => parts.join("/");

/** Candidate skill folders for one source: `[relative folder, folder name]`, deterministic. */
async function candidateFolders(
  fs: CheckoutFS,
  source: SkillSource,
): Promise<Array<{ relative: string; folder: string }>> {
  const out: Array<{ relative: string; folder: string }> = [];
  const base = source;
  for (const name of (await fs.directory(base)) ?? []) {
    if (name.startsWith(".")) continue;
    if (!(await fs.directory(join(base, name)))) continue;
    out.push({ relative: posix(source, name), folder: name });
  }
  if (source === "skills") {
    const vendor = join(base, "vendor");
    for (const vendorName of (await fs.directory(vendor)) ?? []) {
      if (vendorName.startsWith(".")) continue;
      const vendorDir = join(vendor, vendorName);
      for (const name of (await fs.directory(vendorDir)) ?? []) {
        if (name.startsWith(".")) continue;
        if (!(await fs.directory(join(vendorDir, name)))) continue;
        out.push({
          relative: posix(source, "vendor", vendorName, name),
          folder: name,
        });
      }
    }
  }
  return out;
}

export async function discoverSkills(
  options: SkillDiscoveryOptions,
): Promise<SkillDiscoveryReport> {
  const maxSkills = options.maxSkills ?? DEFAULT_MAX_SKILLS;
  const maxBytes = options.maxContentBytes ?? DEFAULT_MAX_SKILL_BYTES;
  if (!Number.isInteger(maxSkills) || maxSkills < 0)
    throw new RangeError("maxSkills must be a non-negative integer");
  if (!Number.isInteger(maxBytes) || maxBytes < 1)
    throw new RangeError("maxContentBytes must be a positive integer");
  const report: SkillDiscoveryReport = {
    skills: [],
    shadowed: [],
    skipped: [],
    warnings: [],
  };
  const byName = new Map<string, DiscoveredSkill>();
  const seenPaths = new Set<string>();
  const fs = await CheckoutFS.open(options.root);
  try {
    let lock: Awaited<ReturnType<typeof readSkillsLock>> = new Map();
    let invalidLock = false;
    try {
      lock = await readSkillsLock(fs);
    } catch {
      invalidLock = true;
      report.warnings.push({
        path: "skills-lock.json",
        message:
          "Invalid or unsupported skills-lock.json; provenance is unverified (only version 2 is supported).",
      });
    }
    for (const source of SKILL_SOURCES) {
      for (const { relative, folder } of await candidateFolders(fs, source)) {
        const path = posix(relative, SKILL_FILE);
        const entry = await fs.entry(path);
        if (!entry) continue;
        const realPath = entry.path;
        const isFile = (await entry.handle.stat()).isFile();
        await entry.handle.close();
        if (seenPaths.has(realPath)) continue;
        seenPaths.add(realPath);
        if (!isFile) {
          report.skipped.push({ path, reason: "not-file" });
          continue;
        }
        if (report.skills.length >= maxSkills) {
          report.skipped.push({ path, reason: "limit" });
          continue;
        }
        const read = await fs.read(realPath, maxBytes);
        if ("reason" in read) {
          report.skipped.push({ path, reason: read.reason });
          continue;
        }
        let content: string;
        try {
          content = new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: true,
          }).decode(read.data);
        } catch {
          report.skipped.push({ path, reason: "encoding" });
          continue;
        }
        const bytes = read.data.length;
        const threat = scanThreat(content);
        if (threat) {
          report.skipped.push({ path, reason: `threat:${threat}` });
          continue;
        }
        const frontmatter = parseImportedFrontmatter(content);
        if (!frontmatter) {
          report.skipped.push({ path, reason: "frontmatter" });
          report.warnings.push({
            path,
            message:
              "Unsupported frontmatter: require scalar name/description; only description block scalars and ignored optional metadata/lists are supported; YAML anchors, aliases and tags are forbidden.",
          });
          continue;
        }
        const name = frontmatter.name?.trim() ?? "";
        const description = frontmatter.description?.trim() ?? "";
        if (!name || !description) {
          report.skipped.push({ path, reason: "missing-name-or-description" });
          continue;
        }
        if (!isValidSkillName(name)) {
          report.skipped.push({ path, reason: "invalid-name" });
          continue;
        }
        if (name !== folder)
          report.warnings.push({
            path,
            message: `frontmatter name "${name}" differs from folder "${folder}"`,
          });
        const existing = byName.get(name);
        if (existing) {
          report.shadowed.push({ name, path, shadowed_by: existing.path });
          continue;
        }
        const provenance = await skillProvenance(fs, relative, folder, lock);
        if (invalidLock) provenance.status = "unverified";
        if (
          provenance.status === "modified" ||
          provenance.status === "unverified"
        )
          report.warnings.push({
            path,
            message:
              provenance.status === "modified"
                ? "Skill modified: computedHash does not match skills-lock.json; remains untrusted."
                : "Skill provenance unverified: invalid lock or hash resource limit/unreadable files; remains untrusted.",
          });
        const skill: DiscoveredSkill = {
          name,
          description,
          path,
          source,
          content,
          bytes,
          frontmatter: { ...frontmatter },
          provenance,
        };
        byName.set(name, skill);
        report.skills.push(skill);
      }
    }
    return report;
  } finally {
    await fs.close();
  }
}

/**
 * Adapts discovered skills to the lifecycle `SkillRecord` shape so the host can
 * freeze them like store skills. Repository skills are always `active`,
 * unpinned, with epoch timestamps and no usage history.
 */
export function toSkillRecords(
  discovered: readonly DiscoveredSkill[] | SkillDiscoveryResult,
): SkillRecord[] {
  const skills: readonly DiscoveredSkill[] =
    "skills" in discovered ? discovered.skills : discovered;
  return skills.map((skill) => ({
    name: skill.name,
    content: skill.content,
    status: "active",
    pinned: false,
    createdAt: 0,
    lastActivity: 0,
    useCount: 0,
  }));
}
