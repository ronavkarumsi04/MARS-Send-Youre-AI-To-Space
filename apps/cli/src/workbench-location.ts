import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// `mars serve`, `mars vault` and `mars session` must agree on these defaults:
// serve writes connection.json and the stores here, vault and session read them.

export function defaultProjectId(sourceRealpath: string): string {
  return `project-${createHash("sha256").update(sourceRealpath).digest("hex").slice(0, 24)}`;
}

export function defaultStateRoot(project: string): string {
  return join(homedir(), ".mars", "workbench", project);
}

export interface WorkbenchLocation {
  source: string;
  project: string;
  state: string;
}

export async function resolveWorkbenchLocation(flags: {
  source?: string | undefined;
  project?: string | undefined;
  state?: string | undefined;
}): Promise<WorkbenchLocation> {
  const source = await realpath(resolve(flags.source ?? process.cwd()));
  const project = flags.project ?? defaultProjectId(source);
  const state = resolve(flags.state ?? defaultStateRoot(project));
  return { source, project, state };
}
