import type { FeatureCollection } from 'geojson'
import type { GeoJSONSource, Map as MapLibreMap, MapSourceDataEvent } from 'maplibre-gl'
import type { GlobalManifest } from '@/hooks/use-global-fires'
import type { FireFeature } from '@/lib/fire-severity'
import type { ObservationFilters } from '@/lib/investigation'
import { apiUrl } from '@/lib/api-config'
import type { GlobalDisplayStatus } from './global-fire-controller'
import { FIRE_PIXEL_COLOR, FIRE_SQUARE_IMAGE, fireSquareSprite } from './fire-map-style'
import { createGlobalPointRenderer, type GlobalPointRenderer } from './global-point-renderer'
import { FIRE_LAYER_BEFORE_ID } from './geography'

export const GLOBAL_POINT_SOURCE = 'global-hotspot-individual-observations'
export const GLOBAL_POINT_LAYER = 'global-hotspot-individual-squares'
export const GLOBAL_POINT_INDEX_LAYER = `${GLOBAL_POINT_LAYER}-index`
const SELECTED_SOURCE = 'global-hotspot-selected'
const SELECTED_LAYER = 'global-hotspot-selected-square'
const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] }

export function isGlobalPointSourceReady(map: Pick<MapLibreMap, 'getSource' | 'isSourceLoaded'>) {
  return Boolean(map.getSource(GLOBAL_POINT_SOURCE) && map.isSourceLoaded(GLOBAL_POINT_SOURCE))
}

