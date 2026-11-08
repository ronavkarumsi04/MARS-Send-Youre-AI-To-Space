import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeOmniRoute } from "@mars/providers-omniroute";
import { ServeUsageError } from "./cli-errors";
import { omnirouteDoctorReport, omnirouteFromFlags } from "./omniroute";

describe("mars serve --omniroute flags", () => {
  test("absent flag yields no OmniRoute options and rejects dependent flags", () => {
    expect(omnirouteFromFlags({})).toBeUndefined();
    expect(
      omnirouteFromFlags({ enabled: false, start: false }),
    ).toBeUndefined();
    for (const flags of [
      { url: "http://localhost:20128" },
      { start: true },
      { allow: ["caution"] },
    ])
      expect(() => omnirouteFromFlags(flags)).toThrow(ServeUsageError);
  });

  test("defaults to loopback attach with every exclusion on", () => {
    expect(omnirouteFromFlags({ enabled: true })).toEqual({
      url: "http://localhost:20128",
    });
    expect(
      omnirouteFromFlags({
        enabled: true,
        url: "http://127.0.0.1:20128/v1",
        start: true,
        allow: ["web-session", "caution", "unknown"],
      }),
    ).toEqual({
      url: "http://127.0.0.1:20128/v1",
      start: true,
      overrides: {
        allowWebSession: true,
        allowTermsRisk: ["caution", "unknown"],
      },
    });
  });

  test("rejects bad URLs, cleartext remote URLs and the avoid verdict", () => {
    expect(() =>
      omnirouteFromFlags({ enabled: true, url: "localhost:20128" }),
    ).toThrow(ServeUsageError);
    expect(() =>
      omnirouteFromFlags({
        enabled: true,
        url: "http://gateway.example:20128",
      }),
    ).toThrow(/https/);
    expect(
      omnirouteFromFlags({ enabled: true, url: "https://gateway.example" }),
    ).toEqual({ url: "https://gateway.example" });
    expect(() =>
      omnirouteFromFlags({ enabled: true, url: "ftp://localhost:20128" }),
    ).toThrow(ServeUsageError);
    expect(() =>
      omnirouteFromFlags({ enabled: true, allow: ["avoid"] }),
    ).toThrow(/avoid can never be allowed/);
  });
});

describe("mars doctor omniroute section", () => {
  test("reports reachability and catalog health as booleans, counts and ages without secrets", async () => {
    const fake = await startFakeOmniRoute({
      apiKey: "gateway-secret",
      models: [{ id: "goodapi/clean-1", tool_calling: true }],
    });
    try {
      const env = { OMNIROUTE_API_KEY: "gateway-secret" };
      const report = await omnirouteDoctorReport({
        url: fake.url,
        env,
        now: new Date("2026-11-02T00:00:00Z"),
      });
      expect(report.gateway).toMatchObject({
        reachable: true,
        models_endpoint: true,
        authorized: true,
        model_count: 1,
        api_key_env_present: true,
      });
      expect(report.catalog).toMatchObject({
        present: true,
        release: "v3.8.52",
        revision_pinned: true,
        stale: false,
        age_days: 14,
      });
      expect(report.catalog.entries?.routable).toBeGreaterThan(0);
      expect(report.catalog).not.toHaveProperty("load_error");
      expect(report).toMatchObject({
        mcp_a2a_used: false,
        live_verified: false,
      });
      expect(JSON.stringify(report)).not.toContain("gateway-secret");
      expect(fake.requests.map((request) => request.path)).toEqual([
        "/v1/models",
      ]);
      const down = await omnirouteDoctorReport({
        url: "http://127.0.0.1:1",
        env: {},
      });
      expect(down.gateway).toMatchObject({
        reachable: false,
        authorized: null,
        api_key_env_present: false,
      });
      const missingCatalog = await omnirouteDoctorReport({
        url: "http://127.0.0.1:1",
        env: {},
        catalogPath: "/nonexistent/catalog.json",
      });
      expect(missingCatalog.catalog).toMatchObject({
        present: false,
        stale: true,
        load_error: "missing",
      });
    } finally {
      await fake.stop();
    }
  });

  test("separates an invalid catalog from a missing one without echoing its content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mars-omniroute-doctor-"));
    try {
      const cases = [
        ["not-json.json", "{ secret-ish content"],
        ["bad-schema.json", JSON.stringify({ source: "secret-ish content" })],
      ] as const;
      for (const [name, content] of cases) {
        const catalogPath = join(dir, name);
        await writeFile(catalogPath, content);
        const report = await omnirouteDoctorReport({
          url: "http://127.0.0.1:1",
          env: {},
          catalogPath,
        });
        expect(report.catalog).toMatchObject({
          present: false,
          stale: true,
          entries: null,
          load_error: "invalid",
        });
        const serialized = JSON.stringify(report);
        expect(serialized).not.toContain("secret-ish");
        expect(serialized).not.toContain(dir);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
