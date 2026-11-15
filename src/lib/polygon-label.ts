import { geodesicPath, type GeographicPosition } from './geodesy'

type XY = [number, number]
type Vector = [number, number, number]
type Cell = { x: number; y: number; half: number; distance: number; maximum: number }
const radians = Math.PI / 180
const dot = (a: Vector, b: Vector) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vector, b: Vector): Vector => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const normalize = (vector: Vector): Vector => {
  const length = Math.hypot(...vector)
  return vector.map((value) => value / length) as Vector
}
function vector([longitude, latitude]: GeographicPosition): Vector {
  const lat = latitude * radians,
    lon = longitude * radians
  return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)]
}




function localPlane(points: readonly GeographicPosition[]) {
  const sum: Vector = [0, 0, 0]
  for (const point of points) {
    const v = vector(point)
    sum[0] += v[0]
    sum[1] += v[1]
    sum[2] += v[2]
  }
  const center = Math.hypot(...sum) > 1e-8 ? normalize(sum) : vector(points[0])
  const east = normalize(cross(Math.abs(center[2]) > 0.99 ? [0, 1, 0] : [0, 0, 1], center))
  const north = cross(center, east)
  return {
    project(point: GeographicPosition): XY {
      const v = vector(point)
      const scale = Math.sqrt(2 / Math.max(1e-10, 1 + dot(center, v)))
      return [scale * dot(v, east), scale * dot(v, north)]
    },
    unproject([x, y]: XY): GeographicPosition {
      const radius = Math.hypot(x, y)
      if (radius < 1e-12)
        return [Math.atan2(center[1], center[0]) / radians, Math.asin(center[2]) / radians]
      const angle = 2 * Math.asin(Math.min(1, radius / 2))
      const v = center.map(
        (value, index) =>
          value * Math.cos(angle) +
          ((east[index] * x + north[index] * y) * Math.sin(angle)) / radius,
      ) as Vector
      return [
        Math.atan2(v[1], v[0]) / radians,
        Math.asin(Math.max(-1, Math.min(1, v[2]))) / radians,
      ]
    },
  }
}




export function polygonInteriorPoint(
  points: readonly GeographicPosition[],
  boundary = geodesicPath(points, true),
  latitudeLimit = 90,
): GeographicPosition | null {
  if (points.length < 3) return points[0] ?? [0, 0]
  const plane = localPlane(points)
  const ring = boundary.map(plane.project)
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity
  for (const [x, y] of ring) {
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
  }
  const width = maxX - minX,
    height = maxY - minY
  if (Math.min(width, height) < 1e-12) return points[0]
  const makeCell = (x: number, y: number, half: number): Cell => {
    const polygonDistance = signedDistance([x, y], ring)
    const latitude = latitudeLimit < 90 ? plane.unproject([x, y])[1] : 0
    const distance =
      latitudeLimit < 90
        ? Math.min(polygonDistance, (latitudeLimit - Math.abs(latitude)) * radians)
        : polygonDistance
    return { x, y, half, distance, maximum: distance + half * Math.SQRT2 }
  }
  const queue: Cell[] = []
  function push(cell: Cell) {
    queue.push(cell)
    let index = queue.length - 1
    while (index > 0) {
      const parent = (index - 1) >> 1
      if (queue[parent].maximum >= cell.maximum) break
      queue[index] = queue[parent]
      index = parent
    }
    queue[index] = cell
  }
  function pop(): Cell {
    const top = queue[0],
      last = queue.pop()!
    if (queue.length) {
      let index = 0
      while (index * 2 + 1 < queue.length) {
        let child = index * 2 + 1
        if (child + 1 < queue.length && queue[child + 1].maximum > queue[child].maximum) child++
        if (queue[child].maximum <= last.maximum) break
        queue[index] = queue[child]
        index = child
      }
      queue[index] = last
    }
    return top
  }
  const size = Math.max(Math.min(width, height), Math.max(width, height) / 32)
  for (let x = minX; x < maxX; x += size)
    for (let y = minY; y < maxY; y += size) push(makeCell(x + size / 2, y + size / 2, size / 2))
  let best = makeCell((minX + maxX) / 2, (minY + maxY) / 2, 0)
  const geographicCenter = makeCell(0, 0, 0)
  if (geographicCenter.distance > best.distance) best = geographicCenter
  
  if (best.distance < 0) best = makeCell(ring[0][0], ring[0][1], 0)
  const precision = Math.max(width, height) / 2_048
  for (let examined = 0; queue.length && examined < 4_096; examined++) {
    const cell = pop()
    if (cell.distance > best.distance) best = cell
    if (cell.maximum - best.distance <= precision) continue
    const half = cell.half / 2
    for (const dx of [-half, half])
      for (const dy of [-half, half]) push(makeCell(cell.x + dx, cell.y + dy, half))
  }
  const result = plane.unproject([best.x, best.y])
  return best.distance >= 0 && Math.abs(result[1]) <= latitudeLimit + 1e-9 ? result : null
}

export function polygonContainsPoint(
  point: GeographicPosition,
  polygon: readonly GeographicPosition[],
): boolean {
  if (polygon.length < 3) return false
  const plane = localPlane(polygon)
  return (
    signedDistance(plane.project(point), geodesicPath(polygon, true).map(plane.project)) >= -1e-12
  )
}

function signedDistance([x, y]: XY, ring: readonly XY[]): number {
  let inside = false,
    nearest = Infinity
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [ax, ay] = ring[previous],
      [bx, by] = ring[index]
    if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside
    const dx = bx - ax,
      dy = by - ay
    const denominator = dx * dx + dy * dy
    const t = denominator
      ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / denominator))
      : 0
    nearest = Math.min(nearest, (x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2)
  }
  return (inside ? 1 : -1) * Math.sqrt(nearest)
}
