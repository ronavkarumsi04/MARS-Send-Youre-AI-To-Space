import { expect, test } from "bun:test";
import { ModelConfigSchema } from "@mars/contracts";
import {
  DEFAULT_MARS_EDIT_FORMAT,
  defaultEditFormat,
  EDIT_FORMAT_EVIDENCE_SCHEMA,
  type EditFormatEvidence,
  resolveEditFormat,
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
    available: ["apply_patch"],
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
test.each([
  "deepseek/deepseek-v4",
  "KIMI-K2.5",
  "xiaomi/MiMo-v2",
  "MiniMax-M2",
  "stepfun/step-3.5-flash",
  "gpt-5.3-codex-spark",
  "GLM-5.3-Flash",
  "Qwen3.8-Flash-Next",
  "qwen-3.8-27b",
  "moonshotai/opaque",
  "K3",
  "hailuo-02",
])("omp defaults select replace for %s in either name", (name) => {
  expect(defaultEditFormat({ id: name, model: "stub" })).toBe("replace");
  expect(defaultEditFormat({ id: "alias", model: name })).toBe("replace");
});

test.each([
  "stub",
  "gpt-5.4",
  "claude-sonnet",
  "qwen3.6-27b",
  "qwen3.80",
  "glm-5.3",
  "glm-5.2-flash",
  "deepseek-r1-distill-qwen-32b",
])("other models retain hashline: %s", (model) => {
  expect(defaultEditFormat({ id: "alias", model })).toBe("hashline");
});

test("explicit configuration wins and patch fallback records the requested format", () => {
  const model = {
    id: "kimi-k2",
    model: "stub",
    editFormat: "hashline" as const,
  };
  expect(resolveEditFormat(model, { patchAvailable: false })).toEqual({
    format: "hashline",
    requested: "hashline",
    source: "config",
  });
  expect(
    resolveEditFormat(
      { ...model, editFormat: "apply_patch" },
      { patchAvailable: false },
    ),
  ).toEqual({ format: "hashline", requested: "apply_patch", source: "config" });
  expect(
    resolveEditFormat(
      { ...model, editFormat: "apply_patch" },
      { patchAvailable: true },
    ).format,
  ).toBe("apply_patch");
  expect(
    resolveEditFormat({ id: "alias", model: "stub" }, { patchAvailable: false })
      .source,
  ).toBe("default");
});

test("model config accepts only supported edit format overrides", () => {
  const model = {
    id: "alias",
    model: "stub",
    providerId: "p",
    capabilities: { tools: true, vision: false, contextWindow: 32000 },
    pricing: { free: true },
  };
  for (const editFormat of ["hashline", "replace", "apply_patch"] as const) {
    expect(ModelConfigSchema.parse({ ...model, editFormat }).editFormat).toBe(
      editFormat,
    );
  }
  expect(
    ModelConfigSchema.safeParse({ ...model, editFormat: "unknown" }).success,
  ).toBe(false);
});
