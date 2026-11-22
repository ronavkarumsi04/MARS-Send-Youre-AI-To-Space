import { expect, test } from "bun:test";
import { verifyRemoteSource } from "./check-remote-sources";

const revision = "a".repeat(40);
const root = `https://github.com/example/repo`;
const directoryUrl = `${root}/tree/${revision}/fixtures`;
const entry = (path: string, type = "blob") => ({
  path,
  type,
  mode: type === "tree" ? "040000" : "100644",
  sha: "b".repeat(40),
});
const tree = [
  entry("fixtures", "tree"),
  entry("fixtures/b.txt"),
  entry("fixtures/a.txt"),
  entry("other.txt"),
];
const reply = (value: unknown) => async () => Response.json(value);

test("files retain raw byte hashes", async () => {
  const result = await verifyRemoteSource(
    `${root}/blob/${revision}/README.md`,
    async (url) => {
      expect(String(url)).toBe(
        `https://raw.githubusercontent.com/example/repo/${revision}/README.md`,
      );
      return new Response("abc");
    },
  );
  expect(result).toMatchObject({
    kind: "file",
    sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  });
});

test("directories hash sorted relative Git entries, not raw-file URLs", async () => {
  const result = await verifyRemoteSource(directoryUrl, async (url) => {
    expect(String(url)).toBe(
      `https://api.github.com/repos/example/repo/git/trees/${revision}?recursive=1`,
    );
    return Response.json({ truncated: false, tree });
  });
  expect(result).toMatchObject({
    url: directoryUrl,
    kind: "directory",
    git_tree_sha: "b".repeat(40),
  });
  const expected = JSON.stringify(
    ["a.txt", "b.txt"].map((path) => entry(path)),
  );
  expect(result.sha256).toBe(
    new Bun.CryptoHasher("sha256").update(expected).digest("hex"),
  );
  expect(
    await verifyRemoteSource(
      directoryUrl,
      reply({ truncated: false, tree: [...tree].reverse() }),
    ),
  ).toEqual(result);
});

test("an empty directory has an explicit empty-list digest", async () => {
  const result = await verifyRemoteSource(
    directoryUrl,
    reply({ truncated: false, tree: [tree[0]] }),
  );
  expect(result.sha256).toBe(
    new Bun.CryptoHasher("sha256").update("[]").digest("hex"),
  );
});

test("directory verification fails closed for incomplete or missing trees", async () => {
  for (const value of [
    { truncated: true, tree },
    {},
    { truncated: false, tree: [] },
    { truncated: false, tree: [{}] },
  ])
    await expect(
      verifyRemoteSource(directoryUrl, reply(value)),
    ).rejects.toThrow();
  await expect(
    verifyRemoteSource(
      directoryUrl,
      async () => new Response("", { status: 403 }),
    ),
  ).rejects.toThrow("HTTP 403");
  await expect(
    verifyRemoteSource(`${root}/tree/main/fixtures`, reply({})),
  ).rejects.toThrow("immutable");
});
