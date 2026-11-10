import { createHash } from "node:crypto";
import {
  ArtifactRefSchema,
  type RequestContext,
  VERIFICATION_EVIDENCE_OPERATION,
  type VerificationEvidenceRecord,
  VerificationEvidenceRecordSchema,
} from "@mars/contracts";
import type { DurableTaskStore } from "@mars/tasks";
import type { VerifiedExample } from "./builder";

const WORKBENCH_PRODUCER = "@mars/workbench";

export type SkipReason =
  | "not-completed"
  | "unverified"
  | "latest-verdict-not-verified"
  | "verdict-not-patch-bound"
  | "no-exported-tested-patch";

export interface CollectResult {
  examples: VerifiedExample[];
  skipped: { task_id: string; reason: SkipReason }[];
}

/**
 * Reads completed tasks whose newest host verdict is `verified` and bound to a
 * patch digest, and pairs each with the exported patch whose bytes hash to
 * exactly that digest. Agent claims, Watch records and unexported or
 * different patches never become examples.
 */
export async function collectVerifiedExamples(
  store: Pick<DurableTaskStore, "list" | "events" | "artifacts">,
  context: RequestContext,
): Promise<CollectResult> {
  const examples: VerifiedExample[] = [];
  const skipped: CollectResult["skipped"] = [];
  for (const task of await store.list(context)) {
    if (task.status !== "completed") {
      skipped.push({ task_id: task.task_id, reason: "not-completed" });
      continue;
    }
    let latest: VerificationEvidenceRecord | null = null;
    const exported: Uint8Array[] = [];
    for await (const event of store.events(context, task.task_id)) {
      if (
        event.event_type !== "tool.completed" ||
        event.producer !== WORKBENCH_PRODUCER
      )
        continue;
      let payload: unknown;
      try {
        payload = JSON.parse(
          new TextDecoder().decode(
            await store.artifacts.get(context, event.payload),
          ),
        );
      } catch {
        continue;
      }
      if (!payload || typeof payload !== "object") continue;
      const operation = (payload as { operation?: unknown }).operation;
      if (operation === VERIFICATION_EVIDENCE_OPERATION) {
        const record = VerificationEvidenceRecordSchema.safeParse(payload);
        if (record.success && record.data.task_id === task.task_id)
          latest = record.data;
      } else if (operation === "patch.exported") {
        const artifact = ArtifactRefSchema.safeParse(
          (payload as { artifact?: unknown }).artifact,
        );
        if (artifact.success)
          exported.push(await store.artifacts.get(context, artifact.data));
      }
    }
    const reason: SkipReason | null = !latest
      ? "unverified"
      : !latest.verified
        ? "latest-verdict-not-verified"
        : !latest.patch_sha256
          ? "verdict-not-patch-bound"
          : null;
    if (reason || !latest?.patch_sha256) {
      skipped.push({ task_id: task.task_id, reason: reason ?? "unverified" });
      continue;
    }
    const digest = latest.patch_sha256;
    const patch = exported.find(
      (bytes) => createHash("sha256").update(bytes).digest("hex") === digest,
    );
    if (!patch) {
      skipped.push({
        task_id: task.task_id,
        reason: "no-exported-tested-patch",
      });
      continue;
    }
    examples.push({
      task_id: task.task_id,
      scope: {
        owner_id: task.scope.owner_id,
        project_id: task.scope.project_id,
      },
      request: task.request,
      patch: new TextDecoder().decode(patch),
      patch_sha256: digest,
      verdict_run_id: latest.run_id,
      check_manifest_sha256: latest.check_manifest_sha256 ?? null,
    });
  }
  return { examples, skipped };
}
