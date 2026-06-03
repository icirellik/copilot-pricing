import * as os from 'node:os';
import * as path from 'node:path';

// Generates ready-to-install scheduler units that run `copilot-price
// --ingest-only` on a cadence. The app NEVER installs these itself — it only
// prints them; the user decides whether and how to install. The unit body goes
// to stdout (so it can be redirected straight to a file); install/uninstall
// hints go to stderr (see index.ts), so a redirect captures only the unit.

export type ScheduleTarget = 'auto' | 'launchd' | 'cron' | 'systemd';

export const SCHEDULE_LABEL = 'com.icirellik.copilot-price';

export interface ScheduleContext {
  /** Absolute path to the node binary (process.execPath). */
  nodePath: string;
  /** Absolute path to the CLI entry script (resolved process.argv[1]). */
  scriptPath: string;
  /** Ingest cadence in seconds. */
  intervalSec: number;
  /** Extra args to embed (e.g. ['--store', '/p', '--utc']). */
  extraArgs: string[];
  /** Where ingest stdout/stderr is logged. */
  logPath: string;
  /** Home dir (for hint paths). */
  home: string;
}

export interface RenderedSchedule {
  /** The unit text — intended for stdout / redirection to a file. */
  unit: string;
  /** Human install/uninstall guidance — intended for stderr. */
  hints: string[];
}

/** Resolve 'auto' to the platform-native scheduler. */
export function resolveTarget(target: ScheduleTarget, platform: NodeJS.Platform = process.platform): Exclude<ScheduleTarget, 'auto'> {
  if (target !== 'auto') {
    return target;
  }
  if (platform === 'darwin') {
    return 'launchd';
  }
  if (platform === 'linux') {
    return 'systemd';
  }
  return 'cron';
}

function quote(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}

function invocationArgs(ctx: ScheduleContext): string[] {
  return [ctx.scriptPath, '--ingest-only', ...ctx.extraArgs];
}

// Shell-form invocation for cron/systemd: quote the executable, the script, and
// any argument VALUES (which may contain spaces), but leave flag names bare.
function buildInvocation(ctx: ScheduleContext): string {
  const head = `${quote(ctx.nodePath)} ${quote(ctx.scriptPath)} --ingest-only`;
  const tail = ctx.extraArgs.map((a) => (a.startsWith('--') ? a : quote(a))).join(' ');
  return tail ? `${head} ${tail}` : head;
}

function renderLaunchd(ctx: ScheduleContext): RenderedSchedule {
  const args = [ctx.nodePath, ...invocationArgs(ctx)];
  const programArgs = args.map((a) => `    <string>${escapeXml(a)}</string>`).join('\n');
  const plistPath = path.join(ctx.home, 'Library', 'LaunchAgents', `${SCHEDULE_LABEL}.plist`);
  const unit = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SCHEDULE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
  <key>StartInterval</key>
  <integer>${ctx.intervalSec}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(ctx.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(ctx.logPath)}</string>
</dict>
</plist>
`;
  return {
    unit,
    hints: [
      `Save and load it:`,
      `  copilot-price --schedule launchd > ${plistPath}`,
      `  launchctl bootstrap gui/$(id -u) ${plistPath}`,
      `Uninstall:`,
      `  launchctl bootout gui/$(id -u)/${SCHEDULE_LABEL}`,
      `  rm ${plistPath}`,
    ],
  };
}

function renderCron(ctx: ScheduleContext): RenderedSchedule {
  const unit = `* * * * * ${buildInvocation(ctx)} >> ${quote(ctx.logPath)} 2>&1\n`;
  const hints: string[] = [];
  if (ctx.intervalSec !== 60) {
    hints.push(`Note: cron granularity is 1 minute; requested ${ctx.intervalSec}s rounded to 60s.`);
  }
  hints.push(`Install by appending the line above to your crontab:`, `  copilot-price --schedule cron | crontab -l - | crontab -`, `Or run \`crontab -e\` and paste it. Remove the line to uninstall.`);
  return { unit, hints };
}

function renderSystemd(ctx: ScheduleContext): RenderedSchedule {
  const execStart = buildInvocation(ctx);
  const unit = `# --- ${SCHEDULE_LABEL}.service ---
[Unit]
Description=copilot-price ingest (mirror Copilot chat usage into the durable store)

[Service]
Type=oneshot
ExecStart=${execStart}

# --- ${SCHEDULE_LABEL}.timer ---
[Unit]
Description=Run copilot-price ingest every ${ctx.intervalSec}s

[Timer]
OnBootSec=${ctx.intervalSec}
OnUnitActiveSec=${ctx.intervalSec}
AccuracySec=1s

[Install]
WantedBy=timers.target
`;
  const dir = path.join(ctx.home, '.config', 'systemd', 'user');
  return {
    unit,
    hints: [
      `Split the two sections into:`,
      `  ${path.join(dir, `${SCHEDULE_LABEL}.service`)}`,
      `  ${path.join(dir, `${SCHEDULE_LABEL}.timer`)}`,
      `Then enable:`,
      `  systemctl --user enable --now ${SCHEDULE_LABEL}.timer`,
      `Uninstall:  systemctl --user disable --now ${SCHEDULE_LABEL}.timer`,
    ],
  };
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Render a scheduler unit for the given (resolved) target. */
export function renderSchedule(target: Exclude<ScheduleTarget, 'auto'>, ctx: ScheduleContext): RenderedSchedule {
  switch (target) {
    case 'launchd':
      return renderLaunchd(ctx);
    case 'cron':
      return renderCron(ctx);
    case 'systemd':
      return renderSystemd(ctx);
  }
}

/** Default log path under the store's home dir. */
export function defaultLogPath(): string {
  const home = process.env.COPILOT_PRICE_HOME ?? path.join(os.homedir(), '.copilot-price');
  return path.join(home, 'ingest.log');
}
