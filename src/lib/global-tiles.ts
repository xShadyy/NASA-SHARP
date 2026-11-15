import type { Feature, FeatureCollection, Point } from 'geojson'
import { classifyFire, type FireFeature } from './fire-severity'

export const MERCATOR_LATITUDE = 85.0511287798066
export const GLOBAL_TILE_LIMIT = 24
export type GlobalTile = { z: number; x: number; y: number }
export type GlobalPoint = Feature<Point, Record<string, unknown>>
export type GlobalTileCollection = FeatureCollection<Point, Record<string, unknown>>

export function visibleGlobalTiles(
  bounds: { west: number; east: number; south: number; north: number },
  requestedZoom: number,
  limit = GLOBAL_TILE_LIMIT,
): GlobalTile[] {
  const yAt = (latitude: number, size: number) => {
    const lat =
      (Math.max(-MERCATOR_LATITUDE, Math.min(MERCATOR_LATITUDE, latitude)) * Math.PI) / 180
    return Math.max(
      0,
      Math.min(size - 1, Math.floor(((1 - Math.asinh(Math.tan(lat)) / Math.PI) / 2) * size)),
    )
  }
  let zoom = Math.max(0, Math.min(18, Math.floor(requestedZoom)))
  for (;;) {
    const size = 2 ** zoom
    const west = Number.isFinite(bounds.west) ? bounds.west : -180
    let east = Number.isFinite(bounds.east) ? bounds.east : 180
    const wholeWorld = Math.abs(east - west) >= 360
    if (east < west) east += Math.ceil((west - east) / 360) * 360
    const span = wholeWorld ? 360 : Math.min(360, Math.max(0, east - west))
    const first = Math.floor(((west + 180) / 360) * size)
    const last =
      span >= 360 ? first + size - 1 : Math.floor(((west + span + 180) / 360) * size - 1e-10)
    const north = Number.isFinite(bounds.north) ? bounds.north : MERCATOR_LATITUDE
    const south = Number.isFinite(bounds.south) ? bounds.south : -MERCATOR_LATITUDE
    const top = yAt(Math.max(north, south), size),
      bottom = yAt(Math.min(north, south), size)
    const columns = Math.min(size, Math.max(1, last - first + 1))
    if (columns * (bottom - top + 1) > limit && zoom > 0) {
      zoom -= 1
      continue
    }
    const result: GlobalTile[] = []
    for (let x = first; x < first + columns; x++)
      for (let y = top; y <= bottom; y++) result.push({ z: zoom, x: ((x % size) + size) % size, y })
    return result
  }
}

export function canonicalGlobalFeature(feature: GlobalPoint): FireFeature | null {
  if (feature.geometry.type !== 'Point' || feature.properties.kind !== 'observation') return null
  const p = feature.properties
  const acquiredAt = typeof p.acquiredAt === 'string' ? p.acquiredAt : ''
  const acquiredEpoch = Date.parse(acquiredAt)
  if (!Number.isFinite(acquiredEpoch) || typeof p.id !== 'string') return null
  const [longitude, latitude] = feature.geometry.coordinates
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null
  const frpMw =
    typeof p.frpMw === 'number' && Number.isFinite(p.frpMw) && p.frpMw >= 0 ? p.frpMw : null
  return {
    type: 'Feature',
    id: p.id,
    geometry: { type: 'Point', coordinates: [longitude, latitude] },
    properties: {
      ...p,
      id: p.id,
      acquiredAt,
      acquiredEpoch,
      utcDay: acquiredAt.slice(0, 10),
      longitude,
      latitude,
      platform: String(p.platform ?? ''),
      sensor: String(p.sensor ?? ''),
      frpMw,
      severity: classifyFire(frpMw),
    },
  }
}

export function mergeGlobalTiles(collections: GlobalTileCollection[]) {
  const aggregates = new Map<string, GlobalPoint>(),
    observations = new Map<string, FireFeature>()
  for (const collection of collections)
    for (const feature of collection.features) {
      const id = String(feature.properties.id ?? feature.id ?? '')
      if (!id) continue
      if (feature.properties.kind === 'aggregate') aggregates.set(id, feature)
      else {
        const observation = canonicalGlobalFeature(feature)
        if (observation) observations.set(id, observation)
      }
    }
  return {
    aggregates: { type: 'FeatureCollection' as const, features: [...aggregates.values()] },
    observations: [...observations.values()],
  }
}
