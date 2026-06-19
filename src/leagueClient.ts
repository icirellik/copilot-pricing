import type { LeagueConfig } from './league';

// The HTTP client for the league backend. Uses built-in fetch + an AbortSignal
// timeout so it adds no runtime dependencies. Every failure becomes a typed
// LeagueError the CLI can turn into a friendly, actionable message.

export type LeaderboardWindow = 'today' | 'week' | 'all';

export interface DayTotal {
  /** YYYY-MM-DD, publisher-local. */
  date: string;
  totalAic: number;
}

export interface LeaderboardRow {
  handle: string;
  aic: number;
  rank: number;
}

export interface LeaderboardResult {
  window: LeaderboardWindow;
  rows: LeaderboardRow[];
}

export type LeagueErrorKind = 'network' | 'timeout' | 'auth' | 'not-found' | 'server' | 'bad-response';

export class LeagueError extends Error {
  readonly kind: LeagueErrorKind;
  constructor(kind: LeagueErrorKind, message: string) {
    super(message);
    this.name = 'LeagueError';
    this.kind = kind;
  }
}

const TIMEOUT_MS = 5000;

/** Publish today's total. Body is EXACTLY {league, handle, date, totalAic}. */
export async function publish(cfg: LeagueConfig, entry: DayTotal): Promise<void> {
  await request(cfg, 'POST', '/v1/publish', {
    body: { league: cfg.league, handle: cfg.handle, date: entry.date, totalAic: finite(entry.totalAic) },
  });
}

/** Publish several days at once (for --backfill); one round-trip. */
export async function publishBatch(cfg: LeagueConfig, days: DayTotal[]): Promise<void> {
  await request(cfg, 'POST', '/v1/publish-batch', {
    body: {
      league: cfg.league,
      handle: cfg.handle,
      days: days.map((d) => ({ date: d.date, totalAic: finite(d.totalAic) })),
    },
  });
}

/** Fetch a ranked board. The client computes the date window; the server filters. */
export async function fetchLeaderboard(
  cfg: LeagueConfig,
  opts: { window: LeaderboardWindow; date: string; from: string },
): Promise<LeaderboardResult> {
  const data = await request(cfg, 'GET', '/v1/leaderboard', {
    query: { league: cfg.league, window: opts.window, date: opts.date, from: opts.from },
  });
  return parseLeaderboard(data, opts.window);
}

interface RequestOpts {
  query?: Record<string, string>;
  body?: unknown;
}

async function request(cfg: LeagueConfig, method: string, pathname: string, opts: RequestOpts = {}): Promise<unknown> {
  const url = new URL(cfg.apiUrl + pathname);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== '') {
      url.searchParams.set(k, v);
    }
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${cfg.token}`,
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const name = (e as { name?: string } | null)?.name;
    if (name === 'TimeoutError') {
      throw new LeagueError('timeout', `league server didn't respond within ${TIMEOUT_MS / 1000}s`);
    }
    throw new LeagueError('network', `couldn't reach the league server at ${cfg.apiUrl}`);
  }

  if (res.status === 401 || res.status === 403) {
    throw new LeagueError('auth', 'league token rejected — re-run `--join` with a fresh code');
  }
  if (res.status === 404) {
    throw new LeagueError('not-found', `league endpoint not found (${url.pathname}) — check the API URL in your join code`);
  }
  if (!res.ok) {
    throw new LeagueError('server', `league server returned an error (HTTP ${res.status})`);
  }

  const text = await res.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new LeagueError('bad-response', 'league server returned a non-JSON response');
  }
}

function parseLeaderboard(data: unknown, window: LeaderboardWindow): LeaderboardResult {
  const rows = (data as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows)) {
    throw new LeagueError('bad-response', 'league server returned an unexpected leaderboard shape');
  }
  return {
    window,
    rows: rows.map((raw, i) => {
      const r = (raw ?? {}) as Record<string, unknown>;
      return {
        handle: typeof r.handle === 'string' ? r.handle : String(r.handle ?? ''),
        aic: finite(r.aic),
        rank: Number.isFinite(Number(r.rank)) ? Number(r.rank) : i + 1,
      };
    }),
  };
}

function finite(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}
