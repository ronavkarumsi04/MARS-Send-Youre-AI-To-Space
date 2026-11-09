import { expect, test } from "bun:test";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConnectionFileOrThrow } from "./connection";

const token = "fixture-token-0123456789abcdefghijklmnopqrstuvwxyz";
const scope = { owner_id: "owner", project_id: "project" };

test("readConnectionFileOrThrow returns the connection or throws the shared reason", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mars-cli-connection-"));
  const path = join(dir, "connection.json");
  await writeFile(
    path,
    JSON.stringify({
      schema_version: 1,
      url: "http://127.0.0.1:7331/",
      token,
      scope,
    }),
  );
  await chmod(path, 0o600);
  expect(await readConnectionFileOrThrow(path)).toEqual({
    url: "http://127.0.0.1:7331",
    token,
    scope,
  });
  await chmod(path, 0o644);
  await expect(readConnectionFileOrThrow(path)).rejects.toThrow(
    `Connection file is accessible to other users. Restrict it with chmod 600 and try again. (${path})`,
  );
  const missing = join(dir, "missing.json");
  await expect(readConnectionFileOrThrow(missing)).rejects.toThrow(
    `Could not open the connection file. (${missing})`,
  );
});
