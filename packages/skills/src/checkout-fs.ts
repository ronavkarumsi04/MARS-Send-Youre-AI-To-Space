import { constants } from "node:fs";
import {
  type FileHandle,
  open,
  readdir,
  readlink,
  realpath,
} from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

export function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return (
    rel === "" ||
    (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
  );
}

/** Read-only, fd-anchored traversal. Links are resolved component by component. */
export class CheckoutFS {
  private constructor(
    readonly root: string,
    private readonly handle: FileHandle,
  ) {}

  static async open(root: string): Promise<CheckoutFS> {
    const canonical = await realpath(root);
    const handle = await open(
      canonical,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      // Fail closed where directory-fd traversal is unavailable, rather than race a pathname.
      await readdir(`/proc/self/fd/${handle.fd}`);
      return new CheckoutFS(canonical, handle);
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  close() {
    return this.handle.close();
  }

  async entry(
    path: string,
    failOnIOError = false,
  ): Promise<{ handle: FileHandle; path: string } | undefined> {
    const relativeParts = (value: string): string[] | undefined => {
      if (!isAbsolute(value)) return value.split(sep).filter(Boolean);
      if (value === this.root) return [];
      if (!value.startsWith(this.root + sep)) return undefined;
      return value
        .slice(this.root.length + 1)
        .split(sep)
        .filter(Boolean);
    };
    const initial = relativeParts(path);
    if (!initial) return undefined;
    let pending: string[] = initial;
    let parent = await open(
      `/proc/self/fd/${this.handle.fd}`,
      constants.O_RDONLY | constants.O_DIRECTORY,
    );
    let parts: string[] = [];
    let links = 0;
    let owned = true;
    try {
      while (pending.length) {
        const name = pending.shift();
        if (!name || name === ".") continue;
        if (name === "..") {
          if (!parts.length) return undefined;
          parts.pop();
          pending = [...parts, ...pending];
          parts = [];
          await parent.close();
          parent = await open(
            `/proc/self/fd/${this.handle.fd}`,
            constants.O_RDONLY | constants.O_DIRECTORY,
          );
          continue;
        }
        const anchored = `/proc/self/fd/${parent.fd}/${name}`;
        let child: FileHandle;
        try {
          child = await open(
            anchored,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ELOOP") {
            if (code === "ENOENT" || code === "ENOTDIR") return undefined;
            throw error;
          }
          if (++links > 40) return undefined;
          const target = await readlink(anchored);
          const targetParts = relativeParts(target);
          if (!targetParts) return undefined;
          // Preserve .. until preceding symlinks have been resolved (POSIX semantics).
          pending = [
            ...(isAbsolute(target) ? [] : parts),
            ...targetParts,
            ...pending,
          ];
          parts = [];
          await parent.close();
          parent = await open(
            `/proc/self/fd/${this.handle.fd}`,
            constants.O_RDONLY | constants.O_DIRECTORY,
          );
          continue;
        }
        await parent.close();
        parent = child;
        parts.push(name);
        if (pending.length && !(await parent.stat()).isDirectory())
          return undefined;
      }
      const result = { handle: parent, path: join(this.root, ...parts) };
      owned = false;
      return result;
    } catch (error) {
      if (failOnIOError) throw error;
      return undefined;
    } finally {
      if (owned) await parent.close();
    }
  }

  async directory(path: string): Promise<string[] | undefined> {
    const entry = await this.entry(path);
    if (!entry) return undefined;
    try {
      if (!(await entry.handle.stat()).isDirectory()) return undefined;
      return (await readdir(`/proc/self/fd/${entry.handle.fd}`)).sort();
    } finally {
      await entry.handle.close();
    }
  }

  async read(
    path: string,
    maxBytes: number,
  ): Promise<{ data: Buffer; path: string } | { reason: string }> {
    const entry = await this.entry(path);
    if (!entry) return { reason: "missing-or-unsafe-link" };
    try {
      const stat = await entry.handle.stat();
      if (!stat.isFile()) return { reason: "not-file" };
      if (stat.size > maxBytes) return { reason: "oversize" };
      const chunks: Buffer[] = [];
      let length = 0;
      while (length <= maxBytes) {
        const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - length));
        const { bytesRead } = await entry.handle.read(
          buffer,
          0,
          buffer.length,
          null,
        );
        if (!bytesRead) break;
        chunks.push(buffer.subarray(0, bytesRead));
        length += bytesRead;
      }
      if (length > maxBytes) return { reason: "oversize" };
      return { data: Buffer.concat(chunks, length), path: entry.path };
    } finally {
      await entry.handle.close();
    }
  }
}
