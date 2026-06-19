# copilot-price league backend

A tiny [Cloudflare Worker](https://workers.cloudflare.com/) + [D1](https://developers.cloudflare.com/d1/)
(SQLite) service that backs the `copilot-price` friends leaderboard. **One person deploys it
once** for the group; everyone else just runs `copilot-price --join <code>`.

It stores one row per `(league, handle, date)` — your daily total AIC — and sums those rows into
today / this-week / all-time boards. It never sees your prompts, your per-model breakdown, or
your token counts: each publish is exactly `{ league, handle, date, totalAic }`.

## Deploy (once)

```bash
cd server
npm install                                  # just wrangler
npx wrangler login                           # auth to your Cloudflare account

# 1. Create the D1 database, then paste its database_id into wrangler.toml:
npx wrangler d1 create copilot-price-league

# 2. Create the table (remote):
npm run init-db

# 3. Set the shared league secret (pick a long random string; share it with friends):
npx wrangler secret put LEAGUE_SECRET

# 4. Ship it:
npm run deploy
# → https://copilot-price-league.<your-subdomain>.workers.dev
```

## Make a join code for your friends

From the **main** package (the CLI), turn the URL + secret + a league name into one shareable
string:

```bash
copilot-price --make-league-code \
  --api https://copilot-price-league.<your-subdomain>.workers.dev \
  --token <the LEAGUE_SECRET you set> \
  --league friends
```

Each friend runs `copilot-price --join <code> --handle <their-name>` once, then `--publish` /
`--leaderboard`.

## Endpoints

| Method | Path                | Body / query                                   |
| ------ | ------------------- | ---------------------------------------------- |
| `POST` | `/v1/publish`       | `{ league, handle, date, totalAic }`           |
| `POST` | `/v1/publish-batch` | `{ league, handle, days: [{date, totalAic}] }` |
| `GET`  | `/v1/leaderboard`   | `?league&window=today\|week\|all&date&from`    |
| `GET`  | `/v1/health`        | (no auth)                                       |

All but `/v1/health` require `Authorization: Bearer <LEAGUE_SECRET>`.

## Local development

```bash
npm run dev                                  # wrangler dev on http://127.0.0.1:8787
npm run init-db-local                        # create the table in the local D1
# in another shell, point the CLI at it:
copilot-price --make-league-code --api http://127.0.0.1:8787 --token devsecret --league test
```

(`wrangler dev` reads `LEAGUE_SECRET` from a local `.dev.vars` file — add a line
`LEAGUE_SECRET=devsecret`.)

## Security model (read this)

This is built for **trust among friends**, not adversaries:

- **The join code contains the league secret** (it's just base64). Treat it like a password —
  share it privately, don't commit it.
- **The `league` field is a namespace, not a security boundary.** Anyone who knows the secret can
  read or write *any* league on this deployment. If two groups want isolation, run two Workers
  (each with its own secret).
- **Anyone with the token can publish as any handle.** There's no per-person auth, so the board
  is only as honest as the group. A per-handle write PIN is a possible future addition.
