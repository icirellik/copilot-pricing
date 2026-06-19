// Day-boundary helpers shared by the report and the league features. "Today"
// is defined once here so the number a user publishes to the leaderboard is the
// SAME total their own report shows (same since-boundary → same aggregation).

/** Epoch ms of the most recent midnight (local by default, or UTC). */
export function midnightMs(utc: boolean): number {
  const now = new Date();
  if (utc) {
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  }
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Epoch ms of midnight `dayOffset` CALENDAR days before today (local or UTC).
 * Walks by calendar date rather than subtracting 86.4M ms so it stays correct
 * across DST transitions (a local "day" isn't always 24h).
 */
export function midnightDaysAgo(dayOffset: number, utc: boolean): number {
  const now = new Date();
  if (utc) {
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - dayOffset);
  }
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - dayOffset);
  return d.getTime();
}

/** The YYYY-MM-DD calendar date of an epoch ms, read in local (or UTC) tz. */
export function isoDate(ms: number, utc: boolean): string {
  const d = new Date(ms);
  const y = utc ? d.getUTCFullYear() : d.getFullYear();
  const m = (utc ? d.getUTCMonth() : d.getMonth()) + 1;
  const day = utc ? d.getUTCDate() : d.getDate();
  return `${y}-${pad2(m)}-${pad2(day)}`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
