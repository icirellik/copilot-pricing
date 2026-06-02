# copilot-price

A small CLI that shows your **GitHub Copilot AI credit (AIC) usage for today** — from local
midnight — broken down per model, with a USD estimate.

It works like [copilot-budget](https://github.com/mooracle/copilot-budget): it reads the
**measured per-span token counts** that VS Code's Copilot Chat extension writes to a local
OTel SQLite database (`agent-traces.db`) and prices them with a bundled rate card
(1 AIC = $0.01). Nothing is sent anywhere — prompt/response content is never read, only
aggregate token counts.

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
copilot-price            # today's usage (since local midnight)
copilot-price --utc      # since UTC midnight instead
copilot-price --json     # machine-readable output
copilot-price --doctor   # diagnose DB detection + recorded usage
copilot-price --db <path># point at a specific agent-traces.db
copilot-price --no-color # plain output
```

The DB is auto-detected across VS Code variants; override with `--db` or the
`COPILOT_PRICE_DB` environment variable.

## Scope & accuracy

- Measures **VS Code Copilot Chat** usage. The standalone `copilot` CLI does not persist
  token counts locally, so its usage is **not** captured.
- AIC is plan-invariant and matches GitHub's token-based billing. The figure is an estimate
  derived from local token counts × a bundled rate card, which may drift from GitHub's
  current prices.

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
