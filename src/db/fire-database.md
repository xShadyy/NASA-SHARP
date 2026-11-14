# Fire detection database handoff

This file is the spec for the database and the loader. Another agent can build the harmonization script from it without the chat.

## Goal

One Postgres table, `fire_detection`, holds active-fire pixels from every satellite. MODIS and VIIRS 375 m map into the same columns. A later satellite is a new mapper, not a new table.

Archive starts in **2005** (a major fire year). Years 2000–2004 are not loaded. VIIRS starts in **2012**, when that record begins.

## Where it runs

- Google Cloud SQL for **PostgreSQL** (not MySQL). PostGIS does not run on MySQL.
- Database name: **`postgres`** (the default database on this instance). Do not create or require a database named `fires`.
- Region `europe-west1`. Machine is 1 vCPU, 3.75 GB, the smallest this edition allows.
- Storage is about **$0.19 per GiB per month**. Budget for storage is **$260**.
- Connect with `DATABASE_URL`. Schema changes go through Cloud SQL Studio on database `postgres`, or through `psql`.

Enable PostGIS once, in database `postgres`:

```sql
create extension if not exists postgis;
```

If that statement errors with “MySQL server”, Studio is pointed at the MySQL instance. Switch to the PostgreSQL instance.

## Storage efficiency

This is what keeps the archive inside the $260 budget (about $0.19 per GiB per month).

- Start in 2005, not 2000. That drops five years of MODIS.
- One table, narrow columns. Brightness, FRP, scan, and track are `real` (4 bytes). Only latitude and longitude stay `double precision`.
- `source_attrs` is null on every archive row. The original CSV is stored only for near real-time loads. Copying it onto the full history is what blows the disk.
- Partition by year. A year that is not needed can be detached without rewriting the rest.
- The unique key updates a re-delivered overpass in place, so the same pixel is not stored twice.

Each overpass is still its own row. A later day does not replace an earlier day. The unique key is `product_code`, `platform_code`, `acquired_at`, latitude, longitude.

## Source files

NASA FIRMS CSV. Two sensors are in scope. Each one has a standard archive file and a near real-time file. The sensor and the file kind are stored as `platform_code` and `product_code` on `fire_detection`.

### MODIS NRT and standard (MCD14ML)

| FIRMS column | Meaning |
|---|---|
| latitude | Center of the ~1 km fire pixel |
| longitude | Center of the ~1 km fire pixel |
| brightness | Band 21/22 brightness temperature, Kelvin |
| scan | Along-scan pixel size, km |
| track | Along-track pixel size, km |
| acq_date | Acquisition date |
| acq_time | Acquisition time, UTC, HHMM |
| satellite | `A` Aqua, `T` Terra |
| confidence | Integer 0–100 |
| version | Collection and processing, e.g. `6.1NRT`, `6.1RT`, `6.1URT`, or `6.1` for standard |
| bright_t31 | Band 31 brightness temperature, Kelvin |
| frp | Fire radiative power, MW |
| type | Standard product only. 0 vegetation, 1 volcano, 2 other static land source, 3 offshore |
| daynight | `D` day, `N` night |

Load MODIS from **2005** onward. Use `MODIS_STD` for MCD14ML and `MODIS_NRT` for near real-time files.

### VIIRS 375 m NRT and standard

| FIRMS column | Meaning |
|---|---|
| latitude | Center of the ~375 m fire pixel |
| longitude | Center of the ~375 m fire pixel |
| bright_ti4 | I4 brightness temperature, Kelvin. Web services may call this `brightness` |
| scan | Along-scan pixel size |
| track | Along-track pixel size |
| acq_date | Acquisition date |
| acq_time | Acquisition time, UTC, HHMM |
| satellite | `N` Suomi-NPP, `N20` NOAA-20, `N21` NOAA-21 |
| confidence | `low`, `nominal`, or `high` |
| version | e.g. `1.0NRT` or `1.0` |
| bright_ti5 | I5 brightness temperature, Kelvin. Web services may call this `brightness_2` |
| frp | Fire radiative power, MW |
| daynight | `D` day, `N` night |

Load VIIRS from **2012** onward. Use `VIIRS_375_STD` for the archive and `VIIRS_375_NRT` for near real-time files.

## Harmonization

| Canonical column | MODIS | VIIRS 375 m |
|---|---|---|
| product_code | `MODIS_STD` or `MODIS_NRT` | `VIIRS_375_STD` or `VIIRS_375_NRT` |
| platform_code | `T` Terra, `A` Aqua | `N` Suomi-NPP, `N20` NOAA-20, `N21` NOAA-21 |
| location | point from latitude, longitude, WGS 84 | same |
| latitude, longitude | latitude, longitude | latitude, longitude |
| acquired_at | `acq_date` + `acq_time` as UTC | same |
| scan_km, track_km | scan, track | scan, track |
| mir_brightness_k | brightness | bright_ti4, else brightness |
| mir_channel | `MODIS_21_22` | `VIIRS_I4` |
| tir_brightness_k | bright_t31 | bright_ti5, else brightness_2 |
| tir_channel | `MODIS_31` | `VIIRS_I5` |
| frp_mw | frp | frp |
| confidence_class | map 0–100, see below | already low / nominal / high |
| confidence_pct | the 0–100 integer | null |
| day_night | daynight | daynight |
| hotspot_type | type, else null | null |
| collection | version with the suffix removed (`6.1NRT` → `6.1`) | same (`1.0NRT` → `1.0`) |
| processing_level | `URT`, `RT`, `NRT`, or `standard` when there is no suffix | same |
| source_attrs | full CSV row on NRT only | full CSV row on NRT only |

