import type { RequestContext } from "@mars/contracts";
import type { DurableTaskStore } from "@mars/tasks";
import {
  EVIDENCE_BINDING_ERROR_PATTERN,
  WATCH_EVIDENCE_PRODUCER,
  WATCH_PACKAGE_VERSION,
  WATCH_SKILL_VERSION,
  type WatchEvidenceRecord,
  WatchEvidenceRecordSchema,
  type WatchEvidenceSink,
  type WatchService,
} from "@mars/watch";

/** The host-owned watch service surface the workbench binds per task. */
export type WorkbenchWatch = Pick<WatchService, "toolsFor">;

const MAX_LISTED_RECORDS = 50;

/** Host-authoritative binding stamped onto every evidence record it writes. */
export interface EvidenceBinding {
  workspace_id: string;
  workspace_revision: string;
  diff_sha256: string;
}

/**
 * Persists watch-skill evidence as `tool.completed` task events so loop and
 * verification verdicts are durable, reviewable and bound to the task, and
 * reads them back for `mars_watch_evidence`.
 */
export function watchEvidence(
  store: Pick<DurableTaskStore, "appendEvent" | "events" | "artifacts">,
  context: () => RequestContext,
  taskId: string,
  binding?: () => Promise<EvidenceBinding>,
): WatchEvidenceSink {
  return {
    async append(record) {
      const {
        workspace_id: _workspace,
        workspace_revision: _revision,
        diff_sha256: _digest,
        binding_error: _error,
        ...unbound
      } = record;
      const payload = binding ? await bindRecord(unbound, binding) : unbound;
      await store.appendEvent(context(), taskId, {
        event_type: "tool.completed",
        run_id: crypto.randomUUID(),
        producer: WATCH_EVIDENCE_PRODUCER,
        versions: [
          {
            component: WATCH_EVIDENCE_PRODUCER,
            revision: WATCH_PACKAGE_VERSION,
          },
          { component: "watch-skill", revision: WATCH_SKILL_VERSION },
        ],
        payload,
      });
    },
    async list() {
      const records: WatchEvidenceRecord[] = [];
      const current = context();
      for await (const event of store.events(current, taskId)) {
        if (
          event.event_type !== "tool.completed" ||
          event.producer !== WATCH_EVIDENCE_PRODUCER
        )
          continue;
        const bytes = await store.artifacts.get(current, event.payload);
        const parsed = WatchEvidenceRecordSchema.safeParse(parseJson(bytes));
        if (parsed.success) records.push(parsed.data);
      }
      return records.slice(-MAX_LISTED_RECORDS);
    },
  };
}

/**
 * Stamps the host binding onto a record. When the binding cannot be resolved
 * the record is still persisted, unbound, with `binding_error` naming the
 * failure, so a later "stale" verdict is traceable to it.
 */
async function bindRecord(
  record: WatchEvidenceRecord,
  binding: () => Promise<EvidenceBinding>,
): Promise<WatchEvidenceRecord> {
  try {
    return { ...record, ...(await binding()) };
  } catch (error) {
    return { ...record, binding_error: bindingErrorName(error) };
  }
}

function bindingErrorName(error: unknown): string {
  const name = error instanceof Error ? error.name : undefined;
  return name && EVIDENCE_BINDING_ERROR_PATTERN.test(name) ? name : "Error";
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}
