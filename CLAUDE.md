# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**BatchCast** — a Monte Carlo simulation forecasting tool for Azure DevOps teams. It pulls real throughput data from ADO, runs 10,000 simulations, and produces probability-based completion forecasts (p50/p75/p85/p95) in days. Features: batch tracking vs a saved baseline, a landing zone date range (p75–p85) skipping weekends and UK bank holidays, scope diff detection, and an inverse "Batch Sizing" simulation (given N days, how many items can we commit to?).

Deployed on **Render** (free tier — 50s+ cold start on first request), built from the GitHub repo `djwntegs/monte-carlo-sprint-forecaster`, branch `main`, so a push to `origin main` redeploys. A copy of the app is kept in the Commons repo at `apps/contrib/batchcast` and is synced by hand (see Git remotes). The ADO repo `Team30/_git/BatchCast` is retired and no longer pushed to.

## Running locally

```bash
npm install
# Create .env with required variables (see below)
npm run dev       # nodemon with auto-reload
npm start         # production
npm test          # route tests (node:test, no network needed)
```

Required `.env`:
```
ADO_ORG=ntegrasdaas
ADO_PROJECT=Team30
ADO_PAT=<personal access token>
SUPABASE_URL=<url>
SUPABASE_SERVICE_KEY=<service role key>
APP_PASSWORD=<shared password>   # required — server returns 503 if unset
APP_USER=batchcast               # optional, defaults to "batchcast"
```

`APP_PASSWORD` gates the whole app (pages and `/api/*`) with HTTP Basic auth. It fails closed: with no password set the server refuses to serve anything. Set it in Render's environment as well as local `.env`.

Basic auth sends the password with every request, so it is only safe over HTTPS. Render terminates TLS; anyone who runs this elsewhere with `HOST=0.0.0.0` must put TLS in front of it.

After 10 wrong passwords from one address within 15 minutes, that address gets 429 with `Retry-After` until the window ends, even with the right password. Requests with no credentials do not count. The counter is in memory, so it resets on restart and is per instance. On Render the client address is read from `X-Forwarded-For` with one trusted proxy hop; if lockouts hit the wrong people or never trigger, set `TRUST_PROXY_HOPS` (0 to 5) in Render's environment.

Supabase is optional — the app degrades gracefully with 503s when unconfigured (no project/forecast persistence, but simulation still works).

## Architecture

Single-page app with an Express backend. No build step.

```
server.js               createApp(env) builds the app (auth gate first, then routes, then public/); start() listens
src/lib/auth.js         Password gate, failed-attempt limiter, bind-address and proxy-hop logic
src/lib/query.js        Escaping and validation for values that reach ADO queries
public/index.html       Entire frontend — all HTML, CSS, and JS in one file (~3200 lines)
src/routes/
  ado.js                ADO REST + Analytics OData API proxy (org/project locked to env vars)
  forecasts.js          CRUD for saved forecast runs (Supabase)
  projects.js           CRUD for projects (Supabase)
src/schema.sql          Supabase schema (run manually in SQL editor)
```

## Security constraints — must not be changed

- ADO org and project are **server-side only** (`ADO_ORG`, `ADO_PROJECT` env vars). The client never sends these.
- ADO PAT and Supabase service key never reach the browser.
- `/api/ado/*` routes always use `ntegrasdaas/Team30` — no client-supplied org/project accepted.
- Every route sits behind the `APP_PASSWORD` gate, mounted first in `createApp` in `server.js`. Do not add routes or static paths ahead of it. `test/auth.test.js` covers the 503, 401, lockout and bind cases.
- Request values used in an ADO query go through `src/lib/query.js`: `quote()` for WIQL string literals, `odataLit()` for literals in an OData URL, and `optStr`/`reqStr`/`optDate`/`intInRange` to validate parameters. Never interpolate `req.query` values directly. `npm test` covers this.
- No CORS middleware: the frontend is served from the same origin. The server binds to `127.0.0.1` unless `HOST` is set; Render is detected via `RENDER` and binds `0.0.0.0`.

