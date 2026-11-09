import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RequestContext, Task } from "@mars/contracts";
import { createTaskStore } from "@mars/tasks";
import {
  BrowserError,
  type BrowserServiceOptions,
  type BrowserWorker,
  type BrowserWorkerContext,
  type BrowserWorkerInput,
  browserBudgetHoldKey,
  createBrowserService,
  type DurableBrowserService,
  isTerminalBrowserStatus,
} from "./index";

const roots: string[] = [];
const services: DurableBrowserService[] = [];
const stores: Array<Awaited<ReturnType<typeof createTaskStore>>> = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close({ drainMs: 200 });
  for (const store of stores.splice(0)) await store.close?.();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const scope = { owner_id: "owner-1", project_id: "project-1" };
const ctx = (request_id = "req-1"): RequestContext => ({
  schema_version: 1,
  scope,
  request_id,
});
const makeTask = (budget: Partial<Task["budget"]> = {}): Task => ({
  schema_version: 1,
  task_id: "task-1",
  session_id: "session-1",
  scope,
  revision: 0,
  request: "Browse",
  acceptance_criteria: ["Done"],
  budget: {
    max_tokens: 10_000,
    max_usd: 10,
    max_duration_ms: 60_000,
    max_depth: 2,
    max_concurrency: 4,
    ...budget,
  },
  status: "pending",
  specialist_revision: null,
  artifacts: [],
});
const request = (overrides: Record<string, unknown> = {}) => ({
  goal: "Read the page",
  task_id: "task-1",
  task_revision: 0,
  start_url: "https://example.org/",
  allowed_actions: ["navigate", "screenshot", "extract"],
  max_steps: 5,
  deadline: new Date(Date.now() + 30_000).toISOString(),
  budget: {
    max_tokens: 1_000,
    max_usd: 1,
    max_duration_ms: 30_000,
    max_depth: 0,
    max_concurrency: 1,
  },
  ...overrides,
});

type Run = (input: BrowserWorkerInput, context: BrowserWorkerContext) => Promise<void>;
const worker = (run: Run): BrowserWorker => ({ id: "test-worker", version: "1", run });

const completing: Run = async (input, context) => {
  await context.reportUsage({ input_tokens: 10, output_tokens: 5, cost_usd: 0.01 });
  const ref = await context.captureEvidence({
    kind: "page_text",
    url: input.start_url,
    media_type: "text/plain",
    data: new TextEncoder().encode("Mars has two moons."),
  });
  await context.recordStep({
    index: 0,
    action: { type: "extract" },
    outcome: "ok",
    detail: "captured",
    url: input.start_url,
    title: "Mars",
    artifacts: [ref],
  });
  await context.complete({
    success: true,
    summary: "Mars has two moons.",
    final_url: input.start_url,
    artifacts: [ref],
  });
};

async function setup(
  options: {
    run?: Run;
    task?: Task;
    service?: Partial<BrowserServiceOptions>;
    noLedger?: boolean;
  } = {},
) {
  const root = mkdtempSync(path.join(tmpdir(), "mars-browser-test-"));
  roots.push(root);
  const tasks = await createTaskStore({ rootDir: path.join(root, "tasks"), workspaceRoots: [] });
  stores.push(tasks);
  const task = options.task ?? makeTask();
  await tasks.create(ctx("create-task"), task);
  const ledger = options.noLedger
    ? undefined
    : {
        reserve: tasks.reserveBudget!.bind(tasks),
        record: tasks.recordBudget!.bind(tasks),
        committed: tasks.budgetCommitted!.bind(tasks),
      };
  const slots = options.noLedger
    ? undefined
    : {
        acquire: tasks.acquireSlot!.bind(tasks),
        release: tasks.releaseSlot!.bind(tasks),
      };
  const service = await createBrowserService({
    rootDir: path.join(root, "browser"),
    tasks,
    artifacts: tasks.artifacts,
    worker: worker(options.run ?? completing),
    ...(ledger ? { ledger } : {}),
    ...(slots ? { slots } : {}),
    hostPrivateRoots: [path.join(root, "tasks")],
    leaseMs: 300,
    pollMs: 10,
    retryBackoffMs: 1,
    ...options.service,
  });
  services.push(service);
  return { root, tasks, service, task };
}

