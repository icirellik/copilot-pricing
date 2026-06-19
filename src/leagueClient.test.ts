import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LeagueConfig } from './league';
import { fetchLeaderboard, publish, publishBatch } from './leagueClient';

const cfg: LeagueConfig = { apiUrl: 'https://api.example.com', token: 'tok', league: 'friends', handle: 'cam' };

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function lastCall(mock: ReturnType<typeof vi.fn>): { url: URL; init: RequestInit } {
  const [url, init] = mock.mock.calls[0] as [URL | string, RequestInit];
  return { url: new URL(String(url)), init };
}

afterEach(() => vi.unstubAllGlobals());

describe('publish', () => {
  it('POSTs EXACTLY {league, handle, date, totalAic} with a bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    await publish(cfg, { date: '2026-06-09', totalAic: 98.3 });

    const { url, init } = lastCall(fetchMock);
    expect(url.href).toBe('https://api.example.com/v1/publish');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');

    const body = JSON.parse(init.body as string);
    // privacy guarantee: nothing but these four fields ever leaves the machine
    expect(Object.keys(body).sort()).toEqual(['date', 'handle', 'league', 'totalAic']);
    expect(body).toEqual({ league: 'friends', handle: 'cam', date: '2026-06-09', totalAic: 98.3 });
  });

  it('maps a 401 to an auth error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => '' } as unknown as Response));
    await expect(publish(cfg, { date: '2026-06-09', totalAic: 1 })).rejects.toMatchObject({ kind: 'auth' });
  });

  it('maps a network failure to a network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));
    await expect(publish(cfg, { date: '2026-06-09', totalAic: 1 })).rejects.toMatchObject({ kind: 'network' });
  });

  it('maps an AbortSignal timeout to a timeout error', async () => {
    const err = new Error('timed out');
    err.name = 'TimeoutError';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(err));
    await expect(publish(cfg, { date: '2026-06-09', totalAic: 1 })).rejects.toMatchObject({ kind: 'timeout' });
  });
});

describe('publishBatch', () => {
  it('POSTs the league/handle once and a days array', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    await publishBatch(cfg, [
      { date: '2026-06-08', totalAic: 5 },
      { date: '2026-06-09', totalAic: 7 },
    ]);

    const { url, init } = lastCall(fetchMock);
    expect(url.href).toBe('https://api.example.com/v1/publish-batch');
    expect(JSON.parse(init.body as string)).toEqual({
      league: 'friends',
      handle: 'cam',
      days: [
        { date: '2026-06-08', totalAic: 5 },
        { date: '2026-06-09', totalAic: 7 },
      ],
    });
  });
});

describe('fetchLeaderboard', () => {
  it('passes the window/date/from query and parses ranked rows', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        window: 'today',
        rows: [
          { handle: 'dana', aic: 142.7, rank: 1 },
          { handle: 'cam', aic: 98.3, rank: 2 },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await fetchLeaderboard(cfg, { window: 'today', date: '2026-06-09', from: '2026-06-03' });

    const { url, init } = lastCall(fetchMock);
    expect(init.method).toBe('GET');
    expect(url.pathname).toBe('/v1/leaderboard');
    expect(url.searchParams.get('league')).toBe('friends');
    expect(url.searchParams.get('window')).toBe('today');
    expect(url.searchParams.get('date')).toBe('2026-06-09');
    expect(url.searchParams.get('from')).toBe('2026-06-03');

    expect(res.window).toBe('today');
    expect(res.rows[0]).toEqual({ handle: 'dana', aic: 142.7, rank: 1 });
  });

  it('throws bad-response on an unexpected shape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ nope: true })));
    await expect(fetchLeaderboard(cfg, { window: 'all', date: 'd', from: 'f' })).rejects.toMatchObject({
      kind: 'bad-response',
    });
  });
});
