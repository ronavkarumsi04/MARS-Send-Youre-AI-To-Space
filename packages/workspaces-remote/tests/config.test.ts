import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_AGENT_SERVER_KEY_ENV,
  ISOLATION_STATEMENT,
  remoteWorkspaceDoctor,
  remoteWorkspaceFromFlags,
  startFakeAgentServer,
} from "../src";

test("remote selection is explicit and the key comes only from the named env var", () => {
  expect(remoteWorkspaceFromFlags({}, {})).toBeNull();
  expect(remoteWorkspaceFromFlags({ provider: "local" }, {})).toBeNull();
  expect(() => remoteWorkspaceFromFlags({ provider: "remote" }, {})).toThrow(
    "--agent-server",
  );
  expect(() =>
    remoteWorkspaceFromFlags(
      { provider: "local", agentServer: "https://a.example" },
      {},
    ),
  ).toThrow("--workspace-provider remote");
  expect(() => remoteWorkspaceFromFlags({ provider: "cloud" }, {})).toThrow(
    "local or remote",
  );
  expect(() =>
    remoteWorkspaceFromFlags(
      {
        provider: "remote",
        agentServer: "https://a.example",
        keyEnv: "bad name",
      },
      {},
    ),
  ).toThrow("environment variable name");
  expect(() =>
    remoteWorkspaceFromFlags(
      { provider: "remote", agentServer: "http://a.example" },
      {},
    ),
  ).toThrow("https");
  const config = remoteWorkspaceFromFlags(
    { provider: "remote", agentServer: "https://a.example" },
    { [DEFAULT_AGENT_SERVER_KEY_ENV]: "s3cret-value" },
  );
  expect(config).toEqual({
    url: "https://a.example",
    apiKey: "s3cret-value",
    apiKeyEnv: DEFAULT_AGENT_SERVER_KEY_ENV,
    remoteRoot: "/workspace/mars",
    allowInsecureHttp: false,
  });
});

test("doctor reports isolation none with the explicit statement and never prints the key", async () => {
  const base = await mkdtemp(join(tmpdir(), "mars-remote-doctor-"));
  const fake = await startFakeAgentServer({
    workingDir: join(base, "remote"),
    apiKey: "doctor-key-value",
  });
  try {
    const unconfigured = await remoteWorkspaceDoctor({}, {});
    expect(unconfigured.configured).toBe(false);
    expect(unconfigured.statement).toBe(ISOLATION_STATEMENT);
    expect(unconfigured.live_verified).toBe(false);
    const env = { MARS_AGENT_SERVER_API_KEY: "doctor-key-value" };
    const report = await remoteWorkspaceDoctor(
      { agentServer: fake.url, remoteRoot: join(base, "remote") },
      env,
    );
    expect(report.error).toBeNull();
    expect(report.credential_present).toBe(true);
    expect(report.isolation?.os_isolation).toBe("none");
    expect(report.isolation?.transport).toBe("http-loopback");
    expect(JSON.stringify(report)).not.toContain("doctor-key-value");
    expect(fake.log.map((entry) => entry.route)).toEqual(["/server_info"]);
    fake.setVersion("0.1.0");
    const refused = await remoteWorkspaceDoctor({ agentServer: fake.url }, env);
    expect(refused.isolation).toBeNull();
    expect(refused.error).toContain("Unsupported Agent Server version");
  } finally {
    await fake.stop();
    await rm(base, { recursive: true, force: true });
  }
});
