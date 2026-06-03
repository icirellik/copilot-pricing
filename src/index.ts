#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { command, flag, optional, option, run, string } from 'cmd-ts';
import pc from 'picocolors';
import { listDbCandidates, resolveDbPath } from './dbLocator';
import { buildReport, formatJson, formatReport, type UsageCoverage } from './format';
import { openUsageStore, resolveStorePath, type UsageStore } from './ingestStore';
import { errorMessage, log, setDebug } from './logger';
import { createOTelReader, type OTelReader, type PerModelAggregate } from './otelReader';
import { loadRateCard } from './tokenRates';

const VERSION = '1.0.0';

/** Epoch ms of the most recent midnight (local by default, or UTC). */
function midnightMs(utc: boolean): number {
  const now = new Date();
  if (utc) {
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  }
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

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
  }

  process.stdout.write(lines.join('\n') + '\n');
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
    doctor: flag({ long: 'doctor', description: 'Diagnose database detection, the durable store, and recorded usage.' }),
    debug: flag({ long: 'debug', description: 'Print debug logging to stderr.' }),
    noColor: flag({ long: 'no-color', description: 'Disable colored output.' }),
  },
  handler: ({ json, db, store: storeOpt, utc, noIngest, doctor, debug, noColor }) => {
    setDebug(debug);
    const useColor = shouldColor(noColor);
    const dbPath = resolveDbPath(db);

    if (doctor) {
      printDoctor(dbPath, resolveStorePath(storeOpt), useColor, json);
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
      process.stdout.write(json ? formatJson(report) + '\n' : formatReport(report, useColor));
    } finally {
      sourceReader?.close();
      store?.close();
    }
  },
});

run(cmd, process.argv.slice(2));
