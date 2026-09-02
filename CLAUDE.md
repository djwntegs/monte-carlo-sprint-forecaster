# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**BatchCast** — a Monte Carlo simulation forecasting tool for Azure DevOps teams. It pulls real throughput data from ADO, runs 10,000 simulations, and produces probability-based completion forecasts (p50/p75/p85/p95) in days. It includes batch tracking vs a saved baseline and a landing zone date range (75th–85th percentile) that accounts for UK bank holidays.

Deployed on **Render** (free tier — 50s+ cold start on first request). Repos: GitHub (`djwntegs/monte-carlo-sprint-forecaster`) and ADO (`ntegrasdaas.visualstudio.com/Team30/_git/BatchCast`).

## Running locally

```bash
npm install
# Create .env with required variables (see below)
npm run dev       # nodemon with auto-reload
npm start         # production
```

Required `.env`:
```
ADO_ORG=ntegrasdaas
ADO_PROJECT=Team30
ADO_PAT=<personal access token>
SUPABASE_URL=<url>
SUPABASE_SERVICE_KEY=<service role key>
```

## Architecture

Single-page app with an Express backend. No build step — the frontend is one file served as static HTML.

```
server.js               Express entry point, mounts routes, serves public/
public/index.html       Entire frontend — all HTML, CSS, and JS in one file (~3000 lines)
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

## Key frontend patterns

**`public/index.html`** is the entire UI. Key globals:
- `selectedBatch` — the currently selected ADO iteration (includes `startDate` from ADO)
- `baselineForecast` — the pinned baseline forecast loaded from Supabase
- `parsedData` — array of daily throughput numbers (the simulation input)
- `periodLabel` — defaults to `'Day'`; drives all period labelling via `getPeriod(n)`
- `categories` — array for Batch Breakdown category allocations

**ADO throughput pull** uses `WorkItemRevisions` OData filtered by `State eq '<doneState>'`, grouped by `WorkItemId` with `min(ChangedDateSK)` to get the first date each item entered that state, then counted per day. `aggregateDaily()` converts OData rows to an ordered count array.

**Monte Carlo simulation** runs in `simulateAllocations()` — samples randomly from `parsedData` 10,000 times and returns percentile results.

**Landing zone** — `addWorkingDays(isoDate, n)` counts forward n working days from the batch start date, skipping weekends and a hardcoded UK bank holiday set (2025–2027, England & Wales). Displayed after simulation if the selected batch has a `startDate` from ADO.

## ADO API notes

- Iterations endpoint returns `attributes.startDate` and `attributes.finishDate` — included in flattened results.
- Throughput uses `WorkItemRevisions` (not `WorkItemSnapshot`) because `IsLastRevisionOfDay` is unavailable on this project.
- ADO Analytics OData rate-limits under parallel requests — the detail breakdown (`?detail=true`) only fetches on manual pull clicks, not auto-pulls.

## Git remotes

```
origin   https://github.com/djwntegs/monte-carlo-sprint-forecaster.git
ado      https://...<pat>...@ntegrasdaas.visualstudio.com/Team30/_git/BatchCast
```

Push to both after changes: `git push origin main && git push ado main`
