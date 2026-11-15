import { useId, useRef, useState } from 'react'
import { CaretLeftIcon, CaretRightIcon } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import type { AnalysisArea } from '@/lib/analysis-area'
import { selectedActivityStats, type AnalysisActivityData } from '@/lib/analysis-api'
import type { AnalysisFireStatus } from '@/hooks/use-analysis-fires'
import {
  ANALYSIS_PLATFORMS,
  addUtcDays,
  eachUtcDay,
  formatUtcDay,
  formatUtcRange,
  heatLevel,
  type AnalysisRange,
  type SeriesPoint,
  type CalendarDay,
  utcToday,
  monthSpan,
  shiftMonth,
} from '@/lib/analysis-activity'

const PLATFORM_LABELS: Record<string, string> = {
  terra: 'Terra',
  aqua: 'Aqua',
  'suomi-npp': 'Suomi NPP',
  'noaa-20': 'NOAA-20',
  'noaa-21': 'NOAA-21',
}
const PLATFORM_COLORS: Record<string, string> = {
  terra: '#ef4444',
  aqua: '#e8a317',
  'suomi-npp': '#3b82f6',
  'noaa-20': '#22c55e',
  'noaa-21': '#c084fc',
}
type AnalysisActivityProps = {
  area: AnalysisArea
  range: AnalysisRange
  activity: AnalysisActivityData | null
  status: AnalysisFireStatus
  message: string
  onRetry: () => void
  focusedDay: string | null
  onFocusDay: (day: string | null) => void
  onOpenAnalytics?: () => void
}

