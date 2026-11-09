import { expect, test } from "bun:test";
import { createDockerSandbox } from "../src";
import { context, makeFixture } from "./helpers";

// Opt-in: a locally present, digest-pinned image with `bun` on PATH, e.g.
// MARS_WORKSPACES_BUN_TEST_IMAGE=oven/bun@sha256:5148f6742ac31fac28e6eab391ab1f11f6dfc0c8512c7a3679b374ec470f5982
const image = process.env.MARS_WORKSPACES_BUN_TEST_IMAGE;

const encode = (text: string) => new TextEncoder().encode(text);
const PROTECTED_TEST = `import { expect, test } from "bun:test";
import { sum } from "../src/sum";
test("sum", () => expect(sum(2, 3)).toBe(5));
`;

test.skipIf(!image)(
  "runCheck runs a protected bun test in the real sandbox: the buggy candidate fails, a candidate bunfig cannot subvert it, the fix passes",
  async () => {
    const fixture = await makeFixture({
      runner: createDockerSandbox({
        image: image as string,
        pids: 128,
        maxFileBytes: 10 * 1024 * 1024,
      }),
    });
    try {
      const write = async (path: string, text: string) => {
        const current = await fixture.provider.discover(context, "task-test");
        if (!current) throw new Error("candidate missing");
        const ref = await fixture.artifacts.put(
          context,
          encode(text),
          "text/plain",
        );
        await fixture.provider.write(context, current, path, ref);
      };
      const run = async () => {
        const current = await fixture.provider.discover(context, "task-test");
        if (!current) throw new Error("candidate missing");
        const result = await fixture.provider.runCheck(context, current, {
          argv: ["bun", "test", "tests/sum.test.ts"],
          overlay: [
            { path: "tests/sum.test.ts", data: encode(PROTECTED_TEST) },
          ],
          exclude: ["bunfig.toml"],
          timeoutMs: 60_000,
        });
        expect(result.workspace.revision).toBe(current.revision);
        return result;
      };
      await write(
        "src/sum.ts",
        "export const sum = (a: number, b: number) => a - b;\n",
      );
      // A candidate that tries to force a pass through a preload is excluded.
      await write("bunfig.toml", '[test]\npreload = ["./pass.ts"]\n');
      await write("pass.ts", "process.exit(0);\n");
      await write(
        "tests/sum.test.ts",
        'import { test } from "bun:test";\ntest("x", () => {});\n',
      );
      const failed = await run();
      expect(failed.timed_out).toBe(false);
      expect(failed.exit_code).not.toBe(0);
      await write(
        "src/sum.ts",
        "export const sum = (a: number, b: number) => a + b;\n",
      );
      const passed = await run();
      expect({
        exit: passed.exit_code,
        out: new TextDecoder()
          .decode(new Uint8Array([...passed.stdout, ...passed.stderr]))
          .slice(-400),
      }).toMatchObject({ exit: 0 });
    } finally {
      await fixture.close();
    }
  },
  120_000,
);
