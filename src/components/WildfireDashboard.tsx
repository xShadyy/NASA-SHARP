import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { AnalysisArea } from '@/lib/analysis-area'
import {
  aggregateDailyActivity,
  compareActivity,
  detectionsToCsv,
  filterDetections,
  getDashboardWindows,
  isHotspotResponse,
  peakActivity,
  shiftUtcDate,
  type DetectionCell,
  type CountBucket,
  type HotspotDetection,
  type HotspotResponse,
} from '@/lib/wildfire-dashboard'
import './WildfireDashboard.css'

const API_BASE = (import.meta.env.VITE_FIRMS_API_BASE_URL || '/api').replace(/\/$/, '')
const DASHBOARD_AREA = 'netherlands'
const DASHBOARD_AREA_LABEL = 'Netherlands (European part)'

function formatNumber(value: number) {
  return new Intl.NumberFormat().format(value)
}

function formatDay(value: string, options: Intl.DateTimeFormatOptions = {}) {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
    ...options,
  }).format(new Date(`${value}T00:00:00Z`))
}

function formatObservationAge(value: string) {
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60_000))
  if (elapsedMinutes < 60) return `${elapsedMinutes} min ago`
  const hours = Math.floor(elapsedMinutes / 60)
  if (hours < 48) return `${hours} hr ago`
  return `${Math.floor(hours / 24)} days ago`
}

function errorMessage(value: unknown) {
  return value instanceof Error ? value.message : 'The hotspot request failed.'
}

function hotspotErrorDetail(detail: unknown) {
  if (typeof detail === 'string') return detail
  if (!detail || typeof detail !== 'object' || !('sources' in detail)) return null
  const sources = (detail as { sources?: unknown }).sources
  if (!Array.isArray(sources)) return null
  const failures = sources.flatMap((source) => {
    if (!source || typeof source !== 'object') return []
    const report = source as {
      source?: unknown
      failed_days?: unknown
    }
    if (typeof report.source !== 'string' || !Array.isArray(report.failed_days)) return []
    const details = report.failed_days.flatMap((day) => {
      if (!day || typeof day !== 'object' || !('detail' in day)) return []
      const message = (day as { detail: unknown }).detail
      return typeof message === 'string' ? [message] : []
    })
    return details.length ? [`${report.source}: ${[...new Set(details)].join(', ')}`] : []
  })
  return failures.length ? `FIRMS could not provide detections. ${failures.join('; ')}` : null
}

async function fetchWindow(
  startDate: string,
  days: number,
  sensor: 'all' | 'MODIS' | 'VIIRS',
  daynight: 'all' | 'day' | 'night',
  analysisArea: AnalysisArea | null,
  signal: AbortSignal,
) {
  const query = new URLSearchParams({
    area: DASHBOARD_AREA,
    start_date: startDate,
    days: String(days),
  })
  if (daynight !== 'all') query.set('daynight', daynight)
  const sources =
    sensor === 'MODIS'
      ? ['MODIS_NRT']
      : sensor === 'VIIRS'
        ? ['VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT']
        : []
  for (const source of sources) query.append('source', source)
  query.set('summary', 'true')
  return fetchHotspots(query, signal, analysisArea)
}

async function fetchHotspots(
  query: URLSearchParams,
  signal: AbortSignal,
  analysisArea: AnalysisArea | null,
) {
  let response: Response
  try {
    response = analysisArea
      ? await fetch(`${API_BASE}/hotspots/area`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            geometry: analysisArea.geometry,
            start_date: query.get('start_date'),
            days: Number(query.get('days')),
            daynight: query.get('daynight') ?? 'all',
            source: query.getAll('source'),
            summary: query.get('summary') === 'true',
          }),
          signal,
        })
      : await fetch(`${API_BASE}/hotspots?${query}`, { signal })
  } catch (error) {
    if (signal.aborted) throw error
    throw new Error(
      'Cannot reach the hotspot API. Check that the Vite server and FIRMS backend are running.',
      { cause: error },
    )
  }
  const contentType = response.headers.get('content-type') ?? ''
  let payload: unknown
  if (contentType.includes('application/json')) {
    try {
      payload = await response.json()
    } catch {
      throw new Error(`Hotspot API returned malformed JSON (HTTP ${response.status}).`)
    }
  } else {
    await response.text()
    if (response.status === 502 || response.status === 503 || response.status === 504) {
      throw new Error(
        `The Vite API proxy cannot reach the FIRMS backend at 127.0.0.1:8000 (HTTP ${response.status}). Start the backend from src/backend_api; see its README for setup.`,
      )
    }
    throw new Error(`Hotspot API returned a non-JSON response (HTTP ${response.status}).`)
  }
  if (!response.ok) {
    const detail =
      payload && typeof payload === 'object' && 'detail' in payload
        ? (payload as { detail: unknown }).detail
        : null
    throw new Error(
      hotspotErrorDetail(detail) ?? `Hotspot service request failed (HTTP ${response.status}).`,
    )
  }
  if (!isHotspotResponse(payload))
    throw new Error('Hotspot service returned data in an unexpected format.')
  return payload
}

