import type { z } from "zod";
import type { ParamsSchema, ResultSchema } from "../main/protocol";

export const READ_METHODS = [
  "workbench.describe",
  "tasks.list",
  "tasks.inspect",
  "tasks.events",
  "tasks.artifact",
  "tasks.diff",
  "tasks.verification",
  "tasks.evidence",
  "tasks.journal",
] as const;

export type ReadMethod = (typeof READ_METHODS)[number];

const READ_METHOD_SET: ReadonlySet<string> = new Set(READ_METHODS);

export function isReadMethod(value: unknown): value is ReadMethod {
  return typeof value === "string" && READ_METHOD_SET.has(value);
}

export const BRIDGE_CHANNEL = "mars-shell:rpc";
export const BRIDGE_GLOBAL = "marsWorkbench";

export type ParamsFor<M extends ReadMethod> = z.infer<(typeof ParamsSchema)[M]>;
export type ResultFor<M extends ReadMethod> = z.infer<(typeof ResultSchema)[M]>;

export type DescribeResult = ResultFor<"workbench.describe">;
export type DiffResult = ResultFor<"tasks.diff">;
export type EvidenceResult = ResultFor<"tasks.evidence">;
export type ArtifactData = ResultFor<"tasks.artifact">;
export type InspectResult = ResultFor<"tasks.inspect">;
export type JournalResult = ResultFor<"tasks.journal">;

export type BridgeErrorKind =
  | "not_connected"
  | "refused"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "timeout"
  | "unavailable"
  | "protocol"
  | "invalid_response"
  | "hash_mismatch";

export type BridgeError = { kind: BridgeErrorKind; message: string };

export type BridgeResult<T> =
  | { ok: true; result: T }
  | { ok: false; error: BridgeError };

export const BRIDGE_ERROR_MESSAGES: Readonly<Record<BridgeErrorKind, string>> =
  Object.freeze({
    not_connected: "Not connected to a workbench.",
    refused: "Workbench request was refused.",
    unauthorized: "Workbench authentication failed.",
    forbidden: "Workbench request is not permitted.",
    not_found: "Workbench resource was not found.",
    conflict: "Workbench request conflicts with the current state.",
    timeout: "Workbench did not respond in time.",
    unavailable: "Workbench is unavailable.",
    protocol: "Workbench returned an invalid response.",
    invalid_response: "Workbench returned an invalid response.",
    hash_mismatch: "Workbench artifact failed integrity verification.",
  });

export function bridgeError(kind: BridgeErrorKind): BridgeError {
  return { kind, message: BRIDGE_ERROR_MESSAGES[kind] };
}

export function bridgeFailure(kind: BridgeErrorKind): {
  ok: false;
  error: BridgeError;
} {
  return { ok: false, error: bridgeError(kind) };
}

export type ShellBridge = {
  readonly [M in ReadMethod]: (
    params: ParamsFor<M>,
  ) => Promise<BridgeResult<ResultFor<M>>>;
};
