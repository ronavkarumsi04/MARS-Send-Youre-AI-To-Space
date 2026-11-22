import { expect, test } from "bun:test";
import { modelNavigation } from "../src/webview/workspaceViews";

test("the model entry links to setup and reflects whether a key is saved", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  let openCount = 0;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: () => {
        let onClick: (() => void) | undefined;
        return {
          dataset: {},
          disabled: false,
          addEventListener: (_event: string, listener: () => void) => {
            onClick = listener;
          },
          click() {
            if (!this.disabled) onClick?.();
          },
        };
      },
    },
  });
  try {
    const open = () => {
      openCount++;
    };
    const loading = modelNavigation(false, true, open);
    expect(loading.disabled).toBe(true);
    loading.click();
    const disconnected = modelNavigation(false, false, open);
    expect(disconnected.textContent).toBe("Connect model");
    disconnected.click();
    const connected = modelNavigation(true, false, open);
    expect(connected.textContent).toBe("Model connected");
    connected.click();
    expect(openCount).toBe(2);
  } finally {
    if (original) Object.defineProperty(globalThis, "document", original);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
