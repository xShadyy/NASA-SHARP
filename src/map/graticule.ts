import type { Feature, FeatureCollection, LineString, Point } from 'geojson'
import type { GeoJSONSource, LayerSpecification, Map as MapLibreMap, SourceSpecification } from 'maplibre-gl'
import type { MapView } from './projection'

export const GRATICULE_SOURCE_ID = 'reference-graticule'
export const GRATICULE_LINE_LAYER_ID = 'reference-graticule-lines'
export const GRATICULE_AXIS_LAYER_ID = 'reference-graticule-axes'
export const GRATICULE_LABEL_LAYER_ID = 'reference-graticule-labels'
export const GRATICULE_LAYER_IDS = [GRATICULE_LINE_LAYER_ID, GRATICULE_AXIS_LAYER_ID, GRATICULE_LABEL_LAYER_ID] as const

type GridProperties = { kind: 'line' | 'label', axis: boolean, label?: string, priority?: number }
type GridFeature = Feature<LineString | Point, GridProperties>

const EMPTY_GRID: FeatureCollection<LineString | Point, GridProperties> = { type: 'FeatureCollection', features: [] }
const MERCATOR_LIMIT = 85.0511287798066
const GLOBE_LIMIT = MERCATOR_LIMIT
const INTERVALS = [30, 15, 10, 5, 2, 1, 0.5, 0.25, 0.1, 0.05, 0.02, 0.01, 0.005, 0.002, 0.001] as const
const MAX_LINES = 60
const MAX_VERTICES = 24_000

export function graticuleSource(): SourceSpecification {
  return { type: 'geojson', data: EMPTY_GRID, maxzoom: 18, tolerance: 0.2 }
}

export function graticuleLayers(): LayerSpecification[] {
  return [
    {
      id: GRATICULE_LINE_LAYER_ID, type: 'line', source: GRATICULE_SOURCE_ID,
      filter: ['all', ['==', ['get', 'kind'], 'line'], ['==', ['get', 'axis'], false]],
      layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': 0.75, 'line-opacity': 0.34 },
    },
    {
      id: GRATICULE_AXIS_LAYER_ID, type: 'line', source: GRATICULE_SOURCE_ID,
      filter: ['all', ['==', ['get', 'kind'], 'line'], ['==', ['get', 'axis'], true]],
      layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': 1.15, 'line-opacity': 0.56 },
    },
    {
      id: GRATICULE_LABEL_LAYER_ID, type: 'symbol', source: GRATICULE_SOURCE_ID,
      filter: ['==', ['get', 'kind'], 'label'],
      layout: {
        visibility: 'none', 'text-field': ['get', 'label'], 'text-font': ['Fira Sans'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 0, 10, 7, 11, 13, 12],
        'text-pitch-alignment': 'map', 'text-rotation-alignment': 'map',
        'text-allow-overlap': false, 'text-ignore-placement': false,
        'text-padding': 7, 'symbol-sort-key': ['get', 'priority'],
      },
      paint: {
        'text-color': '#ffffff', 'text-opacity': 0.82,
        'text-halo-color': 'rgba(4, 20, 34, 0.85)', 'text-halo-width': 1.15,
      },
    },
  ]
}

function wrapLongitude(longitude: number) {
  return ((longitude + 180) % 360 + 360) % 360 - 180
}

function nearLongitude(longitude: number, center: number) {
  return center + wrapLongitude(longitude - center)
}

function isSurfacePoint(map: MapLibreMap, longitude: number, latitude: number, inset = 0) {
  const screen = map.project([nearLongitude(longitude, map.getCenter().lng), latitude])
  const { clientWidth: width, clientHeight: height } = map.getContainer()
  if (!Number.isFinite(screen.x) || !Number.isFinite(screen.y)
    || screen.x < inset || screen.y < inset || screen.x > width - inset || screen.y > height - inset) return null
  const inverse = map.unproject(screen)
  if (Math.abs(wrapLongitude(inverse.lng - longitude)) > 0.0001 || Math.abs(inverse.lat - latitude) > 0.0001) return null
  return screen
}

function screenAngularSpan(map: MapLibreMap, view: MapView) {
  const { clientWidth: width, clientHeight: height } = map.getContainer()
  const center = map.getCenter()
  const screen = map.project(center)
  const sample = Math.max(36, Math.min(110, width * 0.15, height * 0.15))
  const x = map.unproject([screen.x + sample, screen.y])
  const y = map.unproject([screen.x, screen.y + sample])
  const xScreen = map.project(x)
  const yScreen = map.project(y)
  const xValid = view === 'map' || Math.hypot(xScreen.x - screen.x - sample, xScreen.y - screen.y) <= 1
  const yValid = view === 'map' || Math.hypot(yScreen.x - screen.x, yScreen.y - screen.y - sample) <= 1
  const longitude = xValid ? Math.abs(wrapLongitude(x.lng - center.lng)) : 0
  const latitude = yValid ? Math.abs(y.lat - center.lat) : 0
  const measured = Math.max(longitude, latitude)
  return measured > 0 && measured < 180 ? measured : 110 * 360 / (512 * 2 ** map.getZoom())
}

