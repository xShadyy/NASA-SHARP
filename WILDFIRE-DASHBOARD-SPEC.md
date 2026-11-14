# Wildfire Dashboard: Feature Specification and Implementation Brief

## Purpose

Build a sidebar-accessible dashboard for exploring satellite-observed burning
activity. It should make recent activity easy to monitor and, once the
harmonized historical dataset is available, make seasonal patterns, unusual
conditions, and long-term changes understandable for a selected area.

The contest's primary product is a harmonized burning-activity calendar based
on MODIS and VIIRS active-fire hotspots. The intended users include emergency
responders, early-warning teams, scientists, land managers, and firefighters.
The dashboard must distinguish satellite hotspot observations from confirmed
fire incidents: one incident can produce many observations, and detections can
also come from agricultural burning, industrial heat, volcanoes, and other
sources.

## Current platform context and implementation boundaries

### Capabilities already present in the repository

- A React, TypeScript, and Vite application with a custom Ethereal SHARP visual
  identity, light/dark themes, responsive layouts, and an Earth map.
- A collapsible sidebar navigation pattern in `src/App.tsx`, with existing
  Saved locations and Analysis entries.
- Date selection in the application header, currently offering 24 hours, 7
  days, and 30 days.
- Map location search, map layers, saved locations, and capture tools.
- Area geometry and analysis-related types/helpers in
  `src/lib/analysis-area.ts`, `src/lib/analysis-state.ts`, and
  `src/lib/analysis-countries.ts`, as well as the Analysis UI and its
  app-wide confirmed-area state. Area Analytics uses the confirmed Analysis
  geometry when one exists; otherwise it uses the default Netherlands scope.
- A Python FastAPI FIRMS service under `src/backend_api/` that proxies NASA
  FIRMS hotspot CSV data as GeoJSON. Its `/hotspots` endpoint supports `world`,
  a bounding box, or the generalized European Netherlands country boundary;
  date windows of at most 31 UTC calendar days, sensor/product selection,
  confidence thresholds, and day/night filtering. Returned feature
  properties include sensor, satellite, product processing, acquisition time,
  confidence, FRP, brightness, scan/track, day/night, and coordinates. Source
  status and partial failures are reported.

### Explicitly unfinished dependencies

- **MODIS/VIIRS harmonization:** The harmonization script, harmonized data
  product, quality assurance, and historical-query interface are not
  implemented. Long-term calendars, year-over-year summaries, and
  climatological anomalies must not be presented as complete until these exist.
- The current FIRMS endpoint is a recent-data source, not a substitute for the
  full historical harmonized record. Its 31-day query cap does not support a
  multi-year dashboard request.

Implement the dashboard in stages so the working Netherlands/recent view does
not depend on either unfinished feature. Clearly label unavailable future
capabilities rather than simulating historical results or silently substituting
other data.

## Dashboard information architecture

### Sidebar and entry point

- Add an **Area Analytics** navigation item to the existing sidebar.
- Use the existing sidebar components, active-navigation behavior, tooltips,
  focus states, and mobile-collapse behavior; do not create a second navigation
  system.
- Selecting the item opens a dashboard surface that fits the existing map
  workspace. Provide a clear close/back action and preserve the map and its
  unrelated state.
- The dashboard should remain usable at narrow widths. Stack cards/charts on
  small screens and allow chart controls to wrap rather than causing horizontal
  page overflow.

### Dashboard header and scope controls

Display:

- Page title and short explanation that values are satellite hotspot
  detections, not confirmed incident counts.
- Current area scope: use the **confirmed area from Analysis** when available.
  Otherwise default to **Netherlands (European part)** and use the repository's
  generalized national boundary for exact point-in-polygon filtering; explicitly
  note that Caribbean Netherlands is not included in this fallback.
- The selected time interval, inclusive start/end dates, timezone basis, and
  data freshness/coverage status.
- A time-interval slider with an initial value of **1 day** and an adjustable
  range up to 30 days. Stay within the backend's 31 UTC calendar-day limit.
  Display the selected duration and resulting dates beside the slider.
