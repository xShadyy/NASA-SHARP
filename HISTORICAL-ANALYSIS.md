# Regional history and experimental outlook

The existing method is implemented: `afternoon-active-cells-2km-1`.
It keeps afternoon Aqua and selected VIIRS platforms, counts their equal-area
2 km cells, uses the VIIRS cell union in the VIIRS era and fits the Aqua-era
scale from at least 14 usable regional overlap days. Raw MODIS and VIIRS
observations are never added to construct this metric. Terra is excluded.

## Load genuine regional history

No production historical archive ships with this checkout. Historical summaries
therefore require an imported archive. Tests use explicitly synthetic fixtures;
no fixture is served as production history. When no forecast is supported, the
outlook control may display real cached selected-interval recurrence as a clearly
labeled historical activity diagnostic, with no probabilities or forecast horizon.

The Burning Activity Calendar accepts custom intervals longer than 31 days in
the same panel. These use stored daily summaries, with month navigation; selecting
a day loads only that day's bounded observations onto the map. The browser never
requests decades of raw observations, and a long selection never starts a global
or regional historical backfill. Missing archived days remain unavailable.

Use the canonical CSV format already supported by `harmonize.py`, exported
from an authorized regional archive. Required detection fields:

```text
platform_code,latitude,longitude,acquired_at,frp_mw,confidence_class,confidence_pct,day_night,scan_km,track_km,nominal_resolution_m,source_product,product_version,processing_tier
```

Codes are `T`, `A`, `N`, `N20`, `N21`. UTC timestamps must include an offset.
Optional values stay empty/unknown. Native MODIS confidence is 0–100; VIIRS
classes are `low`, `nominal`, `high`. Source product, processing tier and
version are retained. Use one consistent nonduplicated product generation
for a platform/acquisition; the importer preserves supplied rows and does
not decide which overlapping archive/NRT version supersedes another.

Coverage is mandatory and separate:

```text
date,platform_code,state
```

States are `complete`, `partial`, `unknown`. An omitted platform/day is
unavailable. A `complete` row means the **reporting window for the whole
registered region** was retrieved completely; it never means every grid
cell was observed cloud-free. Do not infer completeness from a detection
being present. Every detection must have an explicit coverage record.
Zero detections with complete reporting can be a valid reported zero.

Create a manifest with the actual coverage domain, source identity and
processing generation. Example schema (replace these values with your data):

```json
{
  "regionId": "regional-extract",
  "regionName": "Regional archive coverage",
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
  "datasetVersion": "regional-standard-products-v1",
  "sources": [
    { "product": "actual-product-id", "processingTier": "standard", "version": "actual-version" }
  ],
  "forecastPlatforms": ["suomi-npp"]
}
```

The rectangle is only a schema example, not an assertion of supplied
coverage. A nonrectangular manifest is served only for that exact AOI;
a rectangular domain can serve any fully contained AOI. This avoids
extending regional coverage to unsupported countries or boundary cells.
`forecastPlatforms` fixes the reporting configuration used for training and
labels; every configured platform must have complete coverage on a target
or feature day. Changes require retraining.

From the repository root, with the backend virtual environment installed:

```powershell
src/backend_api/.venv/Scripts/python.exe tools/sharp-history.py import --detections data/region.csv --coverage data/region-coverage.csv --manifest data/region.json --output data/region-history.sqlite
$env:SHARP_HISTORY_PATH = (Resolve-Path data/region-history.sqlite).Path
```

Import validates region membership and coverage, preserves provenance and
replaces the registered dataset in one SQLite transaction. Generation hashes
include records, coverage and manifest identity. The reader maintains a
bounded two-generation cache invalidated by file change. The path is local
and server-side. No global or multidecade download occurs.

## Historical contract and baseline

`POST /analysis/history` accepts the existing serialized `query` and optional
`options.baselineYears` and `options.minimumYears`. It aggregates on the
server independently of the 31-day raw map acquisition path and returns
daily harmonized activity, year/month totals, seasonal median/range,
selected-period comparison, coverage, source generation and method evidence.

Monthly sums are **active-cell-days**, not unique cells, distinct fires or
burned area. `value` is present only for a fully covered month; `observedSum`
is the reported partial sum, which is never extrapolated. Missing days
remain null. The current unfinished UTC day is partial.

Baseline policy:

- By default use stored years strictly before the selected start year.
- Require at least three eligible years; callers may raise this threshold.
- Every compared date must have complete coverage and a nonmissing value.
- Use the median and linearly interpolated 25th–75th percentile range.
- Exclude 29 February from both sides of comparisons; preserve it in actual
  calendar totals. February seasonal comparison therefore uses 28 days.
- Compare a partial selected month only through equivalent completed UTC
  dates in each historical year. Never extrapolate a partial sum.
- Period comparisons cover at most one occurrence of each month/day.
  A multiyear selection still has full historical summaries, but no
  single-year seasonal difference is manufactured for it.
- All compared periods use the same current method, selected source/platform
  filters and regional overlap calibration. An incompatible archive method
  is rejected. Eligible/excluded years and covered/expected days are returned.

`POST /analysis/method` reports common-cell Aqua/VIIRS overlap counts, scale,
overlap dates and calibration-fit mean absolute differences. No independent
validation is asserted. Agreement on fitting days is not fire-detection
accuracy.

`POST /analysis/recurrence` reuses the canonical recent acquisition cache and
the fixed existing 2 km equal-area grid. It returns distinct detection UTC
dates, first/latest reported acquisition, record count and reporting-day
coverage per occupied cell. It rejects more than 20,000 occupied cells
explicitly. Repeated reports do not establish continuous burning, fire
duration, spread, incident identity or burned area.

