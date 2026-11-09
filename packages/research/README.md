# @mars/research

`@mars/research` is a durable, scoped control plane for research requests and evidence-backed findings. It stores requests, leases, usage, evidence provenance, findings, and an optional task-event outbox in a hardened SQLite database. It does not fetch sources or invoke models.

## API

Create the service with a `rootDir`, a `ResearchTaskReader`, an artifact store, and a `ResearchWorker`. The returned service implements the contracts `ResearchService` methods and adds `inspect`, `list`, `readFindings`, `markUsed`, `reconcileTask`, `pump`, and `close`. Worker input intentionally omits caller scope, request context, and filesystem paths. Worker writes are guarded by the durable request lease and abort signal. Background failures that have no caller to reject are passed to the optional `onInternalError(where, error)` callback and the most recent one is kept for `lastInternalError()`; scheduling continues as before. `where` names the operation that failed: `run_settled` (a run's terminal state write), `flush_events` (the post-run outbox flush, or delivering or decoding one outbox entry), `pump` (a timer-, submit- or post-run-triggered pump) or `execute_claim` (starting a claimed run). Reporter throws, rejected promises and rejected thenables are contained.

## Persistence and enforcement

Requests and findings survive restarts in `research.sqlite`. SQLite transactions use immediate locking; lease ownership, retries, idempotency, deadlines, active-request backpressure, and per-instance worker concurrency are enforced. Token and USD limits are enforced only against usage reported by a worker; usage the worker does not report cannot be enforced. `ResearchJob.enforcement` identifies this distinction.

The current `RESEARCH_STORE_FORMAT_VERSION` is 2. Version 1 stores are migrated atomically on open, including pending event-outbox entries.

Workers receive the request's accumulated usage in `ResearchWorkerInput.usage` and report each new delta through `reportUsage`. Evidence is stored through the configured artifact store, and finding records refer to those captured artifacts. The optional event sink is an outbox: event failures are reported as `flush_events`, retained as pending and retried on later pumps. An entry whose stored event or record cannot be decoded (`corrupt_record`) is reported once and parked as `failed` instead of being retried.

## Citations and privacy

Citation URLs are validated as HTTP(S) provenance labels only. The service performs no DNS lookup, URL retrieval, or network request. A capture records the URL, retrieval timestamp, media type, and artifact reference; it does not establish that a claim is true. Findings may cite only evidence captured for that same scoped request.

Inputs and captured text are checked against configured private paths and the research-store path. Store directories and database files are restricted to owner-only permissions. Never expose `rootDir` or stored scope over RPC; methods should receive the caller's `RequestContext`.

## Parent wiring hooks

The host supplies `rootDir`, `taskStore`, `worker`, `ompSessionDir`, and the caller context:

```ts
import { registerRuntimeCleanup } from "@mars/execution";
import { createResearchService } from "@mars/research";

const research = await createResearchService({
  rootDir,
  tasks: taskStore,
  artifacts: taskStore.artifacts,
  events: taskStore,
  worker,
  hostPrivateRoots: [ompSessionDir],
});

await taskStore.update(context, taskId, expectedRevision, patch);
await research.reconcileTask(context, taskId);
await research.markUsed(context, findingId, taskRevision);

registerRuntimeCleanup("research", () =>
  research.close({ drainMs: 5000 }),
);
```

Call `reconcileTask` after each task revision change (update, steer, or resume) and before presenting findings. Call `markUsed` when a worker actually consumes a finding. Map RPC methods one-to-one to service methods while supplying the caller's context.

Exports: `createResearchService`, `RetryableResearchError`, `ResearchError`, `ResearchErrorCode`, `RESEARCH_STORE_FORMAT_VERSION`, `FindingProposalSchema`, `ResearchFindingSchema`, `ResearchRequestSchema`, `ResearchFinding`, `ResearchRequest`, `ResearchService`, `DurableResearchService`, `EvidenceCapture`, `FindingProposal`, `ResearchArtifactStore`, `ResearchEventSink`, `ResearchJob`, `ResearchJobStatus`, `ResearchServiceOptions`, `ResearchTaskReader`, `ResearchUsage`, `ResearchWorker`, `ResearchWorkerContext`, and `ResearchWorkerInput`.

## Live dispatch status

`@mars/research-worker` ([documentation/RESEARCH_WORKER.md](../../documentation/RESEARCH_WORKER.md)) is the production worker for this control plane: it searches through an injected provider, fetches behind an injected `fetch` with SSRF, robots and byte guards, captures every page as evidence before citing it, and drives model calls through the existing model registry. It is verified offline only; its live mode is opt-in and unverified until a human runs it. No host wires it yet.

## Known gaps

- No host wires the worker yet, and live retrieval remains unverified.
- Token and USD ceilings depend on truthful worker-reported usage.
- Citation capture records provenance, not source authenticity or truth.
- Parent lifecycle wiring, task-revision reconciliation, and RPC privacy boundaries remain the host's responsibility.
- Outbox entries rejected by the task store (for example, for a terminal task or payload conflict) remain pending and are retried (and reported as `flush_events`) on every pump, with no retry cap.
- Evidence bytes stored before a lease-loss check fails remain as unreferenced content-addressed artifacts.
