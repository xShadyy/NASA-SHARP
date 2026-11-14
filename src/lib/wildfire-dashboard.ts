export type HotspotDetection = {
  type: 'Feature'
  geometry: { type: 'Point'; coordinates: [number, number] }
  properties: {
    source: string
    sensor: 'MODIS' | 'VIIRS'
    satellite: string
    processing: string
    acquired_at: string
    confidence: number | 'l' | 'n' | 'h'
    confidence_scale: string
    confidence_class: string | null
    frp_mw: number | null
    brightness_k: number | null
    daynight: string | null
  }
}

export type HotspotResponse = {
  type: 'FeatureCollection'
  features: HotspotDetection[]
  count: number
  partial: boolean
  sources: Array<{
    source: string
    status: 'ok' | 'partial' | 'error'
    count: number
    successful_days: number
    oldest_fetched_at: string | null
    failed_days: Array<{ date: string; detail: string }>
  }>
  window: {
    start_utc: string
    end_utc_exclusive: string
    timezone: string
  }
  summary: HotspotSummary
}

export type DailyActivity = { date: string; count: number }
export type CountBucket = { label: string; count: number }
export type DetectionCell = { label: string; count: number; longitude: number; latitude: number }
export type HotspotSummary = {
  daily: DailyActivity[]
  products: CountBucket[]
  daynight: CountBucket[]
  confidence: CountBucket[]
  frp: CountBucket[]
  frpReported: number
  medianFrp: number | null
  hourly: Array<{ hour: number; count: number }>
  topCells: DetectionCell[]
  latest: HotspotDetection | null
  highestFrp: HotspotDetection | null
}

export function utcDateString(date: Date) {
  return date.toISOString().slice(0, 10)
}

export function shiftUtcDate(date: string, days: number) {
  const [year, month, day] = date.split('-').map(Number)
  return utcDateString(new Date(Date.UTC(year, month - 1, day + days)))
}

export function getDashboardWindows(days: number, today = utcDateString(new Date())) {
  if (!Number.isInteger(days) || days < 1 || days > 30)
    throw new RangeError('Dashboard interval must be between 1 and 30 days.')
  const currentStart = shiftUtcDate(today, 1 - days)
  const previousStart = shiftUtcDate(currentStart, -days)
  return { currentStart, previousStart, endDate: today }
}

export function aggregateDailyActivity(
  features: HotspotDetection[],
  startDate: string,
  days: number,
): DailyActivity[] {
  const counts = new Map<string, number>()
  for (let offset = 0; offset < days; offset++) counts.set(shiftUtcDate(startDate, offset), 0)
  for (const feature of features) {
    const date = feature.properties.acquired_at.slice(0, 10)
    if (counts.has(date)) counts.set(date, counts.get(date)! + 1)
  }
  return [...counts].map(([date, count]) => ({ date, count }))
}

export function peakActivity(days: DailyActivity[]) {
  const peak = days.reduce<DailyActivity | null>(
    (current, day) => (day.count > (current?.count ?? 0) ? day : current),
    null,
  )
  return peak
}

export function countBy(
  features: HotspotDetection[],
  getLabel: (feature: HotspotDetection) => string,
): CountBucket[] {
  const counts = new Map<string, number>()
  for (const feature of features) {
    const label = getLabel(feature)
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  return [...counts].map(([label, count]) => ({ label, count }))
}

export function aggregateHourlyActivity(features: HotspotDetection[]) {
  const counts = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }))
  for (const feature of features) {
    const timestamp = Date.parse(feature.properties.acquired_at)
    if (!Number.isFinite(timestamp)) continue
    counts[new Date(timestamp).getUTCHours()].count++
  }
  return counts
}

