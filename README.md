# copilot-price

A small CLI that shows your **GitHub Copilot AI credit (AIC) usage for today** — from local
midnight — broken down per model, with a USD estimate.

It reads what VS Code's Copilot Chat extension records in a local OTel SQLite database
(`agent-traces.db`). For each chat it uses **Copilot's own billed credit value** (the
`copilot_usage_nano_aiu` attribute — its authoritative AI-Unit figure, 1 AIU ≈ 1 AIC ≈ $0.01),
and falls back to pricing the per-span token counts with a bundled rate card only for chats
that lack a stored value. Nothing is sent anywhere — prompt/response content is never read,
only aggregate usage.

```
Copilot AI credit usage — 6/2/2026, 12:30:00 PM

MODEL              CHATS    INPUT   OUTPUT  CACHE R  CACHE W     AIC
─────────────────  ─────  ───────  ───────  ───────  ───────  ──────
Claude Sonnet 4.6     12  240,118   18,402  120,400    8,210   58.12
GPT-5.2                4   40,002    2,110   10,000        0    9.40
─────────────────  ─────  ───────  ───────  ───────  ───────  ──────
TOTAL                 16  280,120   20,512  130,400    8,210   67.52

Total: 67.52 AIC  (≈ $0.68, 439,242 tokens)
```

## Requirements

- **Node ≥ 22.5** (uses the built-in `node:sqlite` module).
- VS Code (or Insiders / Cursor / VSCodium) with the **Copilot Chat** extension and its OTel
  exporter enabled (see below).

## Install (build + link locally)

```bash
npm install
npm run compile      # tsc typecheck + tsup bundle + rate-card JSON
npm link             # exposes the `copilot-price` command globally
copilot-price
```

(`npm link` symlinks the built `dist/index.js`. Alternatively, `npm i -g .`.)

## Pack & install globally

To install a real, self-contained copy globally (via a tarball, the way a published
package installs):

```bash
npm run compile                          # build first — `npm pack` does NOT build
npm rm -g copilot-price                  # optional: drop a previous `npm link`/install
npm pack                                 # → copilot-price-1.0.0.tgz (uses the "files" allowlist)
npm install -g ./copilot-price-1.0.0.tgz # install that tarball globally
copilot-price                            # run it
```

Notes:

- The tarball name is `<name>-<version>.tgz`; bump the version → adjust the install path.
- `npm run compile` is required — skip it and you'd pack a stale or missing `dist/`.
- Shorthand for the last two steps (no tarball file): `npm install -g .`.
- Installing the command is not enough on its own: `copilot-price` shows no numbers until
  Copilot Chat's OTel exporter is enabled and recording — see
  [Enable usage recording](#enable-usage-recording) below.

## Enable usage recording

`copilot-price` can only show numbers once Copilot Chat is recording token spans:

1. Make sure GitHub Copilot is **enabled** in VS Code (it's off if your settings contain
   `"github.copilot.enable": { "*": false }`).
2. Enable the OTel exporter in `settings.json`:
   ```json
   "github.copilot.chat.otel.dbSpanExporter.enabled": true
   ```
3. **Reload the window**, then use Copilot Chat.
4. Run `copilot-price` (or `copilot-price --doctor` to inspect detection and recorded spans).

## Usage

```bash
copilot-price             # today's usage (since local midnight)
copilot-price --utc       # since UTC midnight instead
copilot-price --json      # machine-readable output
copilot-price --doctor    # diagnose DB detection, the durable store, and recorded usage
copilot-price --db <path> # point at a specific agent-traces.db
copilot-price --store <p> # point at a specific durable store
copilot-price --no-ingest # read the live source only; don't read/write the durable store
copilot-price --no-color  # plain output

# continuous capture (see below)
copilot-price --ingest-only        # mirror new spans into the store and exit
copilot-price --watch [--interval N]  # ingest every N seconds until Ctrl-C
copilot-price --schedule <target>  # print a launchd/cron/systemd unit (installs nothing)

# compete with friends (see below)
copilot-price --join <code> --handle <you>   # join a league
copilot-price --publish            # publish today's total, then show the board
copilot-price --leaderboard [--week|--all-time]   # show the ranked board
copilot-price --backfill <N>       # publish the last N days from your local store
```

The source DB is auto-detected across VS Code variants (stable, Insiders, Cursor, VSCodium);
when several are installed, the most recently used one wins. Override with `--db` or the
`COPILOT_PRICE_DB` environment variable.

## Why a durable store (important)

`agent-traces.db` is **not a cumulative ledger** — it's a snapshot of your *currently retained
chat conversations*. Copilot prunes spans **per conversation**: deleting, clearing, or archiving
a chat — or simply crossing the chat-history cap (50 conversations), or reloading the window —
removes **all** of that conversation's token records at once. So a plain read of the source
**silently undercounts** and the number can *drop* as the day goes on.

To fix this, `copilot-price` keeps its **own append-only copy**: on every run it mirrors the
source's chat spans into a local store (`~/.copilot-price/usage.db`), deduplicated by the
source's `span_id` primary key. A span you've captured **survives even after Copilot drops it**,
so totals only ever grow. Reporting is done from this store.

- Location: `~/.copilot-price/usage.db` — override with `--store` or `COPILOT_PRICE_STORE`
  (or relocate the whole dir with `COPILOT_PRICE_HOME`).
- It can only capture what's present *when it runs*. Usage that was pruned **before** the first
  capture is gone — so run `copilot-price` regularly (or on a schedule) to avoid morning gaps.
  The tool warns when the earliest usage it can account for today starts well after midnight.

## Continuous capture (optional)

To close the *between-runs* gap, keep the store fed in the background. `copilot-price`
**installs nothing** — it just gives you commands and prints scheduler recipes you install
yourself.

```bash
copilot-price --ingest-only          # mirror new spans into the store and exit (for schedulers)
copilot-price --watch                # foreground loop: ingest every 60s until Ctrl-C
copilot-price --watch --interval 30  # finer cadence
```

`--watch` is the zero-setup option: run it in a terminal/tmux, or add it as a macOS *Login
Item* to persist across logins. Nothing is written to OS scheduler locations.

For OS-level scheduling, print a ready-to-install unit (paths resolved for you) and install it
**yourself**:

```bash
# macOS LaunchAgent (runs --ingest-only every 60s):
copilot-price --schedule launchd > ~/Library/LaunchAgents/com.icirellik.copilot-price.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.icirellik.copilot-price.plist

# crontab line (1-minute granularity):
copilot-price --schedule cron        # prints the line; add it with `crontab -e`

# Linux systemd --user service + timer:
copilot-price --schedule systemd     # prints both units + enable hints
```

`--schedule` only prints (unit → stdout, install/uninstall hints → stderr); it never installs
or runs anything. `--doctor` shows the store's **last ingest** time so you can confirm a
scheduler is actually firing.

## Compete with friends (leaderboard)

Add your friends to a shared **league** and race on daily AI-credit usage. Each `--publish`
sends **only** `{ league, handle, date, totalAic }` — your handle, the date, and the single
day total. No per-model data, no token counts, and (as always) no prompt or response content
ever leaves your machine.

It needs a tiny backend the group deploys **once** — a Cloudflare Worker + D1, under
[`server/`](server/README.md). The CLI itself still installs nothing and talks to the backend
over plain HTTPS, so any host implementing the same contract works.

```bash
# 1. One person deploys the backend (see server/README.md), then mints a join code:
copilot-price --make-league-code \
  --api https://copilot-price-league.<subdomain>.workers.dev \
  --token <the shared LEAGUE_SECRET> --league friends
#   → prints a code to share privately (it contains the secret — treat it like a password)

# 2. Everyone joins once:
copilot-price --join <code> --handle dana

# 3. Publish today's total (also prints the board so you see your rank):
copilot-price --publish

# 4. Check the boards any time:
copilot-price --leaderboard            # today
copilot-price --leaderboard --week     # last 7 days
copilot-price --leaderboard --all-time # cumulative
```

```
Copilot league — today  (friends)

🥇  dana          142.70 AIC
🥈  cam (you)      98.30 AIC
🥉  alex           61.00 AIC
```

- **Boards.** Today resets at your local midnight (`--utc` to use UTC); week and all-time
  accumulate from the daily snapshots the backend keeps. Ranked by AIC.
- **Keep it fresh automatically.** Add `--publish` to your background ingest so the board
  updates hands-free: `copilot-price --watch --publish`, or append `--publish` to the
  `--ingest-only` line in your scheduler unit. Publishing is best-effort — a network hiccup
  never stalls or fails the underlying ingest.
- **Backfill.** Only ran the tool sporadically? `copilot-price --backfill 14` republishes the
  last 14 days from your durable local store (which keeps every span), so week/all-time catch
  up. Re-running is idempotent.
- **See exactly what's sent.** `copilot-price --publish --dry-run` prints the precise JSON
  payload and sends nothing.
- **Config.** Your league lives in `~/.copilot-price/league.json` (mode `0600`, it holds the
  shared secret) — override with `COPILOT_PRICE_LEAGUE`, or relocate the dir with
  `COPILOT_PRICE_HOME`.
- **Trust model.** This is built for friends, not adversaries: anyone with the league token can
  publish under any handle and read the whole board. Pick a unique handle; run separate Workers
  for separate groups. See [`server/README.md`](server/README.md) for the details.

## Scope & accuracy

- Measures **VS Code Copilot Chat** usage. The standalone `copilot` CLI does not persist
  token counts locally, so its usage is **not** captured.
- **AIC source.** Each chat is counted from Copilot's own stored credit value
  (`copilot_usage_nano_aiu`) — the authoritative, billed figure. Only chats missing that value
  fall back to the rate card; the footer reports the metered/estimated split so you know how
  much is exact.
- **Rate-card fallback** prices billable input as `input − cacheRead − cacheCreation` (the
  recorded `input_tokens` is the *total* prompt, inclusive of cached tokens — not subtracting
  them overstates cache-heavy sessions several-fold). Card prices can still drift from
  GitHub's, and models not in the card with no stored value are counted as `0` (marked `*`).
- The source DB is ephemeral (see above); the durable store is as complete as your run
  cadence. `--no-ingest` bypasses the store and reads the live source only (a lower bound).

## Develop

```bash
npm run dev          # tsup --watch
npm test             # vitest
npm run type-check   # tsc --noEmit
npm run eslint
```

The rate card lives in `data/models-and-pricing.yml` (an upstream mirror). `npm run compile`
converts it to `dist/models-and-pricing.json`. To refresh prices, re-copy the upstream YAML
and rebuild.
