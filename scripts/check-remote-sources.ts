import { checkSources, type SourceManifest } from "./check-sources";

interface VerifiedSource {
  url: string;
  sha256: string;
  kind: "file" | "directory";
  git_tree_sha?: string;
}

const sha256 = (bytes: string | ArrayBuffer) =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

export async function verifyRemoteSource(
  sourceUrl: string,
  fetcher: (url: string, init?: RequestInit) => Promise<Response> = fetch,
): Promise<VerifiedSource> {
  const url = new URL(sourceUrl);
  const match = /^\/([^/]+)\/([^/]+)\/(blob|tree)\/([a-f0-9]{40})\/(.+)$/.exec(
    url.pathname,
  );
  if (url.origin !== "https://github.com" || !match)
    throw new Error("Expected an immutable GitHub file or directory URL");
  const [, owner, repo, view, revision, path] = match;
  const target =
    view === "tree"
      ? `https://api.github.com/repos/${owner}/${repo}/git/trees/${revision}?recursive=1`
      : `https://raw.githubusercontent.com/${owner}/${repo}/${revision}/${path}`;
  const response = await fetcher(target, {
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (view !== "tree")
    return {
      url: target,
      kind: "file",
      sha256: sha256(await response.arrayBuffer()),
    };
  const result: unknown = await response.json();
  if (
    !result ||
    typeof result !== "object" ||
    !("tree" in result) ||
    !("truncated" in result) ||
    result.truncated !== false ||
    !Array.isArray(result.tree)
  )
    throw new Error("Missing or truncated Git tree");
  const entries = result.tree.map((entry: unknown) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      !("path" in entry) ||
      typeof entry.path !== "string" ||
      !("type" in entry) ||
      !["blob", "tree", "commit"].includes(String(entry.type)) ||
      !("mode" in entry) ||
      typeof entry.mode !== "string" ||
      !("sha" in entry) ||
      typeof entry.sha !== "string" ||
      !/^[a-f0-9]{40}$/.test(entry.sha)
    )
      throw new Error("Malformed Git tree entry");
    return {
      path: entry.path,
      type: String(entry.type),
      mode: entry.mode,
      sha: entry.sha,
    };
  });
  const directory = entries.find(
    (entry) => entry.path === path && entry.type === "tree",
  );
  if (!directory) throw new Error("Pinned directory is missing");
  const children = entries
    .filter((entry) => entry.path.startsWith(`${path}/`))
    .map((entry) => ({
      ...entry,
      path: entry.path.slice((path?.length ?? 0) + 1),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    url: sourceUrl,
    kind: "directory",
    git_tree_sha: directory.sha,
    sha256: sha256(JSON.stringify(children)),
  };
}

export async function checkRemoteSources(
  manifest: SourceManifest,
  fetcher: (url: string, init?: RequestInit) => Promise<Response> = fetch,
) {
  const urls = [
    ...new Set(
      manifest.components.flatMap((component) =>
        [...component.sources, component.license].map((source) => source.url),
      ),
    ),
  ];
  const failures: string[] = [];
  const verified: VerifiedSource[] = [];
  let index = 0;
  async function worker(): Promise<void> {
    while (index < urls.length) {
      const url = urls[index++];
      if (!url) break;
      try {
        verified.push(await verifyRemoteSource(url, fetcher));
      } catch (error) {
        failures.push(
          `${url}: ${error instanceof Error ? error.message : "Fetch failed"}`,
        );
      }
    }
  }
  await Promise.all(Array.from({ length: 5 }, () => worker()));
  return {
    checked_at: new Date().toISOString(),
    verified: verified.sort((a, b) => a.url.localeCompare(b.url)),
    failures: failures.sort(),
  };
}

if (import.meta.main) {
  const report = await checkRemoteSources(await checkSources());
  console.log(JSON.stringify(report, null, 2));
  if (report.failures.length > 0) process.exitCode = 1;
}
