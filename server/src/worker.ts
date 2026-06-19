// copilot-price league backend — a tiny Cloudflare Worker over D1 (SQLite).
//
// It is a DUMB ACCUMULATOR: it stores one row per (league, handle, date) with
// that day's total AIC, and derives today/week/all-time boards by summing the
// day rows. It never re-derives "today" itself — the client sends its own
// publisher-local date strings; the server treats them as opaque and filters
// lexically (YYYY-MM-DD sorts chronologically).
//
// Auth is a single shared LEAGUE_SECRET (set via `wrangler secret put`). The
// `league` field is a namespace so one deployment can host several boards — it
// is NOT a security boundary. This is a trust-among-friends model: anyone with
// the token can publish as any handle and read the whole league.

// --- Minimal D1 shims so this deploys with just `wrangler` (no workers-types) ---
interface D1Result<T = unknown> {
  results: T[];
}
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<unknown>;
  all<T = unknown>(): Promise<D1Result<T>>;
}
interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<unknown[]>;
}

export interface Env {
  DB: D1Database;
  LEAGUE_SECRET: string;
}

const MAX_BODY_CHARS = 8192; // generous enough for a 90-day batch
const MAX_HANDLE = 40;
const MAX_LEAGUE = 64;
const MAX_BATCH_DAYS = 90;
const AIC_CAP = 10_000_000; // a sane per-day upper bound

const UPSERT =
  'INSERT INTO entries (league, handle, date, total_aic, updated_ms) VALUES (?, ?, ?, ?, ?)' +
  ' ON CONFLICT(league, handle, date) DO UPDATE SET total_aic = excluded.total_aic, updated_ms = excluded.updated_ms';

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (req.method === 'GET' && url.pathname === '/v1/health') {
        return json({ ok: true });
      }
      if (!authorized(req, env)) {
        return json({ error: 'unauthorized' }, 401);
      }
      if (req.method === 'POST' && url.pathname === '/v1/publish') {
        return await handlePublish(req, env);
      }
      if (req.method === 'POST' && url.pathname === '/v1/publish-batch') {
        return await handlePublishBatch(req, env);
      }
      if (req.method === 'GET' && url.pathname === '/v1/leaderboard') {
        return await handleLeaderboard(url, env);
      }
      return json({ error: 'not found' }, 404);
    } catch (e) {
      if (e instanceof HttpError) {
        return json({ error: e.message }, e.status);
      }
      return json({ error: 'internal error' }, 500);
    }
  },
};

function authorized(req: Request, env: Env): boolean {
  const header = req.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m || !env.LEAGUE_SECRET) {
    return false;
  }
  return timingSafeEqual(m[1], env.LEAGUE_SECRET);
}

async function handlePublish(req: Request, env: Env): Promise<Response> {
  const body = await readJson(req);
  const league = validLeague(body.league);
  const handle = validHandle(body.handle);
  const date = validDate(body.date);
  const totalAic = validAic(body.totalAic);
  await env.DB.prepare(UPSERT).bind(league, handle, date, totalAic, Date.now()).run();
  return json({ ok: true });
}

async function handlePublishBatch(req: Request, env: Env): Promise<Response> {
  const body = await readJson(req);
  const league = validLeague(body.league);
  const handle = validHandle(body.handle);
  const days = body.days;
  if (!Array.isArray(days) || days.length === 0) {
    throw new HttpError(400, 'days must be a non-empty array');
  }
  if (days.length > MAX_BATCH_DAYS) {
    throw new HttpError(413, `too many days (max ${MAX_BATCH_DAYS})`);
  }
  const now = Date.now();
  const stmt = env.DB.prepare(UPSERT);
  const batch = days.map((d) => {
    const day = (d ?? {}) as Record<string, unknown>;
    return stmt.bind(league, handle, validDate(day.date), validAic(day.totalAic), now);
  });
  await env.DB.batch(batch);
  return json({ ok: true, count: batch.length });
}

async function handleLeaderboard(url: URL, env: Env): Promise<Response> {
  const league = validLeague(url.searchParams.get('league'));
  const window = url.searchParams.get('window') ?? 'today';
  const date = url.searchParams.get('date') ?? '';
  const from = url.searchParams.get('from') ?? '';

  let sql: string;
  let binds: unknown[];
  if (window === 'today') {
    if (!isDate(date)) {
      throw new HttpError(400, 'today requires a valid date');
    }
    sql = 'SELECT handle, SUM(total_aic) AS aic FROM entries WHERE league = ? AND date = ? GROUP BY handle ORDER BY aic DESC';
    binds = [league, date];
  } else if (window === 'week') {
    if (!isDate(date) || !isDate(from)) {
      throw new HttpError(400, 'week requires date and from');
    }
    sql =
      'SELECT handle, SUM(total_aic) AS aic FROM entries WHERE league = ? AND date >= ? AND date <= ? GROUP BY handle ORDER BY aic DESC';
    binds = [league, from, date];
  } else if (window === 'all') {
    sql = 'SELECT handle, SUM(total_aic) AS aic FROM entries WHERE league = ? GROUP BY handle ORDER BY aic DESC';
    binds = [league];
  } else {
    throw new HttpError(400, 'invalid window (today|week|all)');
  }

  const { results } = await env.DB.prepare(sql)
    .bind(...binds)
    .all<{ handle: string; aic: number }>();
  const rows = results.map((r, i) => ({ handle: r.handle, aic: round(r.aic), rank: i + 1 }));
  return json({ window, rows });
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > MAX_BODY_CHARS) {
    throw new HttpError(413, 'request body too large');
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

function validLeague(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s || s.length > MAX_LEAGUE) {
    throw new HttpError(400, 'invalid league');
  }
  return s;
}

function validHandle(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s || s.length > MAX_HANDLE) {
    throw new HttpError(400, 'invalid handle');
  }
  return s;
}

function isDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function validDate(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!isDate(s)) {
    throw new HttpError(400, 'invalid date (want YYYY-MM-DD)');
  }
  return s;
}

function validAic(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 0 || n > AIC_CAP) {
    throw new HttpError(400, 'invalid totalAic');
  }
  return Math.round(n * 1e6) / 1e6;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Length-checked, constant-time-ish string compare to avoid trivial timing leaks. */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < ab.length; i++) {
    diff |= ab[i] ^ bb[i];
  }
  return diff === 0;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