function chooseInterval(map: MapLibreMap, view: MapView) {
  const desired = screenAngularSpan(map, view)
  return [...INTERVALS].reverse().find((interval) => interval >= desired) ?? INTERVALS[0]
}

type Region = { west: number, east: number, south: number, north: number }

function visibleRegion(map: MapLibreMap, view: MapView, interval: number): Region {
  const limit = view === 'globe' ? GLOBE_LIMIT : MERCATOR_LIMIT
  if (view === 'map') {
    const bounds = map.getBounds()
    const center = map.getCenter().lng
    if (bounds.getEast() - bounds.getWest() >= 360) {
      return { west: center - 180, east: center + 180, south: Math.max(-limit, bounds.getSouth()), north: Math.min(limit, bounds.getNorth()) }
    }
    const west = nearLongitude(bounds.getWest(), center)
    let east = west + (bounds.getEast() - bounds.getWest())
    if (east < west) east += 360
    return {
      west: Math.max(center - 180, west - interval * 1.5),
      east: Math.min(center + 180, east + interval * 1.5),
      south: Math.max(-limit, bounds.getSouth() - interval * 1.5),
      north: Math.min(limit, bounds.getNorth() + interval * 1.5),
    }
  }
  const { clientWidth: width, clientHeight: height } = map.getContainer()
  const center = map.getCenter().lng
  const longitudes: number[] = []
  const latitudes: number[] = []
  for (let row = 0; row <= 10; row++) for (let column = 0; column <= 10; column++) {
    const point = { x: width * column / 10, y: height * row / 10 }
    const location = map.unproject([point.x, point.y])
    const inverse = map.project(location)
    if (Math.hypot(inverse.x - point.x, inverse.y - point.y) > 1) continue
    longitudes.push(nearLongitude(location.lng, center))
    latitudes.push(location.lat)
  }
  if (map.getZoom() <= 2.6 || !longitudes.length) {
    return { west: -180, east: 180, south: -limit, north: limit }
  }
  const west = Math.min(...longitudes) - interval * 1.5
  const east = Math.max(...longitudes) + interval * 1.5
  return {
    west: Math.max(center - 180, west), east: Math.min(center + 180, east),
    south: Math.max(-limit, Math.min(...latitudes) - interval * 1.5),
    north: Math.min(limit, Math.max(...latitudes) + interval * 1.5),
  }
}

function coordinateSequence(start: number, end: number, maximumStep: number): number[] {
  const count = Math.max(1, Math.ceil((end - start) / maximumStep))
  return Array.from({ length: count + 1 }, (_, index) => start + (end - start) * index / count)
}

function lineFeature(points: [number, number][], axis: boolean): GridFeature {
  return { type: 'Feature', properties: { kind: 'line', axis }, geometry: { type: 'LineString', coordinates: points } }
}

function labelFeature(longitude: number, latitude: number, label: string, axis: boolean): GridFeature {
  return {
    type: 'Feature', properties: { kind: 'label', axis, label, priority: axis ? 0 : 1 },
    geometry: { type: 'Point', coordinates: [wrapLongitude(longitude), latitude] },
  }
}

function formattedDegrees(value: number, direction: 'latitude' | 'longitude') {
  const rounded = Number(Math.abs(value).toFixed(6))
  if (rounded === 0) return '0°'
  if (direction === 'longitude' && Math.abs(rounded - 180) < 1e-6) return '180°'
  return `${rounded}°${direction === 'latitude' ? value > 0 ? 'N' : 'S' : value > 0 ? 'E' : 'W'}`
}

function bestLabelPosition(map: MapLibreMap, coordinates: [number, number][], kind: 'latitude' | 'longitude') {
  const { clientWidth: width, clientHeight: height } = map.getContainer()
  const insetX = Math.min(width * 0.16, 100)
  const insetY = Math.min(height * 0.19, 110)
  const targetX = kind === 'latitude' ? width * 0.25 : width * 0.5
  const targetY = kind === 'latitude' ? height * 0.5 : height * 0.70
  let best: [number, number] | null = null
  let score = Infinity
  for (const [longitude, latitude] of coordinates) {
    const screen = isSurfacePoint(map, longitude, latitude)
    if (!screen || screen.x < insetX || screen.x > width - insetX || screen.y < insetY || screen.y > height - insetY) continue
    const distance = Math.abs(screen.x - targetX) / width + Math.abs(screen.y - targetY) / height
    if (distance < score) { score = distance; best = [longitude, latitude] }
  }
  return best
}

