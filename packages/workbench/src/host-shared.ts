import { randomUUID } from "node:crypto";
import type { RequestContext, Scope } from "@mars/contracts";
import type { AppendEventInput } from "@mars/tasks";

export const WORKBENCH_PACKAGE_VERSION = "0.0.1";
export const WORKBENCH_PRODUCER = "@mars/workbench";

export function workbenchEvent(
  payload: unknown,
  runId: string = randomUUID(),
  extra: Pick<AppendEventInput, "source_event_ids" | "usage"> = {},
): AppendEventInput {
  return {
    event_type: "tool.completed",
    producer: WORKBENCH_PRODUCER,
    run_id: runId,
    versions: [
      { component: WORKBENCH_PRODUCER, revision: WORKBENCH_PACKAGE_VERSION },
    ],
    ...extra,
    payload,
  };
}

/** The `code` property of a thrown value, whatever its shape. */
export function errorCodeOf(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}

export function internalContext(scope: Scope): RequestContext {
  return { schema_version: 1, scope, request_id: randomUUID() };
}
