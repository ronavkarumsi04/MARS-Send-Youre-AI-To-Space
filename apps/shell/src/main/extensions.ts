import type {
  BrowserWindow,
  Dialog,
  IpcMain,
  MenuItemConstructorOptions,
} from "electron";
import {
  CATALOG,
  type CatalogEntry,
  type DesktopExtensions,
  EXTENSION_CHANNEL,
  findExtension,
} from "../runtime/extension-catalog";
import { type CatalogStatus, ExtensionAction } from "../runtime/extension-wire";

type Project = {
  extensionAction(action: ExtensionAction): Promise<CatalogStatus>;
};

export function extensionController(
  project: () => Project | undefined,
  confirm: (entry: CatalogEntry) => Promise<boolean>,
): DesktopExtensions {
  let reviewing = false;
  return {
    async list() {
      const active = project();
      if (!active)
        throw new Error("Open a local project to manage extensions.");
      const { installed, expired, conflicts } = await active.extensionAction({
        action: "list",
      });
      return CATALOG.map(
        ({ id, name, kind, version, description, permissions }) => ({
          id,
          name,
          kind,
          version,
          description: expired.includes(id)
            ? `Approval expired. Add again to renew. ${description}`
            : conflicts.includes(id)
              ? `Archive the customized skill before reinstalling. ${description}`
              : description,
          permissions,
          installed: installed.includes(id),
        }),
      );
    },
    async install(id) {
      const entry = findExtension(id);
      if (!entry || reviewing) return "unavailable";
      const active = project();
      if (!active) return "unavailable";
      reviewing = true;
      try {
        if (!(await confirm(entry))) return "cancelled";
        if (project() !== active) return "unavailable";
        await active.extensionAction({ action: "install", id });
        return "installed";
      } catch {
        return "unavailable";
      } finally {
        reviewing = false;
      }
    },
  };
}

export function desktopExtensionsMenu(
  { dialog, ipcMain }: { dialog: Dialog; ipcMain: IpcMain },
  window: BrowserWindow,
  project: () => Project | undefined,
  source: () => string,
): MenuItemConstructorOptions {
  const api = extensionController(project, async (entry) => {
    const { response } = await dialog.showMessageBox(window, {
      type: "question",
      title: "Add verified extension",
      message: `Add ${entry.name} to this project?`,
      detail: [
        entry.description,
        `Bundled with MARS · v${entry.version}`,
        `Project: ${source()}`,
        ...entry.permissions,
        entry.kind === "mcp"
          ? "Approval lasts 30 days. Add again after expiry to renew."
          : "A customized active skill is never replaced. To reinstall, archive it first. Adding restores archived skills to the bundled version and keeps prior content in skill version history.",
      ].join("\n\n"),
      buttons: ["Cancel", "Add to project"],
      defaultId: 0,
      cancelId: 0,
    });
    return response === 1;
  });
  ipcMain.handle(EXTENSION_CHANNEL, (event, payload: unknown) => {
    if (
      window.isDestroyed() ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      event.senderFrame?.url !== "mars-shell://app/index.html"
    )
      throw new Error("Extensions are unavailable.");
    const request = ExtensionAction.parse(payload);
    return request.action === "list" ? api.list() : api.install(request.id);
  });
  return {
    label: "Add Verified Extension",
    submenu: (
      [
        ["mcp", "MCP servers — tools"],
        ["skill", "Skills — instructions"],
        ["plugin", "Plugins — bundles"],
      ] as const
    ).map(([kind, label]) => ({
      label,
      submenu: CATALOG.filter((entry) => entry.kind === kind).map((entry) => ({
        label: `${entry.name}…`,
        click: async () => {
          const result = await api.install(entry.id);
          if (window.isDestroyed() || result === "cancelled") return;
          await dialog.showMessageBox(
            window,
            result === "installed"
              ? {
                  type: "info",
                  message: `${entry.name} is ready for new tasks in this project.`,
                }
              : {
                  type: "warning",
                  message: "Extension not added",
                  detail:
                    "Check that a local project is open. If a skill has customized instructions, archive it first, then add the extension again.",
                },
          );
        },
      })),
    })),
  };
}
