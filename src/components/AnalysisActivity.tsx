import { useEffect, useId, useRef, useState } from 'react'
import { CaretLeftIcon, CaretRightIcon } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import type { AnalysisArea } from '@/lib/analysis-area'
import { fetchMonthActivity, type MonthActivity } from '@/lib/analysis-api'
import {
  ANALYSIS_PLATFORMS,
  activityStats,
  addUtcDays,
  calendarWeeks,
  clampRange,
  crossesDateline,
  formatUtcDay,
  formatUtcRange,
  heatLevel,
  monthSpan,
  shiftMonth,
  type AnalysisRange,
  type SeriesPoint,
} from '@/lib/analysis-activity'

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const PLATFORM_LABELS: Record<string, string> = {
  aqua: 'Aqua',
  'suomi-npp': 'Suomi NPP',
  'noaa-20': 'NOAA-20',
  'noaa-21': 'NOAA-21',
}
const PLATFORM_COLORS: Record<string, string> = {
  aqua: '#e8a317',
  'suomi-npp': '#3b82f6',
  'noaa-20': '#22c55e',
  'noaa-21': '#c084fc',
}

type CacheEntry =
  | { status: 'loading' }
  | { status: 'ready'; data: MonthActivity }
  | { status: 'error'; message: string }

type AnalysisActivityProps = {
  area: AnalysisArea
  range: AnalysisRange
  generation: number
  onRangeChange: (range: AnalysisRange) => void
}

