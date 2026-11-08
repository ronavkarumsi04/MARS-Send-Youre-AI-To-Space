import { canonicalJson } from "@mars/contracts/canonical";

export { sha256 } from "@mars/contracts/canonical";

export function canonicalJSON(value: unknown): string {
  return canonicalJson(value);
}
export function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function frozenClone<T>(value: T): T {
  return freeze(structuredClone(value));
}
