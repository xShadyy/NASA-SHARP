import type { AreaGeometry } from '@/lib/analysis-area'
import {
  analysisQuery,
  eachUtcDay,
  monthSpan,
  rangeQuery,
  MAX_ANALYSIS_DAYS,
  historicalUtcDays,
  type AnalysisRange,
  type ActivityStats,
  type CalendarDay,
  type SeriesPoint,
} from '@/lib/analysis-activity'
import { fireMapFeatures, type FireFeature } from '@/lib/fire-severity'

const API = '/firms-api'

export type MonthActivity = {
  summaryOnly?: boolean
  month: string
  start: string
  end: string
  days: CalendarDay[]
  series: SeriesPoint[]
  medianFrp: number | null
  completeness: string
  stats?: ActivityStats
  dailyStats?: Record<string, ActivityStats>
}

export type AnalysisMetadata = {
  summaryOnly?: boolean
  sourceGeneration?: string
  queryId?: string
  datasetVersion?: string
  methodVersion?: string
  completeness?: string
  coverage?: string
  generatedAt?: string
  fetchedAt?: string
  expiresAt?: string
  newestObservationAt?: string | null
  freshness?: string
  updatedAt?: string
}

export type AnalysisActivityData = MonthActivity & {
  range: AnalysisRange
  areaName: string
}

export type AnalysisSelectionData = {
  features: FireFeature[]
  activity: AnalysisActivityData
  meta: AnalysisMetadata
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
    stats: overviewStats(overview),
    dailyStats: overviewDailyStats(overview),
    completeness: completeness(calendar),
  }
}

export async function fetchRangeActivity(
  areaId: string,
  geometry: AreaGeometry,
  range: AnalysisRange,
  signal: AbortSignal,
): Promise<MonthActivity> {
  const query = rangeQuery(areaId, geometry, range)
  const [calendar, overview, series] = await Promise.all([
    postAnalysis('/analysis/calendar', query, signal),
    postAnalysis('/analysis/overview', query, signal),
    postAnalysis('/analysis/time-series', query, signal),
  ])
  return {
    month: range.start.slice(0, 7),
    start: range.start,
    end: range.end,
    days: calendarDays(calendar),
    series: seriesPoints(series),
    medianFrp: medianFrp(overview),
    stats: overviewStats(overview),
    dailyStats: overviewDailyStats(overview),
    completeness: completeness(calendar),
  }
}

export async function fetchAnalysisSelection(
  areaId: string,
  areaName: string,
  geometry: AreaGeometry,
  range: AnalysisRange,
  signal: AbortSignal,
): Promise<AnalysisSelectionData> {
  const query = rangeQuery(areaId, geometry, range)
  if ((Date.parse(range.end) - Date.parse(range.start)) / 86_400_000 + 1 > MAX_ANALYSIS_DAYS) {
    const history = record(
      await postAnalysis('/analysis/history', query, signal),
      'Historical activity',
    )
    const rows = Array.isArray(history.daily) ? history.daily : []
    const byDay = new Map(
      rows.map((item) => {
        const day = record(item, 'Historical day')
        return [String(day.date), day]
      }),
    )
    const days = historicalUtcDays(range.start, range.end).map((date) => {
      const day = byDay.get(date)
      return {
        date,
        count: typeof day?.value === 'number' ? day.value : null,
        state: typeof day?.state === 'string' ? day.state : 'unavailable',
        coverage: typeof day?.coverage === 'string' ? day.coverage : 'No stored reporting coverage',
      }
    })
    const completeness = days.every((day) => day.count == null)
      ? 'unavailable'
      : days.some((day) => day.state !== 'complete' || day.count == null)
        ? 'partial'
        : 'complete'
    const unknown = { detections: null, daysWithDetections: null, peakDate: null, medianFrp: null }
    return {
      features: [],
      activity: {
        month: range.start.slice(0, 7),
        start: range.start,
        end: range.end,
        days,
        series: [],
        medianFrp: null,
        stats: unknown,
        dailyStats: {},
        completeness,
        range,
        areaName,
        summaryOnly: true,
      },
      meta: {
        summaryOnly: true,
        completeness,
        coverage:
          typeof history.reason === 'string'
            ? history.reason
            : 'Stored daily harmonized activity. Select a date to inspect its satellite observations.',
        datasetVersion:
          typeof history.datasetVersion === 'string' ? history.datasetVersion : undefined,
        methodVersion:
          typeof history.methodVersion === 'string' ? history.methodVersion : undefined,
      },
    }
  }
  const [map, activity] = await Promise.all([
    postAnalysis('/analysis/map-source', query, signal),
    fetchRangeActivity(areaId, geometry, range, signal),
  ])
  const body = record(map, 'The fire map')
  const features = fireMapFeatures(map)
  const missingDailyStats = eachUtcDay(activity.start, activity.end).some(
    (day) => !activity.dailyStats?.[day],
  )
  return {
    features,
    activity: {
      ...activity,
      dailyStats: missingDailyStats
        ? { ...cachedDailyStats(activity, features), ...activity.dailyStats }
        : activity.dailyStats,
      range,
      areaName,
    },
    meta: body.meta && typeof body.meta === 'object' ? (body.meta as AnalysisMetadata) : {},
  }
}

