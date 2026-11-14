import type { AreaGeometry } from '@/lib/analysis-area'
import {
  addUtcDays,
  analysisQuery,
  monthSpan,
  type CalendarDay,
  type SeriesPoint,
} from '@/lib/analysis-activity'
import { fireMapFeatures, type FireFeature } from '@/lib/fire-severity'

const API = '/firms-api'

export type MonthActivity = {
  month: string
  start: string
  end: string
  days: CalendarDay[]
  series: SeriesPoint[]
  medianFrp: number | null
  completeness: string
}

export async function fetchMonthActivity(
  areaId: string,
  geometry: AreaGeometry,
  month: string,
  signal: AbortSignal,
): Promise<MonthActivity> {
  const { start, end, endExclusive } = monthSpan(month)
  const query = analysisQuery(areaId, geometry, start, endExclusive)
  const [calendar, overview, series] = await Promise.all([
    postAnalysis('/analysis/calendar', query, signal),
    postAnalysis('/analysis/overview', query, signal),
    postAnalysis('/analysis/time-series', query, signal),
  ])
  return {
    month,
    start,
    end,
    days: calendarDays(calendar),
    series: seriesPoints(series),
    medianFrp: medianFrp(overview),
    completeness: completeness(calendar),
  }
}

export async function fetchAnalysisFires(
  areaId: string,
  geometry: AreaGeometry,
  start: string,
  end: string,
  signal: AbortSignal,
): Promise<FireFeature[]> {
  const query = analysisQuery(areaId, geometry, start, addUtcDays(end, 1))
  return fireMapFeatures(await postAnalysis('/analysis/map-source', query, signal))
}

async function postAnalysis(path: string, query: unknown, signal: AbortSignal) {
  let response: Response
  try {
    response = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      signal,
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new Error('The analysis service is not running.')
  }
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) throw new Error(messageFrom(body, response.status))
  return body
}

function messageFrom(body: unknown, status: number) {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>
    if (typeof record.message === 'string' && record.message) return record.message
    if (typeof record.detail === 'string' && record.detail) return record.detail
  }
  if (status === 503) return 'Set FIRMS_MAP_KEY before using FIRMS routes.'
  return `Analysis request failed (${status}).`
}

function record(body: unknown, label: string) {
  if (!body || typeof body !== 'object') throw new Error(`${label} was not returned.`)
  return body as Record<string, unknown>
}

function calendarDays(body: unknown): CalendarDay[] {
  const data = record(body, 'The activity calendar').data
  if (!Array.isArray(data)) throw new Error('The activity calendar was not returned.')
  return data.map((item) => {
    const day = record(item, 'An activity day')
    if (typeof day.date !== 'string') throw new Error('An activity day has no date.')
    return {
      date: day.date,
      count: typeof day.count === 'number' ? day.count : null,
      state: typeof day.state === 'string' ? day.state : 'unavailable',
      coverage: typeof day.coverage === 'string' ? day.coverage : '',
    }
  })
}

function seriesPoints(body: unknown): SeriesPoint[] {
  const data = record(body, 'The activity trend').data
  if (!Array.isArray(data)) throw new Error('The activity trend was not returned.')
  return data.map((item) => {
    const point = record(item, 'A trend point')
    if (typeof point.date !== 'string' || typeof point.platform !== 'string')
      throw new Error('A trend point is missing its date or platform.')
    return {
      date: point.date,
      endDate: typeof point.endDate === 'string' ? point.endDate : point.date,
      count: typeof point.count === 'number' ? point.count : 0,
      platform: point.platform,
      state: typeof point.state === 'string' ? point.state : 'unavailable',
    }
  })
}

function medianFrp(body: unknown) {
  const data = record(record(body, 'The activity summary').data, 'The activity summary')
  const metric = record(data.medianFrp, 'Median FRP')
  return typeof metric.value === 'number' ? metric.value : null
}

function completeness(body: unknown) {
  const meta = record(body, 'The activity calendar').meta
  const value = record(meta, 'The activity calendar').completeness
  return typeof value === 'string' ? value : 'unavailable'
}
