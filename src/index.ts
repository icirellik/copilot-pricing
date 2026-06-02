#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { command, flag, optional, option, run, string } from 'cmd-ts';
import pc from 'picocolors';
import { listDbCandidates, resolveDbPath } from './dbLocator';
import { buildReport, formatJson, formatReport } from './format';
import { setDebug } from './logger';
import { createOTelReader } from './otelReader';
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

function printDoctor(dbPath: string | null, useColor: boolean, json: boolean): void {
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

  if (json) {
    process.stdout.write(
      JSON.stringify({ platform: process.platform, resolvedDb: dbPath, queryable, candidates, diagnostics }, null, 2) + '\n',
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
    lines.push(bold('Recorded chat spans (all-time):'));
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
  process.stdout.write(lines.join('\n') + '\n');
}

const cmd = command({
  name: 'copilot-price',
  version: VERSION,
  description: "Show today's GitHub Copilot AI credit (AIC) usage, computed from local token counts.",
  args: {
    json: flag({ long: 'json', description: 'Output machine-readable JSON.' }),
    db: option({ long: 'db', type: optional(string), description: 'Path to agent-traces.db (overrides auto-detection).' }),
    utc: flag({ long: 'utc', description: 'Use UTC midnight instead of local midnight.' }),
    doctor: flag({ long: 'doctor', description: 'Diagnose database detection and recorded usage.' }),
    debug: flag({ long: 'debug', description: 'Print debug logging to stderr.' }),
    noColor: flag({ long: 'no-color', description: 'Disable colored output.' }),
  },
  handler: ({ json, db, utc, doctor, debug, noColor }) => {
    setDebug(debug);
    const useColor = shouldColor(noColor);
    const dbPath = resolveDbPath(db);

    if (doctor) {
      printDoctor(dbPath, useColor, json);
      return;
    }

    if (!dbPath || !existsSync(dbPath)) {
      printMissingDb(db ?? process.env.COPILOT_PRICE_DB, useColor, json);
      return;
    }

    const reader = createOTelReader(dbPath);
    try {
      if (!reader.isAvailable()) {
        printMissingDb(dbPath, useColor, json);
        return;
      }
      loadRateCard();
      const since = midnightMs(utc);
      const aggregates = reader.aggregateSince(since);
      const report = buildReport(aggregates, since);
      process.stdout.write(json ? formatJson(report) + '\n' : formatReport(report, useColor));
    } finally {
      reader.close();
    }
  },
});

run(cmd, process.argv.slice(2));
