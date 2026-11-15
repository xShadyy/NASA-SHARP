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
import type { Outlook } from './InvestigationScience'
import { FIRE_MAP_LAYERS } from '@/map/fire-map-style'
import { createInvestigationLayerController, DIAGNOSTIC_LAYERS } from '@/map/investigation-layers'

type Diagnostic = 'recurrence' | 'outlook'
type Result<T> = { query: unknown; generation?: string; value: T | null; error: string }

/** Request identity depends on investigation scope; camera and opacity never refetch. */
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
  const [enabled, setEnabled] = useState<Record<Diagnostic, boolean>>({
    recurrence: false,
    outlook: false,
  })
  const [opacity, setOpacity] = useState(0.55)
  const [recurrenceResult, setRecurrence] = useState<Result<GeoJSON.FeatureCollection> | null>(null)
  const [outlookResult, setOutlook] = useState<Result<Outlook> | null>(null)
  const currentRecurrence =
    recurrenceResult?.query === query && recurrenceResult.generation === sourceGeneration
  const recurrence = currentRecurrence ? recurrenceResult.value : null
  const outlook = outlookResult?.query === query ? outlookResult.value : null
  const status = {
    recurrence: !currentRecurrence
      ? !sourceGeneration
        ? 'Load observations for this interval, or select a day from a long interval, to map recurrence.'
        : 'Loading recurrence…'
      : recurrenceResult.error ||
        `${recurrence?.features.length.toLocaleString() ?? '0'} occupied 2 km cells · distinct reported UTC dates`,
    outlook:
      outlookResult?.query !== query
        ? 'Loading outlook…'
        : outlookResult.error || `${outlook?.state.replaceAll('-', ' ')}. ${outlook?.reason ?? ''}`,
  }
  const renderer = useRef<ReturnType<typeof createInvestigationLayerController> | null>(null)
  const inspectionPopup = useRef<Popup | null>(null)

  useEffect(() => {
    if (!query || !sourceGeneration || !enabled.recurrence || currentRecurrence) return
    const controller = new AbortController()
    investigationRequest<GeoJSON.FeatureCollection>(
      'recurrence',
      query,
      { sourceGeneration },
      controller.signal,
    ).then(
      (value) => {
        if (!controller.signal.aborted)
          setRecurrence({ query, generation: sourceGeneration, value, error: '' })
      },
      (error: Error) => {
        if (!controller.signal.aborted)
          setRecurrence({ query, generation: sourceGeneration, value: null, error: error.message })
      },
    )
    return () => controller.abort()
  }, [query, enabled.recurrence, currentRecurrence, sourceGeneration])
  useEffect(() => {
    if (!query || !enabled.outlook || outlookResult?.query === query) return
    const controller = new AbortController()
    investigationRequest<Outlook>('outlook', query, {}, controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) setOutlook({ query, value, error: '' })
      },
      (error: Error) => {
        if (!controller.signal.aborted) setOutlook({ query, value: null, error: error.message })
      },
    )
    return () => controller.abort()
  }, [query, enabled.outlook, outlookResult?.query])

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
    renderer.current?.setData({
      recurrence,
      outlook: outlook?.features ?? null,
      recurrenceEnabled: enabled.recurrence,
      outlookEnabled: enabled.outlook,
      forecastValidated: outlook?.state === 'experimental-forecast',
    })
  }, [map, enabled.recurrence, enabled.outlook, recurrence, outlook])
  useEffect(() => {
    renderer.current?.setOpacity(opacity)
  }, [map, opacity])

  const inspectClick = useEffectEvent((event: MapMouseEvent, popup: Popup) => {
    if (!map) return
    const layers = DIAGNOSTIC_LAYERS.filter((id) => map.getLayer(id))
    const observationLayers = Object.values(FIRE_MAP_LAYERS).filter((id) => map.getLayer(id))
    if (
      observationLayers.length &&
      map.queryRenderedFeatures(event.point, { layers: observationLayers }).length
    )
      return
    const feature = layers.length ? map.queryRenderedFeatures(event.point, { layers })[0] : null
    if (!feature) return
    const properties = feature.properties ?? {}
    const isRecurrence = feature.layer.id === DIAGNOSTIC_LAYERS[0]
    const body = document.createElement('section')
    body.className = 'fire-popup'
    const title = document.createElement('strong')
    title.textContent = isRecurrence
      ? `Detections reported on ${properties.distinctDates} selected dates`
      : outlook?.state === 'experimental-forecast' &&
          typeof properties.probability === 'number' &&
          Number.isFinite(properties.probability)
        ? `${(Number(properties.probability) * 100).toFixed(1)}% reported-hotspot probability`
        : `${properties.historicalReportedDates ?? 'Unknown'} historical dates with reported detections`
    body.append(title)
    const details = document.createElement('p')
    details.textContent = isRecurrence
      ? `${properties.observationCount} observations. First: ${properties.firstAcquiredAt}. Latest: ${properties.latestAcquiredAt}. Reporting coverage: ${properties.coveredReportingDays}/${properties.selectedDays} selected days. Repeated reporting does not establish continuous burning.`
      : `${outlook?.target}. ${outlook?.horizonHours ? `Horizon: ${outlook.horizonHours} hours.` : 'Historical activity; no forecast horizon.'} ${outlook?.reason ?? ''} Grid: ${outlook?.gridSizeM ?? 'unknown'} m. Model: ${outlook?.modelVersion ?? 'unavailable'}. Inputs: ${JSON.stringify(outlook?.inputFreshness ?? {})}. Features: ${String(properties.features ?? 'unavailable')}`
    body.append(details)
    const action = document.createElement('button')
    action.type = 'button'
    action.className = 'fire-popup-action'
    action.textContent = 'Open in Area Analytics'
    action.addEventListener('click', () => {
      if (feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon')
        onInspect({}, feature.geometry)
      popup.remove()
    })
    body.append(action)
    popup.setLngLat(event.lngLat).setDOMContent(body).addTo(map)
  })

  useEffect(() => {
    if (!map || !interactive) return
    const popup = new Popup({
      closeButton: true,
      closeOnClick: true,
      maxWidth: '460px',
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
  }, [map, interactive])
  useEffect(() => {
    inspectionPopup.current?.remove()
  }, [query, recurrence, outlook, enabled.recurrence, enabled.outlook])

  return (
    <fieldset>
      <legend>Activity diagnostics</legend>
      {(['recurrence', 'outlook'] as const).map((kind) => (
        <div key={kind}>
          <div className="layer-setting-row">
            <Checkbox
              id={`sharp-${kind}-toggle`}
              checked={enabled[kind]}
              disabled={!query}
              onCheckedChange={(checked) =>
                setEnabled((current) => ({ ...current, [kind]: checked === true }))
              }
            />
            <label htmlFor={`sharp-${kind}-toggle`}>
              <span>
                {kind === 'recurrence'
                  ? 'Observation recurrence'
                  : 'Experimental outlook · 24 hours'}
              </span>
              <small>
                {enabled[kind]
                  ? status[kind]
                  : kind === 'recurrence'
                    ? 'Distinct dates with reported detections · 2 km equal-area grid'
                    : 'Reported satellite hotspot activity; probabilities require held-out validation'}
              </small>
            </label>
          </div>
          {enabled[kind] && (
            <div className="diagnostic-legend">
              <span
                style={{
                  background:
                    kind === 'recurrence'
                      ? 'linear-gradient(90deg,#c5c4ed,#31256b)'
                      : 'linear-gradient(90deg,#d2f2ef,#123f68)',
                }}
              />
              {kind === 'recurrence'
                ? '1 → 31 reported dates'
                : outlook?.state === 'experimental-forecast'
                  ? '0 → 100% · next 24 hours'
                  : 'Fewer → more historical reported dates'}
              <small>
                Unfilled cells: unavailable or unsupported
                {kind === 'outlook' && outlook?.issueTime
                  ? ` · Issued ${outlook.issueTime} · Valid ${outlook.validStart} to ${outlook.validEnd}`
                  : ''}
              </small>
            </div>
          )}
          {enabled[kind] &&
            (kind === 'recurrence'
              ? currentRecurrence && recurrenceResult.error
              : outlookResult?.query === query && outlookResult.error) && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => (kind === 'recurrence' ? setRecurrence(null) : setOutlook(null))}
              >
                Retry {kind}
              </Button>
            )}
        </div>
      ))}
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
      <Button size="sm" variant="ghost" disabled={!query} onClick={() => onInspect({})}>
        Method and validation details
      </Button>
    </fieldset>
  )
}
