export const EXTENSION_CHANNEL = "mars-shell:extensions";

export interface Extension {
  id: string;
  kind: "mcp" | "skill" | "plugin";
  name: string;
  version: string;
  description: string;
  permissions: string[];
}

const summary = {
  file: "mars-change-summary.md",
  sha256: "8e55df7d8e2f98c7fd4fbdeb6dac8c88553526342354fa1ede143942187f9565",
};
const handoff = {
  file: "mars-test-handoff.md",
  sha256: "cbf14da95865ed6ea9996ef941b586f397defc811a52d8dca5c27e28c3111a48",
};
export const CATALOG = [
  {
    id: "mars-utc-clock",
    kind: "mcp",
    name: "UTC clock",
    version: "1.0.0",
    description:
      "Give the assistant a local tool to read the current UTC time.",
    permissions: [
      "Run the bundled clock process",
      "Call utc_now (no arguments)",
    ],
    assets: [
      {
        file: "utc-clock.ts",
        sha256:
          "aa22e310518ab0f35f84edf93c04f160767276698af2becde3f129c40d762ca4",
      },
    ],
  },
  {
    id: "mars-change-summary",
    kind: "skill",
    name: "Change summary",
    version: "1.0.0",
    description:
      "Teach the assistant to write release notes from verified changes.",
    permissions: ["Add the Change summary instructions to this project"],
    assets: [summary],
  },
  {
    id: "mars-release-kit",
    kind: "plugin",
    name: "Release handoff kit",
    version: "1.0.0",
    description:
      "Bundle two skills: Change summary for release notes and Test handoff for reporting verification.",
    permissions: [
      "Add the Change summary and Test handoff instructions to this project",
    ],
    assets: [summary, handoff],
  },
] satisfies (Extension & { assets: { file: string; sha256: string }[] })[];
export type CatalogEntry = (typeof CATALOG)[number];

export type ExtensionView = Extension & { installed: boolean };
export interface DesktopExtensions {
  list(): Promise<ExtensionView[]>;
  install(id: string): Promise<"installed" | "cancelled" | "unavailable">;
}
export function findExtension(id: unknown) {
  return CATALOG.find((entry) => entry.id === id);
}
