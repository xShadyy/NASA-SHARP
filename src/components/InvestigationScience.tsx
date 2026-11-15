import { useEffect, useState } from 'react'
import {
  investigationRequest,
  createInvestigation,
  type InvestigationScope,
} from '@/lib/investigation'

type Evidence = {
  name: string
  methodVersion: string
  gridSizeM: number
  platforms: string[]
  calibrationPeriod: unknown
  usableOverlapDays: number
  fittedScale: number | null
  agreement: Record<string, unknown>
  independentValidation: unknown
  coverageRestriction: string
  notes: string[]
  overlap: {
    date: string
    aquaCells: number
    viirsCells: number
    scaledAquaCells: number | null
    commonCells: number
  }[]
}
type History = {
  status: string
  reason?: string
  unit: string
  datasetVersion?: string
  importedAt?: string
  coverage?: { start: string; endInclusive: string }
  months: {
    year: number
    month: number
    value: number | null
    observedSum: number | null
    state: string
    coveredDays: number
    expectedDays: number
  }[]
  daily: { date: string; value: number | null; state: string; coverage: string }[]
  evidence?: Evidence
  baseline?: {
    years: number[]
    minimumYears: number
    typicalRange: string
    requiredCoverage: string
    leapDayPolicy: string
    partialPeriodPolicy: string
    months: {
      month: number
      median: number | null
      q25: number | null
      q75: number | null
      eligibleYears: number[]
      excludedYears: number[]
    }[]
  }
  comparison?: {
    state: string
    observedValue: number | null
    median?: number
    difference?: number
    eligibleYears: number[]
    coveredDays: number
    expectedDays: number
    partialPeriod: boolean
  }
}
export type Outlook = {
  state: string
  reason?: string
  target: string
  horizonHours: number | null
  gridSizeM?: number
  modelVersion?: string
  issueTime?: string
  validStart?: string
  validEnd?: string
  evaluation?: unknown
  features?: GeoJSON.FeatureCollection
  effectiveInputResolution?: string
  inputFreshness?: unknown
  domain?: unknown
}
function renderValue(item: unknown) {
  return item == null
    ? 'Unavailable'
    : typeof item === 'object'
      ? JSON.stringify(item)
      : String(item)
}
const monthName = (i: number) =>
  new Date(Date.UTC(2000, i - 1)).toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })

export function InvestigationScience({
  scope,
  onScopeChange,
  sourceGeneration,
}: {
  scope: InvestigationScope
  onScopeChange: (scope: InvestigationScope) => void
  sourceGeneration?: string
}) {
  const [history, setHistory] = useState<History | null>(null)
  const [evidence, setEvidence] = useState<Evidence | null>(null)
  const [outlook, setOutlook] = useState<Outlook | null>(null)
  const [year, setYear] = useState(Number(scope.range.end.slice(0, 4)))
  const [month, setMonth] = useState<number | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const query = scope.query
  const [previousQuery, setPreviousQuery] = useState(query)
  if (previousQuery !== query) {
    setPreviousQuery(query)
    setHistory(null)
    setEvidence(null)
    setOutlook(null)
    setErrors({})
  }
  useEffect(() => {
    const controller = new AbortController()
    const failed = (key: string) => (error: Error) => {
      if (!controller.signal.aborted) setErrors((current) => ({ ...current, [key]: error.message }))
    }
    investigationRequest<History>('history', query, {}, controller.signal).then((data) => {
      if (!controller.signal.aborted) {
        setHistory(data)
        if (data.evidence) setEvidence(data.evidence)
      }
    }, failed('history'))
    investigationRequest<Outlook>('outlook', query, {}, controller.signal).then((data) => {
      if (!controller.signal.aborted) setOutlook(data)
    }, failed('outlook'))
    return () => controller.abort()
  }, [query])
  useEffect(() => {
    if (!sourceGeneration) return
    const controller = new AbortController()
    investigationRequest<Evidence>('method', query, { sourceGeneration }, controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) {
          setEvidence(data)
          setErrors((current) => ({ ...current, method: '' }))
        }
      },
      (error: Error) => {
        if (!controller.signal.aborted)
          setErrors((current) => ({ ...current, method: error.message }))
      },
    )
    return () => controller.abort()
  }, [query, sourceGeneration])
  const years = [...new Set(history?.months?.map((item) => item.year) ?? [])]
  const maximum = Math.max(1, ...(history?.months?.map((item) => item.value ?? 0) ?? []))
  const daily =
    history?.daily?.filter(
      (day) =>
        Number(day.date.slice(0, 4)) === year &&
        (month == null || Number(day.date.slice(5, 7)) === month),
    ) ?? []
  const season = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    selected: history?.months?.find((item) => item.year === year && item.month === i + 1),
    baseline: history?.baseline?.months.find((item) => item.month === i + 1),
  }))
  // Leap day is retained in monthly totals, but excluded on both sides of seasonal comparisons.
  const seasonalValue = (index: number) => {
    if (season[index].selected?.value == null) return null
    const values =
      history?.daily.filter(
        (day) =>
          Number(day.date.slice(0, 4)) === year &&
          Number(day.date.slice(5, 7)) === index + 1 &&
          day.date.slice(5) !== '02-29',
      ) ?? []
    return values.length && values.every((day) => day.value != null && day.state === 'complete')
      ? values.reduce((sum, day) => sum + (day.value ?? 0), 0)
      : null
  }
  const seasonMax = Math.max(
    1,
    ...season.map((item, i) => Math.max(seasonalValue(i) ?? 0, item.baseline?.q75 ?? 0)),
  )
  return (
    <>
      <section className="investigation-section">
        <h2>Historical calendar and seasons</h2>
        {errors.history && <p role="alert">{errors.history}</p>}
        {!history && !errors.history && <p role="status">Loading stored history…</p>}
        {history?.status === 'unavailable' && (
          <p>
            {history.reason ??
              'Stored historical reporting coverage is unavailable for this region.'}
          </p>
        )}
        {history?.coverage && (
          <p className="area-analytics-footnote">
            Stored coverage: {history.coverage.start} – {history.coverage.endInclusive} ·{' '}
            {history.datasetVersion} · Imported {history.importedAt}
          </p>
        )}
        {!!years.length && (
          <>
            <div className="history-heatmap">
              <table>
                <caption>Monthly activity · active-cell-days</caption>
                <thead>
                  <tr>
                    <th>Year</th>
                    {Array.from({ length: 12 }, (_, i) => (
                      <th key={i}>{monthName(i + 1)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {years.map((item) => (
                    <tr key={item}>
                      <th>
                        <button
                          onClick={() => {
                            setYear(item)
                            setMonth(null)
                          }}
                        >
                          {item}
                        </button>
                      </th>
                      {Array.from({ length: 12 }, (_, i) => {
                        const cell = history?.months.find(
                          (m) => m.year === item && m.month === i + 1,
                        )
                        return (
                          <td key={i}>
                            <button
                              className="history-cell"
                              aria-pressed={year === item && month === i + 1}
                              data-missing={cell?.value == null}
                              style={
                                cell?.value == null
                                  ? undefined
                                  : {
                                      background: `color-mix(in srgb, var(--brand-accent) ${15 + (75 * cell.value) / maximum}%, var(--surface))`,
                                    }
                              }
                              onClick={() => {
                                setYear(item)
                                setMonth(i + 1)
                              }}
                              title={`${item}-${i + 1}: ${cell?.value ?? 'Unavailable'} active-cell-days; ${cell?.coveredDays ?? 0}/${cell?.expectedDays ?? '?'} covered days${cell?.state === 'partial' ? `; available partial sum ${cell.observedSum ?? 'unknown'}` : ''}`}
                            >
                              {cell?.value == null ? '—' : Math.round(cell.value).toLocaleString()}
                            </button>
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <h3>{year} seasonal comparison</h3>
            <p className="area-analytics-footnote">
              Selected year (solid), historical median (line), and interquartile range (band) ·
              active-cell-days · leap day excluded
            </p>
            <svg
              viewBox="0 0 720 180"
              className="history-season-chart"
              role="group"
              aria-label="Selected-year seasonal activity and historical baseline"
            >
              <text x="0" y="12">
                {Math.round(seasonMax)}
              </text>
              <text x="0" y="150">
                0
              </text>
              {season.map((item, i) => {
                const x = 48 + i * 55
                const observed = seasonalValue(i)
                const b = item.baseline
                const y = (v: number) => 150 - (v / seasonMax) * 130
                return (
                  <g
                    key={item.month}
                    role="button"
                    tabIndex={0}
                    aria-label={`${monthName(item.month)} ${year}, ${observed ?? 'Unavailable'} active-cell-days. Median ${b?.median ?? 'unavailable'}, typical ${b?.q25 ?? 'unavailable'} to ${b?.q75 ?? 'unavailable'}`}
                    onClick={() => setMonth(item.month)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        setMonth(item.month)
                      }
                    }}
                  >
                    <title>
                      {monthName(item.month)} · {observed ?? 'Unavailable'} ·{' '}
                      {b?.eligibleYears.length ?? 0} eligible historical years
                    </title>
                    {b?.q25 != null && b.q75 != null && (
                      <rect
                        x={x - 20}
                        y={y(b.q75)}
                        width={40}
                        height={Math.max(1, y(b.q25) - y(b.q75))}
                        fill="#7e70bf"
                        opacity="0.25"
                      />
                    )}
                    {observed != null && (
                      <rect
                        x={x - 10}
                        y={y(observed)}
                        width="20"
                        height={Math.max(1, 150 - y(observed))}
                        fill="var(--brand-accent)"
                      />
                    )}
                    {b?.median != null && (
                      <line
                        x1={x - 20}
                        x2={x + 20}
                        y1={y(b.median)}
                        y2={y(b.median)}
                        stroke="#7e70bf"
                        strokeWidth="3"
                      />
                    )}
                    <text x={x} y="173" textAnchor="middle">
                      {monthName(item.month)}
                    </text>
                    <rect x={x - 25} y="15" width="50" height="150" fill="transparent" />
                  </g>
                )
              })}
            </svg>
            <h3>
              Daily detail · {year}
              {month ? `-${String(month).padStart(2, '0')}` : ''}
            </h3>
            <div className="history-daily">
              {daily.map((day) => (
                <button
                  key={day.date}
                  disabled={day.value == null}
                  title={`${day.date} UTC · ${day.value ?? 'Unavailable'} harmonized active cells · ${day.coverage}`}
                  onClick={() =>
                    onScopeChange({
                      ...createInvestigation(
                        scope.area,
                        { start: day.date, end: day.date },
                        scope.metadata,
                      ),
                      focusedDay: day.date,
                    })
                  }
                >
                  {day.date.slice(5)}
                  <strong>{day.value == null ? '—' : Math.round(day.value)}</strong>
                </button>
              ))}
            </div>
          </>
        )}
        {history?.comparison && (
          <p>
            Selected-period activity: {history.comparison.observedValue ?? 'unavailable'}{' '}
            active-cell-days. Historical median: {history.comparison.median ?? 'unavailable'}.
            Difference: {history.comparison.difference ?? 'unavailable'}. Eligible years:{' '}
            {history.comparison.eligibleYears?.join(', ') || 'none'}. Coverage:{' '}
            {history.comparison.coveredDays}/{history.comparison.expectedDays} days.
          </p>
        )}
        {history?.baseline && (
          <details>
            <summary>Baseline coverage and comparison rules</summary>
            <p>
              Years: {history.baseline.years.join(', ')}. Minimum {history.baseline.minimumYears}{' '}
              years. Typical range: {history.baseline.typicalRange}.{' '}
              {history.baseline.requiredCoverage}. {history.baseline.partialPeriodPolicy}.{' '}
              {history.baseline.leapDayPolicy}.
            </p>
          </details>
        )}
      </section>
      <section className="investigation-section">
        <details>
          <summary>Scientific method and overlap evidence</summary>
          {errors.method && !evidence && <p role="alert">{errors.method}</p>}
          {evidence && (
            <>
              <h3>{evidence.name}</h3>
              <dl className="investigation-evidence">
                {Object.entries({
                  Method: evidence.methodVersion,
                  'Afternoon platforms': evidence.platforms?.join(', '),
                  'Equal-area grid (m)': evidence.gridSizeM,
                  'Calibration period': evidence.calibrationPeriod,
                  'Usable overlap days': evidence.usableOverlapDays,
                  'Fitted scale': evidence.fittedScale,
                  'Calibration-fit agreement': evidence.agreement,
                  'Independent validation': evidence.independentValidation ?? 'Unavailable',
                  'Coverage restrictions': evidence.coverageRestriction,
                }).map(([key, item]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>{renderValue(item)}</dd>
                  </div>
                ))}
              </dl>
              <p className="area-analytics-footnote">
                Calibration-fit agreement does not establish independent fire detection accuracy.
              </p>
              <div className="investigation-table">
                <table>
                  <caption>Aqua / VIIRS on the common 2 km cell basis</caption>
                  <thead>
                    <tr>
                      <th>UTC day</th>
                      <th>Aqua cells</th>
                      <th>VIIRS cells</th>
                      <th>Scaled Aqua</th>
                      <th>Shared cells</th>
                    </tr>
                  </thead>
                  <tbody>
                    {evidence.overlap?.map((row) => (
                      <tr key={row.date}>
                        <td>{row.date}</td>
                        <td>{row.aquaCells}</td>
                        <td>{row.viirsCells}</td>
                        <td>{row.scaledAquaCells ?? '—'}</td>
                        <td>{row.commonCells}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </details>
      </section>
      <section className="investigation-section">
        <h2>Experimental outlook</h2>
        {errors.outlook && <p role="alert">{errors.outlook}</p>}
        {outlook ? (
          <>
            <strong>{outlook.state.replaceAll('-', ' ')}</strong>
            <p>
              {outlook.target} · {outlook.horizonHours} hours
            </p>
            <p>{outlook.reason}</p>
            <dl className="investigation-evidence">
              {Object.entries({
                'Model version': outlook.modelVersion,
                'Display grid (m)': outlook.gridSizeM,
                'Effective input resolution': outlook.effectiveInputResolution,
                'Issued UTC': outlook.issueTime,
                'Valid from UTC': outlook.validStart,
                'Valid until UTC': outlook.validEnd,
                'Input freshness': outlook.inputFreshness,
                'Supported domain': outlook.domain,
              }).map(([key, item]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{renderValue(item)}</dd>
                </div>
              ))}
            </dl>
            {outlook.evaluation != null && (
              <details>
                <summary>Held-out evaluation and validation status</summary>
                <pre>{JSON.stringify(outlook.evaluation, null, 2)}</pre>
              </details>
            )}
          </>
        ) : (
          !errors.outlook && <p role="status">Loading outlook status…</p>
        )}
      </section>
    </>
  )
}
