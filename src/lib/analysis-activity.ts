import type { AreaBounds, AreaGeometry } from '@/lib/analysis-area'

export const MODIS_START_DAY = '2000-11-01'
export const VIIRS_START_DAY = '2012-01-20'
export const MAX_ANALYSIS_DAYS = 31
export const MAX_HISTORICAL_DAYS = 36_600
export function customAnalysisRange(first: string, second: string): AnalysisRange {
  const start = first < second ? first : second
  const end = first < second ? second : first
  const duration = (Date.parse(end) - Date.parse(start)) / 86_400_000 + 1
  if (!Number.isInteger(duration) || duration < 1 || duration > MAX_HISTORICAL_DAYS)
    throw new Error('Select a valid UTC interval shorter than 100 years.')
  return { start, end }
}
export const ANALYSIS_PLATFORMS = ['aqua', 'suomi-npp', 'noaa-20', 'noaa-21'] as const

const DAY_MS = 86_400_000

export type AnalysisRange = {
  start: string
  end: string
  startAt?: string
  endAt?: string
  preset?: '24h' | '7d' | 'month'
}

export type CalendarDay = {
  date: string
  count: number | null
  state: string
  coverage: string
}

export type SeriesPoint = {
  date: string
  endDate: string
  count: number
  platform: string
  state: string
}

export type ActivityStats = {
  detections: number | null
  daysWithDetections: number | null
  peakDate: string | null
  medianFrp: number | null
}

export function utcToday(now = new Date()) {
  return now.toISOString().slice(0, 10)
}

export function utcDayToPickerDate(day: string) {
  const [year, month, date] = day.split('-').map(Number)
  return new Date(year, month - 1, date)
}

export function pickerDateToUtcDay(date: Date) {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

export function utcMidnight(day: string) {
  const [year, month, date] = day.split('-').map(Number)
  return Date.UTC(year, month - 1, date)
}

export function addUtcDays(day: string, amount: number) {
  return new Date(utcMidnight(day) + amount * DAY_MS).toISOString().slice(0, 10)
}

export function formatUtcDay(day: string) {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(utcMidnight(day)))
}

export function formatUtcRange(range: AnalysisRange) {
  if (range.start === range.end) return formatUtcDay(range.start)
  if (range.start.slice(0, 7) === range.end.slice(0, 7))
    return `${Number(range.start.slice(8))}-${formatUtcDay(range.end)}`
  return `${formatUtcDay(range.start)} - ${formatUtcDay(range.end)}`
}

export function monthSpan(month: string) {
  const match = /^(\d{4})-(\d{2})$/.exec(month)
  const monthNumber = match ? Number(match[2]) : 0
  if (!match || monthNumber < 1 || monthNumber > 12) throw new Error('Month must be YYYY-MM.')
  const start = `${match[1]}-${match[2]}-01`
  const endExclusive = new Date(Date.UTC(Number(match[1]), monthNumber, 1))
    .toISOString()
    .slice(0, 10)
  return { start, end: addUtcDays(endExclusive, -1), endExclusive }
}

export function shiftMonth(month: string, amount: number) {
  const { start } = monthSpan(month)
  const [year, monthNumber] = start.split('-').map(Number)
  const shifted = new Date(Date.UTC(year, monthNumber - 1 + amount, 1))
  return shifted.toISOString().slice(0, 7)
}

export function calendarWeeks(month: string) {
  const { start, end } = monthSpan(month)
  const leading = new Date(utcMidnight(start)).getUTCDay()
  let cursor = addUtcDays(start, -leading)
  const weeks: string[][] = []
  do {
    const week: string[] = []
    for (let index = 0; index < 7; index += 1) {
      week.push(cursor)
      cursor = addUtcDays(cursor, 1)
    }
    weeks.push(week)
  } while (cursor <= end && weeks.length < 6)
  return weeks
}

export function clampRange(anchor: string, focus: string): AnalysisRange {
  const span = Math.round((utcMidnight(focus) - utcMidnight(anchor)) / DAY_MS)
  const limited = Math.max(-(MAX_ANALYSIS_DAYS - 1), Math.min(MAX_ANALYSIS_DAYS - 1, span))
  const other = addUtcDays(anchor, limited)
  return anchor <= other ? { start: anchor, end: other } : { start: other, end: anchor }
}

