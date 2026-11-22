import { expect, test } from "bun:test";
import { replaceDurably } from "./durable";

function fixture(fail?: string, code = "EIO") {
  const events: string[] = [];
  const record = async (event: string) => {
    events.push(event);
    if (event === fail) throw Object.assign(new Error(code), { code });
  };
  const io = {
    async open(path: string) {
      const kind = path === "/vault" ? "dir" : "file";
      await record(`open:${kind}`);
      return {
        writeFile: async () => record("write"),
        sync: async () => record(`sync:${kind}`),
        close: async () => record(`close:${kind}`),
      };
    },
    rename: async () => record("rename"),
  };
  return { io, events };
}

test("durability: temp file is synced before rename and directory after rename, including empty files", async () => {
  for (const text of ["content", ""]) {
    const { io, events } = fixture();
    await replaceDurably("/vault/temp", "/vault/note", text, io);
    expect(events).toEqual([
      "open:file",
      "write",
      "sync:file",
      "close:file",
      "rename",
      "open:dir",
      "sync:dir",
      "close:dir",
    ]);
  }
});

test("durability: failed file sync prevents rename and closes the file", async () => {
  const { io, events } = fixture("sync:file");
  await expect(
    replaceDurably("/vault/temp", "/vault/note", "", io),
  ).rejects.toMatchObject({ code: "EIO" });
  expect(events).toEqual(["open:file", "write", "sync:file", "close:file"]);
});

test("durability: unsupported directory sync is best effort but disk errors propagate", async () => {
  for (const code of ["EISDIR", "EPERM", "EINVAL", "ENOTSUP"]) {
    const { io, events } = fixture("sync:dir", code);
    await replaceDurably("/vault/temp", "/vault/note", "", io);
    expect(events.at(-1)).toBe("close:dir");
  }
  const { io } = fixture("sync:dir");
  await expect(
    replaceDurably("/vault/temp", "/vault/note", "", io),
  ).rejects.toMatchObject({ code: "EIO" });
});
