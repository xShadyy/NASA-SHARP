# Shared worldwide satellite observations

The map's global layer reads one published local dataset. No browser, tile,
viewport, popup or map movement downloads FIRMS data. AOI analysis reuses
matching stored source/day partitions and supplements only missing supported
partitions through the existing bounded acquisition path.

## Run and deploy

From the repository root, with the existing backend virtual environment:

```powershell
$env:SHARP_GLOBAL_DB_PATH = "$PWD/data/global-hotspots.sqlite"
src/backend_api/.venv/Scripts/python.exe -m uvicorn app:app --app-dir src/backend_api --host 127.0.0.1 --port 8000
```

The backend starts its independent ingestion service by default. It serves a
durable previous publication immediately while a refresh runs; a first cold
startup reports building/unavailable until genuine observations are imported.
`SHARP_GLOBAL_INGEST_ENABLED=0` disables ingestion for a read-only API instance.
On Windows, `./tools/start-global-backend.ps1` supplies the same persistent defaults;
optional `-Database`, `-BindAddress` and `-Port` arguments set the deployment location.
`config/global.env.example` lists the server-only settings without secrets.
At most one owner can refresh the shared SQLite store: workers use a persisted
lease with a 30-second heartbeat and a 900-second recovery timeout. Browser
disconnects do not cancel ingestion. A backend shutdown waits for an in-progress
partition write before releasing ownership.

Persist the database directory, including its SQLite WAL/SHM sidecars, across
restarts. Multiple local API workers must use the same absolute database path.
The practical deployment is one host and one durable local volume. Independent
replicas with separate disks do not coordinate; use one ingestion host and a
shared serving deployment or replace this adapter with a genuinely shared store.
Do not put SQLite on a network filesystem without verifying its locking semantics.

Explicit operator commands also share the lease and refresh schedule:

```powershell
src/backend_api/.venv/Scripts/python.exe tools/global-hotspots.py refresh --database data/global-hotspots.sqlite
src/backend_api/.venv/Scripts/python.exe tools/global-hotspots.py status --database data/global-hotspots.sqlite
```

An administrator can import a real previously retrieved NASA-format CSV with
explicit reporting-extraction boundaries. Hotspot presence never establishes
coverage:

```powershell
src/backend_api/.venv/Scripts/python.exe tools/global-hotspots.py import --database data/global-hotspots.sqlite --csv data/MODIS.csv --source MODIS_NRT --start 2026-11-08T12:00:00Z --end 2026-11-15T12:00:00Z
```

The dates above demonstrate the command syntax, not shipped coverage. Runtime
databases and downloaded CSVs are ignored by Git. No synthetic production
dataset or forecast is installed.

## Source identity, intervals and replacement

