import { useEffect, useEffectEvent, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { Map as MapLibreMap, Marker, setWorkerUrl, type MapMouseEvent } from 'maplibre-gl'
import mapWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { GlobeHemisphereWestIcon, MapTrifoldIcon } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { applyLayerVisibility, createEarthStyle, registerGeographicImages, getReferenceLayerAvailability, type MapBackground, type MapReferenceLayers, type ReferenceLayerAvailability } from '@/map/basemaps'
import { createProjectionController, HOME_CENTER, MIN_ZOOM, maximumZoomForView, minimumZoomForView, overviewZoom, setMapView, type MapView, type ProjectionController } from '@/map/projection'
import type { LocationTarget } from '@/lib/locations'
import { MapLayersControl } from '@/components/LayerSettings'
import { createNonFireOverlayController, type OverlayStatus } from '@/map/non-fire-overlays'
import { createGraticuleController } from '@/map/graticule'
import { createScaleBar } from '@/map/scale-bar'
import { createSkyBackgroundLayer, SKY_BACKGROUND_LAYER_ID } from '@/map/sky-background' 
import 'maplibre-gl/dist/maplibre-gl.css'
import './EarthMap.css'

export type MapCameraState = { ready: boolean, zoom: number, minZoom: number, maxZoom: number, longitude: number, latitude: number, view: MapView }
export type EarthMapHandle = { zoomBy: (delta: number) => void, resetView: () => void }
type EarthMapProps = {
  ref: Ref<EarthMapHandle>
  destination: LocationTarget | null
  navigationRequest: number
  onCameraChange: (camera: MapCameraState) => void
  dataDate: string | null
  referenceLayers: MapReferenceLayers
  onReferenceChange: (key: keyof MapReferenceLayers, value: boolean) => void
  background: MapBackground
  onBackgroundChange: (background: MapBackground) => void
  showSpace: boolean
  onSpaceChange: (visible: boolean) => void
}

setWorkerUrl(mapWorkerUrl)

export function EarthMap({ ref, destination, navigationRequest, onCameraChange, dataDate, referenceLayers, onReferenceChange, background, onBackgroundChange, showSpace, onSpaceChange }: EarthMapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const projectionRef = useRef<ProjectionController | null>(null)
  const markerRef = useRef<Marker | null>(null)
  const coordinatesRef = useRef<HTMLOutputElement>(null)
  const viewRef = useRef<MapView>('globe')
  const [view, setView] = useState<MapView>('globe')
  const [ready, setReady] = useState(false)
  const [notice, setNotice] = useState('')
  const settingsRef = useRef({ referenceLayers, background, showSpace, dataDate })
  const graticuleRef = useRef<ReturnType<typeof createGraticuleController> | null>(null)
  const overlaysRef = useRef<ReturnType<typeof createNonFireOverlayController> | null>(null)
  const skyRef = useRef<ReturnType<typeof createSkyBackgroundLayer> | null>(null)
  const scaleRef = useRef<ReturnType<typeof createScaleBar> | null>(null)
  const scaleOutputRef = useRef<HTMLOutputElement>(null)
  const [overlayStatus, setOverlayStatus] = useState<OverlayStatus>({})
  const [availability, setAvailability] = useState<ReferenceLayerAvailability | null>(null)
  const reportCamera = useEffectEvent(() => {
    const map = mapRef.current
    if (!map) return
    const center = map.getCenter().wrap()
    onCameraChange({ ready: true, zoom: map.getZoom(), minZoom: minimumZoomForView(map, viewRef.current), maxZoom: map.getMaxZoom(), longitude: center.lng, latitude: center.lat, view: viewRef.current })
  })
  const syncLayers = useEffectEvent(() => {
    const map = mapRef.current
    if (!map) return
    applyLayerVisibility(map, { ...settingsRef.current.referenceLayers, background: settingsRef.current.background, view: viewRef.current })
    const settings = settingsRef.current
    graticuleRef.current?.setEnabled(settings.referenceLayers.showGraticule)
    skyRef.current?.setVisible(settings.showSpace)
    overlaysRef.current?.set(settings.referenceLayers, settings.dataDate)
    const next = getReferenceLayerAvailability(map)
    setAvailability((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next)
  })
  useEffect(() => {
    settingsRef.current = { referenceLayers, background, showSpace, dataDate }
    if (ready) syncLayers()
  }, [referenceLayers, background, showSpace, dataDate, ready])
  useImperativeHandle(ref, () => ({
    zoomBy(delta) {
      const map = mapRef.current
      if (!map) return
      projectionRef.current?.markNavigated()
      map.zoomTo(Math.max(minimumZoomForView(map, viewRef.current), Math.min(map.getMaxZoom(), map.getZoom() + delta)), { duration: 300 })
    },
    resetView() {
      const map = mapRef.current
      if (!map) return
      projectionRef.current?.markNavigated()
      map.easeTo({ center: HOME_CENTER, zoom: overviewZoom(map.getContainer().clientWidth, map.getContainer().clientHeight), bearing: 0, pitch: 0, duration: 500 })
      markerRef.current?.remove()
    },
  }), [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let active = true
    let map: MapLibreMap | undefined
    let observer: ResizeObserver | undefined
    async function initialize(container: HTMLDivElement) {
      await document.fonts.load('400 16px "Fira Sans"').catch(() => undefined)
      if (!active) return
      try {
        map = new MapLibreMap({
          container, style: createEarthStyle('globe'), center: HOME_CENTER,
          zoom: overviewZoom(container.clientWidth, container.clientHeight), minZoom: MIN_ZOOM, maxZoom: maximumZoomForView('globe'),
          maxPitch: 0, keyboard: false, dragRotate: false, pitchWithRotate: false, touchPitch: false,
          transformCameraUpdate: () => ({ bearing: 0, pitch: 0, roll: 0 }),
          attributionControl: { compact: true }, canvasContextAttributes: { antialias: true }, hash: false,
        })
        mapRef.current = map
        projectionRef.current = createProjectionController(map, 'globe')
        map.touchZoomRotate.disableRotation()
        map.getCanvas().setAttribute('aria-label', 'Interactive Earth, north up. Left-drag to explore, scroll to zoom.')
        const current = map
        current.on('style.load', () => {
          if (!active) return
          registerGeographicImages(current)
          setMapView(current, viewRef.current)
          const settings = settingsRef.current
          const sky = createSkyBackgroundLayer({ visible: settings.showSpace, onError: () => { if (active) setNotice('The star map could not load.') }, onReady: () => { if (active) setNotice((current) => current === 'The star map could not load.' ? '' : current) } })
          skyRef.current = sky
          if (!current.getLayer(SKY_BACKGROUND_LAYER_ID)) current.addLayer(sky, current.getStyle().layers?.[0]?.id)
          graticuleRef.current = createGraticuleController(current, () => viewRef.current, settings.referenceLayers.showGraticule)
          overlaysRef.current = createNonFireOverlayController(current, (status) => { if (active) setOverlayStatus(status) })
          if (scaleOutputRef.current) scaleRef.current = createScaleBar(current, scaleOutputRef.current, () => viewRef.current)
          syncLayers()
          setReady(true)
          reportCamera()
        })
        current.on('moveend', () => { reportCamera(); syncLayers() })
        current.on('movestart', (event) => { if (event.originalEvent) projectionRef.current?.markNavigated() })
        current.on('mousemove', (event: MapMouseEvent) => {
          const output = coordinatesRef.current
          if (!output) return
          const projected = current.project(event.lngLat)
          const valid = Math.hypot(projected.x - event.point.x, projected.y - event.point.y) <= 1
          output.hidden = !valid
          if (valid) { const { lat, lng } = event.lngLat.wrap(); output.textContent = `Lat ${lat.toFixed(6)}° · Lon ${lng.toFixed(6)}°` }
        })
        current.on('mouseout', () => { if (coordinatesRef.current) coordinatesRef.current.hidden = true })
        current.on('error', () => { if (active) setNotice('Some map resources could not load. Check your connection or retry.') })
        observer = new ResizeObserver(() => { current.resize(); projectionRef.current?.refreshZoomLimits() })
        observer.observe(container)
      } catch {
        if (active) setNotice('The map could not start. Enable WebGL in your browser, then reload.')
      }
    }
    void initialize(container)
    return () => {
      active = false
      observer?.disconnect()
      markerRef.current?.remove()
      markerRef.current = null
      graticuleRef.current?.destroy()
      overlaysRef.current?.destroy()
      scaleRef.current?.destroy()
      graticuleRef.current = null
      overlaysRef.current = null
      scaleRef.current = null
      skyRef.current = null
      map?.remove()
      mapRef.current = null
      projectionRef.current = null
    }
  }, [])

  const navigateDestination = useEffectEvent(() => {
    const map = mapRef.current
    if (!map || !destination) return
    projectionRef.current?.markNavigated()
    if (Math.abs(destination.coordinates[1]) > 85 && viewRef.current === 'map') {
      viewRef.current = 'globe'
      setView('globe')
      projectionRef.current?.setView('globe')
    }
    if (destination.bounds) map.fitBounds(destination.bounds, { padding: 90, duration: 0, maxZoom: Math.min(map.getMaxZoom(), destination.kind === 'continent' ? 4.5 : destination.kind === 'country' ? 8 : 14) })
    else map.jumpTo({ center: destination.coordinates, zoom: Math.min(map.getMaxZoom(), Math.abs(destination.coordinates[1]) > 85 ? 2 : 11) })
    map.setPadding({ top: 0, right: 0, bottom: 0, left: 0 })
    markerRef.current?.remove()
    markerRef.current = new Marker({ color: '#0960e1', opacityWhenCovered: 0 }).setLngLat(destination.coordinates).addTo(map)
    projectionRef.current?.refreshZoomLimits()
    reportCamera()
  })
  useEffect(() => { if (ready && navigationRequest > 0) navigateDestination() }, [navigationRequest, ready])
  useEffect(() => { if (!destination) { markerRef.current?.remove(); markerRef.current = null } }, [destination])

  function changeView(next: string) {
    const map = mapRef.current
    if (!map || !ready || (next !== 'globe' && next !== 'map')) return
    viewRef.current = next
    setView(next)
    projectionRef.current?.setView(next)
    graticuleRef.current?.refresh(); scaleRef.current?.refresh()
    applyLayerVisibility(map, { ...settingsRef.current.referenceLayers, background: settingsRef.current.background, view: next })
    const center = map.getCenter().wrap()
    onCameraChange({ ready: true, zoom: map.getZoom(), minZoom: minimumZoomForView(map, next), maxZoom: map.getMaxZoom(), longitude: center.lng, latitude: center.lat, view: next })
  }

  return <section className="earth-map" data-view={view} aria-label="Earth map">
    <div ref={containerRef} className="earth-map-canvas" />
    <div className="map-view-control"><ToggleGroup type="single" value={view} onValueChange={changeView} aria-label="Map projection" disabled={!ready}>
      <ToggleGroupItem value="globe" aria-label="Globe"><GlobeHemisphereWestIcon size={16} />Globe</ToggleGroupItem>
      <ToggleGroupItem value="map" aria-label="Map"><MapTrifoldIcon size={16} />Map</ToggleGroupItem>
    </ToggleGroup></div>
    <div className="map-background-control"><MapLayersControl overlayStatus={overlayStatus} onOverlayRetry={() => overlaysRef.current?.retry()} background={background} onBackgroundChange={onBackgroundChange} referenceLayers={referenceLayers} onReferenceChange={onReferenceChange} availability={availability} showSpace={showSpace} onSpaceChange={onSpaceChange} /></div>
    <output ref={scaleOutputRef} className="map-scale-bar" aria-live="off" aria-label="Local map scales in kilometers and miles" hidden />
    <output ref={coordinatesRef} className="map-coordinates" aria-label="Hovered coordinates" hidden />
    {notice && <div className="map-status" role="status"><p>{notice}</p><Button variant="outline" size="sm" onClick={() => window.location.reload()}>Reload</Button></div>}
  </section>
}
