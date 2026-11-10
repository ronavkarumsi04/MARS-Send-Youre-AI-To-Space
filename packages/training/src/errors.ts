export type TrainingErrorCode =
  | "invalid_input"
  | "manifest_missing"
  | "manifest_invalid"
  | "not_ready"
  | "artifact_missing"
  | "artifact_digest_mismatch"
  | "record_malformed"
  | "job_not_found"
  | "capacity_exhausted"
  | "worker_unavailable"
  | "worker_protocol"
  | "budget_invalid";

export class TrainingError extends Error {
  constructor(
    readonly code: TrainingErrorCode,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "TrainingError";
  }
}
