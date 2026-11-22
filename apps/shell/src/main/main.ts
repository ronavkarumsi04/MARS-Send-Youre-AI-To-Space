import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  protocol,
  session,
} from "electron";
import { explicitConnection, resolveConnection } from "./connection";
import { createDesktop } from "./desktop";
import { registerBridge, registerTeamChatBridge } from "./ipc";
import {
  createRendererRecovery,
  RENDERER_RECOVERY_HTML,
} from "./renderer-recovery";
import {
  appResponseHeaders,
  resolveAppAsset,
  SHELL_WEB_PREFERENCES,
} from "./security";
import { createReconnectingBridge } from "./session";
import { layoutPath, loadWindowLayout, saveWindowLayout } from "./settings";
import { createTeamChatBridge } from "./team-chat-bridge";
import { createLoopbackTransport } from "./transport";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "mars-shell",
    privileges: { standard: true, secure: true },
  },
]);
app.enableSandbox();

const trustedOrigin = "mars-shell://app";
const managed = app.isPackaged && !explicitConnection();
const primary = !managed || app.requestSingleInstanceLock();
if (!primary) app.quit();
let mainWindow: BrowserWindow | undefined;
let desktop: Awaited<ReturnType<typeof createDesktop>> | undefined;
let shuttingDown = false;

app.on("second-instance", () => {
  if (mainWindow?.isMinimized()) mainWindow.restore();
  mainWindow?.focus();
});

app.on("web-contents-created", (_event, contents) => {
  contents.on("will-navigate", (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-attach-webview", (event) => event.preventDefault());
});

app.on("ready", async () => {
  if (!primary) return;
  const defaultSession = session.defaultSession;
  defaultSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  defaultSession.setPermissionCheckHandler(() => false);
  defaultSession.webRequest.onBeforeRequest(
    { urls: ["<all_urls>"] },
    (details, callback) => {
      callback({ cancel: !details.url.startsWith(`${trustedOrigin}/`) });
    },
  );
  Menu.setApplicationMenu(null);
  protocol.handle("mars-shell", async (request) => {
    if (request.url === `${trustedOrigin}/recovery.html`)
      return new Response(RENDERER_RECOVERY_HTML, {
        headers: {
          ...appResponseHeaders(),
          "Content-Type": "text/html; charset=utf-8",
        },
      });
    const rendererDir = join(app.getAppPath(), "renderer");
    const asset = resolveAppAsset(request.url, rendererDir);
    if (!asset)
      return new Response("Not found", {
        status: 404,
        headers: appResponseHeaders(),
      });
    try {
      return new Response(await readFile(asset.file), {
        status: 200,
        headers: {
          ...appResponseHeaders(),
          "Content-Type": asset.mediaType,
        },
      });
    } catch {
      return new Response("Not found", {
        status: 404,
        headers: appResponseHeaders(),
      });
    }
  });

  const filePath = layoutPath(app.getPath("home"));
  const saved = await loadWindowLayout(filePath);
  const window = new BrowserWindow({
    title: managed ? "MARS" : "MARS Shell",
    width: saved.width,
    height: saved.height,
    backgroundColor: "#050407",
    webPreferences: {
      ...SHELL_WEB_PREFERENCES,
      preload: join(app.getAppPath(), "preload.cjs"),
    },
  });
  mainWindow = window;
  let windowClosing = false;
  const recoverRenderer = createRendererRecovery({
    isClosing: () => shuttingDown || windowClosing || window.isDestroyed(),
    log: (reason) => console.error(`MARS renderer recovery: ${reason}`),
    reload: () => window.webContents.reload(),
    showRecovery: () => {
      void window.loadURL(`${trustedOrigin}/recovery.html`).catch(() => {
        console.error("MARS recovery page could not load.");
      });
    },
  });
  window.webContents.on("render-process-gone", (_event, details) =>
    recoverRenderer(details.reason),
  );
  window.on("unresponsive", () => recoverRenderer("unresponsive"));
  const newBridge = () =>
    createReconnectingBridge({
      resolve: () => (desktop ? desktop.resolve() : resolveConnection()),
      makeTransport: (connection) => createLoopbackTransport(connection),
    });
  let bridge = newBridge();
  registerBridge(
    ipcMain,
    { call: (method, params) => bridge.call(method, params) },
    { trustedOrigin, trustedContents: window.webContents },
  );
  registerTeamChatBridge(ipcMain, createTeamChatBridge(), {
    trustedOrigin,
    trustedContents: window.webContents,
  });
  if (managed) {
    try {
      desktop = await createDesktop(window, () => {
        bridge = newBridge();
        window.webContents.reload();
      });
    } catch {
      showDesktopStartupError();
      return;
    }
  }
  window.on("close", () => {
    windowClosing = true;
    const { width, height } = window.getBounds();
    void saveWindowLayout(filePath, { width, height }).catch(() => {});
  });
  await window.loadURL(`${trustedOrigin}/index.html`);
});

function showDesktopStartupError() {
  dialog.showErrorBox(
    "MARS could not open",
    "The app could not prepare its local data folder. Check its permissions and reopen MARS.",
  );
  app.quit();
}

app.on("before-quit", (event) => {
  if (!desktop) return;
  event.preventDefault();
  if (shuttingDown) return;
  shuttingDown = true;
  void desktop.close().finally(() => {
    desktop = undefined;
    app.quit();
  });
});

app.on("window-all-closed", () => app.quit());