- Appropriate loading, empty, retryable error, and partial-data states.
  Never show a successful-looking zero when a request failed or data is
  unavailable.

Use dashboard-owned query state unless a deliberate, tested product decision
is made to share the existing header date state. Do not unexpectedly change the
map's current date or date presets when the dashboard slider moves.

### Summary cards (live/recent view)

Show the following when supported by the selected data:

1. **Hotspot detections:** total records in the requested area and interval.
   Label this as detections/observations, not fires.
2. **Change versus prior period:** percentage and absolute difference against
   the immediately preceding interval of equal duration. State the comparison
   dates. Handle a zero comparison baseline without division errors (show the
   absolute difference and explain that a percentage is unavailable).
3. **Peak activity period:** date or day/week with the highest count in the
   selected interval.
4. **Anomaly indicator:** only when there is an appropriate historical
   baseline. Show the observed value, baseline statistic, difference, baseline
   years, and whether the value is above/near/below typical activity.
   Until harmonized historical data is queryable, show an explicit
   “Historical baseline unavailable” state rather than a fabricated anomaly.
5. **Data coverage:** included products/sensors, date coverage, and whether
   any source/day failed or was partial.

Do not treat total hotspot detections as the number of unique fires. A
distinct-incident count requires a separately designed, validated
spatiotemporal clustering method and must be labeled as an estimate.

### Fire Activity at a Glance

Place a prominent **Fire Activity at a Glance** panel at the top of the
dashboard content, before KPI cards and detailed charts. Its job is to orient
users in seconds with a concise, factual readout of recent satellite-observed
activity, its short-term direction, and the reliability of the data. Use
**Observed satellite activity** as the concept—not "severity," "threat level,"
"fire danger," or a red/green all-clear indicator.

The panel must summarize the **same selected 1–30 UTC-calendar-day interval**
as the dashboard KPIs and charts and compare it with the immediately preceding
equal-length interval. Do not run a separate rolling-24-hour snapshot. Show
the selected duration and date range, selected area (Global until confirmed
Analysis-area support exists), applied sensor/day-night filters, and comparison
range. The same filters must apply to the panel, KPI cards, charts, and export.

Show:

- The number of FIRMS detections in the selected interval, clearly labeled as
  hotspot observations—not fires or incidents.
- The change from the preceding equal-length interval as an absolute difference and, when
  the prior count is non-zero, a percentage. State the comparison interval.
- A plain-language direction such as **More detections than the previous
  interval**, **Fewer detections**, or **Same detection count**. This describes
  observed counts only; it is not a severity tier or forecast.
- The latest observation timestamp and age when at least one observation was
  returned.
- Data state and caveat, with partial-source/day failures and unavailable
  comparison made obvious.

Use explicit states:

- **Loading satellite activity for the selected interval** while the request
  is pending.
- **Activity status unavailable** when the current request fails or is
  malformed; show a retry action and never substitute zero.
- **Incomplete satellite data** when the selected interval has partial products/days;
  show the returned count as partial and do not assign an activity level.
- **No detections reported** only when a complete successful query returns
  zero detections. Add: this does not confirm there is no active fire or
  threat.
- **No detections match these filters** when the successful query contains
  detections but the selected sensor/day-night filters exclude all of them.
- **Satellite activity observed** when there are detections but no reliable
  complete comparison.
- Directional comparison only when both current and previous windows are
  complete. If the previous query fails or is partial, report
  **Previous interval unavailable** rather than inferring a trend.

Always state that FIRMS near-real-time observations can be delayed or missed
because of satellite overpass timing, cloud cover, sensor characteristics, and
processing latency. A stale last-observation time or a zero detection count is
not evidence that a fire is out or an area is safe. The panel must not infer
fire perimeters, spread, population exposure, incident severity, evacuation
status, or dispatch recommendations from hotspots alone.

Do not introduce a calibrated **Low / Moderate / High / Extreme** status until
the product has a validated baseline and a defined, tested methodology.
Historical anomaly labels require the harmonized time series and must show the
baseline period, coverage, and statistic. A future **Threat assessment** is a
separate capability requiring authoritative incident/perimeter data, weather
and fire-danger conditions, exposed assets, and official safety information.

