import pc from 'picocolors';
import type { PerModelAggregate } from './otelReader';
import { computeCost, getDisplayName, getRateCard } from './tokenRates';

export interface UsageRow {
  model: string;
  modelId: string;
  chats: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  aic: number;
  /** Whether the model matched a rate card (false → AIC could not be priced). */
  priced: boolean;
}

/** Where today's numbers came from and how complete they are. */
export interface UsageCoverage {
  /** 'store' = our durable copy (recommended); 'live' = source DB only. */
  source: 'store' | 'live';
  /** Earliest chat-span end time counted today (ms), or null if none. */
  earliestEndMs: number | null;
  /** Chats we retain that the live source has already pruned (store path only). */
  rescuedChats?: number;
}

export interface UsageReport {
  sinceMs: number;
  sinceIso: string;
  rows: UsageRow[];
  totals: {
    chats: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    tokens: number;
    aic: number;
    usd: number;
  };
  /** Models seen today with no rate-card match (their AIC is 0). */
  unpricedModels: string[];
  coverage?: UsageCoverage;
}

// If the earliest usage we can account for today starts more than this long
// after midnight, warn: anything before it may have been pruned before capture.
const COVERAGE_GAP_THRESHOLD_MS = 15 * 60 * 1000;

/** Build a priced usage report from raw per-model aggregates. */
export function buildReport(aggregates: PerModelAggregate[], sinceMs: number, coverage?: UsageCoverage): UsageReport {
  const rows: UsageRow[] = aggregates
    .map((a) => {
      const modelId = a.model ?? 'unknown';
      const priced = getRateCard(modelId) !== null;
      const aic = computeCost(modelId, {
        input: a.inputTokens,
        output: a.outputTokens,
        cacheRead: a.cacheReadTokens,
        cacheCreation: a.cacheCreationTokens,
      });
      return {
        model: getDisplayName(modelId),
        modelId,
        chats: a.chats,
        inputTokens: a.inputTokens,
        outputTokens: a.outputTokens,
        cacheReadTokens: a.cacheReadTokens,
        cacheCreationTokens: a.cacheCreationTokens,
        aic,
        priced,
      };
    })
    .sort((x, y) => y.aic - x.aic || y.inputTokens + y.outputTokens - (x.inputTokens + x.outputTokens));

  const totals = rows.reduce(
    (acc, r) => {
      acc.chats += r.chats;
      acc.inputTokens += r.inputTokens;
      acc.outputTokens += r.outputTokens;
      acc.cacheReadTokens += r.cacheReadTokens;
      acc.cacheCreationTokens += r.cacheCreationTokens;
      acc.aic += r.aic;
      return acc;
    },
    { chats: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, aic: 0, tokens: 0, usd: 0 },
  );
  totals.tokens = totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheCreationTokens;
  totals.usd = totals.aic / 100;

  return {
    sinceMs,
    sinceIso: new Date(sinceMs).toISOString(),
    rows,
    totals,
    unpricedModels: rows.filter((r) => !r.priced).map((r) => r.model),
    coverage,
  };
}

function num(n: number): string {
  return n.toLocaleString('en-US');
}

function aic(n: number): string {
  return n.toFixed(2);
}

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

interface Column {
  header: string;
  align: 'left' | 'right';
  value: (r: UsageRow) => string;
}

const COLUMNS: Column[] = [
  { header: 'MODEL', align: 'left', value: (r) => (r.priced ? r.model : `${r.model} *`) },
  { header: 'CHATS', align: 'right', value: (r) => num(r.chats) },
  { header: 'INPUT', align: 'right', value: (r) => num(r.inputTokens) },
  { header: 'OUTPUT', align: 'right', value: (r) => num(r.outputTokens) },
  { header: 'CACHE R', align: 'right', value: (r) => num(r.cacheReadTokens) },
  { header: 'CACHE W', align: 'right', value: (r) => num(r.cacheCreationTokens) },
  { header: 'AIC', align: 'right', value: (r) => aic(r.aic) },
];

