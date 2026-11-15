import type { Feature, FeatureCollection, Geometry } from 'geojson'
import geographicLib from 'geographiclib-geodesic'
import {
  Marker,
  type GeoJSONSource,
  type Map as MapLibreMap,
  type MapMouseEvent,
  type MapTouchEvent,
} from 'maplibre-gl'
import {
  geodesicDistanceKm,
  geodesicPath,
  geodesicPolygonAccumulator,
  geodesicSegment,
  closeGeodesicRing,
  hasCrossingPaths,
  type GeodesicSegment,
  type GeographicPosition,
} from '@/lib/geodesy'
import { polygonInteriorPoint, polygonContainsPoint } from '@/lib/polygon-label'
import {
  measurementUnits,
  type MeasurementMode,
  type MeasurementUnit,
} from '@/lib/measurement-units'
import { FIRE_LAYER_BEFORE_ID } from './geography'
import {
  measurementLabelScale,
  measurementLabelSize,
  measurementLabelOpacity,
  measurementLabelSizeExpression,
  measurementLabelOpacityExpression,
  type MeasurementLabelScale,
} from './measurement-labels'
import {
  DEFAULT_MEASUREMENT_COLORS,
  isMeasurementColor,
  measurementColorValue,
  type MeasurementColor,
  type MeasurementColors,
} from './measurement-colors'
import {
  loadFinishedMeasurements,
  persistFinishedMeasurements,
  MEASUREMENT_NAME_LIMIT,
  type StoredMeasurement,
} from './measurement-storage'
import './measurement-controller.css'

export type MeasurementState = {
  mode: 'orbit' | MeasurementMode
  canUndo: boolean
  canClear: boolean
  canFinish: boolean
  value: number
  text: string
  pointCount: number
  finished: boolean
  error: string | null
}

export type MeasurementTarget = {
  id: string
  mode: MeasurementMode
  name: string
  color: MeasurementColor
  unit: MeasurementUnit
  
  text: string
}

export type MeasurementVertexHit = { measurementId: string; index: number }

export type MeasurementController = {
  setMode: (mode: 'orbit' | MeasurementMode) => void
  setUnit: (unit: MeasurementUnit) => void
  setColors: (colors: MeasurementColors) => void
  undo: () => void
  clear: () => void
  finish: () => void
  cancelDrawing: () => boolean
  findVertex: (point: { x: number; y: number }, radius?: number) => MeasurementVertexHit | null
  findMeasurement: (point: { x: number; y: number }, radius?: number) => MeasurementTarget | null
  getMeasurement: (id: string) => MeasurementTarget | null
  selectMeasurement: (id: string | null) => void
  deleteMeasurement: (id: string) => void
  renameMeasurement: (id: string, name: string) => void
  recolorMeasurement: (id: string, color: MeasurementColor) => void
  removeVertex: (hit: MeasurementVertexHit) => void
  destroy: () => void
}

type CachedGeometry = {
  segments: GeodesicSegment[]
  openPath: GeographicPosition[]
  boundary: GeographicPosition[]
  ring: GeographicPosition[]
  accumulator: ReturnType<typeof geodesicPolygonAccumulator>
  distanceKm: number
  crossing: boolean
  hasPolarGeometry: boolean
  labelAnchor: GeographicPosition | null
}
type Shape = StoredMeasurement & { finished: boolean; cache: CachedGeometry }
type MeasurementLabel = {
  id: string
  kind: 'segment-label' | 'area-label'
  point: GeographicPosition
  text: string
  name: string
  valueText: string
  scale: MeasurementLabelScale
}
type ScreenPoint = { x: number; y: number }
type VertexDrag = {
  measurementId: string
  index: number
  original: GeographicPosition
  offset: ScreenPoint
  pending: GeographicPosition | null
  touchId: number | null
  viewport: { left: number; top: number; scaleX: number; scaleY: number }
}
const SOURCE = 'measurements'
const PREVIEW_SOURCE = 'measurement-preview-geometry'
const LAYERS = [
  'measurement-area',
  'measurement-line-halo',
  'measurement-line',
  'measurement-preview-halo',
  'measurement-preview',
  'measurement-vertices',
  'measurement-segment-labels',
  'measurement-area-label',
]
const empty: FeatureCollection = { type: 'FeatureCollection', features: [] }
const previewInterval = 1_000 / 30
const VERTEX_HIT_RADIUS = 14
const MAX_VECTOR_LATITUDE = 85.0511287798066
const rounded = new Intl.NumberFormat('en', { maximumFractionDigits: 2 })
const precise = new Intl.NumberFormat('en', { maximumFractionDigits: 4 })




