import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  decodeJoinCode,
  encodeJoinCode,
  loadLeague,
  resolveLeaguePath,
  saveLeague,
  type LeagueConfig,
} from './league';

describe('join code', () => {
  it('round-trips apiUrl/token/league', () => {
    const code = encodeJoinCode({ apiUrl: 'https://x.example.com', token: 's3cr3t', league: 'friends' });
    expect(decodeJoinCode(code)).toEqual({ apiUrl: 'https://x.example.com', token: 's3cr3t', league: 'friends' });
  });

  it('strips a trailing slash from the api url on both ends', () => {
    const code = encodeJoinCode({ apiUrl: 'https://x.example.com/', token: 't', league: 'l' });
    expect(decodeJoinCode(code).apiUrl).toBe('https://x.example.com');
  });

  it('throws on a malformed code', () => {
    expect(() => decodeJoinCode('not-base64!!')).toThrow(/invalid join code/);
  });

  it('throws when a field is missing', () => {
    const bad = Buffer.from(JSON.stringify({ u: 'https://x', t: 'tok' }), 'utf8').toString('base64url');
    expect(() => decodeJoinCode(bad)).toThrow(/missing apiUrl, token, or league/);
  });
});

describe('config persistence', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'copilot-price-league-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('saves and loads a full config', () => {
    const cfg: LeagueConfig = { apiUrl: 'https://x.example.com', token: 't', league: 'l', handle: 'cam' };
    const p = join(dir, 'league.json');
    saveLeague(p, cfg);
    expect(loadLeague(p)).toEqual(cfg);
  });

  it('returns null when no config exists', () => {
    expect(loadLeague(join(dir, 'nope.json'))).toBeNull();
  });

  it('throws on an incomplete config', () => {
    const p = join(dir, 'partial.json');
    saveLeague(p, { apiUrl: 'https://x', token: 't', league: 'l', handle: 'cam' });
    // overwrite with a partial doc
    rmSync(p, { force: true });
    saveLeague(p, { apiUrl: 'https://x', token: 't', league: 'l', handle: '' } as LeagueConfig);
    expect(() => loadLeague(p)).toThrow(/incomplete/);
  });
});

describe('resolveLeaguePath', () => {
  const ORIG = { league: process.env.COPILOT_PRICE_LEAGUE, home: process.env.COPILOT_PRICE_HOME };
  afterEach(() => {
    process.env.COPILOT_PRICE_LEAGUE = ORIG.league;
    process.env.COPILOT_PRICE_HOME = ORIG.home;
  });

  it('prefers the explicit override', () => {
    expect(resolveLeaguePath('/tmp/explicit-league.json')).toBe('/tmp/explicit-league.json');
  });

  it('falls back to COPILOT_PRICE_LEAGUE', () => {
    delete process.env.COPILOT_PRICE_HOME;
    process.env.COPILOT_PRICE_LEAGUE = '/tmp/env-league.json';
    expect(resolveLeaguePath()).toBe('/tmp/env-league.json');
  });

  it('honors COPILOT_PRICE_HOME', () => {
    delete process.env.COPILOT_PRICE_LEAGUE;
    process.env.COPILOT_PRICE_HOME = '/tmp/cphome';
    expect(resolveLeaguePath()).toBe('/tmp/cphome/league.json');
  });
});