export function historicalUtcDays(start: string, end: string) {
  const range = customAnalysisRange(start, end)
  const days: string[] = []
  for (let day = range.start; day <= range.end; day = addUtcDays(day, 1)) days.push(day)
  return days
}

export function eachUtcDay(start: string, end: string) {
  const days: string[] = []
  let cursor = start
  while (cursor <= end && days.length < MAX_ANALYSIS_DAYS) {
    days.push(cursor)
    cursor = addUtcDays(cursor, 1)
  }
  return days
}

export function rangePreset(preset: '24h' | '7d' | 'month', now = new Date()): AnalysisRange {
  const end = utcToday(now)
  if (preset === '24h') {
    const startAt = new Date(now.getTime() - DAY_MS).toISOString()
    return {
      start: startAt.slice(0, 10),
      end: new Date(now.getTime() - 1).toISOString().slice(0, 10),
      startAt,
      endAt: now.toISOString(),
      preset,
    }
  }
  const days = preset === '7d' ? 7 : Number(monthSpan(end.slice(0, 7)).end.slice(8))
  return { start: addUtcDays(end, 1 - days), end, preset }
}

export function rangeQuery(areaId: string, geometry: AreaGeometry, range: AnalysisRange) {
  const query = analysisQuery(areaId, geometry, range.start, addUtcDays(range.end, 1))
  query.interval = {
    start: range.startAt ?? query.interval.start,
    endExclusive: range.endAt ?? query.interval.endExclusive,
  }
  query.id = [query.id, query.interval.start, query.interval.endExclusive].join(':')
  return query
}

export function focusRange(range: AnalysisRange, day: string | null): AnalysisRange {
  if (!day || day < range.start || day > range.end) return range
  return {
    start: day,
    end: day,
    startAt: day === range.start ? range.startAt : undefined,
    endAt: day === range.end ? range.endAt : undefined,
  }
}

export function crossesDateline(bounds: AreaBounds) {
  return bounds[1][0] > 180
}

export function analysisQuery(
  areaId: string,
  geometry: AreaGeometry,
  start: string,
  endExclusive: string,
) {
  return {
    id: `activity:${areaId}:${start}:${endExclusive}`,
    processingMode: 'harmonized' as const,
    aoi: { geometry },
    interval: {
      start: `${start}T00:00:00.000Z`,
      endExclusive: `${endExclusive}T00:00:00.000Z`,
    },
    resolution: 'daily' as const,
    filters: {
      platforms: [...ANALYSIS_PLATFORMS],
      dayNight: 'all' as const,
      modisConfidenceMin: 0,
      viirsConfidence: ['low', 'nominal', 'high'],
    },
  }
}

export function activityStats(
  series: SeriesPoint[],
  selection: AnalysisRange,
  medianFrp: number | null,
  medianMatchesSelection: boolean,
): ActivityStats {
  const byDay = new Map<string, SeriesPoint[]>()
  for (const point of series) {
    const list = byDay.get(point.date)
    if (list) list.push(point)
    else byDay.set(point.date, [point])
  }
  let detections = 0
  let daysWithDetections = 0
  let peakDate: string | null = null
  let peakCount = -1
  let known = false
  for (const day of eachUtcDay(selection.start, selection.end)) {
    const points = byDay.get(day)
    if (!points?.length)
      return { detections: null, daysWithDetections: null, peakDate: null, medianFrp: null }
    const measured = points.filter((point) => point.state !== 'unavailable')
    if (!measured.length) continue
    known = true
    const count = measured.reduce((total, point) => total + point.count, 0)
    detections += count
    if (count > 0) daysWithDetections += 1
    if (count > peakCount) {
      peakCount = count
      peakDate = day
    }
  }
  if (!known) return { detections: null, daysWithDetections: null, peakDate: null, medianFrp: null }
  return {
    detections,
    daysWithDetections,
    peakDate,
    medianFrp: medianMatchesSelection ? medianFrp : null,
  }
}

export function heatLevel(count: number | null, max: number) {
  if (count === null) return null
  if (count <= 0 || max <= 0) return 0
  const ratio = count / max
  if (ratio > 0.75) return 4
  if (ratio > 0.5) return 3
  if (ratio > 0.25) return 2
  return 1
}
