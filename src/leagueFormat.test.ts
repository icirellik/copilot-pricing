import { describe, expect, it } from 'vitest';
import { renderLeaderboard } from './leagueFormat';
import type { LeaderboardResult } from './leagueClient';

const board: LeaderboardResult = {
  window: 'today',
  rows: [
    { handle: 'dana', aic: 142.7, rank: 1 },
    { handle: 'cam', aic: 98.3, rank: 2 },
    { handle: 'alex', aic: 61, rank: 3 },
  ],
};

describe('renderLeaderboard', () => {
  it('renders ranked rows with the window title and AIC values', () => {
    const out = renderLeaderboard(board, { useColor: false });
    expect(out).toContain('Copilot league — today');
    expect(out).toContain('dana');
    expect(out).toContain('142.70 AIC');
    expect(out).toContain('98.30 AIC');
    // top-3 get medals
    expect(out).toContain('🥇');
    expect(out).toContain('🥉');
  });

  it('marks the self handle', () => {
    const out = renderLeaderboard(board, { useColor: false, self: 'cam' });
    expect(out).toContain('cam (you)');
    expect(out).not.toContain('dana (you)');
  });

  it('uses a numeric rank past the podium', () => {
    const out = renderLeaderboard(
      { window: 'all', rows: [{ handle: 'z', aic: 1, rank: 4 }] },
      { useColor: false },
    );
    expect(out).toContain('4.');
    expect(out).toContain('all time');
  });

  it('shows a friendly empty state', () => {
    const out = renderLeaderboard({ window: 'week', rows: [] }, { useColor: false, league: 'friends' });
    expect(out).toContain("No one in league 'friends' has published yet.");
  });
});
