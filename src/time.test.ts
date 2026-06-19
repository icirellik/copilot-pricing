import { describe, expect, it } from 'vitest';
import { isoDate, midnightDaysAgo, midnightMs } from './time';

describe('midnightMs', () => {
  it('returns a midnight boundary (local) that isoDate reads back to today', () => {
    const since = midnightMs(false);
    // local midnight has zeroed time components
    const d = new Date(since);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
    expect(isoDate(since, false)).toBe(isoDate(Date.now(), false));
  });

  it('UTC midnight has zeroed UTC time components', () => {
    const d = new Date(midnightMs(true));
    expect(d.getUTCHours()).toBe(0);
    expect(d.getUTCMinutes()).toBe(0);
    expect(d.getUTCSeconds()).toBe(0);
  });
});

describe('isoDate', () => {
  it('formats a fixed UTC instant as YYYY-MM-DD', () => {
    // 2026-06-09T15:30:00Z
    expect(isoDate(Date.UTC(2026, 5, 9, 15, 30), true)).toBe('2026-06-09');
  });

  it('zero-pads single-digit months and days', () => {
    expect(isoDate(Date.UTC(2026, 0, 3, 12), true)).toBe('2026-01-03');
  });
});

describe('midnightDaysAgo', () => {
  it('offset 0 equals midnightMs', () => {
    expect(midnightDaysAgo(0, false)).toBe(midnightMs(false));
    expect(midnightDaysAgo(0, true)).toBe(midnightMs(true));
  });

  it('walks back the requested number of calendar days', () => {
    const today = isoDate(midnightDaysAgo(0, true), true);
    const sixBack = isoDate(midnightDaysAgo(6, true), true);
    expect(sixBack < today).toBe(true);
    // exactly 6 days earlier on the calendar
    const a = new Date(`${today}T00:00:00Z`).getTime();
    const b = new Date(`${sixBack}T00:00:00Z`).getTime();
    expect(Math.round((a - b) / 86_400_000)).toBe(6);
  });
});
