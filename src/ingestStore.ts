import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { PerModelAggregate, RawChatSpan } from './otelReader';

// See otelReader.ts for why node:sqlite is loaded via createRequire.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync: DatabaseSyncCtor } = nodeRequire('node:sqlite') as typeof import('node:sqlite');

// Why this store exists: agent-traces.db is NOT a cumulative ledger. Copilot
// prunes spans per *conversation* — deleting/clearing/archiving a chat, or
// crossing the chat-history cap, drops all of that conversation's spans (and a
// window reload reconciles them away in one sweep). So a live read of the
// source is only ever a LOWER BOUND for "today". This store mirrors chat spans
// into our own append-only DB, keyed by the source's span_id primary key, so a
// span we have ever seen survives even after Copilot drops it. Ingest is
// idempotent (UPSERT): re-seeing a span refreshes its token columns (in case
// attributes such as cache-creation arrive after the row) but never duplicates
// or loses it.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS chat_spans (
     span_id TEXT PRIMARY KEY,
     model TEXT,
     start_time_ms INTEGER,
     end_time_ms INTEGER,
     input_tokens INTEGER NOT NULL DEFAULT 0,
     output_tokens INTEGER NOT NULL DEFAULT 0,
     cache_read_tokens INTEGER NOT NULL DEFAULT 0,
     cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
     usage_nano_aiu INTEGER,
     chat_session_id TEXT,
     conversation_id TEXT,
     first_seen_ms INTEGER NOT NULL,
     last_seen_ms INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_spans_end ON chat_spans(end_time_ms)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_spans_model ON chat_spans(model)`,
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`,
];

const UPSERT_SQL =
  'INSERT INTO chat_spans' +
  ' (span_id, model, start_time_ms, end_time_ms, input_tokens, output_tokens,' +
  '  cache_read_tokens, cache_creation_tokens, usage_nano_aiu, chat_session_id,' +
  '  conversation_id, first_seen_ms, last_seen_ms)' +
  ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)' +
  ' ON CONFLICT(span_id) DO UPDATE SET' +
  '  model = excluded.model,' +
  '  start_time_ms = excluded.start_time_ms,' +
  '  end_time_ms = excluded.end_time_ms,' +
  '  input_tokens = excluded.input_tokens,' +
  '  output_tokens = excluded.output_tokens,' +
  '  cache_read_tokens = excluded.cache_read_tokens,' +
  '  cache_creation_tokens = excluded.cache_creation_tokens,' +
  // COALESCE keeps a previously-captured AIU if a later read lacks it (e.g. the
  // attribute hadn't been written yet), but lets a real value fill in a null.
  '  usage_nano_aiu = COALESCE(excluded.usage_nano_aiu, chat_spans.usage_nano_aiu),' +
  '  chat_session_id = excluded.chat_session_id,' +
  '  conversation_id = excluded.conversation_id,' +
  '  last_seen_ms = excluded.last_seen_ms';

export interface IngestResult {
  seen: number;
  inserted: number;
}

export interface UsageStore {
  ingest(spans: RawChatSpan[], nowMs: number): IngestResult;
  aggregateSince(sinceMs: number): PerModelAggregate[];
  earliestEndSince(sinceMs: number): number;
  totalRows(): number;
  /** Epoch ms of the last ingest (0 if never) — for doctor/coverage recency. */
  lastIngestMs(): number;
  readonly path: string;
  close(): void;
}

/** Resolve where our durable store lives (override → env → ~/.copilot-price). */
export function resolveStorePath(override?: string): string {
  const explicit = override ?? process.env.COPILOT_PRICE_STORE;
  if (explicit) {
    return explicit;
  }
  const home = process.env.COPILOT_PRICE_HOME ?? path.join(os.homedir(), '.copilot-price');
  return path.join(home, 'usage.db');
}

class UsageStoreImpl implements UsageStore {
  readonly path: string;
  private db: DatabaseSync;

  constructor(storePath: string) {
    this.path = storePath;
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    this.db = new DatabaseSyncCtor(storePath);
    try {
      // WAL + a generous busy_timeout is the whole concurrency story: a
      // scheduled `--ingest-only` can overlap a manual run, but WAL allows one
      // writer at a time and busy_timeout makes the loser wait rather than
      // throw. Transactions here are tiny, so the wait is brief.
      this.db.exec('PRAGMA busy_timeout = 5000');
      this.db.exec('PRAGMA journal_mode = WAL');
    } catch {
      // non-fatal; defaults still work
    }
    for (const stmt of SCHEMA) {
      this.db.exec(stmt);
    }
    this.migrate();
  }

  /** Additive migrations for stores created by an earlier version. */
  private migrate(): void {
    const cols = (this.db.prepare('PRAGMA table_info(chat_spans)').all() as Array<{ name: string }>).map((c) => c.name);
    if (!cols.includes('usage_nano_aiu')) {
      this.db.exec('ALTER TABLE chat_spans ADD COLUMN usage_nano_aiu INTEGER');
    }
  }

