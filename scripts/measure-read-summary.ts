import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { renderRead } from "../packages/execution/src/read-summary";

const { countTokens, Encoding } = createRequire(
  new URL("../packages/execution/package.json", import.meta.url),
)("@oh-my-pi/pi-natives") as {
  countTokens(input: string, encoding: string): number;
  Encoding: { O200kBase: string };
};

const paths = process.argv.slice(2);
const files = paths.length
  ? paths
  : [
      "packages/execution/src/runtime.ts",
      "packages/workbench/src/host.ts",
      "packages/workspaces/src/provider.ts",
      "HANDOFF.md",
      "packages/execution/src/runtime.test.ts",
    ];
console.log(
  "Tokens counted with installed pi-natives countTokens, Encoding.O200kBase (text only, no chat framing).",
);
console.log(
  "| File | Full bytes | Outline bytes | Full tokens | Outline tokens | Byte savings | ",
);
console.log("| --- | ---: | ---: | ---: | ---: | ---: |");
for (const path of files) {
  const bytes = new Uint8Array(await readFile(resolve(path)));
  const full = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const outlined = renderRead(path, bytes);
  const outputBytes = Buffer.byteLength(outlined, "utf8");
  console.log(
    `| ${path} | ${bytes.length} | ${outputBytes} | ${countTokens(full, Encoding.O200kBase)} | ${countTokens(outlined, Encoding.O200kBase)} | ${(100 * (1 - outputBytes / bytes.length)).toFixed(1)}% |`,
  );
}
