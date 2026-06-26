import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOTelReader } from './otelReader';

const MIDNIGHT = 1_780_000_000_000; // arbitrary fixed epoch ms boundary

let dir: string;
let dbPath: string;

function seedDb(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE spans (
      span_id TEXT,
      chat_session_id TEXT,
      conversation_id TEXT,
      request_model TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cached_tokens INTEGER,
      start_time_ms INTEGER,
      end_time_ms INTEGER,
      operation_name TEXT
    );
    CREATE TABLE span_attributes (span_id TEXT, key TEXT, value TEXT);
  `);

  const insSpan = db.prepare(
    'INSERT INTO spans (span_id, request_model, input_tokens, output_tokens, cached_tokens, end_time_ms, operation_name) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  // model A, after midnight, with a cache-creation attribute
  insSpan.run('s1', 'gpt-test', 100, 50, 10, MIDNIGHT + 1000, 'chat');
  // model A, after midnight, no cache attribute
  insSpan.run('s2', 'gpt-test', 200, 20, 0, MIDNIGHT + 2000, 'chat');
  // model B, after midnight
  insSpan.run('s3', 'claude-test', 1000, 100, 0, MIDNIGHT + 3000, 'chat');
  // model A, BEFORE midnight → excluded from aggregateSince, counted in diagnostics
  insSpan.run('s4', 'gpt-test', 999, 999, 0, MIDNIGHT - 5000, 'chat');
  // non-chat operation → excluded everywhere
  insSpan.run('s5', 'gpt-test', 500, 500, 0, MIDNIGHT + 4000, 'execute_tool');

  // Session ids: s1/s2 share a human session, s3 another; s4 (pre-midnight) is a
  // subagent toolu_ session that must be excluded from sessionsSince.
  const updSession = db.prepare('UPDATE spans SET chat_session_id = ? WHERE span_id = ?');
  updSession.run('sessA', 's1');
  updSession.run('sessA', 's2');
  updSession.run('sessB', 's3');
  updSession.run('toolu_bdrk_x', 's4');

  const insAttr = db.prepare('INSERT INTO span_attributes (span_id, key, value) VALUES (?, ?, ?)');
  insAttr.run('s1', 'gen_ai.usage.cache_creation.input_tokens', '5');
  // s1 carries Copilot's stored credits (2e9 nano = 2.0 AIU); s2/s3 do not.
  insAttr.run('s1', 'copilot_chat.copilot_usage_nano_aiu', '2000000000');
  db.close();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'copilot-price-otel-'));
  dbPath = join(dir, 'agent-traces.db');
  seedDb(dbPath);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('OTelReader', () => {
  it('reports availability for a well-formed db', () => {
    const reader = createOTelReader(dbPath);
    expect(reader.isAvailable()).toBe(true);
    reader.close();
  });

  it('reports unavailable for a missing db', () => {
    const reader = createOTelReader(join(dir, 'nope.db'));
    expect(reader.isAvailable()).toBe(false);
    reader.close();
  });

  it('aggregates only post-midnight chat spans, grouped by model, joining cache-creation', () => {
    const reader = createOTelReader(dbPath);
    const rows = reader.aggregateSince(MIDNIGHT);
    reader.close();

    const byModel = Object.fromEntries(rows.map((r) => [r.model, r]));
    expect(Object.keys(byModel).sort()).toEqual(['claude-test', 'gpt-test']);

    expect(byModel['gpt-test']).toMatchObject({
      chats: 2,
      inputTokens: 300,
      outputTokens: 70,
      cacheReadTokens: 10,
      cacheCreationTokens: 5,
      // s1 is metered (2 AIU); s2 is not → un-metered token sums are s2's only.
      meteredChats: 1,
      meteredAiu: 2,
      unmeteredInputTokens: 200,
      unmeteredOutputTokens: 20,
      unmeteredCacheReadTokens: 0,
      unmeteredCacheCreationTokens: 0,
    });
    expect(byModel['claude-test']).toMatchObject({
      chats: 1,
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      meteredChats: 0,
      meteredAiu: 0,
      unmeteredInputTokens: 1000,
    });
  });

  it('excludes spans before the boundary', () => {
    const reader = createOTelReader(dbPath);
    // boundary after everything → no rows
    const rows = reader.aggregateSince(MIDNIGHT + 10_000);
    reader.close();
    expect(rows).toEqual([]);
  });

  it('readChatSpans returns raw chat spans with cache-creation joined', () => {
    const reader = createOTelReader(dbPath);
    const spans = reader.readChatSpans();
    reader.close();

    const byId = Object.fromEntries(spans.map((s) => [s.spanId, s]));
    expect(Object.keys(byId).sort()).toEqual(['s1', 's2', 's3', 's4']); // chat only, no boundary
    expect(byId['s1']).toMatchObject({
      model: 'gpt-test',
      inputTokens: 100,
      cacheReadTokens: 10,
      cacheCreationTokens: 5,
      usageNanoAiu: 2000000000,
    });
    expect(byId['s2']).toMatchObject({ cacheCreationTokens: 0, usageNanoAiu: null });
  });

  it('readChatSpans honors the optional sinceMs boundary', () => {
    const reader = createOTelReader(dbPath);
    const spans = reader.readChatSpans(MIDNIGHT);
    reader.close();
    expect(spans.map((s) => s.spanId).sort()).toEqual(['s1', 's2', 's3']); // s4 is before midnight
  });

  it('sessionsSince counts distinct human sessions, excluding subagent/background', () => {
    const reader = createOTelReader(dbPath);
    // s1+s2 = sessA, s3 = sessB (both after midnight); s4 is pre-midnight toolu_; s5 is non-chat.
    expect(reader.sessionsSince(MIDNIGHT)).toBe(2);
    expect(reader.sessionsSince(MIDNIGHT + 10_000)).toBe(0);
    reader.close();
  });

  it('earliestEndSince returns the earliest post-boundary chat end', () => {
    const reader = createOTelReader(dbPath);
    expect(reader.earliestEndSince(MIDNIGHT)).toBe(MIDNIGHT + 1000);
    expect(reader.earliestEndSince(MIDNIGHT + 10_000)).toBe(0);
    reader.close();
  });

  it('diagnostics count all chat spans all-time and report latest + models', () => {
    const reader = createOTelReader(dbPath);
    const diag = reader.getDiagnostics();
    reader.close();
    expect(diag.totalChatSpans).toBe(4); // s1..s4 are chat; s5 is execute_tool
    expect(diag.latestSpanMs).toBe(MIDNIGHT + 3000);
    expect(diag.models.sort()).toEqual(['claude-test', 'gpt-test']);
  });
});
