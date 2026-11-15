# Worldwide observation presentation

The main globe is a display-only last-24-hours context layer: crisp red square
pixels without count labels, observation popups, footprints or a global status
card. Detailed inspection is available through AOI and Area Analytics. The
startup Spinner keeps the app hidden and inert until valid 24-hour data is
prepared by the observation source and a render completes. Successful partial or
zero-result data is supported, with Retry on failure.

The global layer reads a durable, immutable published snapshot. All manifest,
tile, popup, detail and export routes are local reads; none starts acquisition.
The designated ingestion owner is configured separately. The original bounded
AOI and Area Analytics paths reuse matching global source/day partitions before
using a separately governed regional fallback. Missing platform/day jobs alone
are acquired. A retained current UTC day's partial reporting is labeled partial.

## Current raster presentation

The main globe uses native MapLibre raster layers backed by transparent PNGs:

```text
GET /global/manifest?window=24h
GET /global/raster/{snapshot}/{window}/red-pixels-1/{z}/{x}/{y}.png
```

The manifest supplies one immutable snapshot, its exact UTC start and exclusive
end, source generations, freshness, completeness, and `rasterTiles`,
`rasterTileSize: 512`, `rasterMaxZoom: 18`, `rasterStyle: red-pixels-1`.
The default acquisition and map window are rolling **24 hours**, anchored by the
published dataset. Browsers do not create new intervals from their own clocks.
Larger stored windows remain an explicit operator/analytics option; the map has
no 48-hour or seven-day selector and never starts an unrestricted backfill.

The server visits every matching canonical observation and paints its reported
location as a pure red `#ff0000` square. Unknown FRP is retained. There is no
sampling, count-based thinning, clustering, blur, or replacement by cell centres.
Squares occupy two tile pixels at zooms 0–3 and one at zooms 4–18. At screen
resolution, neighboring observations can occupy the same pixel; opaque pixel
count is not a detection count. These are display marks, not sensor footprints,
fire perimeters, burned area, or incident counts. Original coordinates, native
FRP, confidence, provenance, stable IDs and analytical color scales remain in
the canonical store and the existing AOI/Area Analytics workflow.

