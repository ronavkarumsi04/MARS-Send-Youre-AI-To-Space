import type { RequestContext } from "@mars/contracts";
import type {
  ServingAttestation,
  ServingAttestor,
  ServingBinding,
} from "@mars/specialists";
import type { VllmClient, VllmModelCard } from "./client";
import type { VllmServingProfile } from "./profile";
import {
  ADAPTER_NAME_PATTERN,
  VLLM_PROVIDER_ID,
  vllmModelId,
} from "./provider";

/** What one `/version` + `/v1/models` round reports, after pin and profile checks. */
export interface VllmServingSnapshot {
  version: string;
  base: VllmModelCard;
  /** Adapter cards whose name is a bundle sha256 and whose parent is the base. */
  adapters: VllmModelCard[];
  /** Cards ignored for attestation (other bases, non-sha adapters, foreign parents). */
  ignored_cards: number;
}

export interface VllmAttestorOptions {
  client: VllmClient;
  profile: VllmServingProfile;
  providerId?: string;
}

/**
 * Reads the live server and checks it against the pin and the operator
 * profile. Throws a `VllmError` (or a plain `Error` on profile disagreement);
 * the attestor turns every throw into "unattested".
 */
export async function readVllmServing(
  client: VllmClient,
  profile: VllmServingProfile,
): Promise<VllmServingSnapshot> {
  const version = await client.assertPinnedVersion();
  const cards = await client.models();
  const base = cards.find(
    (card) => card.id === profile.served_model_name && card.parent === null,
  );
  if (!base) throw new Error("vLLM does not serve the profiled base model.");
  if (profile.model_path !== undefined && base.root !== profile.model_path)
    throw new Error("vLLM base model path differs from the profile.");
  const adapters = cards.filter(
    (card) =>
      card.parent === base.id &&
      card.root !== null &&
      ADAPTER_NAME_PATTERN.test(card.id),
  );
  return {
    version,
    base,
    adapters,
    ignored_cards: cards.length - 1 - adapters.length,
  };
}

/**
 * A `ServingAttestor` backed by a real vLLM `/v1/models` listing. It fails
 * closed: unreachable server, malformed listing, version other than the pin,
 * a different provider, missing base, or a binding naming a model the
 * server does not serve all return `null` (unattested).
 *
 * A binding whose `provider_model` is a sha256-shaped adapter name that is
 * not loaded still attests the base, with that sha absent from
 * `loaded_adapter_sha256s`, so the consumer reports
 * `serving_adapter_not_loaded` rather than a generic `serving_unattested`.
 */
export function createVllmServingAttestor(
  options: VllmAttestorOptions,
): ServingAttestor {
  const providerId = options.providerId ?? VLLM_PROVIDER_ID;
  return {
    async attest(
      _context: RequestContext,
      binding: ServingBinding,
    ): Promise<ServingAttestation | null> {
      if (binding.provider_id !== providerId) return null;
      let snapshot: VllmServingSnapshot;
      try {
        snapshot = await readVllmServing(options.client, options.profile);
      } catch {
        return null;
      }
      const loaded = snapshot.adapters.map((card) => card.id);
      const servesModel =
        binding.provider_model === snapshot.base.id ||
        ADAPTER_NAME_PATTERN.test(binding.provider_model);
      if (!servesModel) return null;
      return {
        model_id:
          providerId === VLLM_PROVIDER_ID
            ? vllmModelId(binding.provider_model)
            : `${providerId}/${binding.provider_model}`,
        provider_id: providerId,
        provider_model: binding.provider_model,
        base_model: options.profile.base_model,
        tokenizer: options.profile.tokenizer,
        chat_template_sha256: options.profile.chat_template_sha256,
        adapter_formats: ["peft-lora"],
        loaded_adapter_sha256s: loaded.sort(),
      };
    },
  };
}
