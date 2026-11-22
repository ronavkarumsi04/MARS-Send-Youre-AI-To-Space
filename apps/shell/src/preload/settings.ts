import { contextBridge, ipcRenderer } from "electron";
import {
  DESKTOP_MODEL_CHANNEL,
  type DesktopModelSettings,
} from "../shared/desktop-model";

contextBridge.exposeInMainWorld(
  "marsModelSettings",
  Object.freeze({
    setKey: (key) => ipcRenderer.invoke(DESKTOP_MODEL_CHANNEL, key),
  } satisfies DesktopModelSettings),
);
