import type { FeatureCollection } from 'geojson'
import type { ExpressionSpecification, GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl'
import { FIRE_MAP_LAYERS } from './fire-map-style'

export const DIAGNOSTIC_LAYERS = ['sharp-recurrence'] as const
const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] }
const RECURRENCE_COLOR: ExpressionSpecification = [
  'interpolate',
  ['linear'],
  ['get', 'distinctDates'],
  1,
  '#c5c4ed',
  7,
  '#6665b4',
  31,
  '#31256b',
]
type DiagnosticData = {
  recurrence: FeatureCollection | null
  recurrenceEnabled: boolean
}

/** Retains unchanged source objects; camera and opacity updates do no GeoJSON preparation. */
export function createInvestigationLayerController(map: MapLibreMap) {
  let data: DiagnosticData = {
    recurrence: null,
    recurrenceEnabled: false,
  }
  let opacity = 0.55
  let destroyed = false
  let restorePending = false
  let orderingPending = false
  const retained = new Map<string, { source: GeoJSONSource; data: FeatureCollection }>()

  function firstObservationLayer() {
    return Object.values(FIRE_MAP_LAYERS).find((id) => map.getLayer(id))
  }

  function orderAfterListeners(restore = false) {
    restorePending ||= restore
    if (orderingPending) return
    orderingPending = true
    // Other style.load listeners restore observation layers later in the same event.
    queueMicrotask(() => {
      if (!destroyed) {
        if (restorePending) {
          restorePending = false
          apply()
        }
        const before = firstObservationLayer()
        if (before)
          for (const id of DIAGNOSTIC_LAYERS) if (map.getLayer(id)) map.moveLayer(id, before)
      }
      orderingPending = false
    })
  }

  function onStyleLoad() {
    orderAfterListeners(true)
  }

  function apply() {
    // isStyleLoaded also waits for remote tiles and pending GeoJSON preparation.
    // These do not prevent updating an already initialized style's local sources.
    if (destroyed || !map.getStyle()) return
    const before = firstObservationLayer()
    for (const id of DIAGNOSTIC_LAYERS) {
      const collection = data.recurrence ?? EMPTY
      const enabled = data.recurrenceEnabled
      let source = map.getSource(id) as GeoJSONSource | undefined
      if (!source) {
        map.addSource(id, { type: 'geojson', data: collection })
        source = map.getSource(id) as GeoJSONSource
      } else if (retained.get(id)?.source !== source || retained.get(id)?.data !== collection) {
        void source.setData(collection)
      }
      retained.set(id, { source, data: collection })
      if (!map.getLayer(id)) {
        map.addLayer(
          {
            id,
            type: 'fill',
            source: id,
            layout: { visibility: enabled ? 'visible' : 'none' },
            paint: { 'fill-opacity': opacity, 'fill-color': RECURRENCE_COLOR },
          },
          before,
        )
      } else {
        map.setLayoutProperty(id, 'visibility', enabled ? 'visible' : 'none')
        map.setPaintProperty(id, 'fill-color', RECURRENCE_COLOR)
      }
    }
    if (!before) orderAfterListeners()
  }

  map.on('style.load', onStyleLoad)
  return {
    setData(next: DiagnosticData) {
      data = next
      apply()
    },
    setOpacity(next: number) {
      if (next === opacity) return
      opacity = next
      for (const id of DIAGNOSTIC_LAYERS)
        if (map.getLayer(id)) map.setPaintProperty(id, 'fill-opacity', opacity)
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      map.off('style.load', onStyleLoad)
      for (const id of DIAGNOSTIC_LAYERS) {
        if (map.getLayer(id)) map.removeLayer(id)
        if (map.getSource(id)) map.removeSource(id)
      }
      retained.clear()
    },
  }
}
