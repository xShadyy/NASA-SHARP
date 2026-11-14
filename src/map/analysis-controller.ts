import {
  TerraDraw,
  TerraDrawPolygonMode,
  TerraDrawRectangleMode,
  TerraDrawExtend,
} from 'terra-draw'
import { TerraDrawMapLibreGLAdapter } from 'terra-draw-maplibre-gl-adapter'
import type { Feature, FeatureCollection, Polygon } from 'geojson'
import type { GeoJSONSource, Map as MapLibreMap, MapMouseEvent, MapTouchEvent } from 'maplibre-gl'
import { drawnArea, validateDrawnArea, type AnalysisArea } from '@/lib/analysis-area'
import type { AnalysisState } from '@/lib/analysis-state'
import { analysisDrawingMeasurements } from '@/lib/analysis-measurements'
import type { AreaUnit, DistanceUnit } from '@/lib/measurement-units'
import { formatMeasurement } from '@/map/measurement-controller'
import { minimumZoomForView, setAnalysisZoomFloor, type MapView } from '@/map/projection'
import './analysis-controller.css'
import { createAnalysisSelectMode } from './analysis-select-mode'
import { createCountryPickingController } from './country-picking'
import { FIRE_LAYER_BEFORE_ID } from './geography'
import { createAnalysisGeometryPreparer } from './analysis-geometry-preparer'
import { fallbackAnalysisDisplayGeometry, type AnalysisDisplayGeometry } from './analysis-geometry'

const SOURCE = 'analysis-area'
const MASK = 'analysis-outside'
const LAYERS = [
  'analysis-outside-dim',
  'analysis-area-fill',
  'analysis-boundary-halo',
  'analysis-boundary',
]
const empty: FeatureCollection = { type: 'FeatureCollection', features: [] }

class AnalysisDrawAdapter extends TerraDrawMapLibreGLAdapter<MapLibreMap> {
  private readonly attachedMap: MapLibreMap

  constructor(attachedMap: MapLibreMap) {
    super({ map: attachedMap, prefixId: 'analysis-draw', coordinatePrecision: 9 })
    this.attachedMap = attachedMap
  }

  clear() {
    try {
      super.clear()
    } catch (error) {
      if (
        ['point', 'linestring', 'polygon'].every((kind) =>
          this.attachedMap.getSource(`analysis-draw-${kind}`),
        )
      )
        throw error
    }
  }

  unregister() {
    TerraDrawExtend.TerraDrawBaseAdapter.prototype.unregister.call(this)
    for (const kind of ['point-marker', 'point', 'linestring', 'polygon-outline', 'polygon']) {
      const id = `analysis-draw-${kind}`
      if (this.attachedMap.getLayer(id)) this.attachedMap.removeLayer(id)
    }
    for (const kind of ['point', 'linestring', 'polygon']) {
      const id = `analysis-draw-${kind}`
      if (this.attachedMap.getSource(id)) this.attachedMap.removeSource(id)
    }
  }
}

