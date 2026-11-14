import { useEffect, useEffectEvent, useImperativeHandle, useRef, useState, type Ref } from 'react'
import {
  Map as MapLibreMap,
  setWorkerUrl,
  type GeoJSONSource,
  type MapMouseEvent,
} from 'maplibre-gl'
import mapWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { GlobeHemisphereWestIcon, MapTrifoldIcon } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  applyLayerVisibility,
  createEarthStyle,
  getReferenceLayerAvailability,
  NASA_LAYER_ID,
  NASA_SOURCE_ID,
  registerGeographicImages,
  type MapBackground,
  type MapReferenceLayers,
  type ReferenceLayerAvailability,
} from '@/map/basemaps'
import { createNonFireOverlayController, type OverlayStatus } from '@/map/non-fire-overlays'
import { createGraticuleController } from '@/map/graticule'
import { createScaleBar } from '@/map/scale-bar'
import { createReferenceTileCache } from '@/map/reference-tile-cache'
import { createAnalysisController, type AnalysisController } from '@/map/analysis-controller'
import type { AnalysisState } from '@/lib/analysis-state'
import type { AnalysisArea } from '@/lib/analysis-area'
import {
  createMeasurementController,
  type MeasurementController,
  type MeasurementState,
  type MeasurementTarget,
} from '@/map/measurement-controller'
import {
  createSkyBackgroundLayer,
  SKY_BACKGROUND_ERROR,
  SKY_BACKGROUND_LAYER_ID,
} from '@/map/sky-background'
import type {
  AreaUnit,
  DistanceUnit,
  MeasurementMode,
  MeasurementUnit,
} from '@/lib/measurement-units'
import type { MeasurementColor, MeasurementColors } from '@/map/measurement-colors'
import type { LocationTarget } from '@/lib/locations'
import type { SharedCoordinates } from '@/lib/share-hash'
import { LocationPin } from '@/components/LocationPin'
import { MapLayersControl } from '@/components/LayerSettings'
import { MapContextMenu } from '@/components/MapContextMenu'
import { MeasurementNameDialog } from '@/components/MeasurementNameDialog'
import {
  captureMapImage,
  type CaptureRegion,
  type CaptureResult,
  type CaptureSettings,
} from '@/lib/map-capture'
import {
  createProjectionController,
  HOME_CENTER,
  MIN_ZOOM,
  maximumZoomForView,
  minimumZoomForView,
  overviewZoom,
  setMapView,
  type MapView,
  type ProjectionController,
} from '@/map/projection'
import 'maplibre-gl/dist/maplibre-gl.css'
import './EarthMap.css'

export type MapCameraState = {
  ready: boolean
  zoom: number
  minZoom: number
  maxZoom: number
  longitude: number
  latitude: number
  view: MapView
}
export type EarthMapHandle = {
  finishAnalysisDrawing: () => void
  zoomBy: (delta: number) => void
  resetView: () => void
  undoMeasurement: () => void
  clearMeasurement: () => void
  finishMeasurement: () => void
  createCapturePreview: (
    settings: CaptureSettings,
    region?: CaptureRegion,
  ) => Promise<CaptureResult>
}

type EarthMapProps = {
  analysis: AnalysisState
  analysisOpen: boolean
  analysisPicking: boolean
  onCountryPick: (countryId: string) => void
  analysisDistanceUnit: DistanceUnit
  analysisAreaUnit: AreaUnit
  onAnalysisChange: (area: AnalysisArea | null, error: string | null, vertices: number) => void
  onAnalysisFinish: (area: AnalysisArea, error: string | null) => void
  onAnalysisCancel: () => void
  ref: Ref<EarthMapHandle>
  initialView: MapView
  initialCoordinates: SharedCoordinates | null
  sharedNavigation: SharedCoordinates | null
  onSharedNavigationApplied: () => void
  referenceLayers: MapReferenceLayers
  onReferenceChange: (key: keyof MapReferenceLayers, value: boolean) => void
  showSpace: boolean
  onSpaceChange: (value: boolean) => void
  background: MapBackground
  onBackgroundChange: (background: MapBackground) => void
  dataDate: string | null
  measurementMode: 'orbit' | MeasurementMode
  measurementUnit: MeasurementUnit
  measurementColors: MeasurementColors
  onMeasurementChange: (state: MeasurementState) => void
  onMeasurementStorageError: (message: string) => void
  onRequestSaveLocation: (location: LocationTarget) => void
  onCaptureRegion: () => void
  navigationRequest: number
  savedNavigation: boolean
  destination: LocationTarget | null
  destinationSaved: boolean
  onSaveLocation: (location: LocationTarget) => void
  onDismissLocation: () => void
  onCameraChange: (camera: MapCameraState) => void
}

