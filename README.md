<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/brand/sharp-logo-white.svg">
    <img src="public/brand/sharp-logo.svg" alt="SHARP logo" width="420">
  </picture>

  <h1>SHARP</h1>

  <p><strong>Satellite Harmonization and Activity Records Platform</strong></p>

  <p>Explore satellite hotspots. Investigate a region. Understand its burning activity.</p>

  <p>
    <a href="https://www.spaceappschallenge.org/2026/challenges/modis-and-viirs-hot-spots/"><img src="https://img.shields.io/badge/NASA_Space_Apps-2026-0B3D91?style=flat-square" alt="NASA Space Apps 2026"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-2563EB?style=flat-square" alt="Apache 2.0"></a>
    <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript"></a>
    <a href="https://react.dev/"><img src="https://img.shields.io/badge/React-20232A?style=flat-square&logo=react&logoColor=61DAFB" alt="React"></a>
    <a href="https://www.python.org/"><img src="https://img.shields.io/badge/Python-3.11%2B-3776AB?style=flat-square&logo=python&logoColor=white" alt="Python 3.11+"></a>
    <a href="https://fastapi.tiangolo.com/"><img src="https://img.shields.io/badge/FastAPI-009688?style=flat-square&logo=fastapi&logoColor=white" alt="FastAPI"></a>
    <a href="https://maplibre.org/"><img src="https://img.shields.io/badge/MapLibre_GL-396CB2?style=flat-square" alt="MapLibre GL"></a>
  </p>

  <p>
    <a href="#about">About</a> ·
    <a href="#features">Features</a> ·
    <a href="#run-locally">Run locally</a> ·
    <a href="#harmonization">Harmonization</a> ·
    <a href="#data-sources">Data sources</a> ·
  </p>
</div>

## About

