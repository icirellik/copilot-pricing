import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openUsageStore, resolveStorePath, type UsageStore } from './ingestStore';
import type { RawChatSpan } from './otelReader';

const MIDNIGHT = 1_780_000_000_000;
const NOW = MIDNIGHT + 100_000;

function span(over: Partial<RawChatSpan> & Pick<RawChatSpan, 'spanId'>): RawChatSpan {
  return {
    model: 'gpt-test',
    startTimeMs: MIDNIGHT + 1000,
    endTimeMs: MIDNIGHT + 1000,
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    usageNanoAiu: null,
    chatSessionId: 'sess',
    conversationId: 'conv',
    ...over,
  };
}

let dir: string;
let store: UsageStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'copilot-price-store-'));
  store = openUsageStore(join(dir, 'usage.db'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('UsageStore', () => {
  it('aggregates ingested spans by model, only past the boundary', () => {
    store.ingest(
      [
        span({ spanId: 's1', model: 'gpt-test', inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, endTimeMs: MIDNIGHT + 1000 }),
        span({ spanId: 's2', model: 'gpt-test', inputTokens: 200, outputTokens: 20, endTimeMs: MIDNIGHT + 2000 }),
        span({ spanId: 's3', model: 'claude-test', inputTokens: 1000, outputTokens: 100, endTimeMs: MIDNIGHT + 3000 }),
        span({ spanId: 's4', model: 'gpt-test', inputTokens: 999, outputTokens: 999, endTimeMs: MIDNIGHT - 5000 }),
      ],
      NOW,
    );

    const byModel = Object.fromEntries(store.aggregateSince(MIDNIGHT).map((r) => [r.model, r]));
    expect(Object.keys(byModel).sort()).toEqual(['claude-test', 'gpt-test']);
    expect(byModel['gpt-test']).toMatchObject({ chats: 2, inputTokens: 300, outputTokens: 70, cacheReadTokens: 10 });
    expect(byModel['claude-test']).toMatchObject({ chats: 1, inputTokens: 1000, outputTokens: 100 });
  });

  it('is idempotent — re-ingesting the same spans adds no rows', () => {
    const spans = [span({ spanId: 'a' }), span({ spanId: 'b' })];
    const first = store.ingest(spans, NOW);
    expect(first).toEqual({ seen: 2, inserted: 2 });

    const second = store.ingest(spans, NOW + 1);
    expect(second).toEqual({ seen: 2, inserted: 0 });
    expect(store.totalRows()).toBe(2);
  });

  it('retains spans the source later drops (the whole point)', () => {
    store.ingest([span({ spanId: 'old', endTimeMs: MIDNIGHT + 1000 })], NOW);
    // Source pruned 'old'; a later run only sees a new span.
    store.ingest([span({ spanId: 'new', endTimeMs: MIDNIGHT + 9000 })], NOW + 1000);

    expect(store.totalRows()).toBe(2);
    const total = store.aggregateSince(MIDNIGHT).reduce((n, a) => n + a.chats, 0);
    expect(total).toBe(2);
  });

  it('refreshes token columns on conflict (late-arriving cache-creation attr)', () => {
    store.ingest([span({ spanId: 'x', cacheCreationTokens: 0 })], NOW);
    store.ingest([span({ spanId: 'x', cacheCreationTokens: 42 })], NOW + 1);

    const agg = store.aggregateSince(MIDNIGHT);
    expect(agg).toHaveLength(1);
    expect(agg[0]).toMatchObject({ chats: 1, cacheCreationTokens: 42 });
  });

  it('aggregateBetween bounds to a half-open (start, end] window', () => {
    store.ingest(
      [
        span({ spanId: 'lo', endTimeMs: MIDNIGHT + 1000 }), // == start, excluded (strict >)
        span({ spanId: 'a', endTimeMs: MIDNIGHT + 2000 }), // inside
        span({ spanId: 'b', endTimeMs: MIDNIGHT + 3000 }), // inside
        span({ spanId: 'hi', endTimeMs: MIDNIGHT + 4000 }), // == end, included (<=)
        span({ spanId: 'over', endTimeMs: MIDNIGHT + 5000 }), // after end, excluded
      ],
      NOW,
    );
    const agg = store.aggregateBetween(MIDNIGHT + 1000, MIDNIGHT + 4000);
    expect(agg).toHaveLength(1);
    expect(agg[0].chats).toBe(3); // a, b, hi
  });

  it('earliestEndSince returns the min end past the boundary', () => {
    store.ingest(
      [
        span({ spanId: 'a', endTimeMs: MIDNIGHT + 5000 }),
        span({ spanId: 'b', endTimeMs: MIDNIGHT + 2000 }),
        span({ spanId: 'c', endTimeMs: MIDNIGHT - 1000 }),
      ],
      NOW,
    );
    expect(store.earliestEndSince(MIDNIGHT)).toBe(MIDNIGHT + 2000);
    expect(store.earliestEndSince(MIDNIGHT + 9000)).toBe(0);
  });

  it('sessionsSince counts distinct human sessions, excluding background + subagent calls', () => {
    store.ingest(
      [
        span({ spanId: 'a', chatSessionId: 'sessA', endTimeMs: MIDNIGHT + 1000 }),
        span({ spanId: 'b', chatSessionId: 'sessA', endTimeMs: MIDNIGHT + 1100 }), // same session
        span({ spanId: 'c', chatSessionId: 'sessB', endTimeMs: MIDNIGHT + 1200 }),
        span({ spanId: 'd', chatSessionId: '', endTimeMs: MIDNIGHT + 1300 }), // background (no session)
        span({ spanId: 'e', chatSessionId: null, endTimeMs: MIDNIGHT + 1400 }), // background
        span({ spanId: 'f', chatSessionId: 'toolu_bdrk_123', endTimeMs: MIDNIGHT + 1500 }), // subagent
        span({ spanId: 'g', chatSessionId: 'sessOld', endTimeMs: MIDNIGHT - 1000 }), // before boundary
      ],
      NOW,
    );
    expect(store.sessionsSince(MIDNIGHT)).toBe(2); // sessA, sessB
  });

  it('handles an empty ingest', () => {
    expect(store.ingest([], NOW)).toEqual({ seen: 0, inserted: 0 });
    expect(store.totalRows()).toBe(0);
  });

  it('records the last ingest time, even on a no-op ingest', () => {
    expect(store.lastIngestMs()).toBe(0);
    store.ingest([span({ spanId: 'a' })], NOW);
    expect(store.lastIngestMs()).toBe(NOW);
    store.ingest([], NOW + 5000);
    expect(store.lastIngestMs()).toBe(NOW + 5000);
  });

  it('aggregates stored AIU and splits out un-metered token sums', () => {
    store.ingest(
      [
        span({ spanId: 'm1', usageNanoAiu: 2_000_000_000, inputTokens: 1000 }), // 2.0 AIU, metered
        span({ spanId: 'm2', usageNanoAiu: 500_000_000, inputTokens: 2000 }), //  0.5 AIU, metered
        span({ spanId: 'u1', usageNanoAiu: null, inputTokens: 4000, outputTokens: 7 }), // un-metered
      ],
      NOW,
    );
    const agg = store.aggregateSince(MIDNIGHT);
    expect(agg).toHaveLength(1);
    expect(agg[0]).toMatchObject({
      chats: 3,
      meteredChats: 2,
      meteredAiu: 2.5,
      unmeteredInputTokens: 4000, // u1 only
      unmeteredOutputTokens: 7,
    });
  });

  it('keeps a captured AIU when a later read of the same span lacks it', () => {
    store.ingest([span({ spanId: 'x', usageNanoAiu: 3_000_000_000 })], NOW);
    store.ingest([span({ spanId: 'x', usageNanoAiu: null })], NOW + 1);
    expect(store.aggregateSince(MIDNIGHT)[0]).toMatchObject({ meteredChats: 1, meteredAiu: 3 });
  });
});

describe('resolveStorePath', () => {
  const ORIG = { store: process.env.COPILOT_PRICE_STORE, home: process.env.COPILOT_PRICE_HOME };
  afterEach(() => {
    process.env.COPILOT_PRICE_STORE = ORIG.store;
    process.env.COPILOT_PRICE_HOME = ORIG.home;
  });

  it('prefers the explicit override', () => {
    expect(resolveStorePath('/tmp/explicit.db')).toBe('/tmp/explicit.db');
  });

  it('falls back to COPILOT_PRICE_STORE', () => {
    delete process.env.COPILOT_PRICE_HOME;
    process.env.COPILOT_PRICE_STORE = '/tmp/env-store.db';
    expect(resolveStorePath()).toBe('/tmp/env-store.db');
  });

  it('honors COPILOT_PRICE_HOME', () => {
    delete process.env.COPILOT_PRICE_STORE;
    process.env.COPILOT_PRICE_HOME = '/tmp/cphome';
    expect(resolveStorePath()).toBe('/tmp/cphome/usage.db');
  });
});