function ActivityChart({
  days,
  previousDays,
  busy,
}: {
  days: Array<{ date: string; count: number }>
  previousDays: Array<{ date: string; count: number }>
  busy: boolean
}) {
  const max = Math.max(
    1,
    ...days.map(({ count }) => count),
    ...previousDays.map(({ count }) => count),
  )
  const labelStep = Math.max(1, Math.ceil(days.length / 7))
  return (
    <figure className="wildfire-chart" aria-busy={busy}>
      <figcaption className="wildfire-chart-caption">
        <span>Detections per day</span>
        <span>UTC · {formatNumber(max)} max</span>
      </figcaption>
      <div className="wildfire-chart-scroll">
        <div
          className="wildfire-bars"
          role="group"
          aria-label="Daily hotspot detections; current interval compared with the previous interval"
        >
          {days.map(({ date, count }, index) => (
            <div className="wildfire-bar-column" key={date}>
              <div className="wildfire-bar-pair">
                {previousDays[index] && (
                  <button
                    type="button"
                    className="wildfire-bar is-previous"
                    style={{
                      height: `${Math.max(2, (previousDays[index].count / max) * 100)}%`,
                    }}
                    aria-label={`Previous interval, day ${index + 1}: ${formatNumber(previousDays[index].count)} detections`}
                    title={`Previous interval, day ${index + 1}: ${formatNumber(previousDays[index].count)} detections`}
                  />
                )}
                <button
                  type="button"
                  className="wildfire-bar"
                  style={{ height: `${Math.max(2, (count / max) * 100)}%` }}
                  aria-label={`${formatDay(date, { year: 'numeric' })}: ${formatNumber(count)} detections`}
                  title={`${formatDay(date, { year: 'numeric' })}: ${formatNumber(count)} detections`}
                />
              </div>
              {index % labelStep === 0 || index === days.length - 1 ? (
                <span className="wildfire-bar-label" aria-hidden="true">
                  {formatDay(date)}
                </span>
              ) : (
                <span className="wildfire-bar-label" aria-hidden="true">
                  &nbsp;
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="wildfire-chart-axis" aria-hidden="true">
        <span>0</span>
        <span>{formatNumber(max)} detections</span>
      </div>
      <div className="wildfire-legend">
        <span>
          <i className="wildfire-legend-current" /> Selected interval
        </span>
        <span>
          <i className="wildfire-legend-previous" /> Previous interval
        </span>
      </div>
    </figure>
  )
}

function BreakdownChart({
  title,
  description,
  buckets,
  emptyLabel = 'No detections for this breakdown.',
}: {
  title: string
  description: string
  buckets: CountBucket[]
  emptyLabel?: string
}) {
  const max = Math.max(1, ...buckets.map(({ count }) => count))
  const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0)
  return (
    <section className="wildfire-card wildfire-analysis-card">
      <div className="wildfire-section-heading">
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
      </div>
      {total ? (
        <ul className="wildfire-breakdown">
          {buckets.map(({ label, count }, index) => (
            <li key={label}>
              <div className="wildfire-breakdown-heading">
                <span>{label}</span>
                <strong>
                  {formatNumber(count)} <small>({((count / total) * 100).toFixed(1)}%)</small>
                </strong>
              </div>
              <div
                className="wildfire-breakdown-track"
                role="img"
                aria-label={`${label}: ${formatNumber(count)} detections, ${((count / total) * 100).toFixed(1)} percent`}
              >
                <span
                  className={`wildfire-breakdown-fill wildfire-fill-${index % 5}`}
                  style={{ width: `${(count / max) * 100}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="wildfire-empty">{emptyLabel}</p>
      )}
    </section>
  )
}

function HourlyChart({ hours }: { hours: Array<{ hour: number; count: number }> }) {
  const max = Math.max(1, ...hours.map(({ count }) => count))
  return (
    <section className="wildfire-card wildfire-analysis-card">
      <div className="wildfire-section-heading">
        <div>
          <h2>Observation time of day</h2>
          <p>Detections grouped by acquisition hour in UTC; not local fire-start time.</p>
        </div>
      </div>
      <div className="wildfire-hourly" role="group" aria-label="Detections by UTC hour">
        {hours.map(({ hour, count }) => (
          <div className="wildfire-hour" key={hour}>
            <button
              type="button"
              className="wildfire-hour-bar"
              style={{ height: `${Math.max(2, (count / max) * 100)}%` }}
              title={`${String(hour).padStart(2, '0')}:00 UTC · ${formatNumber(count)} detections`}
              aria-label={`${String(hour).padStart(2, '0')}:00 UTC: ${formatNumber(count)} detections`}
            />
            {hour % 4 === 0 && <span aria-hidden="true">{String(hour).padStart(2, '0')}</span>}
          </div>
        ))}
      </div>
      <div className="wildfire-chart-axis">
        <span>00:00 UTC</span>
        <span>24:00 UTC</span>
      </div>
    </section>
  )
}

function TopDetectionCells({ cells }: { cells: DetectionCell[] }) {
  const max = Math.max(1, ...cells.map(({ count }) => count))
  return (
    <section className="wildfire-card wildfire-analysis-card">
      <div className="wildfire-section-heading">
        <div>
          <h2>Highest-detection grid cells</h2>
          <p>
            Approximate 2° cells ranked by observations; not incident clusters or fire perimeters.
          </p>
        </div>
      </div>
      {cells.length ? (
        <ol className="wildfire-breakdown wildfire-cell-list">
          {cells.map((cell) => (
            <li key={cell.label}>
              <div className="wildfire-breakdown-heading">
                <span>{cell.label}</span>
                <strong>{formatNumber(cell.count)} detections</strong>
              </div>
              <div
                className="wildfire-breakdown-track"
                role="img"
                aria-label={`${cell.label}: ${formatNumber(cell.count)} detections`}
              >
                <span
                  className="wildfire-breakdown-fill"
                  style={{ width: `${(cell.count / max) * 100}%` }}
                />
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="wildfire-empty">No detections to group into grid cells.</p>
      )}
    </section>
  )
}

function RecentDetections({
  features,
  totalCount,
}: {
  features: HotspotDetection[]
  totalCount: number
}) {
  const [sort, setSort] = useState<'newest' | 'frp'>('newest')
  const rows = [...features]
    .sort((left, right) =>
      sort === 'frp'
        ? (right.properties.frp_mw ?? -1) - (left.properties.frp_mw ?? -1)
        : right.properties.acquired_at.localeCompare(left.properties.acquired_at),
    )
    .slice(0, 50)
  return (
    <section className="wildfire-card wildfire-table-card">
      <div className="wildfire-section-heading">
        <div>
          <h2>Detection records</h2>
          <p>
            Up to {formatNumber(Math.min(50, features.length))} rows from the latest{' '}
            {formatNumber(features.length)} sampled records; {formatNumber(totalCount)} detections
            in the interval
          </p>
        </div>
        <label className="wildfire-sort">
          Sort
          <select
            value={sort}
            onChange={(event) => setSort(event.currentTarget.value as 'newest' | 'frp')}
          >
            <option value="newest">Newest first</option>
            <option value="frp">Highest FRP</option>
          </select>
        </label>
      </div>
      {rows.length ? (
        <div className="wildfire-table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Acquired (UTC)</th>
                <th scope="col">Sensor / satellite</th>
                <th scope="col">Confidence</th>
                <th scope="col">FRP (MW)</th>
                <th scope="col">Day/night</th>
                <th scope="col">Coordinates</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((feature, index) => {
                const properties = feature.properties
                const [longitude, latitude] = feature.geometry.coordinates
                return (
                  <tr
                    key={`${properties.source}-${properties.acquired_at}-${longitude}-${latitude}-${index}`}
                  >
                    <td>
                      {new Intl.DateTimeFormat('en-GB', {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                        timeZone: 'UTC',
                      }).format(new Date(properties.acquired_at))}
                    </td>
                    <td>
                      {properties.sensor} · {properties.satellite}
                      <small>{properties.source}</small>
                    </td>
                    <td>
                      {properties.confidence_class ?? properties.confidence}{' '}
                      <small>{properties.confidence_scale}</small>
                    </td>
                    <td>{properties.frp_mw === null ? '—' : properties.frp_mw.toFixed(1)}</td>
                    <td>
                      {properties.daynight === 'D'
                        ? 'Day'
                        : properties.daynight === 'N'
                          ? 'Night'
                          : 'Unknown'}
                    </td>
                    <td>
                      {latitude.toFixed(3)}, {longitude.toFixed(3)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="wildfire-empty">No records match the selected filters.</p>
      )}
    </section>
  )
}

export function WildfireDashboard({
  analysisArea,
  onClose,
}: {
  analysisArea: AnalysisArea | null
  onClose: () => void
}) {
  const [days, setDays] = useState(1)
  const [sensor, setSensor] = useState<'all' | 'MODIS' | 'VIIRS'>('all')
  const [daynight, setDaynight] = useState<'all' | 'day' | 'night'>('all')
  const [data, setData] = useState<HotspotResponse | null>(null)
  const [previousData, setPreviousData] = useState<HotspotResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [comparisonLoading, setComparisonLoading] = useState(true)
  const [error, setError] = useState('')
  const [previousError, setPreviousError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const areaLabel = analysisArea?.name ?? DASHBOARD_AREA_LABEL
  const today = new Date().toISOString().slice(0, 10)
  const windows = getDashboardWindows(days, today)
  const filtered = useMemo(
    () => filterDetections(data?.features ?? [], sensor, daynight),
    [data, daynight, sensor],
  )
  const daily = useMemo(
    () => data?.summary.daily ?? aggregateDailyActivity([], windows.currentStart, days),
    [data, days, windows.currentStart],
  )
  const previousDaily = useMemo(
    () => previousData?.summary.daily ?? aggregateDailyActivity([], windows.previousStart, days),
    [days, previousData, windows.previousStart],
  )
  const peak = useMemo(() => peakActivity(daily), [daily])
  const sensorBuckets = data?.summary.products ?? []
  const confidenceDistribution = data?.summary.confidence ?? []
  const frpDistribution = data?.summary.frp ?? []
  const medianFrpValue = data?.summary.medianFrp ?? null
  const highestFrpDetection = data?.summary.highestFrp ?? null
  const latest = data?.summary.latest ?? null
  const topCells = data?.summary.topCells ?? []

  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setLoading(true)
      setComparisonLoading(true)
      setError('')
      setPreviousError('')
      setData(null)
      setPreviousData(null)
      const comparison = getDashboardWindows(days, today)
      void fetchWindow(
        comparison.currentStart,
        days,
        sensor,
        daynight,
        analysisArea,
        controller.signal,
      ).then(
        (current) => {
          if (controller.signal.aborted) return
          setLoading(false)
          setData(current)
        },
        (reason: unknown) => {
          if (controller.signal.aborted) return
          setLoading(false)
          setError(errorMessage(reason))
        },
      )
      void fetchWindow(
        comparison.previousStart,
        days,
        sensor,
        daynight,
        analysisArea,
        controller.signal,
      ).then(
        (previous) => {
          if (controller.signal.aborted) return
          setPreviousData(previous)
          setComparisonLoading(false)
        },
        (reason: unknown) => {
          if (controller.signal.aborted) return
          setPreviousError(errorMessage(reason))
          setComparisonLoading(false)
        },
      )
    }, 500)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [analysisArea, attempt, daynight, days, sensor, today])

  const comparison =
    data &&
    !data.partial &&
    data.sources.every((source) => source.status === 'ok') &&
    previousData &&
    !previousData.partial &&
    previousData.sources.every((source) => source.status === 'ok')
      ? compareActivity(data.count, previousData.count)
      : null
  const partial = Boolean(data?.partial || data?.sources.some((source) => source.status !== 'ok'))

  function downloadCsv() {
    if (!data) return
    const blob = new Blob([detectionsToCsv(filtered)], {
      type: 'text/csv;charset=utf-8',
    })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    const areaFilename =
      areaLabel
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'area'
    anchor.download = `wildfire-hotspots-${areaFilename}-${windows.currentStart}-to-${windows.endDate}-recent-sample.csv`
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  return (
    <section className="wildfire-dashboard" aria-labelledby="wildfire-dashboard-title">
      <header className="wildfire-dashboard-header">
        <div>
          <p className="wildfire-eyebrow">ETHEREAL SHARP · BURNING ACTIVITY</p>
          <h1 id="wildfire-dashboard-title">Area Analytics</h1>
          <p className="wildfire-description">
            Satellite hotspot detections show observed thermal activity, not confirmed fire
            incidents.
          </p>
        </div>
        <Button type="button" variant="outline" onClick={onClose}>
          Return to map
        </Button>
      </header>

      <div className="wildfire-dashboard-content">
        <section className="wildfire-controls" aria-label="Area Analytics query">
          <div className="wildfire-scope">
            <span className="wildfire-control-label">Area</span>
            <strong>{areaLabel}</strong>
            <span className="wildfire-control-note">
              {analysisArea
                ? 'Confirmed area from Analysis · detections are clipped to its boundary'
                : 'Generalized boundary · Caribbean Netherlands not included'}
            </span>
          </div>
          <div className="wildfire-range">
            <div className="wildfire-range-heading">
              <label htmlFor="wildfire-days">Recent interval</label>
              <strong>{days} days</strong>
            </div>
            <input
              id="wildfire-days"
              type="range"
              min="1"
              max="30"
              step="1"
              value={days}
              onChange={(event) => setDays(Number(event.currentTarget.value))}
              aria-describedby="wildfire-range-dates"
            />
            <div className="wildfire-range-foot">
              <span>1 day</span>
              <span id="wildfire-range-dates">
                {formatDay(windows.currentStart, { year: 'numeric' })} –{' '}
                {formatDay(windows.endDate, { year: 'numeric' })} UTC
              </span>
              <span>30 days</span>
            </div>
            <span className="wildfire-control-note">
              The current UTC day is still in progress; satellite overpass and processing delays
              mean recent observations may be incomplete.
            </span>
          </div>
          <div className="wildfire-filters" aria-label="Detection filters">
            <label>
              Sensor
              <select
                value={sensor}
                onChange={(event) =>
                  setSensor(event.currentTarget.value as 'all' | 'MODIS' | 'VIIRS')
                }
              >
                <option value="all">All sensors</option>
                <option value="MODIS">MODIS</option>
                <option value="VIIRS">VIIRS</option>
              </select>
            </label>
            <label>
              Day/night
              <select
                value={daynight}
                onChange={(event) =>
                  setDaynight(event.currentTarget.value as 'all' | 'day' | 'night')
                }
              >
                <option value="all">All observations</option>
                <option value="day">Day</option>
                <option value="night">Night</option>
              </select>
            </label>
            <span className="wildfire-filter-count">
              Showing {formatNumber(filtered.length)} recent records from{' '}
              {formatNumber(data?.count ?? 0)} total detections
            </span>
          </div>
        </section>

        {error ? (
          <div className="wildfire-alert" role="alert">
            <div>
              <strong>Could not load hotspot detections</strong>
              <p>{error}</p>
              <p>Check that the FIRMS backend is running and retry.</p>
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Retry
            </Button>
          </div>
        ) : null}

        {partial && data && (
          <div className="wildfire-warning" role="status">
            Partial results: some FIRMS products or dates could not be loaded. Counts may be
            incomplete.
          </div>
        )}

        {(previousError ||
          (previousData &&
            (previousData.partial ||
              previousData.sources.some((source) => source.status !== 'ok')))) &&
          data && (
            <div className="wildfire-warning" role="status">
              The comparison period is incomplete or unavailable. Current-period detections remain
              available.
            </div>
          )}

        <section
          className={`wildfire-glance ${partial ? 'is-incomplete' : ''}`}
          aria-labelledby="wildfire-glance-title"
          aria-busy={loading}
        >
          <div className="wildfire-glance-main">
            <p className="wildfire-eyebrow">
              {areaLabel.toUpperCase()} · {days} DAYS ·{' '}
              {formatDay(windows.currentStart, { year: 'numeric' })} –{' '}
              {formatDay(windows.endDate, { year: 'numeric' })} UTC
            </p>
            <h2 id="wildfire-glance-title">Fire Activity at a Glance</h2>
            {loading && !data ? (
              <p className="wildfire-glance-status" role="status">
                Loading satellite activity for the selected interval…
              </p>
            ) : error ? (
              <div>
                <p className="wildfire-glance-status">Activity status unavailable</p>
                <p className="wildfire-glance-copy">{error}</p>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setAttempt((value) => value + 1)}
                >
                  Retry selected interval
                </Button>
              </div>
            ) : partial && data ? (
              <div>
                <p className="wildfire-glance-status">Incomplete satellite data</p>
                <p className="wildfire-glance-copy">
                  {formatNumber(data.count)} detections returned for {days} days; one or more
                  products or dates could not be loaded.
                </p>
              </div>
            ) : data && data.count === 0 ? (
              <div>
                <p className="wildfire-glance-status">No detections reported</p>
                <p className="wildfire-glance-copy">
                  FIRMS returned no hotspot observations in the selected {days}-day interval. This
                  does not confirm there is no active fire or threat.
                </p>
              </div>
            ) : data ? (
              <div>
                <p className="wildfire-glance-status">
                  {comparison === null
                    ? 'Satellite activity observed'
                    : comparison.difference > 0
                      ? 'More detections than the previous interval'
                      : comparison.difference < 0
                        ? 'Fewer detections than the previous interval'
                        : 'Same detection count as the previous interval'}
                </p>
                <p className="wildfire-glance-copy">
                  {formatNumber(data.count)} hotspot detections in the selected {days}-day interval
                  {comparison &&
                    ` · ${comparison.difference > 0 ? '+' : ''}${formatNumber(comparison.difference)} (${comparison.percentage === null ? 'percentage unavailable: previous count was zero' : `${comparison.percentage > 0 ? '+' : ''}${comparison.percentage.toFixed(1)}%`}) versus the preceding ${days} days`}
                </p>
              </div>
            ) : (
              <p className="wildfire-glance-status">Activity status unavailable</p>
            )}
          </div>
          <div className="wildfire-glance-details">
            <div>
              <span>Last observation in this window</span>
              <strong>
                {latest
                  ? `${formatObservationAge(latest.properties.acquired_at)} · ${new Intl.DateTimeFormat(
                      'en-GB',
                      {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                        timeZone: 'UTC',
                      },
                    ).format(new Date(latest.properties.acquired_at))} UTC`
                  : data
                    ? 'No observation reported'
                    : 'Unavailable'}
              </strong>
            </div>
            <div>
              <span>Data status</span>
              <strong>
                {error
                  ? 'Unavailable'
                  : loading && !data
                    ? 'Loading'
                    : partial
                      ? 'Partial results'
                      : data && data.sources.every((source) => source.status === 'ok')
                        ? 'All queried products returned'
                        : 'Not confirmed'}
              </strong>
            </div>
            <div>
              <span>Filters applied</span>
              <strong>
                {sensor === 'all' ? 'All sensors' : sensor} ·{' '}
                {daynight === 'all' ? 'Day and night' : daynight}
              </strong>
            </div>
            <div>
              <span>Compared with</span>
              <strong>
                {comparison
                  ? `${formatNumber(previousData?.count ?? 0)} detections · ${formatDay(windows.previousStart, { year: 'numeric' })}–${formatDay(shiftUtcDate(windows.currentStart, -1), { year: 'numeric' })} UTC`
                  : comparisonLoading
                    ? 'Loading equal-length comparison…'
                    : 'Previous interval unavailable'}
              </strong>
            </div>
            <p className="wildfire-glance-caveat">
              FIRMS near-real-time satellite observations for the selected interval are not a
              fire-threat rating. Overpass, cloud, and processing gaps apply; a lack of detections
              is not an all-clear. The current UTC day may be incomplete.
            </p>
          </div>
        </section>

        <section className="wildfire-summary-grid" aria-label="Recent activity summary">
          <article className="wildfire-card">
            <span className="wildfire-card-label">Hotspot detections</span>
            <strong className="wildfire-card-value">
              {data ? formatNumber(data.count) : loading ? '…' : '—'}
            </strong>
            <span className="wildfire-card-note">Satellite observations · {days} days</span>
          </article>
          <article className="wildfire-card">
            <span className="wildfire-card-label">Change vs prior period</span>
            <strong className="wildfire-card-value">
              {comparison
                ? comparison.percentage === null
                  ? `${comparison.difference > 0 ? '+' : ''}${formatNumber(comparison.difference)}`
                  : `${comparison.percentage > 0 ? '+' : ''}${comparison.percentage.toFixed(1)}%`
                : loading
                  ? '…'
                  : '—'}
            </strong>
            <span className="wildfire-card-note">
              {comparison
                ? `${formatNumber(Math.abs(comparison.difference))} detections ${comparison.difference >= 0 ? 'more' : 'fewer'} · previous ${days} days`
                : 'Equal-length period immediately before the selected interval'}
            </span>
            {comparison?.percentage === null && (
              <span className="wildfire-card-note">
                Percentage unavailable: prior count was zero.
              </span>
            )}
          </article>
          <article className="wildfire-card">
            <span className="wildfire-card-label">Peak activity day</span>
            <strong className="wildfire-card-value">
              {peak ? formatDay(peak.date) : data ? 'No detections' : loading ? '…' : '—'}
            </strong>
            <span className="wildfire-card-note">
              {peak
                ? `${formatNumber(peak.count)} detections · UTC`
                : 'Highest daily total in this interval'}
            </span>
          </article>
          <article className="wildfire-card">
            <span className="wildfire-card-label">Historical anomaly</span>
            <strong className="wildfire-card-value wildfire-card-value-small">
              Baseline unavailable
            </strong>
            <span className="wildfire-card-note">
              Waiting for the harmonized historical dataset
            </span>
          </article>
          <article className="wildfire-card">
            <span className="wildfire-card-label">Latest observation</span>
            <strong className="wildfire-card-value wildfire-card-value-small">
              {latest
                ? new Intl.DateTimeFormat('en-GB', {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                    timeZone: 'UTC',
                  }).format(new Date(latest.properties.acquired_at))
                : data
                  ? 'None in interval'
                  : loading
                    ? '…'
                    : '—'}
            </strong>
            <span className="wildfire-card-note">
              {latest
                ? `${formatObservationAge(latest.properties.acquired_at)} · ${latest.properties.sensor} · ${latest.properties.satellite} · UTC`
                : 'Latest observation time in the selected interval'}
            </span>
          </article>
          <article className="wildfire-card">
            <span className="wildfire-card-label">Highest reported FRP</span>
            <strong className="wildfire-card-value">
              {highestFrpDetection
                ? `${highestFrpDetection.properties.frp_mw?.toFixed(1)} MW`
                : data
                  ? 'Not reported'
                  : loading
                    ? '…'
                    : '—'}
            </strong>
            <span className="wildfire-card-note">
              {highestFrpDetection
                ? `${highestFrpDetection.properties.sensor} · ${new Intl.DateTimeFormat('en-GB', {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                    timeZone: 'UTC',
                  }).format(new Date(highestFrpDetection.properties.acquired_at))} UTC`
                : 'Per-observation value; not a measure of fire size'}
            </span>
          </article>
        </section>

        <section
          className="wildfire-card wildfire-chart-card"
          aria-labelledby="wildfire-activity-title"
        >
          <div className="wildfire-section-heading">
            <div>
              <h2 id="wildfire-activity-title">Recent activity</h2>
              <p>
                {data
                  ? `${formatNumber(data.count)} filtered detections from ${formatDay(windows.currentStart, { year: 'numeric' })} to ${formatDay(windows.endDate, { year: 'numeric' })}`
                  : 'Daily hotspot detections in the selected interval'}
              </p>
            </div>
            <Button type="button" variant="outline" onClick={downloadCsv} disabled={!data}>
              Download recent sample CSV
            </Button>
          </div>
          {loading && !data ? (
            <p className="wildfire-loading" role="status">
              Loading recent FIRMS detections…
            </p>
          ) : error && !data ? (
            <p className="wildfire-empty">Chart unavailable until hotspot data can be loaded.</p>
          ) : data ? (
            <ActivityChart
              days={daily}
              previousDays={comparison ? previousDaily : []}
              busy={loading}
            />
          ) : (
            <p className="wildfire-empty">No data is available for this interval.</p>
          )}
        </section>

        <section className="wildfire-analysis-grid" aria-label="Detection analytics">
          <BreakdownChart
            title="Detections by product"
            description="Sensor/product provenance in the selected interval."
            buckets={sensorBuckets}
          />
          <BreakdownChart
            title="Confidence distribution"
            description="MODIS numeric ranges and VIIRS classes are shown separately; they are not equivalent scales."
            buckets={confidenceDistribution}
          />
          <BreakdownChart
            title="Fire radiative power"
            description="Observation counts by reported FRP range, in megawatts."
            buckets={frpDistribution}
          />
          <TopDetectionCells cells={topCells} />
          <HourlyChart hours={data?.summary.hourly ?? []} />
          <section className="wildfire-card wildfire-analysis-card">
            <div className="wildfire-section-heading">
              <div>
                <h2>FRP summary</h2>
                <p>Fire radiative power per hotspot observation, where reported.</p>
              </div>
            </div>
            <strong className="wildfire-card-value">
              {medianFrpValue === null ? '—' : `${medianFrpValue.toFixed(1)} MW`}
            </strong>
            <span className="wildfire-card-note">
              Median FRP · {formatNumber(data?.summary.frpReported ?? 0)} of{' '}
              {formatNumber(data?.count ?? 0)} observations reported FRP
            </span>
            <p className="wildfire-footnote">
              FRP is a satellite-derived observation of radiative power, not a direct measure of
              burned area, fire size, or impact.
            </p>
          </section>
        </section>

        <RecentDetections features={filtered} totalCount={data?.count ?? 0} />

        <section
          className="wildfire-card wildfire-coverage"
          aria-labelledby="wildfire-coverage-title"
        >
          <div className="wildfire-section-heading">
            <div>
              <h2 id="wildfire-coverage-title">Data coverage</h2>
              <p>NASA FIRMS near-real-time products · query dates use UTC calendar days</p>
            </div>
            <span className={`wildfire-status ${partial ? 'is-partial' : ''}`}>
              {data ? (partial ? 'Partial' : 'Complete') : loading ? 'Loading' : 'Unavailable'}
            </span>
          </div>
          {data ? (
            <ul className="wildfire-source-list">
              {data.sources.map((source) => (
                <li key={source.source}>
                  <span>{source.source}</span>
                  <span>
                    {source.status === 'ok'
                      ? `${source.successful_days}/${days} days`
                      : `${source.status} · ${source.successful_days}/${days} days`}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="wildfire-empty">
              {error
                ? 'Coverage details unavailable because the request failed.'
                : 'Coverage details will appear with the results.'}
            </p>
          )}
          {data && (
            <p className="wildfire-footnote">
              Oldest contributing data fetch:{' '}
              {data.sources
                .map((source) => source.oldest_fetched_at)
                .filter((value): value is string => Boolean(value))
                .sort()[0]
                ? new Intl.DateTimeFormat('en-GB', {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                    timeZone: 'UTC',
                  }).format(
                    new Date(
                      data.sources
                        .map((source) => source.oldest_fetched_at)
                        .filter((value): value is string => Boolean(value))
                        .sort()[0]!,
                    ),
                  ) + ' UTC'
                : 'not reported'}
            </p>
          )}
          <p className="wildfire-footnote">
            A hotspot is a satellite observation and may represent wildfire, agricultural burning,
            industrial heat, or another thermal anomaly. Observation counts are not unique fire
            counts.
          </p>
        </section>

        <section
          className="wildfire-card wildfire-roadmap"
          aria-labelledby="wildfire-history-title"
        >
          <div>
            <p className="wildfire-eyebrow">HISTORICAL ANALYTICS</p>
            <h2 id="wildfire-history-title">Burning-activity calendar</h2>
            <p>
              Month-by-year heatmaps, monthly and annual summaries, seasonal patterns, and
              historical anomaly comparisons will be enabled after MODIS and VIIRS harmonization is
              implemented and validated.
            </p>
          </div>
          <span className="wildfire-status">Not available yet</span>
        </section>
      </div>
    </section>
  )
}
