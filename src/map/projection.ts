import type { JumpToOptions, Map as MapLibreMap } from 'maplibre-gl'

export type MapView = 'globe' | 'map'

// MapLibre's public globe mode transitions to Mercator at close zoom. Keeping a
// fixed float32 sphere at street-level zoom displaces raster marks from their
// canonical locations; the native globe transition avoids that precision loss.
export const GLOBE_PROJECTION = 'globe'

export function globeSurfaceVisible(map: Pick<MapLibreMap, 'getProjection' | 'getZoom'>) {
  const type = map.getProjection().type
  if (type === 'vertical-perspective') return true
  return (type === GLOBE_PROJECTION || Array.isArray(type)) && map.getZoom() < 12
}

export const HOME_CENTER: [number, number] = [18, 12]
export const MIN_ZOOM = -1
export const MIN_FLAT_ZOOM = 2
export const MAX_ZOOM = 18
export const MAX_GLOBE_ZOOM = 13
const analysisZoomFloors = new WeakMap<MapLibreMap, number>()

export function setAnalysisZoomFloor(map: MapLibreMap, minimum: number | null) {
  if (minimum === null) analysisZoomFloors.delete(map)
  else analysisZoomFloors.set(map, Math.max(-2, Math.min(MIN_FLAT_ZOOM, minimum)))
}

export function maximumZoomForView(view: MapView) {
  return view === 'globe' ? MAX_GLOBE_ZOOM : MAX_ZOOM
}

export function globeMinimumZoom(width: number, height: number) {
  const diameterRatio = width <= 600 ? 0.65 : 0.6
  return Math.max(
    MIN_ZOOM,
    Math.min(3, Math.log2((Math.max(1, Math.min(width, height)) * diameterRatio) / 140)),
  )
}

function configuredMinimumZoom(map: MapLibreMap, view: MapView) {
  const { top = 0, bottom = 0, left = 0, right = 0 } = map.getPadding()
  const width = Math.max(1, map.getContainer().clientWidth - left - right)
  const height = Math.max(1, map.getContainer().clientHeight - top - bottom)
  return view === 'globe'
    ? Math.min(globeMinimumZoom(width, height), analysisZoomFloors.get(map) ?? Infinity)
    : Math.min(
        Math.max(MIN_FLAT_ZOOM, Math.log2(height / 512)),
        analysisZoomFloors.get(map) ?? Infinity,
      )
}

export function minimumZoomForView(map: MapLibreMap, view: MapView) {
  const minimum = configuredMinimumZoom(map, view)
  if (view === 'map') return minimum
  const latitude = Math.min(85.0511287798066, Math.abs(map.getCenter().lat))
  return minimum + Math.log2(Math.cos((latitude * Math.PI) / 180))
}

export function overviewZoom(width: number, height: number) {
  return Math.max(MIN_ZOOM, Math.min(3, Math.log2((Math.min(width, height) * 0.78) / 140)))
}

export function setMapView(map: MapLibreMap, view: MapView) {
  map.setProjection({ type: view === 'globe' ? GLOBE_PROJECTION : 'mercator' })
  map.setSky({
    'sky-color': '#02050d',
    'horizon-color': '#91b9e3',
    'sky-horizon-blend': 0.08,
    'atmosphere-blend':
      view === 'globe' ? ['interpolate', ['linear'], ['zoom'], 0, 0.55, 4, 0.4, 7, 0] : 0,
  })
}

export class ProjectionController {
  private readonly map: MapLibreMap
  private view: MapView
  private globeCamera: JumpToOptions | undefined
  private flatNavigated = false
  private flatEntryCamera: { longitude: number; latitude: number; zoom: number } | undefined

  constructor(map: MapLibreMap, initialView: MapView = 'globe') {
    this.map = map
    this.view = initialView
    this.refreshZoomLimits()
  }

  getView(): MapView {
    return this.view
  }

  markNavigated(): void {
    if (this.view === 'map') this.flatNavigated = true
  }

  refreshZoomLimits(): void {
    const minimum = configuredMinimumZoom(this.map, this.view)
    if (this.map.getMinZoom() !== minimum) this.map.setMinZoom(minimum)
    const maximum = maximumZoomForView(this.view)
    if (this.map.getMaxZoom() !== maximum) this.map.setMaxZoom(maximum)
  }

  setView(view: MapView): void {
    if (view === this.view) {
      setMapView(this.map, view)
      this.refreshZoomLimits()
      return
    }

    this.map.stop()

    const flatCenter = this.map.getCenter()
    const flatMoved =
      this.flatNavigated ||
      (!!this.flatEntryCamera &&
        (Math.abs(flatCenter.lng - this.flatEntryCamera.longitude) > 1e-7 ||
          Math.abs(flatCenter.lat - this.flatEntryCamera.latitude) > 1e-7 ||
          Math.abs(this.map.getZoom() - this.flatEntryCamera.zoom) > 1e-5))
    if (view === 'map') {
      this.globeCamera = {
        center: this.map.getCenter().toArray(),
        zoom: this.map.getZoom(),
        bearing: this.map.getBearing(),
        pitch: this.map.getPitch(),
        roll: this.map.getRoll(),
        elevation: this.map.getCenterElevation(),
        padding: { ...this.map.getPadding() },
      }
      this.flatNavigated = false
    }

    this.view = view

    this.map.setMinZoom(MIN_ZOOM)
    this.map.setMaxZoom(maximumZoomForView(view))
    setMapView(this.map, view)
    this.refreshZoomLimits()
    if (view === 'map') {
      const center = this.map.getCenter()
      this.flatEntryCamera = {
        longitude: center.lng,
        latitude: center.lat,
        zoom: this.map.getZoom(),
      }
    }
    if (view === 'globe') {
      if (this.globeCamera && !flatMoved) {
        this.map.jumpTo(this.globeCamera)
      }
      this.globeCamera = undefined
      this.flatNavigated = false
      this.flatEntryCamera = undefined
    }
  }
}

export function createProjectionController(
  map: MapLibreMap,
  initialView: MapView = 'globe',
): ProjectionController {
  return new ProjectionController(map, initialView)
}
