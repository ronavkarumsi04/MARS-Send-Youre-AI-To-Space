import { expect, test } from "bun:test";
import { MarsClient } from "../src/client";
import { RpcError } from "../src/rpc";
import { SkillsController, type SkillsState } from "../src/skillsController";
import { FakeServer, flush } from "./fixtures";

const proposal = (id: string, cleared: boolean, status = "pending") => ({
  proposal_id: id,
  source: `background_review:s:review-${id}`,
  review_id: `review-${id}`,
  rationale: "Lesson",
  status,
  operations: [{ op: "create", name: `skill-${id}`, content: "Do it." }],
  gate: {
    required: true,
    cleared,
    summary: cleared ? `passed (${"a".repeat(12)})` : "none yet",
    latest: null,
  },
});

async function setup() {
  const server = new FakeServer();
  const proposals = new Map([
    ["p1", proposal("p1", true)],
    ["p2", proposal("p2", false)],
  ]);
  server.on("skills.list", () => [
    {
      name: "triage",
      status: "active",
      pinned: false,
      content: "Do it.",
      use_count: 1,
      last_activity: 0,
      outcomes: null,
    },
  ]);
  server.on("skills.proposals.list", () => [...proposals.values()]);
  server.on("skills.proposals.accept", (p) => {
    const id = String(p.proposal_id);
    const current = proposals.get(id);
    if (!current) throw new RpcError("not-found", "no proposal");
    if (!current.gate.cleared && p.without_gate_reason === undefined)
      throw new RpcError("conflict", "gate required");
    proposals.set(id, { ...current, status: "accepted" });
    return proposals.get(id);
  });
  server.on("skills.proposals.reject", (p) => {
    const id = String(p.proposal_id);
    const next = { ...proposal(id, false, "rejected"), reason: p.reason };
    proposals.set(id, next);
    return next;
  });
  server.on("skills.reviews.undo", () => ({ undone: 1 }));
  const client = new MarsClient(server);
  await client.describe();
  const states: SkillsState[] = [];
  const confirms: string[] = [];
  const answers: (string | undefined)[] = [];
  const controller = new SkillsController({
    client: () => client,
    post: (state) => states.push(state),
    ui: {
      confirm: async (message) => {
        confirms.push(message);
        return true;
      },
      prompt: async () => answers.shift(),
    },
  });
  return { server, controller, states, confirms, answers, client };
}

for (const target of ["another server", "disconnected"] as const) {
  for (const fails of [false, true]) {
    test(`Skills discards stale ${fails ? "errors" : "results"} after switching to ${target}`, async () => {
      const old = await setup();
      const next = await setup();
      next.server.on("skills.list", () => []);
      next.server.on("skills.proposals.list", () => []);
      let current: MarsClient | undefined = old.client;
      const states: SkillsState[] = [];
      const controller = new SkillsController({
        client: () => current,
        post: (state) => states.push(state),
        ui: { confirm: async () => true, prompt: async () => undefined },
      });
      const gate = Promise.withResolvers<void>();
      const skills = old.client.skills.bind(old.client);
      old.client.skills = async () => {
        await gate.promise;
        if (fails) throw new Error("old server failed");
        return skills();
      };
      const loading = controller.refresh();
      await flush();
      current = target === "another server" ? next.client : undefined;
      await controller.refresh();
      const switched = states.length;
      gate.resolve();
      await loading;
      expect(states.at(-1)).toMatchObject({
        connected: target === "another server",
        skills: [],
        proposals: [],
        busy: null,
      });
      expect(
        states.slice(switched).some((state) => state.skills.length > 0),
      ).toBe(false);
      expect(states.at(-1)?.notice?.kind).not.toBe("error");
    });
  }
}

test("Skills view lists skills and proposals, and accepts through the gate", async () => {
  const ctx = await setup();
  await ctx.controller.handleMessage({ type: "ready" });
  const first = ctx.states.at(-1);
  expect(first?.connected).toBe(true);
  expect(first?.skills.map((s) => s.name)).toEqual(["triage"]);
  expect(first?.proposals).toHaveLength(2);

  // A cleared gate only needs a confirmation.
  await ctx.controller.handleMessage({ type: "accept", proposalId: "p1" });
  expect(ctx.confirms).toEqual(["Accept this skill proposal?"]);
  const accept = ctx.server.calls.filter(
    (c) => c.method === "skills.proposals.accept",
  );
  expect(accept.map((c) => c.params)).toEqual([{ proposal_id: "p1" }]);

  // Without a passing verdict it needs a reason; cancelling sends nothing.
  ctx.answers.push(undefined);
  await ctx.controller.handleMessage({ type: "accept", proposalId: "p2" });
  ctx.answers.push("  no model key yet ");
  await ctx.controller.handleMessage({ type: "accept", proposalId: "p2" });
  expect(
    ctx.server.calls
      .filter((c) => c.method === "skills.proposals.accept")
      .map((c) => c.params),
  ).toEqual([
    { proposal_id: "p1" },
    { proposal_id: "p2", without_gate_reason: "no model key yet" },
  ]);
  expect(ctx.states.at(-1)?.notice?.text).toContain("recorded");

  await ctx.controller.handleMessage({ type: "undo", reviewId: "review-p1" });
  expect(ctx.states.at(-1)?.notice?.text).toBe("Undid 1 change(s).");
});

test("Skills view rejects with a reason, surfaces errors and drops bad messages", async () => {
  const ctx = await setup();
  await ctx.controller.handleMessage({ type: "refresh" });
  ctx.answers.push("noise");
  await ctx.controller.handleMessage({ type: "reject", proposalId: "p2" });
  expect(
    ctx.states.at(-1)?.proposals.find((p) => p.proposal_id === "p2")?.status,
  ).toBe("rejected");
  // The server's answer is checked against the request.
  ctx.server.on("skills.proposals.accept", () =>
    proposal("other", true, "accepted"),
  );
  await ctx.controller.handleMessage({ type: "accept", proposalId: "p1" });
  expect(ctx.states.at(-1)?.notice?.kind).toBe("error");
  expect(await ctx.controller.handleMessage({ type: "accept" })).toBe(false);
  expect(
    await ctx.controller.handleMessage({ type: "delete", name: "x" }),
  ).toBe(false);
});

test("Skills view asks for a connection when the Tasks view has none, and loads once it connects", async () => {
  const { client } = await setup();
  let current: MarsClient | undefined;
  const states: SkillsState[] = [];
  const controller = new SkillsController({
    client: () => current,
    post: (state) => states.push(state),
    ui: { confirm: async () => true, prompt: async () => "x" },
  });
  await controller.handleMessage({ type: "ready" });
  expect(states.at(-1)).toMatchObject({ connected: false });
  expect(states.at(-1)?.notice?.text).toContain("Tasks view");
  // The extension refreshes on the Tasks controller's onClientChange.
  current = client;
  await controller.refresh();
  expect(states.at(-1)).toMatchObject({ connected: true, notice: null });
  expect(states.at(-1)?.skills).toHaveLength(1);
  current = undefined;
  await controller.refresh();
  expect(states.at(-1)).toMatchObject({
    connected: false,
    skills: [],
    proposals: [],
  });
});
