import { apiUrl } from '@/lib/api-config'
import { Popup, type GeoJSONSource, type Map as MapLibreMap, type MapMouseEvent } from 'maplibre-gl'
import type { FeatureCollection } from 'geojson'
import type { GlobalManifest } from '@/hooks/use-global-fires'
import type { FrozenSelection, ObservationFilters } from '@/lib/investigation'
import type { FireFeature } from '@/lib/fire-severity'
import { mergeGlobalTiles, visibleGlobalTiles, type GlobalTileCollection } from '@/lib/global-tiles'
import { FIRE_COLOR_EXPRESSION, FIRE_SQUARE_IMAGE, fireSquareSprite } from './fire-map-style'
import { FIRE_LAYER_BEFORE_ID } from './geography'
import { createDraggablePopup } from './draggable-popup'
import { createGlobalObservationPopup } from './global-observation-popup'

export const GLOBAL_AGGREGATE_SOURCE = 'global-hotspot-aggregates'
export const GLOBAL_AGGREGATE_LAYER = 'global-hotspot-squares'
const SELECTED_SOURCE = 'global-hotspot-selected',
  SELECTED_LAYER = 'global-hotspot-selected-square'
const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] }
export type GlobalDisplayStatus = {
  snapshotId?: string
  loading: boolean
  error: string
  visibleTiles: number
  displayFeatures: number
  decodedBytes: number
}