export function AnalysisActivity({
  area,
  range,
  generation,
  onRangeChange,
}: AnalysisActivityProps) {
  const labelId = useId()
  const gridRef = useRef<HTMLDivElement>(null)
  const anchorRef = useRef(range.start)
  const draggedRef = useRef(false)
  const pendingFocus = useRef<string | null>(null)
  const selectionRef = useRef(range)
  selectionRef.current = range
  const [month, setMonth] = useState(() => range.start.slice(0, 7))
  const [seenGeneration, setSeenGeneration] = useState(generation)
  const [detail, setDetail] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  if (generation !== seenGeneration) {
    setSeenGeneration(generation)
    setMonth(range.start.slice(0, 7))
  }

  const dateline = crossesDateline(area.fullBounds ?? area.bounds)
  const months = dateline
    ? []
    : [...new Set([month, range.start.slice(0, 7), range.end.slice(0, 7)])]
  const cache = useMonthCache(area, months, retry, generation)
  const weeks = calendarWeeks(month)
  const days = new Map<string, MonthActivity['days'][number]>()
  for (const entry of cache.values()) {
    if (entry.status !== 'ready') continue
    for (const day of entry.data.days) days.set(day.date, day)
  }
  const selectedMonths = [...new Set([range.start.slice(0, 7), range.end.slice(0, 7)])]
  const selectedEntries = selectedMonths.map((item) => cache.get(`${area.id}:${item}`))
  const selectedReady = selectedEntries.every((entry) => entry?.status === 'ready')
  const error = selectedEntries.find((entry) => entry?.status === 'error')
  const series = selectedReady
    ? selectedEntries.flatMap((entry) => (entry?.status === 'ready' ? entry.data.series : []))
    : []
  const loadedMonth = selectedEntries.find(
    (entry) =>
      entry?.status === 'ready' && entry.data.start === range.start && entry.data.end === range.end,
  )
  const stats = selectedReady
    ? activityStats(
        series,
        range,
        loadedMonth?.status === 'ready' ? loadedMonth.data.medianFrp : null,
        loadedMonth?.status === 'ready',
      )
    : null
  const visible = cache.get(`${area.id}:${month}`)
  const maxCount = Math.max(0, ...weeks.flat().map((day) => days.get(day)?.count ?? 0))
  const monthDate = new Date(`${monthSpan(month).start}T00:00:00Z`)
  const monthLabel = new Intl.DateTimeFormat('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(monthDate)

  useEffect(() => {
    const day = pendingFocus.current
    if (!day) return
    const node = gridRef.current?.querySelector<HTMLButtonElement>(`[data-day="${day}"]`)
    if (!node) return
    node.focus()
    pendingFocus.current = null
  }, [month, range])

  function selectDay(day: string, extend: boolean) {
    pendingFocus.current = day
    if (day.slice(0, 7) !== month) setMonth(day.slice(0, 7))
    onRangeChange(extend ? clampRange(anchorRef.current, day) : clampRange(day, day))
    if (!extend) anchorRef.current = day
  }

  function dayFromPoint(x: number, y: number) {
    const node = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-day]')
    return node?.dataset.day ?? null
  }

  return (
    <section className="analysis-activity" aria-labelledby={labelId}>
      <h2 id={labelId}>Activity</h2>
      <p className="analysis-activity-range">{formatUtcRange(range)} UTC</p>
      <dl className="analysis-metrics">
        <Metric
          label="Detections"
          value={stats ? formatNumber(stats.detections) : '—'}
          detail="Returned FIRMS detections in the selected dates."
        />
        <Metric
          label="Days with detections"
          value={stats ? formatNumber(stats.daysWithDetections) : '—'}
          detail="Selected UTC days with at least one returned detection."
        />
        <Metric
          label="Peak day"
          value={stats?.peakDate ? formatUtcDay(stats.peakDate) : '—'}
          detail="Earliest selected day tied for the most detections."
        />
        <Metric
          label="Median FRP"
          value={
            stats?.medianFrp === null || stats === null
              ? '—'
              : `${formatNumber(stats.medianFrp)} MW`
          }
          detail="Median fire radiative power for the whole loaded month. A shorter selection has no FRP values."
        />
      </dl>

      {dateline && (
        <p className="analysis-error" role="alert">
          This area crosses 180° longitude, so the live query cannot bound it. Draw the part you
          want on one side of the date line.
        </p>
      )}
      {!dateline && error?.status === 'error' && (
        <div className="analysis-error" role="alert">
          <p>{error.message}</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setRetry((current) => current + 1)}
          >
            Retry
          </Button>
        </div>
      )}
      {!dateline && !error && !selectedReady && (
        <p className="analysis-notice" role="status">
          Loading activity.
        </p>
      )}
      {visible?.status === 'ready' && visible.data.completeness !== 'complete' && (
        <p className="analysis-notice">
          {visible.data.completeness === 'unavailable'
            ? 'No stored coverage for this month.'
            : 'Some days in this month are only partly covered.'}
        </p>
      )}

      <div className="analysis-calendar">
        <div className="analysis-calendar-nav">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Previous month"
            onClick={() => setMonth((current) => shiftMonth(current, -1))}
          >
            <CaretLeftIcon size={16} />
          </Button>
          <h3>{monthLabel}</h3>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Next month"
            onClick={() => setMonth((current) => shiftMonth(current, 1))}
          >
            <CaretRightIcon size={16} />
          </Button>
        </div>
        <div className="analysis-heat">
          <div className="analysis-heat-dow" aria-hidden="true">
            {WEEKDAYS.map((name) => (
              <span key={name}>{name.slice(0, 1)}</span>
            ))}
          </div>
          <div
            ref={gridRef}
            className="analysis-heat-grid"
            role="group"
            aria-label={`${monthLabel} activity`}
            onPointerDown={(event) => {
              if (event.button !== 0) return
              const day = dayFromPoint(event.clientX, event.clientY)
              if (!day) return
              draggedRef.current = false
              anchorRef.current = day
              const next = clampRange(day, day)
              selectionRef.current = next
              event.currentTarget.setPointerCapture(event.pointerId)
              onRangeChange(next)
            }}
            onPointerMove={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
              const day = dayFromPoint(event.clientX, event.clientY)
              if (!day) return
              if (day !== anchorRef.current) draggedRef.current = true
              const next = clampRange(anchorRef.current, day)
              if (
                next.start === selectionRef.current.start &&
                next.end === selectionRef.current.end
              )
                return
              selectionRef.current = next
              onRangeChange(next)
            }}
            onPointerUp={() => {
              anchorRef.current = selectionRef.current.start
            }}
          >
            {weeks.map((week) =>
              week.map((day) => {
                const cell = days.get(day)
                const outside = day.slice(0, 7) !== month
                const selected = day >= range.start && day <= range.end
                const level =
                  cell?.state === 'unavailable' || cell?.count == null
                    ? null
                    : heatLevel(cell.count, maxCount)
                const countLabel = !cell
                  ? 'Not loaded'
                  : cell.state === 'unavailable' || cell.count === null
                    ? 'No coverage'
                    : `${cell.count} harmonized active cells`
                return (
                  <button
                    key={day}
                    type="button"
                    data-day={day}
                    className="analysis-heat-day"
                    data-level={level ?? undefined}
                    data-state={cell ? cell.state : 'unloaded'}
                    data-outside={outside || undefined}
                    aria-pressed={selected}
                    aria-label={`${formatUtcDay(day)}. ${countLabel}`}
                    onClick={(event) => {
                      if (draggedRef.current) {
                        draggedRef.current = false
                        event.preventDefault()
                        return
                      }
                      anchorRef.current = day
                      onRangeChange(clampRange(day, day))
                    }}
                    onFocus={() => setDetail(`${formatUtcDay(day)}. ${countLabel}`)}
                    onPointerEnter={() => setDetail(`${formatUtcDay(day)}. ${countLabel}`)}
                    onKeyDown={(event) => {
                      const step =
                        event.key === 'ArrowUp'
                          ? -1
                          : event.key === 'ArrowDown'
                            ? 1
                            : event.key === 'ArrowLeft'
                              ? -7
                              : event.key === 'ArrowRight'
                                ? 7
                                : 0
                      if (!step) return
                      event.preventDefault()
                      selectDay(addUtcDays(day, step), event.shiftKey)
                    }}
                  />
                )
              }),
            )}
          </div>
        </div>
        <p className="analysis-heat-detail" aria-live="polite">
          {detail ?? 'Click a day or drag across a period of up to 31 days.'}
        </p>
        <div className="analysis-heat-legend">
          <span>Less</span>
          {[0, 1, 2, 3, 4].map((level) => (
            <span key={level} className="analysis-heat-swatch" data-level={level} />
          ))}
          <span>More</span>
          <span className="analysis-heat-swatch" data-state="unavailable" />
          <span>No coverage</span>
        </div>
        <p className="analysis-heat-unit">
          Cell color is harmonized afternoon active cells, not a count of fires.
        </p>
      </div>

      <ActivityTrend days={selectedReady ? eachSelectedDay(range) : []} series={series} />
    </section>
  )
}

