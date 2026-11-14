# NASA FIRMS hotspot backend

This Python API fetches NASA FIRMS active-fire detections on demand and returns
GeoJSON points. NASA runs the detection algorithms. The backend filters and
normalizes those detections for use in a map or another application.

## 1. Request your NASA key

Open [NASA FIRMS Map Key](https://firms.modaps.eosdis.nasa.gov/api/map_key),
choose **Get MAP_KEY**, and submit your email address. Use the key NASA emails
you. You can check its status and transaction usage on the same page. The
credential goes in the upstream URL, so keep it on the server and redact it
from outbound proxy logs or tracing if you use them.

## 2. Start the backend

The backend must be running while using dashboard data. From the repository
root, open a **second PowerShell terminal** (leave `npm run dev` running in the
frontend terminal) and run these commands from `src\backend_api`. Use Python
3.11 or newer:

```bash
cd src/backend_api
python -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
read -rsp 'NASA FIRMS map key: ' FIRMS_MAP_KEY
export FIRMS_MAP_KEY
printf '\n'
python -m uvicorn app:app --host 127.0.0.1 --port 8000
```

On Windows PowerShell:

```powershell
Set-Location .\src\backend_api
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
$key = Read-Host 'NASA FIRMS map key' -AsSecureString
$keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($key)
try {
  $env:FIRMS_MAP_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)
  .\.venv\Scripts\python.exe -m uvicorn app:app --host 127.0.0.1 --port 8000
} finally {
  Remove-Item Env:FIRMS_MAP_KEY -ErrorAction SilentlyContinue
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
  $key.Dispose()
}
```

Keep that terminal open while using the dashboard. Verify the service from
another terminal with `Invoke-RestMethod http://127.0.0.1:8000/health`; it
should return `{"status":"ok"}`. Do not paste the key into the frontend, source
code, or a `VITE_` environment variable. If you already created a virtual
environment, you can skip the `py -m venv .venv` command.

The Vite development server proxies the dashboard's `/api` requests to
`http://127.0.0.1:8000`. Start the frontend from the repository root with
`npm run dev` in a separate terminal. For a deployment, configure the web
server to proxy `/api` to the backend on the same origin. A cross-origin API
base can be configured at build time with `VITE_FIRMS_API_BASE_URL` only when
the backend is also configured with an appropriately restrictive CORS policy.
Keep the FIRMS map key on the backend; it must never be placed in a `VITE_`
variable.

SQLite caches requests automatically. Set `FIRMS_CACHE_PATH` before starting
the server to choose a different file. By default it uses
`firms-hotspots/cache.sqlite3` under the system temporary directory
(usually `/tmp` on Linux).

## 3. Verify your key and fetch detections

In a second terminal, run the following. You can also open
[the interactive API docs](http://127.0.0.1:8000/docs).

```bash
curl -sS 'http://127.0.0.1:8000/health'
curl -sS 'http://127.0.0.1:8000/availability'
curl -sS 'http://127.0.0.1:8000/hotspots?area=-125,32,-114,42&days=2'
```

`/health` checks the process. `/availability` makes a live authenticated NASA
request and returns the start and end dates FIRMS currently reports for each
available MODIS or VIIRS product. `/hotspots` defaults to MODIS Terra/Aqua
and VIIRS NOAA-20/21 near-real-time products. The example queries a bounding
box over California and surrounding areas.

| Query parameter        | Value                                                                                                                                                                                                                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `area`                 | Required. `west,south,east,north` in decimal degrees, `world`, or `netherlands`. `netherlands` queries and clips to the generalized European Netherlands boundary; Caribbean Netherlands is not included. Split a box crossing the antimeridian into two requests.                            |
| `days`                 | 1–31 UTC calendar days. Without a start date, the window ends today in UTC and includes today's observations so far.                                                                                                                                                                          |
| `start_date`           | Optional `YYYY-MM-DD`. The window starts on this date and extends forward inclusively. Use this or the precise start/end parameters for standard-processing products.                                                                                                                         |
| `start` and `end`      | ISO 8601 date and time, inclusive start and exclusive end. Supply both and omit `start_date` and `days`. At most 31 UTC calendar days per query.                                                                                                                                              |
| `tz`                   | IANA timezone, for example `Europe/Amsterdam`. Required for timestamps without an offset. The response includes `acquired_at_local` in this zone, with UTC as the default. Explicit timestamp offsets determine the query instants when supplied. Legacy `start_date` and `days` stay in UTC. |
| `daynight`             | `all`, `day`, or `night`. Uses the FIRMS observation flag and excludes unknown flags when filtering.                                                                                                                                                                                          |
| `source`               | Optional and repeatable. Use `MODIS_NRT`, `VIIRS_NOAA20_NRT`, `VIIRS_NOAA21_NRT`, `VIIRS_SNPP_NRT`, or their `_SP` equivalents when available.                                                                                                                                                |
| `modis_min_confidence` | Integer from 0 to 100, default 0.                                                                                                                                                                                                                                                             |
| `viirs_min_confidence` | `l` (low), `n` (nominal), or `h` (high), default `l`.                                                                                                                                                                                                                                         |
| `summary`              | Optional boolean. `true` returns exact interval-wide dashboard metrics and only the 500 newest matching detection records; omitted/false returns every matching feature.                                                                                                                      |

### Confirmed Analysis geometry

Use `POST /hotspots/area` when querying a confirmed Polygon or MultiPolygon from
the Analysis tool. Send a JSON body containing `geometry`, `start_date`,
`days`, and any supported `daynight`, `source`, `modis_min_confidence`,
`viirs_min_confidence`, or `summary` filters. The geometry is used to request
candidate FIRMS bounding boxes, then both summary metrics and returned
detections are clipped to the exact Polygon/MultiPolygon. Areas crossing the
antimeridian are split into two candidate requests.

Area Analytics uses this endpoint only when Analysis has a confirmed area.
Otherwise it continues using `area=netherlands` and the generalized European
Netherlands boundary.

For historical data, use `/availability` to select a product with coverage
for the dates you need. NASA announced the end of Suomi NPP observations
on November 2, 2026, so it is an opt-in source for covered historical dates.
For example:

```bash
curl -sS 'http://127.0.0.1:8000/hotspots?area=-125,32,-114,42&days=1&start_date=2024-07-01&source=MODIS_SP&source=VIIRS_SNPP_SP'
```

This example selects nighttime observations during a local-time window.
`--data-urlencode` also handles the plus sign in explicit offsets such as
`+02:00`.

```bash
curl -sS -G 'http://127.0.0.1:8000/hotspots' \
  --data-urlencode 'area=3.3,50.7,7.3,53.7' \
  --data-urlencode 'start=2024-07-01T22:30:00' \
  --data-urlencode 'end=2024-07-02T04:00:00' \
  --data-urlencode 'tz=Europe/Amsterdam' \
  --data-urlencode 'daynight=night' \
  --data-urlencode 'source=MODIS_SP' \
  --data-urlencode 'source=VIIRS_NOAA20_SP'
```

A local timestamp that occurs twice during a daylight-saving transition
or falls inside a skipped hour returns HTTP 422. Supply an explicit offset
to identify the intended instant. The output always includes the original
UTC timestamp. FIRMS observations have minute-level timestamps.

GeoJSON coordinates are longitude then latitude. Each point includes source,
satellite, acquisition time in UTC, original sensor confidence, and optional
measurements including fire radiative power in MW. A successful request can
return zero features. Inspect `partial` and `sources` alongside `count`.
If one product fails, the others can still return data. If every product
fails, the backend returns HTTP 502 with a per-source error. Detections can
include thermal anomalies other than wildfire. Satellite coverage, cloud and
overpass timing affect what FIRMS can observe.

The dashboard uses `summary=true` to keep global multi-week queries usable.
`count` and the summary metrics cover every matching observation; `features`
contains only the latest 500 records for inspection/export, not the complete
dataset. Omit `summary` for the full GeoJSON feature list, which can be very
large for global intervals.

## How the backend calls NASA

- Availability uses `/api/data_availability/csv/<MAP_KEY>/ALL` and keeps only
  MODIS and VIIRS entries. Hotspot observations come exclusively from the
  allowlisted MODIS and VIIRS products.
- Hotspots use one `/api/area/csv/<MAP_KEY>/<SOURCE>/<AREA>/1` request
  per uncached product and UTC date. Historical requests append `/<DATE>`.
  Prefer bounded regional queries. A large response may exceed the 50 MiB
  per-source, per-day CSV cap. NASA documents a 5,000-transaction limit per
  10 minutes, with larger calls potentially counting multiple times.
- A successful daily batch, including an empty CSV with valid headers, is
  cached before time, confidence or day/night filters are applied. The same
  product, bounding box and date can serve different filters and timezones.
  Cache reuse requires identical bounds. Each source reports cache hits,
  the oldest fetch timestamp and any failed UTC dates. A failed date is
  retried on the next request.
- Expiry is five minutes for current and previous UTC day NRT data, one
  day for older NRT, and seven days for SP. Expired entries are pruned
  on writes and the least recently used entries are evicted above 128 MiB
  of compressed payload. SQLite files can retain allocated space for
  reuse. Stop the server before removing the cache files.
- The dashboard also caches compact daily summaries, tied to the exact
  underlying batch version and its expiry. Repeated interval/filter queries
  can reuse aggregate counts and the bounded recent-record sample without
  decompressing and reprocessing every cached point. These entries are
  disposable and capped separately at 32 MiB.
- The setup binds to localhost. Add access controls before exposing the
  service to other users so requests cannot freely consume your quota.

## Harmonizing observations for the science website

The API uses one schema with sensor, satellite, product and version, UTC
acquisition time, GeoJSON location, fire radiative power in MW and the
reported scan and track dimensions in km. It also reports nominal
resolution in meters and labels the brightness temperature band. Preserve
the sensor's native confidence. MODIS reports a 0–100 value and VIIRS
reports low/nominal/high. The meaning and detection sensitivity differ
between products and overpass conditions.

For scientific comparisons, start with standard-processing products and
display separate MODIS and VIIRS counts on the same equal-area grid and
UTC time bins. Label those counts as detected pixels. For event totals,
design a separate matching step using overlap and time proximity, validate
it on representative fires, and retain links to all original detections.
Account for overpass coverage, cloud and scan geometry when interpreting
differences or empty intervals. Keep raw point-level FRP by sensor until
you have validated any pooled FRP statistic. The temporary cache is
disposable. Use a durable versioned store for reproducible analyses.

The analysis API exposes `GET /capabilities` and `POST` endpoints at
`/analysis/calendar`, `/analysis/overview`, `/analysis/time-series`,
`/analysis/observations`, `/analysis/observation`, and `/analysis/map-source`.
It reads canonical detections from `FIRE_DATA_CSV` (and optionally
`FIRE_COVERAGE_CSV`) or from the database configured by `DATABASE_URL`.
When no local rows are available, a configured `FIRMS_MAP_KEY` enables
live-area analysis for requests up to 31 UTC days. Local-data analysis does
not require a FIRMS key; `/availability`, `/hotspots`, and
`/hotspots/area` always do.

NASA documentation

- [Area API](https://firms.modaps.eosdis.nasa.gov/api/area)
- [Data Availability API](https://firms.modaps.eosdis.nasa.gov/api/data_availability)
- [Fire detection interpretation](https://firms.modaps.eosdis.nasa.gov/alerts/notes.php)
- [FIRMS product notices](https://firms.modaps.eosdis.nasa.gov/content/notifications/firms/news.html)