### Required visualizations

#### MVP analytics available from recent FIRMS detections

The Global/recent dashboard should expose several complementary views of the
same filtered detection set, not just a headline count:

1. **Daily trend with prior-period overlay:** paired daily bars for the selected
   interval and preceding equal-duration interval. Keep dates aligned by
   interval day, label both series, and explain when the comparison is
   unavailable or partial.
2. **Detections by product:** counts and shares by FIRMS product/source, so
   users can see which sensor/satellite is contributing to the total.
3. **Confidence distribution:** separate VIIRS low/nominal/high classes and
   MODIS numeric ranges. Make clear these are sensor-specific categories, not
   an interchangeable cross-sensor confidence score.
4. **FRP distribution and summary:** detection counts by FRP range, a median,
   the highest reported observation, and the number of records without FRP.
   Use MW and explain that FRP is not a direct measure of fire size or impact.
5. **Observation time-of-day histogram:** hourly count by acquisition time in
   UTC. Explain that this is satellite observation time—not ignition time or
   local fire-start time.
6. **Detection-density grid:** rank coarse geographic grid cells by detection
   count to help users scan concentration areas. Show cell size and coordinates;
   never describe cells as fire perimeters, incident clusters, or affected-area
   boundaries.
7. **Recent detection table:** sortable by acquisition time and FRP; show
   timestamp, sensor/satellite/product, confidence and scale, FRP, day/night,
   and coordinates. Paginate or cap visible rows while stating the number
   shown and the total matching records. For multi-week intervals,
   calculate analytics server-side and return a bounded recent-record sample
   to the browser; clearly distinguish the sample size from the interval total.
   Cache compact per-day summaries against the exact cached source batch and
   active filters so repeated periods do not decode and rescan every point.

The day/night filter remains available, but Area Analytics does not render a
day/night distribution statistic.

All counts, percentages, overlays, breakdowns, and exports must derive from
the same filters and selected period. Show denominators for percentages, report
unknown/unavailable values, and preserve partial-source warnings. The current
MVP filters are sensor and day/night; only expose additional filters after
they are applied consistently to every view and export.

#### Recent activity time series

- Show daily detections for recent windows; optionally aggregate to weeks when
  that improves readability.
- Use a labeled time axis, count axis, hover/focus details, and a visible
  indication of missing/partial days.
- Permit a meaningful comparison with the preceding equal-length interval
  when the data is available.
- Ensure chart totals reconcile with the summary-card count after applying the
  same filters and area geometry.

#### Burning-activity calendar (historical, dependent on harmonization)

- Provide a month-by-year heatmap for the selected area.
- Each cell represents the defined harmonized activity measure for a calendar
  month/year. Identify the measure, units, and any normalization.
- Include year and month labels, a readable legend, a no-data state, and
  keyboard-accessible cell details.
- Use an accessible sequential color ramp with enough contrast and do not rely
  on color alone; expose values in text/tooltips.
- Support selecting a cell/month to inspect its period and compare it with
  relevant historical values.

#### Seasonal and annual summaries (historical, dependent on harmonization)

- Show monthly climatology (prefer a clearly specified multi-year median and
  range) so users can identify seasonal peaks.
- Show annual totals and changes over time, including the selected year versus
  historical context.
- Display the underlying years and data completeness. Avoid comparing
  incomplete years as if they were full years; mark the current/incomplete year.

#### Anomaly view (historical, dependent on harmonization)

- Compare the selected month/season with the same calendar month/season in
  prior years, rather than with an unrelated annual average.
- State the statistic (for example, median), baseline interval, number of
  contributing years, data coverage, observed value, absolute deviation, and
  optional standardized score if its assumptions are met.
- Do not imply forecasting or causal explanation. An anomaly is a comparison
  with a stated baseline, not a prediction.

#### Map context

- Reuse the existing Earth map and selected area boundary where practical.
- For recent data, show detections in the selected interval and visually
  distinguish detections only when the distinction is supported (for example,
  sensor or confidence class).
