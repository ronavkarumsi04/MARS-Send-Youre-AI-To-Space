import { close, constants, fstat, read } from "node:fs";
import { promisify } from "node:util";
import {
  LimitExceededError,
  WorkspaceNotFoundError,
  WorkspacePolicyError,
} from "./errors";

export function openatPlatform(platform: string, arch: string) {
  if (arch !== "x64" && arch !== "arm64")
    throw new WorkspacePolicyError("Anchored file reads are unavailable");
  if (platform === "darwin")
    return {
      library: "/usr/lib/libSystem.B.dylib",
      atFdcwd: -2,
      flags: {
        O_RDONLY: 0,
        O_NONBLOCK: 4,
        O_DIRECTORY: 0x100000,
        O_NOFOLLOW: 0x100,
        O_CLOEXEC: 0x1000000,
      },
    };
  if (platform === "linux")
    return {
      library: "libc.so.6",
      atFdcwd: -100,
      flags: {
        O_RDONLY: 0,
        O_NONBLOCK: 0x800,
        O_DIRECTORY: arch === "arm64" ? 0x4000 : 0x10000,
        O_NOFOLLOW: arch === "arm64" ? 0x8000 : 0x20000,
        O_CLOEXEC: 0x80000,
      },
    };
  throw new WorkspacePolicyError("Anchored file reads are unavailable");
}

export function openatErrnoCode(platform: string, errno: number) {
  if (platform !== "linux" && platform !== "darwin") return undefined;
  if (errno === (platform === "darwin" ? 62 : 40)) return "ELOOP";
  const codes: Readonly<Record<number, string>> = {
    1: "EPERM",
    2: "ENOENT",
    4: "EINTR",
    5: "EIO",
    9: "EBADF",
    13: "EACCES",
    20: "ENOTDIR",
  };
  return codes[errno];
}

async function createOpenat() {
  const config = openatPlatform(process.platform, process.arch);
  for (const name of [
    "O_RDONLY",
    "O_NONBLOCK",
    "O_DIRECTORY",
    "O_NOFOLLOW",
  ] as const)
    if (config.flags[name] !== constants[name])
      throw new WorkspacePolicyError(
        "Anchored file read flags are unavailable",
      );
  try {
    const ffi = await import("bun:ffi");
    const functions = {
      openat: { args: ["i32", "ptr", "i32"], returns: "i32" },
    } as const;
    const library =
      process.platform === "darwin"
        ? ffi.dlopen(config.library, {
            ...functions,
            __error: { args: [], returns: "ptr" },
          })
        : ffi.dlopen(config.library, {
            ...functions,
            __errno_location: { args: [], returns: "ptr" },
          });
    return {
      config,
      open(dirfd: number, path: string, flags: number) {
        const fd = library.symbols.openat(
          dirfd,
          Buffer.from(`${path}\0`),
          flags,
        );
        if (fd >= 0) return fd;
        const pointer =
          "__error" in library.symbols
            ? library.symbols.__error()
            : library.symbols.__errno_location();
        if (!pointer)
          throw new WorkspacePolicyError(
            "Anchored file read errno unavailable",
          );
        const errno = ffi.read.i32(pointer);
        throw Object.assign(new Error("Anchored workspace open failed"), {
          code: openatErrnoCode(process.platform, errno) ?? "EOPENAT",
          errno,
        });
      },
    };
  } catch {
    throw new WorkspacePolicyError("Anchored file reads are unavailable");
  }
}

let openat: ReturnType<typeof createOpenat> | undefined;
const statFd = promisify(fstat);
const readFd = promisify(read);
const closeFd = promisify(close);

export async function readAnchored(
  root: string,
  path: string,
  maxBytes: number,
): Promise<Uint8Array> {
  openat ??= createOpenat();
  const native = await openat;
  const { flags, atFdcwd } = native.config;
  const descriptors: number[] = [];
  const segments = path.split("/");
  const fileFlags =
    flags.O_RDONLY | flags.O_NOFOLLOW | flags.O_NONBLOCK | flags.O_CLOEXEC;
  try {
    const rootFd = native.open(atFdcwd, root, fileFlags | flags.O_DIRECTORY);
    descriptors.push(rootFd);
    for (const [index, segment] of segments.entries()) {
      const parent = descriptors[descriptors.length - 1];
      if (parent === undefined) throw new WorkspacePolicyError();
      const last = index === segments.length - 1;
      const fd = native.open(
        parent,
        segment,
        fileFlags | (last ? 0 : flags.O_DIRECTORY),
      );
      descriptors.push(fd);
      if (!last) continue;
      const info = await statFd(fd);
      if (!info.isFile() || info.nlink !== 1)
        throw new WorkspacePolicyError(
          "Workspace file must be singly linked and regular",
        );
      if (info.size > maxBytes)
        throw new LimitExceededError("File exceeds read bound");
      const data = await readBounded(fd, maxBytes);
      const after = await statFd(fd);
      if (
        after.nlink !== 1 ||
        after.size !== info.size ||
        after.mtimeMs !== info.mtimeMs ||
        after.ctimeMs !== info.ctimeMs
      )
        throw new WorkspacePolicyError("Workspace file changed during read");
      return data;
    }
    throw new WorkspacePolicyError();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" && segments.length === 1 && descriptors.length === 1)
      throw new WorkspaceNotFoundError();
    if (["ENOENT", "ENOTDIR", "ELOOP", "EACCES", "EPERM"].includes(code ?? ""))
      throw new WorkspacePolicyError("Workspace path changed or denied");
    throw error;
  } finally {
    await Promise.all(descriptors.map((fd) => closeFd(fd)));
  }
}

async function readBounded(fd: number, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const length =
      total === maxBytes ? 1 : Math.min(64 * 1024, maxBytes - total);
    const chunk = Buffer.allocUnsafe(length);
    const { bytesRead } = await readFd(fd, chunk, 0, length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maxBytes)
      throw new LimitExceededError("File exceeds read bound");
    chunks.push(chunk.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, total);
}