export function confidenceBuckets(features: HotspotDetection[]) {
  const counts = new Map<string, number>()
  for (const feature of features) {
    const { sensor, confidence } = feature.properties
    let label: string
    if (sensor === 'VIIRS') {
      label = typeof confidence === 'string' ? `VIIRS ${confidence.toUpperCase()}` : 'VIIRS unknown'
    } else if (typeof confidence === 'number') {
      label = confidence >= 80 ? 'MODIS 80–100' : confidence >= 30 ? 'MODIS 30–79' : 'MODIS 0–29'
    } else {
      label = 'MODIS unknown'
    }
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  const order = [
    'VIIRS H',
    'VIIRS N',
    'VIIRS L',
    'VIIRS unknown',
    'MODIS 80–100',
    'MODIS 30–79',
    'MODIS 0–29',
    'MODIS unknown',
  ]
  return order
    .filter((label) => counts.has(label))
    .map((label) => ({ label, count: counts.get(label)! }))
}

export function frpBuckets(features: HotspotDetection[]) {
  const ranges = [
    { label: '0–10 MW', min: 0, max: 10 },
    { label: '10–50 MW', min: 10, max: 50 },
    { label: '50–100 MW', min: 50, max: 100 },
    { label: '100+ MW', min: 100, max: Infinity },
  ]
  const counts = ranges.map(({ label }) => ({ label, count: 0 }))
  let unavailable = 0
  for (const { properties } of features) {
    const frp = properties.frp_mw
    if (frp === null || !Number.isFinite(frp) || frp < 0) {
      unavailable++
      continue
    }
    const index = ranges.findIndex(({ min, max }) => frp >= min && frp < max)
    if (index >= 0) counts[index].count++
  }
  return unavailable ? [...counts, { label: 'Not reported', count: unavailable }] : counts
}

export function medianFrp(features: HotspotDetection[]) {
  const values = features
    .map(({ properties }) => properties.frp_mw)
    .filter((value): value is number => value !== null && Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b)
  if (!values.length) return null
  const middle = Math.floor(values.length / 2)
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2
}

export function highestFrp(features: HotspotDetection[]) {
  return features.reduce<HotspotDetection | null>((highest, feature) => {
    const frp = feature.properties.frp_mw
    return frp !== null &&
      Number.isFinite(frp) &&
      frp >= 0 &&
      frp > (highest?.properties.frp_mw ?? -1)
      ? feature
      : highest
  }, null)
}

export function latestDetection(features: HotspotDetection[]) {
  return features.reduce<HotspotDetection | null>(
    (latest, feature) =>
      !latest || feature.properties.acquired_at > latest.properties.acquired_at ? feature : latest,
    null,
  )
}

export function topDetectionCells(
  features: HotspotDetection[],
  cellSize = 2,
  limit = 8,
): DetectionCell[] {
  if (!Number.isFinite(cellSize) || cellSize <= 0 || cellSize > 180)
    throw new RangeError('Grid cell size must be greater than 0 and no more than 180 degrees.')
  if (!Number.isInteger(limit) || limit < 1)
    throw new RangeError('Cell limit must be a positive integer.')
  const cells = new Map<string, DetectionCell>()
  const latitudeCellCount = Math.ceil(180 / cellSize)
  const longitudeCellCount = Math.ceil(360 / cellSize)
  for (const feature of features) {
    const [longitude, latitude] = feature.geometry.coordinates
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) continue
    const x = Math.min(longitudeCellCount - 1, Math.floor((longitude + 180) / cellSize))
    const y = Math.min(latitudeCellCount - 1, Math.floor((latitude + 90) / cellSize))
    const key = `${x}:${y}`
    const cell = cells.get(key)
    if (cell) {
      cell.count++
      continue
    }
    const west = -180 + x * cellSize
    const south = -90 + y * cellSize
    const centerLongitude = Number((west + Math.min(cellSize, 180 - west) / 2).toFixed(2))
    const centerLatitude = Number((south + Math.min(cellSize, 90 - south) / 2).toFixed(2))
    cells.set(key, {
      label: `${centerLatitude.toFixed(2)}°, ${centerLongitude.toFixed(2)}°`,
      count: 1,
      longitude: centerLongitude,
      latitude: centerLatitude,
    })
  }
  return [...cells.values()].sort((left, right) => right.count - left.count).slice(0, limit)
}

export function filterDetections(
  features: HotspotDetection[],
  sensor: 'all' | 'MODIS' | 'VIIRS',
  daynight: 'all' | 'day' | 'night',
) {
  return features.filter(({ properties }) => {
    if (sensor !== 'all' && properties.sensor !== sensor) return false
    if (daynight === 'day' && properties.daynight !== 'D') return false
    if (daynight === 'night' && properties.daynight !== 'N') return false
    return true
  })
}

