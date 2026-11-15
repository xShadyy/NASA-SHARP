import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { Popup, type Map as MapLibreMap, type MapMouseEvent } from 'maplibre-gl'
import { Checkbox } from './ui/checkbox'
import { Button } from './ui/button'
import {
  investigationRequest,
  type InvestigationScope,
  type ObservationFilters,
} from '@/lib/investigation'
import type { AreaGeometry } from '@/lib/analysis-area'
import { FIRE_MAP_LAYERS } from '@/map/fire-map-style'
import { createInvestigationLayerController, DIAGNOSTIC_LAYERS } from '@/map/investigation-layers'

type Result = {
  query: unknown
  generation?: string
  value: GeoJSON.FeatureCollection | null
  error: string
}


export function useInvestigationLayers({
  map,
  query,
  sourceGeneration,
  interactive,
  onInspect,
}: {
  map: MapLibreMap | null
  query: InvestigationScope['query'] | null
  sourceGeneration?: string
  interactive: boolean
  onInspect: (filters: ObservationFilters, geometry?: AreaGeometry) => void
}) {
  const [enabled, setEnabled] = useState(false)
  const [opacity, setOpacity] = useState(0.55)
  const [result, setResult] = useState<Result | null>(null)
  const current = result?.query === query && result?.generation === sourceGeneration
  const recurrence = current ? (result?.value ?? null) : null
  const status = !current
    ? sourceGeneration
      ? 'Loading recurrence…'
      : 'Load observations for the selected interval.'
    : result?.error ||
      `${recurrence?.features.length.toLocaleString() ?? '0'} occupied 2 km cells - distinct reported UTC dates`
  const renderer = useRef<ReturnType<typeof createInvestigationLayerController> | null>(null)
  const inspectionPopup = useRef<Popup | null>(null)

  useEffect(() => {
    if (!query || !sourceGeneration || !enabled || current) return
    const controller = new AbortController()
    investigationRequest<GeoJSON.FeatureCollection>(
      'recurrence',
      query,
      { sourceGeneration },
      controller.signal,
    ).then(
      (value) => {
        if (!controller.signal.aborted)
          setResult({ query, generation: sourceGeneration, value, error: '' })
      },
      (error: Error) => {
        if (!controller.signal.aborted)
          setResult({ query, generation: sourceGeneration, value: null, error: error.message })
      },
    )
    return () => controller.abort()
  }, [query, sourceGeneration, enabled, current])
  useEffect(() => {
    if (!map) return
    const controller = createInvestigationLayerController(map)
    renderer.current = controller
    return () => {
      renderer.current = null
      controller.destroy()
    }
  }, [map])
  useEffect(() => {
    renderer.current?.setData({ recurrence, recurrenceEnabled: enabled })
  }, [map, recurrence, enabled])
  useEffect(() => {
    renderer.current?.setOpacity(opacity)
  }, [map, opacity])

  const inspectClick = useEffectEvent((event: MapMouseEvent, popup: Popup) => {
    if (!map) return
    const observationLayers = Object.values(FIRE_MAP_LAYERS).filter((id) => map.getLayer(id))
    if (
      observationLayers.length &&
      map.queryRenderedFeatures(event.point, { layers: observationLayers }).length
    )
      return
    const layers = DIAGNOSTIC_LAYERS.filter((id) => map.getLayer(id))
    const feature = layers.length ? map.queryRenderedFeatures(event.point, { layers })[0] : null
    if (!feature) return
    const body = document.createElement('section')
    body.className = 'fire-popup fire-popup-compact'
    const title = document.createElement('strong')
    title.textContent = 'Observation recurrence'
    const action = document.createElement('button')
    action.type = 'button'
    action.className = 'fire-popup-action'
    action.textContent = 'Open in Area Analytics'
    action.addEventListener('click', () => {
      if (feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon')
        onInspect({}, feature.geometry)
      popup.remove()
    })
    body.append(title, action)
    popup.setLngLat(event.lngLat).setDOMContent(body).addTo(map)
  })
  useEffect(() => {
    if (!map || !interactive || !enabled) return
    const popup = new Popup({
      closeButton: true,
      closeOnClick: true,
      maxWidth: '240px',
      className: 'fire-popup-wrap',
    })
    inspectionPopup.current = popup
    const click = (event: MapMouseEvent) => inspectClick(event, popup)
    const close = () => popup.remove()
    map.on('click', click)
    map.on('style.load', close)
    return () => {
      inspectionPopup.current = null
      map.off('click', click)
      map.off('style.load', close)
      popup.remove()
    }
  }, [map, interactive, enabled])
  useEffect(() => {
    inspectionPopup.current?.remove()
  }, [query, recurrence, enabled])

  return (
    <fieldset>
      <legend>Activity diagnostics</legend>
      <div className="layer-setting-row">
        <Checkbox
          id="sharp-recurrence-toggle"
          checked={enabled}
          disabled={!query}
          onCheckedChange={(checked) => setEnabled(checked === true)}
        />
        <label htmlFor="sharp-recurrence-toggle">
          <span>Observation recurrence</span>
          <small>
            {enabled ? status : 'Distinct dates with reported detections - 2 km equal-area grid'}
          </small>
        </label>
      </div>
      {enabled && current && result?.error && (
        <Button size="sm" variant="outline" onClick={() => setResult(null)}>
          Retry recurrence
        </Button>
      )}
      <label className="diagnostic-opacity">
        Opacity
        <input
          type="range"
          aria-label="Activity diagnostic opacity"
          min="0.1"
          max="0.9"
          step="0.05"
          value={opacity}
          onChange={(event) => setOpacity(Number(event.target.value))}
        />
      </label>
      {!query && <small>Select and confirm an area first.</small>}
    </fieldset>
  )
}
