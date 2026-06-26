#!/usr/bin/env node
import { existsSync, realpathSync } from 'node:fs';
import * as os from 'node:os';
import { command, flag, optional, option, run, string } from 'cmd-ts';
import pc from 'picocolors';
import { listDbCandidates, resolveDbPath } from './dbLocator';
import { buildReport, formatJson, formatReport, type SourceBreakdownRow, type SourceBucket, type UsageCoverage } from './format';
import { openUsageStore, resolveStorePath, type UsageStore } from './ingestStore';
import { errorMessage, log, setDebug } from './logger';
import { createOTelReader, type OTelReader, type PerModelAggregate } from './otelReader';
import {
  decodeJoinCode,
  defaultHandle,
  encodeJoinCode,
  loadLeague,
  resolveLeaguePath,
  saveLeague,
  type LeagueConfig,
} from './league';
import {
  fetchLeaderboard,
  LeagueError,
  publish,
  publishBatch,
  type DayTotal,
  type LeaderboardWindow,
} from './leagueClient';
import { renderLeaderboard } from './leagueFormat';
import {
  defaultLogPath,
  renderSchedule,
  resolveTarget,
  type ScheduleContext,
  type ScheduleTarget,
} from './schedule';
import { isoDate, midnightDaysAgo, midnightMs, monthStartMs } from './time';
import { loadRateCard } from './tokenRates';

const SCHEDULE_TARGETS = new Set(['auto', 'launchd', 'cron', 'systemd']);

const VERSION = '1.0.0';

function shouldColor(noColor: boolean): boolean {
  return !noColor && !!process.stdout.isTTY && pc.isColorSupported;
}

