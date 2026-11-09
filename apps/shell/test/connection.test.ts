import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConnection } from "../src/main/connection";

const token = "fixture-token-0123456789abcdefghijklmnopqrstuvwxyz";
const connection = {
  schema_version: 1,
  url: "http://127.0.0.1:7331/",
  token,
  scope: { owner_id: "owner", project_id: "project" },
};

async function writeConnection(path: string, value = connection, mode = 0o600) {
  await writeFile(path, JSON.stringify(value), { mode });
  await chmod(path, mode);
}

test("discovery handles none, one, and several connection files", async () => {
  const home = await mkdtemp(join(tmpdir(), "mars-shell-connection-"));
  const base = join(home, ".mars", "workbench");
  const directory = join(base, "one");
  await mkdir(directory, { recursive: true });
  const path = join(directory, "connection.json");
  await writeConnection(path, connection, 0o644);
  expect(
    await resolveConnection({ argv: [], env: {}, homeDir: home }),
  ).toMatchObject({
    ok: false,
    reason: expect.stringContaining("chmod 600"),
  });
  await writeConnection(path);

  const noneHome = join(home, "none");
  expect(
    await resolveConnection({ argv: [], env: {}, homeDir: noneHome }),
  ).toMatchObject({
    ok: false,
    reason: expect.stringContaining("No workbench"),
  });
  await mkdir(join(base, "without-connection"), { recursive: true });
  const one = await resolveConnection({ argv: [], env: {}, homeDir: home });
  expect(one.ok).toBe(true);
  if (one.ok) {
    expect(one.connection.scope).toEqual({
      owner_id: "owner",
      project_id: "project",
    });
  }
  await mkdir(join(base, "two"), { recursive: true });
  await writeConnection(join(base, "two", "connection.json"));
  expect(
    await resolveConnection({ argv: [], env: {}, homeDir: home }),
  ).toMatchObject({
    ok: false,
    reason: expect.stringContaining("Several workbench"),
  });
  expect(
    await resolveConnection({
      argv: [`--connection=${path}`],
      env: {},
      homeDir: noneHome,
    }),
  ).toMatchObject({ ok: true });
});
