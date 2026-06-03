import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listDbCandidates, pickActiveDb, resolveDbPath, type DbCandidate } from './dbLocator';

const ENV_KEY = 'COPILOT_PRICE_DB';
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
});

afterEach(() => {
  if (savedEnv === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = savedEnv;
  }
});

describe('listDbCandidates', () => {
  it('returns one candidate per known editor, all ending in the expected path', () => {
    const candidates = listDbCandidates();
    expect(candidates.map((c) => c.editor)).toEqual(['Code', 'Code - Insiders', 'Cursor', 'VSCodium']);
    for (const cand of candidates) {
      expect(cand.path).toContain('github.copilot-chat');
      expect(cand.path.endsWith('agent-traces.db')).toBe(true);
      expect(typeof cand.exists).toBe('boolean');
    }
  });
});

describe('resolveDbPath', () => {
  it('returns the explicit override verbatim', () => {
    expect(resolveDbPath('/tmp/custom/agent-traces.db')).toBe('/tmp/custom/agent-traces.db');
  });

  it('honors the COPILOT_PRICE_DB env var when no flag is given', () => {
    process.env[ENV_KEY] = '/tmp/from-env/agent-traces.db';
    expect(resolveDbPath()).toBe('/tmp/from-env/agent-traces.db');
  });

  it('prefers the flag over the env var', () => {
    process.env[ENV_KEY] = '/tmp/from-env/agent-traces.db';
    expect(resolveDbPath('/tmp/from-flag/agent-traces.db')).toBe('/tmp/from-flag/agent-traces.db');
  });
});

describe('pickActiveDb', () => {
  const cand = (editor: string, p: string, exists: boolean): DbCandidate => ({ editor, path: p, exists });

  it('returns null when no candidate exists', () => {
    expect(pickActiveDb([cand('Code', '/a', false), cand('Code - Insiders', '/b', false)])).toBeNull();
  });

  it('returns the sole existing candidate (single-editor fast path)', () => {
    expect(pickActiveDb([cand('Code', '/a', false), cand('Code - Insiders', '/b', true)])).toBe('/b');
  });

  it('picks the most recently written DB when several editors are installed', () => {
    const recency = (p: string): number => ({ '/a': 100, '/b': 500, '/c': 300 })[p] ?? 0;
    const picked = pickActiveDb(
      [cand('Code', '/a', true), cand('Code - Insiders', '/b', true), cand('Cursor', '/c', true)],
      recency,
    );
    expect(picked).toBe('/b');
  });
});
