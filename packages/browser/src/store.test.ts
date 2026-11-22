import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openBrowserStore } from "./store";

test("browser store refuses a database symlink before modifying its target", () => {
  const root = mkdtempSync(path.join(tmpdir(), "browser-store-"));
  const target = path.join(root, "private.sqlite");
  const original = new Database(target);
  original.exec("CREATE TABLE private_data (value TEXT)");
  original.close();
  const storeRoot = path.join(root, "browser");
  mkdirSync(storeRoot);
  symlinkSync(target, path.join(storeRoot, "browser.sqlite"));
  let store: ReturnType<typeof openBrowserStore> | undefined;
  try {
    expect(() => {
      store = openBrowserStore({ rootDir: storeRoot });
    }).toThrow("Browser store file must be a regular file");
    const db = new Database(target);
    try {
      expect(
        db.query("SELECT name FROM sqlite_master WHERE name = 'jobs'").get(),
      ).toBeNull();
    } finally {
      db.close();
    }
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