const SLOW_LOADING_NOTICE = 'Imagery is taking longer to load. You can keep navigating or retry.'
const NASA_TILE_NOTICE = 'Some NASA tiles could not load. Base map detail fills gaps as it loads.'
type NasaTileRetry = { attempts: number; timer?: ReturnType<typeof setTimeout> }
function cameraState(map: MapLibreMap, view: MapView): MapCameraState {
  const center = map.getCenter().wrap()
  return {
    ready: true,
    zoom: map.getZoom(),
    minZoom: minimumZoomForView(map, view),
    maxZoom: map.getMaxZoom(),
    longitude: center.lng,
    latitude: center.lat,
    view,
  }
}
function displayCoordinates(
  output: HTMLOutputElement | null,
  coordinates?: [number, number] | null,
) {
  if (!output) return
  const valid = coordinates?.every(Number.isFinite)
  output.hidden = !valid
  const text = valid
    ? `Lat ${coordinates![1].toFixed(6)}° · Lon ${coordinates![0].toFixed(6)}°`
    : ''
  if (output.textContent !== text) output.textContent = text
}

setWorkerUrl(mapWorkerUrl)

export function EarthMap({
  ref,
  analysis,
  analysisOpen,
  analysisPicking,
  onCountryPick,
  analysisDistanceUnit,
  analysisAreaUnit,
  onAnalysisChange,
  onAnalysisFinish,
  onAnalysisCancel,
  initialView,
  initialCoordinates,
  sharedNavigation,
  onSharedNavigationApplied,
  dataDate,
  referenceLayers,
  showSpace,
  onSpaceChange,
  onReferenceChange,
  background,
  onBackgroundChange,
  measurementMode,
  measurementUnit,
  measurementColors,
  onMeasurementChange,
  onMeasurementStorageError,
  onRequestSaveLocation,
  onCaptureRegion,
  navigationRequest,
  savedNavigation,
  destination,
  destinationSaved,
  onSaveLocation,
  onDismissLocation,
  onCameraChange,
}: EarthMapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const projectionRef = useRef<ProjectionController | null>(null)
  const measurementsRef = useRef<MeasurementController | null>(null)
  const analysisRef = useRef<AnalysisController | null>(null)
  const analysisFitRef = useRef(-1)
  const analysisUnitsRef = useRef({ distance: analysisDistanceUnit, area: analysisAreaUnit })
  const reportAnalysisChange = useEffectEvent(onAnalysisChange)
  const reportAnalysisFinish = useEffectEvent(onAnalysisFinish)
  const reportAnalysisCancel = useEffectEvent(onAnalysisCancel)
  const reportCountryPick = useEffectEvent(onCountryPick)
  const skyRef = useRef<ReturnType<typeof createSkyBackgroundLayer> | null>(null)
  const graticuleRef = useRef<ReturnType<typeof createGraticuleController> | null>(null)
  const coordinatesRef = useRef<HTMLOutputElement>(null)
  const scaleOutputRef = useRef<HTMLOutputElement>(null)
  const scaleRef = useRef<ReturnType<typeof createScaleBar> | null>(null)
  const dataDateRef = useRef(dataDate)
  const overlaysRef = useRef<ReturnType<typeof createNonFireOverlayController> | null>(null)
  const [overlayStatus, setOverlayStatus] = useState<OverlayStatus>({})
  const coordinateFrameRef = useRef(0)
  const contextTriggerRef = useRef<HTMLSpanElement>(null)
  const [contextCoordinates, setContextCoordinates] = useState<[number, number] | null>(null)
  const [contextMeasurement, setContextMeasurement] = useState<MeasurementTarget | null>(null)
  const [renamingMeasurement, setRenamingMeasurement] = useState<MeasurementTarget | null>(null)
  const reportMeasurementChange = useEffectEvent(onMeasurementChange)
  const reportMeasurementStorageError = useEffectEvent(onMeasurementStorageError)
  const reportCameraChange = useEffectEvent(onCameraChange)
  const availabilitySignatureRef = useRef('')
  const settingsRef = useRef({
    referenceLayers,
    showSpace,
    background,
    measurementMode,
    measurementUnit,
    measurementColors,
  })
  const viewRef = useRef<MapView>(initialView)
  const interactedRef = useRef(Boolean(initialCoordinates))
  const nasaRetriesRef = useRef(new Map<string, NasaTileRetry>())
  const [layerAvailability, setLayerAvailability] = useState<ReferenceLayerAvailability | null>(
    null,
  )
  const reportLayerAvailability = useEffectEvent((map: MapLibreMap) => {
    const availability = getReferenceLayerAvailability(map)
    const signature = JSON.stringify(availability)
    if (signature === availabilitySignatureRef.current) return
    availabilitySignatureRef.current = signature
    setLayerAvailability(availability)
  })
  const [view, setView] = useState<MapView>(initialView)
  const [ready, setReady] = useState(false)
  const [mapInstance, setMapInstance] = useState<MapLibreMap | null>(null)
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState('')
  const [fatal, setFatal] = useState(false)

  useEffect(() => {
    if (!mapInstance) return
    const controller = createAnalysisController(mapInstance, {
      onChange: (area, error, vertices) => reportAnalysisChange(area, error, vertices),
      onFinish: (area, error) => reportAnalysisFinish(area, error),
      onCancel: () => reportAnalysisCancel(),
      onCountryPick: (countryId) => reportCountryPick(countryId),
      getView: () => viewRef.current,
      getUnits: () => analysisUnitsRef.current,
      markNavigated: () => {
        interactedRef.current = true
        projectionRef.current?.markNavigated()
      },
    })
    analysisRef.current = controller
    analysisFitRef.current = -1
    return () => {
      controller.destroy()
      analysisRef.current = null
    }
  }, [mapInstance])

  useEffect(() => {
    analysisUnitsRef.current = { distance: analysisDistanceUnit, area: analysisAreaUnit }
    analysisRef.current?.updateReadout()
  }, [analysisDistanceUnit, analysisAreaUnit])

  useEffect(() => {
    const controller = analysisRef.current
    if (!controller) return
    const replacingCountry =
      analysis.phase === 'loading' ||
      (analysisPicking && analysis.confirmed?.type === 'country' && !analysis.draft)
    const area = replacingCountry
      ? null
      : analysis.draft && !analysis.error
        ? analysis.draft
        : analysis.confirmed
    controller.setArea(area)
    controller.configure(analysis, analysisOpen, analysisPicking)
    controller.refreshProjection()
    if (analysis.fitRequest !== analysisFitRef.current) {
      analysisFitRef.current = analysis.fitRequest
      if (area && analysis.fitRequest > 0) controller.fit(area)
    }
  }, [analysis, analysisOpen, analysisPicking, mapInstance, view])

  useEffect(() => {
    dataDateRef.current = dataDate
    overlaysRef.current?.set(referenceLayers, dataDate)
  }, [referenceLayers, dataDate, ready])

  useEffect(() => {
    settingsRef.current = {
      referenceLayers,
      showSpace,
      background,
      measurementMode,
      measurementUnit,
      measurementColors,
    }
    const map = mapRef.current
    if (!map || !ready) return
    applyLayerVisibility(map, { ...referenceLayers, view: viewRef.current, background })
    graticuleRef.current?.setEnabled(referenceLayers.showGraticule)
    skyRef.current?.setVisible(showSpace)
    reportLayerAvailability(map)
    measurementsRef.current?.setMode(measurementMode)
    measurementsRef.current?.setUnit(measurementUnit)
    measurementsRef.current?.setColors(measurementColors)
  }, [
    referenceLayers,
    showSpace,
    background,
    measurementMode,
    measurementUnit,
    measurementColors,
    ready,
  ])

  useImperativeHandle(ref, () => ({
    finishAnalysisDrawing() {
      analysisRef.current?.finish()
    },
    zoomBy(delta) {
      interactedRef.current = true
      projectionRef.current?.markNavigated()
      const map = mapRef.current
      if (map)
        map.zoomTo(
          Math.max(
            minimumZoomForView(map, viewRef.current),
            Math.min(map.getMaxZoom(), map.getZoom() + delta),
          ),
          { duration: 300 },
        )
    },
    resetView() {
      const map = mapRef.current
      if (!map) return
      projectionRef.current?.markNavigated()
      interactedRef.current = false
      map.easeTo({
        center: HOME_CENTER,
        zoom: overviewZoom(map.getContainer().clientWidth, map.getContainer().clientHeight),
        bearing: 0,
        pitch: 0,
        duration: 500,
      })
    },
    undoMeasurement() {
      measurementsRef.current?.undo()
    },
    clearMeasurement() {
      measurementsRef.current?.clear()
    },
    finishMeasurement() {
      measurementsRef.current?.finish()
    },
    async createCapturePreview(settings, region) {
      const map = mapRef.current
      if (!map) throw new Error('The map is not ready yet.')
      return captureMapImage(map, settings, region)
    },
  }))

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const referenceTiles = createReferenceTileCache()
    let active = true
    const nasaRetries = nasaRetriesRef.current
    let map: MapLibreMap | undefined
    let observer: ResizeObserver | undefined
    let loadTimer: ReturnType<typeof setTimeout> | undefined
    let coordinateEvent: MapMouseEvent | null = null

    function clearCoordinates() {
      coordinateEvent = null
      cancelAnimationFrame(coordinateFrameRef.current)
      coordinateFrameRef.current = 0
      displayCoordinates(coordinatesRef.current)
    }

    async function initialize(container: HTMLDivElement) {
      await document.fonts.load('400 16px "Fira Sans"').catch(() => undefined)
      if (!active) return
      try {
        map = new MapLibreMap({
          container,
          style: createEarthStyle(initialView),
          center: initialCoordinates
            ? [initialCoordinates.longitude, initialCoordinates.latitude]
            : HOME_CENTER,
          zoom: overviewZoom(container.clientWidth, container.clientHeight),
          minZoom: MIN_ZOOM,
          maxZoom: maximumZoomForView(initialView),
          maxPitch: 0,
          maxTileCacheZoomLevels: 8,
          maxTileCacheSize: 256,
          fadeDuration: 0,
          transformRequest: referenceTiles.transformRequest,
          keyboard: false,
          dragRotate: false,
          pitchWithRotate: false,
          touchPitch: false,
          transformCameraUpdate: () => ({ bearing: 0, pitch: 0, roll: 0 }),
          attributionControl: false,
          canvasContextAttributes: { antialias: true },
          hash: false,
        })
        mapRef.current = map
        projectionRef.current = createProjectionController(map, initialView)
        map.touchZoomRotate.disableRotation()
        map
          .getCanvas()
          .setAttribute(
            'aria-label',
            'Interactive Earth, north up. Left-drag to explore, scroll to zoom, right-click for actions or to finish drawing.',
          )
        const currentMap = map
        const reportCamera = () => {
          if (!active) return
          reportCameraChange(cameraState(currentMap, viewRef.current))
          reportLayerAvailability(currentMap)
        }
        const syncLayers = () => {
          const settings = settingsRef.current
          applyLayerVisibility(currentMap, {
            ...settings.referenceLayers,
            view: viewRef.current,
            background: settings.background,
          })
          reportLayerAvailability(currentMap)
        }
        currentMap.on('style.load', () => {
          if (!active) return
          graticuleRef.current?.destroy()
          graticuleRef.current = null
          if (!currentMap.getLayer(SKY_BACKGROUND_LAYER_ID)) {
            const sky = createSkyBackgroundLayer({
              visible: settingsRef.current.showSpace,
              onError: () => {
                if (active) setNotice(SKY_BACKGROUND_ERROR)
              },
              onReady: () => {
                if (active)
                  setNotice((current) => (current === SKY_BACKGROUND_ERROR ? '' : current))
              },
            })
            skyRef.current = sky
            currentMap.addLayer(sky, currentMap.getStyle().layers?.[0]?.id)
          }
          overlaysRef.current = createNonFireOverlayController(currentMap, (state) => {
            if (active) setOverlayStatus(state)
          })
          overlaysRef.current.set(settingsRef.current.referenceLayers, dataDateRef.current)
          if (scaleOutputRef.current) {
            scaleRef.current = createScaleBar(
              currentMap,
              scaleOutputRef.current,
              () => viewRef.current,
            )
          }
          registerGeographicImages(currentMap)
          measurementsRef.current = createMeasurementController(currentMap, {
            onChange: (state) => reportMeasurementChange(state),
            onStorageError: (message) => reportMeasurementStorageError(message),
            colors: settingsRef.current.measurementColors,
          })
          measurementsRef.current.setMode(settingsRef.current.measurementMode)
          measurementsRef.current.setUnit(settingsRef.current.measurementUnit)
          setMapView(currentMap, viewRef.current)
          graticuleRef.current = createGraticuleController(
            currentMap,
            () => viewRef.current,
            settingsRef.current.referenceLayers.showGraticule,
          )
          syncLayers()
          setMapInstance(currentMap)
          setReady(true)
          reportCamera()
        })
        currentMap.on('contextmenu', (event: MapMouseEvent) => {
          event.preventDefault()
          if (analysisRef.current?.isDrawing()) {
            analysisRef.current.finish()
            return
          }
          if (measurementsRef.current?.cancelDrawing()) return
          const original = event.originalEvent
          const rect = currentMap.getCanvas().getBoundingClientRect()
          const keyboard = original.clientX === 0 && original.clientY === 0 && original.button === 0
          const point = keyboard ? { x: rect.width / 2, y: rect.height / 2 } : event.point
          const controller = measurementsRef.current
          const vertex = controller?.findVertex(point) ?? null
          const measurement = vertex
            ? (controller?.getMeasurement(vertex.measurementId) ?? null)
            : (controller?.findMeasurement(point) ?? null)
          setContextMeasurement(measurement)
          controller?.selectMeasurement(measurement?.id ?? null)
          const geographic = currentMap.unproject([point.x, point.y])
          const projected = currentMap.project(geographic)
          const valid = Math.hypot(projected.x - point.x, projected.y - point.y) <= 1
          const wrapped = geographic.wrap()
          setContextCoordinates(valid ? [wrapped.lng, wrapped.lat] : null)
          contextTriggerRef.current?.dispatchEvent(
            new MouseEvent('contextmenu', {
              bubbles: true,
              cancelable: true,
              button: 2,
              clientX: keyboard ? rect.left + point.x : original.clientX,
              clientY: keyboard ? rect.top + point.y : original.clientY,
            }),
          )
        })
        currentMap.on('moveend', () => {
          reportCamera()
          syncLayers()
        })
        currentMap.on('zoom', () => reportLayerAvailability(currentMap))
        currentMap.on('movestart', (event) => {
          if (event.originalEvent) {
            interactedRef.current = true
            projectionRef.current?.markNavigated()
          }
          clearCoordinates()
        })
        currentMap.on('mousemove', (event: MapMouseEvent) => {
          coordinateEvent = event
          if (coordinateFrameRef.current) return
          coordinateFrameRef.current = requestAnimationFrame(() => {
            coordinateFrameRef.current = 0
            const latest = coordinateEvent
            coordinateEvent = null
            if (!active || !latest) return
            const projected = currentMap.project(latest.lngLat)
            if (Math.hypot(projected.x - latest.point.x, projected.y - latest.point.y) > 1) {
              displayCoordinates(coordinatesRef.current)
              return
            }
            const { lat, lng } = latest.lngLat.wrap()
            displayCoordinates(coordinatesRef.current, [lng, lat])
          })
        })
        currentMap.on('mouseout', clearCoordinates)
        currentMap.on('idle', () => {
          if (!active) return
          setLoading(false)
          setNotice((current) => (current === SLOW_LOADING_NOTICE ? '' : current))
        })
        currentMap.on('sourcedata', (event) => {
          if (
            !active ||
            event.sourceId !== NASA_SOURCE_ID ||
            event.tile?.state !== 'loaded' ||
            !event.coord
          )
            return
          const { x, y, z } = event.coord.canonical
          const key = `${z}/${x}/${y}`
          const retry = nasaRetries.get(key)
          if (retry?.timer) clearTimeout(retry.timer)
          nasaRetries.delete(key)
          if (!nasaRetries.size)
            setNotice((current) => (current === NASA_TILE_NOTICE ? '' : current))
        })
        currentMap.on('error', (event) => {
          if (!active) return
          setLoading(false)
          const sourceId = 'sourceId' in event ? event.sourceId : undefined
          if (typeof sourceId === 'string' && sourceId.startsWith('context-')) return
          if (sourceId === NASA_SOURCE_ID) {
            const tile = (
              event as typeof event & {
                tile?: { tileID?: { canonical?: { x: number; y: number; z: number } } }
              }
            ).tile?.tileID?.canonical
            if (
              tile &&
              Number.isInteger(tile.x) &&
              Number.isInteger(tile.y) &&
              Number.isInteger(tile.z)
            ) {
              const key = `${tile.z}/${tile.x}/${tile.y}`
              const retry = nasaRetries.get(key) ?? { attempts: 0 }
              if (!retry.timer && retry.attempts < 2) {
                retry.attempts += 1
                retry.timer = setTimeout(() => {
                  retry.timer = undefined
                  if (
                    active &&
                    currentMap.getLayer(NASA_LAYER_ID) &&
                    currentMap.getLayoutProperty(NASA_LAYER_ID, 'visibility') !== 'none'
                  ) {
                    currentMap.refreshTiles(NASA_SOURCE_ID, [tile])
                  }
                }, 700 * retry.attempts)
                nasaRetries.set(key, retry)
              } else if (retry.attempts >= 2) {
                setNotice(NASA_TILE_NOTICE)
              }
            } else {
              setNotice(NASA_TILE_NOTICE)
            }
            return
          }
          setNotice('Some map imagery could not load. Check your connection or retry.')
          console.warn('Map resource error:', event.error.message)
        })
        const canvas = currentMap.getCanvas()
        canvas.addEventListener('mouseleave', clearCoordinates)
        canvas.addEventListener('webglcontextlost', contextLost)
        canvas.addEventListener('webglcontextrestored', contextRestored)
        observer = new ResizeObserver(() => {
          currentMap.resize()
          projectionRef.current?.refreshZoomLimits()
          if (!interactedRef.current && viewRef.current === 'globe') {
            currentMap.setZoom(overviewZoom(container.clientWidth, container.clientHeight))
          }
        })
        observer.observe(container)
        loadTimer = setTimeout(() => {
          if (active && !currentMap.areTilesLoaded()) {
            setLoading(false)
            setNotice(SLOW_LOADING_NOTICE)
          }
        }, 12_000)
      } catch (error) {
        if (!active) return
        setLoading(false)
        setFatal(true)
        setNotice(
          'The map could not start. Check that WebGL is enabled in your browser, then reload.',
        )
        console.warn('Map initialization failed:', error)
      }
    }
    function contextLost() {
      if (!active) return
      setNotice('The graphics context was interrupted. Waiting for the browser to restore it.')
      setLoading(false)
    }
    function contextRestored() {
      if (active) setNotice('')
    }
    void initialize(container)
    return () => {
      active = false
      clearCoordinates()
      for (const retry of nasaRetries.values()) clearTimeout(retry.timer)
      nasaRetries.clear()
      observer?.disconnect()
      clearTimeout(loadTimer)
      map?.getCanvas().removeEventListener('webglcontextlost', contextLost)
      map?.getCanvas().removeEventListener('webglcontextrestored', contextRestored)
      map?.getCanvas().removeEventListener('mouseleave', clearCoordinates)
      mapRef.current = null
      projectionRef.current = null
      measurementsRef.current?.destroy()
      analysisRef.current?.destroy()
      analysisRef.current = null
      measurementsRef.current = null
      graticuleRef.current?.destroy()
      graticuleRef.current = null
      overlaysRef.current?.destroy()
      overlaysRef.current = null
      scaleRef.current?.destroy()
      scaleRef.current = null
      map?.remove()
      referenceTiles.destroy()
      skyRef.current = null
    }
  }, [initialCoordinates, initialView])

  const navigateDestination = useEffectEvent(() => {
    const map = mapRef.current
    if (!map || !destination) return
    interactedRef.current = true
    projectionRef.current?.markNavigated()
    map.stop()
    const [longitude, latitude] = destination.coordinates
    if (Math.abs(latitude) > 85 && viewRef.current === 'map') {
      viewRef.current = 'globe'
      projectionRef.current?.setView('globe')
      queueMicrotask(() => setView('globe'))
    }
    if (destination.bounds) {
      const width = map.getContainer().clientWidth
      const height = map.getContainer().clientHeight
      map.fitBounds(destination.bounds, {
        duration: 0,
        bearing: 0,
        pitch: 0,
        padding: {
          top: Math.min(110, height * 0.2),
          bottom: Math.min(170, height * 0.27),
          left: Math.min(60, width * 0.12),
          right: Math.min(60, width * 0.12),
        },
        maxZoom: Math.min(
          map.getMaxZoom(),
          destination.kind === 'continent' ? 4.5 : destination.kind === 'country' ? 8 : 14,
        ),
      })
      map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 })
    } else {
      map.jumpTo({
        center: [longitude, latitude],
        zoom: Math.abs(latitude) > 85 ? 2 : destination.kind === 'current' ? 13 : 11,
        bearing: 0,
        pitch: 0,
        padding: { top: 0, bottom: 0, left: 0, right: 0 },
      })
    }
    projectionRef.current?.refreshZoomLimits()
    if (savedNavigation)
      map.setZoom(Math.max(minimumZoomForView(map, viewRef.current), map.getZoom() - 1.5))
    const settings = settingsRef.current
    applyLayerVisibility(map, {
      ...settings.referenceLayers,
      view: viewRef.current,
      background: settings.background,
    })
  })

  useEffect(() => {
    if (ready && navigationRequest > 0) navigateDestination()
  }, [navigationRequest, ready])

  const restoreSharedNavigation = useEffectEvent(() => {
    if (!sharedNavigation) return
    const map = mapRef.current
    if (!map) return
    interactedRef.current = true
    map.stop()
    if (Math.abs(sharedNavigation.latitude) > 85 && viewRef.current === 'map') {
      viewRef.current = 'globe'
      setView('globe')
      projectionRef.current?.setView('globe')
    }
    projectionRef.current?.markNavigated()
    map.jumpTo({
      center: [sharedNavigation.longitude, sharedNavigation.latitude],
      padding: { top: 0, bottom: 0, left: 0, right: 0 },
    })
    scaleRef.current?.refresh()
    const settings = settingsRef.current
    applyLayerVisibility(map, {
      ...settings.referenceLayers,
      view: viewRef.current,
      background: settings.background,
    })
    reportCameraChange(cameraState(map, viewRef.current))
    onSharedNavigationApplied()
  })

  useEffect(() => {
    if (ready && sharedNavigation) restoreSharedNavigation()
  }, [ready, sharedNavigation])

  function requestSaveContextLocation() {
    if (!contextCoordinates) return
    onRequestSaveLocation({
      id: `map:${contextCoordinates.join(',')}`,
      name: 'New location',
      coordinates: [...contextCoordinates],
      kind: 'coordinates',
      source: 'Map',
    })
  }

  function deleteContextMeasurement() {
    if (!contextMeasurement) return
    measurementsRef.current?.deleteMeasurement(contextMeasurement.id)
    setContextMeasurement(null)
    mapRef.current?.getCanvas().focus({ preventScroll: true })
  }

  function changeContextMeasurementColor(color: MeasurementColor) {
    if (!contextMeasurement) return
    const controller = measurementsRef.current
    controller?.recolorMeasurement(contextMeasurement.id, color)
    setContextMeasurement(controller?.getMeasurement(contextMeasurement.id) ?? null)
    requestAnimationFrame(() => {
      const active = document.activeElement
      if (active === document.body || active?.closest('[role="menu"]'))
        mapRef.current?.getCanvas().focus({ preventScroll: true })
    })
  }

  function renameContextMeasurement() {
    if (!contextMeasurement) return
    setRenamingMeasurement(measurementsRef.current?.getMeasurement(contextMeasurement.id) ?? null)
  }

  function saveMeasurementName(name: string) {
    if (!renamingMeasurement) return
    const controller = measurementsRef.current
    controller?.renameMeasurement(renamingMeasurement.id, name)
    setContextMeasurement(controller?.getMeasurement(renamingMeasurement.id) ?? null)
    setRenamingMeasurement(null)
  }

  function changeView(next: string) {
    if (next !== 'globe' && next !== 'map') return
    const map = mapRef.current
    if (!map || !ready) return
    map.stop()
    interactedRef.current = true
    viewRef.current = next
    setView(next)
    cancelAnimationFrame(coordinateFrameRef.current)
    coordinateFrameRef.current = 0
    displayCoordinates(coordinatesRef.current)
    projectionRef.current?.setView(next)
    graticuleRef.current?.refresh()
    scaleRef.current?.refresh()
    applyLayerVisibility(map, { ...referenceLayers, view: next, background })
    onCameraChange(cameraState(map, next))
  }

  function retryMapResources() {
    const map = mapRef.current
    if (!map) return
    const nasaOnly = notice === NASA_TILE_NOTICE
    const failedNasaTiles = [...nasaRetriesRef.current.keys()].map((key) => {
      const [z, x, y] = key.split('/').map(Number)
      return { x, y, z }
    })
    for (const retry of nasaRetriesRef.current.values()) clearTimeout(retry.timer)
    nasaRetriesRef.current.clear()
    setNotice('')
    if (nasaOnly) {
      map.refreshTiles(NASA_SOURCE_ID, failedNasaTiles.length ? failedNasaTiles : undefined)
      return
    }
    skyRef.current?.retry()
    overlaysRef.current?.retry()
    applyLayerVisibility(map, { ...referenceLayers, view, background })
    Object.entries(map.getStyle().sources).forEach(([id, config]) => {
      const source = map.getSource(id)
      if (config.type === 'geojson' && typeof config.data === 'string') {
        ;(source as GeoJSONSource | undefined)?.setData(config.data)
      } else if (source?.type !== 'geojson') {
        map.refreshTiles(id)
      }
    })
  }

  return (
    <section className="earth-map" data-view={view} aria-label="Earth map">
      <div
        ref={containerRef}
        className="earth-map-canvas"
        onDragStart={(event) => event.preventDefault()}
        onPointerDown={() => window.getSelection()?.removeAllRanges()}
      />
      <MapContextMenu
        triggerRef={contextTriggerRef}
        coordinates={contextCoordinates}
        measurement={contextMeasurement}
        onDeleteMeasurement={deleteContextMeasurement}
        onRenameMeasurement={renameContextMeasurement}
        onMeasurementColorChange={changeContextMeasurementColor}
        onSave={requestSaveContextLocation}
        onCapture={onCaptureRegion}
      />
      <MeasurementNameDialog
        measurement={renamingMeasurement}
        onSubmit={saveMeasurementName}
        onClose={() => setRenamingMeasurement(null)}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          mapRef.current?.getCanvas().focus({ preventScroll: true })
        }}
      />
      <div className="map-view-control">
        <ToggleGroup
          type="single"
          value={view}
          onValueChange={changeView}
          aria-label="Map projection"
          disabled={!ready}
        >
          <ToggleGroupItem value="globe" aria-label="Globe">
            <GlobeHemisphereWestIcon size={16} />
            Globe
          </ToggleGroupItem>
          <ToggleGroupItem value="map" aria-label="Map">
            <MapTrifoldIcon size={16} />
            Map
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      <div className="map-background-control">
        <MapLayersControl
          overlayStatus={overlayStatus}
          onOverlayRetry={() => overlaysRef.current?.retry()}
          background={background}
          onBackgroundChange={onBackgroundChange}
          referenceLayers={referenceLayers}
          onReferenceChange={onReferenceChange}
          availability={layerAvailability}
          showSpace={showSpace}
          onSpaceChange={onSpaceChange}
        />
      </div>
      <output
        ref={scaleOutputRef}
        className="map-scale-bar"
        aria-live="off"
        aria-label="Local map scales in kilometers and miles"
        hidden
      />
      <output
        ref={coordinatesRef}
        className="map-coordinates"
        aria-label="Hovered coordinates"
        hidden
      />
      {ready && destination && mapInstance && (
        <LocationPin
          map={mapInstance}
          location={destination}
          saved={destinationSaved}
          onSave={onSaveLocation}
          onDismiss={onDismissLocation}
        />
      )}
      {(loading || notice) && (
        <div className="map-status" role="status" data-fatal={fatal || undefined}>
          <p>{notice || 'Loading Earth imagery.'}</p>
          {notice && !fatal && (
            <Button type="button" variant="outline" size="sm" onClick={retryMapResources}>
              Retry
            </Button>
          )}
          {fatal && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => window.location.reload()}
            >
              Reload
            </Button>
          )}
        </div>
      )}
    </section>
  )
}
