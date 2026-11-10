export type EvolutionErrorCode =
  | "invalid_input"
  | "not_found"
  | "scope_denied"
  | "conflict"
  | "stale_revision"
  | "stale_lease"
  | "invalid_state"
  | "budget_exhausted"
  | "over_budget"
  | "deadline_exceeded"
  | "protected_path"
  | "unsafe_patch"
  | "patch_failed"
  | "build_failed"
  | "tamper_detected"
  | "accounting_tampered"
  | "holdout_leak"
  | "split_violation"
  | "evaluator_mismatch"
  | "irreproducible"
  | "unsafe_path"
  | "corrupt_record"
  | "closed";

export class EvolutionError extends Error {
  readonly code: EvolutionErrorCode;
  readonly detail: string | undefined;

  constructor(code: EvolutionErrorCode, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = "EvolutionError";
    this.code = code;
    this.detail = detail;
  }
}

export function fail(code: EvolutionErrorCode, detail?: string): never {
  throw new EvolutionError(code, detail);
}
