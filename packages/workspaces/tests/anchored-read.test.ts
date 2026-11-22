import { expect, test } from "bun:test";
import { closeSync, constants, fstatSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openatErrnoCode,
  openatPlatform,
  readAnchored,
} from "../src/anchored-read";

test("openat flags match Linux x64 and arm64 UAPI values", () => {
  expect(openatPlatform("linux", "x64")).toMatchObject({
    library: "libc.so.6",
    atFdcwd: -100,
    flags: {
      O_RDONLY: 0,
      O_NONBLOCK: 0x800,
      O_DIRECTORY: 0x10000,
      O_NOFOLLOW: 0x20000,
      O_CLOEXEC: 0x80000,
    },
  });
  expect(openatPlatform("linux", "arm64").flags).toEqual({
    O_RDONLY: 0,
    O_NONBLOCK: 0x800,
    O_DIRECTORY: 0x4000,
    O_NOFOLLOW: 0x8000,
    O_CLOEXEC: 0x80000,
  });
});

test.each(["x64", "arm64"])("openat flags match Darwin %s headers", (arch) => {
  expect(openatPlatform("darwin", arch)).toMatchObject({
    library: "/usr/lib/libSystem.B.dylib",
    atFdcwd: -2,
    flags: {
      O_RDONLY: 0,
      O_NONBLOCK: 4,
      O_DIRECTORY: 0x100000,
      O_NOFOLLOW: 0x100,
      O_CLOEXEC: 0x1000000,
    },
  });
});

test.skipIf(!["linux", "darwin"].includes(process.platform))(
  "openat flags agree with the running platform's filesystem constants",
  () => {
    const { flags } = openatPlatform(process.platform, process.arch);
    for (const name of [
      "O_RDONLY",
      "O_NONBLOCK",
      "O_DIRECTORY",
      "O_NOFOLLOW",
    ] as const)
      expect(flags[name]).toBe(constants[name]);
  },
);

test.skipIf(!["linux", "darwin"].includes(process.platform))(
  "native openat opens a directory with close-on-exec set",
  async () => {
    const { dlopen } = await import("bun:ffi");
    const config = openatPlatform(process.platform, process.arch);
    const library = dlopen(config.library, {
      openat: { args: ["i32", "ptr", "i32"], returns: "i32" },
      fcntl: { args: ["i32", "i32"], returns: "i32" },
    });
    let fd = -1;
    try {
      const flags = config.flags;
      fd = library.symbols.openat(
        config.atFdcwd,
        Buffer.from("/\0"),
        flags.O_RDONLY | flags.O_DIRECTORY | flags.O_NOFOLLOW | flags.O_CLOEXEC,
      );
      expect(fd).toBeGreaterThanOrEqual(0);
      expect(fstatSync(fd).isDirectory()).toBe(true);
      expect(library.symbols.fcntl(fd, 1) & 1).toBe(1);
    } finally {
      if (fd >= 0) closeSync(fd);
      library.close();
    }
  },
);

test("openat rejects unsupported platforms and architectures", () => {
  for (const [platform, arch] of [
    ["win32", "x64"],
    ["freebsd", "x64"],
    ["linux", "ia32"],
  ] as const)
    expect(() => openatPlatform(platform, arch)).toThrow(
      expect.objectContaining({ code: "policy" }),
    );
});

test.each(["linux", "darwin"])(
  "openat maps %s errno without guessing",
  (platform) => {
    for (const [errno, code] of [
      [1, "EPERM"],
      [2, "ENOENT"],
      [4, "EINTR"],
      [5, "EIO"],
      [9, "EBADF"],
      [13, "EACCES"],
      [20, "ENOTDIR"],
    ] as const)
      expect(openatErrnoCode(platform, errno)).toBe(code);
    expect(openatErrnoCode(platform, platform === "darwin" ? 62 : 40)).toBe(
      "ELOOP",
    );
    expect(
      openatErrnoCode(platform, platform === "darwin" ? 40 : 62),
    ).toBeUndefined();
    expect(openatErrnoCode(platform, 9999)).toBeUndefined();
    expect(openatErrnoCode("win32", 2)).toBeUndefined();
  },
);

test.skipIf(!["linux", "darwin"].includes(process.platform))(
  "native openat reads empty files at a zero bound and maps real missing paths",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "mars-openat-"));
    try {
      await writeFile(join(root, "empty.txt"), "");
      await writeFile(join(root, "full.txt"), "content");
      expect(await readAnchored(root, "empty.txt", 0)).toEqual(Buffer.alloc(0));
      await expect(readAnchored(root, "full.txt", 0)).rejects.toMatchObject({
        code: "limit_exceeded",
      });
      await expect(readAnchored(root, "missing.txt", 10)).rejects.toMatchObject(
        {
          code: "not_found",
        },
      );
      await expect(
        readAnchored(root, "missing/file.txt", 10),
      ).rejects.toMatchObject({
        code: "policy",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
