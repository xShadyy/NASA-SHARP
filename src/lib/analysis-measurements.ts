import type { Feature, Polygon } from 'geojson'
import { geodesicAreaKm2, geodesicDistanceKm, type GeographicPosition } from './geodesy'

export function analysisDrawingMeasurements(feature: Feature<Polygon>, finished: boolean) {
  const ring = feature.geometry.coordinates[0] ?? []
  if (!ring.length || ring.some((point) => !point.slice(0, 2).every(Number.isFinite))) return null
  const positions = ring.map(([lng, lat]): GeographicPosition => [lng, lat])
  const rectangle = feature.properties?.mode === 'rectangle'
  const count = finished
    ? Math.max(0, positions.length - 1)
    : rectangle
      ? 4
      : Number(feature.properties?.committedCoordinateCount ?? Math.max(0, positions.length - 2))
  if (!Number.isInteger(count) || count < 1 || count >= positions.length) return null
  const committed = positions.slice(0, count)
  const cursor = positions[count]
  const points = finished || rectangle ? committed : [...committed, cursor]
  const distinct = new Set(points.map((point) => point.join(','))).size
  const origin = positions[0]
  const horizontal = rectangle
    ? (positions.find((point) => point[1] === origin[1] && point[0] !== origin[0]) ?? origin)
    : origin
  const vertical = rectangle
    ? (positions.find((point) => point[0] === origin[0] && point[1] !== origin[1]) ?? origin)
    : origin
  return {
    edgeKm: !finished && !rectangle ? geodesicDistanceKm(committed.at(-1)!, cursor) : null,
    widthKm: rectangle ? geodesicDistanceKm(origin, horizontal) : null,
    heightKm: rectangle ? geodesicDistanceKm(origin, vertical) : null,
    areaKm2: distinct >= 3 ? geodesicAreaKm2(points) : null,
  }
}
