import type { ExtractedFile, RepositoryMap } from "./types";

export interface ParseCacheEntry extends ExtractedFile {
  sha256: string;
  extractorVersion: string;
}

export interface WorkspaceCache {
  scopeKey: string;
  rootHash: string;
  files: Map<string, ParseCacheEntry>;
  maps: Map<string, RepositoryMap>;
}

export function touchLru<V>(
  entries: Map<string, V>,
  key: string,
  value: V,
  limit: number,
): void {
  entries.delete(key);
  entries.set(key, value);
  while (entries.size > limit) {
    const oldest = entries.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}

export function cloneMap(map: RepositoryMap): RepositoryMap {
  return {
    ...map,
    workspace: { ...map.workspace },
    files: map.files.map((file) => ({
      ...file,
      symbols: file.symbols.map((symbol) => ({ ...symbol })),
    })),
    stats: {
      ...map.stats,
      skipped: { ...map.stats.skipped },
    },
  };
}