export async function fetchAnalysisMap(
  areaId: string,
  geometry: AreaGeometry,
  range: AnalysisRange,
  signal: AbortSignal,
) {
  const body = record(
    await postAnalysis('/analysis/map-source', rangeQuery(areaId, geometry, range), signal),
    'The fire map',
  )
  return { features: fireMapFeatures(body), meta: body.meta as AnalysisMetadata | undefined }
}

export function analysisSelectionKey(areaId: string, geometry: AreaGeometry, range: AnalysisRange) {
  return [
    'analysis-selection',
    areaId,
    JSON.stringify(rangeQuery(areaId, geometry, range)),
  ] as const
}

export function selectedActivityStats(activity: AnalysisActivityData | null, day: string | null) {
  if (!activity) return null
  if (!day) return activity.stats ?? null
  return activity.dailyStats?.[day] ?? cachedDailyStats(activity)[day] ?? null
}

function cachedDailyStats(
  activity: MonthActivity,
  features: FireFeature[] = [],
): Record<string, ActivityStats> {
  const seriesByDay = new Map<string, SeriesPoint[]>()
  for (const point of activity.series) {
    if (point.endDate !== point.date) continue
    const points = seriesByDay.get(point.date) ?? []
    points.push(point)
    seriesByDay.set(point.date, points)
  }
  const observationsByDay = new Map<string, { count: number; frp: number[] }>()
  for (const feature of features) {
    const instant = Date.parse(feature.properties.acquiredAt)
    if (!Number.isFinite(instant)) continue
    const day = new Date(instant).toISOString().slice(0, 10)
    const observations = observationsByDay.get(day) ?? { count: 0, frp: [] }
    observations.count += 1
    const power = feature.properties.frpMw
    if (typeof power === 'number' && Number.isFinite(power) && power >= 0)
      observations.frp.push(power)
    observationsByDay.set(day, observations)
  }
  return Object.fromEntries(
    eachUtcDay(activity.start, activity.end).map((day) => {
      const measured = (seriesByDay.get(day) ?? []).filter((point) => point.state !== 'unavailable')
      if (!measured.length)
        return [
          day,
          {
            detections: null,
            daysWithDetections: null,
            peakDate: null,
            medianFrp: null,
          } satisfies ActivityStats,
        ]
      const detections = measured.reduce((count, point) => count + point.count, 0)
      const observations = observationsByDay.get(day)
      const powers =
        observations?.count === detections ? observations.frp.sort((a, b) => a - b) : []
      const middle = Math.floor(powers.length / 2)
      const medianFrp = !powers.length
        ? null
        : powers.length % 2
          ? powers[middle]
          : (powers[middle - 1] + powers[middle]) / 2
      return [
        day,
        {
          detections,
          daysWithDetections: detections > 0 ? 1 : 0,
          peakDate: detections > 0 ? day : null,
          medianFrp,
        } satisfies ActivityStats,
      ]
    }),
  )
}

export async function fetchAnalysisFires(
  areaId: string,
  geometry: AreaGeometry,
  range: AnalysisRange,
  signal: AbortSignal,
): Promise<FireFeature[]> {
  const query = rangeQuery(areaId, geometry, range)
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
    throw new Error('The analysis service is not running.', { cause: error })
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

function overviewStats(body: unknown): ActivityStats {
  const data = record(record(body, 'The activity summary').data, 'The activity summary')
  const value = (name: string) => record(data[name], name).value
  return {
    detections:
      typeof value('detectionCount') === 'number' ? (value('detectionCount') as number) : null,
    daysWithDetections:
      typeof value('daysWithDetections') === 'number'
        ? (value('daysWithDetections') as number)
        : null,
    peakDate: typeof value('peakDate') === 'string' ? (value('peakDate') as string) : null,
    medianFrp: typeof value('medianFrp') === 'number' ? (value('medianFrp') as number) : null,
  }
}

function overviewDailyStats(body: unknown): Record<string, ActivityStats> {
  const data = record(record(body, 'The activity summary').data, 'The activity summary')
  if (!Array.isArray(data.daily)) return {}
  return Object.fromEntries(
    data.daily.map((item) => {
      const day = record(item, 'Daily activity summary')
      if (typeof day.date !== 'string') throw new Error('A daily summary has no date.')
      return [
        day.date,
        {
          detections: typeof day.detectionCount === 'number' ? day.detectionCount : null,
          daysWithDetections:
            typeof day.daysWithDetections === 'number' ? day.daysWithDetections : null,
          peakDate: typeof day.peakDate === 'string' ? day.peakDate : null,
          medianFrp: typeof day.medianFrp === 'number' ? day.medianFrp : null,
        },
      ]
    }),
  )
}
