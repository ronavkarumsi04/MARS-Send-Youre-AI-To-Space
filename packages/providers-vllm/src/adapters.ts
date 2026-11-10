import type { ModelConfig, RequestContext } from "@mars/contracts";
import {
  checkServingReadiness,
  compatibleBase,
  type ModelCatalog,
  type ReasonCode,
  type ServingAttestor,
  type ServingReadiness,
  type SpecialistRegistration,
} from "@mars/specialists";
import { createVllmServingAttestor, readVllmServing } from "./attestor";
import type { VllmClient, VllmModelCard } from "./client";
import { sameVersionRef, type VllmServingProfile } from "./profile";
import { ADAPTER_NAME_PATTERN, VLLM_PROVIDER_ID, vllmModels } from "./provider";

/** A MARS adapter bundle as the vLLM host sees it: its sha256 and its path there. */
export interface AdapterArtifact {
  sha256: string;
  /** Path of the hash-addressed bundle on the vLLM host (`lora_path`). */
  path: string;
}

export type AdapterRefusalCode =
  | "adapter_missing"
  | "adapter_format_unsupported"
  | "artifact_hash_mismatch"
  | "no_vllm_binding"
  | "serving_base_mismatch"
  | "serving_tokenizer_mismatch"
  | "serving_chat_template_mismatch"
  | "runtime_lora_disabled"
  | "adapter_path_mismatch"
  | "still_loaded"
  | "not_ready";

export class VllmAdapterRefused extends Error {
  constructor(
    readonly code: AdapterRefusalCode,
    message: string,
    readonly reasons: ReasonCode[] = [],
  ) {
    super(message);
    this.name = "VllmAdapterRefused";
  }
}

export interface VllmAdapterManagerOptions {
  client: VllmClient;
  profile: VllmServingProfile;
  /**
   * Runtime `/v1/load_lora_adapter` use. Development only and off by default;
   * the operator must also start vLLM with `VLLM_ALLOW_RUNTIME_LORA_UPDATING`,
   * which MARS never sets. Production uses static `--lora-modules`.
   */
  runtimeLoraUpdating?: boolean;
  /** Catalog used by `checkServingReadiness`; defaults to the profiled vLLM models. */
  catalog?: ModelCatalog;
  attestor?: ServingAttestor;
  providerId?: string;
  /** Context window reported for synthesized catalog entries. */
  contextWindow?: number;
}

export interface StaticLoraModule {
  name: string;
  path: string;
  base_model_name: string;
}

export interface RollbackResult {
  unloaded: string | null;
  restored: string | null;
  readiness: ServingReadiness[];
}

/** A free, always-available catalog of the profiled base and any sha-named adapter. */
export function vllmCatalog(
  profile: VllmServingProfile,
  contextWindow = 8192,
): ModelCatalog {
  const base = vllmModels(profile, {
    context_window: contextWindow,
    adapter_sha256s: [],
  })[0] as ModelConfig;
  return {
    policy: { allowPaid: false },
    getModel(id) {
      if (id === base.id) return base;
      const sha = id.startsWith(`${VLLM_PROVIDER_ID}/`)
        ? id.slice(VLLM_PROVIDER_ID.length + 1)
        : "";
      if (!ADAPTER_NAME_PATTERN.test(sha)) return undefined;
      return vllmModels(profile, {
        context_window: contextWindow,
        adapter_sha256s: [sha],
      })[1];
    },
    unavailableReason: () => undefined,
  };
}

/**
 * Loads, unloads and rolls back LoRA adapters on an operator-started vLLM,
 * naming each by its bundle sha256. Every check that can be made without
 * the server (base, tokenizer, chat template, hash, format) runs before
 * any request, so a wrong-base adapter never reaches vLLM.
 */
export class VllmAdapterManager {
  private readonly providerId: string;
  private readonly catalog: ModelCatalog;
  private readonly attestor: ServingAttestor;

  constructor(private readonly options: VllmAdapterManagerOptions) {
    this.providerId = options.providerId ?? VLLM_PROVIDER_ID;
    this.catalog =
      options.catalog ?? vllmCatalog(options.profile, options.contextWindow);
    this.attestor =
      options.attestor ??
      createVllmServingAttestor({
        client: options.client,
        profile: options.profile,
        providerId: this.providerId,
      });
  }

  get runtimeLoraUpdating(): boolean {
    return this.options.runtimeLoraUpdating === true;
  }

  /** Offline compatibility gate; throws `VllmAdapterRefused`, never touches the network. */
  preflight(
    registration: SpecialistRegistration,
    artifact: AdapterArtifact,
  ): void {
    const { profile } = this.options;
    if (!registration.adapter)
      throw new VllmAdapterRefused(
        "adapter_missing",
        "Specialist has no adapter artifact.",
      );
    if (
      !ADAPTER_NAME_PATTERN.test(artifact.sha256) ||
      artifact.sha256 !== registration.adapter.sha256
    )
      throw new VllmAdapterRefused(
        "artifact_hash_mismatch",
        "Adapter bundle sha256 does not match the registered adapter.",
      );
    if (registration.profile.adapter_spec?.format !== "peft-lora")
      throw new VllmAdapterRefused(
        "adapter_format_unsupported",
        "vLLM serves peft-lora adapters only.",
        ["serving_adapter_unsupported"],
      );
    if (
      !registration.profile.serving.some(
        (binding) =>
          binding.provider_id === this.providerId &&
          binding.provider_model === artifact.sha256,
      )
    )
      throw new VllmAdapterRefused(
        "no_vllm_binding",
        "Specialist has no serving binding to this vLLM adapter name.",
      );
    if (!compatibleBase(registration, profile.base_model))
      throw new VllmAdapterRefused(
        "serving_base_mismatch",
        "Adapter was trained on a different base model than vLLM serves.",
        ["serving_base_mismatch"],
      );
    if (!sameVersionRef(registration.tokenizer, profile.tokenizer))
      throw new VllmAdapterRefused(
        "serving_tokenizer_mismatch",
        "Adapter tokenizer differs from the served tokenizer.",
        ["serving_tokenizer_mismatch"],
      );
    if (registration.chat_template.sha256 !== profile.chat_template_sha256)
      throw new VllmAdapterRefused(
        "serving_chat_template_mismatch",
        "Adapter chat template differs from the served chat template.",
        ["serving_chat_template_mismatch"],
      );
  }