- Provide a legend, map attribution where required, and a clear way to return
  to the dashboard.
- For a polygon/country selection, filter detections against the actual
  geometry, not only its bounding box. The current backend accepts `world` or
  bounding-box areas; add a correct polygon query/filter path before claiming
  polygon-scoped statistics.

### Detection inspection and filters

Expose, where present in the source records:

- Acquisition date/time (identify UTC or the selected display timezone).
- Sensor (MODIS/VIIRS), satellite, and product/processing type (NRT/standard
  processing).
- Confidence value and its scale/class.
- Fire radiative power (FRP), with units (MW).
- Day/night indicator.
- Latitude/longitude.
- Brightness, scan, and track when useful and available.

Offer filters only when all summary cards, charts, map marks, and exports can
apply them consistently. Potential filters are sensor/product, confidence
threshold, day/night, and date range. MODIS numeric confidence and VIIRS
low/nominal/high confidence are not the same scale; do not merge or compare
their raw values as though they were equivalent.

### Emergency-response decision support

Emergency users need to judge **where activity is, how recent the observation
is, whether it is increasing, what is exposed, and how trustworthy/complete
the feed is**. Prioritize the following, and keep each added feed's source,
valid time, update time, resolution, and limitations visible.

#### Useful now from FIRMS

- Latest observation timestamp, sensor/satellite, and age of the observation.
  State that an old observation is not proof the fire is out; satellite
  overpasses, clouds, and transmission latency create gaps.
- Explicitly mark the current UTC day and NRT feed as provisional/incomplete;
  "no recent detections" is not confirmation of no active fire.
- Highest reported FRP and median/distribution of FRP, always described as
  satellite-derived radiative power—not fire size, burned area, or severity.
- Confidence class/scale and product provenance for each observation.
- Approximate high-detection grid cells to help triage where observations are
  concentrated. Label these as observation-density cells, not distinct fires,
  perimeters, or incident clusters.
- Source-by-source successful/missing dates and partial-result warnings.
- A concise triage summary that states the selected area and time window, the
  detection total, latest observation age, and whether any product/date failed.
  Keep the summary factual; do not generate an incident severity or dispatch
  recommendation from the detection count alone.

#### Important follow-on layers (require additional data)

- **Authoritative active incidents, perimeters, and incident status:** link
  clustered satellite observations to an incident only when a reliable agency
  feed provides identifiers/status. Show source agency and update time; never
  infer that a hotspot is a reported incident.
- **Weather and fire-danger context:** observed/forecast wind speed and
  direction, relative humidity, temperature, precipitation, and an established
  fire-weather index for the location/time. Clearly distinguish observations
  from forecast, show forecast issue/valid times, and do not compute a spread
  direction from hotspot point locations.
- **Exposure and nearby assets:** distance/bearing to population centers,
  critical infrastructure, roads, hospitals, utilities, protected areas, and
  other user-defined assets. Use authoritative, licensed geospatial layers;
  show distance/units and avoid implying impact without perimeter and
  conditions data.
- **Public safety notices:** official evacuation orders/warnings, closures, and
  incident-management links only from responsible authorities. Surface source,
  timestamp, jurisdiction, and freshness prominently; stale/missing notices
  must not be interpreted as no risk.
- **Operational access/context:** road closures and access limitations where
  an up-to-date authority feed exists. Avoid directing responders or the public
  using unverified map routes.
- **Communications and action links:** provide source/agency links and a
  prominent reminder that this is decision support, not a dispatch system,
  evacuation instruction, or replacement for local incident command.

Do not add all of these as empty widgets to the MVP. First deliver reliable
hotspot analysis and provenance. Add contextual layers only with well-defined
feeds, licensing, timestamp/freshness handling, failure behavior, and clear
responsibility boundaries.

#### Recommended priority for emergency-user additions

1. **Freshness and coverage first:** report the newest observation, how old it
   is, the period queried, current-day provisional status, and missing/partial
   product-days. Make stale or incomplete data visually unmistakable.
2. **Location and confidence next:** provide a map/list of observations with
   sensor-specific confidence and coordinates, then coarse density summaries.
   A point is a detection location, not a perimeter or guaranteed current fire
   location.
