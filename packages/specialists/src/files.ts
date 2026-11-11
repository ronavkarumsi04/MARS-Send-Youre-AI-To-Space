import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactRef, RequestContext } from "@mars/contracts";
import { z } from "zod";
import { sha256 } from "./canonical";
import { createHmacEvidenceVerifier } from "./evidence";

export function createFileArtifactStore(dir: string) {
  return {
    async get(_ctx: RequestContext, ref: ArtifactRef): Promise<Uint8Array> {
      if (!/^[a-f0-9]{64}$/.test(ref.sha256))
        throw new Error("artifact_invalid");
      const bytes = await readFile(join(dir, ref.sha256));
      if (sha256(bytes) !== ref.sha256 || bytes.byteLength !== ref.byte_length)
        throw new Error("artifact_digest_mismatch");
      return bytes;
    },
    async put(
      _ctx: RequestContext,
      bytes: Uint8Array,
      mediaType: string,
    ): Promise<ArtifactRef> {
      const copy = Uint8Array.from(bytes);
      const digest = sha256(copy);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700);
      const file = join(dir, digest);
      await writeFile(file, copy, { mode: 0o600 });
      await chmod(file, 0o600);
      return {
        artifact_id: `sha256:${digest}`,
        sha256: digest,
        byte_length: copy.byteLength,
        media_type: mediaType,
      };
    },
  };
}

export const SpecialistTrustSchema = z
  .object({
    schema: z.literal("mars.specialist-trust/v1"),
    authorities: z
      .array(
        z
          .object({
            key_id: z.string().min(1),
            authority_id: z.string().min(1),
            secret_env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
            owner_ids: z.array(z.string().min(1)).min(1),
            evaluator_ids: z.array(z.string().min(1)).min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

/** Secrets are UTF-8 strings read exclusively from the named environment variables. */
export async function loadSpecialistTrust(
  file: string,
  env: Record<string, string | undefined>,
) {
  try {
    const trust = SpecialistTrustSchema.parse(
      JSON.parse(await readFile(file, "utf8")),
    );
    const keys = new Set<string>();
    const authorities = trust.authorities.map(
      ({ secret_env, ...authority }) => {
        const value = env[secret_env];
        if (!value?.trim() || keys.has(authority.key_id))
          throw new Error("trust_invalid");
        keys.add(authority.key_id);
        return { ...authority, secret: new TextEncoder().encode(value) };
      },
    );
    return {
      authorities,
      evidenceVerifier: createHmacEvidenceVerifier({ authorities }),
    };
  } catch {
    throw new Error("trust_invalid");
  }
}
