// Read-only lifecycle probe for the Copilot Chat OTel store (agent-traces.db).
//
// Samples the database at a fixed interval and records — to a CSV and the
// console — the signals that distinguish the possible data-lifecycle causes:
//
//   * file identity (inode) + size + mtime of db / -wal / -shm
//       → inode change  = the file was deleted & recreated (full reset)
//       → inode same but MIN(start_time) jumps = in-place DELETE (truncate/prune)
//   * per-operation MIN(start_time_ms) / MAX(end_time_ms)
//       → a global time cutoff would move ALL ops' MIN together
//       → chat-only shrink with execute_tool intact ⇒ NOT a global cutoff
//   * chat counts + token sums
//       → detects the "lower than an hour ago" drop quantitatively
//
// Read-only: opens with { readOnly: true } and never writes to the DB.
//
// Usage:
//   node scripts/lifecycle-probe.mjs [--interval=30] [--count=Infinity]
//        [--out=/tmp/copilot-price-lifecycle.csv] [--db=/path/to/agent-traces.db]

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite');

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

const DEFAULT_DB = path.join(
  os.homedir(),
  'Library/Application Support/Code - Insiders/User/globalStorage/github.copilot-chat/agent-traces.db',
);
const DB = args.db || process.env.COPILOT_PRICE_DB || DEFAULT_DB;
const INTERVAL_MS = (Number(args.interval) || 30) * 1000;
const MAX_SAMPLES = args.count ? Number(args.count) : Infinity;
const OUT = args.out || path.join(os.tmpdir(), 'copilot-price-lifecycle.csv');

const COLUMNS = [
  'sample_iso',
  'db_ino',
  'db_size',
  'db_mtime_iso',
  'wal_size',
  'shm_size',
  'total_spans',
  'chat_count',
  'chat_input',
  'chat_output',
  'chat_cached',
  'chat_min_start_iso',
  'chat_max_end_iso',
  'exec_count',
  'exec_min_start_iso',
  'invoke_count',
  'invoke_min_start_iso',
  'all_min_start_iso',
  'all_max_end_iso',
  'note',
];

