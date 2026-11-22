import { expect, test } from "bun:test";
import {
  parseSavedTaskLinks,
  rememberTaskLink,
  type SavedTaskLink,
  savedTaskLinksFor,
} from "./savedLinks";

const link = (linkId: string, over: Partial<SavedTaskLink> = {}) => ({
  viewerId: "ada",
  conversationId: "conv_1",
  linkId,
  ...over,
});

test("two task links survive a webview reload and stay scoped to their viewer and conversation", () => {
  let links: SavedTaskLink[] = [];
  links = rememberTaskLink(links, link("link_1"));
  links = rememberTaskLink(links, link("link_2"));
  links = rememberTaskLink(links, link("link_3", { conversationId: "conv_2" }));
  links = rememberTaskLink(links, link("link_4", { viewerId: "grace" }));
  expect(rememberTaskLink(links, link("link_1"))).toBe(links);

  // What VS Code hands back from `getState()` after the webview is recreated.
  const restored = parseSavedTaskLinks(
    JSON.parse(JSON.stringify({ conversationId: "conv_1", links })).links,
  );
  expect(restored).toEqual(links);
  expect(
    savedTaskLinksFor(restored, "ada", "conv_1").map((item) => item.linkId),
  ).toEqual(["link_1", "link_2"]);
  expect(savedTaskLinksFor(restored, "grace", "conv_2")).toEqual([]);
});

test("damaged saved state yields only well-formed, distinct links", () => {
  for (const raw of [undefined, null, "links", 7, { links: [] }])
    expect(parseSavedTaskLinks(raw)).toEqual([]);
  expect(
    parseSavedTaskLinks([
      null,
      "link_1",
      { viewerId: "ada", conversationId: "conv_1" },
      { viewerId: "ada", conversationId: 1, linkId: "link_1" },
      { ...link("link_1"), extra: "dropped" },
      link("link_1"),
    ]),
  ).toEqual([link("link_1")]);
});
