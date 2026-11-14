import type { MultiPolygon, Polygon, Position } from 'geojson'
import polygonClipping from 'polygon-clipping'
import { geodesicAreaKm2, hasCrossingEdges, type GeographicPosition } from '@/lib/geodesy'

export type AreaGeometry = Polygon | MultiPolygon
export type AreaKind = 'country' | 'polygon' | 'rectangle'
export type AreaBounds = [[number, number], [number, number]]
export type AnalysisArea = {
  id: string
  name: string
  type: AreaKind
  geometry: AreaGeometry
  bounds: AreaBounds
  source?: { name: string; dataset: string; url: string }
}

export const areaPolygons = (geometry: AreaGeometry) =>
  geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates

export function wrapLongitude(value: number) {
  return ((((value + 180) % 360) + 360) % 360) - 180
}

export function unwrapRing(ring: Position[], reference?: number): GeographicPosition[] {
  if (!ring.length) return []
  const result: GeographicPosition[] = []
  for (const point of ring) {
    const longitude = wrapLongitude(point[0])
    const previous = result.at(-1)?.[0] ?? reference ?? longitude
    result.push([longitude + Math.round((previous - longitude) / 360) * 360, point[1]])
  }
  return result
}

export function areaBounds(geometry: AreaGeometry): AreaBounds {
  const points = areaPolygons(geometry).flatMap((polygon) => polygon[0])
  const longitudes = [...new Set(points.map((point) => ((point[0] % 360) + 360) % 360))].sort(
    (a, b) => a - b,
  )
  let gap = -1
  let start = longitudes[0] ?? 0
  for (let index = 0; index < longitudes.length; index++) {
    const next =
      longitudes[(index + 1) % longitudes.length] + (index === longitudes.length - 1 ? 360 : 0)
    if (next - longitudes[index] > gap) {
      gap = next - longitudes[index]
      start = next % 360
    }
  }
  const west = wrapLongitude(start)
  const south = Math.min(...points.map((point) => point[1]))
  const north = Math.max(...points.map((point) => point[1]))
  return [
    [west, south],
    [west + Math.max(0, 360 - gap), north],
  ]
}

function orientation(a: Position, b: Position, c: Position) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}

function intersects(a: Position, b: Position, c: Position, d: Position) {
  const epsilon = 1e-10
  const on = (p: Position, q: Position, r: Position) =>
    Math.abs(orientation(p, q, r)) < epsilon &&
    r[0] >= Math.min(p[0], q[0]) - epsilon &&
    r[0] <= Math.max(p[0], q[0]) + epsilon &&
    r[1] >= Math.min(p[1], q[1]) - epsilon &&
    r[1] <= Math.max(p[1], q[1]) + epsilon
  return (
    (orientation(a, b, c) * orientation(a, b, d) < 0 &&
      orientation(c, d, a) * orientation(c, d, b) < 0) ||
    on(a, b, c) ||
    on(a, b, d) ||
    on(c, d, a) ||
    on(c, d, b)
  )
}

export function validateDrawnArea(geometry: AreaGeometry | null): string | null {
  if (!geometry || geometry.type !== 'Polygon' || !geometry.coordinates[0]?.length)
    return 'Draw an area with at least three distinct vertices.'
  const raw = geometry.coordinates[0]
  if (
    raw.some(
      (point) => point.length < 2 || !point.every(Number.isFinite) || Math.abs(point[1]) > 90,
    )
  )
    return 'Keep every vertex on the map surface.'
  const ring = unwrapRing(raw)
  const closed = raw[0][0] === raw.at(-1)![0] && raw[0][1] === raw.at(-1)![1]
  const vertices = closed ? ring.slice(0, -1) : ring
  if (new Set(vertices.map((point) => point.join(','))).size < 3)
    return 'Add at least three distinct vertices to define an area.'
  for (let left = 0; left < vertices.length; left++) {
    if (
      vertices[left][0] === vertices[(left + 1) % vertices.length][0] &&
      vertices[left][1] === vertices[(left + 1) % vertices.length][1]
    )
      return 'Move or remove overlapping vertices.'
    for (let right = left + 2; right < vertices.length; right++) {
      if (left === 0 && right === vertices.length - 1) continue
      if (
        intersects(
          vertices[left],
          vertices[(left + 1) % vertices.length],
          vertices[right],
          vertices[(right + 1) % vertices.length],
        )
      )
        return 'The boundary crosses itself. Drag a vertex to remove the crossing.'
    }
  }
  if (hasCrossingEdges(vertices))
    return 'The boundary crosses itself. Drag a vertex to remove the crossing.'
  if (!(geodesicAreaKm2(vertices) > 1e-8))
    return 'This shape has no usable area. Move a vertex away from the line.'
  return null
}

export function drawnArea(
  geometry: Polygon,
  type: 'polygon' | 'rectangle',
  id: string = crypto.randomUUID(),
): AnalysisArea {
  const coordinates = geometry.coordinates.map((ring) =>
    ring.map(([x, y]) => [Number(wrapLongitude(x).toFixed(9)), Number(y.toFixed(9))]),
  )
  const normalized: Polygon = { type: 'Polygon', coordinates }
  return {
    id,
    name: type === 'rectangle' ? 'Custom rectangle' : 'Custom polygon',
    type,
    geometry: normalized,
    bounds: areaBounds(normalized),
  }
}

function rectangle(
  west: number,
  south: number,
  east: number,
  north: number,
): polygonClipping.Polygon {
  return [
    [
      [west, south],
      [east, south],
      [east, north],
      [west, north],
      [west, south],
    ],
  ]
}

export function wrappedArea(geometry: AreaGeometry): MultiPolygon {
  const result: polygonClipping.MultiPolygon = []
  for (const polygon of areaPolygons(geometry)) {
    const rawOuter = polygon[0]
    const polar = rawOuter.some((point) => Math.abs(point[1]) >= 89.999)
    const outer = polar
      ? rawOuter.map(([x, y]): GeographicPosition => [x, y])
      : unwrapRing(rawOuter)
    const reference = outer.reduce((sum, point) => sum + point[0], 0) / outer.length
    const rings = [outer, ...polygon.slice(1).map((ring) => unwrapRing(ring, reference))]
    const xs = outer.map((point) => point[0])
    const west = Math.min(...xs),
      east = Math.max(...xs)
    for (
      let shift = Math.ceil((-180 - east) / 360);
      shift <= Math.floor((180 - west) / 360);
      shift++
    ) {
      const moved = rings.map((ring) =>
        ring.map(([x, y]): polygonClipping.Pair => [x + shift * 360, y]),
      )
      result.push(...polygonClipping.intersection(moved, rectangle(-180, -90, 180, 90)))
    }
  }
  return { type: 'MultiPolygon', coordinates: result }
}

export function outsideAreaMask(geometry: AreaGeometry): MultiPolygon {
  const selected = wrappedArea(geometry).coordinates as polygonClipping.MultiPolygon
  const coordinates: polygonClipping.MultiPolygon = []
  for (let west = -180; west < 180; west += 60) {
    for (let south = -90; south < 90; south += 30) {
      coordinates.push(
        ...polygonClipping.difference(rectangle(west, south, west + 60, south + 30), selected),
      )
    }
  }
  return { type: 'MultiPolygon', coordinates }
}