export function compareActivity(current: number, previous: number) {
  const difference = current - previous
  return {
    difference,
    percentage: previous === 0 ? null : (difference / previous) * 100,
  }
}

function csvCell(value: string | number | null | undefined) {
  const text = value == null ? '' : String(value)
  return `"${text.replaceAll('"', '""')}"`
}

export function detectionsToCsv(features: HotspotDetection[]) {
  const rows = [
    [
      'acquired_at_utc',
      'longitude',
      'latitude',
      'sensor',
      'satellite',
      'product',
      'processing',
      'confidence',
      'confidence_scale',
      'confidence_class',
      'frp_mw',
      'brightness_k',
      'daynight',
    ],
    ...features.map((feature) => {
      const properties = feature.properties
      const [longitude, latitude] = feature.geometry.coordinates
      return [
        properties.acquired_at,
        longitude,
        latitude,
        properties.sensor,
        properties.satellite,
        properties.source,
        properties.processing,
        properties.confidence,
        properties.confidence_scale,
        properties.confidence_class,
        properties.frp_mw,
        properties.brightness_k,
        properties.daynight,
      ]
    }),
  ]
  const [header, ...data] = rows
  return `${header.join(',')}\r\n${data.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`
}

function isHotspotDetection(value: unknown): value is HotspotDetection {
  if (!value || typeof value !== 'object') return false
  const feature = value as Partial<HotspotDetection>
  return (
    feature.type === 'Feature' &&
    feature.geometry?.type === 'Point' &&
    Array.isArray(feature.geometry.coordinates) &&
    feature.geometry.coordinates.length === 2 &&
    feature.geometry.coordinates.every(Number.isFinite) &&
    typeof feature.properties?.acquired_at === 'string' &&
    typeof feature.properties?.sensor === 'string' &&
    typeof feature.properties?.source === 'string'
  )
}

function isCountBucket(value: unknown): value is CountBucket {
  if (!value || typeof value !== 'object') return false
  const bucket = value as Partial<CountBucket>
  return typeof bucket.label === 'string' && typeof bucket.count === 'number'
}

export function isHotspotResponse(value: unknown): value is HotspotResponse {
  if (!value || typeof value !== 'object') return false
  const response = value as Partial<HotspotResponse>
  const summary = response.summary
  return (
    response.type === 'FeatureCollection' &&
    Array.isArray(response.features) &&
    response.features.every(isHotspotDetection) &&
    typeof response.count === 'number' &&
    typeof response.partial === 'boolean' &&
    Array.isArray(response.sources) &&
    summary !== undefined &&
    Array.isArray(summary.daily) &&
    summary.daily.every((day) => typeof day?.date === 'string' && typeof day?.count === 'number') &&
    Array.isArray(summary.products) &&
    summary.products.every(isCountBucket) &&
    Array.isArray(summary.daynight) &&
    summary.daynight.every(isCountBucket) &&
    Array.isArray(summary.confidence) &&
    summary.confidence.every(isCountBucket) &&
    Array.isArray(summary.frp) &&
    summary.frp.every(isCountBucket) &&
    typeof summary.frpReported === 'number' &&
    (summary.medianFrp === null || typeof summary.medianFrp === 'number') &&
    Array.isArray(summary.hourly) &&
    summary.hourly.every(
      (hour) => Number.isInteger(hour?.hour) && typeof hour?.count === 'number',
    ) &&
    Array.isArray(summary.topCells) &&
    summary.topCells.every(
      (cell) =>
        typeof cell?.label === 'string' &&
        typeof cell?.count === 'number' &&
        Number.isFinite(cell?.longitude) &&
        Number.isFinite(cell?.latitude),
    ) &&
    (summary.latest === null || isHotspotDetection(summary.latest)) &&
    (summary.highestFrp === null || isHotspotDetection(summary.highestFrp)) &&
    typeof response.window?.start_utc === 'string' &&
    typeof response.window?.end_utc_exclusive === 'string' &&
    response.sources.every(
      (source) =>
        typeof source?.source === 'string' &&
        (source.status === 'ok' || source.status === 'partial' || source.status === 'error') &&
        typeof source.successful_days === 'number' &&
        Array.isArray(source.failed_days),
    )
  )
}
