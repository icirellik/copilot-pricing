import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Local config for the friends leaderboard. Holds the shared league secret, so
// it's written 0600 and lives alongside the durable store under the same home
// dir resolution as ingestStore.ts (override → env → ~/.copilot-price).

export interface LeagueConfig {
  /** Base URL of the league backend, no trailing slash. */
  apiUrl: string;
  /** Shared league bearer secret (the same for everyone in the league). */
  token: string;
  /** League namespace — one backend can host several boards. */
  league: string;
  /** Your name on the board. */
  handle: string;
}

/** The shareable part of a league: everything except your personal handle. */
export interface JoinPayload {
  apiUrl: string;
  token: string;
  league: string;
}

/** Resolve where league.json lives (override → env → ~/.copilot-price). */
export function resolveLeaguePath(override?: string): string {
  const explicit = override ?? process.env.COPILOT_PRICE_LEAGUE;
  if (explicit) {
    return explicit;
  }
  const home = process.env.COPILOT_PRICE_HOME ?? path.join(os.homedir(), '.copilot-price');
  return path.join(home, 'league.json');
}

/** A best-effort default handle from the OS user (overridable with --handle). */
export function defaultHandle(): string {
  try {
    const u = os.userInfo().username;
    if (u) {
      return u;
    }
  } catch {
    // os.userInfo can throw on exotic setups; fall through to env
  }
  return process.env.USER ?? process.env.USERNAME ?? '';
}

/** Encode a shareable join code (base64url of the league connection details). */
export function encodeJoinCode(payload: JoinPayload): string {
  const json = JSON.stringify({ u: normalizeApiUrl(payload.apiUrl), t: payload.token, l: payload.league });
  return Buffer.from(json, 'utf8').toString('base64url');
}

/** Decode a join code back into connection details; throws on a malformed code. */
export function decodeJoinCode(code: string): JoinPayload {
  let parsed: { u?: unknown; t?: unknown; l?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(code.trim(), 'base64url').toString('utf8'));
  } catch {
    throw new Error('invalid join code — could not decode it');
  }
  const { u, t, l } = parsed;
  if (typeof u !== 'string' || typeof t !== 'string' || typeof l !== 'string' || !u || !t || !l) {
    throw new Error('invalid join code — missing apiUrl, token, or league');
  }
  return { apiUrl: normalizeApiUrl(u), token: t, league: l };
}

/** Read the saved league config, or null if none exists yet. */
export function loadLeague(configPath: string): LeagueConfig | null {
  if (!fs.existsSync(configPath)) {
    return null;
  }
  let parsed: Partial<LeagueConfig>;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<LeagueConfig>;
  } catch {
    throw new Error(`league config at ${configPath} is not valid JSON`);
  }
  if (!parsed.apiUrl || !parsed.token || !parsed.league || !parsed.handle) {
    throw new Error(`league config at ${configPath} is incomplete — re-run with --join`);
  }
  return {
    apiUrl: normalizeApiUrl(parsed.apiUrl),
    token: parsed.token,
    league: parsed.league,
    handle: parsed.handle,
  };
}

/** Persist the league config (0600 — it contains the shared secret). */
export function saveLeague(configPath: string, config: LeagueConfig): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ ...config, apiUrl: normalizeApiUrl(config.apiUrl) }, null, 2) + '\n', {
    mode: 0o600,
  });
}

function normalizeApiUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}
