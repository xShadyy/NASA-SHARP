import type { MultiPolygon, Polygon, Position } from 'geojson'

function isRing(value: unknown): value is Position[] {
  if (!Array.isArray(value) || value.length < 4) return false
  if (
    !value.every(
      (point) =>
        Array.isArray(point) &&
        point.length >= 2 &&
        point.every((number) => typeof number === 'number' && Number.isFinite(number)) &&
        Math.abs(point[0]) <= 180 &&
        Math.abs(point[1]) <= 90,
    )
  )
    return false
  return value[0][0] === value.at(-1)[0] && value[0][1] === value.at(-1)[1]
}

export function isCountryGeometry(value: unknown): value is Polygon | MultiPolygon {
  if (!value || typeof value !== 'object' || !('type' in value) || !('coordinates' in value))
    return false
  const polygon = (rings: unknown) =>
    Array.isArray(rings) && rings.length > 0 && rings.every(isRing)
  return value.type === 'Polygon'
    ? polygon(value.coordinates)
    : value.type === 'MultiPolygon' &&
        Array.isArray(value.coordinates) &&
        value.coordinates.length > 0 &&
        value.coordinates.every(polygon)
}

export function readCountryGeometry(value: unknown): Polygon | MultiPolygon {
  if (
    !value ||
    typeof value !== 'object' ||
    !('features' in value) ||
    !Array.isArray(value.features)
  )
    throw new Error('The detailed country boundary is invalid.')
  const geometries = value.features.map((feature) => feature?.geometry as unknown)
  if (!geometries.length || !geometries.every(isCountryGeometry))
    throw new Error('The detailed country boundary has no usable polygons.')
  if (geometries.length === 1) return geometries[0]
  return {
    type: 'MultiPolygon',
    coordinates: geometries.flatMap((geometry) =>
      geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates,
    ),
  }
}
