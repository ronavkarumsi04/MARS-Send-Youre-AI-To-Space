import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isLoopbackHost,
  loadConnectionFile,
  MAX_CONNECTION_FILE_BYTES,
  parseConnectionFile,
  readConnectionFile,
} from "./connection-file";

const TOKEN = "dummyTokenNotReal_0123456789-abcdefghijklmn"; // 43 chars, fake
const SCOPE = { owner_id: "owner-1", project_id: "project-1" };
const enc = (value: unknown) =>
  new TextEncoder().encode(
    typeof value === "string" ? value : JSON.stringify(value),
  );
const valid = {
  schema_version: 1,
  url: "http://127.0.0.1:7331",
  token: TOKEN,
  scope: SCOPE,
};

describe("isLoopbackHost", () => {
  test("accepts only localhost, bracketed [::1] and 127.0.0.0/8 dotted quads", () => {
    for (const host of [
      "localhost",
      "LOCALHOST",
      "[::1]",
      "127.0.0.1",
      "127.10.0.1",
      "127.255.255.255",
    ])
      expect(isLoopbackHost(host)).toBe(true);
    for (const host of [
      "::1",
      "[::2]",
      "127.0.0.256",
      "127.0.0",
      "127.0.0.1.1",
      "127.0.0.01x",
      "128.0.0.1",
      "0.0.0.0",
      "127.0.0.1.nip.io",
      "localhost.example.com",
      "",
    ])
      expect(isLoopbackHost(host)).toBe(false);
  });

  test("matches what URL.hostname yields for loopback URLs", () => {
    for (const raw of [
      "http://localhost:1",
      "http://[::1]:1",
      "http://[0:0:0:0:0:0:0:1]:1",
      "http://127.1:1",
      "http://0x7f.0.0.1:1",
    ])
      expect(isLoopbackHost(new URL(raw).hostname)).toBe(true);
  });
});

function reason(value: unknown): string {
  const result = parseConnectionFile(enc(value));
  if (result.ok) throw new Error("expected rejection");
  expect(result.reason).not.toContain(TOKEN);
  return result.reason;
}

describe("parseConnectionFile", () => {
  test("accepts the exact mars serve shape and normalizes the URL", () => {
    expect(parseConnectionFile(enc(valid))).toEqual({
      ok: true,
      connection: { url: "http://127.0.0.1:7331", token: TOKEN, scope: SCOPE },
    });
    for (const url of ["http://localhost:9000/", "http://[::1]:7331"]) {
      const result = parseConnectionFile(enc({ ...valid, url }));
      expect(result.ok).toBe(true);
    }
  });

  test("rejects extra, missing or wrongly typed keys", () => {
    expect(reason({ ...valid, extra: 1 })).toContain("exactly");
    expect(
      reason({ ...valid, scope: { ...SCOPE, workspace_id: "w" } }),
    ).toContain("exactly");
    const { token: _t, ...noToken } = valid;
    expect(reason(noToken)).toContain("exactly");
    expect(reason({ ...valid, schema_version: 2 })).toContain("exactly");
    expect(
      reason({ ...valid, scope: { owner_id: "", project_id: "p" } }),
    ).toContain("exactly");
    expect(reason([valid])).toContain("exactly");
    expect(
      reason(`{"__proto__":{"x":1},${JSON.stringify(valid).slice(1)}`),
    ).toContain("exactly");
  });

  test("enforces the token format", () => {
    for (const token of [
      "short",
      `${TOKEN}=`,
      "a".repeat(257),
      `${TOKEN.slice(1)} `,
    ])
      expect(reason({ ...valid, token })).toContain("token");
    expect(
      parseConnectionFile(enc({ ...valid, token: "a".repeat(32) })).ok,
    ).toBe(true);
  });

  test("requires a root HTTP loopback URL", () => {
    for (const url of [
      "https://127.0.0.1:7331",
      "http://example.com:7331",
      "http://10.0.0.1:7331",
      "http://127.0.0.1.nip.io",
      "http://user:pw@127.0.0.1:7331",
      "http://127.0.0.1:7331/api",
      "http://127.0.0.1:7331/?a=1",
      "http://127.0.0.1:7331/#x",
      "http://127.0.0.1:7331?",
      "file:///etc/passwd",
      "not a url",
    ])
      expect(reason({ ...valid, url })).toMatch(/url/);
  });

  test("rejects oversized, non-UTF-8 and non-JSON input without echoing it", () => {
    const big = new Uint8Array(MAX_CONNECTION_FILE_BYTES + 1).fill(0x20);
    expect(parseConnectionFile(big)).toEqual({
      ok: false,
      reason: "Connection file is larger than 16 KiB.",
    });
    expect(parseConnectionFile(new Uint8Array([0xff, 0xfe]))).toMatchObject({
      ok: false,
      reason: "Connection file is not valid UTF-8.",
    });
    expect(reason(`{"token":"${TOKEN}"`)).toBe(
      "Connection file is not valid JSON.",
    );
  });
});

describe("readConnectionFile", () => {
  const dir = mkdtempSync(join(tmpdir(), "mars-conn-"));
  const file = (name: string, body: string | Uint8Array, mode = 0o600) => {
    const path = join(dir, name);
    writeFileSync(path, body);
    chmodSync(path, mode);
    return path;
  };

  test("reads a private regular file", async () => {
    const result = await readConnectionFile(
      file("ok.json", JSON.stringify(valid)),
    );
    expect(result.ok && parseConnectionFile(result.bytes).ok).toBe(true);
  });

  test("rejects group/other-accessible files on POSIX only", async () => {
    const path = file("open.json", JSON.stringify(valid), 0o644);
    expect((await readConnectionFile(path)).ok).toBe(false);
    expect((await readConnectionFile(path, "win32")).ok).toBe(true);
  });

  test("rejects oversized files, directories, symlinks and missing paths", async () => {
    const big = file("big.json", new Uint8Array(MAX_CONNECTION_FILE_BYTES + 1));
    expect(await readConnectionFile(big)).toEqual({
      ok: false,
      reason: "Connection file is larger than 16 KiB.",
    });
    const sub = join(dir, "sub");
    mkdirSync(sub, { mode: 0o700 });
    expect((await readConnectionFile(sub)).ok).toBe(false);
    const link = join(dir, "link.json");
    symlinkSync(file("target.json", JSON.stringify(valid)), link);
    expect((await readConnectionFile(link)).ok).toBe(false);
    expect((await readConnectionFile(join(dir, "missing.json"))).ok).toBe(
      false,
    );
  });
});

describe("loadConnectionFile", () => {
  const dir = mkdtempSync(join(tmpdir(), "mars-conn-load-"));

  test("reads and parses in one step, passing read failures through", async () => {
    const path = join(dir, "connection.json");
    writeFileSync(path, JSON.stringify(valid));
    chmodSync(path, 0o600);
    expect(await loadConnectionFile(path)).toEqual({
      ok: true,
      connection: { url: "http://127.0.0.1:7331", token: TOKEN, scope: SCOPE },
    });
    expect(await loadConnectionFile(join(dir, "missing.json"))).toEqual({
      ok: false,
      reason: "Could not open the connection file.",
    });
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ ...valid, url: "http://10.0.0.1" }));
    chmodSync(bad, 0o600);
    expect(await loadConnectionFile(bad)).toEqual({
      ok: false,
      reason: "Connection file url must be a loopback address.",
    });
  });
});