function printMissingDb(searchedExplicit: string | undefined, useColor: boolean, json: boolean): void {
  const candidates = listDbCandidates();
  if (json) {
    process.stdout.write(
      JSON.stringify(
        {
          status: 'no-database',
          message: 'Copilot Chat OTel database (agent-traces.db) not found.',
          searched: searchedExplicit ? [searchedExplicit] : candidates.map((c) => c.path),
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }
  const c = useColor ? pc : null;
  const bold = (s: string) => (c ? c.bold(s) : s);
  const dim = (s: string) => (c ? c.dim(s) : s);
  const yellow = (s: string) => (c ? c.yellow(s) : s);

  const lines: string[] = [];
  lines.push(yellow("Couldn't find Copilot Chat's usage database (agent-traces.db)."));
  lines.push('');
  if (searchedExplicit) {
    lines.push(dim(`Looked for: ${searchedExplicit}`));
  } else {
    lines.push(dim('Searched these locations:'));
    for (const cand of candidates) {
      lines.push(dim(`  ${cand.exists ? '✓' : '✗'} ${cand.path}`));
    }
  }
  lines.push('');
  lines.push(bold('To start recording usage:'));
  lines.push('  1. Make sure GitHub Copilot is enabled in VS Code (it is currently disabled if');
  lines.push(`     ${dim('"github.copilot.enable": {"*": false}')} is set).`);
  lines.push('  2. Enable the OTel exporter in settings.json:');
  lines.push(`     ${dim('"github.copilot.chat.otel.dbSpanExporter.enabled": true')}`);
  lines.push('  3. Reload the VS Code window, then use Copilot Chat.');
  lines.push('  4. Re-run ' + bold('copilot-price') + ' (or ' + bold('copilot-price --doctor') + ' to inspect).');
  process.stdout.write(lines.join('\n') + '\n');
}

interface StoreInfo {
  path: string;
  exists: boolean;
  rows?: number;
  capturedToday?: number;
  earliestTodayMs?: number | null;
  lastIngestMs?: number | null;
  error?: string;
}

/** Read-only snapshot of the durable store for doctor (never creates it). */
function inspectStore(storePath: string): StoreInfo {
  if (!existsSync(storePath)) {
    return { path: storePath, exists: false };
  }
  try {
    const store = openUsageStore(storePath);
    try {
      const since = midnightMs(false);
      const agg = store.aggregateSince(since);
      return {
        path: storePath,
        exists: true,
        rows: store.totalRows(),
        capturedToday: agg.reduce((n, a) => n + a.chats, 0),
        earliestTodayMs: store.earliestEndSince(since) || null,
        lastIngestMs: store.lastIngestMs() || null,
      };
    } finally {
      store.close();
    }
  } catch (e) {
    return { path: storePath, exists: true, error: errorMessage(e) };
  }
}

function printDoctor(dbPath: string | null, storePath: string, useColor: boolean, json: boolean): void {
  const candidates = listDbCandidates();
  const available = dbPath && existsSync(dbPath);
  let diagnostics: { totalChatSpans: number; latestSpanMs: number; models: string[] } | null = null;
  let queryable = false;
  if (available) {
    const reader = createOTelReader(dbPath);
    queryable = reader.isAvailable();
    if (queryable) {
      diagnostics = reader.getDiagnostics();
    }
    reader.close();
  }

  const storeInfo = inspectStore(storePath);

  if (json) {
    process.stdout.write(
      JSON.stringify(
        { platform: process.platform, resolvedDb: dbPath, queryable, candidates, diagnostics, store: storeInfo },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  const c = useColor ? pc : null;
  const bold = (s: string) => (c ? c.bold(s) : s);
  const dim = (s: string) => (c ? c.dim(s) : s);
  const green = (s: string) => (c ? c.green(s) : s);
  const yellow = (s: string) => (c ? c.yellow(s) : s);

  const lines: string[] = [];
  lines.push(bold('copilot-price doctor'));
  lines.push(dim(`platform: ${process.platform}   node: ${process.version}`));
  lines.push('');
  lines.push(bold('Editor databases searched:'));
  for (const cand of candidates) {
    const mark = cand.exists ? green('✓ found') : dim('✗ missing');
    lines.push(`  ${mark}  ${cand.editor}`);
    lines.push(dim(`           ${cand.path}`));
  }
  lines.push('');
  lines.push(bold('Resolved database: ') + (dbPath ? dbPath : yellow('none')));
  if (dbPath && !available) {
    lines.push(yellow('  (path does not exist)'));
  } else if (available && !queryable) {
    lines.push(yellow('  (file present but not queryable yet — Copilot Chat may still be initializing it; reload the window)'));
  } else if (diagnostics) {
    lines.push('');
    lines.push(bold('Recorded chat spans in source (live, prunable):'));
    lines.push(`  count:  ${diagnostics.totalChatSpans.toLocaleString('en-US')}`);
    lines.push(
      `  latest: ${diagnostics.latestSpanMs ? new Date(diagnostics.latestSpanMs).toLocaleString() : dim('none')}`,
    );
    lines.push(`  models: ${diagnostics.models.length ? diagnostics.models.join(', ') : dim('none')}`);
    if (diagnostics.totalChatSpans === 0) {
      lines.push('');
      lines.push(yellow('No chat spans recorded yet. Enable OTel and use Copilot Chat (see `copilot-price` for steps).'));
    }
  }

  lines.push('');
  lines.push(bold('Durable store (our own copy, survives Copilot pruning):'));
  lines.push(dim(`  ${storeInfo.path}`));
  if (!storeInfo.exists) {
    lines.push(dim('  not created yet — run `copilot-price` once to start capturing'));
  } else if (storeInfo.error) {
    lines.push(yellow(`  error: ${storeInfo.error}`));
  } else {
    lines.push(`  total chats kept: ${(storeInfo.rows ?? 0).toLocaleString('en-US')}`);
    lines.push(`  captured today:   ${(storeInfo.capturedToday ?? 0).toLocaleString('en-US')}`);
    lines.push(
      `  earliest today:   ${storeInfo.earliestTodayMs ? new Date(storeInfo.earliestTodayMs).toLocaleString() : dim('none')}`,
    );
    lines.push(
      `  last ingest:      ${storeInfo.lastIngestMs ? new Date(storeInfo.lastIngestMs).toLocaleString() : dim('never')}`,
    );
  }

  process.stdout.write(lines.join('\n') + '\n');
}

const DEFAULT_INTERVAL_SEC = 60;
const MIN_INTERVAL_SEC = 5;

function parseIntervalSec(raw?: string): number {
  const n = raw === undefined ? DEFAULT_INTERVAL_SEC : Number(raw);
  if (!Number.isFinite(n)) {
    return DEFAULT_INTERVAL_SEC;
  }
  return Math.max(MIN_INTERVAL_SEC, Math.floor(n));
}

/** Mirror the source's chat spans into the store. null = source unavailable. */
function runIngest(dbPath: string | null, store: UsageStore, nowMs: number): { seen: number; inserted: number } | null {
  if (!dbPath || !existsSync(dbPath)) {
    return null;
  }
  const reader = createOTelReader(dbPath);
  try {
    if (!reader.isAvailable()) {
      return null;
    }
    return store.ingest(reader.readChatSpans(), nowMs);
  } finally {
    reader.close();
  }
}

function printIngestSummary(res: { seen: number; inserted: number } | null, store: UsageStore, json: boolean): void {
  if (json) {
    process.stdout.write(
      JSON.stringify({
        seen: res?.seen ?? 0,
        inserted: res?.inserted ?? 0,
        totalRows: store.totalRows(),
        sourceAvailable: res !== null,
      }) + '\n',
    );
    return;
  }
  if (!res) {
    process.stdout.write('source unavailable — nothing ingested\n');
    return;
  }
  process.stdout.write(`Captured ${res.inserted} new of ${res.seen} chat spans → ${store.path} (total ${store.totalRows()})\n`);
}

function runWatch(
  dbPath: string | null,
  store: UsageStore,
  intervalSec: number,
  pubCtx: { cfg: LeagueConfig; utc: boolean } | null,
): void {
  const tick = (): void => {
    const res = runIngest(dbPath, store, Date.now());
    const ts = new Date().toLocaleTimeString();
    if (res) {
      process.stderr.write(`[${ts}] ingest: ${res.seen} seen, ${res.inserted} new (total ${store.totalRows()})\n`);
    } else {
      process.stderr.write(`[${ts}] source unavailable; retrying in ${intervalSec}s\n`);
    }
    // Best-effort publish AFTER ingest — fire-and-forget so a slow/failed network
    // call can never stall or abort the ingest loop. `date` is recomputed inside
    // (via the current time) so a midnight rollover starts a fresh day's row.
    if (pubCtx) {
      void publishTodayBestEffort(pubCtx.cfg, store, pubCtx.utc);
    }
  };
  process.stderr.write(
    `watching: ingesting every ${intervalSec}s${pubCtx ? ' and publishing to the league' : ''} — Ctrl-C to stop\n`,
  );
  tick();
  const timer = setInterval(tick, intervalSec * 1000);
  process.on('SIGINT', () => {
    clearInterval(timer);
    store.close();
    process.stderr.write('\nstopped.\n');
    process.exit(0);
  });
}

function printSchedule(targetRaw: string, intervalSec: number, storeOpt: string | undefined, dbOpt: string | undefined, utc: boolean): void {
  if (!SCHEDULE_TARGETS.has(targetRaw)) {
    process.stderr.write(`Unknown --schedule target "${targetRaw}". Use one of: auto, launchd, cron, systemd.\n`);
    process.exitCode = 1;
    return;
  }
  const target = resolveTarget(targetRaw as ScheduleTarget);

  const extraArgs: string[] = [];
  if (storeOpt) {
    extraArgs.push('--store', storeOpt);
  }
  if (dbOpt) {
    extraArgs.push('--db', dbOpt);
  }
  if (utc) {
    extraArgs.push('--utc');
  }

  let scriptPath = process.argv[1] ?? '';
  try {
    scriptPath = realpathSync(scriptPath);
  } catch {
    // fall back to the raw argv path
  }

  const ctx: ScheduleContext = {
    nodePath: process.execPath,
    scriptPath,
    intervalSec,
    extraArgs,
    logPath: defaultLogPath(),
    home: os.homedir(),
  };
  const { unit, hints } = renderSchedule(target, ctx);
  process.stdout.write(unit);
  process.stderr.write(`\n# ${target}: this only prints — copilot-price installs nothing.\n`);
  for (const h of hints) {
    process.stderr.write(`# ${h}\n`);
  }
}

/** Price each source bucket via buildReport so the parts sum to the headline AIC. */
function buildBreakdown(bucketRows: Array<PerModelAggregate & { bucket: SourceBucket }>, sinceMs: number): SourceBreakdownRow[] {
  const order: Array<{ bucket: SourceBucket; label: string }> = [
    { bucket: 'direct', label: 'Direct chats' },
    { bucket: 'subagent', label: 'Subagents' },
    { bucket: 'background', label: 'Background' },
  ];
  const out: SourceBreakdownRow[] = [];
  for (const { bucket, label } of order) {
    const aggs = bucketRows.filter((r) => r.bucket === bucket);
    if (aggs.length === 0) {
      continue;
    }
    const rep = buildReport(aggs, sinceMs);
    out.push({ bucket, label, requests: rep.totals.chats, aic: rep.totals.aic });
  }
  return out;
}

// --- League (friends leaderboard) --------------------------------------------

/** Load the saved league config, or print a friendly error and return null. */
function requireLeague(): LeagueConfig | null {
  let cfg: LeagueConfig | null;
  try {
    cfg = loadLeague(resolveLeaguePath());
  } catch (e) {
    process.stderr.write('copilot-price: ' + errorMessage(e) + '\n');
    process.exitCode = 1;
    return null;
  }
  if (!cfg) {
    process.stderr.write(
      "copilot-price: you haven't joined a league yet. Run: copilot-price --join <code> --handle <you>\n",
    );
    process.exitCode = 1;
    return null;
  }
  return cfg;
}

/** Load league config without failing — for the watch/ingest publish side-effect. */
function loadLeagueQuiet(): LeagueConfig | null {
  try {
    return loadLeague(resolveLeaguePath());
  } catch (e) {
    log('league config unreadable: ' + errorMessage(e));
    return null;
  }
}

function reportLeagueError(e: unknown): void {
  process.stderr.write('copilot-price: ' + (e instanceof LeagueError ? e.message : errorMessage(e)) + '\n');
  process.exitCode = 1;
}

/** Today's publishable total from the store. Assumes the rate card is loaded. */
function todayEntry(store: UsageStore, utc: boolean): DayTotal {
  const since = midnightMs(utc);
  return { date: isoDate(since, utc), totalAic: buildReport(store.aggregateSince(since), since).totals.aic };
}

/** Compute, then publish today's total; errors are swallowed (best-effort). */
function publishTodayBestEffort(cfg: LeagueConfig, store: UsageStore, utc: boolean): Promise<void> {
  let entry: DayTotal;
  try {
    entry = todayEntry(store, utc);
  } catch (e) {
    log('publish prep failed: ' + errorMessage(e));
    return Promise.resolve();
  }
  return publish(cfg, entry).catch((e) => log('publish failed: ' + errorMessage(e)));
}

function runMakeLeagueCode(api: string | undefined, token: string | undefined, league: string | undefined): void {
  if (!api || !token || !league) {
    process.stderr.write('copilot-price: --make-league-code needs --api, --token, and --league.\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write(encodeJoinCode({ apiUrl: api, token, league }) + '\n');
  process.stderr.write('# Share this code privately — it contains your league secret (treat it like a password).\n');
  process.stderr.write('# Friends run: copilot-price --join <code> --handle <name>\n');
}

function runJoin(code: string, handleOpt: string | undefined): void {
  let payload;
  try {
    payload = decodeJoinCode(code);
  } catch (e) {
    process.stderr.write('copilot-price: ' + errorMessage(e) + '\n');
    process.exitCode = 1;
    return;
  }
  const handle = (handleOpt ?? defaultHandle()).trim();
  if (!handle) {
    process.stderr.write('copilot-price: provide --handle <name> (your name on the board).\n');
    process.exitCode = 1;
    return;
  }
  const cfg: LeagueConfig = { ...payload, handle };
  saveLeague(resolveLeaguePath(), cfg);
  process.stdout.write(
    `Joined league '${cfg.league}' as ${handle}.\n` +
      "Run `copilot-price --publish` to post today's usage, or `copilot-price --leaderboard` to see the board.\n",
  );
}

async function runLeaderboard(
  cfg: LeagueConfig,
  window: LeaderboardWindow,
  utc: boolean,
  json: boolean,
  useColor: boolean,
): Promise<void> {
  const date = isoDate(midnightMs(utc), utc);
  const from = isoDate(midnightDaysAgo(6, utc), utc);
  try {
    const result = await fetchLeaderboard(cfg, { window, date, from });
    if (json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else {
      process.stdout.write(renderLeaderboard(result, { self: cfg.handle, league: cfg.league, useColor }));
    }
  } catch (e) {
    reportLeagueError(e);
  }
}

/** Open the store for a manual publish/backfill, or print an error and return null. */
function openStoreForPublish(storeOpt: string | undefined): UsageStore | null {
  try {
    return openUsageStore(resolveStorePath(storeOpt));
  } catch (e) {
    process.stderr.write('copilot-price: could not open durable store: ' + errorMessage(e) + '\n');
    process.exitCode = 1;
    return null;
  }
}

async function runPublish(
  cfg: LeagueConfig,
  dbPath: string | null,
  storeOpt: string | undefined,
  utc: boolean,
  dryRun: boolean,
  json: boolean,
  useColor: boolean,
): Promise<void> {
  loadRateCard();
  const store = openStoreForPublish(storeOpt);
  if (!store) {
    return;
  }
  try {
    runIngest(dbPath, store, Date.now()); // best-effort capture of the latest spans
    const entry = todayEntry(store, utc);

    if (dryRun) {
      process.stdout.write(JSON.stringify({ league: cfg.league, handle: cfg.handle, ...entry }, null, 2) + '\n');
      process.stderr.write('# --dry-run: nothing was sent.\n');
      return;
    }

    try {
      await publish(cfg, entry);
    } catch (e) {
      reportLeagueError(e);
      return;
    }

    // Publish succeeded — show today's board so you see your rank.
    try {
      const result = await fetchLeaderboard(cfg, {
        window: 'today',
        date: entry.date,
        from: isoDate(midnightDaysAgo(6, utc), utc),
      });
      if (json) {
        process.stdout.write(JSON.stringify({ published: entry, leaderboard: result }, null, 2) + '\n');
      } else {
        process.stdout.write(`Published ${entry.totalAic.toFixed(2)} AIC for ${entry.date}.\n\n`);
        process.stdout.write(renderLeaderboard(result, { self: cfg.handle, league: cfg.league, useColor }));
      }
    } catch (e) {
      if (json) {
        process.stdout.write(JSON.stringify({ published: entry }, null, 2) + '\n');
      } else {
        process.stdout.write(`Published ${entry.totalAic.toFixed(2)} AIC for ${entry.date}.\n`);
      }
      log('post-publish leaderboard fetch failed: ' + errorMessage(e));
    }
  } finally {
    store.close();
  }
}

async function runBackfill(
  cfg: LeagueConfig,
  nRaw: string,
  dbPath: string | null,
  storeOpt: string | undefined,
  utc: boolean,
  dryRun: boolean,
  json: boolean,
): Promise<void> {
  loadRateCard();
  const parsed = Number(nRaw);
  const n = Math.max(1, Math.min(90, Number.isFinite(parsed) ? Math.floor(parsed) : 7));
  const store = openStoreForPublish(storeOpt);
  if (!store) {
    return;
  }
  try {
    runIngest(dbPath, store, Date.now());
    const days: DayTotal[] = [];
    for (let i = 0; i < n; i++) {
      const dayStart = midnightDaysAgo(i, utc);
      const report = buildReport(store.aggregateBetween(dayStart, midnightDaysAgo(i - 1, utc)), dayStart);
      if (report.totals.chats > 0) {
        days.push({ date: isoDate(dayStart, utc), totalAic: report.totals.aic });
      }
    }

    if (days.length === 0) {
      process.stdout.write(`Nothing to backfill — no captured usage in the last ${n} day(s).\n`);
      return;
    }
    if (dryRun) {
      process.stdout.write(JSON.stringify({ league: cfg.league, handle: cfg.handle, days }, null, 2) + '\n');
      process.stderr.write('# --dry-run: nothing was sent.\n');
      return;
    }

    try {
      await publishBatch(cfg, days);
    } catch (e) {
      reportLeagueError(e);
      return;
    }
    if (json) {
      process.stdout.write(JSON.stringify({ backfilled: days }, null, 2) + '\n');
    } else {
      process.stdout.write(`Backfilled ${days.length} day(s) to league '${cfg.league}'.\n`);
    }
  } finally {
    store.close();
  }
}

const cmd = command({
  name: 'copilot-price',
  version: VERSION,
  description: "Show today's GitHub Copilot AI credit (AIC) usage, computed from local token counts.",
  args: {
    json: flag({ long: 'json', description: 'Output machine-readable JSON.' }),
    db: option({ long: 'db', type: optional(string), description: 'Path to agent-traces.db (overrides auto-detection).' }),
    store: option({ long: 'store', type: optional(string), description: 'Path to the durable usage store (overrides default).' }),
    utc: flag({ long: 'utc', description: 'Use UTC midnight instead of local midnight.' }),
    noIngest: flag({ long: 'no-ingest', description: 'Read the live source only; skip the durable store.' }),
    ingestOnly: flag({ long: 'ingest-only', description: 'Mirror new spans into the durable store and exit (for schedulers).' }),
    watch: flag({ long: 'watch', description: 'Continuously ingest on an interval until interrupted (installs nothing).' }),
    interval: option({
      long: 'interval',
      type: optional(string),
      description: 'Ingest cadence in seconds for --watch / --schedule (default 60).',
    }),
    schedule: option({
      long: 'schedule',
      type: optional(string),
      description: 'Print a scheduler unit (auto|launchd|cron|systemd) and exit; installs nothing.',
    }),
    doctor: flag({ long: 'doctor', description: 'Diagnose database detection, the durable store, and recorded usage.' }),
    breakdown: flag({ long: 'breakdown', description: "Break today's AIC down by source (direct chats / subagents / background)." }),
    debug: flag({ long: 'debug', description: 'Print debug logging to stderr.' }),
    noColor: flag({ long: 'no-color', description: 'Disable colored output.' }),
    // League (friends leaderboard).
    makeLeagueCode: flag({ long: 'make-league-code', description: 'Print a shareable league join code from --api/--token/--league.' }),
    api: option({ long: 'api', type: optional(string), description: 'League backend base URL (with --make-league-code).' }),
    token: option({ long: 'token', type: optional(string), description: 'Shared league secret (with --make-league-code).' }),
    league: option({ long: 'league', type: optional(string), description: 'League namespace (with --make-league-code).' }),
    join: option({ long: 'join', type: optional(string), description: 'Join a league from a code (pair with --handle).' }),
    handle: option({ long: 'handle', type: optional(string), description: 'Your name on the leaderboard (with --join).' }),
    publish: flag({ long: 'publish', description: "Publish today's total to the league (also works with --watch/--ingest-only)." }),
    backfill: option({ long: 'backfill', type: optional(string), description: 'Publish the last N days from the local store (≤90).' }),
    leaderboard: flag({ long: 'leaderboard', description: 'Show the league leaderboard (default today; see --week/--all-time).' }),
    week: flag({ long: 'week', description: 'With --leaderboard: show the this-week board.' }),
    allTime: flag({ long: 'all-time', description: 'With --leaderboard: show the all-time board.' }),
    dryRun: flag({ long: 'dry-run', description: 'With --publish/--backfill: print the exact payload and send nothing.' }),
  },
  handler: async (args) => {
    const {
      json,
      db,
      store: storeOpt,
      utc,
      noIngest,
      ingestOnly,
      watch,
      interval,
      schedule,
      doctor,
      breakdown,
      debug,
      noColor,
      makeLeagueCode,
      api,
      token,
      league,
      join,
      handle,
      publish: publishFlag,
      backfill,
      leaderboard,
      week,
      allTime,
      dryRun,
    } = args;
    setDebug(debug);
    const useColor = shouldColor(noColor);
    const dbPath = resolveDbPath(db);

    if (schedule !== undefined) {
      printSchedule(schedule, parseIntervalSec(interval), storeOpt, db, utc);
      return;
    }

    if (doctor) {
      printDoctor(dbPath, resolveStorePath(storeOpt), useColor, json);
      return;
    }

    // --- League modes (each is terminal) ---
    if (makeLeagueCode) {
      runMakeLeagueCode(api, token, league);
      return;
    }
    if (join !== undefined) {
      runJoin(join, handle);
      return;
    }
    if (backfill !== undefined && !watch && !ingestOnly) {
      if (noIngest) {
        process.stderr.write('copilot-price: --backfill reads the durable store; drop --no-ingest.\n');
        process.exitCode = 1;
        return;
      }
      const cfg = requireLeague();
      if (cfg) {
        await runBackfill(cfg, backfill, dbPath, storeOpt, utc, dryRun, json);
      }
      return;
    }
    if (publishFlag && !watch && !ingestOnly) {
      if (noIngest) {
        process.stderr.write('copilot-price: --publish reads the durable store; drop --no-ingest.\n');
        process.exitCode = 1;
        return;
      }
      const cfg = requireLeague();
      if (cfg) {
        await runPublish(cfg, dbPath, storeOpt, utc, dryRun, json, useColor);
      }
      return;
    }
    if (leaderboard) {
      if (week && allTime) {
        process.stderr.write('copilot-price: choose only one of --week / --all-time.\n');
        process.exitCode = 1;
        return;
      }
      const cfg = requireLeague();
      if (cfg) {
        const window: LeaderboardWindow = week ? 'week' : allTime ? 'all' : 'today';
        await runLeaderboard(cfg, window, utc, json, useColor);
      }
      return;
    }

    // Automation modes: mirror spans into the store without rendering a report.
    if (watch || ingestOnly) {
      if (noIngest) {
        process.stderr.write('--watch/--ingest-only cannot be combined with --no-ingest.\n');
        process.exitCode = 1;
        return;
      }
      let store: UsageStore;
      try {
        store = openUsageStore(resolveStorePath(storeOpt));
      } catch (e) {
        process.stderr.write('could not open durable store: ' + errorMessage(e) + '\n');
        process.exitCode = 1;
        return;
      }

      // Opt into auto-publish only if --publish is set AND a league is configured.
      let pubCtx: { cfg: LeagueConfig; utc: boolean } | null = null;
      if (publishFlag) {
        const cfg = loadLeagueQuiet();
        if (cfg) {
          loadRateCard(); // publishing prices the un-metered split via the rate card
          pubCtx = { cfg, utc };
        } else {
          process.stderr.write('copilot-price: --publish ignored — no league configured (run --join first).\n');
        }
      }

      if (watch) {
        runWatch(dbPath, store, parseIntervalSec(interval), pubCtx);
        return; // the interval loop owns the process lifetime
      }
      const res = runIngest(dbPath, store, Date.now());
      printIngestSummary(res, store, json);
      // One-shot: await the publish so it completes before we exit (errors swallowed).
      if (pubCtx) {
        await publishTodayBestEffort(pubCtx.cfg, store, pubCtx.utc);
      }
      store.close();
      return;
    }

    const since = midnightMs(utc);
    loadRateCard();

    // Open our durable store unless the user opted out.
    let store: UsageStore | null = null;
    if (!noIngest) {
      try {
        store = openUsageStore(resolveStorePath(storeOpt));
      } catch (e) {
        log('could not open durable store: ' + errorMessage(e));
        store = null;
      }
    }

    // Open the live source (if present) and mirror its chat spans into the store.
    let sourceReader: OTelReader | null = null;
    let sourceAvailable = false;
    let liveChatsToday = 0;
    if (dbPath && existsSync(dbPath)) {
      const reader = createOTelReader(dbPath);
      if (reader.isAvailable()) {
        sourceReader = reader;
        sourceAvailable = true;
        if (store) {
          try {
            const spans = reader.readChatSpans();
            const res = store.ingest(spans, Date.now());
            log(`ingest: ${res.seen} source chat spans, ${res.inserted} newly captured`);
          } catch (e) {
            log('ingest failed: ' + errorMessage(e));
          }
        }
        liveChatsToday = reader.aggregateSince(since).reduce((n, a) => n + a.chats, 0);
      } else {
        reader.close();
      }
    }

    try {
      let aggregates: PerModelAggregate[];
      let coverage: UsageCoverage;

      if (store) {
        aggregates = store.aggregateSince(since);
        const storeChatsToday = aggregates.reduce((n, a) => n + a.chats, 0);
        coverage = {
          source: 'store',
          earliestEndMs: store.earliestEndSince(since) || null,
          rescuedChats: sourceAvailable ? Math.max(0, storeChatsToday - liveChatsToday) : undefined,
        };
      } else if (sourceAvailable && sourceReader) {
        aggregates = sourceReader.aggregateSince(since);
        coverage = { source: 'live', earliestEndMs: sourceReader.earliestEndSince(since) || null };
      } else {
        printMissingDb(db ?? process.env.COPILOT_PRICE_DB, useColor, json);
        return;
      }

      // Nothing captured and no live source to read → guide the user to enable OTel.
      if (aggregates.length === 0 && !sourceAvailable) {
        printMissingDb(db ?? process.env.COPILOT_PRICE_DB, useColor, json);
        return;
      }

      const report = buildReport(aggregates, since, coverage);
      // Human chat-session count today (agent mode logs many model requests per
      // chat, so REQUESTS far exceeds the conversations a person opened).
      report.sessions = store ? store.sessionsSince(since) : sourceReader ? sourceReader.sessionsSince(since) : undefined;
      // Month-to-date headline, from the durable store only (the live source is
      // pruned and can't cover a whole month). aggregateSince(monthStart) is
      // month-to-date since there are no future spans.
      if (store) {
        const monthStart = monthStartMs(utc);
        const monthAic = buildReport(store.aggregateSince(monthStart), monthStart).totals.aic;
        report.monthToDate = { sinceMs: monthStart, aic: monthAic, usd: monthAic / 100 };
      }
      if (breakdown && store) {
        report.breakdown = buildBreakdown(store.bucketAggregateSince(since), since);
      } else if (breakdown && !store) {
        process.stderr.write('copilot-price: --breakdown needs the durable store (drop --no-ingest).\n');
      }
      process.stdout.write(json ? formatJson(report) + '\n' : formatReport(report, useColor));
    } finally {
      sourceReader?.close();
      store?.close();
    }
  },
});

void Promise.resolve(run(cmd, process.argv.slice(2))).catch((e) => {
  process.stderr.write('copilot-price: ' + errorMessage(e) + '\n');
  process.exitCode = 1;
});
