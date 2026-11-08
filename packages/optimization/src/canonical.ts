import {
  sha256,
  canonicalJson as sharedCanonicalJson,
} from "@mars/contracts/canonical";

export { sha256 };

/** Sorted-key JSON without undefined members; stable across host and worker. */
export function canonicalJson(value: unknown): string {
  return sharedCanonicalJson(value, {
    undefinedMembers: "omit",
    keyOrder: "integer-keys-first",
  });
}

/** Candidate ids are content-addressed so the same components always map to one record. */
export function candidateId(components: Record<string, string>): string {
  return `cand-${sha256(canonicalJson(components)).slice(0, 24)}`;
}

export function scopeKey(scope: {
  owner_id: string;
  project_id: string;
  workspace_id?: string | undefined;
}): string {
  return sha256(
    canonicalJson({
      owner_id: scope.owner_id,
      project_id: scope.project_id,
      workspace_id: scope.workspace_id ?? null,
    }),
  ).slice(0, 32);
}
