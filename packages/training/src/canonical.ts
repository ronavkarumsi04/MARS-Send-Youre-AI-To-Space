import { canonicalJson, sha256 } from "@mars/specialists";

export { canonicalJson, sha256 };

export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
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
