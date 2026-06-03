import { existsSync, statSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// The Copilot Chat extension writes its OTel store to
//   <editor globalStorage>/github.copilot-chat/agent-traces.db
// We probe the known editor variants and OS layouts in priority order.
const COPILOT_CHAT_DIR = 'github.copilot-chat';
const DB_NAME = 'agent-traces.db';

// VS Code stable first, then Insiders, then VS Code-compatible forks.
const EDITORS = ['Code', 'Code - Insiders', 'Cursor', 'VSCodium'] as const;

export interface DbCandidate {
  editor: string;
  path: string;
  exists: boolean;
}

function globalStorageRoot(editor: string): string {
  const home = os.homedir();
  switch (process.platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', editor, 'User', 'globalStorage');
    case 'win32':
      return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), editor, 'User', 'globalStorage');
    default:
      // Linux and other Unixes follow the XDG layout.
      return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), editor, 'User', 'globalStorage');
  }
}

/** All candidate DB paths (existing and not), in priority order. */
export function listDbCandidates(): DbCandidate[] {
  return EDITORS.map((editor) => {
    const dbPath = path.join(globalStorageRoot(editor), COPILOT_CHAT_DIR, DB_NAME);
    return { editor, path: dbPath, exists: existsSync(dbPath) };
  });
}

/** Most recent write across the DB and its -wal sidecar (0 if unreadable). */
function recencyMs(dbPath: string): number {
  let mtime = 0;
  for (const p of [dbPath, `${dbPath}-wal`]) {
    try {
      mtime = Math.max(mtime, statSync(p).mtimeMs);
    } catch {
      // missing file/sidecar — ignore
    }
  }
  return mtime;
}

/**
 * Of the existing candidate DBs, choose the one to read. With a single editor
 * that's just that editor; when several are installed (e.g. stable VS Code AND
 * Insiders) the most recently written DB wins, so we follow the editor you're
 * actually using rather than a fixed priority order.
 */
export function pickActiveDb(candidates: DbCandidate[], recency: (p: string) => number = recencyMs): string | null {
  const existing = candidates.filter((c) => c.exists);
  if (existing.length === 0) {
    return null;
  }
  if (existing.length === 1) {
    return existing[0].path;
  }
  return existing.reduce((best, c) => (recency(c.path) > recency(best.path) ? c : best)).path;
}

/**
 * Resolve the DB path to use. An explicit override (`--db` flag or
 * `COPILOT_PRICE_DB`) is returned as-is so the caller can report a bad path;
 * otherwise the most recently active existing candidate is returned, or null
 * when none exist.
 */
export function resolveDbPath(override?: string): string | null {
  const explicit = override ?? process.env.COPILOT_PRICE_DB;
  if (explicit) {
    return explicit;
  }
  return pickActiveDb(listDbCandidates());
}
