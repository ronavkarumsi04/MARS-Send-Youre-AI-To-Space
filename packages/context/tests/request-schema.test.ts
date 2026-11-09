import { describe, expect, test } from "bun:test";
import { WorkspaceRefSchema } from "@mars/contracts";
import { RepositoryMapRequestSchema } from "../src";

describe("repository map request schema", () => {
  const request = (field: string, value: string) => ({
    workspace: {
      workspace_id: "workspace-1",
      provider: "local",
      revision: "rev-1",
      [field]: value,
    },
    max_output_tokens: 1024,
  });

  test.each(["workspace_id", "provider", "revision"])(
    "bounds workspace %s like the shared WorkspaceRefSchema",
    (field) => {
      const atLimit = request(field, "x".repeat(256));
      const overLimit = request(field, "x".repeat(257));
      expect(RepositoryMapRequestSchema.safeParse(atLimit).success).toBe(true);
      expect(RepositoryMapRequestSchema.safeParse(overLimit).success).toBe(
        false,
      );
      expect(WorkspaceRefSchema.safeParse(overLimit.workspace).success).toBe(
        false,
      );
      expect(
        RepositoryMapRequestSchema.safeParse(request(field, "")).success,
      ).toBe(false);
    },
  );
});
