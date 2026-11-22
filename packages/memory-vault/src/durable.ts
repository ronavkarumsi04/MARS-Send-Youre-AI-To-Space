import { open, rename } from "node:fs/promises";
import { dirname } from "node:path";

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
): Promise<void> {
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