function pad(text: string, width: number, align: 'left' | 'right'): string {
  if (text.length >= width) {
    return text;
  }
  const fill = ' '.repeat(width - text.length);
  return align === 'right' ? fill + text : text + fill;
}

/** Render the report as a human-readable, colorized table. */
export function formatReport(report: UsageReport, useColor = true): string {
  const c = useColor ? pc : noColor();
  const localSince = new Date(report.sinceMs).toLocaleString();
  const header = c.bold('Copilot AI credit usage') + c.dim(` — since ${localSince}`);

  if (report.rows.length === 0) {
    return `${header}\n\n${c.dim('No Copilot chat usage recorded yet today.')}\n`;
  }

  // Totals row reuses the same column formatting.
  const totalRow: UsageRow = {
    model: 'TOTAL',
    modelId: 'TOTAL',
    chats: report.totals.chats,
    inputTokens: report.totals.inputTokens,
    outputTokens: report.totals.outputTokens,
    cacheReadTokens: report.totals.cacheReadTokens,
    cacheCreationTokens: report.totals.cacheCreationTokens,
    aic: report.totals.aic,
    priced: true,
  };

  const bodyRows = [...report.rows, totalRow];
  const widths = COLUMNS.map((col) =>
    Math.max(col.header.length, ...bodyRows.map((r) => col.value(r).length)),
  );

  const renderCells = (cells: string[], colorize: (s: string) => string): string =>
    cells.map((cell, i) => colorize(pad(cell, widths[i], COLUMNS[i].align))).join('  ');

  const headerLine = renderCells(
    COLUMNS.map((col) => col.header),
    (s) => c.bold(c.cyan(s)),
  );
  const divider = c.dim(widths.map((w) => '─'.repeat(w)).join('  '));

  const dataLines = report.rows.map((r) =>
    renderCells(
      COLUMNS.map((col) => col.value(r)),
      (s) => s,
    ),
  );
  const totalLine = renderCells(
    COLUMNS.map((col) => col.value(totalRow)),
    (s) => c.bold(s),
  );

  const lines = [header, '', headerLine, divider, ...dataLines, divider, totalLine, ''];
  lines.push(
    c.bold(`Total: ${aic(report.totals.aic)} AIC`) + c.dim(`  (≈ ${usd(report.totals.usd)}, ${num(report.totals.tokens)} tokens)`),
  );
  if (report.unpricedModels.length > 0) {
    lines.push(c.yellow(`* not in rate card — AIC unpriced: ${report.unpricedModels.join(', ')}`));
  }
  for (const notice of coverageNotices(report, c)) {
    lines.push(notice);
  }
  return lines.join('\n') + '\n';
}

/** Coverage/accuracy notices (rescued spans, start-of-day gap) for the footer. */
function coverageNotices(report: UsageReport, c: typeof pc): string[] {
  const cov = report.coverage;
  if (!cov) {
    return [];
  }
  const out: string[] = [];

  if (cov.rescuedChats && cov.rescuedChats > 0) {
    out.push(
      c.green(`✓ Local store retained ${num(cov.rescuedChats)} chat(s) Copilot has already pruned from its own DB.`),
    );
  }

  if (report.totals.chats > 0 && cov.earliestEndMs && cov.earliestEndMs - report.sinceMs > COVERAGE_GAP_THRESHOLD_MS) {
    const t = new Date(cov.earliestEndMs).toLocaleTimeString();
    out.push(
      c.yellow(`⚠ Earliest usage counted today is ${t}.`) +
        c.dim(' Copilot prunes old chats; usage before then may be uncaptured — run copilot-price regularly to avoid gaps.'),
    );
  }

  return out;
}

/** Render the report as machine-readable JSON. */
export function formatJson(report: UsageReport): string {
  return JSON.stringify(report, null, 2);
}

// A no-op picocolors shim so --no-color / non-TTY output is plain.
function noColor(): typeof pc {
  const identity = (s: string | number) => String(s);
  return new Proxy({} as typeof pc, {
    get: (_t, prop) => (prop === 'isColorSupported' ? false : identity),
  });
}