3. **Operational context after authoritative feeds exist:** incident
   identifiers/status/perimeters, weather and fire-danger conditions, exposed
   assets, official notices, and access/closure information. Display each
   provider and its update/valid time; distinguish absent data from a verified
   absence of hazard.
4. **Actionable but non-prescriptive links:** direct users to responsible
   agencies and incident pages. Do not issue evacuation instructions, dispatch
   recommendations, or route responders based only on satellite detections.

### Download and sharing

- Provide CSV export for the currently selected area, date range, and applied
  filters, consistent with the contest suggestion. If the current API returns
  only a bounded sample, label the download as a sample; full-interval export
  requires a separate server-side streaming/export path.
- Include stable column names, units, acquisition timestamp/timezone,
  sensor/product provenance, coordinates, confidence scale, FRP, and the query
  window in the export or its metadata.
- If an export is too large or unavailable, explain the reason and offer a
  useful retry/narrow-query path. Do not silently truncate records.
- Consider downloadable chart images or a report only after the MVP data and
  CSV export are reliable.

## Data and metric definitions

### Primary source

Use NASA Earthdata FIRMS active-fire hotspot products for the initial
recent-data view and the future harmonized MODIS/VIIRS dataset for long-term
analysis. The existing backend already provides a server-side FIRMS proxy and
normalizes selected MODIS and VIIRS fields. Keep NASA credentials and
upstream-specific requests on the backend; the browser must call the
application service, never call FIRMS with a secret key.

Do not add another NASA API merely to increase the number of dashboard cards.
Add a supplementary source only when it answers a distinct requirement,
documents its temporal/spatial resolution and licensing/attribution, and can be
combined without implying false equivalence with hotspot observations.

### Harmonization requirements before historical analytics

The harmonization work must document and expose at least:

- A stable record/observation schema with source sensor, satellite, product,
  acquisition timestamp, coordinates, confidence and confidence scale, FRP and
  units, and quality/processing metadata where available.
- The harmonized activity measure and what is counted (raw detections,
  filtered observations, or another explicitly defined measure).
- A reproducible treatment of overlapping observations, duplicate records,
  differing sensor resolution/sensitivity, and different observation
  schedules. Preserve raw provenance; do not deduplicate across sensors
  without a tested, documented rule.
- Product date coverage, missing-data indicators, processing/version metadata,
  and reproducible aggregation rules.
- Validation that compares sensor overlap and documents known limitations.

Until the method is validated, keep source-specific counts available and label
any combined count as provisional. Do not call a count “harmonized” solely
because MODIS and VIIRS rows have been placed in one table.

### Geographic and temporal semantics

- Define all query intervals precisely, including whether the end is inclusive
  or exclusive, and use one convention throughout requests, charts, and CSVs.
- The current backend windows are UTC-based by default and capped at 31 UTC
  calendar days. Show this limitation and avoid off-by-one comparisons.
- Without a confirmed Analysis area, query `area=netherlands`; the backend must
  use its bounding box only to fetch candidate records, then clip both exact
  summaries and returned features to the generalized European Netherlands
  polygon. With a confirmed area, send its Polygon/MultiPolygon geometry to the
  backend, use bounded FIRMS candidate queries (split at the antimeridian when
  needed), and clip summaries and returned features to the exact confirmed
  geometry. Report the active area's name. Keep `world` available as an API
  area, but do not use it as the dashboard's initial scope.
- Treat incomplete source/day results as partial, including per-source status
  where possible. A partial total is not an authoritative complete total.

## Suggested MVP

Build the MVP in this order:

1. Add the Area Analytics sidebar entry and responsive dashboard surface.
2. Use a confirmed Analysis area when available; otherwise default to
   **Netherlands (European part)**. Keep the **1-day interval** default and
   allow the slider to adjust up to 30 days.
3. Connect to the existing backend `/hotspots` service for the Netherlands
   fallback and the geometry-aware `/hotspots/area` service for confirmed
   Analysis areas, with clear loading,
   error, empty, and partial-result handling.