async function settled(service: DurableBrowserService, id: string, context = ctx()) {
  const until = Date.now() + 5_000;
  while (Date.now() < until) {
    const job = await service.inspect(context, id);
    if (isTerminalBrowserStatus(job.status)) return job;
    await Bun.sleep(5);
  }
  throw new Error("job did not settle");
}
const codeOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: unknown) => (error as BrowserError).code,
  );

test("a job runs to completion with steps, evidence, usage and a settled task hold", async () => {
  const { service, tasks } = await setup();
  const job = await service.submit(ctx(), request());
  expect(job.status).toBe("queued");
  const done = await settled(service, job.request_id);
  expect(done.status).toBe("completed");
  expect(done.usage).toEqual({ input_tokens: 10, output_tokens: 5, cost_usd: 0.01, reported: true });
  const view = await service.readResult(ctx(), job.request_id);
  expect(view.steps).toHaveLength(1);
  expect(view.result?.summary).toBe("Mars has two moons.");
  const ref = view.result?.artifacts[0];
  expect(ref && new TextDecoder().decode(await tasks.artifacts.get(ctx(), ref))).toBe("Mars has two moons.");
  // The hold shrinks from the whole job budget to what was used.
  expect(await tasks.budgetCommitted!(ctx(), "task-1")).toEqual({ tokens: 15, usd: 0.01 });
  expect(await service.allowance(ctx(), "task-1")).toEqual({ max_tokens: 9_985, max_usd: 9.99 });
});

test("submission is idempotent, strict and bounded by host policy and task budget", async () => {
  const { service } = await setup({ service: { allowedActions: ["navigate", "screenshot", "extract"] } });
  const same = request();
  const first = await service.submit(ctx("same"), same);
  expect((await service.submit(ctx("same"), same)).request_id).toBe(first.request_id);
  expect(await codeOf(service.submit(ctx("same"), { ...same, goal: "Other" }))).toBe("conflict");
  expect(await codeOf(service.submit(ctx("a"), request({ allowed_actions: ["navigate", "type"] })))).toBe("forbidden");
  expect(
    await codeOf(service.submit(ctx("b"), request({ actions: [{ type: "click", ref: "e1" }] }))),
  ).toBe("invalid_input");
  expect(await codeOf(service.submit(ctx("c"), request({ start_url: "file:///etc/passwd" })))).toBe("invalid_input");
  expect(await codeOf(service.submit(ctx("d"), request({ start_url: "https://u:p@example.org/" })))).toBe("invalid_input");
  expect(await codeOf(service.submit(ctx("e"), request({ task_revision: 3 })))).toBe("stale_revision");
  expect(
    await codeOf(service.submit(ctx("f"), request({ budget: { ...request().budget, max_tokens: 20_000 } }))),
  ).toBe("budget_exceeded");
});

test("the shared ledger refuses a job that would overrun the task beside other spenders", async () => {
  const { service, tasks } = await setup({ run: async () => new Promise(() => {}) });
  await tasks.reserveBudget!(ctx("fg"), "task-1", "foreground:test", { tokens: 9_500, usd: 0 });
  expect(await codeOf(service.submit(ctx("big"), request()))).toBe("budget_exceeded");
  expect(await tasks.budgetCommitted!(ctx(), "task-1")).toEqual({ tokens: 9_500, usd: 0 });
  const ok = await service.submit(ctx("small"), request({ budget: { ...request().budget, max_tokens: 500 } }));
  expect(ok.status).toBe("queued");
  expect(await tasks.budgetCommitted!(ctx(), "task-1")).toEqual({ tokens: 10_000, usd: 1 });
});

test("one task slot stays free for the foreground run; queued jobs wait for a slot", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started: string[] = [];
  const { service, tasks } = await setup({
    task: makeTask({ max_concurrency: 2 }),
    run: async (input, context) => {
      started.push(input.request_id);
      await gate;
      await completing(input, context);
    },
  });
  const a = await service.submit(ctx("a"), request());
  const b = await service.submit(ctx("b"), request());
  await Bun.sleep(100);
  expect(started).toEqual([a.request_id]);
  expect((await service.inspect(ctx("b"), b.request_id)).status).toBe("queued");
  // Another spender cannot take a slot either: the only background slot is in use.
  expect(await tasks.acquireSlot!(ctx(), "task-1", "other", { now: Date.now(), expiresAt: Date.now() + 1_000 })).toBe(false);
  release();
  expect((await settled(service, b.request_id, ctx("b"))).status).toBe("completed");
  expect(started).toEqual([a.request_id, b.request_id]);
  expect(await tasks.acquireSlot!(ctx(), "task-1", "other", { now: Date.now(), expiresAt: Date.now() + 1_000 })).toBe(true);
});

