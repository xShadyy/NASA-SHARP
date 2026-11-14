import simplify from '@turf/simplify'
import type { MultiPolygon, Polygon, Position } from 'geojson'
import {
  areaBounds,
  countryFocusBounds,
  outsideAreaMask,
  unwrapRing,
  wrapLongitude,
  wrappedArea,
  type AreaBounds,
  type AreaGeometry,
} from '@/lib/analysis-area'

export type AnalysisDisplayGeometry = {
  boundary: AreaGeometry
  outside: MultiPolygon | null
}

export type PreparedBoundaryGeometry = {
  displayGeometry: AreaGeometry
  displayBoundary: MultiPolygon
  displayMask: MultiPolygon | null
  bounds: AreaBounds
  fullBounds: AreaBounds
}

const DISPLAY_TOLERANCE = 0.00025

function planarRingArea(ring: Position[]) {
  let sum = 0
  for (let index = 1; index < ring.length; index++)
    sum += ring[index - 1][0] * ring[index][1] - ring[index][0] * ring[index - 1][1]
  return sum / 2
}

function simplifyRing(ring: Position[], reference?: number): Position[] {
  const unwrapped = unwrapRing(ring, reference)
  let west = Infinity
  let south = Infinity
  let east = -Infinity
  let north = -Infinity
  for (const [longitude, latitude] of unwrapped) {
    west = Math.min(west, longitude)
    south = Math.min(south, latitude)
    east = Math.max(east, longitude)
    north = Math.max(north, latitude)
  }
  const tolerance = Math.min(DISPLAY_TOLERANCE, Math.max(east - west, north - south) / 1200)
  let simplified: Position[] = unwrapped
  try {
    simplified = simplify<Polygon>(
      { type: 'Polygon', coordinates: [unwrapped] },
      { tolerance, highQuality: true },
    ).coordinates[0]
  } catch {
    simplified = unwrapped
  }
  const originalArea = planarRingArea(unwrapped)
  const displayArea = planarRingArea(simplified)
  const ratio = originalArea === 0 ? 0 : displayArea / originalArea
  if (simplified.length < 4 || ratio < 0.9 || ratio > 1.1) simplified = unwrapped
  return simplified.map(([longitude, latitude]) => [wrapLongitude(longitude), latitude])
}

export function simplifyCountryDisplayGeometry(geometry: AreaGeometry): AreaGeometry {
  const polygon = (rings: Position[][]) => {
    const outer = unwrapRing(rings[0])
    const reference = outer.reduce((sum, point) => sum + point[0], 0) / outer.length
    return rings.map((ring) => simplifyRing(ring, reference))
  }
  return geometry.type === 'Polygon'
    ? { type: 'Polygon', coordinates: polygon(geometry.coordinates) }
    : { type: 'MultiPolygon', coordinates: geometry.coordinates.map(polygon) }
}

export function prepareCountryDisplayGeometry(
  geometry: AreaGeometry,
  preferredBounds?: AreaBounds,
): PreparedBoundaryGeometry {
  const displayGeometry = simplifyCountryDisplayGeometry(geometry)
  const displayBoundary = wrappedArea(displayGeometry)
  let displayMask: MultiPolygon | null = null
  try {
    displayMask = outsideAreaMask(displayGeometry)
  } catch {
    displayMask = null
  }
  return {
    displayGeometry,
    displayBoundary,
    displayMask,
    bounds: countryFocusBounds(geometry, preferredBounds),
    fullBounds: areaBounds(geometry),
  }
}

export function prepareAnalysisDisplayGeometry(geometry: AreaGeometry): AnalysisDisplayGeometry {
  return { boundary: wrappedArea(geometry), outside: outsideAreaMask(geometry) }
}

export function fallbackAnalysisDisplayGeometry(geometry: AreaGeometry): AnalysisDisplayGeometry {
  try {
    return prepareAnalysisDisplayGeometry(geometry)
  } catch {
    return { boundary: geometry, outside: null }
  }
}
