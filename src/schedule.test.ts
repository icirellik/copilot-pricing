import { describe, expect, it } from 'vitest';
import { renderSchedule, resolveTarget, SCHEDULE_LABEL, type ScheduleContext } from './schedule';

const CTX: ScheduleContext = {
  nodePath: '/usr/local/bin/node',
  scriptPath: '/opt/copilot-price/dist/index.js',
  intervalSec: 60,
  extraArgs: ['--store', '/data/usage.db'],
  logPath: '/home/u/.copilot-price/ingest.log',
  home: '/home/u',
};

describe('resolveTarget', () => {
  it('passes through explicit targets', () => {
    expect(resolveTarget('launchd')).toBe('launchd');
    expect(resolveTarget('cron')).toBe('cron');
    expect(resolveTarget('systemd')).toBe('systemd');
  });

  it('maps auto to the platform default', () => {
    expect(resolveTarget('auto', 'darwin')).toBe('launchd');
    expect(resolveTarget('auto', 'linux')).toBe('systemd');
    expect(resolveTarget('auto', 'win32')).toBe('cron');
  });
});

describe('renderSchedule (launchd)', () => {
  const { unit, hints } = renderSchedule('launchd', CTX);

  it('embeds node, script, --ingest-only and extra args as ProgramArguments', () => {
    expect(unit).toContain('<string>/usr/local/bin/node</string>');
    expect(unit).toContain('<string>/opt/copilot-price/dist/index.js</string>');
    expect(unit).toContain('<string>--ingest-only</string>');
    expect(unit).toContain('<string>--store</string>');
    expect(unit).toContain('<string>/data/usage.db</string>');
  });

  it('sets the label, interval, and log paths', () => {
    expect(unit).toContain(`<string>${SCHEDULE_LABEL}</string>`);
    expect(unit).toContain('<key>StartInterval</key>\n  <integer>60</integer>');
    expect(unit).toContain('/home/u/.copilot-price/ingest.log');
  });

  it('hints at launchctl install/uninstall', () => {
    expect(hints.join('\n')).toMatch(/launchctl bootstrap/);
    expect(hints.join('\n')).toMatch(/launchctl bootout/);
  });

  it('escapes XML-special characters in paths', () => {
    const { unit: u } = renderSchedule('launchd', { ...CTX, scriptPath: '/opt/a&b/index.js' });
    expect(u).toContain('/opt/a&amp;b/index.js');
    expect(u).not.toContain('/opt/a&b/index.js');
  });
});

describe('renderSchedule (cron)', () => {
  it('produces a one-minute crontab line with quoted, --ingest-only invocation', () => {
    const { unit } = renderSchedule('cron', CTX);
    expect(unit.startsWith('* * * * * ')).toBe(true);
    expect(unit).toContain('"/usr/local/bin/node" "/opt/copilot-price/dist/index.js" --ingest-only');
    expect(unit).toContain('--store "/data/usage.db"');
  });

  it('warns when the requested interval is not 60s (cron is minute-granular)', () => {
    const { hints } = renderSchedule('cron', { ...CTX, intervalSec: 30 });
    expect(hints.join('\n')).toMatch(/1 minute/);
  });
});

describe('renderSchedule (systemd)', () => {
  it('emits a oneshot service and a timer with the requested cadence', () => {
    const { unit } = renderSchedule('systemd', { ...CTX, intervalSec: 45 });
    expect(unit).toContain('Type=oneshot');
    expect(unit).toContain('ExecStart="/usr/local/bin/node" "/opt/copilot-price/dist/index.js" --ingest-only');
    expect(unit).toContain('OnUnitActiveSec=45');
    expect(unit).toContain('[Timer]');
  });
});