test("a task whose concurrency leaves no background slot refuses browser work", async () => {
  const { service } = await setup({ task: makeTask({ max_concurrency: 1 }) });
  expect(await codeOf(service.submit(ctx(), request()))).toBe("budget_exceeded");
});

test("cancel aborts the running worker, frees its slot and settles the hold", async () => {
  let signal: AbortSignal | undefined;
  const { service, tasks } = await setup({
    task: makeTask({ max_concurrency: 2 }),
    run: async (_input, context) => {
      signal = context.signal;
      await context.reportUsage({ input_tokens: 3, output_tokens: 0, cost_usd: 0 });
      await new Promise((_, reject) => context.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    },
  });
  const job = await service.submit(ctx(), request());
  while (!signal) await Bun.sleep(5);
  const cancelled = await service.cancel(ctx(), job.request_id);
  expect(cancelled.status).toBe("cancelled");
  expect(signal.aborted).toBe(true);
  await Bun.sleep(50);
  expect(await tasks.acquireSlot!(ctx(), "task-1", "other", { now: Date.now(), expiresAt: Date.now() + 1_000 })).toBe(true);
  expect(await tasks.budgetCommitted!(ctx(), "task-1")).toEqual({ tokens: 3, usd: 0 });
});

test("evidence must be captured by the attempt, private paths are refused or scrubbed", async () => {
  let failures: string[] = [];
  const { service, root } = await setup({
    run: async (input, context) => {
      const privatePath = path.join(root, "tasks", "secret.txt");
      failures = [];
      const attempt = async (operation: () => Promise<unknown>) => {
        try {
          await operation();
        } catch (error) {
          failures.push((error as BrowserError).code);
        }
      };
      await attempt(() =>
        context.captureEvidence({ kind: "page_text", url: input.start_url, media_type: "text/plain", data: new TextEncoder().encode(`see ${privatePath}`) }),
      );
      await attempt(() =>
        context.captureEvidence({ kind: "screenshot", url: input.start_url, media_type: "text/html", data: new Uint8Array(1) }),
      );
      await attempt(() =>
        context.recordStep({
          index: 0,
          action: { type: "screenshot" },
          outcome: "ok",
          detail: "",
          url: input.start_url,
          title: "",
          artifacts: [{ artifact_id: "forged", sha256: "a".repeat(64), media_type: "image/png", byte_length: 1 }],
        }),
      );
      await attempt(() =>
        context.recordStep({ index: 0, action: { type: "click", ref: "e1" }, outcome: "ok", detail: "", url: "", title: "", artifacts: [] }),
      );
      await context.recordStep({ index: 0, action: { type: "click", ref: "e1" }, outcome: "blocked", detail: `not allowed ${privatePath}`, url: "", title: "", artifacts: [] });
      await attempt(() => context.saveSession(new Uint8Array(1)));
      await context.complete({ success: false, summary: `failed near ${privatePath}`, final_url: "", artifacts: [] });
    },
  });
  const job = await service.submit(ctx(), request());
  await settled(service, job.request_id);
  expect(failures).toEqual(["evidence_rejected", "invalid_input", "evidence_rejected", "forbidden", "forbidden"]);
  const view = await service.readResult(ctx(), job.request_id);
  expect(JSON.stringify(view)).not.toContain(root);
  expect(view.steps[0]?.detail).toContain("[redacted]");
});

test("retryable failures get a fresh attempt; worker errors and missing results fail", async () => {
  const attempts: number[] = [];
  const { service } = await setup({
    run: async (input, context) => {
      attempts.push(input.attempt);
      if (input.goal === "flaky" && input.attempt === 1) throw new Error("browser crashed");
      if (input.goal === "broken") throw new BrowserError("invalid_input", "bad");
      if (input.goal === "silent") return;
      await completing(input, context);
    },
  });
  const flaky = await service.submit(ctx("flaky"), request({ goal: "flaky" }));
  expect((await settled(service, flaky.request_id, ctx("flaky"))).status).toBe("completed");
  expect(attempts).toEqual([1, 2]);
  const broken = await service.submit(ctx("broken"), request({ goal: "broken" }));
  expect((await settled(service, broken.request_id, ctx("broken"))).error_code).toBe("worker_failed");
  const silent = await service.submit(ctx("silent"), request({ goal: "silent" }));
  expect((await settled(service, silent.request_id, ctx("silent"))).error_code).toBe("incomplete");
});

test("reported usage over the job budget fails the job and aborts the worker", async () => {
  let aborted = false;
  const { service, tasks } = await setup({
    run: async (_input, context) => {
      try {
        await context.reportUsage({ input_tokens: 900, output_tokens: 200, cost_usd: 0 });
      } finally {
        aborted = context.signal.aborted;
      }
    },
  });
  const job = await service.submit(ctx(), request());
  const done = await settled(service, job.request_id);
  expect(done.error_code).toBe("budget_exceeded");
  expect(aborted).toBe(true);
  expect(await tasks.budgetCommitted!(ctx(), "task-1")).toEqual({ tokens: 1_100, usd: 0 });
});

test("sessions are shared only between jobs of the same task with the same key", async () => {
  const seen: (string | null)[] = [];
  const { service } = await setup({
    run: async (input, context) => {
      const state = await context.loadSession();
      seen.push(state ? new TextDecoder().decode(state) : null);
      if (input.session_key) await context.saveSession(new TextEncoder().encode(`cookie-${input.goal}`));
      await completing(input, context);
    },
  });
  for (const [id, overrides] of [
    ["one", { goal: "one", session_key: "login" }],
    ["two", { goal: "two", session_key: "login" }],
    ["three", { goal: "three" }],
  ] as const) {
    const job = await service.submit(ctx(id), request(overrides));
    await settled(service, job.request_id, ctx(id));
  }
  expect(seen).toEqual([null, "cookie-one", null]);
});

test("stale revisions and terminal tasks cancel active jobs", async () => {
  const { service } = await setup({ run: async () => new Promise(() => {}) });
  const job = await service.submit(ctx(), request());
  expect(await service.markStale(ctx(), "task-1", 1)).toBe(1);
  const stale = await service.inspect(ctx(), job.request_id);
  expect(stale.status).toBe("cancelled");
  expect(stale.stale).toBe(true);
});

test("a run interrupted by shutdown is requeued and finished by the next process", async () => {
  const { service, root, tasks } = await setup({
    run: async (_input, context) =>
      new Promise((_, reject) => context.signal.addEventListener("abort", () => reject(new Error("closed")))),
  });
  const job = await service.submit(ctx(), request());
  await Bun.sleep(50);
  await service.close({ drainMs: 100 });
  services.splice(services.indexOf(service), 1);
  const next = await createBrowserService({
    rootDir: path.join(root, "browser"),
    tasks,
    artifacts: tasks.artifacts,
    worker: worker(completing),
    leaseMs: 300,
    pollMs: 10,
  });
  services.push(next);
  const done = await settled(next, job.request_id);
  expect(done.status).toBe("completed");
  expect(done.attempts).toBe(2);
});

test("deadlines expire running jobs and abort the worker", async () => {
  let reason: unknown;
  const { service } = await setup({
    run: async (_input, context) =>
      new Promise((_, reject) =>
        context.signal.addEventListener("abort", () => {
          reason = context.signal.reason;
          reject(new Error("aborted"));
        }),
      ),
  });
  const job = await service.submit(ctx(), request({ deadline: new Date(Date.now() + 150).toISOString() }));
  expect((await settled(service, job.request_id)).status).toBe("expired");
  expect(reason).toBe("deadline_exceeded");
});

test("a zero retry backoff is accepted, as research accepts it; negative limits are not", async () => {
  const flaky: Run = async (input, context) => {
    if (input.attempt === 1) throw new Error("crash");
    await completing(input, context);
  };
  const { service } = await setup({ run: flaky, service: { retryBackoffMs: 0 } });
  const job = await service.submit(ctx(), request());
  expect((await settled(service, job.request_id)).attempts).toBe(2);
  expect(await codeOf(setup({ service: { retryBackoffMs: -1 } }))).toBe("invalid_input");
  expect(await codeOf(setup({ service: { leaseMs: 0 } }))).toBe("invalid_input");
});

test("hold keys are namespaced per request", () => {
  expect(browserBudgetHoldKey("a")).toMatch(/^browser:[a-f0-9]{32}$/);
  expect(browserBudgetHoldKey("a")).not.toBe(browserBudgetHoldKey("b"));
});
