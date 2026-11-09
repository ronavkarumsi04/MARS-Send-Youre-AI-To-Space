import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isInsideOrEqual } from "@mars/contracts/path-containment";
import { z } from "zod";
import { canonicalJSON, sha256 } from "./canonical";
import { fail, IntegrationTrustError } from "./errors";
import type { AuditEvent, AuditEventInput, TrustState } from "./schemas";
import {
  AuditEventInputSchema,
  AuditEventSchema,
  DigestSchema,
  RevisionSchema,
  TrustStateSchema,
} from "./schemas";

const StoredRecordSchema = z
  .object({
    revision: RevisionSchema,
    state: TrustStateSchema,
    last_audit_sha256: DigestSchema,
    state_sha256: DigestSchema,
  })
  .strict();
const STALE_LOCK_MS = 30000,
  LOCK_WAIT_MS = 2000,
  LOCK_POLL_MS = 20;
export interface TrustStore {
  load(): Promise<{ revision: number; state: TrustState }>;
  commit(
    expectedRevision: number,
    next: TrustState,
    events: AuditEventInput[],
  ): Promise<number>;
}
export function emptyState(): TrustState {
  return { reviews: [], grants: [], consumed_nonces: [], events: [] };
}
function append(state: TrustState, events: AuditEventInput[]): TrustState {
  const next = structuredClone(state);
  for (const input of events) {
    const parsed = AuditEventInputSchema.safeParse(input);
    if (!parsed.success) fail("store_corrupt");
    const event = {
      ...parsed.data,
      seq: next.events.length + 1,
      event_id: randomUUID(),
      prev_sha256: next.events.at(-1)?.sha256 ?? "0".repeat(64),
    };
    next.events.push({ ...event, sha256: sha256(canonicalJSON(event)) });
  }
  return next;
}
function verify(events: AuditEvent[]) {
  let previous = "0".repeat(64);
  for (const [index, event] of events.entries()) {
    const { sha256: hash, ...rest } = event;
    if (
      event.seq !== index + 1 ||
      event.prev_sha256 !== previous ||
      hash !== sha256(canonicalJSON(rest))
    )
      fail("store_corrupt");
    previous = hash;
  }
  return previous;
}
export class MemoryTrustStore implements TrustStore {
  private revision = 0;
  private state = emptyState();
  async load() {
    return { revision: this.revision, state: structuredClone(this.state) };
  }
  async commit(
    expectedRevision: number,
    next: TrustState,
    events: AuditEventInput[],
  ) {
    if (expectedRevision !== this.revision) fail("revision_conflict");
    if (canonicalJSON(next.events) !== canonicalJSON(this.state.events))
      fail("store_corrupt");
    this.state = append(next, events);
    return ++this.revision;
  }
}
async function resolved(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    const parent = dirname(path);
    if (parent === path) throw e;
    return join(await resolved(parent), path.slice(parent.length));
  }
}
export class FileTrustStore implements TrustStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly options: { directory: string; workspaceRoots: string[] },
  ) {}
  private async init() {
    const { directory, workspaceRoots } = this.options;
    if (!isAbsolute(directory)) fail("store_location_unsafe");
    const dir = await resolved(directory);
    for (const root of workspaceRoots) {
      const r = await realpath(root);
      if (isInsideOrEqual(r, dir) || isInsideOrEqual(dir, r))
        fail("store_location_unsafe");
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await this.mode(directory, 0o700);
  }
  private async mode(path: string, mode: number) {
    const s = await stat(path);
    if (
      process.platform !== "win32" &&
      ((s.mode & 0o777) !== mode || s.uid !== process.getuid?.())
    )
      fail("store_location_unsafe");
    if ((await realpath(path)) !== resolve(path)) fail("store_location_unsafe");
  }
  private async read() {
    try {
      const path = join(this.options.directory, "state.json"),
        audit = join(this.options.directory, "audit.jsonl");
      let raw: string;
      try {
        raw = await readFile(path, "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        try {
          await this.mode(audit, 0o600);
        } catch (a) {
          if ((a as NodeJS.ErrnoException).code !== "ENOENT") throw a;
        }
        return { revision: 0, state: emptyState() };
      }
      await this.mode(path, 0o600);
      await this.mode(audit, 0o600);
      const parsed = StoredRecordSchema.safeParse(JSON.parse(raw)),
        lines = await readFile(audit, "utf8");
      if (!parsed.success) fail("store_corrupt");
      const record = parsed.data;
      const events = lines
        .split("\n")
        .slice(0, record.state.events.length)
        .map((line) => {
          const event = AuditEventSchema.safeParse(JSON.parse(line));
          if (!event.success) fail("store_corrupt");
          return event.data;
        });
      if (
        record.last_audit_sha256 !== verify(events) ||
        record.state_sha256 !== sha256(canonicalJSON(record.state)) ||
        canonicalJSON(record.state.events) !== canonicalJSON(events)
      )
        fail("store_corrupt");
      return { revision: record.revision, state: record.state };
    } catch (e) {
      if (e instanceof IntegrationTrustError) throw e;
      fail("store_corrupt", e);
    }
  }
  async load() {
    await this.init();
    return this.read();
  }
  async commit(
    expectedRevision: number,
    next: TrustState,
    events: AuditEventInput[],
  ): Promise<number> {
    const operation = this.queue.then(async () => {
      await this.init();
      const lock = join(this.options.directory, "lock");
      const start = Date.now();
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      while (!handle) {
        try {
          handle = await open(lock, "wx", 0o600);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST")
            fail("store_corrupt", e);
          try {
            if (Date.now() - (await stat(lock)).mtimeMs > STALE_LOCK_MS)
              await unlink(lock);
          } catch {}
          if (Date.now() - start > LOCK_WAIT_MS) fail("revision_conflict", e);
          await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
        }
      }
      try {
        const current = await this.read();
        if (current.revision !== expectedRevision) fail("revision_conflict");
        if (canonicalJSON(current.state.events) !== canonicalJSON(next.events))
          fail("store_corrupt");
        const state = append(next, events),
          revision = expectedRevision + 1;
        const auditTmp = join(this.options.directory, `${randomUUID()}.tmp`);
        const audit = await open(auditTmp, "wx", 0o600);
        try {
          await audit.writeFile(
            state.events.map((e) => `${canonicalJSON(e)}\n`).join(""),
          );
          await audit.sync();
        } finally {
          await audit.close();
        }
        try {
          await rename(auditTmp, join(this.options.directory, "audit.jsonl"));
        } finally {
          await unlink(auditTmp).catch(() => undefined);
        }
        const directory = await open(this.options.directory, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
        const tmp = join(this.options.directory, `${randomUUID()}.tmp`),
          file = await open(tmp, "wx", 0o600);
        try {
          await file.writeFile(
            canonicalJSON({
              revision,
              state,
              last_audit_sha256: verify(state.events),
              state_sha256: sha256(canonicalJSON(state)),
            }),
          );
          await file.sync();
        } finally {
          await file.close();
        }
        try {
          await rename(tmp, join(this.options.directory, "state.json"));
        } finally {
          await unlink(tmp).catch(() => undefined);
        }
        return revision;
      } finally {
        await handle.close();
        await unlink(lock);
      }
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
}
