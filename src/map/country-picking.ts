import type { FeatureCollection } from 'geojson'
import type {
  Map as MapLibreMap,
  MapMouseEvent,
  GeoJSONSource,
  ExpressionSpecification,
} from 'maplibre-gl'
import { loadCountryOverview } from '@/lib/analysis-countries'
import { FIRE_LAYER_BEFORE_ID } from './geography'
import { ANALYSIS_AREA_COLOR } from './analysis-colors'

export const COUNTRY_PICK_SOURCE = 'analysis-country-overview'
export const COUNTRY_PICK_LAYER = 'analysis-country-pick'
const LAYERS = [
  COUNTRY_PICK_LAYER,
  'analysis-country-hover-casing',
  'analysis-country-hover-outline',
]
const empty: FeatureCollection = { type: 'FeatureCollection', features: [] }

export function createCountryPickingController(
  map: MapLibreMap,
  options: {
    onPick: (countryId: string) => void
    onError?: (error: string | null) => void
    loadOverview?: () => Promise<FeatureCollection>
  },
) {
  let active = false
  let disposed = false
  let countries: FeatureCollection | null = null
  let pending: Promise<void> | null = null
  let hovered: string | number | null = null
  let cursorOwned = false
  let previousCursor = ''
  const tooltip = document.createElement('div')
  tooltip.className = 'analysis-country-tooltip'
  tooltip.hidden = true
  tooltip.setAttribute('aria-hidden', 'true')
  map.getContainer().append(tooltip)

  function ensureLayers() {
    if (disposed) return
    if (!map.getSource(COUNTRY_PICK_SOURCE))
      map.addSource(COUNTRY_PICK_SOURCE, {
        type: 'geojson',
        data: countries ?? empty,
        tolerance: 0.3,
      })
    const before = map.getLayer(FIRE_LAYER_BEFORE_ID) ? FIRE_LAYER_BEFORE_ID : undefined
    const visibility = active ? 'visible' : 'none'
    const hover: ExpressionSpecification = ['boolean', ['feature-state', 'hover'], false]
    if (!map.getLayer(COUNTRY_PICK_LAYER))
      map.addLayer(
        {
          id: COUNTRY_PICK_LAYER,
          type: 'fill',
          source: COUNTRY_PICK_SOURCE,
          layout: { visibility },
          paint: { 'fill-color': ANALYSIS_AREA_COLOR, 'fill-opacity': ['case', hover, 0.1, 0.001] },
        },
        before,
      )
    if (!map.getLayer(LAYERS[1]))
      map.addLayer(
        {
          id: LAYERS[1],
          type: 'line',
          source: COUNTRY_PICK_SOURCE,
          layout: { visibility },
          paint: {
            'line-color': '#07173f',
            'line-width': 3.3,
            'line-opacity': ['case', hover, 0.7, 0],
          },
        },
        before,
      )
    if (!map.getLayer(LAYERS[2]))
      map.addLayer(
        {
          id: LAYERS[2],
          type: 'line',
          source: COUNTRY_PICK_SOURCE,
          layout: { visibility },
          paint: {
            'line-color': '#ffffff',
            'line-width': 1.35,
            'line-opacity': ['case', hover, 1, 0],
          },
        },
        before,
      )
  }

  function clearHover() {
    if (hovered !== null && map.getSource(COUNTRY_PICK_SOURCE))
      map.setFeatureState({ source: COUNTRY_PICK_SOURCE, id: hovered }, { hover: false })
    hovered = null
    tooltip.hidden = true
    if (cursorOwned) map.getCanvas().style.cursor = previousCursor
    cursorOwned = false
  }

  function hit(event: MapMouseEvent) {
    if (!active || disposed || !map.getLayer(COUNTRY_PICK_LAYER)) return undefined
    const projected = map.project(event.lngLat)
    if (Math.hypot(projected.x - event.point.x, projected.y - event.point.y) > 2) return undefined
    return map.queryRenderedFeatures(event.point, { layers: [COUNTRY_PICK_LAYER] })[0]
  }

  function pointerMove(event: MapMouseEvent) {
    if (!active || disposed) return
    const feature = hit(event)
    const id = feature?.id ?? null
    if (id !== hovered) {
      clearHover()
      if (id !== null) {
        hovered = id
        map.setFeatureState({ source: COUNTRY_PICK_SOURCE, id }, { hover: true })
      }
    }
    if (id === null) return
    if (!cursorOwned) {
      previousCursor = map.getCanvas().style.cursor
      cursorOwned = true
      map.getCanvas().style.cursor = 'pointer'
    }
    tooltip.textContent = String(feature?.properties?.name ?? '')
    tooltip.hidden = !tooltip.textContent
    const width = map.getContainer().clientWidth
    const height = map.getContainer().clientHeight
    tooltip.style.transform = `translate3d(${Math.max(8, Math.min(event.point.x + 14, width - 170))}px, ${Math.max(8, Math.min(event.point.y + 14, height - 34))}px, 0)`
  }

  function click(event: MapMouseEvent) {
    const feature = hit(event)
    const id = feature?.properties?.countryId
    if (typeof id === 'string') options.onPick(id)
  }

  function load() {
    if (countries || pending || disposed) return
    options.onError?.(null)
    pending = (options.loadOverview ?? loadCountryOverview)()
      .then((collection) => {
        if (disposed) return
        countries = collection
        ;(map.getSource(COUNTRY_PICK_SOURCE) as GeoJSONSource | undefined)?.setData(collection)
      })
      .catch(() => {
        if (!disposed && active)
          options.onError?.(
            'Map country outlines could not load. Choose a country in search or try map selection again.',
          )
      })
      .finally(() => {
        pending = null
      })
  }

  function setEnabled(enabled: boolean) {
    if (disposed) return
    if (!enabled) clearHover()
    active = enabled
    ensureLayers()
    for (const id of LAYERS) {
      const visibility = enabled ? 'visible' : 'none'
      if (map.getLayoutProperty(id, 'visibility') !== visibility)
        map.setLayoutProperty(id, 'visibility', visibility)
    }
    if (enabled) load()
  }

  function styleLoad() {
    clearHover()
    ensureLayers()
    if (active) load()
  }

  map.on('mousemove', pointerMove)
  map.on('click', click)
  map.on('mouseout', clearHover)
  map.on('movestart', clearHover)
  map.on('style.load', styleLoad)

  return {
    setEnabled,
    destroy() {
      if (disposed) return
      clearHover()
      disposed = true
      map.off('mousemove', pointerMove)
      map.off('click', click)
      map.off('mouseout', clearHover)
      map.off('movestart', clearHover)
      map.off('style.load', styleLoad)
      tooltip.remove()
      for (const id of [...LAYERS].reverse()) if (map.getLayer(id)) map.removeLayer(id)
      if (map.getSource(COUNTRY_PICK_SOURCE)) map.removeSource(COUNTRY_PICK_SOURCE)
    },
  }
}
