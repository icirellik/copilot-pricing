import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listDbCandidates, resolveDbPath } from './dbLocator';

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