function useMonthCache(area: AnalysisArea, months: string[], retry: number, generation: number) {
  const cache = useRef(new Map<string, CacheEntry>())
  const [version, setVersion] = useState(0)
  const monthsKey = months.join(',')
  const identity = `${area.id}:${generation}`
  useEffect(() => {
    cache.current.clear()
  }, [identity])
  useEffect(() => {
    if (!monthsKey) return
    const controller = new AbortController()
    const requested = monthsKey.split(',')
    const pending = requested.filter((item) => {
      const entry = cache.current.get(`${area.id}:${item}`)
      return !entry || entry.status === 'error'
    })
    if (!pending.length) return
    for (const item of pending) cache.current.set(`${area.id}:${item}`, { status: 'loading' })
    setVersion((current) => current + 1)
    for (const item of pending) {
      const key = `${area.id}:${item}`
      fetchMonthActivity(area.id, area.geometry, item, controller.signal)
        .then((data) => {
          if (controller.signal.aborted) return
          cache.current.set(key, { status: 'ready', data })
          setVersion((current) => current + 1)
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return
          cache.current.set(key, {
            status: 'error',
            message: error instanceof Error ? error.message : 'The activity could not be loaded.',
          })
          setVersion((current) => current + 1)
        })
    }
    return () => {
      controller.abort()
      for (const item of pending) {
        const key = `${area.id}:${item}`
        if (cache.current.get(key)?.status === 'loading') cache.current.delete(key)
      }
    }
  }, [area, identity, monthsKey, retry])
  void version
  return cache.current
}

