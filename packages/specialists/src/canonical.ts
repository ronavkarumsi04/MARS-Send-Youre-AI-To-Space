import path from "node:path";
import { containsSecretToken } from "@mars/contracts";
import {
  sha256,
  canonicalJson as sharedCanonicalJson,
} from "@mars/contracts/canonical";
import { SpecialistRegistryError } from "./errors";

export { sha256 };

export function canonicalJson(value: unknown): string {
  return sharedCanonicalJson(value, {
    keyOrder: "integer-keys-first",
    error: () => new SpecialistRegistryError("invalid_input", "invalid_json"),
  });
}

export function scopeKey(scope: {
  owner_id: string;
  project_id: string;
  workspace_id?: string | undefined;
}): string {
  return canonicalJson({
    owner_id: scope.owner_id,
    project_id: scope.project_id,
    workspace_id: scope.workspace_id ?? null,
  });
}

export function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

const pathSegmentChar = /[A-Za-z0-9._~-]/;

function containsRootAtBoundary(text: string, root: string): boolean {
  let index = text.indexOf(root);
  while (index !== -1) {
    const next = text[index + root.length];
    if (next === undefined || !pathSegmentChar.test(next)) return true;
    index = text.indexOf(root, index + 1);
  }
  return false;
}

export function assertPublishable(
  value: unknown,
  options: { rootDir?: string; hostPrivateRoots?: readonly string[] } = {},
): void {
  let serialized: string;
  try {
    serialized = canonicalJson(value);
  } catch {
    throw new SpecialistRegistryError("unsafe_content", "invalid_json");
  }
  if (
    containsSecretToken(serialized) ||
    (options.rootDir !== undefined &&
      containsRootAtBoundary(serialized, path.resolve(options.rootDir))) ||
    (options.hostPrivateRoots ?? []).some((root) =>
      containsRootAtBoundary(serialized, path.resolve(root)),
    )
  ) {
    throw new SpecialistRegistryError("unsafe_content", "publishability");
  }
}

export function withoutAttestation<T extends { attestation: unknown }>(
  document: T,
): Omit<T, "attestation"> {
  const { attestation: _attestation, ...unsigned } = document;
  return unsigned;
}

export function candidateDigest<T extends { evaluation: unknown }>(
  registration: T,
): string {
  const candidate = { ...registration } as Record<string, unknown>;
  delete candidate.evaluation;
  return sha256(canonicalJson(candidate));
}

export function decisionDigest(decision: Record<string, unknown>): string {
  const {
    decision_id: _decisionId,
    created_at: _createdAt,
    decision_sha256: _decisionSha256,
    retry_of: _retryOf,
    attempt: _attempt,
    ...stable
  } = decision;
  return sha256(canonicalJson(stable));
}
