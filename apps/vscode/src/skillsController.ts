import type { MarsClient } from "./client";
import type { SkillProposalView } from "./protocol";
import { SkillsMessageSchema, type SkillsState } from "./skillsMessages";

export {
  type SkillsMessage,
  SkillsMessageSchema,
  type SkillsState,
} from "./skillsMessages";

export interface SkillsUi {
  confirm(message: string, detail: string, action: string): Promise<boolean>;
  /** Free-text input; undefined when cancelled. */
  prompt(title: string, prompt: string): Promise<string | undefined>;
}

/**
 * VS Code–independent state for the Skills view. All skill truth comes from
 * the server; decisions go through the same gate-enforcing host methods as
 * `mars skills`.
 */
export class SkillsController {
  private state: SkillsState = {
    connected: false,
    skills: [],
    proposals: [],
    busy: null,
    notice: null,
  };

  constructor(
    private readonly options: {
      client: () => MarsClient | undefined;
      ui: SkillsUi;
      post: (state: SkillsState) => void;
    },
  ) {}

  async handleMessage(raw: unknown): Promise<boolean> {
    const parsed = SkillsMessageSchema.safeParse(raw);
    if (!parsed.success) return false;
    const message = parsed.data;
    switch (message.type) {
      case "ready":
      case "refresh":
        await this.refresh();
        break;
      case "accept":
        await this.accept(message.proposalId);
        break;
      case "reject":
        await this.reject(message.proposalId);
        break;
      case "undo":
        await this.undo(message.reviewId);
        break;
    }
    return true;
  }

  private emit(patch: Partial<SkillsState>): void {
    this.state = { ...this.state, ...patch };
    this.options.post(this.state);
  }

  private async run(
    label: string,
    work: (client: MarsClient) => Promise<string | null>,
  ): Promise<void> {
    const client = this.options.client();
    if (!client) {
      this.emit({
        connected: false,
        notice: {
          kind: "info",
          text: "Connect to a MARS server in the Tasks view first.",
        },
      });
      return;
    }
    if (this.state.busy) {
      this.emit({
        notice: {
          kind: "info",
          text: `Wait for "${this.state.busy}" to finish.`,
        },
      });
      return;
    }
    this.emit({ busy: label, notice: null });
    try {
      const done = await work(client);
      const [skills, proposals] = await Promise.all([
        client.skills(),
        client.skillProposals(),
      ]);
      this.emit({
        connected: true,
        skills,
        proposals,
        busy: null,
        notice: done ? { kind: "info", text: done } : null,
      });
    } catch (error) {
      this.emit({
        busy: null,
        notice: {
          kind: "error",
          text: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  refresh(): Promise<void> {
    return this.run("Refresh", async () => null);
  }

  private pending(id: string): SkillProposalView | undefined {
    return this.state.proposals.find(
      (p) => p.proposal_id === id && p.status === "pending",
    );
  }

  async accept(id: string): Promise<void> {
    const proposal = this.pending(id);
    if (!proposal) return this.refresh();
    const ops = proposal.operations
      .map((op) => `${op.op} ${op.name}`)
      .join(", ");
    if (proposal.gate.cleared) {
      if (
        !(await this.options.ui.confirm(
          "Accept this skill proposal?",
          `${ops}\nGate: ${proposal.gate.summary}`,
          "Accept",
        ))
      )
        return;
      return this.run("Accept", async (client) => {
        await client.acceptSkillProposal(id);
        return `Accepted: ${ops}.`;
      });
    }
    const reason = (
      await this.options.ui.prompt(
        "Accept without a passing gate",
        `${ops}. Gate: ${proposal.gate.summary}. Why accept it anyway? The reason is recorded with your name.`,
      )
    )?.trim();
    if (!reason) return;
    return this.run("Accept without gate", async (client) => {
      await client.acceptSkillProposal(id, reason);
      return `Accepted without a passing gate (recorded): ${ops}.`;
    });
  }

  async reject(id: string): Promise<void> {
    if (!this.pending(id)) return this.refresh();
    const reason = (
      await this.options.ui.prompt("Reject skill proposal", "Reason")
    )?.trim();
    if (!reason) return;
    return this.run("Reject", async (client) => {
      await client.rejectSkillProposal(id, reason);
      return "Rejected.";
    });
  }

  async undo(reviewId: string): Promise<void> {
    if (
      !(await this.options.ui.confirm(
        "Undo every skill change from this review?",
        `Review ${reviewId}`,
        "Undo",
      ))
    )
      return;
    return this.run("Undo", async (client) => {
      const undone = await client.undoSkillReview(reviewId);
      return undone ? `Undid ${undone} change(s).` : "Nothing to undo.";
    });
  }
}
