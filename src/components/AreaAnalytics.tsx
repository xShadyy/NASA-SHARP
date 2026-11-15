import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CheckCircleIcon, CircleNotchIcon } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import type { AnalysisArea } from '@/lib/analysis-area'
import { apiUrl } from '@/lib/api-config'
import {
  createInvestigation,
  createGlobalInvestigation,
  investigationKey,
  investigationRequest,
  type InvestigationScope,
  type ObservationFilters,
} from '@/lib/investigation'
import {
  canonicalDashboard,
  fullIntervalObservationScope,
  chartFilter,
  observationDays,
  scopeObservationOptions,
  scopeExportIdentity,
  type ObservationPage,
} from '@/lib/analytics-investigation'
import { RecordsExplorer } from './RecordsExplorer'
import type { AnalysisRange } from '@/lib/analysis-activity'
import { exportInvestigation, fetchObservationPage } from '@/lib/observation-client'
const InvestigationScience = lazy(() =>
  import('./InvestigationScience').then((module) => ({ default: module.InvestigationScience })),
)
import {
  aggregateDailyActivity,
  compareActivity,
  getAreaAnalyticsWindows,
  isHotspotResponse,
  peakActivity,
  shiftUtcDate,
  type DetectionCell,
  type CountBucket,
  type HotspotResponse,
} from '@/lib/area-analytics'
import './AreaAnalytics.css'

const AREA_ANALYTICS_DEFAULT_AREA = 'netherlands'
const AREA_ANALYTICS_DEFAULT_AREA_LABEL = 'Netherlands (European part)'

type ActivityProgress = { processedDays: number; totalDays: number }
type ActivityProgressHandler = (progress: ActivityProgress) => void
type ActivityQuery = {
  analysisArea: AnalysisArea | null
  days: number
  sensor: 'all' | 'MODIS' | 'VIIRS'
  daynight: 'all' | 'day' | 'night'
  today: string
}
type ActivityProgressState = {
  query: ActivityQuery
  progress: ActivityProgress
  complete: boolean
}

function sameActivityQuery(left: ActivityQuery, right: ActivityQuery) {
  return (
    left.analysisArea === right.analysisArea &&
    left.days === right.days &&
    left.sensor === right.sensor &&
    left.daynight === right.daynight &&
    left.today === right.today
  )
}

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
  onProgress: ActivityProgressHandler,
) {
  const query = {
    area: AREA_ANALYTICS_DEFAULT_AREA,
    geometry: analysisArea?.geometry ?? null,
    start_date: startDate,
    days,
    daynight,
    summary: true,
  }
  const sources =
    sensor === 'MODIS'
      ? ['MODIS_NRT']
      : sensor === 'VIIRS'
        ? ['VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT']
        : []
  return fetchHotspots({ ...query, source: sources }, signal, onProgress)
}

async function fetchHotspots(
  query: {
    area: string
    geometry: AnalysisArea['geometry'] | null
    start_date: string
    days: number
    daynight: 'all' | 'day' | 'night'
    source: string[]
    summary: boolean
  },
  signal: AbortSignal,
  onProgress: ActivityProgressHandler,
) {
  let response: Response
  try {
    response = await fetch(apiUrl('/hotspots/stream'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(query),
      signal,
    })
  } catch (error) {
    if (signal.aborted) throw error
    throw new Error(
      'Cannot reach the hotspot API. Check that the Vite server and FIRMS backend are running.',
      { cause: error },
    )
  }
  const contentType = response.headers.get('content-type') ?? ''
  if (!response.ok) {
    let detail: unknown = null
    if (contentType.includes('application/json')) {
      try {
        const payload: unknown = await response.json()
        detail =
          payload && typeof payload === 'object' && 'detail' in payload ? payload.detail : null
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
    }
    throw new Error(
      hotspotErrorDetail(detail) ??
        (typeof detail === 'string'
          ? detail
          : `Hotspot service request failed (HTTP ${response.status}).`),
    )
  }
  if (!contentType.includes('application/x-ndjson'))
    throw new Error(`Hotspot API returned an unexpected response type (HTTP ${response.status}).`)

  const reader = response.body?.getReader()
  if (!reader) throw new Error('Hotspot API did not provide a progress stream.')
  const decoder = new TextDecoder()
  let buffer = ''
  let result: HotspotResponse | null = null
  const consumeLine = (line: string) => {
    if (!line.trim()) return
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      throw new Error('Hotspot progress stream returned malformed JSON.')
    }
    if (!parsed || typeof parsed !== 'object' || !('type' in parsed))
      throw new Error('Hotspot progress stream returned an unexpected event.')
    const event = parsed as Record<string, unknown>
    if (
      event.type === 'progress' &&
      typeof event.processed_days === 'number' &&
      typeof event.total_days === 'number'
    ) {
      onProgress({
        processedDays: event.processed_days,
        totalDays: event.total_days,
      })
    } else if (event.type === 'result' && isHotspotResponse(event.data)) {
      result = event.data
    } else if (event.type === 'error') {
      const message =
        hotspotErrorDetail(event.detail) ??
        (typeof event.detail === 'string' ? event.detail : 'Hotspot processing failed.')
      throw new Error(message)
    } else {
      throw new Error('Hotspot progress stream returned an unexpected event.')
    }
  }
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (value) buffer += decoder.decode(value, { stream: !done })
      if (done) {
        if (!value) buffer += decoder.decode()
        consumeLine(buffer)
        break
      }
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) consumeLine(line)
    }
  } finally {
    reader.releaseLock()
  }
  if (!result) throw new Error('Hotspot progress stream ended before returning data.')
  return result
}

