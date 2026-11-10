import type { ModelConfig } from "@mars/contracts";
import { loadModelRegistry, type ModelProviderRegistry } from "@mars/providers";
import {
  extendRegistryWithVllm,
  type FetchLike,
  loadVllmServingProfile,
  readVllmServing,
  VLLM_API_KEY_ENV,
  VLLM_DEFAULT_URL,
  VLLM_PIN,
  VLLM_PROVIDER_ID,
  VLLM_ROUTE,
  VllmClient,
  VllmError,
  type VllmModelCard,
  type VllmServingProfile,
  versionMatchesPin,
  vllmModelId,
  vllmModels,
  vllmOrigin,
} from "@mars/providers-vllm";
import { ServeUsageError } from "./cli-errors";

/** `mars serve` vLLM flags, already split off the serve argument list. */
export interface VllmServeFlags {
  url: string;
  allowRemote: boolean;
  apiKeyEnv: string;
  profilePath?: string;
  devRuntimeLora: boolean;
}

const VALUE_FLAGS = ["vllm", "vllm-api-key-env", "vllm-profile"] as const;
const BOOLEAN_FLAGS = ["vllm-allow-remote", "vllm-dev-runtime-lora"] as const;

export const VLLM_SERVE_USAGE = [
  "                  [--vllm http://127.0.0.1:8000] [--vllm-profile PROFILE.json] [--vllm-allow-remote] [--vllm-api-key-env NAME] [--vllm-dev-runtime-lora]",
];
export const VLLM_SERVE_HELP =
  "--vllm attaches to an operator-started vLLM v0.32.0 (MARS never starts it) as the `vllm` provider target. Loopback by default; a remote URL needs --vllm-allow-remote and https. Startup fails closed unless GET /version is the pinned release and GET /v1/models lists the base. --vllm-profile pins base, tokenizer and chat template so sha256-named LoRA adapters attest; without it only the base is registered. Adapters are static --lora-modules by default; --vllm-dev-runtime-lora is a development-only opt-in and MARS never sets VLLM_ALLOW_RUNTIME_LORA_UPDATING. The server's --api-key is read from MARS_VLLM_API_KEY (or --vllm-api-key-env) by name. Live vLLM use is unverified.";

/**
 * Removes the vLLM flags from a `mars serve` argument list so the serve
 * parser stays strict. Returns `undefined` config when `--vllm` is absent;
 * dependent flags without `--vllm` are a usage error.
 */
export function splitVllmServeArgs(args: readonly string[]): {
  args: string[];
  vllm?: VllmServeFlags;
} {
  const rest: string[] = [];
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string;
    if (arg === "--") {
      rest.push(...args.slice(index));
      break;
    }
    const match = /^--(vllm(?:-[a-z-]+)?)(?:=(.*))?$/.exec(arg);
    const name = match?.[1];
    if (!match || name === undefined) {
      rest.push(arg);
      continue;
    }
    if ((VALUE_FLAGS as readonly string[]).includes(name)) {
      const value = match[2] ?? args[++index];
      if (value === undefined || value === "" || value.startsWith("--"))
        throw new ServeUsageError(`--${name} needs a value.`);
      if (values.has(name))
        throw new ServeUsageError(`--${name} may be given once.`);
      values.set(name, value);
    } else if ((BOOLEAN_FLAGS as readonly string[]).includes(name)) {
      if (match[2] !== undefined)
        throw new ServeUsageError(`--${name} takes no value.`);
      booleans.add(name);
    } else {
      throw new ServeUsageError(`Unknown vLLM flag --${name}.`);
    }
  }
  const url = values.get("vllm");
  if (url === undefined) {
    if (values.size > 0 || booleans.size > 0)
      throw new ServeUsageError(
        "--vllm-* flags need --vllm URL to attach to a vLLM server.",
      );
    return { args: rest };
  }
  const allowRemote = booleans.has("vllm-allow-remote");
  try {
    vllmOrigin(url, { allowRemote });
  } catch (error) {
    throw new ServeUsageError(
      `--vllm: ${error instanceof Error ? error.message : "invalid URL"}`,
    );
  }
  const apiKeyEnv = values.get("vllm-api-key-env") ?? VLLM_API_KEY_ENV;
  if (!/^[A-Z_][A-Z0-9_]*$/.test(apiKeyEnv))
    throw new ServeUsageError(
      "--vllm-api-key-env must be an environment variable name.",
    );
  const profilePath = values.get("vllm-profile");
  return {
    args: rest,
    vllm: {
      url,
      allowRemote,
      apiKeyEnv,
      ...(profilePath !== undefined ? { profilePath } : {}),
      devRuntimeLora: booleans.has("vllm-dev-runtime-lora"),
    },
  };
}

