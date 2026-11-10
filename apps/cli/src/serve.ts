import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createPlaywrightEngine } from "@mars/browser-worker";
import { applyPatch, discoverInstructions } from "@mars/codex-tools";
import { registerRuntimeCleanup } from "@mars/execution";
import {
  createBraveSearch,
  createSearxngSearch,
  createTavilySearch,
  type SearchProvider,
} from "@mars/research-worker";
import {
  createWorkbenchService,
  DEFAULT_WORKBENCH_PORT,
  loadWorkbenchConventions,
  type WorkbenchBrowserOptions,
  type WorkbenchResearchOptions,
} from "@mars/workbench";
import { remoteWorkspaceFromFlags } from "@mars/workspaces-remote";
import { ServeUsageError } from "./cli-errors";
import { omnirouteFromFlags } from "./omniroute";
import {
  VLLM_SERVE_HELP,
  VLLM_SERVE_USAGE,
  type VllmServeFlags,
  vllmServeRegistry,
} from "./vllm";
import { resolveWorkbenchLocation } from "./workbench-location";

export { ServeUsageError };

/** Search providers `mars serve` can drive; credentials are read from the named environment variable at startup only. */
export const RESEARCH_SEARCH_PROVIDERS = {
  brave: {
    api_key_env: "BRAVE_SEARCH_API_KEY",
    docs_url: "https://brave.com/search/api/",
  },
  searxng: {
    api_key_env: null,
    docs_url: "https://docs.searxng.org/",
  },
  tavily: {
    api_key_env: "TAVILY_API_KEY",
    docs_url: "https://docs.tavily.com/",
  },
} as const;
export type ResearchSearchProviderId = keyof typeof RESEARCH_SEARCH_PROVIDERS;

export interface ResearchFlags {
  search?: string;
  apiKeyEnv?: string;
  searxngUrl?: string;
  model?: string;
  denyHosts?: string[];
}

function isSearchProviderId(value: string): value is ResearchSearchProviderId {
  return Object.hasOwn(RESEARCH_SEARCH_PROVIDERS, value);
}

/**
 * Builds the live browser configuration from CLI flags: the Playwright engine
 * drives the named local Chromium/Chrome executable, and every page request
 * goes through the worker's guarded fetch with real DNS.
 */
export function browserFromFlags(flags: {
  chromium?: string;
  denyHosts?: string[];
  allowInput?: boolean;
}): WorkbenchBrowserOptions | undefined {
  if (flags.chromium === undefined) {
    if (flags.denyHosts?.length || flags.allowInput)
      throw new ServeUsageError(
        "--browser-deny-host and --browser-allow-input require --browser-chromium PATH.",
      );
    return undefined;
  }
  const executablePath = flags.chromium;
  let usable = isAbsolute(executablePath);
  if (usable) {
    try {
      usable = statSync(executablePath).isFile();
      accessSync(executablePath, constants.X_OK);
    } catch {
      usable = false;
    }
  }
  if (!usable)
    throw new ServeUsageError(
      "--browser-chromium must be the absolute path of an executable Chromium or Chrome binary.",
    );
  return {
    engine: createPlaywrightEngine({ executablePath }),
    ...(flags.allowInput
      ? {
          allowedActions: [
            "navigate",
            "click",
            "type",
            "press",
            "scroll",
            "back",
            "screenshot",
            "extract",
          ],
        }
      : {}),
    worker: {
      live: true,
      ...(flags.denyHosts?.length ? { deny_hosts: flags.denyHosts } : {}),
    },
  };
}

/**
 * Builds the live research configuration from CLI flags. Only the credential's
 * environment variable name is ever reported; its value goes to the search
 * adapter and nowhere else.
 */
