import type { FeatureCollection } from 'geojson'
import type { GeoJSONSource, Map as MapLibreMap, MapSourceDataEvent } from 'maplibre-gl'
import type { GlobalManifest } from '@/hooks/use-global-fires'
import type { FireFeature } from '@/lib/fire-severity'
import type { ObservationFilters } from '@/lib/investigation'
import { apiUrl } from '@/lib/api-config'
import { FIRE_LAYER_BEFORE_ID } from './geography'
import { FIRE_SQUARE_IMAGE, fireSquareSprite } from './fire-map-style'

export const GLOBAL_RASTER_PREFIX = 'global-hotspot-raster-'
export type GlobalRasterDisplayStatus = {
  snapshotId?: string
  sourceId?: string
  loading: boolean
  updating?: boolean
  error: string
  visibleTiles: number
  displayFeatures: number
  decodedBytes: number
  displayedManifest: GlobalManifest | null
}
type Slot = {
  sourceId: string
  layerId: string
  url: string
  manifest: GlobalManifest
  source: ReturnType<MapLibreMap['getSource']>
  tiles: Set<string>
  stage: 'loading' | 'rendering' | 'ready'
  error: string
}
const SELECTED_SOURCE = 'global-hotspot-selected'
const SELECTED_LAYER = 'global-hotspot-selected-square'
const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] }


