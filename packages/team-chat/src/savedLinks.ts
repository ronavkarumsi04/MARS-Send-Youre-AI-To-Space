/** A task link its requester created, kept in webview state so it can be reopened after a reload. */
export interface SavedTaskLink {
  viewerId: string;
  conversationId: string;
  linkId: string;
}

const same = (a: SavedTaskLink, b: SavedTaskLink) =>
  a.viewerId === b.viewerId &&
  a.conversationId === b.conversationId &&
  a.linkId === b.linkId;

/** Read saved links back from untrusted persisted state, dropping malformed and repeated entries. */
export function parseSavedTaskLinks(raw: unknown): SavedTaskLink[] {
  if (!Array.isArray(raw)) return [];
  const links: SavedTaskLink[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const { viewerId, conversationId, linkId } = item as Record<
      string,
      unknown
    >;
    if (
      typeof viewerId !== "string" ||
      typeof conversationId !== "string" ||
      typeof linkId !== "string"
    )
      continue;
    const link = { viewerId, conversationId, linkId };
    if (!links.some((entry) => same(entry, link))) links.push(link);
  }
  return links;
}

/** Add a link once; the same array comes back when it is already saved. */
export function rememberTaskLink(
  links: SavedTaskLink[],
  link: SavedTaskLink,
): SavedTaskLink[] {
  return links.some((entry) => same(entry, link)) ? links : [...links, link];
}

/** The links one viewer saved in one conversation, oldest first. */
export function savedTaskLinksFor(
  links: SavedTaskLink[],
  viewerId: string,
  conversationId: string,
): SavedTaskLink[] {
  return links.filter(
    (link) =>
      link.viewerId === viewerId && link.conversationId === conversationId,
  );
}
