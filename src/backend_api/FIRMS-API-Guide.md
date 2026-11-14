# FIRMS Hotspot API — Quick Start

This project’s Python API serves MODIS and VIIRS active-fire detections from NASA FIRMS as GeoJSON. Teammates and frontend clients call the Python backend. The NASA map key stays on the server.

## Start the server

Install Python 3.11 or newer. Get a free key from the [NASA FIRMS Map Key page](https://firms.modaps.eosdis.nasa.gov/api/map_key/). Extract the [backend ZIP](https://chatgpt.com/library?file_id=libfile_99cc5810e7a48191a4cc20b15a93fbc2&account_id=personal) and open a Bash terminal in the directory that contains `app.py` and `requirements.txt`.

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
read -rsp 'NASA FIRMS map key: ' FIRMS_MAP_KEY
export FIRMS_MAP_KEY
printf '\n'
python -m uvicorn app:app --app-dir "$PWD" --host 127.0.0.1 --port 8000
```

Use [interactive docs](http://127.0.0.1:8000/docs) to try requests, or [OpenAPI JSON](http://127.0.0.1:8000/openapi.json) for tools and AI clients. These addresses work on the machine running the backend. If your team deploys it, substitute your deployment’s base URL.

## Endpoints

All endpoints use HTTP GET and return JSON.

| Path | What it returns |
| --- | --- |
| `/health` | `{"status":"ok"}` when the backend is running. |
| `/availability` | `products` with `source`, `min_date`, and `max_date` for each product NASA reports. Check this before choosing historical dates. |
| `/hotspots` | GeoJSON `FeatureCollection` for the specified area and time. |
| `/transactions` | Live FIRMS quota for the server key. Fields are `current_transactions`, `transaction_limit`, `transaction_interval`, and `remaining_transactions`. Usage is shared across all callers using that key. |

## Get hotspots

Recent detections from MODIS Terra/Aqua and VIIRS NOAA-20 and NOAA-21, using the default near-real-time products.

```bash
curl -sS 'http://127.0.0.1:8000/hotspots?area=-125,32,-114,42&days=2'
```

Historical nighttime detections in a local-time window. Select standard-processing products that cover the dates listed in `/availability`.

```bash
curl -sS -G 'http://127.0.0.1:8000/hotspots' \
  --data-urlencode 'area=-125,32,-114,42' \
  --data-urlencode 'start=2024-07-01T22:00' \
  --data-urlencode 'end=2024-07-02T05:00' \
  --data-urlencode 'tz=America/Los_Angeles' \
  --data-urlencode 'daynight=night' \
  --data-urlencode 'source=MODIS_SP' \
  --data-urlencode 'source=VIIRS_NOAA20_SP'
```

| Parameter | How to use it |
| --- | --- |
| `area` | Required. Decimal degrees in `west,south,east,north` order, or `world`. Split areas crossing ±180° into two queries. |
| `days`, `start_date` | `days` defaults to 1 and accepts 1–31 UTC calendar days. With `start_date=YYYY-MM-DD`, count forward from that date. Without it, count back from today, including today. |
| `start`, `end` | Supply both for a precise window, up to 31 UTC dates. Start is inclusive and end is exclusive. Omit `days` and `start_date` when using these. |
| `tz` | IANA timezone, such as `Europe/Amsterdam`. Required for timestamps without an offset. Output local time defaults to UTC. Use explicit offsets for ambiguous daylight-saving times. |
| `daynight` | `all` (default), `day`, or `night`, using NASA’s observation flag. |
| `source` | Repeat to select multiple products. Product prefixes are `MODIS`, `VIIRS_NOAA20`, `VIIRS_NOAA21`, and `VIIRS_SNPP`, with suffix `_NRT` or `_SP`. Standard processing (`_SP`) requires explicit dates. |
| Confidence | `modis_min_confidence` accepts 0–100 (default 0). `viirs_min_confidence` accepts `l`, `n`, or `h` (default `l`). |

## Read the result

- `features` contains detected pixels. Coordinates are `[longitude, latitude]`. Use `properties.acquired_at` for UTC and `properties.acquired_at_local` for display. Keep `source`, `satellite`, and native `confidence` when comparing products.
- Check `partial` and each source’s `failed_days` before interpreting `count`. A complete response can contain zero detections. Pixel counts describe detections, and multiple pixels can belong to the same fire.
- The backend caches successful batches by product, bounding box, and UTC date. Different filters can reuse the same batch.

## Troubleshooting

| Response | What to check |
| --- | --- |
| `404` | Check the host and port. Open `/docs` and verify the route is listed. Start Uvicorn from the folder containing the latest `app.py`. |
| `422` | Check the area, date window, timezone, and filter values. |
| `502` | Check the returned detail, FIRMS key, quota, and NASA product availability. A hotspot query can return HTTP 200 with `partial: true` if only some batches failed. |

```bash
curl -i 'http://127.0.0.1:8000/transactions'
```