export function AnalysisActivity({
  range,
  activity,
  status,
  message,
  onRetry,
  focusedDay,
  onFocusDay,
  onOpenAnalytics,
}: AnalysisActivityProps) {
  const labelId = useId()
  const gridRef = useRef<HTMLDivElement>(null)
  const [detail, setDetail] = useState<string | null>(null)
  const displayRange = activity?.range ?? range
  const [month, setMonth] = useState(displayRange.start.slice(0, 7))
  const summaryOnly =
    activity?.summaryOnly ||
    (Date.parse(displayRange.end) - Date.parse(displayRange.start)) / 86_400_000 >= 31
  const visibleRange = summaryOnly
    ? {
        start:
          monthSpan(month).start < displayRange.start ? displayRange.start : monthSpan(month).start,
        end: monthSpan(month).end > displayRange.end ? displayRange.end : monthSpan(month).end,
      }
    : displayRange
  const stats = selectedActivityStats(activity, focusedDay)
  const days = eachUtcDay(visibleRange.start, visibleRange.end)
  const cells = new Map(activity?.days.map((day) => [day.date, day]) ?? [])
  const maxCount = Math.max(0, ...Array.from(cells.values()).map((day) => day.count ?? 0))
  const leading = new Date(visibleRange.start + 'T00:00:00Z').getUTCDay()
  const slots: (string | null)[] = [...Array.from({ length: leading }, () => null), ...days]
  const series = activity?.series ?? []

  return (
    <section className="analysis-activity" aria-labelledby={labelId}>
      <h2 id={labelId}>Activity</h2>
      <p className="analysis-activity-range">{formatUtcRange(displayRange)} UTC</p>
      {['error', 'stale', 'partial'].includes(status) && (
        <div className="analysis-error" role="alert">
          <p>{message}</p>
          {!/180(?:°| degrees)|31 UTC calendar days|smaller region|shorter period/i.test(
            message,
          ) && (
            <Button size="sm" variant="outline" onClick={onRetry}>
              {status === 'error' ? 'Retry' : 'Refresh'}
            </Button>
          )}
        </div>
      )}
      {status === 'loading' && (
        <p className="analysis-notice" role="status">
          {message || 'Loading activity.'}
        </p>
      )}
      {activity?.completeness === 'partial' && (
        <p className="analysis-notice">
          Some source partitions are still missing. Counts reflect available data.
        </p>
      )}
      {activity?.completeness === 'unavailable' && (
        <p className="analysis-notice">No source coverage is available for this period.</p>
      )}
      <div className="analysis-calendar">
        <div className="analysis-calendar-nav">
          {summaryOnly && (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Previous activity month"
              disabled={month <= displayRange.start.slice(0, 7)}
              onClick={() => setMonth(shiftMonth(month, -1))}
            >
              <CaretLeftIcon size={16} />
            </Button>
          )}
          <h3>{formatUtcRange(visibleRange)}</h3>
          {summaryOnly && (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Next activity month"
              disabled={month >= displayRange.end.slice(0, 7)}
              onClick={() => setMonth(shiftMonth(month, 1))}
            >
              <CaretRightIcon size={16} />
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            aria-pressed={!focusedDay}
            onClick={() => onFocusDay(null)}
          >
            Clear day focus
          </Button>
        </div>
        <div className="analysis-heat">
          <div className="analysis-heat-dow" aria-hidden="true">
            {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((day, index) => (
              <span key={index}>{day}</span>
            ))}
          </div>
          <div
            ref={gridRef}
            className="analysis-heat-grid"
            role="group"
            aria-label="Activity in the selected period"
          >
            {slots.map((day, index) => {
              if (!day) return <span key={'empty-' + index} aria-hidden="true" />
              const cell = cells.get(day)
              const level =
                cell?.state === 'unavailable' || cell?.count == null
                  ? null
                  : heatLevel(cell.count, maxCount)
              const description =
                formatUtcDay(day) +
                '. ' +
                (!cell
                  ? 'Loading'
                  : cell.count === null || cell.state === 'unavailable'
                    ? 'No coverage'
                    : cell.count + ' harmonized active cells')
              return (
                <button
                  key={day}
                  type="button"
                  data-activity-day={day}
                  className="analysis-heat-day"
                  data-level={level ?? undefined}
                  data-state={cell?.state ?? 'unloaded'}
                  aria-label={description}
                  title={description}
                  aria-pressed={focusedDay === day}
                  onClick={() => onFocusDay(focusedDay === day ? null : day)}
                  onFocus={() => setDetail(description)}
                  onPointerEnter={() => setDetail(description)}
                  onKeyDown={(event) => {
                    const step = (
                      { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 } as Record<
                        string,
                        number
                      >
                    )[event.key]
                    if (!step) return
                    event.preventDefault()
                    const next = addUtcDays(day, step)
                    gridRef.current
                      ?.querySelector<HTMLButtonElement>('[data-activity-day="' + next + '"]')
                      ?.focus()
                  }}
                >
                  {Number(day.slice(8))}
                </button>
              )
            })}
          </div>
        </div>
        <p className="analysis-heat-detail" aria-live="polite">
          {detail}
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
        <p className="analysis-heat-unit">Cell color shows harmonized afternoon active cells.</p>
      </div>
      <p className="analysis-stat-range">
        {focusedDay ? formatUtcDay(focusedDay) : 'Full selected period'} UTC
      </p>
      {summaryOnly ? (
        <dl className="analysis-metrics">
          <Metric
            label="Reported activity (covered days)"
            value={
              activity?.days.some((day) => day.count != null)
                ? formatNumber(activity.days.reduce((sum, day) => sum + (day.count ?? 0), 0))
                : '—'
            }
            detail="Sum of reported daily harmonized active cells, in active-cell-days. Missing days are excluded."
          />
          <Metric
            label="Days with reported activity data"
            value={`${activity?.days.filter((day) => day.count != null).length ?? 0} / ${activity?.days.length ?? 0}`}
            detail="Missing days remain unavailable; partial sums are never extrapolated."
          />
        </dl>
      ) : (
        <dl className="analysis-metrics">
          <Metric
            label="Detections"
            value={stats ? formatNumber(stats.detections) : '-'}
            detail="Returned FIRMS detections in the displayed dates."
          />
          <Metric
            label="Days with detections"
            value={stats ? formatNumber(stats.daysWithDetections) : '-'}
            detail="Displayed UTC days with detections."
          />
          <Metric
            label="Peak day"
            value={stats?.peakDate ? formatUtcDay(stats.peakDate) : '-'}
            detail="Earliest displayed day tied for the most detections."
          />
          <Metric
            label="Median FRP"
            value={stats?.medianFrp == null ? '-' : formatNumber(stats.medianFrp) + ' MW'}
            detail="Median fire radiative power for the displayed dates."
          />
        </dl>
      )}
      <p className="analysis-heat-unit">
        {summaryOnly
          ? 'Stored daily activity · active-cell-days. Select a date for its map observations.'
          : 'Statistics count returned satellite detections. Calendar cells use the harmonized afternoon method.'}
      </p>
      <ActivityTrend
        days={activity ? days : []}
        series={series}
        calendar={activity?.days ?? []}
        focusedDay={focusedDay}
        onFocusDay={onFocusDay}
        rawAvailable={!summaryOnly}
      />
      {onOpenAnalytics && (
        <div className="analysis-trend-controls">
          <Button variant="outline" size="sm" onClick={onOpenAnalytics}>
            Open in Area Analytics
          </Button>
        </div>
      )}
    </section>
  )
}

function formatNumber(value: number | null) {
  if (value === null) return '-'
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

export function ActivityTrend({
  days,
  series,
  calendar,
  focusedDay,
  onFocusDay,
  rawAvailable = true,
}: {
  days: string[]
  series: SeriesPoint[]
  calendar: CalendarDay[]
  focusedDay: string | null
  onFocusDay: (day: string | null) => void
  rawAvailable?: boolean
}) {
  const [view, setView] = useState<'harmonized' | 'satellite'>('harmonized')
  const [detail, setDetail] = useState('')
  const platforms = ['terra', ...ANALYSIS_PLATFORMS].filter((platform) =>
    series.some((point) => point.platform === platform && days.includes(point.date)),
  )
  const rows = platforms.map((platform) => ({
    platform,
    values: days.map((day) => {
      const point = series.find((item) => item.date === day && item.platform === platform)
      return !point || point.state === 'unavailable' ? null : point.count
    }),
  }))
  const hasValue =
    view === 'harmonized'
      ? calendar.some((day) => day.count !== null)
      : rows.some((row) => row.values.some((value) => value !== null))
  const max = Math.max(
    1,
    ...(view === 'harmonized'
      ? calendar.map((day) => day.count ?? 0)
      : rows.flatMap((row) => row.values.filter((value) => value !== null))),
  )
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
      <div className="analysis-trend-controls">
        <Button
          size="sm"
          variant="outline"
          aria-pressed={view === 'harmonized'}
          onClick={() => setView('harmonized')}
        >
          Harmonized activity
        </Button>
        <Button
          size="sm"
          variant="outline"
          aria-pressed={view === 'satellite'}
          disabled={!rawAvailable}
          onClick={() => setView('satellite')}
        >
          By satellite
        </Button>
      </div>
      <p className="analysis-heat-unit">
        {view === 'harmonized'
          ? 'Harmonized afternoon active cells · 2 km grid'
          : 'Raw detections · sensor sensitivity and reporting availability differ'}
      </p>
      {!days.length ? (
        <p className="analysis-notice">The trend appears when the selected dates have loaded.</p>
      ) : !hasValue ? (
        <p className="analysis-notice">No covered detections in the selected dates.</p>
      ) : (
        <svg
          viewBox={`0 0 ${width} ${height}`}
          role="group"
          aria-label={
            view === 'harmonized' ? 'Daily harmonized activity' : 'Detections by platform'
          }
        >
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
          {view === 'harmonized' &&
            days.map((date, index) => {
              const day = calendar.find((item) => item.date === date)
              return day?.count == null || day.state === 'unavailable' ? null : (
                <rect
                  key={date}
                  x={x(index) - Math.min(8, plotWidth / days.length / 3)}
                  width={Math.min(16, plotWidth / days.length / 1.5)}
                  y={y(day.count)}
                  height={Math.max(1, top + plotHeight - y(day.count))}
                  fill="var(--brand-accent)"
                  stroke="none"
                />
              )
            })}
          {view === 'satellite' &&
            rows.map((row) => (
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
          {days.map((date, index) => {
            const day = calendar.find((item) => item.date === date)
            const description = `${formatUtcDay(date)} UTC. ${view === 'harmonized' ? `${day?.count ?? 'Unavailable'} harmonized active cells` : rows.map((row) => `${PLATFORM_LABELS[row.platform]}: ${row.values[index] ?? 'unavailable'} raw detections`).join('; ')}. Coverage: ${day?.coverage || day?.state || 'unavailable'}${date === utcToday() ? '. Current UTC day unfinished' : ''}`
            return (
              <rect
                key={date}
                role="button"
                tabIndex={0}
                aria-label={description}
                aria-pressed={focusedDay === date}
                x={Math.max(left, x(index) - plotWidth / Math.max(1, days.length - 1) / 2)}
                y={top}
                width={days.length === 1 ? plotWidth : plotWidth / Math.max(1, days.length - 1)}
                height={plotHeight}
                fill={focusedDay === date ? 'var(--brand-accent)' : 'transparent'}
                fillOpacity={focusedDay === date ? 0.15 : 1}
                stroke="none"
                onPointerEnter={() => setDetail(description)}
                onFocus={() => setDetail(description)}
                onClick={() => onFocusDay(focusedDay === date ? null : date)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onFocusDay(focusedDay === date ? null : date)
                  }
                }}
              >
                <title>{description}</title>
              </rect>
            )
          })}
        </svg>
      )}
      <p className="analysis-heat-detail" aria-live="polite">
        {detail}
      </p>
      {view === 'satellite' && (
        <ul className="analysis-trend-legend">
          {platforms.map((platform) => (
            <li key={platform}>
              <span style={{ background: PLATFORM_COLORS[platform] }} />
              {PLATFORM_LABELS[platform]}
            </li>
          ))}
        </ul>
      )}
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