## Colour system

The four percentile levels use a fixed palette applied consistently across confidence cards, histogram bars, cumulative chart reference lines, deviation badges, and the landing zone:

| Level | Colour | Hex |
|-------|--------|-----|
| p50   | Amber  | `#F59E0B` / bg `#FFFBEB` |
| p75   | Green  | `#10B981` / bg `#ECFDF5` |
| p85   | Blue   | `#3B82F6` / bg `#EFF6FF` |
| p95   | Purple | `#8B5CF6` / bg `#F5F3FF` |

CSS classes: `.conf-50`, `.conf-75`, `.conf-85`, `.conf-95`. Deviation badges inside each card inherit the card's colour via `.conf-50 .conf-deviation`, `.conf-75 .conf-deviation`, etc.

## Key frontend globals and functions

**State globals:**
- `parsedData` — array of daily throughput numbers; the simulation input
- `selectedBatch` — the currently selected ADO iteration (includes `startDate` from ADO)
- `baselineForecast` — the pinned baseline forecast loaded from Supabase
- `cachedScopeDiff` — `{ added: [...], removed: [...] }` populated by `fetchScopeDiff()` after batch selection; used by `renderBurnup()` to detect a fresh batch (all baseline items replaced)
- `categories` — array for Batch Breakdown category allocations
- `adoReady` — boolean; false when ADO env vars are missing

**Key functions:**
- `simulateAllocations(cats, backlog, simCount)` — main Monte Carlo; samples `parsedData` 10,000× per category, returns `{ perCategory, overall }` sorted arrays
- `simulateBatchSize(throughput, targetDays, simCount)` — inverse simulation; sums `targetDays` random samples per run to produce an "items completable in N days" distribution
- `autoPullThroughput(types)` — pulls project-wide throughput from ADO for the configured lookback window; NOT scoped to the selected batch (intentional — historical data spans multiple batches)
- `fetchBatchBacklog(wiqlPath, types)` — queries `/api/ado/backlog` to count remaining items in the selected batch, passing custom done states so team-specific states (e.g. "Dev Environment") are excluded
- `getDoneStates()` — reads the UI done-state selector and returns the team's custom "done" states to pass to backend queries
- `fetchScopeDiff()` — compares the baseline snapshot item list against current ADO items to detect added/removed scope; calls `renderBurnup()` on completion
- `renderBurnup()` — draws the burn-up chart; detects fresh batches via `cachedScopeDiff` (when removed ≥ snapshot size and added > 0) and suppresses the actuals line on day 1
- `addWorkingDays(isoDate, n)` — advances a date by n working days, skipping weekends and a hardcoded UK bank holiday list (2025–2027, England & Wales)

## ADO API notes

- Throughput uses `WorkItemRevisions` OData (not `WorkItemSnapshot`) — `IsLastRevisionOfDay` is unavailable on this project. Groups by `WorkItemId` with `min(ChangedDateSK)` to get the first completion date per item.
- `/api/ado/backlog` excludes built-in closed states (`Closed`, `Done`, `Removed`) plus any team-specific done states passed via `?doneStates=Dev+Environment,...`
- ADO Analytics OData rate-limits under parallel requests — the detail breakdown (`?detail=true`) only fetches on manual pull clicks, not auto-pulls.
- Iterations endpoint returns `attributes.startDate` / `attributes.finishDate` — both are included in flattened results and used for landing zone date calculations.

## Git remotes

```
origin   https://github.com/djwntegs/monte-carlo-sprint-forecaster.git
```

Never embed a PAT in a remote URL. Credentials live in the macOS Keychain (`credential.helper=osxkeychain`).

Push after changes with `git push origin main`; Render redeploys from it. The old `ado` remote (`Team30/_git/BatchCast`) is retired: do not push to it.

Commons (`DocRepo/commons/apps/contrib/batchcast`, a separate repo) is a plain file copy, not linked to this one. After a meaningful change, copy the changed files across, bump the version in its README front matter, add a `revisions.md` row and commit there.
