# Specialist serving on vLLM (Milestone 7, Workstream A)

Status: **offline-verified only** against an in-process fake vLLM. No GPU host, real vLLM server or model key has been used; nothing here is a live serving claim.

## What MARS does and does not do

- MARS **attaches** to an operator-started `vllm serve` process. It never starts, installs or configures vLLM, and never sets `VLLM_ALLOW_RUNTIME_LORA_UPDATING`.
- The server is the `vllm` provider target, reached through the existing `openai-compatible` adapter (`ProviderConfig.kind` is unchanged). Model policy, free-first routing and paid consent stay in `@mars/providers`; every vLLM model is registered as free (self-hosted) and the registry's `policy.allowPaid` is untouched.
- Pin: vLLM `v0.32.0`, source audit revision `5df63a7203cdb9328d824a27b682e77c7b9928be` (`sources/manifest.json` component `vllm`). `GET /version` must report exactly `0.32.0` (a PEP 440 local label such as `0.32.0+cu130` is accepted; dev, rc and other releases are not).
- URL policy: loopback (`127.0.0.1`, `localhost`, `::1`) by default, default `http://127.0.0.1:8000`. A non-loopback server needs the explicit `--vllm-allow-remote` flag **and** `https`. URLs with credentials, queries or paths other than `/v1` are refused.
- Attach, attestation and doctor use control requests: `GET /version`, `GET /v1/models`, and (dev runtime mode only) `POST /v1/load_lora_adapter` / `POST /v1/unload_lora_adapter`. No completion is requested at startup or in `mars doctor`. Task execution and serving-backed evaluation can request completions; their offline tests use opt-in fake completions, not real models.
- The server's own `--api-key` is read by environment-variable name (`MARS_VLLM_API_KEY`, or `--vllm-api-key-env NAME`) and sent as a bearer token; it is never printed.

## Serving profile

vLLM v0.32.0 `/v1/models` reports, per card, `id` (served name or LoRA name), `root` (model path or LoRA path), `parent` (`null` for a base, the base name for a LoRA) and `max_model_len`. It does not report the base revision, tokenizer revision or chat template. Those come from an operator profile (`VllmServingProfileSchema`), passed as `--vllm-profile FILE`:

```json
{
  "schema_version": 1,
  "served_model_name": "mars-base",
  "model_path": "/models/mars-base",
  "base_model": { "component": "model/qwen", "revision": "<40-hex>" },
  "tokenizer": { "component": "tokenizer/qwen", "revision": "<40-hex>" },
  "chat_template_sha256": "<64-hex>",
  "capabilities": { "tools": true, "vision": false },
  "max_lora_rank": 16
}
```

The profile is an operator statement; the live server must still agree on the served base name and, when `model_path` is set, its `root`. Without a profile `mars serve --vllm` registers only the base model (tool-less, context from `max_model_len`) and no adapter can attest.

## Attestation (`createVllmServingAttestor`)

Implements `ServingAttestor` from `packages/specialists/src/compat.ts` unchanged. Each `attest(context, binding)`:

1. returns `null` unless `binding.provider_id` is the vLLM provider id;
2. reads `/version` and `/v1/models`; an unreachable server, HTTP error, 401/403, non-JSON or schema-violating body, duplicate ids, a version other than the pin, a missing base card or a base `root` that differs from the profile all return `null` (unattested);
3. returns `null` when `binding.provider_model` is neither the served base nor a sha256-shaped adapter name;
4. otherwise returns `base_model`, `tokenizer` and `chat_template_sha256` from the profile, `adapter_formats: ["peft-lora"]`, and `loaded_adapter_sha256s` = cards whose id is a 64-hex sha256, whose `parent` is the served base and whose `root` is set.

A binding for a sha256 adapter that is not loaded therefore attests with that sha absent, so `checkServingReadiness` reports `serving_adapter_not_loaded` (not a generic `serving_unattested`). All other mismatch codes (`model_binding_mismatch`, `serving_base_mismatch`, `serving_tokenizer_mismatch`, `serving_chat_template_mismatch`, `serving_adapter_unsupported`) come from the unchanged consumer in `compat.ts`.

## Adapter lifecycle (`VllmAdapterManager`)

- **Name = bundle sha256.** The adapter's vLLM `lora_name` is the registered `adapter.sha256`; `lora_path` is the hash-addressed bundle path on the vLLM host.
- **Preflight, before any request:** the registration must have an adapter, the artifact sha must equal it, the format must be `peft-lora`, a serving binding must target `vllm`/`<sha>`, and `compatibleBase(registration, profile.base_model)`, the tokenizer and the chat template sha must match the profile. A wrong-base adapter is refused (`serving_base_mismatch`) with zero vLLM requests.
- **Static mode (default):** `staticLoraModules()` returns `--lora-modules` JSON values (`{"name": sha, "path": ..., "base_model_name": served}`) and `vllmServeArgv()` the operator command (`vllm serve <model> --served-model-name <name> --enable-lora [--max-lora-rank N] --lora-modules ...`). MARS prints, never runs, it.
- **Runtime mode (development only):** `load`, `unload` and `rollback` require `runtimeLoraUpdating: true` (`--vllm-dev-runtime-lora`) and an operator-started server with `VLLM_ALLOW_RUNTIME_LORA_UPDATING`. Without the flag they throw `runtime_lora_disabled` before any request; with the flag against a server where the routes are not mounted, load fails with `runtime_lora_unavailable`.
  - `load` skips the request when the sha is already listed from the same path (a different `root` throws `adapter_path_mismatch` before any request), then requires `checkServingReadiness` to report the vLLM binding `verified` with no reasons; otherwise it throws `not_ready` with the reasons, unloading the adapter only if this call loaded it.
  - `unload` is a no-op when the sha is not listed and fails `still_loaded` if `/v1/models` still lists it afterwards.
  - `rollback(context, fromSha, to?)` unloads `fromSha`, then loads `to` when given; with no `to` (or a failed restore) routing falls back to the base.

