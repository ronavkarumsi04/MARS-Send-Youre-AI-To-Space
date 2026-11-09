import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultProjectId,
  defaultStateRoot,
  resolveWorkbenchLocation,
} from "./workbench-location";

test("default project id is the first 24 hex chars of sha256(source realpath)", () => {
  expect(defaultProjectId("/srv/mars/project")).toBe(
    "project-556ac57be08919affdbb1e25",
  );
});

test("default state root lives under ~/.mars/workbench/<project>", () => {
  expect(defaultStateRoot("project-x")).toBe(
    join(homedir(), ".mars", "workbench", "project-x"),
  );
});

test("resolveWorkbenchLocation derives defaults and honours explicit flags", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mars-location-"));
  try {
    const real = realpathSync(dir);
    expect(await resolveWorkbenchLocation({ source: dir })).toEqual({
      source: real,
      project: defaultProjectId(real),
      state: defaultStateRoot(defaultProjectId(real)),
    });
    expect(
      await resolveWorkbenchLocation({
        source: dir,
        project: "custom",
        state: "relative-state",
      }),
    ).toEqual({
      source: real,
      project: "custom",
      state: join(process.cwd(), "relative-state"),
    });
    expect(
      (await resolveWorkbenchLocation({ source: dir, project: "custom" }))
        .state,
    ).toBe(defaultStateRoot("custom"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
