export const TEAM_STORE_FORMAT_VERSION = 1;

/**
 * Forward-only, ordered migration ledger. This is the first migration
 * mechanism in the repository and it is private to this store: the other
 * SQLite stores keep rejecting foreign format versions. Append new entries,
 * never edit or reorder applied ones; a ledger that names an id this code does
 * not know (written by newer code) or in a different order is rejected.
 */
export const TEAM_MIGRATIONS: ReadonlyArray<{ id: string; sql: string }> = [
  {
    id: "0001_initial",
    sql: `
      CREATE TABLE members (
        team_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'removed')),
        revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (team_id, user_id)
      );
      CREATE TABLE conversations (
        conversation_id TEXT PRIMARY KEY, team_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('dm', 'group')),
        title TEXT, dm_key TEXT, revision INTEGER NOT NULL, last_seq INTEGER NOT NULL,
        last_event_seq INTEGER NOT NULL, created_by TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX conversations_team_dm ON conversations(team_id, dm_key) WHERE kind = 'dm';
      CREATE INDEX conversations_team ON conversations(team_id);
      CREATE TABLE participants (
        conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
        user_id TEXT NOT NULL, joined_seq INTEGER NOT NULL, joined_event_seq INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'removed')),
        pinned INTEGER NOT NULL, read_seq INTEGER NOT NULL,
        PRIMARY KEY (conversation_id, user_id)
      );
      CREATE INDEX participants_user ON participants(user_id, state);
      CREATE TABLE messages (
        message_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
        seq INTEGER NOT NULL, author_id TEXT NOT NULL, client_message_id TEXT NOT NULL,
        body TEXT NOT NULL, body_sha256 TEXT NOT NULL, reply_to TEXT,
        reference_ids_json TEXT NOT NULL, created_at TEXT NOT NULL, edited_at TEXT,
        deleted INTEGER NOT NULL, record_sha256 TEXT NOT NULL,
        UNIQUE (conversation_id, seq),
        UNIQUE (conversation_id, author_id, client_message_id)
      );
      CREATE TABLE reactions (
        message_id TEXT NOT NULL REFERENCES messages(message_id),
        user_id TEXT NOT NULL, emoji TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (message_id, user_id, emoji)
      );
      CREATE TABLE outbox (
        conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
        event_seq INTEGER NOT NULL, kind TEXT NOT NULL, message_seq INTEGER NOT NULL,
        message_id TEXT, revision INTEGER NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (conversation_id, event_seq)
      );
      CREATE TABLE idempotency (
        team_id TEXT NOT NULL, user_id TEXT NOT NULL, request_id TEXT NOT NULL,
        operation TEXT NOT NULL, input_sha256 TEXT NOT NULL, result_json TEXT NOT NULL,
        created_seq INTEGER NOT NULL,
        PRIMARY KEY (team_id, user_id, request_id, operation, input_sha256)
      );
      CREATE INDEX idempotency_owner ON idempotency(team_id, user_id, created_seq);
    `,
  },
  {
    // Team Chat PR 6: chat-side task links and result cards. Workbench ids are
    // opaque here; `provenance_json` is frozen at draft time and never rewritten.
    id: "0002_task_links",
    sql: `
      CREATE TABLE task_links (
        link_id TEXT PRIMARY KEY, team_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
        requester_id TEXT NOT NULL, launch_key TEXT NOT NULL,
        provenance_json TEXT NOT NULL, reference_ids_json TEXT NOT NULL,
        target_json TEXT, workbench_json TEXT, task_revision INTEGER,
        status TEXT NOT NULL CHECK (status IN ('draft', 'confirmed', 'created', 'shared', 'abandoned')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, record_sha256 TEXT NOT NULL,
        UNIQUE (team_id, launch_key)
      );
      CREATE INDEX task_links_conversation ON task_links(conversation_id);
      CREATE TABLE result_shares (
        share_id TEXT PRIMARY KEY,
        link_id TEXT NOT NULL REFERENCES task_links(link_id),
        message_id TEXT NOT NULL UNIQUE REFERENCES messages(message_id),
        message_seq INTEGER NOT NULL, preview_sha256 TEXT NOT NULL,
        candidate_diff_sha256 TEXT NOT NULL, evidence_sha256 TEXT NOT NULL,
        card_json TEXT NOT NULL, created_at TEXT NOT NULL, record_sha256 TEXT NOT NULL
      );
      CREATE INDEX result_shares_link ON result_shares(link_id, message_seq);
    `,
  },
  {
    // Repo access + committed code references (Team Chat PR 4; after PR 6's 0002_task_links). `repo_id` is
    // the opaque id the host registered in the @mars/code-refs registry; no
    // filesystem path is stored. `references` is an SQL keyword, hence
    // `code_references`. Postgres-portable types only.
    id: "0003_references",
    sql: `
      CREATE TABLE repos (
        team_id TEXT NOT NULL, repo_id TEXT NOT NULL, label TEXT NOT NULL,
        revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (team_id, repo_id)
      );
      CREATE TABLE repo_access (
        team_id TEXT NOT NULL, repo_id TEXT NOT NULL, user_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'removed')),
        revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (team_id, repo_id, user_id),
        FOREIGN KEY (team_id, repo_id) REFERENCES repos(team_id, repo_id)
      );
      CREATE INDEX repo_access_user ON repo_access(team_id, user_id, state);
      CREATE TABLE code_references (
        team_id TEXT NOT NULL, reference_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('git_range')),
        repo_id TEXT NOT NULL, commit_sha TEXT NOT NULL, path TEXT NOT NULL,
        line_start INTEGER, line_end INTEGER, blob_sha256 TEXT,
        resolved_state TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
        record_sha256 TEXT NOT NULL,
        PRIMARY KEY (team_id, reference_id)
      );
      CREATE INDEX code_references_repo ON code_references(team_id, repo_id);
      CREATE TABLE message_references (
        message_id TEXT NOT NULL REFERENCES messages(message_id),
        team_id TEXT NOT NULL, reference_id TEXT NOT NULL, position INTEGER NOT NULL,
        PRIMARY KEY (message_id, reference_id),
        FOREIGN KEY (team_id, reference_id) REFERENCES code_references(team_id, reference_id)
      );
      CREATE INDEX message_references_reference ON message_references(team_id, reference_id);
    `,
  },
  {
    id: "0004_agent_requests",
    sql: `
      ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'user' CHECK (kind IN ('user', 'agent', 'result_card'));
      ALTER TABLE messages ADD COLUMN agent_request_id TEXT;
      UPDATE messages SET kind = 'result_card' WHERE message_id IN (SELECT message_id FROM result_shares);
      CREATE TABLE agent_requests (
        request_id TEXT PRIMARY KEY, team_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
        requester_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, params_sha256 TEXT NOT NULL,
        anchor_seq INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled', 'restricted')),
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        input_json TEXT NOT NULL, input_sha256 TEXT NOT NULL,
        record_json TEXT NOT NULL, record_sha256 TEXT NOT NULL,
        answer_body TEXT, created_seq INTEGER NOT NULL,
        UNIQUE (team_id, requester_id, idempotency_key)
      );
      CREATE INDEX agent_requests_queue ON agent_requests(status, created_seq);
      CREATE INDEX agent_requests_conversation ON agent_requests(conversation_id, created_seq);
    `,
  },
  {
    // Team Chat PR 7: durable redacted counters (`TEAM_METRIC_COUNTERS` names
    // only, integer values) so `mars team stats` in another process reads
    // what the serving process counted. The `team.enabled` kill switch lives
    // in `meta` and needs no table.
    id: "0005_metrics",
    sql: `
      CREATE TABLE metrics (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
    `,
  },
];
