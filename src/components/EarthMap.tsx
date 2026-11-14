import { useEffect, useEffectEvent, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { Map as MapLibreMap, Marker, setWorkerUrl, type MapMouseEvent } from 'maplibre-gl'
import mapWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { GlobeHemisphereWestIcon, MapTrifoldIcon } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { applyLayerVisibility, createEarthStyle, DEFAULT_MAP_BACKGROUND, DEFAULT_REFERENCE_LAYERS, registerGeographicImages } from '@/map/basemaps'
import { createProjectionController, HOME_CENTER, MIN_ZOOM, maximumZoomForView, minimumZoomForView, overviewZoom, setMapView, type MapView, type ProjectionController } from '@/map/projection'
import type { LocationTarget } from '@/lib/locations'

import 'maplibre-gl/dist/maplibre-gl.css'
import './EarthMap.css'

export type MapCameraState = { ready: boolean, zoom: number, minZoom: number, maxZoom: number, longitude: number, latitude: number, view: MapView }
export type EarthMapHandle = { zoomBy: (delta: number) => void, resetView: () => void }
type EarthMapProps = {
  ref: Ref<EarthMapHandle>
  destination: LocationTarget | null
  navigationRequest: number
  onCameraChange: (camera: MapCameraState) => void
  
}

setWorkerUrl(mapWorkerUrl)

export function EarthMap({ ref, destination, navigationRequest, onCameraChange }: EarthMapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const projectionRef = useRef<ProjectionController | null>(null)
  const markerRef = useRef<Marker | null>(null)
  const coordinatesRef = useRef<HTMLOutputElement>(null)
  const viewRef = useRef<MapView>('globe')
  const [view, setView] = useState<MapView>('globe')
  const [ready, setReady] = useState(false)
  const [notice, setNotice] = useState('')
  
  const reportCamera = useEffectEvent(() => {
    const map = mapRef.current
    if (!map) return
    const center = map.getCenter().wrap()
    onCameraChange({ ready: true, zoom: map.getZoom(), minZoom: minimumZoomForView(map, viewRef.current), maxZoom: map.getMaxZoom(), longitude: center.lng, latitude: center.lat, view: viewRef.current })
  })
  const syncLayers = useEffectEvent(() => {
    const map = mapRef.current
    if (!map) return
    applyLayerVisibility(map, { ...DEFAULT_REFERENCE_LAYERS, background: DEFAULT_MAP_BACKGROUND, view: viewRef.current })
    
  })
  
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
    
    applyLayerVisibility(map, { ...DEFAULT_REFERENCE_LAYERS, background: DEFAULT_MAP_BACKGROUND, view: next })
    const center = map.getCenter().wrap()
    onCameraChange({ ready: true, zoom: map.getZoom(), minZoom: minimumZoomForView(map, next), maxZoom: map.getMaxZoom(), longitude: center.lng, latitude: center.lat, view: next })
  }

  return <section className="earth-map" data-view={view} aria-label="Earth map">
    <div ref={containerRef} className="earth-map-canvas" />
    <div className="map-view-control"><ToggleGroup type="single" value={view} onValueChange={changeView} aria-label="Map projection" disabled={!ready}>
      <ToggleGroupItem value="globe" aria-label="Globe"><GlobeHemisphereWestIcon size={16} />Globe</ToggleGroupItem>
      <ToggleGroupItem value="map" aria-label="Map"><MapTrifoldIcon size={16} />Map</ToggleGroupItem>
    </ToggleGroup></div>
    
    <output ref={coordinatesRef} className="map-coordinates" aria-label="Hovered coordinates" hidden />
    {notice && <div className="map-status" role="status"><p>{notice}</p><Button variant="outline" size="sm" onClick={() => window.location.reload()}>Reload</Button></div>}
  </section>
}