function ActivityProgressBar({
  progress,
  complete,
}: {
  progress: ActivityProgress
  complete: boolean
}) {
  const totalDays = Math.max(1, progress.totalDays)
  const processedDays = Math.max(0, Math.min(totalDays, progress.processedDays))
  const percentage = complete ? 100 : (processedDays / totalDays) * 100
  const description = `${formatNumber(processedDays)} of ${formatNumber(totalDays)} days processed`
  return (
    <div className={`area-analytics-progress ${complete ? 'is-complete' : ''}`}>
      <div
        className="area-analytics-progress-track"
        role="progressbar"
        aria-label="Days processed in the selected interval"
        aria-valuemin={0}
        aria-valuemax={totalDays}
        aria-valuenow={complete ? totalDays : processedDays}
        aria-valuetext={description}
      >
        <div className="area-analytics-progress-fill" style={{ width: `${percentage}%` }} />
        <span className="area-analytics-progress-marker" style={{ left: `${percentage}%` }}>
          {complete ? (
            <CheckCircleIcon size={20} weight="fill" aria-hidden="true" />
          ) : (
            <CircleNotchIcon
              className="area-analytics-progress-spinner"
              size={18}
              aria-hidden="true"
            />
          )}
        </span>
      </div>
      <span className="area-analytics-progress-label" aria-live="polite">
        {complete ? `${description} · complete` : description}
      </span>
    </div>
  )
}

