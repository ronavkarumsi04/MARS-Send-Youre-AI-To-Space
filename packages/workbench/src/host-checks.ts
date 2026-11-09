import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  HostCheckIdSchema,
  type HostCheckSummary,
  REQUIRED_CHECK_DEFAULT_TIMEOUT_MS,
  REQUIRED_CHECK_MAX_TIMEOUT_MS,
} from "@mars/contracts";
import { z } from "zod";

const relativePath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (path) =>
      !isAbsolute(path) &&
      !path.includes("\\") &&
      path
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".."),
    { message: "Check paths are relative, normalised workspace paths" },
  );

/**
 * A protected check the host operator defines. Clients and the model only
 * ever see `id`, `label` and `description`; the command and the protected
 * bytes are read from host-owned `source` files outside every workspace.
 */
export const HostCheckDefinitionSchema = z
  .object({
    id: HostCheckIdSchema,
    label: z.string().min(1).max(200),
    description: z.string().max(1024).optional(),
    argv: z.array(z.string().min(1).max(4096)).min(1).max(64),
    /** Written over the candidate copy; the candidate's own bytes at these paths never run. */
    protected_files: z
      .array(
        z.object({ path: relativePath, source: z.string().min(1) }).strict(),
      )
      .max(64)
      .default([]),
    /** Removed from the candidate copy (exact paths, or directory prefixes ending in `/`). */
    exclude_paths: z.array(z.string().min(1).max(1024)).max(64).default([]),
    timeout_ms: z
      .number()
      .int()
      .positive()
      .max(REQUIRED_CHECK_MAX_TIMEOUT_MS)
      .default(REQUIRED_CHECK_DEFAULT_TIMEOUT_MS),
  })
  .strict();
export type HostCheckDefinition = z.output<typeof HostCheckDefinitionSchema>;

export const HostChecksFileSchema = z
  .object({
    schema_version: z.literal(1),
    checks: z.array(HostCheckDefinitionSchema).max(64),
  })
  .strict()
  .refine(
    (file) =>
      new Set(file.checks.map((check) => check.id)).size === file.checks.length,
    { message: "Host check ids are unique" },
  );

/** A definition with its protected bytes loaded and its identity digest computed. */
export interface ResolvedHostCheck {
  definition: HostCheckDefinition;
  sha256: string;
  overlay: { path: string; data: Uint8Array }[];
}

const sha256 = (data: Uint8Array | string) =>
  createHash("sha256").update(data).digest("hex");

/** Reads a host checks file; relative `source` paths resolve against the file's directory. */
export async function loadHostChecks(
  file: string,
): Promise<HostCheckDefinition[]> {
  const parsed = HostChecksFileSchema.parse(
    JSON.parse(await readFile(file, "utf8")),
  );
  return parsed.checks.map((check) => ({
    ...check,
    protected_files: check.protected_files.map((entry) => ({
      path: entry.path,
      source: resolve(dirname(file), entry.source),
    })),
  }));
}

export function summarizeHostChecks(
  checks: readonly HostCheckDefinition[],
): HostCheckSummary[] {
  return checks.map((check) => ({
    id: check.id,
    label: check.label,
    ...(check.description ? { description: check.description } : {}),
  }));
}

/**
 * Loads the protected bytes and digests the full definition (command,
 * paths, exclusions, timeout and every protected file's bytes), so a
 * verdict names exactly which check it answers.
 */
export async function resolveHostCheck(
  definition: HostCheckDefinition,
): Promise<ResolvedHostCheck> {
  const overlay = await Promise.all(
    definition.protected_files.map(async (entry) => ({
      path: entry.path,
      data: new Uint8Array(await readFile(entry.source)),
    })),
  );
  const digest = sha256(
    JSON.stringify({
      id: definition.id,
      argv: definition.argv,
      exclude_paths: definition.exclude_paths,
      timeout_ms: definition.timeout_ms,
      protected_files: overlay.map((file) => ({
        path: file.path,
        sha256: sha256(file.data),
      })),
    }),
  );
  return { definition, sha256: digest, overlay };
}

/** True when `path` is one the check owns: protected, or excluded from the copy. */
export function checkOwnsPath(
  definition: HostCheckDefinition,
  path: string,
): boolean {
  return (
    definition.protected_files.some((entry) => entry.path === path) ||
    definition.exclude_paths.some((rule) =>
      rule.endsWith("/") ? path.startsWith(rule) : path === rule,
    )
  );
}