export function createMeasurementController(
  map: MapLibreMap,
  options: {
    onChange: (state: MeasurementState) => void
    colors?: MeasurementColors
    onStorageError?: (message: string) => void
  },
): MeasurementController {
  let mode: 'orbit' | MeasurementMode = 'orbit'
  let geometryMode: MeasurementMode = 'ruler'
  let cursor: GeographicPosition | null = null
  let cursorPoint: { x: number; y: number } | null = null
  let scheduledFrame = 0
  let scheduledTimer: ReturnType<typeof setTimeout> | undefined
  let previewDirty = false
  let previewHasGeometry = false
  let previewVisible = false
  let lastPreviewTime = -Infinity
  let destroyed = false
  let drag: VertexDrag | null = null
  let hoveredVertex: MeasurementVertexHit | null = null
  let suppressClick = false
  let selectedId: string | null = null
  let editError: string | null = null
  let storageWarningShown = false
  const segmentCache = new Map<string, GeodesicSegment>()
  const polarLabels = new Map<
    string,
    {
      marker: Marker
      element: HTMLDivElement
      scale: MeasurementLabelScale
      name: string
      valueText: string
    }
  >()
  const labelMeasure = document.createElement('canvas').getContext('2d')
  const defaults = {
    colors: { ...DEFAULT_MEASUREMENT_COLORS, ...options.colors },
    units: { ruler: 'km', area: 'ha' } as Record<MeasurementMode, MeasurementUnit>,
  }
  const drafts: Record<MeasurementMode, Shape> = {
    ruler: newDraft('ruler'),
    area: newDraft('area'),
  }
  const finished = new Map<string, Shape>()
  const renderedShapes = new Map<
    string,
    { features: Feature<Geometry>[]; labels: MeasurementLabel[] }
  >()
  const canvas = map.getCanvas()
  const container = map.getContainer()
  const previousCursor = canvas.style.cursor
  const doubleClickZoomEnabled = map.doubleClickZoom.isEnabled()
  const readout = document.createElement('output')
  readout.className = 'measurement-cursor-readout'
  readout.hidden = true
  readout.setAttribute('aria-hidden', 'true')
  container.append(readout)
  
  let containerWidth = container.clientWidth,
    containerHeight = container.clientHeight
  let readoutWidth = 150,
    readoutHeight = 26
  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const box = entry.borderBoxSize[0]
      const width = box?.inlineSize ?? entry.contentRect.width
      const height = box?.blockSize ?? entry.contentRect.height
      if (entry.target === container) {
        containerWidth = width
        containerHeight = height
        updatePolarLabelAppearance()
      } else if (width > 0 && height > 0) {
        readoutWidth = width
        readoutHeight = height
      }
    }
    if (cursorPoint) requestFrame()
  })
  observer.observe(container)
  observer.observe(readout)

  map.addSource(SOURCE, { type: 'geojson', data: empty, maxzoom: 20, tolerance: 0.01 })
  map.addSource(PREVIEW_SOURCE, { type: 'geojson', data: empty, maxzoom: 20, tolerance: 0.01 })
  const committedWriter = latestSourceWriter(map, SOURCE, () => {
    if (drag?.pending && !destroyed) requestFrame()
  })
  const previewWriter = latestSourceWriter(map, PREVIEW_SOURCE, () => {
    if (destroyed) return
    setPreviewVisible(
      previewHasGeometry && !drag && !!cursor && mode !== 'orbit' && draft().points.length > 0,
    )
    if (previewDirty) requestFrame()
  })
  const before = map.getLayer(FIRE_LAYER_BEFORE_ID) ? FIRE_LAYER_BEFORE_ID : undefined
  map.addLayer(
    {
      id: LAYERS[0],
      type: 'fill',
      source: SOURCE,
      filter: ['==', 'kind', 'area'],
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.2 },
    },
    before,
  )
  map.addLayer(
    {
      id: LAYERS[1],
      type: 'line',
      source: SOURCE,
      filter: ['==', 'kind', 'path'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#07173f', 'line-width': 4.5, 'line-opacity': 0.8 },
    },
    before,
  )
  map.addLayer(
    {
      id: LAYERS[2],
      type: 'line',
      source: SOURCE,
      filter: ['==', 'kind', 'path'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': 2 },
    },
    before,
  )
  for (const halo of [true, false])
    map.addLayer(
      {
        id: halo ? LAYERS[3] : LAYERS[4],
        type: 'line',
        source: PREVIEW_SOURCE,
        layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' },
        paint: halo
          ? { 'line-color': '#07173f', 'line-width': 4.5, 'line-opacity': 0.8 }
          : { 'line-color': ['get', 'color'], 'line-width': 2, 'line-dasharray': [3, 2] },
      },
      before,
    )
  map.addLayer(
    {
      id: LAYERS[5],
      type: 'circle',
      source: SOURCE,
      filter: ['==', 'kind', 'vertex'],
      paint: {
        'circle-radius': ['case', ['==', ['get', 'index'], 0], 5, 4],
        'circle-color': ['get', 'color'],
        'circle-stroke-color': '#07173f',
        'circle-stroke-width': 2,
      },
    },
    before,
  )
  
  
  for (const area of [false, true])
    map.addLayer({
      id: area ? LAYERS[7] : LAYERS[6],
      type: 'symbol',
      source: SOURCE,
      filter: ['all', ['==', 'kind', area ? 'area-label' : 'segment-label'], ['!=', 'polar', true]],
      layout: {
        'text-field': ['get', 'label'],
        'text-font': ['Fira Sans'],
        'text-size': measurementLabelSizeExpression,
        'text-anchor': area ? 'center' : 'bottom',
        'text-offset': area
          ? [0, 0]
          : [
              'case',
              ['==', ['get', 'isTotal'], true],
              ['literal', [0, -1.6]],
              ['literal', [0, -0.45]],
            ],
        'text-max-width': 12,
        'text-allow-overlap': true,
        'text-ignore-placement': true,
        'text-pitch-alignment': 'viewport',
        'text-rotation-alignment': 'viewport',
      },
      paint: {
        'text-color': '#ffffff',
        'text-halo-color': '#07173f',
        'text-halo-width': 1.5,
        'text-opacity': measurementLabelOpacityExpression,
      },
    })

  function newDraft(tool: MeasurementMode): Shape {
    return {
      id: crypto.randomUUID(),
      mode: tool,
      name: '',
      points: [],
      finished: false,
      unit: defaults.units[tool],
      color: defaults.colors[tool],
      cache: blankCache(),
    }
  }

  function draft() {
    return drafts[geometryMode]
  }

  function getShape(id: string) {
    return (
      finished.get(id) ??
      (drafts.ruler.id === id ? drafts.ruler : drafts.area.id === id ? drafts.area : null)
    )
  }

  function allShapes() {
    return [
      ...finished.values(),
      ...Object.values(drafts).filter((current) => current.points.length),
    ]
  }

  function shape() {
    return (
      (drag ? getShape(drag.measurementId) : null) ??
      (draft().points.length ? draft() : selectedId ? finished.get(selectedId) : null) ??
      draft()
    )
  }

  function storageError(message: string) {
    if (storageWarningShown) return
    storageWarningShown = true
    options.onStorageError?.(message)
  }

  function persist() {
    if (!persistFinishedMeasurements([...finished.values()]))
      storageError(
        'Measurements could not be saved in this browser. They remain on the map until you close or reload the page.',
      )
  }

  function setPreviewVisible(visible: boolean) {
    if (previewVisible === visible) return
    previewVisible = visible
    for (const layer of [LAYERS[3], LAYERS[4]])
      map.setLayoutProperty(layer, 'visibility', visible ? 'visible' : 'none')
  }

  function canFinish(current: Shape) {
    if (current.points.length < (current.mode === 'area' ? 3 : 2) || current.cache.crossing)
      return false
    const value =
      current.mode === 'area'
        ? Math.abs(current.cache.accumulator.signedAreaKm2)
        : current.cache.distanceKm
    return Number.isFinite(value) && value > (current.mode === 'area' ? 1e-8 : 0)
  }

  function updatePointerCursor() {
    canvas.style.cursor = drag
      ? 'grabbing'
      : hoveredVertex !== null
        ? 'grab'
        : mode === 'orbit'
          ? previousCursor
          : 'crosshair'
    canvas.classList.toggle('measurement-vertex-dragging', drag !== null)
  }

  


  function vertexScreenPosition(
    point: GeographicPosition,
    near: ScreenPoint,
    maxDistance = Infinity,
  ): ScreenPoint | null {
    if (Math.abs(point[1]) > MAX_VECTOR_LATITUDE) return null
    const longitude = map.unproject([near.x, near.y]).lng
    const wrap = Math.round((longitude - point[0]) / 360)
    let best: ScreenPoint | null = null
    let distance = Infinity
    for (const copy of [wrap, wrap - 1, wrap + 1]) {
      const projected = map.project([point[0] + copy * 360, point[1]])
      const candidateDistance = Math.hypot(projected.x - near.x, projected.y - near.y)
      if (
        candidateDistance > maxDistance ||
        candidateDistance >= distance ||
        projected.x < 0 ||
        projected.y < 0 ||
        projected.x > containerWidth ||
        projected.y > containerHeight
      )
        continue
      const visible = map.unproject(projected).wrap()
      if (geodesicDistanceKm(point, [visible.lng, visible.lat]) > 0.01) continue
      best = projected
      distance = candidateDistance
    }
    return best
  }

  function findVertex(point: ScreenPoint, radius = VERTEX_HIT_RADIUS): MeasurementVertexHit | null {
    if (
      destroyed ||
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y) ||
      !Number.isFinite(radius) ||
      radius < 0
    )
      return null
    let nearest: MeasurementVertexHit | null = null
    let distance = radius
    for (const current of allShapes())
      for (const [index, position] of current.points.entries()) {
        const projected = vertexScreenPosition(position, point, distance)
        if (!projected) continue
        const next = Math.hypot(projected.x - point.x, projected.y - point.y)
        if (next <= distance) {
          nearest = { measurementId: current.id, index }
          distance = next
        }
      }
    return nearest
  }

  function target(current: Shape): MeasurementTarget {
    const value =
      current.mode === 'area'
        ? Math.abs(current.cache.accumulator.signedAreaKm2)
        : current.cache.distanceKm
    return {
      id: current.id,
      mode: current.mode,
      name: current.name,
      color: current.color,
      unit: current.unit,
      text: formatMeasurement(value, current.unit),
    }
  }

  function findMeasurement(point: ScreenPoint, radius = 10): MeasurementTarget | null {
    if (destroyed || !Number.isFinite(radius) || radius < 0) return null
    const geographic = positionAtPoint(point)
    if (!geographic) return null
    const candidates = new Set(
      map
        .queryRenderedFeatures(
          [
            [point.x - radius, point.y - radius],
            [point.x + radius, point.y + radius],
          ],
          { layers: [LAYERS[0], LAYERS[2]] },
        )
        .map((item) => item.properties.measurementId as string),
    )
    const pointerLongitude = map.unproject([point.x, point.y]).lng
    let nearest: Shape | null = null
    let distance = radius
    for (const current of [...finished.values()].reverse()) {
      if (!candidates.has(current.id) && !current.cache.hasPolarGeometry) continue
      const path = current.mode === 'area' ? current.cache.boundary : current.cache.openPath
      for (let index = 1; index < path.length; index++) {
        const from = path[index - 1],
          to = path[index]
        
        
        const wrap = Math.round((pointerLongitude - (from[0] + to[0]) / 2) / 360) * 360
        const project = (position: GeographicPosition) => {
          const result = map.project([position[0] + wrap, position[1]])
          const back = map.unproject(result).wrap()
          return geodesicDistanceKm(position, [back.lng, back.lat]) <= 0.01 ? result : null
        }
        const a = project(from),
          b = project(to)
        if (!a || !b) continue
        const next = pointSegmentDistance(point, a, b)
        if (next < distance || (!nearest && next <= distance)) {
          nearest = current
          distance = next
        }
      }
    }
    if (nearest) return target(nearest)
    
    
    for (const current of [...finished.values()].reverse()) {
      if (
        current.mode === 'area' &&
        !current.cache.crossing &&
        (candidates.has(current.id) || current.cache.hasPolarGeometry) &&
        polygonContainsPoint(geographic, current.points)
      )
        return target(current)
    }
    return null
  }

  function positionAtPoint(point: ScreenPoint): GeographicPosition | null {
    if (point.x < 0 || point.y < 0 || point.x > containerWidth || point.y > containerHeight)
      return null
    const location = map.unproject([point.x, point.y])
    const projected = map.project(location)
    if (
      !Number.isFinite(location.lng) ||
      !Number.isFinite(location.lat) ||
      Math.hypot(projected.x - point.x, projected.y - point.y) > 1
    )
      return null
    const wrapped = location.wrap()
    return [wrapped.lng, Math.max(-90, Math.min(90, wrapped.lat))]
  }

  function getSegment(from: GeographicPosition, to: GeographicPosition) {
    const key = `${from[0]},${from[1]}/${to[0]},${to[1]}`
    let segment = segmentCache.get(key)
    if (!segment) {
      segment = geodesicSegment(from, to)
      if (segmentCache.size >= 2_048) segmentCache.delete(segmentCache.keys().next().value!)
      segmentCache.set(key, segment)
    }
    return segment
  }

  function rebuild(current: Shape) {
    renderedShapes.delete(current.id)
    const segments: GeodesicSegment[] = []
    for (let index = 1; index < current.points.length; index++)
      segments.push(getSegment(current.points[index - 1], current.points[index]))
    const paths = segments.map((segment) => segment.path)
    const openPath = joinPaths(paths)
    const closedPaths =
      current.mode === 'area' && current.points.length >= 2
        ? [...paths, getSegment(current.points.at(-1)!, current.points[0]).path]
        : paths
    const boundary = joinPaths(closedPaths)
    const accumulator = geodesicPolygonAccumulator(current.points)
    const ring =
      current.mode === 'area' && current.points.length >= 3
        ? closeGeodesicRing(boundary, accumulator.signedAreaKm2)
        : []
    current.cache = {
      segments,
      openPath,
      boundary,
      ring,
      accumulator,
      distanceKm: segments.reduce((total, segment) => total + segment.distanceKm, 0),
      crossing:
        current.mode === 'area' && current.points.length >= 4 && hasCrossingPaths(closedPaths),
      
      
      hasPolarGeometry:
        boundary.some((position) => Math.abs(position[1]) > MAX_VECTOR_LATITUDE) ||
        ring.some((position) => Math.abs(position[1]) > MAX_VECTOR_LATITUDE),
      labelAnchor: null,
    }
  }

  function renderShape(current: Shape) {
    const cached = renderedShapes.get(current.id)
    if (cached) return cached
    const cache = current.cache
    const features: Feature<Geometry>[] = []
    const labels: MeasurementLabel[] = []
    const properties = {
      measurementId: current.id,
      mode: current.mode,
      name: current.name,
      color: measurementColorValue(current.color),
      finished: current.finished,
    }
    function add(
      kind: string,
      geometry: Geometry,
      id: string,
      extra: Record<string, unknown> = {},
    ) {
      features.push({
        ...feature(kind, geometry, `${current.id}:${id}`),
        properties: { ...properties, kind, ...extra },
      })
    }
    function label(
      kind: MeasurementLabel['kind'],
      point: GeographicPosition,
      id: string,
      value: number,
      name = '',
    ) {
      const valueText = formatMeasurement(value, current.unit)
      const text = namedLabel(name, valueText)
      const scale = measurementLabelScale(value, current.mode === 'area')
      labels.push({ id: `${current.id}:${id}`, kind, point, text, name, valueText, scale })
      add(kind, { type: 'Point', coordinates: point }, id, {
        label: text,
        value,
        isTotal: id === 'total-label',
        ...scale,
        polar: Math.abs(point[1]) > 85,
      })
    }
    if (current.mode === 'area' && current.points.length >= 3 && !cache.crossing)
      add('area', { type: 'Polygon', coordinates: [cache.ring] }, 'area')
    const path = current.mode === 'area' ? cache.boundary : cache.openPath
    if (path.length >= 2) add('path', { type: 'LineString', coordinates: path }, 'path')
    for (const [index, point] of current.points.entries())
      add('vertex', { type: 'Point', coordinates: point }, `vertex-${index}`, { index })
    if (current.mode === 'ruler') {
      for (const [index, segment] of cache.segments.entries()) {
        label(
          'segment-label',
          segment.midpoint,
          `segment-label-${index}`,
          segment.distanceKm,
          cache.segments.length === 1 ? current.name : '',
        )
      }
      if (current.name && cache.segments.length > 1)
        label(
          'segment-label',
          pathMidpoint(cache.segments),
          'total-label',
          cache.distanceKm,
          current.name,
        )
    } else if (current.finished && !cache.crossing && cache.labelAnchor) {
      label(
        'area-label',
        cache.labelAnchor,
        'area-label',
        Math.abs(cache.accumulator.signedAreaKm2),
        current.name,
      )
    }
    const result = { features, labels }
    renderedShapes.set(current.id, result)
    return result
  }

  function writeCommitted() {
    const features: Feature<Geometry>[] = []
    const labels: MeasurementLabel[] = []
    for (const current of allShapes()) {
      const rendered = renderShape(current)
      features.push(...rendered.features)
      labels.push(...rendered.labels)
    }
    reconcilePolarLabels(labels)
    committedWriter.write({ type: 'FeatureCollection', features })
  }

  function namedLabel(name: string, value: string, size = 0) {
    let display = name.length > 24 ? `${name.slice(0, 23)}…` : name
    if (size && display && labelMeasure) {
      labelMeasure.font = `400 ${size}px "Fira Sans"`
      const width = Math.max(100, Math.min(320, containerWidth - 24))
      while (display.length > 2 && labelMeasure.measureText(`${display} - ${value}`).width > width)
        display = `${display.replace(/…$/, '').slice(0, -1)}…`
      if (labelMeasure.measureText(`${display} - ${value}`).width > width) display = ''
    }
    return display ? `${display} - ${value}` : value
  }

  function reconcilePolarLabels(labels: MeasurementLabel[]) {
    const desired = new Set(
      labels.filter((label) => Math.abs(label.point[1]) > 85).map((label) => label.id),
    )
    for (const [id, current] of polarLabels)
      if (!desired.has(id)) {
        current.marker.remove()
        polarLabels.delete(id)
      }
    for (const label of labels) {
      if (!desired.has(label.id)) continue
      let current = polarLabels.get(label.id)
      if (!current) {
        const element = document.createElement('div')
        element.className = 'measurement-polar-label'
        element.dataset.kind = label.kind
        const marker = new Marker({
          element,
          anchor: label.kind === 'area-label' ? 'center' : 'bottom',
          offset:
            label.kind === 'area-label'
              ? [0, 0]
              : label.id.endsWith(':total-label')
                ? [0, -32]
                : [0, -8],
          opacity: measurementLabelOpacity(label.scale, map.getZoom()),
          opacityWhenCovered: 0,
        })
          .setLngLat(label.point)
          .addTo(map)
        current = {
          marker,
          element,
          scale: label.scale,
          name: label.name,
          valueText: label.valueText,
        }
        polarLabels.set(label.id, current)
      }
      current.element.textContent = label.text
      current.element.dataset.longitude = String(label.point[0])
      current.element.dataset.latitude = String(label.point[1])
      current.scale = label.scale
      current.name = label.name
      current.valueText = label.valueText
      current.marker.setLngLat(label.point)
    }
    updatePolarLabelAppearance()
  }

  function updatePolarLabelAppearance() {
    const zoom = map.getZoom()
    for (const { marker, element, scale, name, valueText } of polarLabels.values()) {
      const size = measurementLabelSize(scale, zoom)
      element.style.fontSize = `${size}px`
      element.textContent = namedLabel(name, valueText, size)
      marker.setOpacity(measurementLabelOpacity(scale, zoom), 0)
    }
  }

  function publish() {
    const current = shape(),
      cache = current.cache
    const value =
      current.mode === 'area' ? Math.abs(cache.accumulator.signedAreaKm2) : cache.distanceKm
    const error =
      editError ??
      (cache.crossing ? 'Edges cross. Move or remove a point to measure this area.' : null)
    options.onChange({
      mode,
      canUndo: current.points.length > 0,
      canClear: current.points.length > 0,
      canFinish: !current.finished && canFinish(current),
      value: cache.crossing ? 0 : value,
      text: current.points.length ? (error ?? formatMeasurement(value, current.unit)) : '',
      pointCount: current.points.length,
      finished: current.finished,
      error,
    })
  }

  function validPosition(event: MapMouseEvent): GeographicPosition | null {
    const projected = map.project(event.lngLat)
    if (Math.hypot(projected.x - event.point.x, projected.y - event.point.y) > 1) return null
    const { lng, lat } = event.lngLat.wrap()
    return Number.isFinite(lng) && Number.isFinite(lat)
      ? [lng, Math.max(-90, Math.min(90, lat))]
      : null
  }

  function updateReadout() {
    const current = shape()
    if (drag) {
      if (!cursorPoint || current.points.length < (current.mode === 'area' ? 3 : 2)) {
        readout.hidden = true
        return
      }
      const value =
        current.mode === 'area'
          ? Math.abs(current.cache.accumulator.signedAreaKm2)
          : current.cache.distanceKm
      showReadout(
        current.cache.crossing
          ? 'Edges cross - Move or remove a point'
          : formatMeasurement(value, current.unit),
      )
      return
    }
    if (!cursor || !cursorPoint || mode === 'orbit' || current.finished || !current.points.length) {
      readout.hidden = true
      return
    }
    const value =
      current.mode === 'area'
        ? Math.abs(current.cache.accumulator.previewSignedAreaKm2(cursor))
        : current.cache.distanceKm + geodesicDistanceKm(current.points.at(-1)!, cursor)
    const text = current.cache.crossing
      ? 'Edges cross - Move or remove a point'
      : formatMeasurement(value, current.unit)
    showReadout(text)
  }

  function showReadout(text: string) {
    if (!cursorPoint) return
    if (readout.textContent !== text) readout.textContent = text
    readout.hidden = false
    const x = Math.max(8, Math.min(cursorPoint.x + 15, containerWidth - readoutWidth - 8))
    const y = Math.max(
      8,
      Math.min(cursorPoint.y - readoutHeight - 7, containerHeight - readoutHeight - 8),
    )
    readout.style.transform = `translate3d(${x}px, ${y}px, 0)`
  }

  function writePreview() {
    const current = draft()
    if (drag || !cursor || mode === 'orbit' || current.finished || !current.points.length) {
      previewHasGeometry = false
      setPreviewVisible(false)
      previewWriter.write(empty)
      return
    }
    
    
    const points =
      current.mode === 'area' && current.points.length >= 2
        ? [current.points.at(-1)!, cursor, current.points[0]]
        : [current.points.at(-1)!, cursor]
    previewHasGeometry = true
    previewWriter.write({
      type: 'FeatureCollection',
      features: [
        {
          ...feature('preview', { type: 'LineString', coordinates: geodesicPath(points) }),
          properties: {
            kind: 'preview',
            measurementId: current.id,
            color: measurementColorValue(current.color),
          },
        },
      ],
    })
  }

  function requestFrame() {
    if (scheduledFrame || destroyed) return
    scheduledFrame = requestAnimationFrame((now) => {
      scheduledFrame = 0
      if (destroyed) return
      if (drag?.pending) {
        if (!committedWriter.busy) {
          const wait = previewInterval - (now - lastPreviewTime)
          if (wait > 0) {
            if (scheduledTimer === undefined)
              scheduledTimer = setTimeout(() => {
                scheduledTimer = undefined
                requestFrame()
              }, wait)
          } else {
            lastPreviewTime = now
            applyDragPosition(drag)
          }
        }
        updateReadout()
        return
      }
      updateReadout()
      if (drag) return
      if (!previewDirty || previewWriter.busy) return
      const wait = previewInterval - (now - lastPreviewTime)
      if (wait > 0) {
        if (scheduledTimer === undefined)
          scheduledTimer = setTimeout(() => {
            scheduledTimer = undefined
            requestFrame()
          }, wait)
        return
      }
      previewDirty = false
      lastPreviewTime = now
      writePreview()
    })
  }

  function clearCursor() {
    cursor = null
    cursorPoint = null
    previewDirty = false
    previewHasGeometry = false
    
    
    setPreviewVisible(false)
    readout.hidden = true
    clearTimeout(scheduledTimer)
    scheduledTimer = undefined
    
    
    previewWriter.write(empty)
  }

  function applyDragPosition(active: VertexDrag) {
    if (!active.pending) return
    const current = getShape(active.measurementId)
    if (!current) return
    current.points[active.index] = active.pending
    active.pending = null
    rebuild(current)
    
    
    
    if (current.mode === 'area' && current.finished && !current.cache.crossing) {
      current.cache.labelAnchor = polygonInteriorPoint(current.points, current.cache.boundary)
    }
    writeCommitted()
  }

  function dragAt(clientX: number, clientY: number) {
    if (!drag) return
    const { viewport, offset } = drag
    cursorPoint = {
      x: (clientX - viewport.left) * viewport.scaleX,
      y: (clientY - viewport.top) * viewport.scaleY,
    }
    const point = positionAtPoint({ x: cursorPoint.x + offset.x, y: cursorPoint.y + offset.y })
    if (point) drag.pending = point
    requestFrame()
  }

  function onDragMouseMove(event: MouseEvent) {
    if (!drag || drag.touchId !== null) return
    if (!(event.buttons & 1)) {
      endDrag()
      return
    }
    event.preventDefault()
    dragAt(event.clientX, event.clientY)
  }

  function onDragMouseUp(event: MouseEvent) {
    if (!drag || drag.touchId !== null || event.button !== 0) return
    dragAt(event.clientX, event.clientY)
    endDrag()
  }

  function onDragTouchMove(event: TouchEvent) {
    if (!drag || drag.touchId === null) return
    
    
    if (event.touches.length !== 1) {
      endDrag(true)
      return
    }
    const touch = [...event.touches].find((item) => item.identifier === drag?.touchId)
    if (!touch) return
    if (event.cancelable) event.preventDefault()
    dragAt(touch.clientX, touch.clientY)
  }

  function onDragTouchEnd(event: TouchEvent) {
    if (!drag || drag.touchId === null) return
    const touch = [...event.changedTouches].find((item) => item.identifier === drag?.touchId)
    if (!touch) return
    dragAt(touch.clientX, touch.clientY)
    endDrag()
  }

  function onDragCancel() {
    endDrag(true)
  }
  function onDragKeyDown(event: KeyboardEvent) {
    if (!drag || event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    endDrag(true)
  }

  function beginDrag(hit: MeasurementVertexHit, point: ScreenPoint, touchId: number | null) {
    const current = getShape(hit.measurementId)
    if (!current) return
    const original = current.points[hit.index]
    const projected = vertexScreenPosition(original, point)
    if (!projected) return
    map.stop()
    clearCursor()
    selectedId = finished.has(current.id) ? current.id : null
    editError = null
    const rect = canvas.getBoundingClientRect()
    drag = {
      measurementId: current.id,
      index: hit.index,
      original: [...original],
      pending: null,
      touchId,
      offset: { x: projected.x - point.x, y: projected.y - point.y },
      viewport: {
        left: rect.left,
        top: rect.top,
        scaleX: canvas.clientWidth / rect.width,
        scaleY: canvas.clientHeight / rect.height,
      },
    }
    hoveredVertex = hit
    suppressClick = true
    cursorPoint = point
    updatePointerCursor()
    window.addEventListener('mousemove', onDragMouseMove, true)
    window.addEventListener('mouseup', onDragMouseUp, true)
    window.addEventListener('touchmove', onDragTouchMove, { capture: true, passive: false })
    window.addEventListener('touchend', onDragTouchEnd, true)
    window.addEventListener('touchcancel', onDragCancel, true)
    window.addEventListener('pointercancel', onDragCancel, true)
    window.addEventListener('blur', onDragCancel)
    window.addEventListener('keydown', onDragKeyDown, true)
  }

  function endDrag(cancelled = false) {
    if (!drag) return
    const active = drag
    if (!destroyed) {
      if (cancelled) {
        active.pending = active.original
        applyDragPosition(active)
      } else applyDragPosition(active)
      const current = getShape(active.measurementId)
      if (!cancelled && current?.finished && !canFinish(current)) {
        active.pending = active.original
        applyDragPosition(active)
        editError = 'That move would make an invalid measurement. The point was restored.'
      }
      if (!cancelled && current?.finished) persist()
    }
    drag = null
    window.removeEventListener('mousemove', onDragMouseMove, true)
    window.removeEventListener('mouseup', onDragMouseUp, true)
    window.removeEventListener('touchmove', onDragTouchMove, true)
    window.removeEventListener('touchend', onDragTouchEnd, true)
    window.removeEventListener('touchcancel', onDragCancel, true)
    window.removeEventListener('pointercancel', onDragCancel, true)
    window.removeEventListener('blur', onDragCancel)
    window.removeEventListener('keydown', onDragKeyDown, true)
    hoveredVertex = null
    updatePointerCursor()
    if (!destroyed) {
      clearCursor()
      publish()
    }
  }

  
  
  
  function drawingToolActive() {
    return mode !== 'orbit'
  }

  function onMouseDown(event: MapMouseEvent) {
    if (drawingToolActive()) return
    if (event.originalEvent.button !== 0 || event.originalEvent.target !== canvas) return
    suppressClick = false
    if (event.defaultPrevented || event.originalEvent.defaultPrevented) return
    const index = findVertex(event.point)
    if (index === null) return
    
    
    event.preventDefault()
    event.originalEvent.preventDefault()
    beginDrag(index, event.point, null)
  }

  function onTouchStart(event: MapTouchEvent) {
    if (drawingToolActive()) return
    if (event.originalEvent.target !== canvas) return
    suppressClick = false
    if (drag) {
      event.preventDefault()
      endDrag(true)
      return
    }
    if (event.points.length !== 1 || event.defaultPrevented) return
    const index = findVertex(event.point, 22)
    if (index === null) return
    event.preventDefault()
    beginDrag(index, event.point, event.originalEvent.touches[0].identifier)
  }

  function onMove(event: MapMouseEvent) {
    if (drag) return
    hoveredVertex =
      drawingToolActive() || map.dragPan.isActive() || event.originalEvent.target !== canvas
        ? null
        : findVertex(event.point)
    updatePointerCursor()
    const current = draft()
    if (mode === 'orbit' || current.finished || !current.points.length) return
    cursor = validPosition(event)
    cursorPoint = cursor ? event.point : null
    previewDirty = true
    requestFrame()
  }

  function onLeave() {
    if (drag) return
    hoveredVertex = null
    updatePointerCursor()
    if (cursor || cursorPoint || previewDirty) clearCursor()
  }

  function onMapMoveStart() {
    endDrag(true)
    onLeave()
  }

  function onClick(event: MapMouseEvent) {
    if (suppressClick) {
      suppressClick = false
      event.preventDefault()
      return
    }
    if (drag || (!drawingToolActive() && findVertex(event.point) !== null)) return
    if (
      event.defaultPrevented ||
      event.originalEvent.defaultPrevented ||
      event.originalEvent.button !== 0 ||
      event.originalEvent.detail > 1 ||
      event.originalEvent.target !== canvas
    )
      return
    if (mode === 'orbit') {
      selectMeasurement(findMeasurement(event.point)?.id ?? null)
      return
    }
    const point = validPosition(event)
    if (!point) return
    const current = draft()
    if (current.points.length >= 3 && vertexScreenPosition(current.points[0], event.point, 18)) {
      if (current.mode === 'ruler') addPoint([...current.points[0]])
      finish()
      return
    }
    const snap = findVertex(event.point, 18)
    const snapped = snap ? getShape(snap.measurementId)?.points[snap.index] : null
    addPoint(snapped ? [...snapped] : point)
  }

  function addPoint(point: GeographicPosition) {
    if (mode === 'orbit' || !point.every(Number.isFinite) || Math.abs(point[1]) > 90) return
    const current = draft()
    selectedId = null
    editError = null
    const last = current.points.at(-1)
    if (last && geodesicDistanceKm(last, point) <= 0.000001) return
    current.points.push(point)
    clearCursor()
    rebuild(current)
    writeCommitted()
    publish()
  }

  function finish() {
    endDrag()
    const current = draft()
    if (mode === 'orbit' || !canFinish(current)) return
    renderedShapes.delete(current.id)
    
    
    const records =
      current.mode === 'ruler'
        ? current.points.slice(1).map((point, index): Shape => ({
            ...current,
            id: index === 0 ? current.id : crypto.randomUUID(),
            points: [[...current.points[index]], [...point]],
            cache: blankCache(),
            finished: true,
          }))
        : [{ ...current, finished: true }]
    for (const record of records) {
      rebuild(record)
      if (record.mode === 'area')
        record.cache.labelAnchor = polygonInteriorPoint(record.points, record.cache.boundary)
      finished.set(record.id, record)
    }
    selectedId = records.at(-1)!.id
    drafts[geometryMode] = newDraft(geometryMode)
    editError = null
    clearCursor()
    writeCommitted()
    persist()
    publish()
  }

  function clear() {
    endDrag()
    if (!draft().points.length) {
      if (selectedId) deleteMeasurement(selectedId)
      return
    }
    renderedShapes.delete(draft().id)
    drafts[geometryMode] = newDraft(geometryMode)
    editError = null
    clearCursor()
    hoveredVertex = null
    updatePointerCursor()
    writeCommitted()
    publish()
  }

  function cancelDrawing() {
    const current = draft()
    if (destroyed || mode === 'orbit' || !current.points.length) return false
    
    
    
    endDrag()
    if (canFinish(current)) finish()
    else clear()
    return true
  }

  function onDoubleClick(event: MapMouseEvent) {
    if (mode === 'orbit' && findVertex(event.point) !== null) {
      event.preventDefault()
      return
    }
    if (mode === 'orbit' || event.originalEvent.target !== canvas || !validPosition(event)) return
    event.preventDefault()
    finish()
  }

  function undo() {
    endDrag()
    const current = shape()
    if (current.finished) {
      removeVertex({ measurementId: current.id, index: current.points.length - 1 })
      return
    }
    if (!current.points.length) return
    current.points.pop()
    editError = null
    clearCursor()
    rebuild(current)
    writeCommitted()
    publish()
  }

  function removeVertex({ measurementId, index }: MeasurementVertexHit) {
    endDrag()
    const current = getShape(measurementId)
    if (!current || !Number.isInteger(index) || index < 0 || index >= current.points.length) return
    const previous = current.points[index]
    current.points.splice(index, 1)
    if (current.finished && current.points.length < (current.mode === 'area' ? 3 : 2)) {
      deleteMeasurement(current.id)
      return
    }
    clearCursor()
    rebuild(current)
    editError = null
    if (current.finished && !canFinish(current)) {
      current.points.splice(index, 0, previous)
      rebuild(current)
      editError = 'Removing that point would make an invalid measurement.'
    }
    if (current.mode === 'area' && current.finished) {
      current.cache.labelAnchor = polygonInteriorPoint(current.points, current.cache.boundary)
    }
    if (current.finished) selectedId = current.id
    hoveredVertex = null
    updatePointerCursor()
    writeCommitted()
    if (current.finished) persist()
    publish()
  }

  function selectMeasurement(id: string | null) {
    selectedId = id && finished.has(id) ? id : null
    editError = null
    publish()
  }

  function deleteMeasurement(id: string) {
    if (!finished.has(id)) return
    if (drag?.measurementId === id) endDrag(true)
    finished.delete(id)
    renderedShapes.delete(id)
    if (selectedId === id) selectedId = null
    hoveredVertex = null
    editError = null
    updatePointerCursor()
    writeCommitted()
    persist()
    publish()
  }

  function renameMeasurement(id: string, name: string) {
    const current = finished.get(id)
    const next = name.trim().slice(0, MEASUREMENT_NAME_LIMIT)
    if (!current || current.name === next) return
    current.name = next
    renderedShapes.delete(id)
    writeCommitted()
    persist()
    publish()
  }

  function recolorMeasurement(id: string, color: MeasurementColor) {
    const current = finished.get(id)
    if (!current || !isMeasurementColor(color) || current.color === color) return
    current.color = color
    renderedShapes.delete(id)
    writeCommitted()
    persist()
    publish()
  }

  function onKeyDown(event: KeyboardEvent) {
    if (mode === 'orbit' || event.target !== canvas) return
    if (event.key === 'Escape' && !event.defaultPrevented && cancelDrawing()) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      finish()
    }
    if (
      event.key === 'Backspace' ||
      event.key === 'Delete' ||
      ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z')
    ) {
      event.preventDefault()
      undo()
    }
  }

  map.on('click', onClick)
  map.on('mousedown', onMouseDown)
  map.on('touchstart', onTouchStart)
  map.on('dblclick', onDoubleClick)
  map.on('mousemove', onMove)
  map.on('mouseout', onLeave)
  map.on('movestart', onMapMoveStart)
  map.on('zoom', updatePolarLabelAppearance)
  canvas.addEventListener('keydown', onKeyDown)
  const stored = loadFinishedMeasurements()
  if (stored.failed)
    storageError(
      'Saved measurements could not be loaded in this browser. New drawings remain available on the map.',
    )
  let migrated = false
  for (const record of stored.records) {
    const records =
      record.mode === 'ruler' && record.points.length > 2
        ? record.points.slice(1).map((point, index) => ({
            ...record,
            id: index === 0 ? record.id : crypto.randomUUID(),
            points: [record.points[index], point],
          }))
        : [record]
    migrated ||= records.length > 1
    for (const segment of records) {
      const current: Shape = { ...segment, finished: true, cache: blankCache() }
      rebuild(current)
      if (!canFinish(current)) continue
      if (current.mode === 'area')
        current.cache.labelAnchor = polygonInteriorPoint(current.points, current.cache.boundary)
      finished.set(current.id, current)
    }
  }
  if (migrated) persist()
  writeCommitted()
  publish()

  return {
    setMode(next) {
      if (mode === next) return
      endDrag()
      const previous = geometryMode
      mode = next
      if (next !== 'orbit') geometryMode = next
      if (previous !== geometryMode) selectedId = null
      editError = null
      clearCursor()
      hoveredVertex = null
      updatePointerCursor()
      if (mode === 'orbit') {
        if (doubleClickZoomEnabled) map.doubleClickZoom.enable()
      } else map.doubleClickZoom.disable()
      publish()
    },
    setUnit(unit) {
      const tool = measurementUnits[unit].mode
      const target = drafts[tool]
      defaults.units[tool] = unit
      if (target.unit === unit) return
      target.unit = unit
      renderedShapes.delete(target.id)
      if (target.points.length) writeCommitted()
      updateReadout()
      publish()
    },
    setColors(colors) {
      let changed = false
      for (const tool of ['ruler', 'area'] as const) {
        if (!isMeasurementColor(colors[tool])) continue
        defaults.colors[tool] = colors[tool]
        if (drafts[tool].color === colors[tool]) continue
        drafts[tool].color = colors[tool]
        renderedShapes.delete(drafts[tool].id)
        changed ||= drafts[tool].points.length > 0
      }
      if (changed) writeCommitted()
      if (cursor) {
        previewDirty = true
        requestFrame()
      }
    },
    undo,
    clear,
    finish,
    cancelDrawing,
    findVertex,
    findMeasurement,
    getMeasurement(id) {
      const current = finished.get(id)
      return current ? target(current) : null
    },
    selectMeasurement,
    deleteMeasurement,
    renameMeasurement,
    recolorMeasurement,
    removeVertex,
    destroy() {
      destroyed = true
      endDrag(true)
      cancelAnimationFrame(scheduledFrame)
      clearTimeout(scheduledTimer)
      committedWriter.destroy()
      previewWriter.destroy()
      observer.disconnect()
      map.off('click', onClick)
      map.off('mousedown', onMouseDown)
      map.off('touchstart', onTouchStart)
      map.off('dblclick', onDoubleClick)
      map.off('mousemove', onMove)
      map.off('mouseout', onLeave)
      map.off('movestart', onMapMoveStart)
      map.off('zoom', updatePolarLabelAppearance)
      canvas.removeEventListener('keydown', onKeyDown)
      canvas.style.cursor = previousCursor
      canvas.classList.remove('measurement-vertex-dragging')
      if (doubleClickZoomEnabled) map.doubleClickZoom.enable()
      readout.remove()
      for (const layer of [...LAYERS].reverse()) if (map.getLayer(layer)) map.removeLayer(layer)
      for (const source of [PREVIEW_SOURCE, SOURCE])
        if (map.getSource(source)) map.removeSource(source)
      for (const label of polarLabels.values()) label.marker.remove()
      polarLabels.clear()
      segmentCache.clear()
      renderedShapes.clear()
      finished.clear()
    },
  }
}

