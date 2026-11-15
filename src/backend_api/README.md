# Run SHARP

Run these commands from the repository root. Use Python 3.11 or newer and a
Node.js version supported by the installed Vite release: Node 20.19+ or 22.12+.
Use a working Python installation to create the virtual environment; an
inaccessible Windows Store Python alias is an environment problem, not a
replacement for installing the backend requirements.

## Local development

Windows PowerShell, backend terminal:

```powershell
npm ci
py -3 -m venv src/backend_api/.venv
.\src\backend_api\.venv\Scripts\python.exe -m pip install -r src/backend_api/requirements.txt
.\tools\start-global-backend.ps1
```

The launcher pins `src/backend_api`, uses port 8000 and one API worker, and
inherits server environment variables. Its optional arguments are
`-Database`, `-BindAddress`, `-Port`, and `-Reload`. Use `-Reload` for local
development to load backend source changes automatically. The launcher checks
for an existing service before changing configuration. Direct startup is equivalent:

```powershell
.\src\backend_api\.venv\Scripts\python.exe -m uvicorn app:app --app-dir src/backend_api --host 127.0.0.1 --port 8000 --workers 1
```

Bash, backend terminal:

```bash
npm ci
cd src/backend_api
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python -m uvicorn app:app --host 127.0.0.1 --port 8000 --workers 1
```

If the environment already exists, skip creating it. The Bash backend
terminal remains in `src/backend_api`; use a separate repository-root terminal
for the frontend and later operator commands. In that second terminal:

```bash
npm run dev
```

Open the Vite URL printed in that terminal. The development and preview
servers proxy `/firms-api` and `/api` to `http://127.0.0.1:8000`.
`SHARP_API_PROXY_TARGET` changes that server-side target. The frontend's
default API base is `/firms-api`.

Check the running application without an authenticated NASA request:

```powershell
Invoke-RestMethod 'http://127.0.0.1:8000/health'
Invoke-RestMethod 'http://127.0.0.1:8000/global/manifest?window=24h'
Invoke-RestMethod 'http://127.0.0.1:8000/global/status'
```

```bash
curl -fsS http://127.0.0.1:8000/health
curl -fsS 'http://127.0.0.1:8000/global/manifest?window=24h'
curl -fsS http://127.0.0.1:8000/global/status
```

An empty global store returns an HTTP 200 availability document while its
first shared import runs. A 404 from `/global/manifest` means an older or
different application is serving that port. Stop that process from its own
terminal and restart the current application; `/health` alone does not prove
that the global routes are loaded. Uvicorn does not reload changed source
unless explicitly started in development reload mode.

## Shared last-24-hour observations

No MAP_KEY is required for the default worldwide view. One leased backend
owner downloads the official public 24-hour NRT CSV extracts for
`MODIS_NRT`, `VIIRS_NOAA20_NRT`, and `VIIRS_NOAA21_NRT`. These are MODIS
Collection 6.1 and VIIRS 375 m Collection 2 products. Bulk NRT is not RT/URT.
Separate Terra and Aqua observations are preserved. Current SNPP bulk data
is not invented; supported historical SNPP products remain explicit sources.

The owner starts independently of browser requests and checks hourly by
default. Acquisition UTC, provider generation, retrieval time and publication
time stay separate. A rolling 24-hour interval uses one published dataset
anchor and can cross two UTC dates; it is different from today in UTC.
Panning, zooming, projection changes, local tile requests and record browsing
never start FIRMS acquisition. The display uses versioned transparent
512-pixel PNG tiles over canonical stored observations. Polar observations
outside the Mercator rendering extent remain in canonical counts and exports.

The durable default store is
`src/backend_api/data/global-hotspots.sqlite`, independent of the current
working directory. Persist its directory, including SQLite WAL/SHM sidecars,
across restarts. Do not replace it with the disposable acquisition cache.
Publications preserve successful sources and mark retained failed sources
stale/partial. New tiles, records and exports use the same snapshot identity.
Pruned snapshots return an explicit unavailable/expired response rather than
substituting a newer membership.

