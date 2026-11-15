import type { Feature, Point, Polygon } from 'geojson'
import geographicLib from 'geographiclib-geodesic'

export const FIRE_FRP_MODERATE = 10
export const FIRE_FRP_HIGH = 50

export const FIRE_LEVELS = [
  { id: 'low', label: 'Low', detail: 'Under 10 MW', color: '#f5c518' },
  { id: 'moderate', label: 'Moderate', detail: '10 to under 50 MW', color: '#f97316' },
  { id: 'high', label: 'High', detail: '50 MW and above', color: '#dc2626' },
  { id: 'unknown', label: 'Unknown FRP', detail: 'FRP not reported', color: '#9ca3af' },
] as const

export type FireSeverity = (typeof FIRE_LEVELS)[number]['id']

export type FireProperties = {
  [key: string]: unknown
  id: string
  acquiredEpoch: number
  utcDay: string
  longitude: number
  latitude: number
  severity: FireSeverity
  frpMw: number | null
  acquiredAt: string
  platform: string
  sensor: string
  scanKm?: number
  trackKm?: number
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
  if (typeof frpMw !== 'number' || !Number.isFinite(frpMw) || frpMw < 0) return 'unknown'
  if (frpMw < FIRE_FRP_MODERATE) return 'low'
  if (frpMw < FIRE_FRP_HIGH) return 'moderate'
  return 'high'
}

export function fireLevel(severity: string) {
  return FIRE_LEVELS.find((level) => level.id === severity) ?? FIRE_LEVELS[3]
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
    if (
      typeof longitude !== 'number' ||
      typeof latitude !== 'number' ||
      !Number.isFinite(longitude) ||
      !Number.isFinite(latitude) ||
      Math.abs(longitude) > 180 ||
      Math.abs(latitude) > 90
    )
      continue
    const properties = record(feature.properties ?? {}, 'A fire detection')
    const frpMw =
      typeof properties.frpMw === 'number' &&
      Number.isFinite(properties.frpMw) &&
      properties.frpMw >= 0
        ? properties.frpMw
        : null
    const acquiredAt = typeof properties.acquiredAt === 'string' ? properties.acquiredAt : ''
    const platform = typeof properties.platform === 'string' ? properties.platform : ''
    const id = String(
      feature.id ?? properties.id ?? `${platform}:${acquiredAt}:${longitude}:${latitude}`,
    )
    features.push({
      type: 'Feature',
      id,
      geometry: { type: 'Point', coordinates: [longitude, latitude] },
      properties: {
        ...properties,
        id,
        longitude,
        latitude,
        acquiredEpoch: Number.isFinite(Date.parse(acquiredAt)) ? Date.parse(acquiredAt) : 0,
        utcDay: Number.isFinite(Date.parse(acquiredAt))
          ? new Date(acquiredAt).toISOString().slice(0, 10)
          : '',
        severity: classifyFire(frpMw),
        frpMw,
        acquiredAt,
        platform,
        sensor: typeof properties.sensor === 'string' ? properties.sensor : '',
        scanKm:
          typeof properties.scanKm === 'number' &&
          Number.isFinite(properties.scanKm) &&
          properties.scanKm > 0
            ? properties.scanKm
            : undefined,
        trackKm:
          typeof properties.trackKm === 'number' &&
          Number.isFinite(properties.trackKm) &&
          properties.trackKm > 0
            ? properties.trackKm
            : undefined,
      },
    })
  }
  const rank = { unknown: -1, low: 0, moderate: 1, high: 2 }
  features.sort((a, b) => rank[a.properties.severity] - rank[b.properties.severity])
  return features
}

function record(body: unknown, label: string) {
  if (!body || typeof body !== 'object') throw new Error(`${label} was not returned.`)
  return body as Record<string, unknown>
}

export function firePixelFeatures(features: FireFeature[]): Feature<Polygon, FireProperties>[] {
  const earth = geographicLib.Geodesic.WGS84
  return features.flatMap((feature) => {
    const [longitude, latitude] = feature.geometry.coordinates
    const dimensions = firePixelDimensions(feature)
    if (!dimensions) return []
    const halfWidth = dimensions.widthKm * 500
    const halfHeight = dimensions.heightKm * 500
    const distance = Math.hypot(halfWidth, halfHeight)
    const angle = (Math.atan2(halfWidth, halfHeight) * 180) / Math.PI
    const ring = [180 + angle, 180 - angle, angle, 360 - angle].map((bearing) => {
      const corner = earth.Direct(
        latitude,
        longitude,
        bearing,
        distance,
        geographicLib.Geodesic.STANDARD | geographicLib.Geodesic.LONG_UNROLL,
      )
      return [corner.lon2 ?? longitude, corner.lat2 ?? latitude]
    })
    ring.push([...ring[0]])
    return [{ ...feature, geometry: { type: 'Polygon' as const, coordinates: [ring] } }]
  })
}

export function firePixelDimensions(feature: FireFeature) {
  const { sensor, platform, scanKm, trackKm, nominalResolutionM } = feature.properties
  const modis = sensor.toUpperCase() === 'MODIS' || ['terra', 'aqua'].includes(platform)
  const viirs =
    sensor.toUpperCase() === 'VIIRS' || ['suomi-npp', 'noaa-20', 'noaa-21'].includes(platform)
  const nominal =
    typeof nominalResolutionM === 'number' &&
    Number.isFinite(nominalResolutionM) &&
    nominalResolutionM > 0
      ? nominalResolutionM / 1000
      : modis
        ? 1
        : viirs
          ? 0.375
          : null
  const widthKm =
    typeof scanKm === 'number' && Number.isFinite(scanKm) && scanKm > 0 ? scanKm : nominal
  const heightKm =
    typeof trackKm === 'number' && Number.isFinite(trackKm) && trackKm > 0 ? trackKm : nominal
  return widthKm !== null && heightKm !== null ? { widthKm, heightKm } : null
}
