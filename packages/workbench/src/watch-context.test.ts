import { expect, test } from "bun:test";
import type { RequestContext } from "@mars/contracts";
import { WATCH_EVIDENCE_PRODUCER, type WatchEvidenceRecord } from "@mars/watch";
import { watchEvidence } from "./watch-context";

const context: RequestContext = {
  schema_version: 1,
  request_id: "request",
  scope: { owner_id: "owner", project_id: "project", workspace_id: "w" },
};

const record = (limitations: string[] = []): WatchEvidenceRecord => ({
  schema_version: 1,
  operation: "watch.evidence",
  kind: "verify",
  tool: "mars_verify",
  verdict: "pass",
  assurance: "isolated_local",
  verified: true,
  advisory: false,
  required_checks: { passed: 1, failed: 0, inconclusive: 0 },
  limitations,
  summary: "verify",
  cli_version: "1.4.3",
  recorded_at: "2026-01-01T00:00:00.000Z",
  workspace_id: "forged",
  workspace_revision: "forged",
  diff_sha256: "0".repeat(64),
});

function memoryStore() {
  const artifacts = new Map<string, Uint8Array>();
  const events: { event_type: string; producer: string; payload: string }[] =
    [];
  const store = {
    async appendEvent(
      _context: RequestContext,
      _taskId: string,
      event: { event_type: string; producer: string; payload: unknown },
    ) {
      const ref = `artifact-${events.length}`;
      artifacts.set(
        ref,
        new TextEncoder().encode(
          typeof event.payload === "string"
            ? event.payload
            : JSON.stringify(event.payload),
        ),
      );
      events.push({ ...event, payload: ref });
    },
    async *events() {
      yield* events;
    },
    artifacts: {
      async get(_context: RequestContext, ref: string) {
        const bytes = artifacts.get(ref);
        if (!bytes) throw new Error("missing artifact");
        return bytes;
      },
    },
  };
  return store as unknown as Parameters<typeof watchEvidence>[0];
}

const binding = {
  workspace_id: "workspace",
  workspace_revision: "r1",
  diff_sha256: "a".repeat(64),
};

test("a resolved binding replaces any tool-supplied stamp", async () => {
  const sink = watchEvidence(
    memoryStore(),
    () => context,
    "task",
    async () => binding,
  );
  await sink.append(record());
  expect(await sink.list()).toEqual([{ ...record(), ...binding }]);
});

test("a failed binding persists the record unbound and names the error class, never its message", async () => {
  class WorkspaceModifiedError extends Error {
    override name = "WorkspaceModifiedError";
  }
  const sink = watchEvidence(
    memoryStore(),
    () => context,
    "task",
    async () => {
      throw new WorkspaceModifiedError("/private/host/path");
    },
  );
  await sink.append(record(["earlier"]));
  const [listed] = await sink.list();
  expect(listed?.workspace_id).toBeUndefined();
  expect(listed?.workspace_revision).toBeUndefined();
  expect(listed?.diff_sha256).toBeUndefined();
  expect(listed?.binding_error).toBe("WorkspaceModifiedError");
  expect(listed?.limitations).toEqual(["earlier"]);
  expect(JSON.stringify(listed)).not.toContain("/private/host/path");
});

test("an unsafe or non-Error binding failure is recorded as a generic error name", async () => {
  for (const thrown of [
    Object.assign(new Error("x"), { name: "/private/host/path" }),
    "not an error",
  ]) {
    const sink = watchEvidence(
      memoryStore(),
      () => context,
      "task",
      async () => {
        throw thrown;
      },
    );
    await sink.append(record());
    const [listed] = await sink.list();
    expect(listed?.binding_error).toBe("Error");
  }
});

test("a tool-supplied binding_error is never trusted", async () => {
  const forged = { ...record(), binding_error: "Forged" };
  const bound = watchEvidence(
    memoryStore(),
    () => context,
    "task",
    async () => binding,
  );
  await bound.append(forged);
  expect((await bound.list())[0]?.binding_error).toBeUndefined();
  const unbound = watchEvidence(memoryStore(), () => context, "task");
  await unbound.append(forged);
  expect((await unbound.list())[0]?.binding_error).toBeUndefined();
});

test("without a binding function records are stored unbound and unchanged", async () => {
  const sink = watchEvidence(memoryStore(), () => context, "task");
  await sink.append(record());
  const {
    workspace_id: _workspace,
    workspace_revision: _revision,
    diff_sha256: _digest,
    ...unbound
  } = record();
  expect(await sink.list()).toEqual([unbound]);
});

test("list skips evidence artifacts that are not JSON", async () => {
  const store = memoryStore();
  await store.appendEvent(context, "task", {
    event_type: "tool.completed",
    run_id: "corrupt",
    producer: WATCH_EVIDENCE_PRODUCER,
    versions: [],
    payload: "not json",
  } as never);
  const sink = watchEvidence(store, () => context, "task");
  await sink.append(record());
  expect(await sink.list()).toHaveLength(1);
});