## CLI

```text
mars serve --vllm http://127.0.0.1:8000 [--vllm-profile PROFILE.json] [--vllm-allow-remote] [--vllm-api-key-env NAME] [--vllm-dev-runtime-lora]
mars doctor [--vllm URL] [--vllm-allow-remote] [--vllm-api-key-env NAME]
```

`mars serve --vllm` fails closed: an unreachable, malformed, off-pin or profile-disagreeing server stops startup with a usage error naming the cause. On success the `listening` line has a `vllm` object (`base_url`, `version`, `base_model`, `attested`, `adapters`, `models`, `lora_mode: static|dev-runtime`, `live_verified: false`) and the registry gains the `vllm` route (`vllm/<served>` and `vllm/<sha256>` models). The default route is unchanged. `mars doctor` reports the pin, reachability, version match and base/adapter counts only (`MARS_VLLM_URL` overrides the default URL).

## Opt-in specialist routing in `mars serve`

```sh
mars serve --source ./repo --state /private/mars-state \
  --vllm http://127.0.0.1:8000 --vllm-profile PROFILE.json \
  --specialists-registry /private/specialists \
  --specialists-trust TRUST.json --specialists-domain coding/mechanical-edit \
  --specialists-complexity medium
```

`--specialists-registry DIR` enables routing and requires `--specialists-trust FILE`
and `--specialists-domain AREA/KIND`. Optional `--specialists-complexity` accepts
`light|medium|heavy` (default `medium`). Dependent flags without the registry are
usage errors. Without these flags the listening summary has `specialists: null`.
`--specialists-registry` cannot be combined with `--omniroute`: the gateway
builds a separate model catalog that specialist routing cannot currently share.
With them it reports only domain, complexity, `serving_attestation: "vllm"|"none"`
and `step_routing: true`, not registry paths or secrets.

The CLI constructs `SpecialistTaskRouter` over the registry using the same model
catalog as the workbench (extended with vLLM when attached), with paid consent
disabled. Artifacts live at `<DIR>/artifacts/<sha256>`; see
[SPECIALISTS.md](SPECIALISTS.md) for the trust schema and permissions. Routing
events are stored as task evidence with `operation: "routing"`.

Only `--vllm` together with `--vllm-profile` supplies a serving attestor. No
attestor, an unattested target, an unloaded adapter (`serving_adapter_not_loaded`)
or a version that goes off-pin after startup (`serving_unattested`) prevents
adapter selection and falls back to an eligible baseline. Baseline execution
uses the ordinary free-only default model route; configure that route explicitly
if it must resolve to the vLLM base. An off-pin vLLM at initial attach refuses
startup instead. An invalidated specialist pin can resume on an eligible routed
fallback, recorded in the routing event, launch `model_rebinds` and journal;
unsafe or unavailable fallbacks leave it paused. No synthetic-fixture evidence
is enabled in production registry construction.

## Offline verified vs blocked

| Offline verified (fake vLLM) | Blocked |
| --- | --- |
| Pin/version check, loopback/remote URL policy, bearer key by env name | Real vLLM v0.32.0 `/v1/models` and `/version` on a GPU host |
| Attestor fail-closed paths and every serving mismatch reason code | Live adapter serving and completions through a loaded LoRA |
| Wrong-base rejection with zero vLLM requests; runtime LoRA refused without the dev flag | Static `--lora-modules` startup on a real server |
| Load / unload / rollback against the fake LoRA routes; serving-backed evaluator against opt-in fake completions | Adapter-vs-base evaluation on real vLLM |
| `SpecialistTaskRouter` consuming this attestor (`src/routing.test.ts`): loaded adapter routes; unload, off-pin version or unreachable server falls back to base | Mid-task fallback on a live server |
| `mars serve --vllm`, `mars doctor`, specialist serve routing (loaded, unloaded and off-pin), and specialists evaluate spawn e2e | Model key, tool-call parser for the chosen base |

The fake vLLM binds loopback. Completion support is opt-in; its default remains
HTTP 500, and completions count in `modelRequests()`. Control-only tests and
fixture evaluators still make zero model requests; fake-completion tests make
counted local requests. No GPU host, real pinned vLLM, real model key or live
adapter serving was verified by this increment.