Server settings are also listed in
[`config/global.env.example`](../../config/global.env.example). Set them in
the server environment; the example file is not automatically loaded.

| Variable                              | Default / purpose                                                                                         |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `SHARP_GLOBAL_DB_PATH`                | Durable global SQLite path above; use an absolute deployment path.                                        |
| `SHARP_GLOBAL_INGEST_ENABLED`         | `1`; set `0` for a serving instance without ingestion.                                                    |
| `SHARP_GLOBAL_RASTER_PREWARM_ENABLED` | `1`; local retained/publication tile warming. Set `0` for strict read-only cold-cache profiling.          |
| `SHARP_GLOBAL_REFRESH_SECONDS`        | `3600`, minimum `300`; checking faster does not make the source observations newer.                       |
| `SHARP_GLOBAL_STALE_SECONDS`          | `3600`; source/publication freshness threshold.                                                           |
| `SHARP_GLOBAL_RETAIN_SNAPSHOTS`       | `8`; immutable publications, including partial updates.                                                   |
| `SHARP_GLOBAL_RETAIN_DAYS`            | `14`, minimum `8`; retained current source/day partitions.                                                |
| `SHARP_GLOBAL_MAX_SOURCE_RECORDS`     | `1500000`; explicit per-source import bound. Downloads are also bounded to 128 MiB/source.                |
| `SHARP_GLOBAL_SOURCES`                | Comma-separated subset of `MODIS_NRT,VIIRS_NOAA20_NRT,VIIRS_NOAA21_NRT`.                                  |
| `FIRMS_CACHE_PATH`                    | Disposable source/day cache; defaults to `firms-hotspots/cache.sqlite3` under the OS temporary directory. |

The supported deployment is one host, one local durable SQLite volume and
one API worker. The persisted ingestion lease coordinates workers sharing the
same database, but process-local analytical snapshots and selection tokens
still require one worker or sticky routing. Separate replicas with separate
disks do not share ingestion, quota knowledge or tokens. Verify filesystem
locking before placing SQLite on any shared network volume.

Explicit operator commands, from the repository root:

```powershell
.\src\backend_api\.venv\Scripts\python.exe tools/global-hotspots.py status
.\src\backend_api\.venv\Scripts\python.exe tools/global-hotspots.py refresh
.\src\backend_api\.venv\Scripts\python.exe tools/global-hotspots.py refresh --window 7d
```

Use `--database /absolute/path/global-hotspots.sqlite` consistently if
overriding the default. Bash uses the same arguments with
`src/backend_api/.venv/bin/python`. A seven-day refresh is operator initiated;
ordinary startup and map use do not perform a historical backfill. A longer
window is unavailable until its genuine source coverage exists.

Previously retrieved NASA CSVs can be imported with explicit reporting
boundaries, never coverage inferred from positive hotspots:

```bash
src/backend_api/.venv/bin/python tools/global-hotspots.py import --csv /data/MODIS.csv --source MODIS_NRT --start 2026-11-14T12:00:00Z --end 2026-11-15T12:00:00Z
```

Those dates demonstrate syntax; replace them with the actual extraction
interval. Duplicate source records collapse; separate satellites remain
separate. Revised matching identities prefer standard processing, NRT, RT,
then URT. Records with changed coordinates are preserved when a replacement
cannot be established. Late-arriving records are revisited by later refreshes.

## Optional keyed regional and historical acquisition

