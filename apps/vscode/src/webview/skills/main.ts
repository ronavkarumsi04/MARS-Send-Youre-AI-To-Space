/// <reference lib="dom" />
import type { SkillsMessage, SkillsState } from "../../skillsMessages";
import { button, h as element } from "../dom";

/** `h` that skips absent children, so optional parts can be written inline. */
const h = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Parameters<typeof element>[1],
  ...children: (string | Node | null)[]
) =>
  element(
    tag,
    props,
    ...children.filter((child): child is string | Node => child !== null),
  );

interface VsCodeApi {
  postMessage(message: SkillsMessage): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const app = document.getElementById("app") as HTMLElement;
const status = h("div", { class: "announcer", role: "status" });
document.body.append(status);

const percent = (value: number) => `${Math.round(value * 100)}%`;

function render(state: SkillsState): void {
  const busy = state.busy !== null;
  status.textContent = state.busy ?? state.notice?.text ?? "";
  const pending = state.proposals.filter((p) => p.status === "pending");
  const decided = state.proposals.filter((p) => p.status !== "pending");
  app.replaceChildren(
    h(
      "div",
      { class: "panel row" },
      h("span", { class: "grow muted" }, state.busy ? `${state.busy}…` : ""),
      button(
        "Refresh",
        "refresh",
        () => vscode.postMessage({ type: "refresh" }),
        {
          secondary: true,
          disabled: busy,
        },
      ),
    ),
    ...(state.notice
      ? [h("div", { class: `notice ${state.notice.kind}` }, state.notice.text)]
      : []),
    h(
      "section",
      { class: "panel" },
      h("h2", {}, `Proposals waiting (${pending.length})`),
      pending.length
        ? h(
            "ul",
            { class: "tasks" },
            ...pending.map((p) =>
              h(
                "li",
                {},
                h("div", { class: "small" }, p.rationale),
                ...p.operations.map((op) =>
                  h(
                    "div",
                    {},
                    h("span", { class: "pill" }, op.op),
                    ` ${op.name}`,
                    op.content !== undefined
                      ? h("pre", { class: "mono small" }, op.content)
                      : null,
                  ),
                ),
                h(
                  "div",
                  {
                    class: `small ${p.gate.cleared ? "v-verified" : "v-unverified"}`,
                  },
                  `Gate: ${p.gate.summary}`,
                ),
                p.gate.latest
                  ? h(
                      "div",
                      { class: "hint" },
                      `${p.gate.latest.trials} held-out tasks: ${p.gate.latest.wins} fixed, ${p.gate.latest.losses} broken, p=${p.gate.latest.p_value ?? "n/a"}, cost ×${p.gate.latest.cost_ratio ?? "∞"}`,
                    )
                  : null,
                h(
                  "div",
                  { class: "row" },
                  button(
                    p.gate.cleared ? "Accept" : "Accept without gate…",
                    `accept-${p.proposal_id}`,
                    () =>
                      vscode.postMessage({
                        type: "accept",
                        proposalId: p.proposal_id,
                      }),
                    { disabled: busy, danger: !p.gate.cleared },
                  ),
                  button(
                    "Reject…",
                    `reject-${p.proposal_id}`,
                    () =>
                      vscode.postMessage({
                        type: "reject",
                        proposalId: p.proposal_id,
                      }),
                    { secondary: true, disabled: busy },
                  ),
                ),
              ),
            ),
          )
        : h("p", { class: "muted" }, "No proposals waiting."),
    ),
    h(
      "section",
      { class: "panel" },
      h("h2", {}, `Skills (${state.skills.length})`),
      state.skills.length
        ? h(
            "ul",
            { class: "tasks" },
            ...state.skills.map((s) =>
              h(
                "li",
                { title: s.content },
                h(
                  "div",
                  { class: "row" },
                  h("span", { class: "grow" }, s.name),
                  h("span", { class: "pill" }, s.status),
                  s.pinned ? h("span", { class: "pill" }, "pinned") : null,
                  s.outcomes?.quarantined
                    ? h("span", { class: "badge v-failed" }, "held back")
                    : null,
                ),
                h(
                  "div",
                  { class: "hint" },
                  s.outcomes
                    ? `${s.outcomes.verified}/${s.outcomes.loads} verified with it vs ${percent(s.outcomes.baseline_rate)} without (${s.outcomes.baseline_loads} tasks); helpfulness ${s.outcomes.helpfulness.toFixed(2)}`
                    : "No verified outcomes yet.",
                ),
              ),
            ),
          )
        : h("p", { class: "muted" }, "No skills yet."),
    ),
    h(
      "section",
      { class: "panel" },
      h("h2", {}, "History"),
      decided.length
        ? h(
            "ul",
            { class: "tasks" },
            ...decided.map((p) =>
              h(
                "li",
                {},
                h(
                  "div",
                  { class: "row" },
                  h(
                    "span",
                    { class: "grow" },
                    `${p.status}: ${p.operations.map((op) => `${op.op} ${op.name}`).join(", ")}`,
                  ),
                  p.status === "accepted" && p.review_id
                    ? button(
                        "Undo review",
                        `undo-${p.proposal_id}`,
                        () =>
                          vscode.postMessage({
                            type: "undo",
                            reviewId: p.review_id as string,
                          }),
                        { secondary: true, disabled: busy },
                      )
                    : null,
                ),
                h(
                  "div",
                  { class: "hint" },
                  p.reason ? `Reason: ${p.reason}` : `Gate: ${p.gate.summary}`,
                ),
              ),
            ),
          )
        : h("p", { class: "muted" }, "Nothing decided yet."),
    ),
  );
}

window.addEventListener("message", (event: MessageEvent) => {
  const data = event.data as { type?: string; state?: SkillsState };
  if (data?.type === "state" && data.state) render(data.state);
});
vscode.postMessage({ type: "ready" });
