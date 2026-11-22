import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCliRunner } from "./cli";

test.skipIf(process.platform === "win32")(
  "CLI timeout kills descendants that inherit its output pipes",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "watch-process-"));
    const pidFile = join(root, "child.pid");
    const runner = createCliRunner({
      command: [
        process.execPath,
        "-e",
        `
      const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
        stdin: "ignore", stdout: "inherit", stderr: "inherit"
      });
      await Bun.write(${JSON.stringify(pidFile)}, String(child.pid));
      setInterval(() => {}, 1000);
    `,
      ],
      dataRoot: root,
      offline: true,
      displayAllowed: false,
      maxOutputBytes: 1024,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const running = runner.run({ args: [], cwd: root, timeoutMs: 200 });
    try {
      const result = await Promise.race([
        running,
        new Promise<"hung">((resolve) => {
          timer = setTimeout(() => resolve("hung"), 1000);
        }),
      ]);
      expect(result).not.toBe("hung");
      if (result === "hung") throw new Error("CLI output pipes remained open");
      expect(result.timed_out).toBe(true);
      expect(result.exit_code).toBeNull();
    } finally {
      clearTimeout(timer);
      const pid = Number(await readFile(pidFile, "utf8").catch(() => ""));
      if (pid > 0) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      await running;
      await rm(root, { recursive: true, force: true });
    }
  },
);
