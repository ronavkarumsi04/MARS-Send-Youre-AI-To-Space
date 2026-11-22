import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Official Fontshare files, unmodified. The license permits app embedding,
// but not distributing standalone fonts in a source repository.
export const fontCache = join(
  import.meta.dir,
  "../node_modules/.cache/mars-fonts",
);
export const websiteFonts = [
  {
    name: "Switzer-Medium.woff2",
    source:
      "OYB4CXKJQXKTNSLJMTDQOIVUL2V5EL7S/WYO2P7DQVV5RNXGMCUO2HL4RJP4VFUAS/6XPIMU23OJVRY676OG5YVJMWEHWICATX",
    sha: "7393d1abac009ede0da9f95d6c83479a08d798e28d3509575e02fb1d2346866f",
  },
  {
    name: "GeneralSans-Regular.woff2",
    source:
      "MFQT7HFGCR2L5ULQTW6YXYZXXHMPKLJ3/YWQ244D6TACUX5JBKATPOW5I5MGJ3G73/7YY3ZAAE3TRV2LANYOLXNHTPHLXVWTKH",
    sha: "3ec2be771caf168b077ca05af4df1dace77088e2b3a27da570036e61be58a039",
  },
];

if (import.meta.main) {
  await mkdir(fontCache, { recursive: true });
  for (const { name, source, sha } of websiteFonts) {
    const path = join(fontCache, name);
    const digest = (data: Uint8Array) =>
      createHash("sha256").update(data).digest("hex");
    const cached = await readFile(path).catch(() => undefined);
    if (cached && digest(cached) === sha) continue;
    const response = await fetch(
      `https://cdn.fontshare.com/wf/${source}.woff2`,
      { signal: AbortSignal.timeout(30000) },
    );
    if (!response.ok)
      throw new Error(
        `Fontshare could not provide ${name}: ${response.status}`,
      );
    const data = new Uint8Array(await response.arrayBuffer());
    if (digest(data) !== sha)
      throw new Error(`Unexpected font digest: ${name}`);
    await writeFile(path, data);
  }
}
