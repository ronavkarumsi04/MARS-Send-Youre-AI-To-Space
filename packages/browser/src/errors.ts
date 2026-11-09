export type BrowserErrorCode =
  | "invalid_input"
  | "not_found"
  | "conflict"
  | "forbidden"
  | "stale_revision"
  | "invalid_state"
  | "lease_lost"
  | "cancelled"
  | "deadline_exceeded"
  | "budget_exceeded"
  | "evidence_rejected"
  | "corrupt_record"
  | "unsafe_path"
  | "closed";

export class BrowserError extends Error {
  readonly code: BrowserErrorCode;

  constructor(code: BrowserErrorCode, message: string) {
    super(message);
    this.name = "BrowserError";
    this.code = code;
  }
}

/** A failure the control plane may retry on a fresh attempt (fresh browser). */
export class RetryableBrowserError extends Error {}