The implementation checked the [official active-fire download documentation](https://firms.modaps.eosdis.nasa.gov/content/active_fire/),
[Area API](https://firms.modaps.eosdis.nasa.gov/api/area/) and
[official API tutorial](https://firms.modaps.eosdis.nasa.gov/content/academy/data_api/firms_api_use.html).
The three public CSV endpoints returned `text/csv` during endpoint verification:

- [MODIS C6.1 global seven-day NRT CSV](https://firms.modaps.eosdis.nasa.gov/data/active_fire/modis-c6.1/csv/MODIS_C6_1_Global_7d.csv).
- [NOAA-20 VIIRS C2 global seven-day NRT CSV](https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Global_7d.csv).
- [NOAA-21 VIIRS C2 global seven-day NRT CSV](https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-21-viirs-c2/csv/J2_VIIRS_C2_Global_7d.csv).

The official page says bulk CSV currently contains NRT; RT/URT are separately
available through services including Area API/WMS, and are removed on NRT
replacement or after six hours. This implementation does not relabel bulk data
as RT/URT or imply the same latency. It does not automatically request worldwide
RT/URT through the keyed Area API. Existing bounded AOI fallback remains available.

`SHARP_GLOBAL_SOURCES` can select a comma-separated subset of those three
products. MODIS preserves separate Terra and Aqua observations. Historic SNPP
records remain supported by the existing archive/AOI infrastructure; no current
SNPP bulk coverage is invented.

Each publication has one stable UTC anchor derived from the most recent
available source generation, bounded by the cadence anchor. Provider
`Last-Modified` is used when supplied; otherwise the manifest explicitly identifies
the retrieval-anchor assumption. Every 24h/48h/7d window uses that same anchor,
with exact start-inclusive/end-exclusive boundaries. The API never recomputes a
different interval for each tile. These windows differ from today in UTC.

The public phrase “last seven days” does not fully specify the first CSV
boundary instant. The importer retains all supplied records within 168 hours,
but only guarantees extraction coverage from six UTC midnights before the
source end. The ambiguous earlier boundary remains unknown. The initial 7d
window can therefore be partial; accumulated retained complete partitions can
fill that gap. No missing source/day is treated as zero, and source extraction
completeness does not mean cloud-free observation of every cell.

All recent days are revisited on each refresh. Exact canonical identity is
satellite, acquisition UTC and original coordinates. Exact duplicate rows
collapse. Matching-ID revisions prefer standard processing, then NRT, RT and
URT; separate satellites never collapse. Changed-coordinate records cannot be
proven to be revisions and are preserved. Snapshot membership is resolved once
using that policy; tiles, aggregate membership and exports reference the same
immutable membership, not changing “latest” rows.

## Durability, bounded work and freshness

SQLite holds source/day partition versions, canonical metadata, an RTree
spatial index, a fixed normalized spatial hierarchy, snapshots, ingestion leases,
quota reservations and source failure state. Publication is one transaction.
Failed sources retain their previous successful partitions and explicitly become
stale/partial. Successful sources remain useful. Restarting the backend retains
the last-known-good dataset and quota knowledge.

Default bounds:

| Setting                           | Default        | Meaning                                                   |
| --------------------------------- | -------------- | --------------------------------------------------------- |
| `SHARP_GLOBAL_REFRESH_SECONDS`    | 900            | Refresh cadence; minimum 300 seconds                      |
| `SHARP_GLOBAL_STALE_SECONDS`      | 3600           | Generation/publication freshness threshold                |
| `SHARP_GLOBAL_RETAIN_SNAPSHOTS`   | 8              | Immutable snapshots, about two hours at 15-minute cadence |
| `SHARP_GLOBAL_RETAIN_DAYS`        | 14             | Current source/day retention; minimum eight days          |
| `SHARP_GLOBAL_MAX_SOURCE_RECORDS` | 1500000        | Explicit per-source import bound                          |
| Download bound                    | 128 MiB/source | Oversized responses retain last-known-good data           |

Snapshot ID mappings consume storage proportional to retained snapshots times
stored observations. Eight snapshots were chosen instead of a 96-snapshot
default to bound that cost. Unreferenced partition versions and mappings are
removed; SQLite reuses freed pages rather than shrinking its file every refresh.
Unchanged full-day payload/coverage hashes exclude retrieval timestamps, so
refreshes reuse them. A fully unchanged conditional download does not create
another full snapshot mapping. Very old snapshot URLs become explicitly unavailable.

The current presentation uses a bounded spatial GeoJSON tile protocol served
by our backend. The client polls the local manifest every 60 seconds without
triggering ingestion. It coarsens the requested zoom until a full viewport uses
at most 24 tiles; each tile has at most 1,024 features (normally at most 256
hierarchy cells). The immutable client cache is bounded by both 64 entries and
16 MiB of decoded JSON. Stable IDs deduplicate tile-buffer and wrapped-world
copies, and the client does not recluster already aggregated global tiles.
Server SQL aggregation assigns membership using one global hierarchy, rather
than independently clustering tile edges.

Conditional headers are sent only after the provider supplied an ETag or
Last-Modified value. A 304 does not advance reported acquisition coverage.
Refresh cadence is not observation age. Acquisition, retrieval, provider
generation and publication timestamps are separate manifest fields.

## Shared transaction governance

The official MAP_KEY limit is 5,000 transactions per ten minutes; a request can
consume multiple transactions. The official tutorial's examples show five for
availability and 36 for one global VIIRS day. These are examples, not fixed prices.

All keyed requests pass through the shared persistent governor, including AOI
fallback, availability and retries. Unkeyed public bulk downloads contain no
MAP_KEY; their requests/bytes are measured separately. There is no browser-side
key, quota check or keyed map request.

| Setting                         | Default                                                       |
| ------------------------------- | ------------------------------------------------------------- |
| `SHARP_FIRMS_TRANSACTION_LIMIT` | 5000; cannot raise above provider limit                       |
| `SHARP_FIRMS_HEADROOM`          | 1000 transactions reserved for uncertainty/other applications |
| `SHARP_FIRMS_LOCAL_BUDGET`      | 3000 estimated transactions per rolling 600 seconds           |
| `SHARP_FIRMS_WORLD_DAY_COST`    | 1200 estimated transactions                                   |
| `SHARP_FIRMS_AVAILABILITY_COST` | 10 estimated transactions                                     |
| `SHARP_FIRMS_OTHER_COST`        | 100 estimated transactions                                    |
| `SHARP_FIRMS_MAX_QUEUED`        | 64 shared pending acquisitions                                |

Area estimates scale conservatively by requested area and days, with a minimum
of five transactions. They are reservations, not measurements of NASA's billing.
Provider-reported usage is reconciled through one coalesced status check per
minute, counting other applications using the same key. Availability CSV is
cached durably for an hour and shared across workers. A stale/unavailable status
fails closed. Concurrency semaphores do not replace transaction reservations.

HTTP 429 honors Retry-After and opens a persistent waiting circuit. Authentication
rejection stops retrying until the configured wait/configuration change.
Timeout/5xx retries are bounded to three attempts with exponential delay and
jitter, reserving each attempt separately. HTTP 200 error text and malformed
CSV are rejected; no provider response body/keyed URL is logged or returned.
Other applications can still consume quota between status checks; headroom and
conservative scheduling reduce that uncertainty rather than claiming a guarantee.

## Measurements and genuine limits

The deterministic backend tests exercise 100 concurrent readers, shared-worker
leases, immutable membership, restart recovery, partial-source failure,
RT/NRT preference, midnight boundaries, antimeridian/polar preservation and
quota persistence. They disable real background ingestion explicitly.

`tools/benchmark-global-results.json` records bounded presentation and inspection
fixture measurements, with all synthetic inputs identified. No production data
or scientific result is synthesized. Live ingestion could not be measured in
the restricted implementation environment because launching the explicit Python
refresh command was denied by its process permissions. The normal backend
owner remains the working ingestion path after startup outside that restriction.
Actual NASA transaction consumption, live download latency, browser memory and
navigation frame times remain unmeasured; backend fixture requests consume zero
upstream transactions.
`tools/benchmark-global-client-results.json` additionally measures Node-based
bounded tile selection and source preparation. It is not a browser frame-rate,
memory, GPU-rendering or visual-acceptance measurement.

Web Mercator presentation covers ±85.05112878° latitude. Canonical polar reports
remain in the store, counts and exports; the manifest states the rendering limit.
That unrendered band must never be interpreted as zero activity. No GIBS raster
or EPSG:4326 tile matrix is silently substituted for canonical global observations.

## Published tile and inspection API

The [presentation contract](GLOBAL-PRESENTATION.md) documents `GET /global/manifest?window=24h|48h|7d`, immutable `GET /global/tiles/{snapshot}/{window}/{z}/{x}/{y}.json`, and `POST /global/observations` plus `/global/observations/export`. This is a gzip GeoJSON spatial protocol benchmarked with an identified fixture, not MVT or a claim of an optimal global tile format. A deterministic global hierarchy owns each record once across seams; aggregates include snapshot, window, cell and display filters in their stable membership identity. Temporary filters, grouping and global sorting precede server pagination. Exports stream every match from that retained snapshot. Pruned snapshots return HTTP 410 rather than substituting new records.

Each tile contains at most 1,024 symbols; dense close zoom tiles retain exact aggregates instead of dropping records. The client retains at most 24 visible tiles and 64 cached entries within 16 MiB. The server retains at most 256 tile entries/32 MiB. Immutable URLs have compression-aware ETags and one-year caching; manifests have a separate 30-second cache policy. `GET /global/status` reports sanitized current-process tile-cache counters alongside persisted ingestion metrics. The benchmark artifact records 100 concurrent warm readers, generated tiles, cache hits, elapsed time, response sizes and traced Python allocation peak. It leaves actual live transactions, browser memory and frame times explicitly unmeasured.
