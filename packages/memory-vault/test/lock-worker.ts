import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withVaultLock } from "../src/lock";

const root = process.argv[2];
if (!root) throw new Error("vault directory required");
await withVaultLock(root, async () => {
  await appendFile(join(root, "events"), "start\n");
  await writeFile(join(root, "ready"), "ready");
  if (process.argv[3] === "crash") process.exit(0);
  await Bun.sleep(80);
  await appendFile(join(root, "events"), "end\n");
});