/** One native tile index and a GPU square renderer; no symbol-placement work. */
export function createGlobalPointController(
  map: MapLibreMap,
  options: {
    onStatus: (status: GlobalDisplayStatus) => void
    createRenderer?: typeof createGlobalPointRenderer
  },
) {
  let manifest: GlobalManifest | null = null
  let filters: ObservationFilters = {}
  let aggregateId: string | undefined
  let enabled = true
  let disposed = false
  let template = ''
  let source: ReturnType<MapLibreMap['getSource']>
  let renderer: GlobalPointRenderer | null = null
  let selected: FeatureCollection = EMPTY
  let selectedSource: GeoJSONSource | undefined
  let selectedData: FeatureCollection | undefined
  let loadedTile = false
  let gpuFrameReady = false
  let needsPreparation = false
  let prepareTimer: ReturnType<typeof setTimeout> | undefined
  let error = ''
  let statusKey = ''

  function report() {
    if (disposed) return
    const complete = Boolean(
      enabled &&
      source &&
      loadedTile &&
      gpuFrameReady &&
      map.getSource(GLOBAL_POINT_SOURCE) === source &&
      isGlobalPointSourceReady(map),
    )
    const status: GlobalDisplayStatus = {
      snapshotId: manifest?.snapshotId,
      loading: Boolean(enabled && manifest?.snapshotId && !complete && !error),
      error,
      visibleTiles: loadedTile && gpuFrameReady ? 1 : 0,
      displayFeatures: manifest?.count ?? 0,
      decodedBytes: renderer?.getStats().bytes ?? 0,
    }
    const nextKey = JSON.stringify(status)
    if (nextKey === statusKey) return
    statusKey = nextKey
    options.onStatus(status)
  }

  function cancelPreparation() {
    clearTimeout(prepareTimer)
    prepareTimer = undefined
  }
  function removePoints() {
    cancelPreparation()
    source = undefined
    renderer = null
    loadedTile = false
    gpuFrameReady = false
    needsPreparation = false
    if (map.getLayer(GLOBAL_POINT_LAYER)) map.removeLayer(GLOBAL_POINT_LAYER)
    if (map.getLayer(GLOBAL_POINT_INDEX_LAYER)) map.removeLayer(GLOBAL_POINT_INDEX_LAYER)
    if (map.getSource(GLOBAL_POINT_SOURCE)) map.removeSource(GLOBAL_POINT_SOURCE)
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
    } else if (existing !== selectedSource || selected !== selectedData) {
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
            'icon-padding': 0,
            'symbol-z-order': 'source',
          },
          paint: {
            'icon-color': FIRE_PIXEL_COLOR,
            'icon-halo-color': '#ffffff',
            'icon-halo-width': 2,
          },
        },
        before,
      )
  }

  function prepare() {
    prepareTimer = undefined
    if (
      disposed ||
      !enabled ||
      !needsPreparation ||
      !source ||
      map.getSource(GLOBAL_POINT_SOURCE) !== source ||
      !isGlobalPointSourceReady(map)
    )
      return
    try {
      const features = map.querySourceFeatures(GLOBAL_POINT_SOURCE, {
        sourceLayer: manifest?.pointSourceLayer ?? 'observations',
      })
      needsPreparation = false
      gpuFrameReady = false
      const stats = renderer?.setFeatures(features)
      gpuFrameReady = Boolean(stats && stats.revision === stats.renderedRevision)
      report()
    } catch (failure) {
      error = failure instanceof Error ? failure.message : 'Hotspot pixels could not be prepared.'
      report()
    }
  }
  function schedulePreparation(delay = 0) {
    if (
      disposed ||
      !enabled ||
      !source ||
      !needsPreparation ||
      prepareTimer !== undefined ||
      (gpuFrameReady && map.isMoving()) ||
      map.getSource(GLOBAL_POINT_SOURCE) !== source ||
      !isGlobalPointSourceReady(map)
    )
      return
    prepareTimer = setTimeout(prepare, delay)
  }

  function ensure() {
    if (disposed || !map.getStyle()) return
    const before = map.getLayer(FIRE_LAYER_BEFORE_ID) ? FIRE_LAYER_BEFORE_ID : undefined
    ensureHighlight(before)
    if (!enabled || !manifest?.snapshotId) {
      removePoints()
      template = ''
      report()
      return
    }
    if (!manifest.pointTiles) {
      removePoints()
      error =
        'Individual hotspot tiles are unavailable. Restart the SHARP backend to load the updated map service.'
      report()
      return
    }
    const params = new URLSearchParams()
    if (Object.keys(filters).length) params.set('filters', JSON.stringify(filters))
    if (aggregateId) params.set('aggregateId', aggregateId)
    const url = apiUrl(manifest.pointTiles) + (params.size ? `?${params}` : '')
    const existing = map.getSource(GLOBAL_POINT_SOURCE)
    if (url !== template || !existing || existing !== source) {
      removePoints()
      template = url
      error = ''
      map.addSource(GLOBAL_POINT_SOURCE, {
        type: 'vector',
        tiles: [url],
        minzoom: 0,
        maxzoom: manifest.pointMaxZoom ?? 18,
        attribution: 'NASA FIRMS',
      })
      source = map.getSource(GLOBAL_POINT_SOURCE)
    }
    // Visible indexing keeps native local tiles/worker decoding active. Constant
    // zero opacity bypasses circle drawing and never enters symbol placement.
    if (!map.getLayer(GLOBAL_POINT_INDEX_LAYER))
      map.addLayer(
        {
          id: GLOBAL_POINT_INDEX_LAYER,
          type: 'circle',
          source: GLOBAL_POINT_SOURCE,
          'source-layer': manifest.pointSourceLayer ?? 'observations',
          paint: { 'circle-radius': 1, 'circle-opacity': 0, 'circle-stroke-width': 0 },
        },
        before,
      )
    if (!map.getLayer(GLOBAL_POINT_LAYER)) {
      const nextRenderer = (options.createRenderer ?? createGlobalPointRenderer)({
        id: GLOBAL_POINT_LAYER,
        onRendered: () => {
          if (disposed || renderer !== nextRenderer) return
          gpuFrameReady = true
          report()
        },
        onError: (message) => {
          if (disposed || renderer !== nextRenderer) return
          error = message
          report()
        },
      })
      renderer = nextRenderer
      map.addLayer(nextRenderer, before)
    }
    report()
  }

  function currentEvent(event: { sourceId?: string; source?: unknown }) {
    const tiles =
      event.source && typeof event.source === 'object' && 'tiles' in event.source
        ? event.source.tiles
        : undefined
    return (
      !disposed &&
      enabled &&
      source &&
      event.sourceId === GLOBAL_POINT_SOURCE &&
      map.getSource(GLOBAL_POINT_SOURCE) === source &&
      (!Array.isArray(tiles) || tiles[0] === template)
    )
  }
  function sourceData(event: MapSourceDataEvent) {
    if (!currentEvent(event)) return
    if (event.type === 'sourcedata' && event.tile?.state === 'loaded') {
      loadedTile = true
      needsPreparation = true
    }
    schedulePreparation()
    report()
  }
  function sourceError(event: {
    sourceId?: string
    source?: unknown
    error?: { message: string }
  }) {
    if (!currentEvent(event)) return
    error =
      event.error?.message ||
      'Individual hotspot pixels could not load. Retry the observation layer.'
    report()
  }
  function frame() {
    // No per-record queries or buffer updates during camera animation.
    if (needsPreparation && !map.isMoving()) schedulePreparation()
  }
  function moved() {
    if (!enabled || !source) return
    // Native tiles can return directly from cache without a new data event.
    // Debounce programmatic camera frames/drag events until navigation settles.
    needsPreparation = true
    cancelPreparation()
    schedulePreparation(250)
  }
  map.on('style.load', ensure)
  map.on('sourcedata', sourceData)
  map.on('sourcedataloading', sourceData)
  map.on('error', sourceError)
  map.on('render', frame)
  map.on('moveend', moved)

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
    setHighlight(feature: FireFeature | null) {
      if (!feature && !selected.features.length) return
      selected = feature ? { type: 'FeatureCollection', features: [feature] } : EMPTY
      ensure()
    },
    setEnabled(next: boolean) {
      if (next === enabled) return
      enabled = next
      ensure()
    },
    setInteractive(interactive: boolean) {
      void interactive
    },
    retry() {
      if (!disposed) {
        removePoints()
        ensure()
      }
    },
    destroy() {
      disposed = true
      map.off('style.load', ensure)
      map.off('sourcedata', sourceData)
      map.off('sourcedataloading', sourceData)
      map.off('error', sourceError)
      map.off('render', frame)
      map.off('moveend', moved)
      removePoints()
      if (map.getLayer(SELECTED_LAYER)) map.removeLayer(SELECTED_LAYER)
      if (map.getSource(SELECTED_SOURCE)) map.removeSource(SELECTED_SOURCE)
    },
  }
}