function lineCounts(region: Region, interval: number) {
  return Math.max(0, Math.floor(region.east / interval) - Math.ceil(region.west / interval) + 1)
    + Math.max(0, Math.floor(region.north / interval) - Math.ceil(region.south / interval) + 1)
}

function buildGrid(map: MapLibreMap, view: MapView): FeatureCollection<LineString | Point, GridProperties> {
  let interval = chooseInterval(map, view)
  let region = visibleRegion(map, view, interval)
  let position = INTERVALS.indexOf(interval)
  while (position > 0 && lineCounts(region, interval) > MAX_LINES) {
    interval = INTERVALS[--position]
    region = visibleRegion(map, view, interval)
  }
  if (region.south >= region.north || region.west >= region.east) return EMPTY_GRID
  const lines: GridFeature[] = []
  const labels: GridFeature[] = []
  let vertices = 0
  const latitudeStart = Math.ceil(region.south / interval)
  const latitudeEnd = Math.floor(region.north / interval)
  const longitudeStart = Math.ceil(region.west / interval)
  const longitudeEnd = Math.floor(region.east / interval)
  const sampleStep = Math.min(1, Math.max(interval / 2, Math.max(region.east - region.west, region.north - region.south) / 256))
  for (let index = latitudeStart; index <= latitudeEnd; index++) {
    const latitude = Number((index * interval).toFixed(6))
    const axis = latitude === 0
    const candidates: [number, number][] = []
    const firstWorld = Math.floor((region.west + 180) / 360)
    const lastWorld = Math.floor((region.east + 180) / 360)
    for (let world = firstWorld; world <= lastWorld; world++) {
      const west = Math.max(region.west, world * 360 - 180)
      const east = Math.min(region.east, world * 360 + 180)
      if (east - west <= 1e-9) continue
      const points: [number, number][] = coordinateSequence(west, east, sampleStep)
        .map((longitude) => [longitude - world * 360, latitude])
      vertices += points.length
      if (vertices <= MAX_VERTICES) lines.push(lineFeature(points, axis))

      const stride = Math.max(1, Math.ceil(points.length / 25))
      for (let point = 0; point < points.length; point += stride) {
        candidates.push([points[point][0], latitude])
      }
    }
    const best = bestLabelPosition(map, candidates, 'latitude')
    if (best) labels.push(labelFeature(best[0], latitude, formattedDegrees(latitude, 'latitude'), axis))
  }
  const visitedMeridians = new Set<number>()
  for (let index = longitudeStart; index <= longitudeEnd; index++) {
    const longitude = index * interval
    const canonical = wrapLongitude(longitude)
    const key = Number(canonical.toFixed(6))
    if (visitedMeridians.has(key)) continue
    visitedMeridians.add(key)
    const axis = Math.abs(canonical) < 1e-9
    const points: [number, number][] = coordinateSequence(region.south, region.north, sampleStep)
      .map((latitude) => [canonical, latitude])
    vertices += points.length
    if (vertices <= MAX_VERTICES) lines.push(lineFeature(points, axis))
    const stride = Math.max(1, Math.ceil(points.length / 25))
    const candidates = points.filter((_, point) => point % stride === 0)
    const best = bestLabelPosition(map, candidates, 'longitude')
    if (best) labels.push(labelFeature(canonical, best[1], formattedDegrees(canonical, 'longitude'), axis))
  }
  return { type: 'FeatureCollection', features: [...lines, ...labels] }
}

export function createGraticuleController(map: MapLibreMap, getView: () => MapView, initiallyEnabled = false) {
  let enabled = initiallyEnabled
  let destroyed = false
  let frame = 0
  const source = () => map.getSource(GRATICULE_SOURCE_ID) as GeoJSONSource | undefined
  function setLayersVisible(value: boolean) {
    for (const id of GRATICULE_LAYER_IDS) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', value ? 'visible' : 'none')
    }
  }
  function update() {
    frame = 0
    if (destroyed || !enabled || !source()) return
    void source()!.setData(buildGrid(map, getView()))
  }
  function refresh() {
    if (destroyed || !enabled || frame) return
    frame = requestAnimationFrame(update)
  }
  function setEnabled(value: boolean) {
    if (destroyed) return
    enabled = value
    setLayersVisible(value)
    if (value) refresh()
    else {
      cancelAnimationFrame(frame)
      frame = 0
      void source()?.setData(EMPTY_GRID)
    }
  }
  map.on('moveend', refresh)
  map.on('resize', refresh)
  setEnabled(initiallyEnabled)
  return {
    setEnabled,
    refresh,
    destroy() {
      destroyed = true
      cancelAnimationFrame(frame)
      map.off('moveend', refresh)
      map.off('resize', refresh)
    },
  }
}
