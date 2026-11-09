import { describe, expect, test } from "bun:test";
import { type ImportHost, importConnection } from "../src/connectionFile";

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

function fakeHost(
  overrides: Partial<ImportHost> & {
    file?: unknown;
    token?: string;
    url?: string;
  } = {},
) {
  const state = {
    token: overrides.token,
    url: overrides.url,
    confirms: [] as string[],
    answer: true,
    suspended: 0,
    log: [] as string[],
  };
  const host: ImportHost = {
    pickFile: async () => "/tmp/connection.json",
    readFile: async () => ({ ok: true, bytes: enc(overrides.file ?? valid) }),
    globalServerUrl: () => state.url,
    getToken: async () => state.token,
    storeToken: async (token) => {
      state.log.push(`token:${state.suspended}`);
      state.token = token;
    },
    deleteToken: async () => {
      state.token = undefined;
    },
    storeGlobalServerUrl: async (url) => {
      state.log.push(`url:${state.suspended}`);
      state.url = url;
    },
    suspendConnections: () => {
      state.suspended++;
      state.log.push("suspend");
      return () => {
        state.suspended--;
        state.log.push("resume");
      };
    },
    confirm: async (message, detail) => {
      state.confirms.push(`${message}\n${detail}`);
      return state.answer;
    },
    ...overrides,
  };
  return { host, state };
}

describe("importConnection", () => {
  test("first import stores token and global URL without a prompt", async () => {
    const { host, state } = fakeHost();
    expect(await importConnection(host)).toEqual({
      status: "imported",
      url: "http://127.0.0.1:7331",
      scope: SCOPE,
    });
    expect(state).toMatchObject({ token: TOKEN, url: "http://127.0.0.1:7331" });
    expect(state.confirms).toEqual([]);
    expect(state.log).toEqual(["suspend", "token:1", "url:1", "resume"]);
  });

  test("replacing an existing token or URL needs confirmation that never shows the token", async () => {
    const declined = fakeHost({
      token: "old-token-value",
      url: "http://127.0.0.1:9999",
    });
    declined.state.answer = false;
    expect(await importConnection(declined.host)).toEqual({
      status: "cancelled",
    });
    expect(declined.state).toMatchObject({
      token: "old-token-value",
      url: "http://127.0.0.1:9999",
    });
    const prompt = declined.state.confirms.join("\n");
    expect(prompt).toContain("http://127.0.0.1:9999 → http://127.0.0.1:7331");
    expect(prompt).not.toContain(TOKEN);
    expect(prompt).not.toContain("old-token-value");

    const accepted = fakeHost({ url: "http://127.0.0.1:9999" });
    expect((await importConnection(accepted.host)).status).toBe("imported");
    expect(accepted.state.confirms).toHaveLength(1);
    expect(accepted.state.url).toBe("http://127.0.0.1:7331");

    const same = fakeHost({ url: "http://127.0.0.1:7331/" });
    expect((await importConnection(same.host)).status).toBe("imported");
    expect(same.state.confirms).toEqual([]);
  });

  test("cancelled picker, unreadable or invalid files change nothing", async () => {
    const picker = fakeHost({ pickFile: async () => undefined });
    expect(await importConnection(picker.host)).toEqual({
      status: "cancelled",
    });
    const unreadable = fakeHost({
      readFile: async () => ({ ok: false, reason: "nope" }),
    });
    expect(await importConnection(unreadable.host)).toEqual({
      status: "rejected",
      reason: "nope",
    });
    const remote = fakeHost({ file: { ...valid, url: "http://example.com" } });
    const outcome = await importConnection(remote.host);
    expect(outcome.status).toBe("rejected");
    expect(JSON.stringify(outcome)).not.toContain(TOKEN);
    for (const ctx of [picker, unreadable, remote])
      expect(ctx.state).toMatchObject({
        token: undefined,
        url: undefined,
        log: [],
      });
  });

  test("a failed URL save rolls the token back", async () => {
    const failing = fakeHost({
      token: "old-token-value",
      storeGlobalServerUrl: async () => {
        throw new Error(`boom ${TOKEN}`);
      },
    });
    const outcome = await importConnection(failing.host);
    expect(outcome.status).toBe("failed");
    expect(JSON.stringify(outcome)).not.toContain(TOKEN);
    expect(failing.state.token).toBe("old-token-value");
    expect(failing.state.log.at(-1)).toBe("resume");
    expect(failing.state.suspended).toBe(0);
    const fresh = fakeHost({
      storeGlobalServerUrl: async () => {
        throw new Error("boom");
      },
    });
    expect(await importConnection(fresh.host)).toEqual({
      status: "failed",
      reason: "Could not save the server URL; the new token was removed.",
    });
    expect(fresh.state.token).toBeUndefined();
  });

  test("a failed URL save reports whether the token rollback worked", async () => {
    const restored = fakeHost({
      token: "old-token-value",
      storeGlobalServerUrl: async () => {
        throw new Error("boom");
      },
    });
    expect(await importConnection(restored.host)).toEqual({
      status: "failed",
      reason: "Could not save the server URL; the previous token was restored.",
    });

    let writes = 0;
    const stuck = fakeHost({
      token: "old-token-value",
      storeToken: async (token) => {
        if (++writes > 1) throw new Error(`rollback ${token}`);
        stuck.state.token = token;
      },
      storeGlobalServerUrl: async () => {
        throw new Error("boom");
      },
    });
    const stuckOutcome = await importConnection(stuck.host);
    expect(stuckOutcome).toEqual({
      status: "failed",
      reason:
        "Could not save the server URL; the stored token could not be rolled back, re-import the connection file.",
    });
    expect(JSON.stringify(stuckOutcome)).not.toContain(TOKEN);
    expect(JSON.stringify(stuckOutcome)).not.toContain("old-token-value");
    expect(stuck.state.suspended).toBe(0);

    const undeletable = fakeHost({
      deleteToken: async () => {
        throw new Error("nope");
      },
      storeGlobalServerUrl: async () => {
        throw new Error("boom");
      },
    });
    expect(await importConnection(undeletable.host)).toEqual({
      status: "failed",
      reason:
        "Could not save the server URL; the stored token could not be rolled back, re-import the connection file.",
    });
  });
});
