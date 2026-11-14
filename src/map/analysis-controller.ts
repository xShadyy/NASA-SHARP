import {
  TerraDraw,
  TerraDrawPolygonMode,
  TerraDrawRectangleMode,
  TerraDrawSelectMode,
  TerraDrawExtend,
} from 'terra-draw'
import { TerraDrawMapLibreGLAdapter } from 'terra-draw-maplibre-gl-adapter'
import type { Feature, FeatureCollection, Polygon } from 'geojson'
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl'
import {
  drawnArea,
  outsideAreaMask,
  validateDrawnArea,
  wrappedArea,
  type AnalysisArea,
} from '@/lib/analysis-area'
import type { AnalysisState } from '@/lib/analysis-state'
import { minimumZoomForView, setAnalysisZoomFloor, type MapView } from '@/map/projection'

const SOURCE = 'analysis-area'
const MASK = 'analysis-outside'
const LAYERS = ['analysis-outside-dim', 'analysis-boundary-halo', 'analysis-boundary']
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
      if (['point', 'linestring', 'polygon'].every((kind) => this.attachedMap.getSource(`analysis-draw-${kind}`))) throw error
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
    getView: () => MapView
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
  let finishedId: string | number | null = null
  let drawId = ''
  let changing = false
  let disposed = false
  let rememberedDoubleClick = false
  let styleReady = true
  let pendingFit: AnalysisArea | null = null

  function ensureLayers() {
    if (!map.getSource(SOURCE))
      map.addSource(SOURCE, { type: 'geojson', data: empty, tolerance: 0 })
    if (!map.getSource(MASK)) map.addSource(MASK, { type: 'geojson', data: empty, tolerance: 0 })
    const before = map.getStyle().layers?.find((layer) => layer.id.startsWith('measurement-'))?.id
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
          type: 'line',
          source: SOURCE,
          paint: { 'line-color': '#07173f', 'line-width': 4, 'line-opacity': 0.8 },
        },
        before,
      )
    if (!map.getLayer(LAYERS[2]))
      map.addLayer(
        {
          id: LAYERS[2],
          type: 'line',
          source: SOURCE,
          paint: { 'line-color': '#ffffff', 'line-width': 2, 'line-opacity': 0.95 },
        },
        before,
      )
  }

  function setArea(next: AnalysisArea | null, force = false) {
    if (!force && area === next) return
    area = next
    if (!styleReady) return
    ensureLayers()
    const selected: FeatureCollection = next
      ? {
          type: 'FeatureCollection',
          features: [
            { type: 'Feature', properties: { id: next.id }, geometry: wrappedArea(next.geometry) },
          ],
        }
      : empty
    const outside: FeatureCollection = next
      ? {
          type: 'FeatureCollection',
          features: [{ type: 'Feature', properties: {}, geometry: outsideAreaMask(next.geometry) }],
        }
      : empty
    ;(map.getSource(SOURCE) as GeoJSONSource).setData(selected)
    ;(map.getSource(MASK) as GeoJSONSource).setData(outside)
    map.getContainer().dataset.analysisArea = next?.id ?? ''
    if (!next) {
      setAnalysisZoomFloor(map, null)
      map.setMinZoom(minimumZoomForView(map, options.getView()))
    }
  }

  function stopDrawing() {
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

  function configure(next: AnalysisState, enabled: boolean) {
    state = next
    open = enabled
    if (!styleReady) return
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
      modes: [
        polygonMode,
        rectangleMode,
        new TerraDrawSelectMode({
          projection: 'globe',
          keyEvents: null,
          allowManualDeselection: false,
          flags: {
            polygon: {
              feature: {
                selfIntersectable: true,
                draggable: true,
                coordinates: { draggable: true, deletable: true, midpoints: true },
              },
            },
            rectangle: { feature: { draggable: true, coordinates: { resizable: 'opposite' } } },
          },
          styles: {
            selectedPolygonFillOpacity: 0,
            selectedPolygonOutlineColor: '#ffffff',
            selectedPolygonOutlineWidth: 2,
            selectionPointColor: '#2E96F5',
            selectionPointWidth: 6,
            selectionPointOutlineColor: '#ffffff',
            selectionPointOutlineWidth: 2,
            midPointColor: '#ffffff',
          },
        }),
      ],
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
    if (!draw || event.defaultPrevented || event.isComposing) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      options.onCancel()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      finish()
    }
  }

  function fit(selected: AnalysisArea) {
    if (!styleReady) { pendingFit = selected; return }
    options.markNavigated()
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
    setAnalysisZoomFloor(map, -2)
    map.setMinZoom(-2)
    const camera = map.cameraForBounds(selected.bounds, {
      padding,
      maxZoom: selected.type === 'country' ? 10 : 13,
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
    setArea(current, true)
    if (state?.phase === 'drawing') options.onCancel()
    else if (state) configure(state, open)
    if (pendingFit) {
      const selected = pendingFit
      pendingFit = null
      fit(selected)
    }
  }

  function styleLoading() {
    styleReady = false
    stopDrawing()
    request = -1
    if (state?.phase === 'drawing') options.onCancel()
  }

  map.getCanvas().addEventListener('keydown', keyDown)
  map.on('style.load', styleLoad)
  map.on('styledataloading', styleLoading)
  ensureLayers()

  return {
    setArea,
    configure,
    finish,
    fit,
    isDrawing: () => Boolean(draw),
    destroy() {
      if (disposed) return
      disposed = true
      stopDrawing()
      map.getCanvas().removeEventListener('keydown', keyDown)
      map.off('style.load', styleLoad)
      map.off('styledataloading', styleLoading)
      for (const layer of [...LAYERS].reverse()) if (map.getLayer(layer)) map.removeLayer(layer)
      for (const source of [SOURCE, MASK]) if (map.getSource(source)) map.removeSource(source)
      setAnalysisZoomFloor(map, null)
      map.getContainer().removeAttribute('data-analysis-area')
    },
  }
}

export type AnalysisController = ReturnType<typeof createAnalysisController>