export function createGlobalRasterController(
  map: MapLibreMap,
  options: { onStatus: (status: GlobalRasterDisplayStatus) => void },
) {
  let manifest: GlobalManifest | null = null
  let filters: ObservationFilters = {}
  let aggregateId: string | undefined
  let active: Slot | null = null
  let pending: Slot | null = null
  let enabled = true
  let disposed = false
  let error = ''
  let signature = ''
  let selected: FeatureCollection = EMPTY
  let selectedSource: GeoJSONSource | undefined
  let selectedData: FeatureCollection | undefined

  function report() {
    if (disposed) return
    const displayed = active ?? pending
    const next = JSON.stringify([
      active?.manifest.snapshotId,
      pending?.manifest.snapshotId,
      active?.url,
      pending?.url,
      Boolean(pending),
      error,
      active?.tiles.size ?? 0,
      enabled,
      manifest?.status,
      displayed?.manifest.status,
      displayed?.manifest.retrievedAt,
      displayed?.manifest.latestAcquisition,
      displayed?.manifest.reason,
    ])
    if (next === signature) return
    signature = next
    options.onStatus({
      snapshotId: displayed?.manifest.snapshotId,
      sourceId: displayed?.sourceId,
      loading: Boolean(enabled && !active && pending),
      updating: Boolean(enabled && pending),
      error,
      visibleTiles: active?.tiles.size ?? 0,
      displayFeatures: displayed?.manifest.count ?? 0,
      decodedBytes: 0,
      displayedManifest: displayed?.manifest ?? null,
    })
  }
  function remove(slot: Slot | null) {
    if (!slot) return
    if (map.getLayer(slot.layerId)) map.removeLayer(slot.layerId)
    if (map.getSource(slot.sourceId)) map.removeSource(slot.sourceId)
  }
  function clear() {
    const previous = [active, pending]
    active = pending = null
    previous.forEach(remove)
  }
  function ensureHighlight(before?: string) {
    if (!selected.features.length && !map.getSource(SELECTED_SOURCE)) return
    if (!map.hasImage(FIRE_SQUARE_IMAGE))
      map.addImage(FIRE_SQUARE_IMAGE, fireSquareSprite(), { sdf: true, pixelRatio: 2 })
    const existing = map.getSource(SELECTED_SOURCE) as GeoJSONSource | undefined
    if (!existing) {
      map.addSource(SELECTED_SOURCE, { type: 'geojson', data: selected })
      selectedSource = map.getSource(SELECTED_SOURCE) as GeoJSONSource
      selectedData = selected
    } else if (existing !== selectedSource || selectedData !== selected) {
      void existing.setData(selected)
      selectedSource = existing
      selectedData = selected
    }
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
            'symbol-z-order': 'source',
            'icon-padding': 0,
          },
          paint: { 'icon-color': '#ff0000', 'icon-halo-color': '#ffffff', 'icon-halo-width': 2 },
        },
        before,
      )
  }
  function ensure() {
    if (disposed || !map.getStyle()) return
    const before = map.getLayer(FIRE_LAYER_BEFORE_ID) ? FIRE_LAYER_BEFORE_ID : undefined
    ensureHighlight(before)
    if (!enabled) {
      clear()
      report()
      return
    }
    if (!manifest?.snapshotId) {
      if (active) {
        const obsolete = pending
        pending = null
        remove(obsolete)
        error = `${manifest?.reason ?? 'A newer hotspot snapshot is unavailable.'} Showing the previous snapshot.`
      } else clear()
      report()
      return
    }
    
    if (active && map.getSource(active.sourceId) !== active.source) active = null
    if (pending && map.getSource(pending.sourceId) !== pending.source) pending = null
    if (!manifest.rasterTiles) {
      error = 'The hotspot map is temporarily unavailable. Please retry.'
      report()
      return
    }
    const params = new URLSearchParams()
    if (manifest.interval) params.set('interval', JSON.stringify(manifest.interval))
    if (Object.keys(filters).length) params.set('filters', JSON.stringify(filters))
    if (aggregateId) params.set('aggregateId', aggregateId)
    const url = apiUrl(manifest.rasterTiles) + (params.size ? `?${params}` : '')
    if (pending?.url === url || (!pending && active?.url === url)) {
      const existing = pending ?? active
      if (existing) existing.manifest = manifest
      report()
      return
    }
    const obsolete = pending
    pending = null
    remove(obsolete)
    
    const name = active?.sourceId.endsWith('a') ? 'b' : 'a'
    const sourceId = `${GLOBAL_RASTER_PREFIX}${name}`
    const layerId = `${sourceId}-pixels`
    error = ''
    map.addSource(sourceId, {
      type: 'raster',
      tiles: [url],
      tileSize: 512,
      minzoom: 0,
      maxzoom: manifest.rasterMaxZoom ?? 18,
      bounds: [-180, -85.0511287798066, 180, 85.0511287798066],
      attribution: 'NASA FIRMS',
    })
    pending = {
      sourceId,
      layerId,
      url,
      manifest,
      source: map.getSource(sourceId),
      tiles: new Set(),
      stage: 'loading',
      error: '',
    }
    map.addLayer(
      {
        id: layerId,
        type: 'raster',
        source: sourceId,
        paint: { 'raster-opacity': 0, 'raster-fade-duration': 0, 'raster-resampling': 'nearest' },
      },
      before,
    )
    report()
  }
  function matches(slot: Slot | null, event: { sourceId?: string; source?: unknown }) {
    if (!slot || event.sourceId !== slot.sourceId || map.getSource(slot.sourceId) !== slot.source)
      return false
    const tiles =
      event.source && typeof event.source === 'object' && 'tiles' in event.source
        ? event.source.tiles
        : undefined
    return !Array.isArray(tiles) || tiles[0] === slot.url
  }
  function sourceData(event: MapSourceDataEvent) {
    if (disposed || !enabled) return
    const slot = matches(pending, event) ? pending : matches(active, event) ? active : null
    if (
      !slot ||
      slot.stage === 'ready' ||
      event.type !== 'sourcedata' ||
      event.tile?.state !== 'loaded'
    )
      return
    const coordinate = event.coord?.canonical
    slot.tiles.add(coordinate ? `${coordinate.z}/${coordinate.x}/${coordinate.y}` : 'viewport')
    if (slot === pending) map.triggerRepaint()
  }
  function frame() {
    if (
      disposed ||
      !enabled ||
      !pending ||
      !pending.tiles.size ||
      map.getSource(pending.sourceId) !== pending.source ||
      !map.isSourceLoaded(pending.sourceId)
    )
      return
    if (pending.error && active) return
    if (pending.stage === 'loading') {
      map.setPaintProperty(pending.layerId, 'raster-opacity', 1)
      if (active) map.setPaintProperty(active.layerId, 'raster-opacity', 0)
      pending.stage = 'rendering'
      map.triggerRepaint()
      return
    }
    
    const previous = active
    active = pending
    pending = null
    active.stage = 'ready'
    error = active.error
    remove(previous)
    report()
  }
  function sourceError(event: {
    sourceId?: string
    source?: unknown
    error?: { message: string }
  }) {
    if (disposed || !enabled) return
    const slot = matches(pending, event) ? pending : matches(active, event) ? active : null
    if (!slot) return
    slot.error = event.error?.message ?? 'Some hotspot image tiles are unavailable.'
    if (slot === pending && active) {
      map.setPaintProperty(active.layerId, 'raster-opacity', 1)
      map.setPaintProperty(slot.layerId, 'raster-opacity', 0)
      slot.stage = 'loading'
    }
    error = active && pending ? `${slot.error} Showing the previous snapshot.` : slot.error
    report()
  }
  map.on('style.load', ensure)
  map.on('sourcedata', sourceData)
  map.on('error', sourceError)
  map.on('render', frame)
  return {
    setManifest(next: GlobalManifest | null) {
      manifest = next
      ensure()
    },
    setInvestigation(next: ObservationFilters = {}, parentAggregate?: string) {
      filters = next
      aggregateId = parentAggregate
      ensure()
    },
    setEnabled(next: boolean) {
      if (enabled !== next) {
        enabled = next
        ensure()
      }
    },
    setHighlight(feature: FireFeature | null) {
      if (!feature && !selected.features.length) return
      selected = feature ? { type: 'FeatureCollection', features: [feature] } : EMPTY
      ensure()
    },
    setInteractive(interactive: boolean) {
      void interactive
    },
    retry() {
      const previousPending = pending
      pending = null
      remove(previousPending)
      error = ''
      if (active) {
        active.error = ''
        map.setPaintProperty(active.layerId, 'raster-opacity', 1)
        map.refreshTiles(active.sourceId)
      }
      ensure()
    },
    destroy() {
      disposed = true
      map.off('style.load', ensure)
      map.off('sourcedata', sourceData)
      map.off('error', sourceError)
      map.off('render', frame)
      clear()
      if (map.getLayer(SELECTED_LAYER)) map.removeLayer(SELECTED_LAYER)
      if (map.getSource(SELECTED_SOURCE)) map.removeSource(SELECTED_SOURCE)
    },
  }
}
