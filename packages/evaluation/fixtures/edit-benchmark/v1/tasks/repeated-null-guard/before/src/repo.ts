interface Repo {
  owner?: string;
  license?: string;
  topics?: string[];
}

export function findLicense(repo: Repo | undefined): string | null {
  if (!repo) {
    return null;
  }
  return repo.license ?? null;
}

export function findOwner(repo: Repo | undefined): string | null {
  if (!repo) {
    return null;
  }
  return repo.owner ?? null;
}

export function firstTopic(repo: Repo | undefined): string | null {
  if (!repo) {
    return null;
  }
  return repo.topics?.[0] ?? null;
}