  ingest(spans: RawChatSpan[], nowMs: number): IngestResult {
    const before = this.totalRows();
    if (spans.length > 0) {
      const stmt = this.db.prepare(UPSERT_SQL);
      this.db.exec('BEGIN');
      try {
        for (const s of spans) {
          stmt.run(
            s.spanId,
            s.model,
            s.startTimeMs,
            s.endTimeMs,
            s.inputTokens,
            s.outputTokens,
            s.cacheReadTokens,
            s.cacheCreationTokens,
            s.usageNanoAiu,
            s.chatSessionId,
            s.conversationId,
            nowMs,
            nowMs,
          );
        }
        this.db.exec('COMMIT');
      } catch (err) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          // ignore
        }
        throw err;
      }
    }
    // Record recency even on a no-op ingest, so doctor can show "last capture".
    this.setMeta('last_ingest_ms', String(nowMs));
    return { seen: spans.length, inserted: this.totalRows() - before };
  }

  private setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  private getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  lastIngestMs(): number {
    const v = this.getMeta('last_ingest_ms');
    return v ? toInt(Number(v)) : 0;
  }

  aggregateSince(sinceMs: number): PerModelAggregate[] {
    const rows = this.db
      .prepare(
        'SELECT model,' +
          ' COUNT(*) AS chats,' +
          ' COALESCE(SUM(input_tokens), 0) AS inputTokens,' +
          ' COALESCE(SUM(output_tokens), 0) AS outputTokens,' +
          ' COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,' +
          ' COALESCE(SUM(cache_creation_tokens), 0) AS cacheCreationTokens,' +
          ' COALESCE(SUM(usage_nano_aiu), 0) AS meteredNano,' +
          ' SUM(CASE WHEN usage_nano_aiu IS NOT NULL THEN 1 ELSE 0 END) AS meteredChats,' +
          ' COALESCE(SUM(CASE WHEN usage_nano_aiu IS NULL THEN input_tokens END), 0) AS unmeteredInputTokens,' +
          ' COALESCE(SUM(CASE WHEN usage_nano_aiu IS NULL THEN output_tokens END), 0) AS unmeteredOutputTokens,' +
          ' COALESCE(SUM(CASE WHEN usage_nano_aiu IS NULL THEN cache_read_tokens END), 0) AS unmeteredCacheReadTokens,' +
          ' COALESCE(SUM(CASE WHEN usage_nano_aiu IS NULL THEN cache_creation_tokens END), 0) AS unmeteredCacheCreationTokens' +
          ' FROM chat_spans WHERE end_time_ms > ? GROUP BY model',
      )
      .all(sinceMs) as Array<{
      model: string | null;
      chats: number | bigint | null;
      inputTokens: number | bigint | null;
      outputTokens: number | bigint | null;
      cacheReadTokens: number | bigint | null;
      cacheCreationTokens: number | bigint | null;
      meteredNano: number | bigint | null;
      meteredChats: number | bigint | null;
      unmeteredInputTokens: number | bigint | null;
      unmeteredOutputTokens: number | bigint | null;
      unmeteredCacheReadTokens: number | bigint | null;
      unmeteredCacheCreationTokens: number | bigint | null;
    }>;

    return rows.map((r) => ({
      model: r.model,
      chats: toInt(r.chats),
      inputTokens: toInt(r.inputTokens),
      outputTokens: toInt(r.outputTokens),
      cacheReadTokens: toInt(r.cacheReadTokens),
      cacheCreationTokens: toInt(r.cacheCreationTokens),
      meteredAiu: toInt(r.meteredNano) / 1e9,
      meteredChats: toInt(r.meteredChats),
      unmeteredInputTokens: toInt(r.unmeteredInputTokens),
      unmeteredOutputTokens: toInt(r.unmeteredOutputTokens),
      unmeteredCacheReadTokens: toInt(r.unmeteredCacheReadTokens),
      unmeteredCacheCreationTokens: toInt(r.unmeteredCacheCreationTokens),
    }));
  }

  earliestEndSince(sinceMs: number): number {
    const row = this.db.prepare('SELECT MIN(end_time_ms) AS minTs FROM chat_spans WHERE end_time_ms > ?').get(sinceMs) as
      | { minTs: number | bigint | null }
      | undefined;
    return toInt(row?.minTs);
  }

  totalRows(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM chat_spans').get() as { c: number | bigint | null } | undefined;
    return toInt(row?.c);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // idempotent
    }
  }
}

function toInt(value: number | bigint | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }
  const n = typeof value === 'bigint' ? Number(value) : value;
  return Number.isFinite(n) ? n : 0;
}

/** Open (creating if needed) the durable usage store at the given path. */
export function openUsageStore(storePath: string): UsageStore {
  return new UsageStoreImpl(storePath);
}