## Train and evaluate offline

```powershell
src/backend_api/.venv/Scripts/python.exe tools/sharp-history.py train --archive data/region-history.sqlite --output data/region-outlook.json --iterations 150
$env:SHARP_OUTLOOK_MODEL_PATH = (Resolve-Path data/region-outlook.json).Path
```

Training never runs during API requests or map interaction. It needs at least
120 complete reporting days and both classes in training and calibration.
The initial bounded pure-Python implementation permits at most 5,000
candidate 10 km cells and 300,000 cell/day examples; choose a smaller genuine
regional extract when the explicit limits are exceeded. No new backend
dependency, negative sampling, class weighting or imputation is used.

The target is **probability of at least one reported satellite hotspot
detection in a grid cell during the next 24 hours**. It includes repeated
reports of existing activity. A complete regional reporting window permits
a no-report label, never a confirmed absence-of-fire label.

The model is regularized logistic regression with seasonal sine/cosine,
lagged cell reports, seven available-day activity and supported neighboring
10 km cells' lagged activity. Neighbor support fraction is a separate feature;
cells outside the registered reporting domain are never counted as covered
zero-report neighbors. No weather or fuel data are fabricated.
The conservative assumed publication delay is 24 hours: a midnight issue
uses complete acquisitions from two UTC dates earlier and older. Since
actual publication timestamps are absent, evaluation is **retrospective**,
not a fully operational historical replay.

The first 60% of complete reporting dates train the model and its seasonal
climatology/recent-persistence baselines, the next 20% fit Platt calibration
and choose the better baseline, and the final 20% are untouched test dates.
Two full days separate partitions. The target is one nonoverlapping UTC
day. Feature windows may use genuinely earlier observations from a prior
partition, as they would at issue time; no outcome/preprocessing parameter
from later partitions enters earlier fitting. There is no spatial holdout;
the model is restricted to its exact registered training domain.

Promotion criteria are defined in code before final holdout evaluation:

- At least 500 test examples, 20 positives and 100 negatives.
- Brier skill of at least 0.02 against the baseline chosen on calibration.
- Average precision/PR-AUC at least 1.2 times test event prevalence.
- Ten-bin expected calibration error at most 0.05.

The artifact reports partition dates, counts, prevalence, PR-AUC (average
precision with tied scores grouped), Brier score, baseline skill, reliability
bins, precision/recall within the highest-ranked 5% of available equal-area
cells selected independently at each issue, and all
promotion checks. Overall accuracy is not used. Weights, evaluation and
version identity are deterministic for unchanged inputs and parameters;
`trainedAt` records the execution time separately.

The selected area budget rounds up to a whole cell. The reported actual
selected fraction and mean selected area explain this discretization; a
one-cell fixture cannot represent an exact 5% area. Ranking ties use stable
cell order, never held-out labels. The baseline preserves the selected method
and platform filter; its reporting coverage follows the stored platforms
available on each date, so changes in the observing constellation and cloud
coverage remain a limitation of comparisons, not evidence of physical fire
change.

No production model has been trained or validated in this checkout. Tests
exercise fitting/evaluation with fixtures; their metrics are not evidence of
operational scientific skill. If criteria fail, only correctly labeled
historical counts are served. Probability fields remain null. Missing input
windows, unsupported regions and stale reporting are masked/unavailable.

`POST /analysis/outlook` serves the current 24-hour issue only for a map
interval containing the current UTC date. Historical dates have no current
forecast. Its bounded cache keys include model, issue, input generation and
query identity. A configured artifact must match method, dataset, domain and
platform configuration; new inputs invalidate cached results without
retraining. No forward forecast is served inside its final test period.

## Official fire-weather context

Provider documentation checked during implementation:

- [EFFIS official WMS download instructions](https://forest-fire.emergency.copernicus.eu/downloads-instructions)
- [GWIS fire-danger forecast background](https://gwis.jrc.ec.europa.eu/about-gwis/technical-background/fire-danger-forecast)
- [ECMWF CEMS-Fire access and archived-data restrictions](https://confluence.ecmwf.int/spaces/CEMS/pages/382667784/CEMS-Fire+Data+access)

`GET /analysis/weather-context` is an optional standard EFFIS WMS adapter.
It defaults to unavailable. To configure an actual provider layer, set
`SHARP_EFFIS_LAYER`, `SHARP_EFFIS_ISSUE_TIME`, `SHARP_EFFIS_VALID_TIME`, and
`SHARP_EFFIS_RESOLUTION_KM` from the provider's current product metadata.
The adapter returns a standard tile URL for the official WMS and retains
provider identity, native FWI units, issue/valid time and actual resolution.
It does not infer freshness, create credentials, ingest weather into the
model or interpret FWI as an ignition probability. The provider may require
separate data access for archived forecast fields; no undocumented JSON API
or credentials are assumed. A rendered weather layer is not enabled by this
adapter alone.

## Verification and measured limits

Run the backend suite from the root:

```powershell
src/backend_api/.venv/Scripts/python.exe -m unittest discover -s src/backend_api/tests
```

The scientific performance fixture test records actual local timings in
`tools/benchmark-scientific-results.json`: a five-year 73,920-observation
summary, offline training/evaluation, first serving and repeated cached
serving. These are synthetic CPU-path measurements and exclude genuine
archive import scale, remote acquisition latency and browser rendering.
No production historical coverage or forecast accuracy is claimed.