MODIS confidence bins: **low** below 30, **nominal** from 30 up to but not including 80, **high** from 80 through 100.

`acq_time` is a 4-digit UTC clock (`425` means 04:25, `2358` means 23:58). Combine with `acq_date` into `timestamptz` UTC.

Unknown CSV columns are not dropped on NRT rows. They stay inside `source_attrs`.

## Tables

There is one table: `fire_detection`. Satellite and product are columns on that row (`platform_code`, `product_code`). The `fire_detection_2005` through `fire_detection_2026` statements are year slices of that same table, which Postgres requires for partitioning. They are not extra datasets.

Run this in database `postgres` after PostGIS is enabled.

```sql
create table if not exists fire_detection (
  id bigserial,
  product_code text not null,
  platform_code text not null,
  location geography(Point, 4326) not null,
  latitude double precision not null,
  longitude double precision not null,
  acquired_at timestamptz not null,
  scan_km real,
  track_km real,
  mir_brightness_k real,
  mir_channel text,
  tir_brightness_k real,
  tir_channel text,
  frp_mw real,
  confidence_class text check (confidence_class in ('low', 'nominal', 'high')),
  confidence_pct smallint check (confidence_pct between 0 and 100),
  day_night char(1) check (day_night in ('D', 'N')),
  hotspot_type smallint check (hotspot_type between 0 and 3),
  collection text,
  processing_level text,
  source_attrs jsonb,
  primary key (id, acquired_at),
  unique (product_code, platform_code, acquired_at, latitude, longitude)
) partition by range (acquired_at);

create table if not exists fire_detection_2005 partition of fire_detection for values from ('2005-01-01') to ('2006-01-01');
create table if not exists fire_detection_2006 partition of fire_detection for values from ('2006-01-01') to ('2007-01-01');
create table if not exists fire_detection_2007 partition of fire_detection for values from ('2007-01-01') to ('2008-01-01');
create table if not exists fire_detection_2008 partition of fire_detection for values from ('2008-01-01') to ('2009-01-01');
create table if not exists fire_detection_2009 partition of fire_detection for values from ('2009-01-01') to ('2010-01-01');
create table if not exists fire_detection_2010 partition of fire_detection for values from ('2010-01-01') to ('2011-01-01');
create table if not exists fire_detection_2011 partition of fire_detection for values from ('2011-01-01') to ('2012-01-01');
create table if not exists fire_detection_2012 partition of fire_detection for values from ('2012-01-01') to ('2013-01-01');
create table if not exists fire_detection_2013 partition of fire_detection for values from ('2013-01-01') to ('2014-01-01');
create table if not exists fire_detection_2014 partition of fire_detection for values from ('2014-01-01') to ('2015-01-01');
create table if not exists fire_detection_2015 partition of fire_detection for values from ('2015-01-01') to ('2016-01-01');
create table if not exists fire_detection_2016 partition of fire_detection for values from ('2016-01-01') to ('2017-01-01');
create table if not exists fire_detection_2017 partition of fire_detection for values from ('2017-01-01') to ('2018-01-01');
create table if not exists fire_detection_2018 partition of fire_detection for values from ('2018-01-01') to ('2019-01-01');
create table if not exists fire_detection_2019 partition of fire_detection for values from ('2019-01-01') to ('2020-01-01');
create table if not exists fire_detection_2020 partition of fire_detection for values from ('2020-01-01') to ('2021-01-01');
create table if not exists fire_detection_2021 partition of fire_detection for values from ('2021-01-01') to ('2022-01-01');
create table if not exists fire_detection_2022 partition of fire_detection for values from ('2022-01-01') to ('2023-01-01');
create table if not exists fire_detection_2023 partition of fire_detection for values from ('2023-01-01') to ('2024-01-01');
create table if not exists fire_detection_2024 partition of fire_detection for values from ('2024-01-01') to ('2025-01-01');
create table if not exists fire_detection_2025 partition of fire_detection for values from ('2025-01-01') to ('2026-01-01');
create table if not exists fire_detection_2026 partition of fire_detection for values from ('2026-01-01') to ('2027-01-01');

create index if not exists fire_detection_location_gix on fire_detection using gist (location);
create index if not exists fire_detection_acquired_at_idx on fire_detection (acquired_at);
```

## What the loader agent builds

Python 3, standard library plus `psycopg`. No pandas. One function per product: CSV row in, canonical record out. A CLI takes a product code and a FIRMS CSV path and upserts on the unique key.

- Read `DATABASE_URL`. The database in that URL is `postgres`.
- Set `location` with `ST_MakePoint(longitude, latitude)::geography`.
- Write `platform_code` (`T`, `A`, `N`, `N20`, `N21`) and `product_code` (`MODIS_NRT`, `MODIS_STD`, `VIIRS_375_NRT`, `VIIRS_375_STD`) on the row. There is no platform or product table.
- Leave `source_attrs` null when the product code ends in `_STD`. Store the original row when it ends in `_NRT`.
- Reject rows with `acquired_at` before 2005-01-01.
- Do not edit files outside this spec. Do not target a database named `fires`.
