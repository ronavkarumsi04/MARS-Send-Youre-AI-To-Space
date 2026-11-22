/// <reference lib="dom" />
import { controller, scenario } from "./stub";
import "../../src/webview/teamChat/main";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 30));

async function waitFor<T extends Element>(selector: string): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const found = document.querySelector<T>(selector);
    if (found) return found;
    await tick();
  }
  throw new Error(`harness: ${selector} never appeared`);
}

async function click(selector: string): Promise<void> {
  const element = await waitFor<HTMLElement>(selector);
  element.click();
  await tick();
}

function key(selector: string): string {
  return `[data-focus-key="${selector}"]`;
}

async function typeInComposer(text: string): Promise<void> {
  const textarea = await waitFor<HTMLTextAreaElement>(key("composer"));
  textarea.focus();
  textarea.value = text;
  textarea.setSelectionRange(text.length, text.length);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  await tick();
}

async function pressEnter(): Promise<void> {
  const textarea = await waitFor<HTMLTextAreaElement>(key("composer"));
  textarea.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    }),
  );
  await tick();
}

async function run(): Promise<void> {
  if (scenario === "handoff") {
    const create = '[data-focus-key^="task-draft-"]';
    await click(create);
    const draft = await waitFor('[aria-label="Task link draft"] blockquote');
    if (
      !draft.textContent?.includes("Release checklist") &&
      !draft.textContent?.includes("launch key evidence")
    )
      throw new Error("harness: task draft missing the selected excerpt");
    await click(key("linked-task-cancel"));
    if (document.querySelector('[aria-label="Task link draft"]'))
      throw new Error("harness: cancelled task draft is still open");
    async function createTask(request: string): Promise<string> {
      await click(create);
      for (const [field, value] of Object.entries({
        request,
        criteria: "Review the release checklist",
        tokens: "1000",
        usd: "0",
        seconds: "60",
        depth: "0",
        concurrency: "1",
      })) {
        const input = await waitFor<HTMLInputElement | HTMLTextAreaElement>(
          key(`linked-task-${field}`),
        );
        input.value = value;
      }
      await click(key("linked-task-confirm"));
      await waitFor(key("linked-task-close"));
      const linkId = controller.snapshot().task_link?.link.link_id;
      if (!linkId) throw new Error("harness: created task has no link");
      await click(key("linked-task-close"));
      return linkId;
    }
    const first = await createTask("Prepare the release");
    const second = await createTask("Write release notes");
    if (
      first === second ||
      document.querySelectorAll('[aria-label="Linked tasks"] li').length !== 2
    )
      throw new Error("harness: expected two distinct saved task links");
    await click(key(`linked-task-reopen-${first}`));
    await click(key("share-evidence"));
    const summary = await waitFor<HTMLTextAreaElement>(key("share-summary"));
    summary.value = "Release checklist reviewed.";
    await click(key("share-preview"));
    await waitFor('[aria-label="Private evidence preview"]');
    if (document.querySelector('[aria-label="Shared evidence"]')) {
      throw new Error("harness: evidence posted before confirmation");
    }
    await click(key("share-cancel"));
    if (
      document.querySelector('[aria-label="Private evidence preview"]') ||
      document.querySelector('[aria-label="Shared evidence"]')
    ) {
      throw new Error("harness: cancelled evidence remained visible");
    }
    await click(key("share-preview"));
    await click(key("share-publish"));
    const card = await waitFor('[aria-label="Shared evidence"]');
    if (
      !card.textContent?.includes(summary.value) ||
      !card.textContent.includes("No verification record was included.") ||
      controller.snapshot().share_result?.link_id !== first
    )
      throw new Error(
        "harness: expected the first task's reviewed evidence and verification reason",
      );
    return;
  }
  if (scenario === "service") {
    // Real adapter over the in-page stub: wait for the inbox, send through
    // messages.send, then let a poll deliver another member's message.
    await waitFor(".fixture-badge");
    await waitFor<HTMLElement>('[data-focus-key^="conv-"]');
    await typeInComposer("Sent through the RPC adapter.");
    await pressEnter();
    const server = (
      globalThis as {
        __teamServer?: {
          post(user: string, conversation: string, body: string): void;
          conversationIds(): string[];
        };
      }
    ).__teamServer;
    const first = server?.conversationIds()[0];
    if (server && first)
      server.post("user_grace", first, "Delivered by events.poll.");
    for (let i = 0; i < 100; i++) {
      if (document.body.textContent?.includes("Delivered by events.poll."))
        break;
      await tick();
    }
    return;
  }
  await waitFor(key("conv-conv_dm_ada_grace"));
  await tick();
  switch (scenario) {
    case "inbox":
      return;
    case "group":
      await click(key("conv-conv_group_release"));
      return;
    case "picker":
      await typeInComposer("Can you check this before the release? @ver");
      await pressEnterOnPickerMove();
      return;
    case "chips":
      await typeInComposer("Both sides of it: @style.css:14-23");
      await selectPicker();
      await typeInComposer("Both sides of it: and @verdictFor");
      await selectPicker();
      await click(key("reply-msg_dm_4"));
      return;
    case "attachment-only": {
      await typeInComposer("@style.css:14-23");
      await selectPicker();
      await waitFor(".chip.draft");
      await pressEnter();
      const alert = await waitFor(".composer-error:not([hidden])");
      const send = await waitFor<HTMLButtonElement>(key("send"));
      if (
        !send.disabled ||
        !document.querySelector(".chip.draft") ||
        !alert.textContent?.includes("Add a message")
      ) {
        throw new Error(
          "harness: attachment-only draft should remain editable",
        );
      }
      return;
    }
    case "panel":
    case "narrow":
      await click(key("conv-conv_group_release"));
      await click(key("chip-msg_grp_2-ref_site_banner"));
      return;
    case "pending":
      await typeInComposer("Checking the badge schema now.");
      await pressEnter();
      return;
    case "failed":
      await controller.handleMessage({
        type: "send",
        conversationId: "conv_dm_ada_grace",
        clientMessageId: "cm_ada_0001",
        body: "A retry that reuses a committed client message id with new content.",
        replyTo: null,
        references: [],
      });
      await tick();
      return;
    case "linus": {
      const select = await waitFor<HTMLSelectElement>(key("viewer"));
      select.value = "user_linus";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await tick();
      await click(key("conv-conv_group_release"));
      await click(key("chip-msg_grp_2-ref_platform_verify"));
      return;
    }
    default:
      throw new Error(`harness: unknown scenario ${scenario}`);
  }
}

async function pressEnterOnPickerMove(): Promise<void> {
  const textarea = await waitFor<HTMLTextAreaElement>(key("composer"));
  textarea.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
    }),
  );
  await tick();
}

async function selectPicker(): Promise<void> {
  const textarea = await waitFor<HTMLTextAreaElement>(key("composer"));
  textarea.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    }),
  );
  await tick();
}

run().then(
  () => {
    document.documentElement.dataset.harnessDone = "true";
  },
  (error: unknown) => {
    document.documentElement.dataset.harnessError = String(error);
  },
);