Stored global source/day partitions and imported canonical data can support
AOI analysis without a key. Missing source coverage remains partial or
unavailable. For bounded fallback acquisition, request a
[FIRMS MAP_KEY](https://firms.modaps.eosdis.nasa.gov/api/map_key/) and set
`FIRMS_MAP_KEY` only on the backend. Never put it in source, browser URLs or
any `VITE_` variable. Redact keyed upstream URLs from infrastructure logs.

Bash, before starting the backend:

```bash
read -rsp 'FIRMS MAP_KEY: ' FIRMS_MAP_KEY
export FIRMS_MAP_KEY
printf '\n'
```

PowerShell, before starting the backend in the same terminal:

```powershell
$secureKey = Read-Host 'FIRMS MAP_KEY' -AsSecureString
try {
  $env:FIRMS_MAP_KEY = [Net.NetworkCredential]::new('', $secureKey).Password
  .\tools\start-global-backend.ps1
} finally {
  Remove-Item Env:FIRMS_MAP_KEY -ErrorAction SilentlyContinue
  $secureKey.Dispose()
}
```

Regional requests reuse cached platform/day batches and exact geometry
filtering. Country MultiPolygons and antimeridian pieces use bounded
candidate boxes instead of a worldwide bounding request. Live raw map
acquisition remains limited to 31 UTC calendar dates. The existing keyed
availability and source/day work is shared; a camera change cannot request it.

The quota governor persists reservations and provider reconciliation in the
global SQLite store. The provider ceiling is 5,000 transactions per rolling
600 seconds; one HTTP request can consume several transactions. Conservative
defaults are `SHARP_FIRMS_HEADROOM=1000`,
`SHARP_FIRMS_LOCAL_BUDGET=3000`,
`SHARP_FIRMS_WORLD_DAY_COST=1200`,
`SHARP_FIRMS_AVAILABILITY_COST=10`, `SHARP_FIRMS_OTHER_COST=100`, and
`SHARP_FIRMS_MAX_QUEUED=64`. These are estimates, not claimed measured prices.
Shared provider-status failure, authentication rejection, 429/Retry-After and
unsafe budget state delay acquisition while useful stored data remain served.

## Genuine regional historical data

No multi-decade archive or validated forecast model ships with the software.
Reported-observation watches and email/SMS delivery are deferred. The application
does not monitor after it closes, and `earlyWarning` remains false.
Opening History and reading `/analysis/history` or `/analysis/history/status`
does not download observations. The explicit **Load historical data** action
posts the exact region/query to `/analysis/history/prepare`. It prepares
bounded selected months and three prior years by default, reusing imported
history, stored partitions and the shared keyed acquisition path. Provider
date availability and the common transaction budget still apply. Progress
and cooldown are stored; an interrupted/partial job can be explicitly retried.
No global backfill starts automatically.

Automatic history storage is under `history/` beside the global database;
`SHARP_HISTORY_CACHE_DIR` can override it. Bounds are
`SHARP_HISTORY_BASELINE_YEARS=3` (3-5), `SHARP_HISTORY_MAX_MONTHS=60`, and
`SHARP_HISTORY_MAX_RECORDS=2000000` per registered region. Loading is bounded
to one selected year at a time. Without a key or sufficient imported data,
the UI reports unavailable coverage rather than fabricated history.

An operator can import an authorized regional archive instead. Canonical
detection CSV fields are:

```text
platform_code,latitude,longitude,acquired_at,frp_mw,confidence_class,confidence_pct,day_night,scan_km,track_km,nominal_resolution_m,source_product,product_version,processing_tier
```

Platform codes are `T`, `A`, `N`, `N20`, `N21`. Acquisition timestamps need
UTC offsets. Preserve native MODIS 0-100 confidence and VIIRS
low/nominal/high classes, products, processing versions and unknown values.
Supply separate `date,platform_code,state` coverage CSV records using
`complete`, `partial`, or `unknown`; omitted platform/days are unavailable.
Complete reporting does not establish cloud-free observation or absence of fire.

The JSON manifest must describe the real regional support geometry and
generation, for example the following schema with operator-supplied values:

```json
{
  "regionId": "your-regional-extract",
  "regionName": "Your regional archive",
  "geometry": {
    "type": "Polygon",
    "coordinates": [
      [
        [3, 50],
        [8, 50],
        [8, 54],
        [3, 54],
        [3, 50]
      ]
    ]
  },
  "datasetVersion": "your-source-processing-generation",
  "sources": [
    { "product": "actual-product", "processingTier": "standard", "version": "actual-version" }
  ],
  "forecastPlatforms": ["suomi-npp"]
}
```

The geometry is a schema example, not supplied historical coverage. Use your
actual supported domain and consistently processed data, then run:

```bash
src/backend_api/.venv/bin/python tools/sharp-history.py import --detections /data/region.csv --coverage /data/region-coverage.csv --manifest /data/region.json --output /data/region-history.sqlite
export SHARP_HISTORY_PATH=/data/region-history.sqlite
```

```powershell
.\src\backend_api\.venv\Scripts\python.exe tools/sharp-history.py import --detections data/region.csv --coverage data/region-coverage.csv --manifest data/region.json --output data/region-history.sqlite
$env:SHARP_HISTORY_PATH = (Resolve-Path data/region-history.sqlite).Path
```

Import replaces a regional archive atomically. Manifest, coverage and rows
are read in one SQLite transaction; generation metadata cannot mix imports.
`FIRE_DATA_CSV` plus optional `FIRE_COVERAGE_CSV` provide another local
canonical input. Without an authoritative coverage file, reporting coverage
is unknown. Optional `DATABASE_URL` uses a PostgreSQL `fire_detection` table
with platform_code, latitude, longitude, acquired_at, frp_mw,
confidence_class, confidence_pct and day_night columns. Only this adapter
requires `python -m pip install 'psycopg[binary]>=3,<4'`; it is not required
for SQLite, CSV or ordinary FIRMS operation.

## Method, investigations and outputs

`afternoon-active-cells-2km-1` is implemented. It uses afternoon Aqua and
selected VIIRS platforms, a fixed 2 km equal-area cell grid, the VIIRS cell
union in the VIIRS era, and Aqua-era overlap scaling after at least 14
usable overlap days. Terra is excluded from this metric. Raw sensor counts
are separate; observation-only filters do not redefine harmonized activity.
Fitting-period agreement is not independently validated fire-detection accuracy.

Monthly sums have units **active-cell-days**, not fires, burned area or unique
monthly cells. Historical comparisons require at least three eligible prior
years with complete corresponding reporting dates. They use the median and
25th-75th percentile range, equivalent elapsed dates for partial periods, no
missing-day zero fill or extrapolation, and exclude 29 February from both
comparison sides while preserving it in actual totals.

`/analysis/observations` performs full-query native search/filtering, stable
sorting, grouping and pagination before returning a page. Page sizes are
1-100; native confidence scales remain separate. Dense map sources use bounded
display aggregates rather than raising the 100,000-individual display bound.
All canonical members remain represented; source metadata identifies the
display representation. Raw acquisition/analytical retention is bounded to
200,000 matching records; exceeding a bound returns an explicit error.

`/analysis/selections` freezes canonical IDs or server display-cell membership
in batches of at most 2,000 IDs/cells, with source-generation validation.
Tokens are process-local and have a fixed 30-minute lifetime from creation;
bounded retention can evict them sooner. A newer generation for the same scope
invalidates the old selection. An actionable HTTP 409 requires selecting that
group again. Pagination, search and exports never silently renew membership.

`/analysis/observations/export` and `/global/observations/export` provide full
matching CSV, GeoJSON and reproducibility JSON, independently of pagination
and display limits. Exports carry exact AOI/interval, filters, membership,
method and source generation. Whole-AOI investigations may explicitly restore
their exact query source; frozen tokens and global snapshot IDs never change
to newer membership automatically. The printable analysis brief requires a
map capture matching the same investigation version.

Offline experimental outlook training is optional:

```bash
src/backend_api/.venv/bin/python tools/sharp-history.py train --archive /data/region-history.sqlite --output /data/region-outlook.json --iterations 150
export SHARP_OUTLOOK_MODEL_PATH=/data/region-outlook.json
```

```powershell
.\src\backend_api\.venv\Scripts\python.exe tools/sharp-history.py train --archive data/region-history.sqlite --output data/region-outlook.json --iterations 150
$env:SHARP_OUTLOOK_MODEL_PATH = (Resolve-Path data/region-outlook.json).Path
```

The target is at least one **reported satellite hotspot detection in a grid
cell during the next 24 hours**. It is not an ignition/spread probability.
Training uses supported whole 10 km cells, chronological partitions, baseline
comparisons, calibration and promotion gates. No training happens in ordinary
requests. Insufficient validation returns null probabilities. Actual archive
coverage and held-out evaluation must be inspected before using a model.
The optional EFFIS configuration (`SHARP_EFFIS_LAYER`,
`SHARP_EFFIS_ISSUE_TIME`, `SHARP_EFFIS_VALID_TIME`,
`SHARP_EFFIS_RESOLUTION_KM`) is a provider-URL metadata adapter, not completed
weather ingestion or a conversion from FWI to probability.

## Production configuration

Build the frontend with `npm run build` and serve `dist/` with an HTTP server.
Use a same-origin `/api/` reverse proxy in production, stripping that prefix,
and serve the SPA entry for frontend routes. Set `VITE_FIRMS_API_BASE_URL=/api`
before the frontend build to select it. The default `/firms-api` base can also
be proxied for existing clients. For example, the essential Nginx locations are:

```nginx
location /firms-api/ { proxy_pass http://127.0.0.1:8000/; }
location /api/ { proxy_pass http://127.0.0.1:8000/; }
location / { try_files $uri $uri/ /index.html; }
```

A separate API origin can be selected at build time with
`VITE_FIRMS_API_BASE_URL=https://api.example.com`. Set backend
`SHARP_CORS_ORIGINS=https://app.example.com` to the exact allowed frontend
origin. Multiple origins are comma separated; wildcards are rejected and
credentials are disabled. Defaults allow localhost and 127.0.0.1 on ports
5173 and 4173 only. CORS is not authentication; expose quota-consuming
regional/history acquisition only under the deployment's access controls.
Keep keys server-side and preserve durable store paths during deployment.

Provider content has its own terms. In particular, WDPCA is retained with
UNEP-WCMC/IUCN citation, release date, Protected Planet link and its separate
[data terms](https://www.protectedplanet.net/en/legal); it is not covered by
the software's Apache license. Country metadata retains individual
geoBoundaries and original-source licensing. Runtime data, caches, credentials
and private downloads must not be committed.

## Verification commands

From the repository root:

```bash
npm run typecheck
npm run lint
npm run test
npm run build
npm run format:check
src/backend_api/.venv/bin/python -m unittest discover -s src/backend_api/tests
```

PowerShell backend tests use:

```powershell
src/backend_api/.venv/Scripts/python.exe -m unittest discover -s src/backend_api/tests
```

The ordinary suites use offline fixtures, not live NASA quota. Real Chromium
integration is explicit: set `SHARP_BROWSER_TEST=1` and optionally
`SHARP_TEST_CHROME` to the local browser executable, then run `npm run test`.
Clear the opt-in afterward. A missing browser/runtime or blocked OS process
must be reported as an environment blocker, not a successful browser check.

Benchmarks are separate from ordinary tests. The existing
`tools/benchmark-analysis-acquisition.py` supports `--global-schema`,
`--global-raster --database /path/to/existing.sqlite`, and `--scientific`.
Synthetic fixture timings are not production scientific validation or NASA
latency. Measure real acquisition and browser behavior separately; do not
infer performance from idle animation frames or invent provider usage.