export interface VllmServeReport {
  provider_id: string;
  route: string;
  base_url: string;
  version: string;
  pinned_release: string;
  base_model: string;
  attested: boolean;
  adapters: number;
  models: string[];
  lora_mode: "static" | "dev-runtime";
  live_verified: false;
}

function usageFromVllm(error: unknown): never {
  if (error instanceof ServeUsageError) throw error;
  if (error instanceof VllmError)
    throw new ServeUsageError(
      `--vllm: ${error.message} MARS refuses to start with an unattested vLLM target.`,
    );
  throw new ServeUsageError(
    `--vllm: ${error instanceof Error ? error.message : "vLLM attach failed."} MARS refuses to start with an unattested vLLM target.`,
  );
}

function baseOnlyModels(base: VllmModelCard): ModelConfig[] {
  return [
    {
      id: vllmModelId(base.id),
      providerId: VLLM_PROVIDER_ID,
      model: base.id,
      capabilities: {
        tools: false,
        vision: false,
        contextWindow: base.max_model_len ?? 4096,
      },
      pricing: { free: true },
      tags: ["vllm", "self-hosted", "vllm:base"],
    },
  ];
}

/**
 * Attaches to the operator's vLLM and layers it over `registry`. Fails
 * closed with a `ServeUsageError` on an unreachable, malformed, off-pin or
 * profile-disagreeing server. Sends only GET /version and GET /v1/models.
 */