4. Put **Fire Activity at a Glance** first: summarize the selected interval and
   preceding equal-length UTC-day interval, apply current filters consistently, and
   display count, factual direction, latest observation age, and data status.
   Never label it as fire severity or a safety/threat rating.
5. Show total hotspot detections, prior-period comparison, peak activity
   period, latest observation, highest/median FRP, data coverage/provenance,
   and daily activity chart.
6. Show sensor/product, confidence, FRP-range, UTC observation-hour,
   and top detection-density grid breakdowns, plus a sortable recent detections
   table with normalized FIRMS attributes.
7. Add CSV download for the exact query and filters.
8. Leave historical calendar, annual/monthly trend, and anomaly sections
   explicitly marked as dependent on harmonization; do not show mock values as
   real results.
9. Keep the confirmed Analysis geometry and the displayed area name in sync.
   The Netherlands fallback must continue using exact generalized-boundary
   filtering in both summary and full-feature paths.

### MVP acceptance criteria

- Area Analytics is reachable from the existing sidebar on desktop and mobile.
- With no confirmed Analysis area, Netherlands (European part) and 1 day are selected; a confirmed
  Analysis area replaces only the geographic scope. The displayed range matches
  the request, and the user can adjust the interval within the supported live
  limit.
- A successful response yields consistent totals and chart bins. A partial
  response is visibly marked. A failed request never appears as zero activity.
- Prior-period comparison uses the immediately preceding equal-duration
  window, and percentage edge cases are handled.
- Every displayed statistic identifies its unit/meaning and relevant period.
- CSV contents match the selected query and filters and preserve source
  provenance.
- No historical anomaly or harmonized trend is presented as real until the
  historical data path and harmonization are implemented and validated.
- Existing map navigation, date selection, saved locations, and theme behavior
  remain intact.
- Add focused tests for date-window calculations, aggregation, comparison
  edge cases, partial failures, and consistent chart/export filtering.

## AI-optimized implementation instructions

Use the following as the implementation brief when assigning this feature to an
AI coding agent:

