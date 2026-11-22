import { createHash } from "node:crypto";
import { join } from "node:path";
import { findExtension } from "../src/runtime/extension-catalog";

// Build only during packaging/tests from the frozen workspace install. Desktop
// installs must work offline and must never resolve packages or run npm scripts.
export async function buildUpstream(destination: string) {
  for (const name of ["filesystem", "sequential-thinking"]) {
    const pkg = `@modelcontextprotocol/server-${name}`;
    const entry = findExtension(`mcp-${name}`);
    const asset = entry?.assets[0];
    if (!asset) throw new Error(`Missing catalog pin for ${pkg}`);
    const root = join(import.meta.dir, "../node_modules", pkg);
    const manifest = await Bun.file(join(root, "package.json")).json();
    if (manifest.name !== pkg || manifest.version !== entry?.version)
      throw new Error(`Unexpected package version for ${pkg}`);
    const result = await Bun.build({
      entrypoints: [
        name === "filesystem"
          ? join(import.meta.dir, "filesystem.mjs")
          : join(root, "dist/index.js"),
      ],
      target: "bun",
      minify: true,
      // Upstream locates its package.json beside its script. Inline the version
      // from the locked package so the shipped file has no sidecar dependencies.
      plugins: [
        {
          name: "standalone-version",
          setup(build) {
            build.onLoad(
              {
                filter:
                  /server-(?:filesystem|sequential-thinking)\/dist\/version\.js$/,
              },
              () => ({
                contents: `export const SERVER_VERSION = ${JSON.stringify(manifest.version)};`,
                loader: "js",
              }),
            );
          },
        },
      ],
      define: { "process.env.DISABLE_THOUGHT_LOGGING": '"true"' },
    });
    const [bundle] = result.outputs;
    if (!result.success || !bundle || result.outputs.length !== 1)
      throw new Error(`Could not bundle ${pkg}: ${result.logs.join("\n")}`);
    const bytes = new Uint8Array(await bundle.arrayBuffer());
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== asset.sha256)
      throw new Error(`Unexpected bundle digest for ${pkg}: ${actual}`);
    await Bun.write(join(destination, asset.file), bytes);
  }
}