export async function attachVllm(
  flags: VllmServeFlags,
  registry: ModelProviderRegistry,
  options: {
    env?: Record<string, string | undefined>;
    fetch?: FetchLike;
  } = {},
): Promise<{ registry: ModelProviderRegistry; report: VllmServeReport }> {
  const env = options.env ?? process.env;
  let profile: VllmServingProfile | undefined;
  if (flags.profilePath !== undefined) {
    try {
      profile = await loadVllmServingProfile(flags.profilePath);
    } catch {
      throw new ServeUsageError(
        "--vllm-profile must name a readable vLLM serving profile JSON (schema_version 1).",
      );
    }
  }
  try {
    const client = new VllmClient({
      url: flags.url,
      allowRemote: flags.allowRemote,
      apiKeyEnv: flags.apiKeyEnv,
      env,
      timeoutMs: 3_000,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    let version: string;
    let models: ModelConfig[];
    let baseName: string;
    let adapters = 0;
    if (profile) {
      const snapshot = await readVllmServing(client, profile);
      version = snapshot.version;
      baseName = snapshot.base.id;
      adapters = snapshot.adapters.length;
      models = vllmModels(profile, {
        context_window: snapshot.base.max_model_len ?? 4096,
        adapter_sha256s: snapshot.adapters.map((card) => card.id),
      });
    } else {
      version = await client.assertPinnedVersion();
      const base = (await client.models()).find((card) => card.parent === null);
      if (!base) throw new Error("vLLM /v1/models lists no base model.");
      baseName = base.id;
      models = baseOnlyModels(base);
    }
    const extended = extendRegistryWithVllm(registry, {
      url: flags.url,
      allowRemote: flags.allowRemote,
      // Keyless vLLM (the default) must stay routable: only require the key when it is set.
      ...(env[flags.apiKeyEnv]?.trim() ? { apiKeyEnv: flags.apiKeyEnv } : {}),
      models,
      env,
    });
    return {
      registry: extended,
      report: {
        provider_id: VLLM_PROVIDER_ID,
        route: VLLM_ROUTE,
        base_url: `${client.origin}/v1`,
        version,
        pinned_release: VLLM_PIN.release,
        base_model: baseName,
        attested: profile !== undefined,
        adapters,
        models: models.map(({ id }) => id),
        lora_mode: flags.devRuntimeLora ? "dev-runtime" : "static",
        live_verified: false,
      },
    };
  } catch (error) {
    usageFromVllm(error);
  }
}

/** `runServer` hook: loads the base registry the workbench would, then attaches vLLM. */
export async function vllmServeRegistry(
  flags: VllmServeFlags,
  location: { sourceRoot: string; trustProjectConfig: boolean },
): Promise<{ registry: ModelProviderRegistry; report: VllmServeReport }> {
  const base = await loadModelRegistry({
    cwd: location.sourceRoot,
    trustProjectConfig: location.trustProjectConfig,
  });
  return attachVllm(flags, base);
}

export interface VllmDoctorReport {
  package: "@mars/providers-vllm";
  pinned_release: string;
  pinned_revision: string;
  default_url: string;
  url: string | null;
  enabled_by: string;
  api_key_env: string;
  api_key_present: boolean;
  server: {
    reachable: boolean;
    version: string | null;
    version_matches_pin: boolean;
    base_models: number;
    sha256_adapters: number;
    error: string | null;
  };
  lora_mode_default: "static --lora-modules";
  runtime_lora_updating: string;
  live_verified: false;
}

/** Counts and booleans only; GET /version and GET /v1/models, no model request. */
export async function vllmDoctorReport(
  options: {
    url?: string;
    allowRemote?: boolean;
    apiKeyEnv?: string;
    env?: Record<string, string | undefined>;
    fetch?: FetchLike;
  } = {},
): Promise<VllmDoctorReport> {
  const env = options.env ?? process.env;
  const apiKeyEnv = options.apiKeyEnv ?? VLLM_API_KEY_ENV;
  const server: VllmDoctorReport["server"] = {
    reachable: false,
    version: null,
    version_matches_pin: false,
    base_models: 0,
    sha256_adapters: 0,
    error: null,
  };
  let url: string | null = null;
  try {
    const client = new VllmClient({
      url: options.url ?? env.MARS_VLLM_URL ?? VLLM_DEFAULT_URL,
      allowRemote: options.allowRemote === true,
      apiKeyEnv,
      env,
      timeoutMs: 1_500,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    url = client.origin;
    const version = await client.version();
    server.reachable = true;
    server.version = version.slice(0, 64);
    server.version_matches_pin = versionMatchesPin(version);
    const cards = await client.models();
    server.base_models = cards.filter((card) => card.parent === null).length;
    server.sha256_adapters = cards.filter(
      (card) => card.parent !== null && /^[a-f0-9]{64}$/.test(card.id),
    ).length;
  } catch (error) {
    server.error =
      error instanceof VllmError
        ? error.code
        : error instanceof Error
          ? "invalid_url"
          : "unknown";
  }
  return {
    package: "@mars/providers-vllm",
    pinned_release: VLLM_PIN.release,
    pinned_revision: VLLM_PIN.revision,
    default_url: VLLM_DEFAULT_URL,
    url,
    enabled_by:
      "mars serve --vllm URL [--vllm-profile PROFILE.json] [--vllm-dev-runtime-lora]",
    api_key_env: apiKeyEnv,
    api_key_present: env[apiKeyEnv] !== undefined,
    server,
    lora_mode_default: "static --lora-modules",
    runtime_lora_updating:
      "off; development-only opt-in with --vllm-dev-runtime-lora, and vLLM must be started by the operator with VLLM_ALLOW_RUNTIME_LORA_UPDATING (MARS never sets it)",
    live_verified: false,
  };
}
