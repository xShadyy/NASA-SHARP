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
  sourceGeometry?: AreaGeometry
  displayGeometry?: AreaGeometry
  displayBoundary?: MultiPolygon
  displayMask?: MultiPolygon | null
  boundaryRef?: string
  bounds: AreaBounds
  fullBounds?: AreaBounds
  source?: {
    name: string
    dataset: string
    url: string
    version?: string
    commit?: string
    iso3?: string
    license?: string
    attribution?: string
    year?: string
  }
}

export const areaPolygons = (geometry: AreaGeometry) =>
  geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates

export function wrapLongitude(value: number) {
  if (value >= -180 && value < 180) return value
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
  let south = Infinity
  let north = -Infinity
  for (const point of points) {
    south = Math.min(south, point[1])
    north = Math.max(north, point[1])
  }
  return [
    [west, south],
    [west + Math.max(0, 360 - gap), north],
  ]
}

function ringBounds(ring: Position[]): [number, number, number, number] {
  let west = Infinity
  let south = Infinity
  let east = -Infinity
  let north = -Infinity
  for (const [longitude, latitude] of ring) {
    west = Math.min(west, longitude)
    south = Math.min(south, latitude)
    east = Math.max(east, longitude)
    north = Math.max(north, latitude)
  }
  return [west, south, east, north]
}

export function countryFocusBounds(geometry: AreaGeometry, preferred?: AreaBounds): AreaBounds {
  const reference = preferred ? (preferred[0][0] + preferred[1][0]) / 2 : undefined
  const polygons = areaPolygons(geometry).map((polygon) => {
    const outer = unwrapRing(polygon[0], reference)
    const bounds = ringBounds(outer)
    const size =
      sphericalRingArea(outer) -
      polygon
        .slice(1)
        .reduce((total, hole) => total + sphericalRingArea(unwrapRing(hole, reference)), 0)
    return { bounds, size }
  })
  const preferredPolygons = preferred
    ? polygons.filter(
        ({ bounds }) =>
          bounds[0] <= preferred[1][0] &&
          bounds[2] >= preferred[0][0] &&
          bounds[1] <= preferred[1][1] &&
          bounds[3] >= preferred[0][1],
      )
    : polygons
  const candidates = preferredPolygons.length ? preferredPolygons : polygons
  const largest = candidates.reduce<(typeof candidates)[number] | null>(
    (current, polygon) => (!current || polygon.size > current.size ? polygon : current),
    null,
  )
  if (!largest) return areaBounds(geometry)
  return [
    [largest.bounds[0], largest.bounds[1]],
    [largest.bounds[2], largest.bounds[3]],
  ]
}

function sphericalRingArea(ring: Position[]) {
  let sum = 0
  for (let index = 1; index < ring.length; index++) {
    const previous = ring[index - 1]
    const point = ring[index]
    sum +=
      (point[0] - previous[0]) *
      (2 + Math.sin((previous[1] * Math.PI) / 180) + Math.sin((point[1] * Math.PI) / 180))
  }
  return Math.abs(sum)
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
    const [west, south, east, north] = ringBounds(outer)
    if (west >= -180 && east <= 180 && south >= -90 && north <= 90) {
      result.push(rings)
      continue
    }
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
  const selected = wrappedArea(geometry).coordinates.map((polygon) => ({
    polygon: polygon as polygonClipping.Polygon,
    bounds: ringBounds(polygon[0]),
  }))
  const coordinates: polygonClipping.MultiPolygon = []
  for (let west = -180; west < 180; west += 60) {
    for (let south = -90; south < 90; south += 30) {
      const nearby = selected
        .filter(
          ({ bounds }) =>
            bounds[0] <= west + 60 &&
            bounds[2] >= west &&
            bounds[1] <= south + 30 &&
            bounds[3] >= south,
        )
        .map(({ polygon }) => polygon)
      coordinates.push(
        ...polygonClipping.difference(rectangle(west, south, west + 60, south + 30), nearby),
      )
    }
  }
  return { type: 'MultiPolygon', coordinates }
}
