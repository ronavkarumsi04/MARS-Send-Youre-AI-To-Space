import { expect, test } from "bun:test";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createFileArtifactStore, loadSpecialistTrust } from "../src/index";
import { context, createTempRoot, removeTempRoot } from "./helpers";

test("concurrent artifact puts never expose partial bytes to readers", async () => {
  const root = await createTempRoot();
  try {
    const store = createFileArtifactStore(join(root, "artifacts"));
    const bytes = new Uint8Array(1024 * 1024).fill(42);
    const ref = await store.put(context, bytes, "application/octet-stream");
    const before = await stat(join(root, "artifacts", ref.sha256), {
      bigint: true,
    });
    const results = await Promise.allSettled([
      ...Array.from({ length: 4 }, async () => {
        for (let i = 0; i < 8; i++)
          await store.put(context, bytes, ref.media_type);
      }),
      ...Array.from({ length: 4 }, async () => {
        for (let i = 0; i < 8; i++)
          expect(await store.get(context, ref)).toEqual(Buffer.from(bytes));
      }),
    ]);
    expect(results.filter((result) => result.status === "rejected")).toEqual(
      [],
    );
    const after = await stat(join(root, "artifacts", ref.sha256), {
      bigint: true,
    });
    expect(after.mtimeNs).toBe(before.mtimeNs);
  } finally {
    await removeTempRoot(root);
  }
});

test("file artifacts round trip, restrict permissions and reject corruption and invalid refs", async () => {
  const root = await createTempRoot();
  try {
    const dir = join(root, "artifacts");
    const store = createFileArtifactStore(dir);
    for (const bytes of [
      new Uint8Array(),
      new TextEncoder().encode("artifact"),
    ]) {
      const ref = await store.put(context, bytes, "application/octet-stream");
      expect(await store.get(context, ref)).toEqual(Buffer.from(bytes));
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
      expect((await stat(join(dir, ref.sha256))).mode & 0o777).toBe(0o600);
      await expect(
        store.get(context, { ...ref, byte_length: ref.byte_length + 1 }),
      ).rejects.toThrow();
      await writeFile(join(dir, ref.sha256), "corrupt");
      await expect(store.get(context, ref)).rejects.toThrow();
      expect(await store.put(context, bytes, ref.media_type)).toEqual(ref);
      expect(await store.get(context, ref)).toEqual(Buffer.from(bytes));
      expect((await stat(join(dir, ref.sha256))).mode & 0o777).toBe(0o600);
      expect((await readdir(dir)).some((file) => file.endsWith(".tmp"))).toBe(
        false,
      );
      await expect(
        store.get(context, { ...ref, sha256: "../escape" }),
      ).rejects.toThrow();
    }
  } finally {
    await removeTempRoot(root);
  }
});

test("strict trust files resolve UTF-8 secrets without exposing invalid input", async () => {
  const root = await createTempRoot();
  try {
    const file = join(root, "trust.json");
    const authority = {
      key_id: "key",
      authority_id: "authority",
      secret_env: "SIGNING_SECRET",
      owner_ids: ["owner"],
      evaluator_ids: ["eval"],
    };
    await writeFile(
      file,
      JSON.stringify({
        schema: "mars.specialist-trust/v1",
        authorities: [authority],
      }),
    );
    const trust = await loadSpecialistTrust(file, { SIGNING_SECRET: "secret" });
    expect(trust.authorities[0]?.secret).toEqual(
      new TextEncoder().encode("secret"),
    );
    for (const env of [{}, { SIGNING_SECRET: "" }, { SIGNING_SECRET: " " }])
      await expect(loadSpecialistTrust(file, env)).rejects.toThrow(
        "trust_invalid",
      );
    const raw = JSON.parse(await readFile(file, "utf8"));
    for (const value of [
      { ...raw, extra: "secret" },
      { ...raw, authorities: [] },
      { ...raw, authorities: [authority, authority] },
    ]) {
      await writeFile(file, JSON.stringify(value));
      await expect(
        loadSpecialistTrust(file, { SIGNING_SECRET: "secret" }),
      ).rejects.toThrow("trust_invalid");
    }
  } finally {
    await removeTempRoot(root);
  }
});
