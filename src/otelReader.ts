import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';

// node:sqlite is loaded via createRequire rather than a static `import`: the
// bundler (esbuild) strips the `node:` prefix from static imports it doesn't
// recognize, producing a bare `sqlite` specifier that Node can't resolve. A
// runtime require keeps the literal `node:sqlite` string intact in both the
// bundled output and when running the TS sources directly (e.g. under vitest).
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync: DatabaseSyncCtor } = nodeRequire('node:sqlite') as typeof import('node:sqlite');

// Upstream schema reference: see
// vscode-copilot-chat/src/platform/otel/node/sqlite/otelSqliteStore.ts
// The `spans` table denormalizes these OTel GenAI attributes into columns:
//   chat_session_id  (copilot_chat.chat_session_id)
//   request_model    (gen_ai.request.model)
//   input_tokens     (gen_ai.usage.input_tokens)
//   output_tokens    (gen_ai.usage.output_tokens)
//   cached_tokens    (gen_ai.usage.cache_read.input_tokens)
//   start_time_ms / end_time_ms / operation_name
// Cache-creation tokens are not denormalized — they live in `span_attributes`
// under key 'gen_ai.usage.cache_creation.input_tokens'. We LEFT JOIN so older
// spans that lack the attribute still appear (with cacheCreationTokens = 0).
// Filter `operation_name = 'chat'` matches upstream's GenAiOperationName.CHAT
// constant — the value used for billable LLM inferences.
//
// Unlike copilot-budget (a long-running extension that scopes spans to the
// active workspace's chat sessions), this is a one-shot CLI: we want EVERY
// chat span since midnight regardless of workspace, so there is no session
// filter — just the time boundary.
//
// Time-boundary filter uses `end_time_ms > sinceMs` (strict): OTel writers
// materialize a span row when the span ends (onEnd), so filtering by end_time
// matches the natural arrival order.
const OPERATION_NAME_CHAT = 'chat';
const ATTR_CACHE_CREATION = 'gen_ai.usage.cache_creation.input_tokens';

export interface PerModelAggregate {
  model: string | null;
  chats: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface Diagnostics {
  totalChatSpans: number;
  latestSpanMs: number;
  models: string[];
}

export interface OTelReader {
  isAvailable(): boolean;
  aggregateSince(sinceMs: number): PerModelAggregate[];
  getLatestTimestamp(): number;
  getDiagnostics(): Diagnostics;
  close(): void;
}

class OTelReaderImpl implements OTelReader {
  private readonly dbPath: string;
  private db: DatabaseSync | null = null;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  isAvailable(): boolean {
    if (!fs.existsSync(this.dbPath)) {
      return false;
    }
    // File existence alone is not proof of usability: Copilot Chat can leave
    // the file half-initialized (zero-byte placeholder, or schema present but
    // indexed tables not yet created). Probe BOTH tables aggregateSince()
    // depends on so isAvailable() reflects full queryability. On failure, drop
    // the cached handle so the next call retries once the DB finishes init.
    try {
      const db = this.ensureDb();
      if (!db) {
        return false;
      }
      db.prepare('SELECT 1 FROM spans LIMIT 1').get();
      db.prepare('SELECT 1 FROM span_attributes LIMIT 1').get();
      return true;
    } catch {
      this.close();
      return false;
    }
  }

  private ensureDb(): DatabaseSync | null {
    if (this.db) {
      return this.db;
    }
    if (!fs.existsSync(this.dbPath)) {
      return null;
    }
    const db = new DatabaseSyncCtor(this.dbPath, { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout = 3000');
    } catch {
      // non-fatal: connection still works, we just forgo the wait on a brief lock.
    }
    this.db = db;
    return this.db;
  }

  aggregateSince(sinceMs: number): PerModelAggregate[] {
    const db = this.ensureDb();
    if (!db) {
      return [];
    }

    const sql =
      'SELECT' +
      ' s.request_model AS model,' +
      ' COUNT(*) AS chats,' +
      ' COALESCE(SUM(s.input_tokens), 0) AS inputTokens,' +
      ' COALESCE(SUM(s.output_tokens), 0) AS outputTokens,' +
      ' COALESCE(SUM(s.cached_tokens), 0) AS cacheReadTokens,' +
      ' COALESCE(SUM(CAST(cc.value AS INTEGER)), 0) AS cacheCreationTokens' +
      ' FROM spans s' +
      ' LEFT JOIN span_attributes cc' +
      '  ON cc.span_id = s.span_id AND cc.key = ?' +
      ' WHERE s.operation_name = ?' +
      '   AND s.end_time_ms > ?' +
      ' GROUP BY s.request_model';

    const rows = db.prepare(sql).all(ATTR_CACHE_CREATION, OPERATION_NAME_CHAT, sinceMs) as Array<{
      model: string | null;
      chats: number | bigint | null;
      inputTokens: number | bigint | null;
      outputTokens: number | bigint | null;
      cacheReadTokens: number | bigint | null;
      cacheCreationTokens: number | bigint | null;
    }>;

    return rows.map((r) => ({
      model: r.model,
      chats: toFiniteInt(r.chats),
      inputTokens: toFiniteInt(r.inputTokens),
      outputTokens: toFiniteInt(r.outputTokens),
      cacheReadTokens: toFiniteInt(r.cacheReadTokens),
      cacheCreationTokens: toFiniteInt(r.cacheCreationTokens),
    }));
  }

  getLatestTimestamp(): number {
    const db = this.ensureDb();
    if (!db) {
      return 0;
    }
    const row = db.prepare('SELECT MAX(end_time_ms) AS maxTs FROM spans WHERE operation_name = ?').get(OPERATION_NAME_CHAT) as
      | { maxTs: number | bigint | null }
      | undefined;
    return toFiniteInt(row?.maxTs);
  }

  getDiagnostics(): Diagnostics {
    const db = this.ensureDb();
    if (!db) {
      return { totalChatSpans: 0, latestSpanMs: 0, models: [] };
    }
    const countRow = db.prepare('SELECT COUNT(*) AS c FROM spans WHERE operation_name = ?').get(OPERATION_NAME_CHAT) as
      | { c: number | bigint | null }
      | undefined;
    const modelRows = db
      .prepare(
        'SELECT DISTINCT request_model AS model FROM spans WHERE operation_name = ? AND request_model IS NOT NULL ORDER BY request_model',
      )
      .all(OPERATION_NAME_CHAT) as Array<{ model: string | null }>;
    return {
      totalChatSpans: toFiniteInt(countRow?.c),
      latestSpanMs: this.getLatestTimestamp(),
      models: modelRows.map((r) => r.model).filter((m): m is string => !!m),
    };
  }

  close(): void {
    if (!this.db) {
      return;
    }
    try {
      this.db.close();
    } catch {
      // idempotent — swallow double-close races
    }
    this.db = null;
  }
}

function toFiniteInt(value: number | bigint | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }
  const n = typeof value === 'bigint' ? Number(value) : value;
  return Number.isFinite(n) ? n : 0;
}

/** Construct a lazy OTelReader for the given agent-traces.db path. */
export function createOTelReader(dbPath: string): OTelReader {
  return new OTelReaderImpl(dbPath);
}