> Implement the Wildfire Dashboard in this repository, following
> `WILDFIRE-DASHBOARD-SPEC.md` and the existing React/TypeScript conventions.
>
> **Before editing**
>
> 1. Inspect `src/App.tsx`, the sidebar components/styles, the map integration,
>    `src/backend_api/README.md`, and the FIRMS backend's `/hotspots` endpoint.
>    Verify the current application state instead of assuming this document's
>    inventory is exhaustive.
> 2. Treat the confirmed Analysis area as the dashboard scope when available;
>    retain Netherlands as the fallback. The MODIS/VIIRS harmonization pipeline
>    remains unfinished. Do not claim or fake that capability. Ask for
>    clarification only if implementation cannot proceed without a product
>    decision.
> 3. Check the worktree and preserve unrelated user changes. Keep scope limited
>    to the dashboard and directly required integration/tests/docs.
>
> **Implementation**
>
> 4. Add an Area Analytics entry using the current sidebar navigation,
>    active-state, tooltip, keyboard, and mobile-collapse patterns. Put the
>    dashboard in the existing application workspace and preserve current map
>    behavior.
> 5. Use the confirmed Analysis polygon or multipolygon when available,
>    otherwise use Netherlands (European part), with exact boundary filtering,
>    and a
>    dashboard-owned date interval initially set to 1 day. Add an accessible
>    slider and visible selected duration/date range. Clamp the live query to
>    what the backend supports (no more than 31 UTC calendar days); do not
>    silently alter the existing global date control.
> 6. Fetch data through the application's backend, not directly from NASA
>    FIRMS. Follow the existing service/API configuration conventions. Use
>    `/hotspots/area` for confirmed geometry and `area=netherlands` as fallback.
>    Abort or ignore stale
>    requests when controls change, and surface network, HTTP, malformed
>    response, and partial-source errors explicitly.
> 7. Implement typed response handling and pure aggregation helpers for
>    detections by day, total count, peak period, and prior equal-duration
>    comparison. Use the same filtered records for cards, chart, map, and CSV.
>    Account for zero-baseline comparisons, absent days, partial source
>    responses, and timezone/date boundaries. Do not use a raw detections count
>    as a count of unique fire incidents.
> 8. Present the required MVP cards and daily chart with accessible labels,
>    keyboard-operable controls, responsive layout, and light/dark theme
>    compatibility. Include sensor/product, confidence, day/night, FRP, and UTC
>    observation-hour breakdowns, summary freshness/FRP indicators, a top
>    detection-density grid, and a sortable recent detections table. Reuse
>    repository UI primitives and styling conventions.
>    8a. Place **Fire Activity at a Glance** before KPI cards. Use the same
>    selected interval as the dashboard, plus the immediately preceding
>    equal-length interval. Do not run a separate rolling-24-hour query.
>    Apply the same sensor/day-night filters and require complete results for
>    directional comparison. Show explicit
>    loading, unavailable, partial, zero-detection, and comparison-unavailable
>    states. Use factual detection-count language only; never call the result
>    fire severity, threat, danger, or an all-clear.
>    Inspect package dependencies before selecting a chart library; do not add
>    a dependency if a clear accessible implementation can be built with
>    existing tools.
> 9. Include source/sensor/product and confidence provenance in detection
>    details. Preserve distinct MODIS and VIIRS confidence scales. Do not
>    combine their confidence values into an unsupported common score.
> 10. Add CSV export for exactly the selected query/filter result, with
>     escaped fields, stable headers, timestamps, units, coordinates,
>     confidence scale, and sensor/product provenance. Handle browser download
>     cleanup and export errors.
> 11. Keep historical calendar, monthly/yearly summaries, and anomalies as
>     unavailable/coming-later UI until a real harmonized historical API exists.
>     Never use fixture/demo values in production UI without clearly marking
>     them as examples.
> 12. Do not wire region selection to an Analysis draft or bounding box. When
>     the Analysis tool becomes available, integrate only its confirmed,
>     stable area selection and ensure exact geometry filtering (or a
>     documented backend geometry query) before showing region-scoped counts.
>
> **Verification**
>
> 13. Add focused tests for window boundaries, aggregation/bin totals,
>     comparison calculations including zero baseline, stale-request handling
>     where practical, and CSV escaping/contents.
> 14. Run the smallest relevant test set, then the repository typecheck/build
>     and lint if changes warrant them. Fix regressions caused by the feature.
> 15. Review the final diff and report the files changed, implemented behavior,
>     validation run/results, and any remaining blockers from missing
>     harmonization.
>
> **Do not** change the harmonization algorithm speculatively, invent a
> historical baseline, expose the FIRMS key to the browser, interpret
> detections as confirmed fires, swallow errors, or make unrelated map/UI
> changes.

## Later roadmap

### Stage 2: confirmed region support (implemented)

- The dashboard consumes the Analysis tool's confirmed-area state and uses
  Netherlands (European part) when there is no confirmed area.
- `/hotspots/area` accepts Polygon/MultiPolygon geometry and clips summary and
  feature results to that geometry, splitting candidate requests at the
  antimeridian.
- The active area name is shown in Area Analytics; add future geometry edge
  cases to the test suite as new Analysis shapes are supported.

### Stage 3: harmonized historical calendar

- Implement and validate the harmonization pipeline and a historical data
  service for bounded area/date queries and aggregated time series.
- Build month-by-year calendar, monthly climatology, annual summaries, and
  baseline-aware anomaly indicators from this source.
- Show dataset versions, baseline years, missing data, provisional status, and
  sensor provenance.

### Stage 4: optional enhancements

- Saved monitoring areas and quick area switching.
- Downloadable calendar/chart/report outputs.
- User-configurable baseline period and confidence/product filters, once
  semantics are well-defined and all views apply them consistently.
- Additional contextual NASA or other authoritative datasets only when they
  provide a clearly described, non-duplicative user benefit.

## Source reference

This specification is based on the contest statement in
[`hackathon-problem-statement.md`](./hackathon-problem-statement.md) and the
current repository structure, including the app shell, map, sidebar, Analysis
foundations, and FIRMS backend.
