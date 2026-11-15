import { useId, useRef, useState } from 'react'
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
}

export function AnalysisActivity({
  range,
  activity,
  status,
  message,
  onRetry,
  focusedDay,
  onFocusDay,
}: AnalysisActivityProps) {
  const labelId = useId()
  const gridRef = useRef<HTMLDivElement>(null)
  const [detail, setDetail] = useState<string | null>(null)
  const displayRange = activity?.range ?? range
  const stats = selectedActivityStats(activity, focusedDay)
  const days = eachUtcDay(displayRange.start, displayRange.end)
  const cells = new Map(activity?.days.map((day) => [day.date, day]) ?? [])
  const maxCount = Math.max(0, ...Array.from(cells.values()).map((day) => day.count ?? 0))
  const leading = new Date(displayRange.start + 'T00:00:00Z').getUTCDay()
  const slots: (string | null)[] = [...Array.from({ length: leading }, () => null), ...days]
  const series = activity?.series ?? []
  const shownDays = focusedDay ? days.filter((day) => day === focusedDay) : days

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
          <h3>{formatUtcRange(displayRange)}</h3>
          <Button
            size="sm"
            variant="outline"
            aria-pressed={!focusedDay}
            onClick={() => onFocusDay(null)}
          >
            All days
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
          {detail ?? 'Select a day to show its detections, or All days for the full period.'}
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
      <p className="analysis-heat-unit">
        Statistics count returned satellite detections. Calendar cells use the existing harmonized
        afternoon method.
      </p>
      <ActivityTrend days={activity ? shownDays : []} series={series} />
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

function ActivityTrend({ days, series }: { days: string[]; series: SeriesPoint[] }) {
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
        {platforms.map((platform) => (
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
