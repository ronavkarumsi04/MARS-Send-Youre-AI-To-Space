import type { Scope } from "@mars/contracts";
import { ScopeSchema } from "@mars/contracts";
import { z } from "zod";
import { canonicalJSON, sha256 } from "./canonical";
import { fail } from "./errors";
export const SlugSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
export const CodeSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
export const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      value === url.origin &&
      !url.hostname.endsWith(".") &&
      !url.username &&
      !url.password &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}
export const OriginSchema = z.string().refine(isOrigin);
export const KindSchema = z.enum(["mcp", "connector", "plugin", "skill"]);
export type Kind = z.infer<typeof KindSchema>;
export const IdentitySchema = z
  .object({
    kind: KindSchema,
    integration_id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
  })
  .strict();
export type Identity = z.infer<typeof IdentitySchema>;
const source = z
  .object({
    type: z.enum(["git", "package", "local-artifact", "remote-endpoint"]),
    locator: z.string().min(1),
    revision: z.string().nullable(),
    content_sha256: DigestSchema.nullable(),
  })
  .strict()
  .superRefine((s, c) => {
    if (
      s.type !== "remote-endpoint" &&
      (s.content_sha256 === null || s.revision === null)
    )
      c.addIssue({ code: "custom", message: "missing_digest" });
    if (
      s.revision !== null &&
      !(
        s.type === "package"
          ? /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
          : /^[a-f0-9]{40}$/
      ).test(s.revision)
    )
      c.addIssue({ code: "custom", message: "revision" });
  });
export const SourceEvidenceSchema = IdentitySchema.extend({
  schema_version: z.literal(1),
  source,
  dependency_sha256: DigestSchema,
  config_sha256: DigestSchema,
  endpoint: z
    .object({ origin: OriginSchema, descriptor_sha256: DigestSchema })
    .strict()
    .nullable(),
  tools: z.array(
    z
      .object({
        name: CodeSchema,
        input_schema_sha256: DigestSchema,
        output_schema_sha256: DigestSchema.nullable(),
      })
      .strict(),
  ),
  observed_at: z.string().datetime({ offset: true }),
})
  .strict()
  .superRefine((e, c) => {
    if (e.source.type === "remote-endpoint" && !e.endpoint)
      c.addIssue({ code: "custom", message: "endpoint" });
    if (e.tools.some((t, i) => i > 0 && (e.tools[i - 1]?.name ?? "") >= t.name))
      c.addIssue({ code: "custom", message: "tools_order" });
  });
export type SourceEvidence = z.infer<typeof SourceEvidenceSchema>;
export function parseEvidence(value: unknown): SourceEvidence {
  const r = SourceEvidenceSchema.safeParse(value);
  if (!r.success) fail("malformed_evidence");
  return r.data;
}
export const PermissionSchema = z
  .object({
    capability: z.enum([
      "fs.read",
      "fs.write",
      "process.spawn",
      "network.connect",
      "credential.use",
      "tool.invoke",
      "model.invoke",
    ]),
    resource: z.string().min(1),
  })
  .strict();
export type Permission = z.infer<typeof PermissionSchema>;
export const PermissionManifestSchema = z
  .object({ permissions: z.array(PermissionSchema).max(64) })
  .strict();
export type PermissionManifest = z.infer<typeof PermissionManifestSchema>;
export const CredentialBindingSchema = z
  .object({ ref_id: SlugSchema, allowed_origin: OriginSchema })
  .strict();
export type CredentialBinding = z.infer<typeof CredentialBindingSchema>;
export const ScanRecordSchema = z
  .object({
    scanner_id: SlugSchema,
    status: z.enum(["ok", "error", "unavailable"]),
    score: z.number().finite().optional(),
    findings: z.array(CodeSchema).max(128),
    observed_at: z.string().datetime({ offset: true }),
    binding_sha256: DigestSchema,
  })
  .strict();
export type ScanRecord = z.infer<typeof ScanRecordSchema>;
export const DecisionSchema = z.enum([
  "pending",
  "approved",
  "denied",
  "revoked",
  "superseded",
  "expired",
]);
export type Decision = z.infer<typeof DecisionSchema>;
const TimestampSchema = z.string().datetime({ offset: true });
export const RevisionSchema = z.number().int().safe().min(1);
export const ReviewSchema = z
  .object({
    review_id: CodeSchema,
    revision: RevisionSchema,
    scope: ScopeSchema,
    kind: KindSchema,
    integration_id: CodeSchema,
    evidence: SourceEvidenceSchema,
    permissions: z.array(PermissionSchema),
    credential_bindings: z.array(CredentialBindingSchema),
    binding_sha256: DigestSchema,
    state: DecisionSchema,
    expires_at: TimestampSchema,
    scans: z.array(ScanRecordSchema),
  })
  .strict();
export type Review = z.infer<typeof ReviewSchema>;
export const GrantSchema = ReviewSchema.omit({ scans: true })
  .extend({
    grant_id: CodeSchema,
    approved_by: CodeSchema,
    approved_at: TimestampSchema,
  })
  .strict();
export type Grant = z.infer<typeof GrantSchema>;
export const AuditEventInputSchema = z
  .object({
    at: TimestampSchema,
    type: CodeSchema,
    scope: ScopeSchema,
    kind: KindSchema,
    integration_id: CodeSchema,
    review_id: CodeSchema.optional(),
    grant_id: CodeSchema.optional(),
    actor: CodeSchema,
    reason_code: CodeSchema,
    binding_sha256: DigestSchema,
  })
  .strict();
export type AuditEventInput = z.infer<typeof AuditEventInputSchema>;
export const AuditEventSchema = AuditEventInputSchema.extend({
  seq: RevisionSchema,
  event_id: CodeSchema,
  prev_sha256: DigestSchema,
  sha256: DigestSchema,
}).strict();
export type AuditEvent = z.infer<typeof AuditEventSchema>;
export const TrustStateSchema = z
  .object({
    reviews: z.array(ReviewSchema),
    grants: z.array(GrantSchema),
    consumed_nonces: z.array(CodeSchema),
    events: z.array(AuditEventSchema),
  })
  .strict();
export type TrustState = z.infer<typeof TrustStateSchema>;
export type NormalizedScope = Omit<Scope, "workspace_id"> & {
  workspace_id: string | null;
};
export function normalizedScope(scope: Scope): NormalizedScope {
  return {
    ...ScopeSchema.parse(scope),
    workspace_id: scope.workspace_id ?? null,
  };
}
export function scopeKey(scope: Scope): string {
  return canonicalJSON(normalizedScope(scope));
}
export function binding(
  scope: Scope,
  e: SourceEvidence,
  permissions: Permission[],
  credential_bindings: CredentialBinding[],
): string {
  return sha256(
    canonicalJSON({
      scope: normalizedScope(scope),
      kind: e.kind,
      integration_id: e.integration_id,
      source: e.source,
      dependency_sha256: e.dependency_sha256,
      config_sha256: e.config_sha256,
      endpoint: e.endpoint,
      tools: e.tools,
      permissions,
      credential_bindings,
    }),
  );
}