export function createGlobalFireController(
  map: MapLibreMap,
  options: {
    onObservations: (features: FireFeature[]) => void
    onStatus: (status: GlobalDisplayStatus) => void
    fetch?: typeof fetch
    createPopup?: () => Popup
    onOpenAnalytics?: (selection: FrozenSelection) => void
    onRefreshSnapshot?: () => void
    
    displayOnly?: boolean
  },
) {
  let manifest: GlobalManifest | null = null,
    enabled = true,
    interactive = true,
    disposed = false
  let aggregates: FeatureCollection = EMPTY,
    selected: FeatureCollection = EMPTY
  let observationKey = '',
    aggregateKey = ''
  let displayFilters: ObservationFilters = {}
  let parentAggregate: string | undefined
  let retainedObservations: FireFeature[] = []
  let request: AbortController | null = null,
    revision = 0,
    displayKey = '',
    decodedBytes = 0
  let popupView: ReturnType<typeof createGlobalObservationPopup> | null = null
  const cache = new Map<string, GlobalTileCollection>()
  const cacheSizes = new Map<string, number>()
  let cacheBytes = 0
  const sources = new Map<string, { source: GeoJSONSource; data: FeatureCollection }>()
  const popup =
    options.createPopup?.() ??
    new Popup({
      closeButton: true,
      closeOnClick: false,
      maxWidth: '460px',
      className: 'fire-popup-wrap',
    })
  const dragging = createDraggablePopup(popup, map)
  function setSource(id: string, data: FeatureCollection) {
    let source = map.getSource(id) as GeoJSONSource | undefined
    if (!source) {
      map.addSource(id, { type: 'geojson', data, promoteId: 'id' })
      source = map.getSource(id) as GeoJSONSource
    } else if (sources.get(id)?.source !== source || sources.get(id)?.data !== data)
      void source.setData(data)
    sources.set(id, { source, data })
  }
  function ensure() {
    if (disposed || !map.getStyle()) return
    if (!map.hasImage(FIRE_SQUARE_IMAGE))
      map.addImage(FIRE_SQUARE_IMAGE, fireSquareSprite(), { sdf: true, pixelRatio: 2 })
    setSource(GLOBAL_AGGREGATE_SOURCE, aggregates)
    setSource(SELECTED_SOURCE, selected)
    const before = map.getLayer(FIRE_LAYER_BEFORE_ID) ? FIRE_LAYER_BEFORE_ID : undefined
    if (!map.getLayer(GLOBAL_AGGREGATE_LAYER))
      map.addLayer(
        {
          id: GLOBAL_AGGREGATE_LAYER,
          type: 'symbol',
          source: GLOBAL_AGGREGATE_SOURCE,
          layout: {
            'icon-image': FIRE_SQUARE_IMAGE,
            'icon-size': options.displayOnly
              ? ['interpolate', ['linear'], ['zoom'], 0, 0.375, 8, 0.51, 14, 0.63]
              : ['interpolate', ['linear'], ['zoom'], 0, 0.85, 10, 1.2, 18, 1.5],
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
            'icon-padding': 0,
            'text-field': options.displayOnly
              ? ''
              : ['case', ['>', ['get', 'count'], 1], ['to-string', ['get', 'count']], ''],
            'text-size': 9,
            'text-font': ['Fira Sans'],
            'text-allow-overlap': true,
            'text-ignore-placement': true,
            'text-padding': 0,
            visibility: enabled ? 'visible' : 'none',
          },
          paint: {
            'icon-color': FIRE_COLOR_EXPRESSION,
            'icon-halo-color': '#25292e',
            'icon-halo-width': 0.6,
            'text-color': '#111827',
            'text-halo-color': '#ffffff',
            'text-halo-width': 0.8,
          },
        },
        before,
      )
    if (!map.getLayer(SELECTED_LAYER))
      map.addLayer(
        {
          id: SELECTED_LAYER,
          type: 'symbol',
          source: SELECTED_SOURCE,
          layout: {
            'icon-image': FIRE_SQUARE_IMAGE,
            'icon-size': 0.8,
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
            'icon-padding': 0,
            visibility: enabled ? 'visible' : 'none',
          },
          paint: {
            'icon-color': FIRE_COLOR_EXPRESSION,
            'icon-halo-color': '#ffffff',
            'icon-halo-width': 2,
          },
        },
        before,
      )
    map.setLayoutProperty(GLOBAL_AGGREGATE_LAYER, 'visibility', enabled ? 'visible' : 'none')
    map.setLayoutProperty(
      SELECTED_LAYER,
      'visibility',
      enabled || selected.features.length ? 'visible' : 'none',
    )
  }
  function clearPopup() {
    popupView?.destroy()
    popupView = null
  }
  popup.on('close', clearPopup)
  function onClick(event: MapMouseEvent) {
    if (
      !enabled ||
      options.displayOnly ||
      !interactive ||
      disposed ||
      !manifest?.snapshotId ||
      !map.getLayer(GLOBAL_AGGREGATE_LAYER)
    )
      return
    const hit = map.queryRenderedFeatures(event.point, { layers: [GLOBAL_AGGREGATE_LAYER] })[0]
    if (!hit) {
      popup.remove()
      return
    }
    const id = hit.properties?.aggregateId
    if (typeof id !== 'string') return
    popup.remove()
    popupView = createGlobalObservationPopup({
      snapshotId: manifest.snapshotId,
      window: manifest.window,
      aggregateId: id,
      interval: manifest.interval!,
      onOpenAnalytics: (selection) => options.onOpenAnalytics?.(selection),
      onRefreshSnapshot: () => {
        popup.remove()
        options.onRefreshSnapshot?.()
      },
      onSelect: (feature) => {
        selected = feature ? { type: 'FeatureCollection', features: [feature] } : EMPTY
        if (!disposed) ensure()
      },
      onZoom: () => {
        const bounds = hit.properties.bbox
        let bbox: unknown = bounds
        if (typeof bounds === 'string') {
          try {
            bbox = JSON.parse(bounds)
          } catch {
            bbox = null
          }
        }
        if (Array.isArray(bbox) && bbox.length === 4 && bbox.every(Number.isFinite))
          map.fitBounds(
            [
              [bbox[0], bbox[1]],
              [bbox[2], bbox[3]],
            ],
            { padding: 60, maxZoom: 16 },
          )
        else if (hit.geometry.type === 'Point')
          map.easeTo({
            center: hit.geometry.coordinates as [number, number],
            zoom: Math.min(16, map.getZoom() + 2),
          })
      },
    })
    popup.setMaxWidth('240px').setLngLat(event.lngLat).setDOMContent(popupView.root).addTo(map)
    dragging.refresh()
  }
  const fetchTile = options.fetch ?? fetch
  async function refresh() {
    if (
      disposed ||
      !enabled ||
      !manifest?.snapshotId ||
      !manifest.tiles ||
      !manifest.interval ||
      manifest.status === 'unavailable' ||
      manifest.status === 'building'
    )
      return
    const bounds = map.getBounds()
    const tiles = visibleGlobalTiles(
      {
        west: bounds.getWest(),
        east: bounds.getEast(),
        south: bounds.getSouth(),
        north: bounds.getNorth(),
      },
      map.getZoom(),
    )
    const key = `${manifest.snapshotId}:${manifest.window}:${tiles
      .map((t) => `${t.z}/${t.x}/${t.y}`)
      .sort()
      .join(',')}`
    if (displayKey === key) return
    request?.abort()
    request = new AbortController()
    const controller = request
    const current = ++revision
    const template = manifest.tiles
    const activeSnapshot = manifest.snapshotId,
      activeWindow = manifest.window
    options.onStatus({
      snapshotId: activeSnapshot,
      loading: true,
      error: '',
      visibleTiles: tiles.length,
      displayFeatures: aggregates.features.length,
      decodedBytes,
    })
    try {
      const loaded: GlobalTileCollection[] = []
      for (let start = 0; start < tiles.length; start += 4) {
        const batch = await Promise.all(
          tiles.slice(start, start + 4).map(async (tile) => {
            let url = template
              .replace('{snapshotId}', encodeURIComponent(activeSnapshot))
              .replace('{window}', activeWindow)
              .replace('{z}', String(tile.z))
              .replace('{x}', String(tile.x))
              .replace('{y}', String(tile.y))
            if (Object.keys(displayFilters).length || parentAggregate)
              url += `${url.includes('?') ? '&' : '?'}filters=${encodeURIComponent(JSON.stringify(displayFilters))}${parentAggregate ? `&aggregateId=${encodeURIComponent(parentAggregate)}` : ''}`
            const existing = cache.get(url)
            if (existing) {
              cache.delete(url)
              cache.set(url, existing)
              return existing
            }
            const response = await fetchTile(apiUrl(url), { signal: controller.signal })
            if (!response.ok) {
              const body = await response.json().catch(() => ({}))
              throw new Error(
                body.message ?? `Stored hotspot tiles could not load (${response.status}).`,
              )
            }
            const raw = await response.text()
            if (disposed || controller.signal.aborted || current !== revision)
              throw new DOMException('Obsolete global tiles', 'AbortError')
            decodedBytes += new TextEncoder().encode(raw).byteLength
            const body = JSON.parse(raw) as GlobalTileCollection
            if (
              body.type !== 'FeatureCollection' ||
              !Array.isArray(body.features) ||
              body.features.length > 1024
            )
              throw new Error('The global tile exceeded its bounded presentation contract.')
            cache.set(url, body)
            const bytes = new TextEncoder().encode(raw).byteLength
            cacheSizes.set(url, bytes)
            cacheBytes += bytes
            while (cache.size > 64 || cacheBytes > 16 * 1024 * 1024) {
              const oldest = cache.keys().next().value!
              cacheBytes -= cacheSizes.get(oldest) ?? 0
              cache.delete(oldest)
              cacheSizes.delete(oldest)
            }
            return body
          }),
        )
        loaded.push(...batch)
      }
      if (disposed || controller.signal.aborted || current !== revision) return
      const merged = mergeGlobalTiles(loaded)
      
      
      const nextAggregateKey = `${activeSnapshot}:${merged.aggregates.features
        .map((feature) => String(feature.id ?? feature.properties.id))
        .sort()
        .join('\n')}`
      const nextObservationKey = `${activeSnapshot}:${merged.observations
        .map((feature) => feature.properties.id)
        .sort()
        .join('\n')}`
      if (nextAggregateKey !== aggregateKey) {
        if (aggregates.features.length || merged.aggregates.features.length)
          aggregates = merged.aggregates
        aggregateKey = nextAggregateKey
      }
      displayKey = key
      ensure()
      if (nextObservationKey !== observationKey) {
        observationKey = nextObservationKey
        if (retainedObservations.length || merged.observations.length) {
          retainedObservations = merged.observations
          options.onObservations(retainedObservations)
        }
      }
      options.onStatus({
        snapshotId: activeSnapshot,
        loading: false,
        error: '',
        visibleTiles: tiles.length,
        displayFeatures: aggregates.features.length + merged.observations.length,
        decodedBytes,
      })
    } catch (error) {
      if (!disposed && !controller.signal.aborted && current === revision)
        options.onStatus({
          snapshotId: activeSnapshot,
          loading: false,
          error: error instanceof Error ? error.message : 'Global tiles could not load.',
          visibleTiles: tiles.length,
          displayFeatures: aggregates.features.length,
          decodedBytes,
        })
    }
  }
  function styleLoad() {
    ensure()
    void refresh()
  }
  const navigate = () => void refresh()
  map.on('moveend', navigate)
  map.on('style.load', styleLoad)
  if (!options.displayOnly) map.on('click', onClick)
  const outside = (event: PointerEvent) => {
    if (
      popup.isOpen() &&
      event.target instanceof Element &&
      !event.target.closest('.fire-popup-wrap')
    )
      popup.remove()
  }
  if (typeof document !== 'undefined') document.addEventListener('pointerdown', outside)
  return {
    setHighlight(feature: FireFeature | null) {
      selected = feature ? { type: 'FeatureCollection', features: [feature] } : EMPTY
      ensure()
    },
    setInvestigation(filters: ObservationFilters = {}, aggregateId?: string) {
      if (
        JSON.stringify(filters) === JSON.stringify(displayFilters) &&
        parentAggregate === aggregateId
      )
        return
      displayFilters = filters
      parentAggregate = aggregateId
      displayKey = ''
      request?.abort()
      revision++
      popup.remove()
      void refresh()
    },
    setManifest(next: GlobalManifest | null) {
      const changed = next?.snapshotId !== manifest?.snapshotId || next?.window !== manifest?.window
      manifest = next
      if (changed) {
        request?.abort()
        revision++
        displayKey = ''
        aggregates = EMPTY
        selected = EMPTY
        aggregateKey = ''
        observationKey = ''
        popup.remove()
        cache.clear()
        cacheSizes.clear()
        cacheBytes = 0
        if (retainedObservations.length) {
          retainedObservations = []
          options.onObservations(retainedObservations)
        }
        ensure()
      }
      void refresh()
    },
    setEnabled(next: boolean) {
      if (enabled === next) return
      enabled = next
      if (!next) {
        request?.abort()
        revision++
        popup.remove()
      }
      ensure()
      if (next) void refresh()
    },
    setInteractive(next: boolean) {
      interactive = !options.displayOnly && next
      if (!interactive) popup.remove()
    },
    retry() {
      displayKey = ''
      void refresh()
    },
    destroy() {
      disposed = true
      request?.abort()
      dragging.destroy()
      popup.remove()
      clearPopup()
      map.off('moveend', navigate)
      map.off('style.load', styleLoad)
      map.off('click', onClick)
      if (typeof document !== 'undefined') document.removeEventListener('pointerdown', outside)
      for (const id of [GLOBAL_AGGREGATE_LAYER, SELECTED_LAYER])
        if (map.getLayer(id)) map.removeLayer(id)
      for (const id of [GLOBAL_AGGREGATE_SOURCE, SELECTED_SOURCE])
        if (map.getSource(id)) map.removeSource(id)
      cache.clear()
      cacheSizes.clear()
      cacheBytes = 0
      sources.clear()
    },
  }
}