function ActivityChart({
  days,
  previousDays,
  busy,
  onSelect,
  focusedDay,
}: {
  days: Array<{ date: string; count: number | null; coverage?: string }>
  previousDays: Array<{ date: string; count: number | null; coverage?: string }>
  busy: boolean
  onSelect?: (date: string) => void
  focusedDay?: string | null
}) {
  const max = Math.max(
    1,
    ...days.map(({ count }) => count ?? 0),
    ...previousDays.map(({ count }) => count ?? 0),
  )
  const labelStep = Math.max(1, Math.ceil(days.length / 7))
  return (
    <figure className="area-analytics-chart" aria-busy={busy}>
      <figcaption className="area-analytics-chart-caption">
        <span>Detections per day</span>
        <span>UTC · {formatNumber(max)} max</span>
      </figcaption>
      <div className="area-analytics-chart-scroll">
        <div
          className="area-analytics-bars"
          role="group"
          aria-label="Daily hotspot detections; current interval compared with the previous interval"
        >
          {days.map(({ date, count, coverage }, index) => (
            <div className="area-analytics-bar-column" key={date}>
              <div className="area-analytics-bar-pair">
                {previousDays[index] && previousDays[index].count !== null && (
                  <button
                    type="button"
                    className="area-analytics-bar is-previous"
                    onClick={() => onSelect?.(previousDays[index].date)}
                    style={{
                      height: `${Math.max(2, ((previousDays[index].count ?? 0) / max) * 100)}%`,
                    }}
                    aria-label={`Previous interval, day ${index + 1}: ${formatNumber(previousDays[index].count ?? 0)} detections`}
                    title={`Previous interval, day ${index + 1}: ${formatNumber(previousDays[index].count ?? 0)} detections`}
                  />
                )}
                <button
                  type="button"
                  className={`area-analytics-bar ${count === null ? 'is-unavailable' : ''} ${date === focusedDay ? 'is-focused' : ''}`}
                  aria-pressed={date === focusedDay}
                  onClick={() => onSelect?.(date)}
                  style={{ height: `${count === null ? 100 : Math.max(2, (count / max) * 100)}%` }}
                  aria-label={`${formatDay(date, { year: 'numeric' })}: ${count === null ? 'Reporting coverage unavailable' : `${formatNumber(count)} detections`}, ${coverage ?? 'reported'} coverage`}
                  title={`${formatDay(date, { year: 'numeric' })}: ${count === null ? 'Reporting coverage unavailable' : `${formatNumber(count)} detections`}, ${coverage ?? 'reported'} coverage`}
                />
              </div>
              {index % labelStep === 0 || index === days.length - 1 ? (
                <span className="area-analytics-bar-label" aria-hidden="true">
                  {formatDay(date)}
                </span>
              ) : (
                <span className="area-analytics-bar-label" aria-hidden="true">
                  &nbsp;
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="area-analytics-chart-axis" aria-hidden="true">
        <span>0</span>
        <span>{formatNumber(max)} detections</span>
      </div>
      <div className="area-analytics-legend">
        <span>
          <i className="area-analytics-legend-current" /> Selected interval
        </span>
        <span>
          <i className="area-analytics-legend-previous" /> Previous interval
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
  onSelect,
}: {
  title: string
  description: string
  buckets: CountBucket[]
  emptyLabel?: string
  onSelect?: (label: string) => void
}) {
  const max = Math.max(1, ...buckets.map(({ count }) => count))
  const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0)
  return (
    <section className="area-analytics-card area-analytics-analysis-card">
      <div className="area-analytics-section-heading">
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
      </div>
      {total ? (
        <ul className="area-analytics-breakdown">
          {buckets.map(({ label, count }, index) => (
            <li key={label}>
              <button
                type="button"
                className="analytics-breakdown-button"
                onClick={() => onSelect?.(label)}
              >
                <div className="area-analytics-breakdown-heading">
                  <span>{label}</span>
                  <strong>
                    {formatNumber(count)} <small>({((count / total) * 100).toFixed(1)}%)</small>
                  </strong>
                </div>
                <div
                  className="area-analytics-breakdown-track"
                  role="img"
                  aria-label={`${label}: ${formatNumber(count)} detections, ${((count / total) * 100).toFixed(1)} percent`}
                >
                  <span
                    className={`area-analytics-breakdown-fill area-analytics-fill-${index % 5}`}
                    style={{ width: `${(count / max) * 100}%` }}
                  />
                </div>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="area-analytics-empty">{emptyLabel}</p>
      )}
    </section>
  )
}

function HourlyChart({
  hours,
  onSelect,
}: {
  hours: Array<{ hour: number; count: number }>
  onSelect?: (hour: number) => void
}) {
  const max = Math.max(1, ...hours.map(({ count }) => count))
  return (
    <section className="area-analytics-card area-analytics-analysis-card">
      <div className="area-analytics-section-heading">
        <div>
          <h2>Observation time of day</h2>
          <p>Detections grouped by acquisition hour in UTC; not local fire-start time.</p>
        </div>
      </div>
      <div className="area-analytics-hourly" role="group" aria-label="Detections by UTC hour">
        {hours.map(({ hour, count }) => (
          <div className="area-analytics-hour" key={hour}>
            <button
              type="button"
              className="area-analytics-hour-bar"
              onClick={() => onSelect?.(hour)}
              style={{ height: `${Math.max(2, (count / max) * 100)}%` }}
              title={`${String(hour).padStart(2, '0')}:00 UTC · ${formatNumber(count)} detections`}
              aria-label={`${String(hour).padStart(2, '0')}:00 UTC: ${formatNumber(count)} detections`}
            />
            {hour % 4 === 0 && <span aria-hidden="true">{String(hour).padStart(2, '0')}</span>}
          </div>
        ))}
      </div>
      <div className="area-analytics-chart-axis">
        <span>00:00 UTC</span>
        <span>24:00 UTC</span>
      </div>
    </section>
  )
}

function TopDetectionCells({ cells }: { cells: DetectionCell[] }) {
  const max = Math.max(1, ...cells.map(({ count }) => count))
  return (
    <section className="area-analytics-card area-analytics-analysis-card">
      <div className="area-analytics-section-heading">
        <div>
          <h2>Highest-detection grid cells</h2>
          <p>
            Approximate 2° cells ranked by observations; not incident clusters or fire perimeters.
          </p>
        </div>
      </div>
      {cells.length ? (
        <ol className="area-analytics-breakdown area-analytics-cell-list">
          {cells.map((cell) => (
            <li key={cell.label}>
              <div className="area-analytics-breakdown-heading">
                <span>{cell.label}</span>
                <strong>{formatNumber(cell.count)} detections</strong>
              </div>
              <div
                className="area-analytics-breakdown-track"
                role="img"
                aria-label={`${cell.label}: ${formatNumber(cell.count)} detections`}
              >
                <span
                  className="area-analytics-breakdown-fill"
                  style={{ width: `${(cell.count / max) * 100}%` }}
                />
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="area-analytics-empty">No detections to group into grid cells.</p>
      )}
    </section>
  )
}

type AnalyticsTab = 'overview' | 'records' | 'history' | 'method'
export type AreaAnalyticsProps = {
  analysisArea: AnalysisArea | null
  scope?: InvestigationScope | null
  onScopeChange?: (scope: InvestigationScope) => void
  onApply?: (scope: InvestigationScope) => void
  onHighlight?: (scope: InvestigationScope) => void
  onClose: () => void
  snapshot?: { url: string; scopeKey: string } | null
  onCapture?: (scope: InvestigationScope) => Promise<void>
}
export function AreaAnalytics({
  analysisArea: initialArea,
  scope: transferredScope,
  onScopeChange,
  onApply,
  onHighlight,
  onClose,
  snapshot,
  onCapture,
}: AreaAnalyticsProps) {
  const [capturing, setCapturing] = useState(false)
  const [captureError, setCaptureError] = useState('')
  const [investigation, setInvestigation] = useState<InvestigationScope | null>(() =>
    transferredScope ? structuredClone(transferredScope) : null,
  )
  const [lastTransfer, setLastTransfer] = useState(transferredScope)
  const [tab, setTab] = useState<AnalyticsTab>(transferredScope?.selection ? 'records' : 'overview')
  const [canonicalPage, setCanonicalPage] = useState<ObservationPage | null>(null)
  const [canonicalIdentity, setCanonicalIdentity] = useState('')
  if (transferredScope !== lastTransfer) {
    setLastTransfer(transferredScope)
    if (
      transferredScope &&
      investigation !== transferredScope &&
      (!investigation || investigationKey(transferredScope) !== investigationKey(investigation))
    ) {
      setInvestigation(structuredClone(transferredScope))
      setCanonicalPage(null)
      setTab(transferredScope.selection ? 'records' : 'overview')
    }
  }
  const analysisArea = investigation?.area ?? initialArea
  const [legacyDays, setLegacyDays] = useState(1)
  const [legacySensor, setLegacySensor] = useState<'all' | 'MODIS' | 'VIIRS'>('all')
  const [legacyDaynight, setLegacyDaynight] = useState<'all' | 'day' | 'night'>('all')
  const days = investigation
    ? Math.floor(
        (Date.parse(investigation.range.end) - Date.parse(investigation.range.start)) / 86400000,
      ) + 1
    : legacyDays
  const sensor = investigation
    ? investigation.filters.sensor === 'MODIS' || investigation.filters.sensor === 'VIIRS'
      ? investigation.filters.sensor
      : 'all'
    : legacySensor
  const daynight = investigation
    ? investigation.filters.dayNight === 'day' || investigation.filters.dayNight === 'night'
      ? investigation.filters.dayNight
      : 'all'
    : legacyDaynight
  function updateInvestigation(next: InvestigationScope) {
    setInvestigation(next)
    onScopeChange?.(next)
  }
  const historyQuery = useMemo(() => {
    if (investigation?.selection?.global) return null
    if (investigation) return investigation.query
    if (!analysisArea) return null
    const end = new Date().toISOString().slice(0, 10)
    return createInvestigation(analysisArea, { start: shiftUtcDate(end, 1-days), end }).query
  }, [investigation, analysisArea, days])
  useEffect(() => {
    if (!historyQuery) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const prepare = () => {
      void investigationRequest<{ state: string }>(
        'history/prepare',
        historyQuery,
        {},
        controller.signal,
      ).then((progress) => {
        if (!controller.signal.aborted && ['queued', 'loading', 'waiting', 'partial'].includes(progress.state))
          timer = setTimeout(prepare, 5000)
      }, () => undefined)
    }
    prepare()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [historyQuery])
  function setSensor(value: 'all' | 'MODIS' | 'VIIRS') {
    if (investigation)
      updateInvestigation({
        ...investigation,
        filters: { ...investigation.filters, sensor: value === 'all' ? undefined : value },
      })
    else setLegacySensor(value)
  }
  function setDaynight(value: 'all' | 'day' | 'night') {
    if (investigation)
      updateInvestigation({
        ...investigation,
        filters: { ...investigation.filters, dayNight: value === 'all' ? undefined : value },
      })
    else setLegacyDaynight(value)
  }
  function setDays(value: number) {
    if (investigation) {
      changeRange({
        start: shiftUtcDate(investigation.range.end, 1 - value),
        end: investigation.range.end,
      })
    } else setLegacyDays(value)
  }
  function changeRange(range: AnalysisRange) {
    if (!investigation) return
    const filters = {
      ...investigation.filters,
      day: undefined,
      acquiredStart: undefined,
      acquiredEndExclusive: undefined,
      observationId: undefined,
    }
    const next = createInvestigation(investigation.area, range, null, null, filters)
    const global = investigation.selection?.global
    updateInvestigation(
      global
        ? {
            ...createGlobalInvestigation(
              {
                ...global,
                aggregateId: undefined,
                bbox: undefined,
                interval: next.query.interval,
              },
              filters,
              { sourceGeneration: global.snapshotId },
            ),
            range,
          }
        : next,
    )
    setCanonicalPage(null)
    setCanonicalIdentity('')
    setData(null)
    setError('')
  }
  const [storedData, setData] = useState<HotspotResponse | null>(null)
  const data =
    investigation && canonicalIdentity !== investigationKey(investigation) ? null : storedData
  const currentPage =
    investigation && canonicalIdentity === investigationKey(investigation) ? canonicalPage : null
  const [legacyPreviousData, setPreviousData] = useState<HotspotResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [legacyComparisonLoading, setComparisonLoading] = useState(true)
  const [error, setError] = useState('')
  const [activityProgressState, setActivityProgressState] = useState<ActivityProgressState | null>(
    null,
  )
  const areaLabel = analysisArea?.name ?? AREA_ANALYTICS_DEFAULT_AREA_LABEL
  const currentUtcDay = new Date().toISOString().slice(0, 10)
  const today = investigation?.range.end ?? currentUtcDay
  const includesCurrentDay =
    !investigation ||
    (investigation.range.start <= currentUtcDay && investigation.range.end >= currentUtcDay)
  const currentQuery: ActivityQuery = {
    analysisArea,
    days,
    sensor,
    daynight,
    today,
  }
  const currentProgressState =
    activityProgressState && sameActivityQuery(activityProgressState.query, currentQuery)
      ? activityProgressState
      : null
  const activityProgress = currentProgressState?.progress ?? { processedDays: 0, totalDays: days }
  const progressComplete = currentProgressState?.complete ?? false
  const windows = investigation
    ? {
        currentStart: investigation.range.start,
        previousStart: shiftUtcDate(investigation.range.start, -days),
        endDate: investigation.range.end,
      }
    : getAreaAnalyticsWindows(days, today)
  const previousScope = useMemo(() => {
    if (
      !investigation ||
      investigation.selection ||
      investigation.focusedDay ||
      investigation.filters.day
    )
      return null
    const duration =
      Date.parse(investigation.query.interval.endExclusive) -
      Date.parse(investigation.query.interval.start)
    const startAt = new Date(
      Date.parse(investigation.query.interval.start) - duration,
    ).toISOString()
    const endAt = investigation.query.interval.start
    return createInvestigation(
      investigation.area,
      {
        start: startAt.slice(0, 10),
        end: new Date(Date.parse(endAt) - 1).toISOString().slice(0, 10),
        startAt,
        endAt,
      },
      null,
      null,
      investigation.filters,
    )
  }, [investigation])
  const previousRequest = useQuery({
    queryKey: ['analytics-prior-interval', previousScope],
    enabled: !!previousScope,
    queryFn: ({ signal }) =>
      fetchObservationPage(
        previousScope!,
        { ...previousScope!.filters, page: 1, pageSize: 1 },
        signal,
      ),
    retry: false,
    staleTime: 300_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
  // Day focus narrows records and map highlighting while the chart retains the full interval.
  const chartScope = useMemo(
    () =>
      investigation && (investigation.focusedDay || investigation.filters.day)
        ? fullIntervalObservationScope(investigation)
        : null,
    [investigation],
  )
  const chartOptions = chartScope ? scopeObservationOptions(chartScope, 1, 1) : null
  const chartContext = useQuery({
    queryKey: [
      'investigation-records',
      chartScope?.query,
      chartScope?.selection?.global,
      chartOptions,
    ],
    enabled: !!chartScope,
    queryFn: ({ signal }) => fetchObservationPage(chartScope!, chartOptions!, signal),
    retry: false,
    staleTime: 300_000,
    gcTime: 600_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
  const activityPage = chartScope ? chartContext.data : currentPage
  const previousData = investigation
    ? previousRequest.data && previousScope
      ? canonicalDashboard(previousRequest.data, previousScope)
      : null
    : legacyPreviousData
  const comparisonLoading = investigation
    ? !!previousScope && previousRequest.isPending
    : legacyComparisonLoading
  const daily = useMemo(
    () => data?.summary.daily ?? aggregateDailyActivity([], windows.currentStart, days),
    [data, days, windows.currentStart],
  )
  const previousDaily = useMemo(
    () =>
      previousRequest.data && previousScope
        ? observationDays(previousRequest.data, previousScope)
        : (previousData?.summary.daily ?? aggregateDailyActivity([], windows.previousStart, days)),
    [days, previousData, windows.previousStart, previousRequest.data, previousScope],
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
    if (investigation) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setLoading(true)
      setComparisonLoading(true)
      setError('')
      setData(null)
      setPreviousData(null)
      const query: ActivityQuery = {
        analysisArea,
        days,
        sensor,
        daynight,
        today,
      }
      setActivityProgressState({
        query,
        progress: { processedDays: 0, totalDays: days },
        complete: false,
      })
      const comparison = getAreaAnalyticsWindows(days, today)
      const updateCurrentProgress: ActivityProgressHandler = (progress) => {
        if (controller.signal.aborted) return
        setActivityProgressState((current) =>
          current?.query === query
            ? {
                ...current,
                progress: {
                  processedDays: Math.max(0, Math.min(progress.totalDays, progress.processedDays)),
                  totalDays: Math.max(1, progress.totalDays),
                },
              }
            : current,
        )
      }
      void fetchWindow(
        comparison.currentStart,
        days,
        sensor,
        daynight,
        analysisArea,
        controller.signal,
        updateCurrentProgress,
      ).then(
        (current) => {
          if (controller.signal.aborted) return
          setActivityProgressState((progress) =>
            progress?.query === query ? { ...progress, complete: true } : progress,
          )
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
        () => undefined,
      ).then(
        (previous) => {
          if (controller.signal.aborted) return
          setPreviousData(previous)
          setComparisonLoading(false)
        },
        () => {
          if (controller.signal.aborted) return
          setComparisonLoading(false)
        },
      )
    }, 500)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [analysisArea, daynight, days, sensor, today, investigation])

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
    if (!investigation) {
      setTab('records')
      return
    }
    void exportInvestigation(investigation, 'csv', scopeObservationOptions(investigation)).catch(
      (reason) => setError(errorMessage(reason)),
    )
  }
  function receivePage(page: ObservationPage) {
    if (!investigation) return
    const recovery = page.meta.sourceRecovery
    const requestedGeneration =
      investigation.selection?.sourceGeneration ?? investigation.metadata?.sourceGeneration
    const recovered = Boolean(
      recovery?.sourceGeneration &&
        page.meta.sourceGeneration === recovery.sourceGeneration &&
        (recovery.previousGeneration ?? null) === (requestedGeneration ?? null) &&
        !investigation.selection?.global &&
        !investigation.selection?.selectionToken &&
        !investigation.selection?.observationIds?.length &&
        (!investigation.selection?.query ||
          JSON.stringify(investigation.selection.query) === JSON.stringify(investigation.query)),
    )
    let next = investigation
    if (
      recovered ||
      (!recovery && !investigation.metadata?.sourceGeneration && page.meta.sourceGeneration)
    ) {
      next = {
        ...investigation,
        metadata: { ...investigation.metadata, ...page.meta },
        selection:
          recovered && investigation.selection
            ? { ...investigation.selection, sourceGeneration: recovery!.sourceGeneration }
            : investigation.selection,
      }
      updateInvestigation(next)
    }
    setCanonicalPage(page)
    setCanonicalIdentity(investigationKey(next))
    setData(canonicalDashboard(page, next))
    setLoading(false)
    setError('')
  }
  function chooseFilter(patch: ObservationFilters, day?: string | null) {
    if (!investigation) return
    const next = {
      ...investigation,
      filters: { ...investigation.filters, ...patch },
      focusedDay: day === undefined ? investigation.focusedDay : day,
    }
    updateInvestigation(next)
    setTab('records')
    onHighlight?.(next)
  }
  const chips = investigation
    ? Object.entries(investigation.filters).filter(
        ([, value]) => value !== undefined && value !== '' && value !== false,
      )
    : []
  const matchingSnapshot =
    investigation && snapshot?.scopeKey === investigationKey(investigation) ? snapshot.url : null
  const membershipInterval =
    investigation?.selection?.query && investigation.selection.query.id !== investigation.query.id
      ? investigation.selection.query.interval
      : null
  function focusDate(date: string) {
    if (!investigation) return
    if (date >= investigation.range.start && date <= investigation.range.end) chooseFilter({}, date)
    else {
      const next = createInvestigation(
        investigation.area,
        { start: date, end: date },
        null,
        date,
        investigation.filters,
      )
      updateInvestigation(next)
      setTab('records')
      onHighlight?.(next)
    }
  }
  function clearFilters() {
    if (investigation) {
      const next = { ...investigation, filters: {}, focusedDay: null }
      updateInvestigation(next)
      onHighlight?.(next)
    }
  }
  function wholeArea() {
    if (!investigation) return
    const global = investigation.selection?.global
    const next: InvestigationScope = global
      ? createGlobalInvestigation(
          { ...global, aggregateId: undefined, bbox: undefined },
          {},
          investigation.metadata,
        )
      : { ...investigation, selection: undefined, filters: {}, focusedDay: null }
    updateInvestigation(next)
    onHighlight?.(next)
  }

  return (
    <section className="area-analytics" aria-labelledby="area-analytics-title">
      <header className="area-analytics-header">
        <div>
          <h1 id="area-analytics-title">Area Analytics</h1>
        </div>
        <div className="analytics-header-actions">
          {investigation && onApply && (
            <Button type="button" variant="outline" onClick={() => onApply(investigation)}>
              Apply to map
            </Button>
          )}
          <Button type="button" variant="outline" onClick={onClose}>
            Return to map
          </Button>
        </div>
      </header>

      <div className="area-analytics-content">
        <nav className="analytics-tabs" aria-label="Area Analytics sections">
          {(['overview', 'records', 'history', 'method'] as const).map((item) => (
            <button
              type="button"
              key={item}
              aria-pressed={tab === item}
              onClick={() => setTab(item)}
            >
              {item[0].toUpperCase() + item.slice(1)}
            </button>
          ))}
        </nav>
        <section className="area-analytics-controls" aria-label="Area Analytics query">
          <div className="area-analytics-scope">
            <span className="area-analytics-control-label">Area</span>
            <strong>{areaLabel}</strong>
            {(!investigation || investigation.selection?.global) && (
              <span className="area-analytics-control-note">
                {investigation?.selection?.global
                  ? `Immutable global snapshot · ${investigation.selection.global.window}${investigation.selection.global.aggregateId ? ' · selected group' : ''}`
                  : analysisArea
                    ? 'Confirmed area · detections are clipped to its boundary'
                    : 'Generalized boundary · Caribbean Netherlands not included'}
              </span>
            )}
          </div>
          <div className="area-analytics-range">
            <div className="area-analytics-range-heading">
              <label htmlFor="area-analytics-days">Selected interval</label>
              <strong>
                {days} {days === 1 ? 'day' : 'days'}
              </strong>
            </div>
            <input
              id="area-analytics-days"
              type="range"
              min="1"
              max="30"
              step="1"
              value={Math.min(30, days)}
              onChange={(event) => setDays(Number(event.currentTarget.value))}
              aria-describedby="area-analytics-range-dates"
            />
            <div className="area-analytics-range-foot">
              <span>1 day</span>
              <span id="area-analytics-range-dates">
                {formatDay(windows.currentStart, { year: 'numeric' })} -{' '}
                {formatDay(windows.endDate, { year: 'numeric' })} UTC
              </span>
              <span>30 days</span>
            </div>
            {investigation && (
              <p className="area-analytics-control-note">
                {investigation.query.interval.start} → {investigation.query.interval.endExclusive}{' '}
                (exclusive)
              </p>
            )}
          </div>
          <div className="area-analytics-filters" aria-label="Detection filters">
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
            <span className="area-analytics-filter-count">
              {formatNumber(currentPage?.data.total ?? data?.count ?? 0)} matching observations
              {currentPage && (
                <>
                  {' '}
                  · {formatNumber(currentPage.data.summary.selectedCount)} selected ·{' '}
                  {formatNumber(currentPage.data.summary.wholeAreaCount)} whole area
                </>
              )}
            </span>
          </div>
        </section>

        {investigation && (
          <div className="analytics-filter-chips" aria-label="Investigation filters">
            {investigation.focusedDay && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => chooseFilter({ day: undefined }, null)}
              >
                UTC {investigation.focusedDay} ×
              </Button>
            )}
            {chips.map(([name, value]) => (
              <Button
                key={name}
                size="sm"
                variant="outline"
                onClick={() => chooseFilter({ [name]: undefined })}
              >
                {name}: {Array.isArray(value) ? value.join(', ') : String(value)} ×
              </Button>
            ))}
            {(chips.length > 0 || investigation.focusedDay) && (
              <Button size="sm" variant="outline" onClick={clearFilters}>
                Clear filters and focus
              </Button>
            )}
            {investigation.selection && (
              <>
                <span>Frozen observation membership</span>
                <Button size="sm" variant="outline" onClick={wholeArea}>
                  Whole area
                </Button>
              </>
            )}
          </div>
        )}
        {membershipInterval && (
          <p className="area-analytics-control-note">
            Frozen membership interval: {membershipInterval.start} →{' '}
            {membershipInterval.endExclusive} (exclusive), UTC. Whole-area counts refer to this
            interval. Whole area restores the full investigation period.
          </p>
        )}

        <div hidden={tab !== 'overview'} className="analytics-overview-section">
          <section
            className={`area-analytics-glance ${partial ? 'is-incomplete' : ''}`}
            aria-labelledby="area-analytics-glance-title"
            aria-busy={loading}
          >
            <div className="area-analytics-glance-main">
              <p className="area-analytics-eyebrow">
                {areaLabel.toUpperCase()} · {days} DAYS ·{' '}
                {formatDay(windows.currentStart, { year: 'numeric' })} -{' '}
                {formatDay(windows.endDate, { year: 'numeric' })} UTC
              </p>
              <h2 id="area-analytics-glance-title">Fire Activity at a Glance</h2>
              {loading && !data ? (
                <p className="area-analytics-glance-status" role="status">
                  Loading satellite activity for the selected interval…
                </p>
              ) : error ? (
                <p className="area-analytics-glance-status">Activity status unavailable</p>
              ) : partial && data ? (
                <div>
                  <p className="area-analytics-glance-status">
                    {data.count > 0 ? 'Satellite activity observed' : 'No observations returned'}
                  </p>
                  <p className="area-analytics-glance-copy">
                    {formatNumber(data.count)} hotspot detections returned for the selected {days}-day
                    interval.
                  </p>
                </div>
              ) : data && data.count === 0 ? (
                <div>
                  <p className="area-analytics-glance-status">
                    {chips.length || investigation?.focusedDay
                      ? 'No matching observations'
                      : 'No detections reported'}
                  </p>
                  <p className="area-analytics-glance-copy">
                    No observations match this investigation's region, interval and filters. This
                    does not confirm absence of fire.
                  </p>
                </div>
              ) : data ? (
                <div>
                  <p className="area-analytics-glance-status">
                    {comparison === null
                      ? 'Satellite activity observed'
                      : comparison.difference > 0
                        ? 'More detections than the previous interval'
                        : comparison.difference < 0
                          ? 'Fewer detections than the previous interval'
                          : 'Same detection count as the previous interval'}
                  </p>
                  <p className="area-analytics-glance-copy">
                    {formatNumber(data.count)} hotspot detections in the selected {days}-day
                    interval
                    {comparison &&
                      ` · ${comparison.difference > 0 ? '+' : ''}${formatNumber(comparison.difference)} (${comparison.percentage === null ? 'percentage unavailable: previous count was zero' : `${comparison.percentage > 0 ? '+' : ''}${comparison.percentage.toFixed(1)}%`}) versus the preceding ${days} days`}
                  </p>
                </div>
              ) : (
                <p className="area-analytics-glance-status">Activity status unavailable</p>
              )}
              {((loading && !data) || progressComplete) && (
                <ActivityProgressBar progress={activityProgress} complete={progressComplete} />
              )}
            </div>
            <div className="area-analytics-glance-details">
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
                    ? `${formatNumber(previousData?.count ?? 0)} detections · ${formatDay(windows.previousStart, { year: 'numeric' })}-${formatDay(shiftUtcDate(windows.currentStart, -1), { year: 'numeric' })} UTC`
                    : comparisonLoading
                      ? 'Loading equal-length comparison…'
                      : 'Previous interval unavailable'}
                </strong>
              </div>
              <p className="area-analytics-glance-caveat">
                Satellite observations for the selected interval are not a fire-threat rating.
                Overpass, cloud, and processing gaps apply; a lack of detections is not an
                all-clear. {includesCurrentDay && 'The current UTC day may be incomplete.'}
              </p>
            </div>
          </section>

          <section className="area-analytics-summary-grid" aria-label="Recent activity summary">
            <article className="area-analytics-card">
              <span className="area-analytics-card-label">Hotspot detections</span>
              <strong className="area-analytics-card-value">
                {data ? formatNumber(data.count) : loading ? '…' : '—'}
              </strong>
              <span className="area-analytics-card-note">Satellite observations · {days} days</span>
            </article>
            <article className="area-analytics-card">
              <span className="area-analytics-card-label">Change vs prior period</span>
              <strong className="area-analytics-card-value">
                {comparison
                  ? comparison.percentage === null
                    ? `${comparison.difference > 0 ? '+' : ''}${formatNumber(comparison.difference)}`
                    : `${comparison.percentage > 0 ? '+' : ''}${comparison.percentage.toFixed(1)}%`
                  : loading
                    ? '…'
                    : '—'}
              </strong>
              <span className="area-analytics-card-note">
                {comparison
                  ? `${formatNumber(Math.abs(comparison.difference))} detections ${comparison.difference >= 0 ? 'more' : 'fewer'} · previous ${days} days`
                  : 'Equal-length period immediately before the selected interval'}
              </span>
              {comparison?.percentage === null && (
                <span className="area-analytics-card-note">
                  Percentage unavailable: prior count was zero.
                </span>
              )}
            </article>
            <article className="area-analytics-card">
              <span className="area-analytics-card-label">Peak activity day</span>
              <strong className="area-analytics-card-value">
                {peak ? formatDay(peak.date) : data ? 'No detections' : loading ? '…' : '—'}
              </strong>
              <span className="area-analytics-card-note">
                {peak
                  ? `${formatNumber(peak.count)} detections · UTC`
                  : 'Highest daily total in this interval'}
              </span>
            </article>
            <article className="area-analytics-card">
              <span className="area-analytics-card-label">Historical comparison</span>
              <strong className="area-analytics-card-value area-analytics-card-value-small">
                <button
                  type="button"
                  className="analytics-record-link"
                  onClick={() => setTab('history')}
                >
                  Open History
                </button>
              </strong>
              <span className="area-analytics-card-note">
                Compare this period with the same dates in past years
              </span>
            </article>
            <article className="area-analytics-card">
              <span className="area-analytics-card-label">Latest observation</span>
              <strong className="area-analytics-card-value area-analytics-card-value-small">
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
              <span className="area-analytics-card-note">
                {latest
                  ? `${formatObservationAge(latest.properties.acquired_at)} · ${latest.properties.sensor} · ${latest.properties.satellite} · UTC`
                  : 'Latest observation time in the selected interval'}
              </span>
            </article>
            <article className="area-analytics-card">
              <span className="area-analytics-card-label">Highest reported FRP</span>
              <strong className="area-analytics-card-value">
                {highestFrpDetection
                  ? `${highestFrpDetection.properties.frp_mw?.toFixed(1)} MW`
                  : data
                    ? 'Not reported'
                    : loading
                      ? '…'
                      : '—'}
              </strong>
              <span className="area-analytics-card-note">
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
            className="area-analytics-card area-analytics-chart-card"
            aria-labelledby="area-analytics-activity-title"
          >
            <div className="area-analytics-section-heading">
              <div>
                <h2 id="area-analytics-activity-title">Recent activity</h2>
                <p>
                  {chartScope
                    ? `Full selected interval · ${investigation?.focusedDay ?? investigation?.filters.day} focused in records`
                    : data
                      ? `${formatNumber(data.count)} filtered detections from ${formatDay(windows.currentStart, { year: 'numeric' })} to ${formatDay(windows.endDate, { year: 'numeric' })}`
                      : 'Daily hotspot detections in the selected interval'}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={downloadCsv}
                disabled={!data || !investigation || loading}
              >
                Export matching CSV
              </Button>
            </div>
            {loading && !data ? (
              <p className="area-analytics-loading" role="status">
                Loading recent FIRMS detections…
              </p>
            ) : error && !data ? (
              <p className="area-analytics-empty">
                Chart unavailable until hotspot data can be loaded.
              </p>
            ) : chartScope && chartContext.isPending ? (
              <p className="area-analytics-loading" role="status">
                Loading full-interval activity…
              </p>
            ) : chartScope && chartContext.isError ? (
              <p className="area-analytics-empty">
                Full-interval chart unavailable.{' '}
                {chartContext.error instanceof Error ? chartContext.error.message : ''}
              </p>
            ) : data ? (
              <ActivityChart
                days={
                  activityPage && investigation
                    ? observationDays(activityPage, investigation)
                    : daily
                }
                previousDays={comparison ? previousDaily : []}
                busy={loading}
                onSelect={focusDate}
                focusedDay={investigation?.focusedDay ?? investigation?.filters.day}
              />
            ) : (
              <p className="area-analytics-empty">No data is available for this interval.</p>
            )}
          </section>

          <section className="area-analytics-analysis-grid" aria-label="Detection analytics">
            <BreakdownChart
              title={investigation ? 'Detections by satellite' : 'Detections by product'}
              description={
                investigation
                  ? 'Raw observation counts by platform within the current filters.'
                  : 'Sensor/product provenance in the selected interval.'
              }
              buckets={sensorBuckets}
              onSelect={(label) => chooseFilter(chartFilter('product', label))}
            />
            <BreakdownChart
              title="Confidence distribution"
              description="MODIS numeric ranges and VIIRS classes are shown separately; they are not equivalent scales."
              buckets={confidenceDistribution}
              onSelect={(label) => chooseFilter(chartFilter('confidence', label))}
            />
            <BreakdownChart
              title="Fire radiative power"
              description="Observation counts by reported FRP range, in megawatts."
              buckets={frpDistribution}
              onSelect={(label) => chooseFilter(chartFilter('frp', label))}
            />
            <TopDetectionCells cells={topCells} />
            <HourlyChart
              hours={data?.summary.hourly ?? []}
              onSelect={(hour) => chooseFilter(chartFilter('hour', hour))}
            />
            <section className="area-analytics-card area-analytics-analysis-card">
              <div className="area-analytics-section-heading">
                <div>
                  <h2>FRP summary</h2>
                  <p>Fire radiative power per hotspot observation, where reported.</p>
                </div>
              </div>
              <strong className="area-analytics-card-value">
                {medianFrpValue === null ? '—' : `${medianFrpValue.toFixed(1)} MW`}
              </strong>
              <span className="area-analytics-card-note">
                Median FRP · {formatNumber(data?.summary.frpReported ?? 0)} of{' '}
                {formatNumber(data?.count ?? 0)} observations reported FRP
              </span>
              <p className="area-analytics-footnote">
                FRP is a satellite-derived observation of radiative power, not a direct measure of
                burned area, fire size, or impact.
              </p>
            </section>
          </section>

          <section
            className="area-analytics-card area-analytics-coverage"
            aria-labelledby="area-analytics-coverage-title"
          >
            <div className="area-analytics-section-heading">
              <div>
                <h2 id="area-analytics-coverage-title">Data coverage</h2>
                <p>NASA FIRMS near-real-time products · query dates use UTC calendar days</p>
              </div>
              <span className={`area-analytics-status ${partial ? 'is-partial' : ''}`}>
                {data ? (partial ? 'Partial' : 'Complete') : loading ? 'Loading' : 'Unavailable'}
              </span>
            </div>
            {data ? (
              <ul className="area-analytics-source-list">
                {data.sources.map((source) => (
                  <li key={source.source}>
                    <span>{source.source}</span>
                    <span>
                      {investigation
                        ? `${source.status === 'ok' ? 'Complete' : source.status === 'partial' ? 'Partial / stale' : 'Unavailable'} reporting${source.oldest_fetched_at ? ` · retrieved ${source.oldest_fetched_at}` : ''}`
                        : source.status === 'ok'
                          ? `${source.successful_days}/${days} days`
                          : `${source.status} · ${source.successful_days}/${days} days`}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="area-analytics-empty">
                {error
                  ? 'Coverage details unavailable because the request failed.'
                  : 'Coverage details will appear with the results.'}
              </p>
            )}
            {data && (
              <p className="area-analytics-footnote">
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
            <p className="area-analytics-footnote">
              A hotspot is a satellite observation and may represent wildfire, agricultural burning,
              industrial heat, or another thermal anomaly. Observation counts are not unique fire
              counts.
            </p>
          </section>
        </div>
        {investigation ? (
          <>
            <RecordsExplorer
              scope={investigation}
              active={tab === 'records'}
              onScopeChange={updateInvestigation}
              onHighlight={onHighlight}
              onResponse={receivePage}
              onReturnToMap={onClose}
              onStatus={(busy, message) => {
                setLoading(busy)
                setError(message)
              }}
            />
            {(tab === 'history' || tab === 'method') && (
              <Suspense
                fallback={
                  <p className="area-analytics-loading" role="status">
                    Loading scientific analysis…
                  </p>
                }
              >
                <InvestigationScience
                  section={tab}
                  scope={investigation}
                  sourceGeneration={
                    currentPage?.meta.sourceGeneration ?? investigation.metadata?.sourceGeneration
                  }
                  onScopeChange={(next) => {
                    updateInvestigation(next)
                    setTab('records')
                    onHighlight?.(next)
                  }}
                />
              </Suspense>
            )}
            <section className="area-analytics-card analytics-brief">
              <div className="area-analytics-section-heading">
                <div>
                  <h2>Analysis brief</h2>
                  <p>Print the current investigation, its chart and reproducibility details.</p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  disabled={!currentPage || loading || (!!chartScope && !chartContext.data)}
                  onClick={() => window.print()}
                >
                  Print / Save PDF
                </Button>
                {onCapture && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!currentPage || capturing || loading}
                    onClick={() => {
                      setCapturing(true)
                      setCaptureError('')
                      void onCapture(investigation)
                        .catch((error: unknown) =>
                          setCaptureError(
                            error instanceof Error ? error.message : 'Map capture failed.',
                          ),
                        )
                        .finally(() => setCapturing(false))
                    }}
                  >
                    {capturing ? 'Capturing map…' : 'Apply and capture map'}
                  </Button>
                )}
              </div>
              {captureError && <p role="alert">{captureError}</p>}
              <div className="analytics-brief-print">
                <h2>{investigation.area.name}</h2>
                <p>
                  {investigation.query.interval.start} → {investigation.query.interval.endExclusive}{' '}
                  (exclusive), UTC
                </p>
                <p>
                  {currentPage?.data.total.toLocaleString() ?? 'Unavailable'} matching observations;{' '}
                  {currentPage?.data.summary.selectedCount.toLocaleString() ?? 'Unavailable'}{' '}
                  selected;{' '}
                  {currentPage?.data.summary.wholeAreaCount.toLocaleString() ?? 'Unavailable'} whole
                  area.
                </p>
                <p>
                  Filters:{' '}
                  {chips.length
                    ? chips.map(([key, value]) => key + ': ' + JSON.stringify(value)).join('; ')
                    : 'None'}
                  . Focused day: {investigation.focusedDay ?? 'None'}.
                </p>
                {membershipInterval && (
                  <p>
                    Frozen membership interval: {membershipInterval.start} →{' '}
                    {membershipInterval.endExclusive} (exclusive), UTC. Whole-area counts refer to
                    this interval.
                  </p>
                )}
                <p>
                  Source generation:{' '}
                  {currentPage?.meta.sourceGeneration ??
                    investigation.metadata?.sourceGeneration ??
                    'Unknown'}
                  . Dataset: {currentPage?.meta.datasetVersion ?? 'Unknown'}.
                </p>
                <p>
                  Completeness: {currentPage?.meta.completeness ?? 'Unknown'}; freshness:{' '}
                  {currentPage?.meta.freshness ?? 'Unknown'}. Latest acquisition:{' '}
                  {currentPage?.data.summary.latestAcquisition ?? 'None reported'}. Retrieved:{' '}
                  {currentPage?.meta.fetchedAt ?? 'Unknown'}.
                </p>
                <p>
                  Harmonized analytical method: {investigation.method}. Overview charts show raw
                  satellite observations; observation filters do not redefine the harmonized method.
                </p>
                {matchingSnapshot ? (
                  <img src={matchingSnapshot} alt="Map of this investigation" />
                ) : (
                  <p>Capture the applied map to include an image of this investigation version.</p>
                )}
                <details open>
                  <summary>Investigation and provenance</summary>
                  <pre>
                    {JSON.stringify(
                      {
                        ...scopeExportIdentity(investigation),
                        metadata: { ...investigation.metadata, ...currentPage?.meta },
                      },
                      null,
                      2,
                    )}
                  </pre>
                </details>
              </div>
            </section>
          </>
        ) : (
          tab !== 'overview' && (
            <section className="area-analytics-card">
              <p>
                Choose an area or observation group on the map to open its complete investigation.
              </p>
              <Button variant="outline" onClick={onClose}>
                Return to map
              </Button>
            </section>
          )
        )}
      </div>
    </section>
  )
}
