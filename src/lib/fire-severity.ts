import type { Feature, Point } from 'geojson'

export const FIRE_FRP_MODERATE = 10
export const FIRE_FRP_HIGH = 50

export const FIRE_LEVELS = [
  { id: 'low', label: 'Low', detail: 'Under 10 MW', color: '#f5c518' },
  { id: 'moderate', label: 'Moderate', detail: '10 to under 50 MW', color: '#f97316' },
  { id: 'high', label: 'High', detail: '50 MW and above', color: '#dc2626' },
] as const

export type FireSeverity = (typeof FIRE_LEVELS)[number]['id']

export type FireProperties = {
  severity: FireSeverity
  frpMw: number | null
  acquiredAt: string
  platform: string
  sensor: string
}

export type FireFeature = Feature<Point, FireProperties>

const PLATFORM_LABELS: Record<string, string> = {
  aqua: 'Aqua',
  terra: 'Terra',
  'suomi-npp': 'Suomi NPP',
  'noaa-20': 'NOAA-20',
  'noaa-21': 'NOAA-21',
}

export function classifyFire(frpMw: number | null | undefined): FireSeverity {
  if (typeof frpMw !== 'number' || !Number.isFinite(frpMw) || frpMw < FIRE_FRP_MODERATE)
    return 'low'
  if (frpMw < FIRE_FRP_HIGH) return 'moderate'
  return 'high'
}

export function fireLevel(severity: string) {
  return FIRE_LEVELS.find((level) => level.id === severity) ?? FIRE_LEVELS[0]
}

export function firePlatformLabel(platform: string) {
  return PLATFORM_LABELS[platform] ?? platform
}

export function formatFireTime(iso: string) {
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return ''
  return `${new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
    hourCycle: 'h23',
  }).format(time)} UTC`
}

export function fireMapFeatures(body: unknown): FireFeature[] {
  const payload = record(record(body, 'The fire map').data, 'The fire map')
  const collection = record(payload.data, 'The fire map')
  if (!Array.isArray(collection.features)) throw new Error('The fire map was not returned.')
  const features: FireFeature[] = []
  for (const item of collection.features) {
    const feature = record(item, 'A fire detection')
    const geometry = record(feature.geometry, 'A fire detection')
    const coordinates = geometry.coordinates
    if (geometry.type !== 'Point' || !Array.isArray(coordinates) || coordinates.length < 2) continue
    const [longitude, latitude] = coordinates
    if (typeof longitude !== 'number' || typeof latitude !== 'number') continue
    const properties = record(feature.properties ?? {}, 'A fire detection')
    const frpMw = typeof properties.frpMw === 'number' ? properties.frpMw : null
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [longitude, latitude] },
      properties: {
        severity: classifyFire(frpMw),
        frpMw,
        acquiredAt: typeof properties.acquiredAt === 'string' ? properties.acquiredAt : '',
        platform: typeof properties.platform === 'string' ? properties.platform : '',
        sensor: typeof properties.sensor === 'string' ? properties.sensor : '',
      },
    })
  }
  const rank = { low: 0, moderate: 1, high: 2 }
  features.sort((a, b) => rank[a.properties.severity] - rank[b.properties.severity])
  return features
}

function record(body: unknown, label: string) {
  if (!body || typeof body !== 'object') throw new Error(`${label} was not returned.`)
  return body as Record<string, unknown>
}