**SHARP** is an interactive platform for exploring satellite fire observations and analyzing burning activity within a selected area. Built by **Team Ethereal** for NASA Space Apps 2026, it addresses the [Harmonization of MODIS and VIIRS Hot Spots](https://www.spaceappschallenge.org/2026/challenges/modis-and-viirs-hot-spots/) challenge.

MODIS and VIIRS differ in spatial resolution and sampling. Directly combining their detection counts can confuse changes in satellite coverage with changes in activity. SHARP keeps the original observations available for inspection and calculates a separate harmonized activity metric on a common spatial grid.

Begin with a worldwide view of the last 24 hours, select a country or draw an area, then explore its calendar, analytics, individual records, and available historical comparisons.

## Features

| Feature | What it provides |
| --- | --- |
| **Interactive globe and map** | Globe and flat-map projections, place search, geographic labels, and multiple base maps. |
| **Global hotspot layer** | Shared last-24-hour MODIS and VIIRS observations rendered through transparent raster tiles. |
| **Area selection** | Country boundaries or custom drawn areas, editable geometry, automatic framing, and emphasis on the selected region. |
| **Burning Activity Calendar** | Date and range selection, daily activity, focused-day inspection, and reporting-coverage states. |
| **Area Analytics** | Daily comparisons, satellite and quality breakdowns, hourly distributions, and an independent scope with **Apply to map**. |
| **Records explorer** | Query-wide search, sensor-specific filters, stable sorting, grouping, pagination, and frozen selections. |
| **Historical analysis** | Coverage-aware reference periods, explicit **Load historical data**, and recurrence diagnostics. |
| **Method evidence** | Explanation of harmonization, calibration support, source generation, and data completeness. |
| **Exports and reports** | CSV, GeoJSON, reproducibility JSON, map captures, and a printable analysis brief. |
| **Map tools** | Distance and area measurements, saved locations, and links sharing the map center. |
| **Context layers** | Protected areas, Natura 2000, settlement extent, known volcanoes, and dated Landsat scene footprints. |
| **Responsive workspace** | Resizable map and analytics split on desktop, with tabs on smaller screens. |

Available base maps include **Blue Marble**, **Topographic**, **Dark Gray**, **Light Gray**, and **Firefly**.

## Run locally

### Requirements

- Git and npm.
- Node.js matching **`^20.19.0 || >=22.12.0`**.
- Python **3.11+**, with `venv` and pip.
- Internet access and a browser supporting WebGL.

The default global view uses public NASA FIRMS downloads and **does not require an API key**.

### 1. Clone and install

```bash
git clone https://github.com/xShadyy/NASA-SHARP.git
cd NASA-SHARP
npm ci
```

### 2. Start the backend

Run the commands for your operating system from the repository root. Keep the terminal open.

**Windows PowerShell**

```powershell
py -3 -m venv src/backend_api/.venv
.\src\backend_api\.venv\Scripts\python.exe -m pip install -r src/backend_api/requirements.txt
.\tools\start-global-backend.ps1
```

For automatic backend reloads during development:

```powershell
.\tools\start-global-backend.ps1 -Reload
```

**Linux / macOS**

```bash
python3 -m venv src/backend_api/.venv
src/backend_api/.venv/bin/python -m pip install -r src/backend_api/requirements.txt
src/backend_api/.venv/bin/python -m uvicorn app:app --app-dir src/backend_api --host 127.0.0.1 --port 8000 --workers 1
```

Reuse an existing virtual environment if one is already installed.

### 3. Start the frontend

Open a second terminal at the repository root:

```bash
npm run dev
```

Open the address printed by Vite, usually **http://localhost:5173**.

| Service | Local address |
| --- | --- |
| Frontend | http://localhost:5173 |
| Backend | http://127.0.0.1:8000 |
| Interactive API reference | http://127.0.0.1:8000/docs |
| Health check | http://127.0.0.1:8000/health |
| Global data status | http://127.0.0.1:8000/global/status |

The initial global import runs in the background. Check the source status while it completes; partial or unavailable data are reported explicitly.

## Using SHARP

1. Open **Map & layers** to choose a base map and contextual overlays.
2. Open **Burning Activity Calendar** and select a country or draw an area of interest.
3. Confirm the area, choose a date or range, and inspect activity and reporting coverage.
4. Open **Area Analytics** and explore **Overview**, **Records**, **History**, and **Method**.
5. Use **Apply to map** to display the analytics scope on the map.
6. Export matching records and reproducibility metadata, or capture a matching map for the printable brief.

The address-bar URL shares the **map center coordinates**. Dates, layers, zoom, saved locations, measurements, and analytical state are not included.

## Harmonization

SHARP implements **`afternoon-active-cells-2km-1`**:

- Eligible afternoon Aqua and selected VIIRS observations are assigned to a fixed **2 km equal-area grid**.
- During the VIIRS era, activity uses the union of active cells across selected VIIRS platforms. Aqua cells are not added to that total.
- Earlier Aqua-era activity can be scaled using the median VIIRS-to-Aqua active-cell ratio after at least **14 usable overlap days**.
- Terra observations remain available in raw records and are excluded from this afternoon metric.
- Monthly totals are expressed in **active-cell-days**, the sum of daily activity.

Raw detection counts, harmonized activity, and reported fire radiative power in **MW** remain separate measures. Active cells are not counts of distinct fires or burned area, and calibration agreement is not independent detection accuracy.

Historical reference comparisons require at least **three eligible prior years** with complete reporting for corresponding dates. Comparisons use the median and interquartile range, align elapsed dates, and preserve missing data as unavailable.

## Data handling

The default global sources are **MODIS Collection 6.1 NRT**, **VIIRS NOAA-20 Collection 2 NRT**, and **VIIRS NOAA-21 Collection 2 NRT**. Terra and Aqua records remain distinct. Historical Suomi NPP support is separate from the current default bulk feeds.

A shared backend importer checks the public 24-hour extracts hourly by default. Published snapshots give map tiles, records, and exports a consistent observation membership. Panning and zooming request local tiles without starting new FIRMS acquisition.

The rolling **24-hour window** is anchored to the publication and can cross two UTC dates. Historical data are loaded explicitly or imported by an operator; a complete multi-year archive is not bundled with the repository.

## Configuration

Set backend variables in the server environment before startup. [`config/global.env.example`](config/global.env.example) lists global-ingestion settings and is not loaded automatically.

| Variable | Purpose / default |
| --- | --- |
| `SHARP_GLOBAL_DB_PATH` | Durable SQLite store; defaults to `src/backend_api/data/global-hotspots.sqlite`. |
| `SHARP_GLOBAL_INGEST_ENABLED` | Enable shared ingestion; default `1`. |
| `SHARP_GLOBAL_REFRESH_SECONDS` | Refresh-check interval; default `3600`, minimum `300`. |
| `SHARP_GLOBAL_SOURCES` | Default: `MODIS_NRT,VIIRS_NOAA20_NRT,VIIRS_NOAA21_NRT`. |
| `FIRMS_MAP_KEY` | Optional backend key for bounded regional/history acquisition beyond stored coverage. |
| `SHARP_API_PROXY_TARGET` | Vite proxy target; default `http://127.0.0.1:8000`. |
| `VITE_FIRMS_API_BASE_URL` | Frontend API base; default `/firms-api`. |
| `SHARP_CORS_ORIGINS` | Exact allowed frontend origins when using separate hosts. |

Keep `FIRMS_MAP_KEY` server-side. Do not put it in `VITE_` variables, which can be exposed in the browser bundle.

## Production build

```bash
npm run build
npm run preview
```

The build produces **`dist/`**. Preview serves it locally for verification.

For production, serve `dist/` with SPA fallback and an API reverse proxy. To use `/api`, set the following before building, for example in `.env.production.local`:

```dotenv
VITE_FIRMS_API_BASE_URL=/api
```

Forward `/api/` to the Python backend, removing that prefix. Run the backend with **one API worker** and persist the SQLite directory, including WAL/SHM sidecars. The supported deployment is one host with one durable local SQLite volume.

## Development

Run checks from the repository root:

```bash
npm run typecheck
npm run lint
npm run test
npm run build
npm run format:check
```

**Backend tests on Linux / macOS**

```bash
src/backend_api/.venv/bin/python -m unittest discover -s src/backend_api/tests
```

**Backend tests on Windows**

```powershell
.\src\backend_api\.venv\Scripts\python.exe -m unittest discover -s src/backend_api/tests
```

The frontend uses **React, TypeScript, Vite, Tailwind CSS, MapLibre GL, TanStack Query, and Terra Draw**. The backend uses **Python, FastAPI, HTTPX, Uvicorn, and SQLite**.

## Data sources

| Resource | Used for |
| --- | --- |
| [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/content/active_fire/) | MODIS and VIIRS hotspot observations. |
| [NASA GIBS](https://nasa-gibs.github.io/gibs-api-docs/) | Imagery and contextual raster layers. |
| [NASA Blue Marble](https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/base-topography-bathymetry/) | Global Earth imagery. |
| [NASA / SEDAC HBASE](https://data.nasa.gov/dataset/global-human-built-up-and-settlement-extent-hbase-dataset-from-landsat) | Human built-up extent for 2010. |
| [NASA CMR / LP DAAC / USGS HLS L30](https://lpdaac.usgs.gov/products/hlsl30v002/) | Dated Landsat 8 and 9 scene footprints. |
| [Protected Planet / UNEP-WCMC / IUCN](https://www.protectedplanet.net/) | Protected-area context, under [separate data terms](https://www.protectedplanet.net/en/legal). |
| [European Environment Agency](https://www.eea.europa.eu/en/datahub/datahubitem-view/6fc8ad2d-195d-40f4-bdec-576e7d1268e4) | Natura 2000 protected areas. |
| [Smithsonian Global Volcanism Program](https://doi.org/10.5479/si.GVP.VOTW5-2026.5.4) | Known Holocene volcano locations. |
| [OpenFreeMap](https://openfreemap.org/), [OpenMapTiles](https://www.openmaptiles.org/), [OpenStreetMap](https://www.openstreetmap.org/copyright) | Cartographic services and geographic data. |
| [Natural Earth](https://www.naturalearthdata.com/about/terms-of-use/), [geoBoundaries](https://github.com/wmgeolab/geoBoundaries/tree/1289e40e366c7b320550be1ee0614a9472d572d4/releaseData/gbOpen) | Geographic reference data and country boundaries. |
| [Photon](https://photon.komoot.io/) | Place search. |
| [NASA SVS / ESA Gaia / DPAC](https://svs.gsfc.nasa.gov/4851/) | Star-map background. |

Landsat footprints represent archived scenes, volcano locations are a reference layer, and HBASE describes settlement extent in 2010. Attribution and applicable terms are retained in the application and [third-party notices](THIRD-PARTY-LICENSES.txt).

## License

Original project software is licensed under the **[Apache License 2.0](LICENSE)**. External datasets, services, fonts, imagery, and other third-party assets retain their applicable terms. See [THIRD-PARTY-LICENSES.txt](THIRD-PARTY-LICENSES.txt).
