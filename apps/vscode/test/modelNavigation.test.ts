import { expect, test } from "bun:test";
import { modelNavigation, renderSettings } from "../src/webview/workspaceViews";

class TestElement {
  dataset: Record<string, string> = {};
  disabled = false;
  textContent = "";
  children: TestElement[] = [];
  private onClick?: () => void;

  constructor(readonly tagName: string) {}

  setAttribute() {}

  append(child: TestElement) {
    this.children.push(child);
  }

  addEventListener(_event: string, listener: () => void) {
    this.onClick = listener;
  }

  click() {
    if (!this.disabled) this.onClick?.();
  }

  descendants(): TestElement[] {
    return [this, ...this.children.flatMap((child) => child.descendants())];
  }
}

function withDocument(run: () => void) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: (tag: string) => new TestElement(tag),
      createTextNode: (text: string) =>
        Object.assign(new TestElement("#text"), { textContent: text }),
    },
  });
  try {
    run();
  } finally {
    if (original) Object.defineProperty(globalThis, "document", original);
    else Reflect.deleteProperty(globalThis, "document");
  }
}

test("the model entry links to setup and reflects whether a key is saved", () => {
  withDocument(() => {
    let openCount = 0;
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
  });
});

test("Settings leads with model setup and links to Project extensions", () => {
  withDocument(() => {
    let opened = false;
    const noop = () => {};
    const settings = renderSettings(false, false, undefined, {
      getKey: noop,
      setKey: noop,
      removeKey: noop,
      settings: noop,
      importConnection: noop,
      extensions: () => {
        opened = true;
      },
    });
    const elements = (settings as unknown as TestElement).descendants();
    expect(
      elements
        .filter((element) => element.tagName === "h2")
        .map((heading) => heading.children[0]?.textContent),
    ).toEqual([
      "Model connection",
      "Privacy",
      "Project extensions",
      "Task server",
    ]);
    elements
      .find((element) => element.dataset.focusKey === "settings-extensions")
      ?.click();
    expect(opened).toBe(true);
  });
});
