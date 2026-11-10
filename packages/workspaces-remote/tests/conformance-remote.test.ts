import { defineProviderConformance } from "./conformance";
import { remoteFixture } from "./fixtures";

defineProviderConformance(
  "remote provider (FAKE Agent Server, pinned wire protocol)",
  remoteFixture,
);