function blankCache(): CachedGeometry {
  return {
    segments: [],
    openPath: [],
    boundary: [],
    ring: [],
    accumulator: geodesicPolygonAccumulator([]),
    distanceKm: 0,
    crossing: false,
    hasPolarGeometry: false,
    labelAnchor: null,
  }
}

function joinPaths(paths: readonly (readonly GeographicPosition[])[]): GeographicPosition[] {
  const result: GeographicPosition[] = []
  for (const path of paths) {
    const offset = result.length ? Math.round((result.at(-1)![0] - path[0][0]) / 360) * 360 : 0
    for (let index = result.length ? 1 : 0; index < path.length; index++)
      result.push([path[index][0] + offset, path[index][1]])
  }
  return result
}

function pointSegmentDistance(point: ScreenPoint, from: ScreenPoint, to: ScreenPoint) {
  const dx = to.x - from.x,
    dy = to.y - from.y
  const length = dx * dx + dy * dy
  const fraction = length
    ? Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / length))
    : 0
  return Math.hypot(point.x - from.x - fraction * dx, point.y - from.y - fraction * dy)
}

function pathMidpoint(segments: GeodesicSegment[]): GeographicPosition {
  let remaining = segments.reduce((sum, segment) => sum + segment.distanceKm, 0) / 2
  for (const segment of segments) {
    if (remaining <= segment.distanceKm) {
      const from = segment.path[0],
        to = segment.path.at(-1)!
      const line = geographicLib.Geodesic.WGS84.InverseLine(from[1], from[0], to[1], to[0])
      const point = line.Position(remaining * 1_000)
      return [point.lon2 ?? from[0], point.lat2 ?? from[1]]
    }
    remaining -= segment.distanceKm
  }
  return segments.at(-1)!.midpoint
}





function latestSourceWriter(map: MapLibreMap, id: string, onIdle?: () => void) {
  let pending: FeatureCollection | null = null
  let busy = false
  let alive = true
  function flush() {
    if (busy || !pending || !alive) return
    const source = map.getSource(id) as GeoJSONSource | undefined
    if (!source) return
    const data = pending
    pending = null
    busy = true
    void source
      .setData(data)
      .catch(() => undefined)
      .finally(() => {
        busy = false
        if (!alive) return
        if (pending) flush()
        else onIdle?.()
      })
  }
  return {
    get busy() {
      return busy
    },
    write(data: FeatureCollection) {
      pending = data
      flush()
    },
    destroy() {
      alive = false
      pending = null
    },
  }
}

function feature(kind: string, geometry: Geometry, id = kind): Feature<Geometry> {
  return { type: 'Feature', id, properties: { kind }, geometry }
}

export function formatMeasurement(value: number, unit: MeasurementUnit): string {
  const converted = value * measurementUnits[unit].factor
  return `${(converted >= 100 ? rounded : precise).format(converted)} ${measurementUnits[unit].symbol}`
}
