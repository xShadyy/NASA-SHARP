import geographicLib from 'geographiclib-geodesic'

export type GeographicPosition = [longitude: number, latitude: number]
const { Geodesic } = geographicLib
const earth = Geodesic.WGS84

export function geodesicDistanceKm(from: GeographicPosition, to: GeographicPosition): number {
  return (earth.Inverse(from[1], from[0], to[1], to[0]).s12 ?? 0) / 1_000
}

export function geodesicLengthKm(points: readonly GeographicPosition[]): number {
  let total = 0
  for (let index = 1; index < points.length; index++) total += geodesicDistanceKm(points[index - 1], points[index])
  return total
}

export type GeodesicSegment = {
  path: GeographicPosition[]
  midpoint: GeographicPosition
  distanceKm: number
}

export function geodesicSegment(from: GeographicPosition, to: GeographicPosition): GeodesicSegment {
  const line = earth.InverseLine(from[1], from[0], to[1], to[0])
  const steps = Math.max(1, Math.ceil(Math.max(line.s13 / 30_000, line.a13 / 0.4)))
  const path: GeographicPosition[] = [[...from]]
  for (let step = 1; step <= steps; step++) {
    const point = line.Position(line.s13 * step / steps, Geodesic.STANDARD | Geodesic.LONG_UNROLL)
    path.push([point.lon2 ?? to[0], point.lat2 ?? to[1]])
  }
  const halfway = line.Position(line.s13 / 2)
  return { path, distanceKm: line.s13 / 1_000, midpoint: [halfway.lon2 ?? from[0], halfway.lat2 ?? from[1]] }
}

export function geodesicPolygonAccumulator(points: readonly GeographicPosition[]) {
  const polygon = earth.Polygon(false)
  for (const [longitude, latitude] of points) polygon.AddPoint(latitude, longitude)
  return {
    signedAreaKm2: (polygon.Compute(false, true).area ?? 0) / 1_000_000,
    previewSignedAreaKm2(point: GeographicPosition) {
      return (polygon.TestPoint(point[1], point[0], false, true).area ?? 0) / 1_000_000
    },
  }
}

export function geodesicAreaKm2(points: readonly GeographicPosition[]): number {
  return Math.abs(signedAreaM2(points)) / 1_000_000
}

function signedAreaM2(points: readonly GeographicPosition[]): number {
  if (points.length < 3) return 0
  const polygon = earth.Polygon(false)
  for (const [longitude, latitude] of points) polygon.AddPoint(latitude, longitude)
  return polygon.Compute(false, true).area ?? 0
}

export function geodesicPath(points: readonly GeographicPosition[], closed = false): GeographicPosition[] {
  if (points.length === 0) return []
  const path: GeographicPosition[] = [[...points[0]]]
  const count = closed ? points.length : points.length - 1
  for (let index = 0; index < count; index++) {
    const from = points[index]
    const to = points[(index + 1) % points.length]
    const segment = geodesicSegment(from, to)
    const previousLongitude = path[path.length - 1][0]
    const offset = Math.round((previousLongitude - from[0]) / 360) * 360
    for (const [longitude, latitude] of segment.path.slice(1)) path.push([longitude + offset, latitude])
  }
  return path
}

export function geodesicPolygonRing(points: readonly GeographicPosition[]): GeographicPosition[] {
  return closeGeodesicRing(geodesicPath(points, true), signedAreaM2(points) / 1_000_000)
}

export function closeGeodesicRing(path: readonly GeographicPosition[], signedAreaKm2: number): GeographicPosition[] {
  const ring = [...path]
  if (ring.length === 0) return ring
  const first = ring[0]
  const last = ring[ring.length - 1]
  const winding = Math.round((last[0] - first[0]) / 360)
  if (winding !== 0) {
    const pole = Math.sign(signedAreaKm2 * winding) >= 0 ? 90 : -90
    ring.push([last[0], pole], [first[0], pole])
  }
  ring.push([...first])
  return ring
}

export function hasCrossingEdges(points: readonly GeographicPosition[]): boolean {
  if (points.length < 4) return false
  const edges: GeographicPosition[][] = []
  let offset = 0
  for (let index = 0; index < points.length; index++) {
    const edge = geodesicPath([points[index], points[(index + 1) % points.length]])
    if (index > 0) offset = Math.round((edges[index - 1].at(-1)![0] - edge[0][0]) / 360) * 360
    edges.push(edge.map(([longitude, latitude]) => [longitude + offset, latitude]))
  }
  return hasCrossingPaths(edges)
}

export function hasCrossingPaths(edges: readonly (readonly GeographicPosition[])[]): boolean {
  const boxes = edges.map((edge) => {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const [x, y] of edge) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y) }
    return { minX, maxX, minY, maxY }
  })
  for (let left = 0; left < edges.length; left++) {
    for (let right = left + 2; right < edges.length; right++) {
      if (left === 0 && right === edges.length - 1) continue
      const a = edges[left]
      const b = edges[right]
      const wrap = Math.round((a[0][0] - b[0][0]) / 360) * 360
      const boxA = boxes[left], boxB = boxes[right]
      if (boxA.maxX < boxB.minX + wrap || boxB.maxX + wrap < boxA.minX || boxA.maxY < boxB.minY || boxB.maxY < boxA.minY) continue
      for (let i = 1; i < a.length; i++) {
        for (let j = 1; j < b.length; j++) {
          const c: GeographicPosition = [b[j - 1][0] + wrap, b[j - 1][1]]
          const d: GeographicPosition = [b[j][0] + wrap, b[j][1]]
          if (segmentsCross(a[i - 1], a[i], c, d)) return true
        }
      }
    }
  }
  return false
}

function segmentsCross(a: GeographicPosition, b: GeographicPosition, c: GeographicPosition, d: GeographicPosition): boolean {
  if (Math.max(a[0], b[0]) < Math.min(c[0], d[0]) || Math.max(c[0], d[0]) < Math.min(a[0], b[0]) ||
      Math.max(a[1], b[1]) < Math.min(c[1], d[1]) || Math.max(c[1], d[1]) < Math.min(a[1], b[1])) return false
  const turn = (p: GeographicPosition, q: GeographicPosition, r: GeographicPosition) =>
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
  return turn(a, b, c) * turn(a, b, d) < -1e-16 && turn(c, d, a) * turn(c, d, b) < -1e-16
}