export function researchFromFlags(
  flags: ResearchFlags,
  env: Record<string, string | undefined>,
): WorkbenchResearchOptions | undefined {
  if (flags.search === undefined) {
    for (const [flag, value] of Object.entries({
      "--research-api-key-env": flags.apiKeyEnv,
      "--research-searxng-url": flags.searxngUrl,
      "--research-model": flags.model,
      "--research-deny-host": flags.denyHosts,
    })) {
      if (value !== undefined)
        throw new ServeUsageError(
          `${flag} requires --research-search <${Object.keys(RESEARCH_SEARCH_PROVIDERS).join("|")}>.`,
        );
    }
    return undefined;
  }
  if (!isSearchProviderId(flags.search))
    throw new ServeUsageError(
      `Unknown research search provider "${flags.search}"; expected one of ${Object.keys(RESEARCH_SEARCH_PROVIDERS).join(", ")}.`,
    );
  const provider = RESEARCH_SEARCH_PROVIDERS[flags.search];
  const pageFetch = (input: string, init?: RequestInit) => fetch(input, init);
  let search: SearchProvider;
  if (flags.search === "searxng") {
    if (flags.apiKeyEnv !== undefined)
      throw new ServeUsageError(
        "--research-api-key-env does not apply to SearXNG.",
      );
    const baseUrl = flags.searxngUrl;
    if (!baseUrl || !/^https?:\/\//.test(baseUrl))
      throw new ServeUsageError(
        "--research-search searxng requires --research-searxng-url http(s)://HOST[:PORT].",
      );
    search = createSearxngSearch({ baseUrl, fetch: pageFetch });
  } else {
    if (flags.searxngUrl !== undefined)
      throw new ServeUsageError(
        "--research-searxng-url applies only to --research-search searxng.",
      );
    const apiKeyEnv = flags.apiKeyEnv ?? provider.api_key_env;
    if (apiKeyEnv === null || !/^[A-Z_][A-Z0-9_]*$/.test(apiKeyEnv))
      throw new ServeUsageError(
        "--research-api-key-env must be an environment variable name.",
      );
    const apiKey = env[apiKeyEnv];
    if (!apiKey)
      throw new ServeUsageError(
        `Research search provider "${flags.search}" needs the ${apiKeyEnv} environment variable; it is not set.`,
      );
    search =
      flags.search === "brave"
        ? createBraveSearch({ apiKey, fetch: pageFetch })
        : createTavilySearch({ apiKey, fetch: pageFetch });
  }
  return {
    search,
    worker: {
      live: true,
      ...(flags.model ? { model: flags.model } : {}),
      ...(flags.denyHosts ? { deny_hosts: flags.denyHosts } : {}),
    },
    env,
  };
}

/**
 * The @mars/codex-tools pieces the loader is given: the apply_patch applier
 * and the instruction-file discovery. Kept in one place so the CLI is the only
 * composition point.
 */
export function conventionsAdapters(): Pick<
  Parameters<typeof loadWorkbenchConventions>[0],
  "applyPatch" | "discoverInstructions"
> {
  return {
    applyPatch: (patch, files) => applyPatch(patch, files),
    discoverInstructions: (root) => discoverInstructions({ root }),
  };
}

export async function runServer(
  args: string[],
  options: { vllm?: VllmServeFlags } = {},
): Promise<void> {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      source: { type: "string" },
      state: { type: "string" },
      port: { type: "string" },
      owner: { type: "string" },
      project: { type: "string" },
      image: { type: "string" },
      checks: { type: "string" },
      "workspace-provider": { type: "string" },
      "agent-server": { type: "string" },
      "agent-server-key-env": { type: "string" },
      "agent-server-root": { type: "string" },
      "agent-server-allow-insecure-http": { type: "boolean" },
      "trust-project": { type: "boolean" },
      "no-conventions": { type: "boolean" },
      "research-search": { type: "string" },
      "research-api-key-env": { type: "string" },
      "research-searxng-url": { type: "string" },
      "research-model": { type: "string" },
      "research-deny-host": { type: "string", multiple: true },
      "browser-chromium": { type: "string" },
      "browser-deny-host": { type: "string", multiple: true },
      "browser-allow-input": { type: "boolean" },
      graphify: { type: "string", multiple: true },
      "graphify-os-wrapper": { type: "boolean" },
      omniroute: { type: "boolean" },
      "omniroute-url": { type: "string" },
      "omniroute-start": { type: "boolean" },
      "omniroute-allow": { type: "string", multiple: true },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      [
        `Usage: mars serve [--source DIR] [--state PRIVATE_DIR] [--port ${DEFAULT_WORKBENCH_PORT}] [--owner ID] [--project ID] [--image REPO@sha256:DIGEST] [--checks HOST_CHECKS.json] [--trust-project] [--no-conventions]`,
        "                  [--research-search brave|searxng|tavily] [--research-api-key-env NAME] [--research-searxng-url URL] [--research-model ID] [--research-deny-host PATTERN]... [--browser-chromium PATH] [--browser-deny-host PATTERN]... [--browser-allow-input] [--graphify ARG]... [--graphify-os-wrapper]",
        "                  [--omniroute] [--omniroute-url http://localhost:20128] [--omniroute-start] [--omniroute-allow web-session|browser-session|caution|ambiguous|unknown]...",
        ...VLLM_SERVE_USAGE,
        "                  [--workspace-provider local|remote] [--agent-server URL] [--agent-server-key-env MARS_AGENT_SERVER_API_KEY] [--agent-server-root /workspace/mars] [--agent-server-allow-insecure-http]",
        "--workspace-provider remote runs workspace shell/files/artifacts on a pinned OpenHands Agent Server (1.59.0) at --agent-server; planning and model calls stay in MARS. The session key is read from the named environment variable and never printed. A remote server interface is not an OS isolation guarantee: commands run with the Agent Server process's privileges on its host. Live remote acceptance is unverified.",
        "Without a pre-pulled digest-pinned image, command execution is disabled. No model request is made at startup. Connection credentials are written only to the private connection file.",
        "Code knowledge graph tools (mars_graph_build, mars_graph_query) are offered only with --graphify ARG (repeatable; the argv prefix of the pinned graphify 0.9.101 executable from a uv/venv install, optionally behind an OS sandbox such as bwrap, then pass --graphify-os-wrapper). Confinement without a wrapper is process-level only (argv, env allowlist, offline flags); the graph is a derived, rebuildable artifact.",
        "Repository conventions are read once from --source at startup: skill folders (skills/, .claude/skills, .codex/skills, .agents/skills) and slash commands (.mars/commands, .claude/commands) always; AGENTS.md/AGENTS.override.md/CLAUDE.md instruction files and .mars/hooks.json only with --trust-project. Hook commands run only through the sandboxed execute path with execute approval. --no-conventions disables all of it, including mars_apply_patch.",
        "Background research runs only with --research-search. The search credential is read from BRAVE_SEARCH_API_KEY / TAVILY_API_KEY (or --research-api-key-env NAME) at startup and never stored; the worker uses the free default model unless --research-model names another free model. Live research is unverified.",
        "Background browser tasks (mars_browse, mars_browse_result) run only with --browser-chromium PATH (a local Chromium/Chrome executable driven through playwright-core). Browsing is read-only unless --browser-allow-input grants typing and key presses, every request passes the MARS egress guard (no private addresses, no credentials in URLs), and the planner is the free default model. Live browsing is unverified.",
        "--omniroute adds a self-hosted OmniRoute gateway as the `omniroute` provider target (attach to a running instance; --omniroute-start spawns the pinned omniroute CLI on 127.0.0.1). Only free, non-excluded catalog models route; MARS keeps policy and sends its paid-consent state. OMNIROUTE_API_KEY (OmniRoute's own key) is read by name; upstream credentials stay in OmniRoute. Live OmniRoute use is unverified.",
        VLLM_SERVE_HELP,
      ].join("\n"),
    );
    return;
  }
  const research = researchFromFlags(
    {
      ...(values["research-search"] !== undefined
        ? { search: values["research-search"] }
        : {}),
      ...(values["research-api-key-env"] !== undefined
        ? { apiKeyEnv: values["research-api-key-env"] }
        : {}),
      ...(values["research-searxng-url"] !== undefined
        ? { searxngUrl: values["research-searxng-url"] }
        : {}),
      ...(values["research-model"] !== undefined
        ? { model: values["research-model"] }
        : {}),
      ...(values["research-deny-host"] !== undefined
        ? { denyHosts: values["research-deny-host"] }
        : {}),
    },
    process.env,
  );
  const browser = browserFromFlags({
    ...(values["browser-chromium"] !== undefined
      ? { chromium: values["browser-chromium"] }
      : {}),
    ...(values["browser-deny-host"] !== undefined
      ? { denyHosts: values["browser-deny-host"] }
      : {}),
    ...(values["browser-allow-input"] ? { allowInput: true } : {}),
  });
  const omniroute = omnirouteFromFlags({
    ...(values.omniroute !== undefined ? { enabled: values.omniroute } : {}),
    ...(values["omniroute-url"] !== undefined
      ? { url: values["omniroute-url"] }
      : {}),
    ...(values["omniroute-start"] !== undefined
      ? { start: values["omniroute-start"] }
      : {}),
    ...(values["omniroute-allow"] !== undefined
      ? { allow: values["omniroute-allow"] }
      : {}),
  });
  const remoteWorkspace = remoteWorkspaceFromFlags(
    {
      ...(values["workspace-provider"] !== undefined
        ? { provider: values["workspace-provider"] }
        : {}),
      ...(values["agent-server"] !== undefined
        ? { agentServer: values["agent-server"] }
        : {}),
      ...(values["agent-server-key-env"] !== undefined
        ? { keyEnv: values["agent-server-key-env"] }
        : {}),
      ...(values["agent-server-root"] !== undefined
        ? { remoteRoot: values["agent-server-root"] }
        : {}),
      ...(values["agent-server-allow-insecure-http"]
        ? { allowInsecureHttp: true }
        : {}),
    },
    process.env,
  );
  const { source, project, state } = await resolveWorkbenchLocation({
    source: values.source,
    project: values.project,
    state: values.state,
  });
  const trustProject =
    values["trust-project"] === true ||
    process.env.MARS_TRUST_PROJECT_CONFIG === "1";
  const conventions =
    values["no-conventions"] === true
      ? null
      : await loadWorkbenchConventions({
          sourceRoot: source,
          trustProject,
          ...conventionsAdapters(),
        });
  const vllm = options.vllm
    ? await vllmServeRegistry(options.vllm, {
        sourceRoot: source,
        trustProjectConfig: trustProject,
      })
    : undefined;
  const service = await createWorkbenchService({
    sourceRoot: source,
    stateRoot: state,
    scope: { owner_id: values.owner ?? "local", project_id: project },
    port:
      values.port === undefined ? DEFAULT_WORKBENCH_PORT : Number(values.port),
    ...(values.image ? { image: values.image } : {}),
    ...(values.checks ? { checksFile: resolve(values.checks) } : {}),
    ...(remoteWorkspace ? { remoteWorkspace } : {}),
    ...(research ? { research } : {}),
    ...(browser ? { browser } : {}),
    ...(values.graphify?.length
      ? {
          knowledgeGraph: {
            command: values.graphify,
            osWrapper: values["graphify-os-wrapper"] === true,
          },
        }
      : {}),
    ...(conventions ? { conventions: conventions.conventions } : {}),
    ...(omniroute ? { omniroute } : {}),
    ...(vllm ? { registry: vllm.registry } : {}),
    trustProjectConfig: trustProject,
  });
  await new Promise<void>((resolve, reject) => {
    registerRuntimeCleanup("mars-workbench", async () => {
      try {
        await service.close();
        resolve();
      } catch {
        reject(new Error("Workbench shutdown failed."));
      }
    });
    console.log(
      JSON.stringify({
        status: "listening",
        url: service.url,
        connection_file: service.connectionFile,
        execute_enabled: Boolean(values.image) || Boolean(remoteWorkspace),
        workspace_provider: service.workspaceIsolation ?? { provider: "local" },
        research: research ? { search: research.search.id, live: true } : null,
        browser: browser ? { engine: browser.engine.id, live: true } : null,
        knowledge_graph: values.graphify?.length
          ? {
              command: values.graphify,
              isolation: values["graphify-os-wrapper"]
                ? "os_wrapper"
                : "process_env",
            }
          : null,
        conventions: conventions ? conventions.summary : null,
        omniroute: service.omniroute,
        vllm: vllm ? vllm.report : null,
      }),
    );
  });
}