  /** `--lora-modules` JSON values for the default, static serving mode. */
  staticLoraModules(
    entries: readonly {
      registration: SpecialistRegistration;
      artifact: AdapterArtifact;
    }[],
  ): string[] {
    return entries.map(({ registration, artifact }) => {
      this.preflight(registration, artifact);
      const module: StaticLoraModule = {
        name: artifact.sha256,
        path: artifact.path,
        base_model_name: this.options.profile.served_model_name,
      };
      return JSON.stringify(module);
    });
  }

  /** Readiness of this registration's vLLM binding(s) as the consumer would see it. */
  async readiness(
    context: RequestContext,
    registration: SpecialistRegistration,
  ): Promise<ServingReadiness[]> {
    const all = await checkServingReadiness(context, registration, {
      catalog: this.catalog,
      servingAttestor: this.attestor,
    });
    return all.filter(
      ({ binding }) =>
        binding.provider_id === this.providerId &&
        binding.provider_model === registration.adapter?.sha256,
    );
  }

  private requireRuntime(action: string): void {
    if (!this.runtimeLoraUpdating)
      throw new VllmAdapterRefused(
        "runtime_lora_disabled",
        `Runtime LoRA ${action} is a development-only path; restart vLLM with static --lora-modules or opt in with --vllm-dev-runtime-lora.`,
      );
  }

  private async loadedAdapters(): Promise<VllmModelCard[]> {
    const snapshot = await readVllmServing(
      this.options.client,
      this.options.profile,
    );
    return snapshot.adapters;
  }

  private async loadedSha256s(): Promise<string[]> {
    return (await this.loadedAdapters()).map((card) => card.id);
  }

  /** Runtime load (dev only), then verify the binding attests with no reasons. */
  async load(
    context: RequestContext,
    registration: SpecialistRegistration,
    artifact: AdapterArtifact,
  ): Promise<ServingReadiness[]> {
    this.preflight(registration, artifact);
    this.requireRuntime("loading");
    const existing = (await this.loadedAdapters()).find(
      (card) => card.id === artifact.sha256,
    );
    if (existing && existing.root !== artifact.path)
      throw new VllmAdapterRefused(
        "adapter_path_mismatch",
        "vLLM already serves this adapter name from a different path; unload it first.",
      );
    if (!existing)
      await this.options.client.loadAdapter(artifact.sha256, artifact.path);
    const readiness = await this.readiness(context, registration);
    const reasons = [...new Set(readiness.flatMap((entry) => entry.reasons))];
    if (
      readiness.length === 0 ||
      reasons.length > 0 ||
      readiness.some((entry) => entry.serving_attestation !== "verified")
    ) {
      await this.options.client
        .unloadAdapter(artifact.sha256)
        .catch(() => undefined);
      throw new VllmAdapterRefused(
        "not_ready",
        "Adapter loaded but did not attest; it was unloaded.",
        reasons.sort() as ReasonCode[],
      );
    }
    return readiness;
  }

  /** Runtime unload (dev only); verified against `/v1/models`. */
  async unload(sha256: string): Promise<boolean> {
    if (!ADAPTER_NAME_PATTERN.test(sha256))
      throw new VllmAdapterRefused(
        "artifact_hash_mismatch",
        "Adapter names are bundle sha256 digests.",
      );
    this.requireRuntime("unloading");
    if (!(await this.loadedSha256s()).includes(sha256)) return false;
    await this.options.client.unloadAdapter(sha256);
    if ((await this.loadedSha256s()).includes(sha256))
      throw new VllmAdapterRefused(
        "still_loaded",
        "vLLM still lists the adapter after unload.",
      );
    return true;
  }

  /**
   * Unloads `from`, then restores `to` when given. With no `to`, or if the
   * restore fails, callers route to the base fallback; `from` stays unloaded.
   */
  async rollback(
    context: RequestContext,
    from: string,
    to?: { registration: SpecialistRegistration; artifact: AdapterArtifact },
  ): Promise<RollbackResult> {
    if (to) this.preflight(to.registration, to.artifact);
    this.requireRuntime("rollback");
    const unloaded = (await this.unload(from)) ? from : null;
    if (!to) return { unloaded, restored: null, readiness: [] };
    const readiness = await this.load(context, to.registration, to.artifact);
    return { unloaded, restored: to.artifact.sha256, readiness };
  }
}

/** The operator command for the default static mode (MARS prints it, never runs it). */
export function vllmServeArgv(
  profile: VllmServingProfile,
  loraModules: readonly string[],
): string[] {
  return [
    "vllm",
    "serve",
    profile.model_path ?? profile.served_model_name,
    "--served-model-name",
    profile.served_model_name,
    ...(loraModules.length > 0
      ? [
          "--enable-lora",
          ...(profile.max_lora_rank
            ? ["--max-lora-rank", String(profile.max_lora_rank)]
            : []),
          "--lora-modules",
          ...loraModules,
        ]
      : []),
  ];
}