The PNGs follow the standard Web Mercator XYZ grid used by
[MapLibre raster sources](https://maplibre.org/maplibre-style-spec/sources/#raster).
The client uses 512-pixel tiles and
[nearest-neighbor resampling](https://maplibre.org/maplibre-style-spec/layers/#raster-resampling),
without interpolating a continuous heat surface. Native maximum zoom 18 matches
the flat map's permitted maximum; the globe stops at zoom 13. Tile images are
regenerated from canonical positions at each requested zoom. Quantization is
limited to the current tile pixel grid, not a persistent coarse geometry.

The main globe does not mount the former global vector source, symbol buckets,
feature-query loop, JavaScript observation arrays, or custom point shader.
MapLibre loads, caches, projects and draws these image tiles in both globe and
flat views. AOI analysis keeps its existing bounded interactive observation path.
Camera movement requests only local immutable image tiles and never NASA data.

## Readiness, refreshes and failure handling

Startup waits for the active global viewport and a completed observation render.
It does not wait for background imagery or an unused empty AOI worker. A valid
partial, stale, or successful-zero snapshot is usable while ingestion refreshes
independently. A transparent empty PNG is a valid result. After a startup failure
or a 30-second timeout, Retry and Open map are available in the existing loading
surface. The default spinner appearance is retained.

Two native raster source slots keep updates coherent. The old snapshot stays
visible while the next generation loads in a hidden staging slot. After its
first viewport loads and two render frames complete, the new slot becomes
active and the old slot is removed. An unavailable update never clears a useful
last-known-good display or substitutes new membership into an older snapshot.
Region highlighting, outside-area dimming, map camera and analytical state remain
independent of these slots. Dataset status and timing live in the existing Map &
layers menu; there is no bottom-left global card.

Style/context restoration uses native source/layer lifecycle restoration. The
separate sky panorama renderer now rebuilds GL resources on context restoration;
it no longer queries `gl.isProgram` on every camera frame. Browser performance
measurements for the current raster path are reported only when actually run.

## Local serving, bounds and deployment

Tiles are dependency-free 512×512 RGBA PNGs encoded with Python's `zlib` and
served as `image/png`. They are already compressed: no extra gzip is needed.
Versioned URLs include snapshot, interval and style. Optional native filters and
frozen group identity are part of the cache key. Successful responses have
content-derived ETags and `Cache-Control: public,max-age=31536000,immutable`.
The manifest has a separate short cache policy. No random timestamp cache buster
is added.

The per-process PNG cache is bounded to 256 entries/32 MiB. Striped single-flight
locks coalesce identical work, and a two-slot semaphore bounds concurrent image
generation. Rendering uses one fixed 1,049,088-byte scanline buffer per tile and
streams selected rows through a cursor. Every cold render verifies snapshot
existence and reads matching membership in one SQLite read transaction; a prune
before that transaction returns HTTP 410, while a prune afterward retains the
complete earlier read version. Cache hits still validate snapshot existence.
Invalid style, coordinates or filters return an explicit error.

At overview zooms, exact normalized bounds narrow the selected snapshot before
materialization. Regional requests additionally use the existing SQLite RTree.
The antimeridian is wrapped and pixels crossing tile boundaries are buffered;
canonical +180 and −180 observations remain distinct records. Polar records
outside ±85.05112878° remain in canonical counts, inspection and exports, with
`polarCount` in the manifest. They are outside the actual Mercator rendering
extent and are not represented as measured zero.

The designated ingestion owner prewarms z0 and all four z1 PNGs after publishing
each useful source generation; startup also warms an existing retained snapshot.
Prewarming performs only local reads. A rendering-cache failure records a metric
and does not invalidate successfully stored observations. This cache is
process-local; the documented deployment uses a single worker. A persisted
120-second per-generation warmup lease coalesces staggered worker startups and
publication warmups without changing the manifest or source retrieval times.
Additional serving processes can populate their own caches on demand; put
immutable tiles behind a shared HTTP cache when deploying multiple workers.
Global ingestion still uses the persisted SQLite lease and shared quota guard.
`/global/status` exposes `rasterTileCache` metrics. No new environment variable
or image dependency is required; existing durable database settings apply.
`SHARP_GLOBAL_RASTER_PREWARM_ENABLED=0` optionally disables warmup for strictly
read-only cold-cache profiling. The client caps native tile retention at 64
tiles per source and three zoom levels.

The Globe view uses MapLibre's public `globe` projection, retaining the spherical
overview and its documented native transition to Mercator by zoom 12. The
previous forced `vertical-perspective` configuration did not transition at
close zoom. The star background recognizes the native expression and is hidden
when the close surface is flat; it no longer synchronously checks GL program
validity on each camera frame.

For server startup and supported acquisition/import commands, see
[GLOBAL-HOTSPOTS.md](GLOBAL-HOTSPOTS.md) and
[config/global.env.example](config/global.env.example).

## Frozen inspection and complete exports

`POST /global/observations` accepts:

```json
{
  "snapshotId": "published snapshot identity",
  "window": "24h",
  "aggregateId": "tile-provided hierarchy identity",
  "options": { "page": 1, "pageSize": 10, "search": "", "sort": "newest", "groupBy": "none" }
}
```

The aggregate encodes snapshot, interval, hierarchy cell and initial display
filters. Camera changes do not alter membership. Temporary native filters,
search, stable global sorting and grouping operate in SQLite before pagination.
Hour groups include their UTC date. Unknown FRP, day/night and native confidence
remain unknown. `observationId` can select one canonical record. Page sizes are
1–100; the popup defaults to 10 and offers 25. An expired/pruned snapshot returns
an explicit unavailable response; it never substitutes the latest snapshot.

`POST /global/observations/export` accepts the same body plus `format` (`csv`,
`geojson`, `json`). Exports stream every matching record with no presentation or
pagination cap. CSV includes native metadata, exact interval, filters, selection
identity, matching count and source generation. GeoJSON and reproducibility JSON
also contain partition generations, source state and publication metadata.

## Measured behavior and limits

Run the current real-store PNG benchmark explicitly:

```powershell
src/backend_api/.venv/Scripts/python.exe tools/benchmark-analysis-acquisition.py --global-raster --database src/backend_api/data/global-hotspots.sqlite
```

It opens SQLite in read-only mode without initializing or altering the store,
and prints JSON to stdout. `--output` explicitly writes a result file, `--viewers`
changes concurrent-reader count, and `--window` selects an actually stored
interval. This command neither fetches NASA nor consumes MAP_KEY quota.

One Windows run used immutable snapshot `d778d9f7022b939928731305`: 96,054 real
stored observations, no polar records, 2026-11-14 16:46:41 through
2026-11-15 16:46:41 UTC, exclusive end. The snapshot was **stale** and is not
claimed to be current or complete. The existing database occupied 1,663,143,936
bytes; this benchmark did not import data or measure import growth.

| Operation                                | Actual local measurement                                     |
| ---------------------------------------- | ------------------------------------------------------------ |
| World PNG, cold / warm                   | 470.837 / 1.124 ms; 468.750 ms cold process CPU              |
| World membership / bytes                 | All 96,054 records visited; 6,117-byte PNG                   |
| Dense z2 PNG, cold / warm                | 400.707 / 1.261 ms; 406.250 ms cold process CPU              |
| Dense tile membership / bytes            | 53,335 core records; 53,897 including buffer; 9,031-byte PNG |
| Regional z5 PNG, cold / warm             | 33.667 / 1.051 ms; 1,692-byte PNG                            |
| Successful empty z12 PNG, cold / warm    | 4.298 / 0.827 ms; 1,096-byte transparent PNG                 |
| 100 cold readers across 20 threads       | 399.576 ms total; one generated tile, 99 cache hits          |
| 100 warm world readers across 20 threads | 30.805 ms total; 100 cache hits, zero generated tiles        |
| Overview cache contents                  | Five z0/z1 PNGs total 22,632 bytes                           |
| Eight-entry serving cache                | 34,451 PNG bytes; 205 hits across 213 requests               |
| Separate allocation-traced world rebuild | 1,351,262 incremental Python bytes peak                      |
| NASA requests / MAP_KEY transactions     | 0 / 0                                                        |

Cold overview rendering executed three SQL SELECTs including snapshot validation;
the regional spatial-index path executed four, including SQLite's internal RTree
read. A warm request executed one lightweight snapshot-validation SELECT and no
observation query. The 100-reader cold case executed 102 SELECTs total; the warm
case executed 100. Every reader saw the same immutable membership. The prewarm
step in this run generated three tiles and reused two already measured overview
tiles, taking 1,182.606 ms; that is not a five-cold-tile startup measurement.

Cold/warm and concurrent timings were measured **without** allocation tracing.
The separate allocation-traced world rebuild took 4,497.169 ms; tracing overhead
is not ordinary serving latency. The earlier dense z2 implementation took
783.543 ms in the same benchmark setup. Narrowing the actual snapshot directly
at overview scales reduced the measured cold case to 400.707 ms without changing
the resulting PNG bytes.

These are local serving measurements, not browser load time, browser memory,
network transfer duration, frame rate, live provider throughput, or scientific
validation. The current raster browser replay must be run separately; results
are not inferred from image size or older GPU runs.

Backend regressions decode real PNG chunks, checksums and transparency; exercise
40,000 overlapping records, unknown FRP, exact positions, UTC boundaries,
seams/dateline/poles, filters and frozen scopes, concurrent pruning, cache limits,
100-reader single-flight, prewarming, HTTP caching and zero upstream requests.
Ordinary tests use temporary stores and do not write tracked benchmark outputs.

## Audited source and investigation contracts

Bulk VIIRS confidence accepts the official full-word encodings `low`, `nominal`,
and `high`, as well as `l`, `n`, and `h`. Canonical values remain the full-word
classes. `confidence.nativeValue` retains the supplied encoding for inspection
and export. Invalid classes fail validation. Offline source-schema fixtures cover
every configured MODIS, NOAA-20 and NOAA-21 bulk provider.

Rolling display windows never define analytical source/day membership. A complete
stored UTC-day partition can be read in full even when its first reports precede
the rolling seven-day boundary. AOI readers apply source, exact UTC interval and
spatial-index predicates before counting toward the existing acquisition budget.
Investigation retention counts the selected result, preserving the original
regional harmonization fit and evidence without keeping unrelated archive rows.
The 200,000 matching-row retention limit remains explicit.

`summary.statistics` and `summary.facets` contain query-wide server summaries,
including median valid FRP, latest/highest records, display bins, daily counts,
platform, native confidence, FRP, acquisition hour and day/night. A record page is
never treated as the complete query. `summary.dailyCoverage` distinguishes
complete, partial and unavailable reporting windows. Source retrieval/failure
states retain their original ages; a new publication cannot freshen a failed
source. Mixed-source freshness is reported explicitly.

Tiles accept an optional `aggregateId` alongside `filters` to display an explicitly
applied frozen selection. Both original group membership and temporary filters
are enforced, including when new aggregates form at a different zoom. Group
inspection and export use the same immutable snapshot. Guarded observation
requests reject a changed `sourceGeneration` instead of silently replacing it.

AOI frozen-selection tokens remain bounded process-local state. Deploy one API
worker or sticky routing for their lifetime; SQLite global ingestion leases do
not share those tokens across workers. An expired AOI token needs an explicit
refresh. Global hierarchy selections are durable snapshot references and expire
only when the snapshot is pruned.

## Retained earlier protocols and measurements

These paths remain available for existing analytical integrations and regression
coverage. They are **not** the current default map renderer, and the measurements
below must not be presented as current PNG or browser performance.

`/global/point-tiles/{snapshot}/{window}/{z}/{x}/{y}.pbf` preserves the individual
MVT POINT protocol, immutable native row IDs, four native FRP severity classes,
65,536 extent, 8-pixel buffer, gzip and bounded cache. Its optional custom GPU
renderer remains in source but is not mounted by the current main globe.
`SHARP_GLOBAL_POINT_TILE_MAX_BYTES` applies only to that retained vector endpoint.
Its protocol follows the
[official MVT specification](https://github.com/mapbox/vector-tile-spec/tree/master/2.1).

`/global/tiles/{snapshot}/{window}/{z}/{x}/{y}.json` preserves the older GeoJSON
analytical aggregates. A deterministic level `z+4` hierarchy groups records,
with individual records at close zoom when within its 1,024-feature bound.
These aggregate identities still freeze exact canonical membership for
inspection and export. Its 256-entry/32 MiB cache is separate from PNG serving.
Analytical aggregate FRP uses the maximum valid reported value: below 10 MW
yellow `#f5c518`, 10 to below 50 MW orange `#f97316`, at least 50 MW red
`#dc2626`, and explicit unknown. Those scales do not redefine global red pixels.

### Earlier multi-source import and aggregate benchmark

Run the explicit offline command from the repository root:

```powershell
src/backend_api/.venv/Scripts/python.exe tools/benchmark-analysis-acquisition.py --global-schema --output .cache/audit-global-benchmark.json
```

It expands the checked-in actual bulk schemas into clearly synthetic observations,
passes all three providers through the real parser and ingestion transaction,
then measures local serving and a simulated provider outage. Use
`--records-per-source` to change its bounded workload. No ordinary test writes
the output, and no NASA service is contacted.

One Windows run after the parser repair used 5,000 rows per provider, 15,000 total,
with Python allocation tracing enabled:

| Operation                           | Measured result                                             |
| ----------------------------------- | ----------------------------------------------------------- |
| Three-source import and publication | 4,991.289 ms wall; 4,609.375 ms process CPU                 |
| Mocked source bytes                 | 1,373,429 bytes across three CSV responses                  |
| Database size / growth              | 15,884,288 / 15,769,600 bytes                               |
| Peak traced Python allocation       | 13,130,823 bytes                                            |
| Worldwide 24h tile, cold / warm     | 30.399 / 1.364 ms; 4,942 gzip bytes; 4,320 observations     |
| Worldwide 7d tile, cold / warm      | 34.202 / 1.379 ms; 5,080 gzip bytes; 15,000 observations    |
| Dense regional tile, cold / warm    | 16.444 / 1.846 ms; 661 gzip bytes; 3,756 observations       |
| Exact aggregate inspection          | 101.410 ms; 24 matching records; 15,393 response bytes      |
| 100 warm reads across 20 threads    | 49.628 ms; 100 cache hits; zero generated tiles             |
| Simulated provider outage           | All 15,000 records retained; all three sources marked stale |

These are local fixture measurements, not network or deployed-browser load times.
Actual NASA requests and MAP_KEY transactions were both zero. Browser memory,
navigation frame times, real download latency and live transaction accounting
were not measured. The outage case exercises the failed-download adapter rather
than measuring network timeout/backoff duration.

### Individual point tiles: real stored last-24-hour measurement

The explicit read-only `--global-points` benchmark was run against the existing
1,113,088,000-byte local SQLite database. Snapshot
`7036e8047eac7821277aa409` contains 87,634 canonical observations for
2026-11-14 15:46:47 through 2026-11-15 15:46:47 UTC, exclusive end. Its source
state was **stale**; no new data was fetched or claimed fresh for this benchmark.
The world tile encoded all 87,634 as separate native POINT features. Nine
additional buffered dateline geometries retained their original feature IDs.

| Operation                              | Actual measurement                                                            |
| -------------------------------------- | ----------------------------------------------------------------------------- |
| World point tile, cold / warm          | 707.161 / 1.157 ms; 687.500 ms cold process CPU                               |
| World tile size                        | 1,840,360 bytes raw; 660,269 bytes gzip                                       |
| Regional z5 tile, cold / warm          | 33.170 / 0.925 ms; 31.250 ms cold process CPU                                 |
| Regional tile membership and bytes     | 359 core records; 385 buffered features; 3,775 bytes gzip                     |
| 100 warm readers across 20 threads     | 38.746 ms total; consistent canonical count                                   |
| Two-entry serving cache                | 2,512,467 bytes; 102 hits from 104 requests                                   |
| Separate world rebuild allocation peak | 5,831,864 incremental traced Python bytes; existing cache measured separately |
| NASA requests / MAP_KEY transactions   | 0 / 0                                                                         |

Cold/warm and concurrent timings above were measured **without** allocation
tracing. The separate allocation-traced world rebuild took 3,665.318 ms; it is
reported separately because tracing substantially increases per-record Python
CPU cost. These are local serving measurements, not browser display latency,
browser memory, navigation frame times, network transfer time, or live ingestion
performance. The read-only benchmark does not measure a database import or growth.

To reproduce that retained vector endpoint benchmark, use `--global-points`
instead of `--global-raster` with the same explicit database option.
