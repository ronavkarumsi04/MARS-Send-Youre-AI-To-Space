import { constants } from "node:fs";
import { type FileHandle, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  descriptorPath,
  removeFileInside,
  type VaultRoot,
  verifyOpenedInside,
  verifyVaultRoot,
} from "./paths";

interface DurableHandle {
  writeFile(text: string): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

interface DurableIO {
  open(path: string, flags: string, mode?: number): Promise<DurableHandle>;
  rename(from: string, to: string): Promise<unknown>;
}

const UNSUPPORTED_DIRECTORY_SYNC = new Set([
  "EISDIR",
  "EPERM",
  "EINVAL",
  "ENOTSUP",
  "ENOSYS",
  "EBADF",
  "EACCES",
]);

export async function replaceDurably(
  temporary: string,
  target: string,
  text: string,
  io: DurableIO = { open, rename },
  containment?: { root: VaultRoot; beforeOpen?: () => Promise<void> },
): Promise<void> {
  if (containment)
    return replaceInsideDurably(temporary, target, text, containment);
  const file = await io.open(temporary, "wx", 0o600);
  try {
    await file.writeFile(text);
    await file.sync();
  } finally {
    await file.close();
  }
  await io.rename(temporary, target);
  let directory: DurableHandle | undefined;
  try {
    directory = await io.open(dirname(target), "r");
    await directory.sync();
  } catch (error) {
    if (
      !UNSUPPORTED_DIRECTORY_SYNC.has(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      throw error;
  } finally {
    await directory?.close();
  }
}

async function replaceInsideDurably(
  temporary: string,
  target: string,
  text: string,
  options: { root: VaultRoot; beforeOpen?: () => Promise<void> },
): Promise<void> {
  const root = options.root;
  await verifyVaultRoot(root);
  const parent = await open(
    dirname(target),
    constants.O_RDONLY |
      (constants.O_DIRECTORY ?? 0) |
      (constants.O_NOFOLLOW ?? 0),
  );
  let file: FileHandle | undefined;
  let renamed = false;
  const parentPath = descriptorPath(parent, dirname(target));
  const tempPath = join(parentPath, basename(temporary));
  const targetPath = join(parentPath, basename(target));
  try {
    await verifyOpenedInside(root, dirname(target), parent);
    await options.beforeOpen?.();
    if (process.platform !== "linux")
      await verifyOpenedInside(root, dirname(target), parent);
    file = await open(tempPath, "wx", 0o600);
    await verifyOpenedInside(root, temporary, file);
    await verifyOpenedInside(root, dirname(target), parent);
    await file.writeFile(text);
    await file.sync();
    await rename(tempPath, targetPath);
    renamed = true;
    await verifyOpenedInside(root, target, file);
    await verifyOpenedInside(root, dirname(target), parent);
    try {
      await parent.sync();
    } catch (error) {
      if (
        !UNSUPPORTED_DIRECTORY_SYNC.has(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw error;
    }
    await verifyOpenedInside(root, dirname(target), parent);
  } finally {
    try {
      if (file && !renamed) {
        // Linux cleanup stays anchored even if the original parent path changed.
        if (process.platform === "linux") await rm(tempPath, { force: true });
        else
          await removeFileInside(
            root,
            temporary,
            undefined,
            await file.stat(),
          ).catch(() => undefined);
      }
    } finally {
      try {
        await file?.close();
      } finally {
        await parent.close();
      }
    }
  }
}