export function createAnalysisController(
  map: MapLibreMap,
  options: {
    onChange: (area: AnalysisArea | null, error: string | null, vertices: number) => void
    onFinish: (area: AnalysisArea, error: string | null) => void
    onCancel: () => void
    onCountryPick: (countryId: string) => void
    getView: () => MapView
    getUnits: () => { distance: DistanceUnit; area: AreaUnit }
    markNavigated: () => void
  },
) {
  let area: AnalysisArea | null = null
  let draw: TerraDraw | null = null
  let polygonMode: TerraDrawPolygonMode | null = null
  let rectangleMode: TerraDrawRectangleMode | null = null
  let request = -1
  let frame = 0
  let state: AnalysisState | null = null
  let open = false
  let picking = false
  let preparedArea: AnalysisDisplayGeometry | null = null
  let lastMask: object | null | undefined
  let lastMaskView: MapView | null = null
  let lastRendered: {
    area: AnalysisArea | null
    prepared: AnalysisDisplayGeometry | null
    role: string
  } | null = null
  let finishedId: string | number | null = null
  let drawId = ''
  let changing = false
  let disposed = false
  let rememberedDoubleClick = false
  let styleReady = true
  let pendingFit: AnalysisArea | null = null
  const geometryPreparer = createAnalysisGeometryPreparer()
  let cursor: { x: number; y: number } | null = null
  let readoutFrame = 0
  const container = map.getContainer()
  const readout = document.createElement('output')
  readout.className = 'analysis-drawing-readout'
  readout.hidden = true
  readout.setAttribute('aria-hidden', 'true')
  container.append(readout)
  const notice = document.createElement('output')
  notice.className = 'analysis-map-notice'
  notice.hidden = true
  notice.setAttribute('role', 'status')
  container.append(notice)
  const countryPicking = createCountryPickingController(map, {
    onPick: (countryId) => options.onCountryPick(countryId),
    onError: (message) => {
      if (disposed) return
      notice.textContent = message ?? ''
      notice.hidden = !message
    },
  })
  const themeObserver = new MutationObserver(() => {
    if (!styleReady || disposed) return
    updateTheme()
    countryPicking.updateTheme()
  })
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  })
  let containerWidth = container.clientWidth
  let containerHeight = container.clientHeight
  let readoutWidth = 240
  let readoutHeight = 26
  const readoutObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const box = entry.borderBoxSize[0]
      const width = box?.inlineSize ?? entry.contentRect.width
      const height = box?.blockSize ?? entry.contentRect.height
      if (entry.target === container) {
        containerWidth = width
        containerHeight = height
      } else if (width > 0 && height > 0) {
        readoutWidth = width
        readoutHeight = height
      }
    }
    positionReadout()
  })
  readoutObserver.observe(container)
  readoutObserver.observe(readout)

  function positionReadout() {
    if (!cursor || readout.hidden) return
    const x = Math.max(8, Math.min(cursor.x + 15, containerWidth - readoutWidth - 8))
    const y = Math.max(
      8,
      Math.min(cursor.y - readoutHeight - 7, containerHeight - readoutHeight - 8),
    )
    readout.style.transform = `translate3d(${x}px, ${y}px, 0)`
  }

  function updateReadout() {
    const current = draw && cursor ? feature() : null
    const values = current ? analysisDrawingMeasurements(current, finishedId !== null) : null
    if (!values || !cursor) {
      readout.hidden = true
      return
    }
    const units = options.getUnits()
    const text = [
      values.edgeKm !== null ? `Edge ${formatMeasurement(values.edgeKm, units.distance)}` : '',
      values.widthKm !== null ? `Width ${formatMeasurement(values.widthKm, units.distance)}` : '',
      values.heightKm !== null
        ? `Height ${formatMeasurement(values.heightKm, units.distance)}`
        : '',
      values.areaKm2 !== null
        ? state?.error
          ? 'Invalid area · Move or remove a point'
          : `Area ${formatMeasurement(values.areaKm2, units.area)}`
        : '',
    ]
      .filter(Boolean)
      .join(' · ')
    if (!text) {
      readout.hidden = true
      return
    }
    if (readout.textContent !== text) readout.textContent = text
    readout.hidden = false
    positionReadout()
  }

  function requestReadout() {
    if (readoutFrame || disposed || !draw) return
    readoutFrame = requestAnimationFrame(() => {
      readoutFrame = 0
      if (!disposed) updateReadout()
    })
  }

  function pointerMove(event: MapMouseEvent | MapTouchEvent) {
    if (!draw) return
    const projected = map.project(event.lngLat)
    if (Math.hypot(projected.x - event.point.x, projected.y - event.point.y) > 2) {
      clearReadout()
      return
    }
    cursor = event.point
    requestReadout()
  }

  function clearReadout() {
    cancelAnimationFrame(readoutFrame)
    readoutFrame = 0
    cursor = null
    readout.hidden = true
  }

  function accent() {
    return getComputedStyle(container).getPropertyValue('--brand-accent').trim() || '#0960e1'
  }

  function updateTheme() {
    for (const [id, property] of [['analysis-area-fill', 'fill-color']] as const)
      if (map.getLayer(id)) map.setPaintProperty(id, property, accent())
  }

  function ensureLayers() {
    if (!map.getSource(SOURCE))
      map.addSource(SOURCE, { type: 'geojson', data: empty, tolerance: 0 })
    if (!map.getSource(MASK)) map.addSource(MASK, { type: 'geojson', data: empty, tolerance: 0 })
    const layers = map.getStyle().layers ?? []
    const before = layers.find(
      (layer) =>
        layer.id.startsWith('measurement-') ||
        layer.id.startsWith('analysis-observations-') ||
        /(?:^|[-_])(?:fire|hotspots?|firms)(?:$|[-_])/i.test(layer.id) ||
        layer.id === FIRE_LAYER_BEFORE_ID,
    )?.id
    if (!map.getLayer(LAYERS[0]))
      map.addLayer(
        {
          id: LAYERS[0],
          type: 'fill',
          source: MASK,
          paint: { 'fill-color': '#56616f', 'fill-opacity': 0.66, 'fill-antialias': false },
        },
        before,
      )
    if (!map.getLayer(LAYERS[1]))
      map.addLayer(
        {
          id: LAYERS[1],
          type: 'fill',
          source: SOURCE,
          paint: {
            'fill-color': accent(),
            'fill-opacity': ['case', ['==', ['get', 'role'], 'candidate'], 0.12, 0.055],
          },
        },
        before,
      )
    if (!map.getLayer(LAYERS[2]))
      map.addLayer(
        {
          id: LAYERS[2],
          type: 'line',
          source: SOURCE,
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: { 'line-color': '#07173f', 'line-width': 4, 'line-opacity': 0.8 },
        },
        before,
      )
    if (!map.getLayer(LAYERS[3]))
      map.addLayer(
        {
          id: LAYERS[3],
          type: 'line',
          source: SOURCE,
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: {
            'line-color': '#ffffff',
            'line-width': 2,
            'line-opacity': 0.95,
          },
        },
        before,
      )
  }

  function renderSelection() {
    if (!styleReady || disposed) return
    const role = area && state?.draft === area ? 'candidate' : 'confirmed'
    if (
      lastRendered?.area === area &&
      lastRendered.prepared === preparedArea &&
      lastRendered.role === role
    )
      return
    lastRendered = { area, prepared: preparedArea, role }
    const features: FeatureCollection['features'] = []
    if (area && preparedArea)
      features.push({
        type: 'Feature',
        properties: { id: area.id, role },
        geometry: preparedArea.boundary,
      })
    ;(map.getSource(SOURCE) as GeoJSONSource).setData({ type: 'FeatureCollection', features })
  }

  function refreshProjection(force = false) {
    if (!styleReady || disposed) return
    const view = options.getView()
    const mask = preparedArea?.outside ?? null
    container.dataset.analysisMask = mask ? 'outside' : area ? 'outline-and-fill' : ''
    if (!force && lastMask === mask && lastMaskView === view) return
    lastMask = mask
    lastMaskView = view
    const data: FeatureCollection = mask
      ? {
          type: 'FeatureCollection',
          features: [{ type: 'Feature', properties: {}, geometry: mask }],
        }
      : empty
    ;(map.getSource(MASK) as GeoJSONSource).setData(data)
    if (area && preparedArea && !mask) {
      notice.dataset.kind = 'mask'
      notice.textContent =
        'Outside dimming is unavailable for this boundary. Its outline and complete analysis geometry are preserved.'
      notice.hidden = false
    } else if (notice.dataset.kind === 'mask') {
      notice.hidden = true
      notice.textContent = ''
      delete notice.dataset.kind
    }
  }

  function setArea(next: AnalysisArea | null, force = false) {
    if (disposed) return
    if (!force && area === next) return
    geometryPreparer.cancel()
    area = next
    notice.hidden = true
    notice.textContent = ''
    delete notice.dataset.kind
    preparedArea = null
    lastRendered = null
    container.removeAttribute('data-analysis-preparing')
    if (!styleReady) return
    ensureLayers()
    const display = (prepared: AnalysisDisplayGeometry | null) => {
      if (disposed || !styleReady || area !== next) return
      preparedArea = prepared
      renderSelection()
      refreshProjection()
      container.removeAttribute('data-analysis-preparing')
    }
    if (!next || (next.type === 'country' && !next.displayBoundary)) display(null)
    container.dataset.analysisArea = next?.id ?? ''
    container.dataset.analysisCredits =
      next?.type === 'country' && next.source
        ? `${next.source.name} · ${next.source.dataset}${next.source.version ? ` · ${next.source.version}` : ''}`
        : ''
    if (!next) {
      setAnalysisZoomFloor(map, null)
      map.setMinZoom(Math.min(map.getZoom(), minimumZoomForView(map, options.getView())))
    } else if (next.displayBoundary) {
      display({ boundary: next.displayBoundary, outside: next.displayMask ?? null })
    } else if (next.type === 'country') {
      container.dataset.analysisPreparing = next.id
      geometryPreparer.prepare(next.geometry, display)
    } else display(fallbackAnalysisDisplayGeometry(next.geometry))
  }

  function stopDrawing() {
    clearReadout()
    cancelAnimationFrame(frame)
    frame = 0
    if (!draw) return
    changing = true
    const current = draw
    draw = null
    try {
      current.stop()
    } finally {
      changing = false
      finishedId = null
      polygonMode = null
      rectangleMode = null
      map.dragPan.enable()
      if (rememberedDoubleClick) map.doubleClickZoom.enable()
      map.getCanvas().style.cursor = ''
      map.getContainer().removeAttribute('data-analysis-drawing')
    }
  }

  function feature() {
    return draw
      ?.getSnapshot()
      .find((item) => item.geometry.type === 'Polygon' && item.properties.mode !== 'select') as
      Feature<Polygon> | undefined
  }

  function reportChange() {
    if (changing || !draw || !state?.tool) return
    requestReadout()
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => {
      frame = 0
      const current = feature()
      if (!current || !state?.tool) return
      const count = Number(
        current.properties?.committedCoordinateCount ??
          Math.max(0, current.geometry.coordinates[0].length - (finishedId === null ? 2 : 1)),
      )
      if (finishedId === null) {
        if (count !== state.vertices || state.error || state.draft)
          options.onChange(null, null, count)
      } else {
        const candidate = drawnArea(current.geometry, state.tool, drawId)
        options.onChange(candidate, validateDrawnArea(candidate.geometry), count)
      }
    })
  }

  function complete(id: string | number) {
    if (!draw || !state?.tool || changing) return
    cancelAnimationFrame(frame)
    frame = 0
    const current = draw.getSnapshotFeature(id)
    if (current?.geometry.type !== 'Polygon') return
    finishedId = id
    const candidate = drawnArea(current.geometry, state.tool, drawId)
    const error = validateDrawnArea(candidate.geometry)
    if (error) draw.selectFeature(id)
    options.onFinish(candidate, error)
  }

  function configure(next: AnalysisState, enabled: boolean, selectCountry = false) {
    state = next
    open = enabled
    picking = enabled && selectCountry
    requestReadout()
    if (!styleReady) return
    countryPicking.setEnabled(picking)
    renderSelection()
    refreshProjection()
    const active = enabled && (next.phase === 'drawing' || next.phase === 'editing') && next.tool
    if (!active || !next.tool) {
      stopDrawing()
      return
    }
    if (draw && request === next.drawRequest) return
    stopDrawing()
    request = next.drawRequest
    drawId = next.draft?.id ?? crypto.randomUUID()
    const allowed = (event: {
      lng: number
      lat: number
      containerX: number
      containerY: number
    }) => {
      const projected = map.project([event.lng, event.lat])
      return Math.hypot(projected.x - event.containerX, projected.y - event.containerY) < 2
    }
    polygonMode = new TerraDrawPolygonMode({
      projection: 'globe',
      keyEvents: { cancel: null, finish: 'Enter' },
      pointerEvents: {
        leftClick: allowed,
        rightClick: false,
        contextMenu: false,
        onDragStart: true,
        onDrag: true,
        onDragEnd: true,
      },
      styles: {
        fillColor: '#2E96F5',
        fillOpacity: 0.06,
        outlineColor: '#ffffff',
        outlineWidth: 2,
        closingPointColor: '#2E96F5',
        closingPointWidth: 6,
      },
    })
    rectangleMode = new TerraDrawRectangleMode({
      projection: 'globe',
      drawInteraction: 'click-move',
      keyEvents: { cancel: null, finish: 'Enter' },
      pointerEvents: {
        leftClick: allowed,
        rightClick: false,
        contextMenu: false,
        onDragStart: true,
        onDrag: true,
        onDragEnd: true,
      },
      styles: { fillColor: '#2E96F5', fillOpacity: 0.06, outlineColor: '#ffffff', outlineWidth: 2 },
    })
    rememberedDoubleClick = map.doubleClickZoom.isEnabled()
    draw = new TerraDraw({
      adapter: new AnalysisDrawAdapter(map),
      modes: [polygonMode, rectangleMode, createAnalysisSelectMode(next.tool)],
    })
    changing = true
    draw.start()
    draw.on('change', reportChange)
    draw.on('finish', (id, context) => {
      if (context.action === 'draw') complete(id)
      else reportChange()
    })
    if (next.phase === 'editing' && next.draft?.geometry.type === 'Polygon') {
      const id = crypto.randomUUID()
      draw.addFeatures([
        {
          type: 'Feature',
          id,
          properties: { mode: next.tool },
          geometry: structuredClone(next.draft.geometry),
        },
      ])
      finishedId = id
      draw.selectFeature(id)
    } else draw.setMode(next.tool)
    changing = false
    map.getContainer().dataset.analysisDrawing = next.tool
    map.getCanvas().focus({ preventScroll: true })
  }

  function finish() {
    if (!draw) return
    if (finishedId !== null) complete(finishedId)
    else {
      const event = { key: 'Enter', heldKeys: [], preventDefault() {} }
      if (state?.tool === 'polygon') polygonMode?.onKeyUp(event)
      else rectangleMode?.onKeyUp(event)
      if (finishedId === null)
        options.onChange(
          null,
          'Add at least three vertices before finishing the polygon.',
          state?.vertices ?? 0,
        )
    }
  }

  function keyDown(event: KeyboardEvent) {
    if (event.defaultPrevented || event.isComposing) return
    if (event.key === 'Escape' && open && (picking || (state && state.phase !== 'idle'))) {
      event.preventDefault()
      event.stopPropagation()
      clearReadout()
      options.onCancel()
    } else if (draw && event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      finish()
    }
  }

  function fit(selected: AnalysisArea) {
    if (!styleReady) {
      pendingFit = selected
      return
    }
    options.markNavigated()
    notice.hidden = true
    notice.textContent = ''
    delete notice.dataset.kind
    const container = map.getContainer()
    const bounds = container.getBoundingClientRect()
    const calendar = document.querySelector('.date-popover')?.getBoundingClientRect()
    const topOverlap =
      calendar &&
      calendar.bottom > bounds.top &&
      calendar.left < bounds.right &&
      calendar.right > bounds.left
        ? Math.max(0, Math.min(bounds.height * 0.3, calendar.bottom - bounds.top + 20))
        : 0
    const pad = Math.max(
      20,
      Math.min(64, container.clientWidth * 0.08, container.clientHeight * 0.12),
    )
    const padding = {
      top: Math.min(bounds.height * 0.35, pad + 62 + topOverlap),
      bottom: Math.min(bounds.height * 0.3, pad + 70),
      left: pad,
      right: pad + 12,
    }
    if (options.getView() === 'globe' && selected.bounds[1][0] - selected.bounds[0][0] > 165) {
      notice.textContent =
        'This main territory spans a globe hemisphere. Pan to inspect the remaining parts; the complete country stays in the analysis area.'
      notice.hidden = false
      const longitude = (selected.bounds[0][0] + selected.bounds[1][0]) / 2
      const latitude = Math.max(
        -75,
        Math.min(75, (selected.bounds[0][1] + selected.bounds[1][1]) / 2),
      )
      map.easeTo({
        center: [longitude, latitude],
        zoom: Math.max(map.getMinZoom(), Math.min(1.5, map.getZoom())),
        duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 650,
        essential: false,
      })
      return
    }
    setAnalysisZoomFloor(map, -2)
    map.setMinZoom(-2)
    const camera = map.cameraForBounds(selected.bounds, {
      padding,
      maxZoom: selected.type === 'country' ? Math.min(15, map.getMaxZoom()) : 13,
    })
    if (!camera) return
    const floor = Math.min(camera.zoom ?? 2, 2)
    setAnalysisZoomFloor(map, floor)
    map.setMinZoom(Math.min(floor, minimumZoomForView(map, options.getView())))
    map.easeTo({
      ...camera,
      padding: { top: 0, bottom: 0, left: 0, right: 0 },
      duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 650,
      essential: false,
    })
  }

  function styleLoad() {
    if (disposed) return
    styleReady = true
    const current = area
    stopDrawing()
    request = -1
    lastRendered = null
    lastMask = undefined
    setArea(current, true)
    if (state?.phase === 'drawing') options.onCancel()
    else if (state) configure(state, open, picking)
    if (pendingFit) {
      const selected = pendingFit
      pendingFit = null
      fit(selected)
    }
  }

  function styleLoading() {
    geometryPreparer.cancel()
    container.removeAttribute('data-analysis-preparing')
    styleReady = false
    stopDrawing()
    request = -1
    if (state?.phase === 'drawing') options.onCancel()
  }

  map.getCanvas().addEventListener('keydown', keyDown)
  map.on('mousemove', pointerMove)
  map.on('touchmove', pointerMove)
  map.on('mouseout', clearReadout)
  map.on('touchend', clearReadout)
  map.on('touchcancel', clearReadout)
  map.on('movestart', clearReadout)
  map.on('style.load', styleLoad)
  map.on('styledataloading', styleLoading)
  ensureLayers()

  return {
    setArea,
    configure,
    finish,
    fit,
    isDrawing: () => Boolean(draw),
    refreshProjection,
    updateReadout: requestReadout,
    destroy() {
      if (disposed) return
      disposed = true
      geometryPreparer.destroy()
      countryPicking.destroy()
      themeObserver.disconnect()
      notice.remove()
      stopDrawing()
      readoutObserver.disconnect()
      readout.remove()
      map.getCanvas().removeEventListener('keydown', keyDown)
      map.off('mousemove', pointerMove)
      map.off('touchmove', pointerMove)
      map.off('mouseout', clearReadout)
      map.off('touchend', clearReadout)
      map.off('touchcancel', clearReadout)
      map.off('movestart', clearReadout)
      map.off('style.load', styleLoad)
      map.off('styledataloading', styleLoading)
      for (const layer of [...LAYERS].reverse()) if (map.getLayer(layer)) map.removeLayer(layer)
      for (const source of [SOURCE, MASK]) if (map.getSource(source)) map.removeSource(source)
      setAnalysisZoomFloor(map, null)
      map.getContainer().removeAttribute('data-analysis-area')
      map.getContainer().removeAttribute('data-analysis-credits')
      map.getContainer().removeAttribute('data-analysis-preparing')
      map.getContainer().removeAttribute('data-analysis-mask')
    },
  }
}

export type AnalysisController = ReturnType<typeof createAnalysisController>
