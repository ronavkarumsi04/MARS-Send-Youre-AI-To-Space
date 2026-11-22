import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "@modelcontextprotocol/server-filesystem/dist/server.js";
import { requireProjectRoot } from "../src/runtime/project-root";

const [root, identity] = process.argv.slice(2);
requireProjectRoot(root, identity);
// Pass only the approved canonical path. Upstream CLI startup expands aliases
// by adding their current targets as additional allowed directories.
serveStdio(({ era }) =>
  createServer([root], { era, readOnly: true, confineRoots: true }),
);
