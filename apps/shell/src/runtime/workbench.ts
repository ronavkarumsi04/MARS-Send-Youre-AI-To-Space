import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { loadModelRegistry } from "@mars/providers";
import { createWorkbenchService } from "@mars/workbench";
import { z } from "zod";

const StartSchema = z
  .object({
    source: z.string().min(1),
    state: z.string().min(1),
    openRouterKey: z.string().max(512).optional(),
  })
  .strict();

async function serve(): Promise<void> {
  const input = createInterface({ input: process.stdin, terminal: false });
  let stop: () => void = () => {};
  const stopped = new Promise<void>((resolve) => {
    stop = resolve;
    input.once("close", resolve);
  });
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    const line = await Promise.race([
      new Promise<string>((resolve) => input.once("line", resolve)),
      stopped,
    ]);
    if (line === undefined) return;
    const { source, state, openRouterKey } = StartSchema.parse(
      JSON.parse(line),
    );
    const service = await createWorkbenchService({
      sourceRoot: source,
      stateRoot: state,
      scope: { owner_id: "local", project_id: basename(state) },
      port: 0,
      registry: await loadModelRegistry({
        cwd: source,
        trustProjectConfig: false,
        env: {
          MARS_HOME: join(state, "desktop-models"),
          OPENROUTER_API_KEY: openRouterKey,
        },
      }),
    });
    try {
      process.stdout.write("MARS_WORKBENCH_READY\n");
      await stopped;
    } finally {
      await service.close();
    }
  } finally {
    input.close();
    process.stdin.destroy();
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}

if (import.meta.main) {
  try {
    await serve();
  } catch {
    process.stderr.write("MARS could not start or stop its local workbench.\n");
    process.exitCode = 1;
  }
}
