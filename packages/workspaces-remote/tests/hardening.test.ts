import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { getEventListeners } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentServerClient } from "../src/client";
import { openRemoteWorkspaceStore } from "../src/store";
import { context } from "./conformance";
import { remoteFixture } from "./fixtures";

const budget = {
  max_tokens: 1,
  max_usd: 0,
  max_duration_ms: 10_000,
  max_depth: 1,
  max_concurrency: 1,
};

test("over-depth directories do not strand checkpoint restore", async () => {
  const fx = await remoteFixture({ limits: { maxDepth: 2 } });
  try {
    const ws = await fx.provider.prepare(context, "depth-restore");
    const checkpoint = await fx.provider.checkpoint(context, ws);
    const executed = await fx.provider.execute(
      context,
      ws,
      ["mkdir", "-p", "src/deep/beyond"],
      budget,
    );
    const restored = await fx.provider.restore(
      context,
      checkpoint,
      executed.workspace.revision,
    );
    expect((await fx.provider.diff(context, restored)).files).toEqual([]);
    expect((await fx.provider.inspect(context, ws.workspace_id)).revision).toBe(
      restored.revision,
    );
  } finally {
    await fx.close();
  }
});

test("remote scan directories cannot escape the local mirror", async () => {
  let forge = false;
  let injected = false;
  const fx = await remoteFixture({
    client: {
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        if (!forge || !input.includes("/bash_events/search?")) return response;
        const body = (await response.json()) as {
          items: { stdout?: string | null }[];
        };
        for (const event of body.items) {
          if (event.stdout?.includes("\u001e")) {
            event.stdout = `d\t755\t0\t../../../../escaped\0${event.stdout}`;
            injected = true;
          }
        }
        return Response.json(body);
      },
    },
  });
  try {
    const ws = await fx.provider.prepare(context, "traversal-scan");
    forge = true;
    await fx.provider.execute(context, ws, ["true"], budget);
    expect(injected).toBe(true);
    expect(existsSync(join(fx.base, "escaped"))).toBe(false);
  } finally {
    await fx.close();
  }
}, 30_000);

test("remote command deadlines apply during output pagination", async () => {
  let armed = false;
  let target: string | undefined;
  let release = false;
  let pages = 0;
  const fx = await remoteFixture({
    client: {
      fetch: async (input, init) => {
        if (
          armed &&
          target &&
          !release &&
          input.includes("/bash_events/search?") &&
          new URL(input).searchParams.get("command_id__eq") === target
        ) {
          await Bun.sleep(2);
          return Response.json({ items: [], next_page_id: String(++pages) });
        }
        const response = await fetch(input, init);
        if (armed && !target && input.endsWith("/start_bash_command")) {
          target = ((await response.clone().json()) as { id: string }).id;
        }
        return response;
      },
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const ws = await fx.provider.prepare(context, "pagination-deadline");
    armed = true;
    timer = setTimeout(() => {
      release = true;
    }, 400);
    const result = await fx.provider.execute(context, ws, ["sleep", "0.2"], {
      ...budget,
      max_duration_ms: 50,
    });
    expect(pages).toBeGreaterThan(1);
    expect(result.timed_out).toBe(true);
    expect(release).toBe(false);
  } finally {
    release = true;
    clearTimeout(timer);
    await fx.close();
  }
}, 30_000);

test("completed remote polling removes abort listeners from the run signal", async () => {
  const fx = await remoteFixture();
  const OriginalController = globalThis.AbortController;
  const controllers: AbortController[] = [];
  try {
    const ws = await fx.provider.prepare(context, "poll-listeners");
    globalThis.AbortController = class extends OriginalController {
      constructor() {
        super();
        controllers.push(this);
      }
    };
    await fx.provider.execute(context, ws, ["sleep", "0.1"], budget);
    expect(controllers.length).toBeGreaterThan(0);
    const controller = controllers[0];
    if (!controller) throw new Error("Run controller was not created");
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  } finally {
    globalThis.AbortController = OriginalController;
    await fx.close();
  }
}, 30_000);

test("unsupported server versions cannot echo the API key into errors", async () => {
  const apiKey = "fixture-only-secret-key";
  const client = createAgentServerClient({
    url: "https://agent.invalid",
    apiKey,
    fetch: async () =>
      Response.json({ title: "OpenHands Agent Server", version: apiKey }),
  });
  let error: unknown;
  try {
    await client.verify();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toContain("Unsupported Agent Server version");
  expect(String(error)).not.toContain(apiKey);
});

test("remote state database symlinks cannot modify an outside database", async () => {
  const root = await mkdtemp(join(tmpdir(), "remote-state-symlink-"));
  const target = join(root, "private.sqlite");
  const db = new Database(target);
  db.exec("CREATE TABLE private_data (value TEXT)");
  db.close();
  const original = await readFile(target);
  await symlink(target, join(root, "remote-workspaces.sqlite"));
  let store: ReturnType<typeof openRemoteWorkspaceStore> | undefined;
  try {
    expect(() => {
      store = openRemoteWorkspaceStore(root);
    }).toThrow("Remote workspace state file must be a regular file");
    expect(await readFile(target)).toEqual(original);
  } finally {
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});