function eachSelectedDay(range: AnalysisRange) {
  const days: string[] = []
  let cursor = range.start
  while (cursor <= range.end && days.length < 31) {
    days.push(cursor)
    cursor = addUtcDays(cursor, 1)
  }
  return days
}

function formatNumber(value: number | null) {
  if (value === null) return '—'
  return new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 }).format(value)
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd title={detail}>{value}</dd>
    </div>
  )
}

function ActivityTrend({ days, series }: { days: string[]; series: SeriesPoint[] }) {
  const platforms = ANALYSIS_PLATFORMS.filter((platform) =>
    series.some((point) => point.platform === platform && days.includes(point.date)),
  )
  const rows = platforms.map((platform) => ({
    platform,
    values: days.map((day) => {
      const point = series.find((item) => item.date === day && item.platform === platform)
      return !point || point.state === 'unavailable' ? null : point.count
    }),
  }))
  const hasValue = rows.some((row) => row.values.some((value) => value !== null))
  const max = Math.max(1, ...rows.flatMap((row) => row.values.filter((value) => value !== null)))
  const width = 320
  const height = 128
  const left = 28
  const right = 6
  const top = 8
  const bottom = 18
  const plotWidth = width - left - right
  const plotHeight = height - top - bottom
  const x = (index: number) =>
    left + (days.length <= 1 ? plotWidth / 2 : (index / (days.length - 1)) * plotWidth)
  const y = (count: number) => top + (1 - count / max) * plotHeight
  const labels = days.length
    ? [days[0], days[Math.floor((days.length - 1) / 2)], days[days.length - 1]].filter(
        (day, index, list) => list.indexOf(day) === index,
      )
    : []

  return (
    <section className="analysis-trend" aria-label="Detection trend">
      <h3>Trend</h3>
      {!days.length ? (
        <p className="analysis-notice">The trend appears when the selected dates have loaded.</p>
      ) : !hasValue ? (
        <p className="analysis-notice">No covered detections in the selected dates.</p>
      ) : (
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Detections by platform">
          <line x1={left} y1={top} x2={left} y2={top + plotHeight} />
          <line x1={left} y1={top + plotHeight} x2={left + plotWidth} y2={top + plotHeight} />
          <text x={left - 4} y={top + 4} textAnchor="end">
            {max}
          </text>
          <text x={left - 4} y={top + plotHeight} textAnchor="end">
            0
          </text>
          {labels.map((day) => (
            <text key={day} x={x(days.indexOf(day))} y={height - 2} textAnchor="middle">
              {Number(day.slice(8))}
            </text>
          ))}
          {rows.map((row) => (
            <g key={row.platform} stroke={PLATFORM_COLORS[row.platform]}>
              {segments(row.values).map((segment, index) => (
                <polyline
                  key={index}
                  fill="none"
                  strokeWidth="2"
                  points={segment
                    .map((value, valueIndex) =>
                      value === null ? '' : `${x(valueIndex)},${y(value)}`,
                    )
                    .filter(Boolean)
                    .join(' ')}
                />
              ))}
              {row.values.map((value, index) =>
                value === null ? null : (
                  <circle
                    key={days[index]}
                    cx={x(index)}
                    cy={y(value)}
                    r="2.5"
                    fill={PLATFORM_COLORS[row.platform]}
                  />
                ),
              )}
            </g>
          ))}
        </svg>
      )}
      <ul className="analysis-trend-legend">
        {ANALYSIS_PLATFORMS.map((platform) => (
          <li key={platform}>
            <span style={{ background: PLATFORM_COLORS[platform] }} />
            {PLATFORM_LABELS[platform]}
          </li>
        ))}
      </ul>
    </section>
  )
}

function segments(values: (number | null)[]) {
  const result: (number | null)[][] = []
  let current: (number | null)[] | null = null
  values.forEach((value, index) => {
    if (value === null) {
      current = null
      return
    }
    if (!current) {
      current = Array.from({ length: values.length }, () => null)
      result.push(current)
    }
    current[index] = value
  })
  return result
}
