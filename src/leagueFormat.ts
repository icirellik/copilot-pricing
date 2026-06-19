import pc from 'picocolors';
import { noColor } from './format';
import type { LeaderboardResult, LeaderboardWindow } from './leagueClient';

// Render a ranked leaderboard for the terminal. Reuses the same no-op color
// shim as the usage report so --no-color / non-TTY output is plain.

const WINDOW_TITLE: Record<LeaderboardWindow, string> = {
  today: 'today',
  week: 'this week',
  all: 'all time',
};

const MEDALS = ['🥇', '🥈', '🥉'];

export interface RenderOptions {
  /** Highlight this handle as "you". */
  self?: string;
  /** League namespace, shown in the title / empty-state. */
  league?: string;
  useColor?: boolean;
}

export function renderLeaderboard(result: LeaderboardResult, opts: RenderOptions = {}): string {
  const c = opts.useColor === false ? noColor() : pc;
  const title =
    c.bold(`Copilot league — ${WINDOW_TITLE[result.window]}`) + (opts.league ? c.dim(`  (${opts.league})`) : '');

  if (result.rows.length === 0) {
    const who = opts.league ? `league '${opts.league}'` : 'this league';
    return `${title}\n\n${c.dim(`No one in ${who} has published yet.`)}\n`;
  }

  const cells = result.rows.map((row) => {
    const isSelf = opts.self !== undefined && row.handle === opts.self;
    return {
      isSelf,
      rank: row.rank <= 3 ? MEDALS[row.rank - 1] : `${row.rank}.`,
      name: isSelf ? `${row.handle} (you)` : row.handle,
      aic: `${row.aic.toFixed(2)} AIC`,
    };
  });

  const rankW = Math.max(...cells.map((x) => x.rank.length));
  const nameW = Math.max(...cells.map((x) => x.name.length));
  const aicW = Math.max(...cells.map((x) => x.aic.length));

  const lines = [title, ''];
  for (const x of cells) {
    const rank = x.rank.padEnd(rankW);
    const name = x.name.padEnd(nameW);
    const aic = x.aic.padStart(aicW);
    const plain = `${rank}  ${name}  ${aic}`;
    lines.push(x.isSelf ? c.bold(c.cyan(plain)) : `${rank}  ${name}  ${c.bold(aic)}`);
  }
  return lines.join('\n') + '\n';
}
