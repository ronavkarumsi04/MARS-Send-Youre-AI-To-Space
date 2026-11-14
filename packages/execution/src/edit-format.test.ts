import { expect, test } from "bun:test";
import {
  DEFAULT_MARS_EDIT_FORMAT,
  EDIT_FORMAT_EVIDENCE_SCHEMA,
  type EditFormatEvidence,
  selectEditFormat,
} from "./edit-format";

const evidence = (
  overrides: Partial<EditFormatEvidence> = {},
): EditFormatEvidence => ({
  schema: EDIT_FORMAT_EVIDENCE_SCHEMA,
  report_sha256: "a".repeat(64),
  model_id: "ollama/qwen3-coder",
  repository: "repo",
  generated_at: "2026-11-14T00:00:00.000Z",
  simulated: false,
  arms: [
    {
      format: "apply_patch",
      trials: 10,
      verified_solves: 7,
      solve_rate: 0.7,
      cost_per_verified_solve_usd: 0,
      tokens_per_verified_solve: 900,
    },
  ],
  ...overrides,
});

test("selectEditFormat uses the matching report and records its digest", () => {
  const decision = selectEditFormat({
    modelId: "ollama/qwen3-coder",
    repository: "repo",
    evidence: [evidence()],
  });
  expect(decision).toMatchObject({
    format: "apply_patch",
    source: "benchmark",
    reason: "best_verified_solve_rate",
    report_sha256: "a".repeat(64),
  });
  expect(decision.candidates[0]?.available).toBe(true);
});

test("selectEditFormat falls back to the static default without evidence for the model or repository", () => {
  for (const input of [
    { modelId: "other/model", repository: "repo" },
    { modelId: "ollama/qwen3-coder", repository: "other-repo" },
  ]) {
    const decision = selectEditFormat({ ...input, evidence: [evidence()] });
    expect(decision).toMatchObject({
      format: DEFAULT_MARS_EDIT_FORMAT,
      source: "static_default",
      reason: "no_report_for_model",
      report_sha256: null,
    });
  }
});

test("simulated reports never decide unless explicitly allowed", () => {
  const simulated = evidence({ simulated: true });
  expect(
    selectEditFormat({
      modelId: "ollama/qwen3-coder",
      repository: "repo",
      evidence: [simulated],
    }),
  ).toMatchObject({
    source: "static_default",
    reason: "simulated_report_refused",
  });
  expect(
    selectEditFormat({
      modelId: "ollama/qwen3-coder",
      repository: "repo",
      evidence: [simulated],
      allowSimulated: true,
    }).source,
  ).toBe("benchmark");
});

test("the newest report decides; formats that never solved or are unavailable are skipped", () => {
  const older = evidence({ generated_at: "2026-11-01T00:00:00.000Z" });
  const newer = evidence({
    report_sha256: "b".repeat(64),
    generated_at: "2026-11-10T00:00:00.000Z",
    arms: [
      {
        format: "hashline",
        trials: 10,
        verified_solves: 9,
        solve_rate: 0.9,
        cost_per_verified_solve_usd: 0,
        tokens_per_verified_solve: 500,
      },
      {
        format: "apply_patch",
        trials: 10,
        verified_solves: 0,
        solve_rate: 0,
        cost_per_verified_solve_usd: null,
        tokens_per_verified_solve: null,
      },
    ],
  });
  const decision = selectEditFormat({
    modelId: "ollama/qwen3-coder",
    repository: "repo",
    evidence: [older, newer],
  });
  expect(decision).toMatchObject({
    format: DEFAULT_MARS_EDIT_FORMAT,
    source: "static_default",
    reason: "no_available_format_solved",
    report_sha256: "b".repeat(64),
  });
  expect(decision.candidates.map((c) => [c.format, c.available])).toEqual([
    ["hashline", false],
    ["apply_patch", true],
  ]);
});
