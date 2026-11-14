import { constants } from "node:fs";
import {
  type FileHandle,
  open,
  readdir,
  readlink,
  realpath,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

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
  ): Promise<{ handle: FileHandle; path: string } | undefined> {
    let pending = relative(this.root, resolve(this.root, path))
      .split(sep)
      .filter(Boolean);
    if (!inside(this.root, resolve(this.root, path))) return undefined;
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
        if (!name || name === "." || name === "..") return undefined;
        const anchored = `/proc/self/fd/${parent.fd}/${name}`;
        let child: FileHandle;
        try {
          child = await open(
            anchored,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ELOOP") return undefined;
          if (++links > 40) return undefined;
          const target = resolve(this.root, ...parts, await readlink(anchored));
          if (!inside(this.root, target)) return undefined;
          pending = [
            ...relative(this.root, target).split(sep).filter(Boolean),
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
    } catch {
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
      const buffer = Buffer.alloc(maxBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await entry.handle.read(
          buffer,
          length,
          buffer.length - length,
          null,
        );
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > maxBytes) return { reason: "oversize" };
      return { data: buffer.subarray(0, length), path: entry.path };
    } finally {
      await entry.handle.close();
    }
  }
}