function statSafe(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function iso(ms) {
  if (ms === null || ms === undefined) return '';
  const n = typeof ms === 'bigint' ? Number(ms) : ms;
  if (!Number.isFinite(n) || n <= 0) return '';
  return new Date(n).toISOString();
}

function num(v) {
  if (v === null || v === undefined) return 0;
  const n = typeof v === 'bigint' ? Number(v) : v;
  return Number.isFinite(n) ? n : 0;
}

function sample() {
  const sampleIso = new Date().toISOString();
  const dbStat = statSafe(DB);
  const walStat = statSafe(`${DB}-wal`);
  const shmStat = statSafe(`${DB}-shm`);

  const row = {
    sample_iso: sampleIso,
    db_ino: dbStat ? dbStat.ino : '',
    db_size: dbStat ? dbStat.size : '',
    db_mtime_iso: dbStat ? new Date(dbStat.mtimeMs).toISOString() : '',
    wal_size: walStat ? walStat.size : '',
    shm_size: shmStat ? shmStat.size : '',
    total_spans: '',
    chat_count: '',
    chat_input: '',
    chat_output: '',
    chat_cached: '',
    chat_min_start_iso: '',
    chat_max_end_iso: '',
    exec_count: '',
    exec_min_start_iso: '',
    invoke_count: '',
    invoke_min_start_iso: '',
    all_min_start_iso: '',
    all_max_end_iso: '',
    note: '',
  };

  if (!dbStat) {
    row.note = 'DB_MISSING';
    return row;
  }

  let db;
  try {
    db = new DatabaseSync(DB, { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout = 3000');
    } catch {
      // non-fatal
    }

    const total = db.prepare('SELECT COUNT(*) c FROM spans').get();
    row.total_spans = num(total?.c);

    const chat = db
      .prepare(
        "SELECT COUNT(*) c, COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o, " +
          "COALESCE(SUM(cached_tokens),0) ca, MIN(start_time_ms) mn, MAX(end_time_ms) mx " +
          "FROM spans WHERE operation_name='chat'",
      )
      .get();
    row.chat_count = num(chat?.c);
    row.chat_input = num(chat?.i);
    row.chat_output = num(chat?.o);
    row.chat_cached = num(chat?.ca);
    row.chat_min_start_iso = iso(chat?.mn);
    row.chat_max_end_iso = iso(chat?.mx);

    const exec = db
      .prepare("SELECT COUNT(*) c, MIN(start_time_ms) mn FROM spans WHERE operation_name='execute_tool'")
      .get();
    row.exec_count = num(exec?.c);
    row.exec_min_start_iso = iso(exec?.mn);

    const invoke = db
      .prepare("SELECT COUNT(*) c, MIN(start_time_ms) mn FROM spans WHERE operation_name='invoke_agent'")
      .get();
    row.invoke_count = num(invoke?.c);
    row.invoke_min_start_iso = iso(invoke?.mn);

    const all = db.prepare('SELECT MIN(start_time_ms) mn, MAX(end_time_ms) mx FROM spans').get();
    row.all_min_start_iso = iso(all?.mn);
    row.all_max_end_iso = iso(all?.mx);
  } catch (err) {
    row.note = `READ_ERROR:${(err && err.message) || err}`;
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }

  return row;
}

function toCsvLine(row) {
  return COLUMNS.map((k) => {
    const v = row[k];
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',');
}

// Per-operation MIN(start)/MAX(end) breakdown — printed to console (not CSV) so
// we can see whether a shrink is global (all ops) or chat-only.
function perOpBreakdown() {
  let db;
  try {
    db = new DatabaseSync(DB, { readOnly: true });
    return db
      .prepare(
        "SELECT operation_name op, COUNT(*) n, MIN(start_time_ms) mn, MAX(end_time_ms) mx " +
          'FROM spans GROUP BY operation_name ORDER BY mn',
      )
      .all()
      .map((r) => `${r.op}: n=${num(r.n)} [${iso(r.mn)} … ${iso(r.mx)}]`);
  } catch {
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

if (!fs.existsSync(OUT)) {
  fs.writeFileSync(OUT, COLUMNS.join(',') + '\n');
}

console.error(`[lifecycle-probe] db=${DB}`);
console.error(`[lifecycle-probe] out=${OUT}  interval=${INTERVAL_MS / 1000}s  max=${MAX_SAMPLES}`);
console.error(`[lifecycle-probe] baseline per-op:`);
for (const line of perOpBreakdown()) console.error(`    ${line}`);

let prev = null;
let n = 0;

function tick() {
  const row = sample();
  fs.appendFileSync(OUT, toCsvLine(row) + '\n');

  const flags = [];
  if (prev) {
    if (prev.db_ino !== row.db_ino) flags.push('⚠INODE_CHANGED(file recreated)');
    if (prev.chat_min_start_iso && row.chat_min_start_iso && prev.chat_min_start_iso !== row.chat_min_start_iso)
      flags.push(`⚠CHAT_MIN_MOVED ${prev.chat_min_start_iso}→${row.chat_min_start_iso}`);
    if (prev.exec_min_start_iso && row.exec_min_start_iso && prev.exec_min_start_iso !== row.exec_min_start_iso)
      flags.push(`⚠EXEC_MIN_MOVED ${prev.exec_min_start_iso}→${row.exec_min_start_iso}`);
    if (prev.all_min_start_iso && row.all_min_start_iso && prev.all_min_start_iso !== row.all_min_start_iso)
      flags.push(`⚠ALL_MIN_MOVED ${prev.all_min_start_iso}→${row.all_min_start_iso}`);
    if (Number(row.chat_count) < Number(prev.chat_count))
      flags.push(`⚠CHAT_COUNT_DROP ${prev.chat_count}→${row.chat_count}`);
    if (Number(row.exec_count) < Number(prev.exec_count))
      flags.push(`⚠EXEC_COUNT_DROP ${prev.exec_count}→${row.exec_count}`);
    if (Number(row.total_spans) < Number(prev.total_spans))
      flags.push(`⚠TOTAL_DROP ${prev.total_spans}→${row.total_spans}`);
  }

  console.error(
    `[${row.sample_iso}] ino=${row.db_ino} wal=${row.wal_size} total=${row.total_spans} ` +
      `chat=${row.chat_count}(min ${row.chat_min_start_iso || '-'}) ` +
      `exec=${row.exec_count}(min ${row.exec_min_start_iso || '-'}) ` +
      `invoke=${row.invoke_count}(min ${row.invoke_min_start_iso || '-'}) ${row.note}` +
      (flags.length ? `  ${flags.join('  ')}` : ''),
  );

  prev = row;
  n += 1;
  if (n >= MAX_SAMPLES) {
    console.error('[lifecycle-probe] done.');
    return;
  }
  setTimeout(tick, INTERVAL_MS);
}

tick();
