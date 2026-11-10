import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ArtifactRef, RequestContext } from "@mars/contracts";
import { ArtifactRefSchema } from "@mars/contracts";
import { scopeKey, sha256 } from "./canonical";
import { TrainingError } from "./errors";
import { type JobRecord, JobRecordSchema } from "./schemas";

/** Content-addressed artifact storage; the host may inject its own (e.g. the optimization store). */
export interface ArtifactStore {
  put(
    context: RequestContext,
    bytes: Uint8Array,
    mediaType: string,
  ): Promise<ArtifactRef>;
  get(context: RequestContext, ref: ArtifactRef): Promise<Uint8Array>;
  /** Bytes stored under `digest` in this scope, or null. Used to resolve manifest datasets. */
  getByDigest?(
    context: RequestContext,
    digest: string,
  ): Promise<Uint8Array | null>;
}

export function artifactRefFor(
  bytes: Uint8Array,
  mediaType: string,
): ArtifactRef {
  const digest = sha256(bytes);
  return {
    artifact_id: `art-${digest.slice(0, 32)}`,
    sha256: digest,
    media_type: mediaType,
    byte_length: bytes.byteLength,
  };
}

function verify(ref: ArtifactRef, bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength !== ref.byte_length || sha256(bytes) !== ref.sha256) {
    throw new TrainingError("artifact_digest_mismatch", ref.artifact_id);
  }
  return bytes;
}

export function createMemoryArtifactStore(): ArtifactStore & {
  readonly items: Map<string, Uint8Array>;
} {
  const items = new Map<string, Uint8Array>();
  const key = (context: RequestContext, digest: string) =>
    `${scopeKey(context.scope)}/${digest}`;
  return {
    items,
    async put(context, bytes, mediaType) {
      const ref = artifactRefFor(bytes, mediaType);
      items.set(key(context, ref.sha256), Uint8Array.from(bytes));
      return ref;
    },
    async get(context, ref) {
      const bytes = items.get(key(context, ref.sha256));
      if (!bytes) throw new TrainingError("artifact_missing", ref.artifact_id);
      return verify(ref, Uint8Array.from(bytes));
    },
    async getByDigest(context, digest) {
      const bytes = items.get(key(context, digest));
      return bytes ? Uint8Array.from(bytes) : null;
    },
  };
}

export function createFileArtifactStore(rootDir: string): ArtifactStore {
  const dirFor = (context: RequestContext) =>
    path.join(rootDir, scopeKey(context.scope), "artifacts");
  const read = async (context: RequestContext, digest: string) => {
    if (!/^[a-f0-9]{64}$/.test(digest)) return null;
    try {
      return new Uint8Array(
        await readFile(path.join(dirFor(context), `${digest}.bin`)),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  return {
    async put(context, bytes, mediaType) {
      const ref = artifactRefFor(bytes, mediaType);
      const dir = dirFor(context);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeAtomic(path.join(dir, `${ref.sha256}.bin`), bytes);
      return ref;
    },
    async get(context, ref) {
      ArtifactRefSchema.parse(ref);
      const bytes = await read(context, ref.sha256);
      if (!bytes) throw new TrainingError("artifact_missing", ref.artifact_id);
      return verify(ref, bytes);
    },
    getByDigest: read,
  };
}

export interface JobStore {
  get(scope: string, jobId: string): Promise<JobRecord | null>;
  put(record: JobRecord): Promise<void>;
}

export function createMemoryJobStore(): JobStore {
  const records = new Map<string, string>();
  return {
    async get(scope, jobId) {
      const text = records.get(`${scope}/${jobId}`);
      return text ? JobRecordSchema.parse(JSON.parse(text)) : null;
    },
    async put(record) {
      records.set(
        `${record.scope_key}/${record.job_id}`,
        JSON.stringify(JobRecordSchema.parse(record)),
      );
    },
  };
}

export function createFileJobStore(rootDir: string): JobStore {
  const fileFor = (scope: string, jobId: string) => {
    if (
      !/^[a-f0-9]{32}$/.test(scope) ||
      !/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(jobId)
    ) {
      throw new TrainingError("invalid_input", "job id");
    }
    return path.join(rootDir, scope, "jobs", `${jobId}.json`);
  };
  return {
    async get(scope, jobId) {
      let text: string;
      try {
        text = await readFile(fileFor(scope, jobId), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      const parsed = JobRecordSchema.safeParse(JSON.parse(text));
      if (!parsed.success) throw new TrainingError("record_malformed", jobId);
      return parsed.data;
    },
    async put(record) {
      const file = fileFor(record.scope_key, record.job_id);
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await writeAtomic(
        file,
        `${JSON.stringify(JobRecordSchema.parse(record), null, 2)}\n`,
      );
    },
  };
}

async function writeAtomic(
  file: string,
  data: Uint8Array | string,
): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, data, { flag: "wx", mode: 0o600 });
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}
