import type { Feature, FeatureCollection, Polygon } from 'geojson'
import {
  Popup,
  type GeoJSONSource,
  type Map as MapLibreMap,
  type MapMouseEvent,
  type MapGeoJSONFeature,
} from 'maplibre-gl'
import {
  firePixelDimensions,
  firePixelFeatures,
  firePlatformLabel,
  formatFireTime,
  type FireFeature,
  type FireProperties,
} from '@/lib/fire-severity'
import { FIRE_LAYER_BEFORE_ID } from '@/map/geography'
import {
  FIRE_POINT_SOURCE,
  FIRE_FOOTPRINT_SOURCE,
  FIRE_SQUARE_IMAGE,
  FIRE_MAP_LAYERS,
  FOOTPRINT_MIN_ZOOM,
  MAX_VISIBLE_FOOTPRINTS,
  FIRE_CLUSTER_THRESHOLD,
  fireLayerSpecifications,
  fireSquareSprite,
} from './fire-map-style'

export type FireDisplay = { endUtcExclusive?: string; focusedDay?: string | null }
export type FireFootprintStatus = {
  state: 'hidden' | 'loading' | 'ready' | 'dense'
  count: number
  label: string
}
type FireControllerOptions = {
  onFootprintStatus?: (status: FireFootprintStatus) => void
  createPopup?: () => Popup
}
const EMPTY_POINTS: FeatureCollection = { type: 'FeatureCollection', features: [] }
const EMPTY_PIXELS: FeatureCollection<Polygon, FireProperties> = {
  type: 'FeatureCollection',
  features: [],
}

export function createFireDotController(map: MapLibreMap, options: FireControllerOptions = {}) {
  let disposed = false
  let interactive = true
  let data: FireFeature[] = []
  let pointCollection: FeatureCollection = EMPTY_POINTS
  let pixelCollection: FeatureCollection<Polygon, FireProperties> = EMPTY_PIXELS
  let focusedDay: string | null = null
  let referenceTime = new Date().toISOString()
  let hovered: string | null = null
  let selected: string | null = null
  let popupPinned = false
  let overlaps: FireFeature[] = []
  let overlapIndex = 0
  let frame = 0
  let hoverEvent: MapMouseEvent | null = null
  let worker: Worker | null = null
  let revision = 0
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined
  let footprintKey = ''
  let clusterEnabled = false
  let activeCluster: MapGeoJSONFeature | null = null
  let clusterOffset = 0
  let popupRevision = 0
  let footprintStatus: FireFootprintStatus = {
    state: 'hidden',
    count: 0,
    label: 'Approximate sensor footprints appear at close zoom.',
  }
  const byId = new Map<string, FireFeature>()
  const popup =
    options.createPopup?.() ??
    new Popup({
      closeButton: true,
      closeOnClick: false,
      maxWidth: '310px',
      className: 'fire-popup-wrap',
    })

  function publishStatus(status: FireFootprintStatus) {
    footprintStatus = status
    options.onFootprintStatus?.(status)
  }

  function sourceData(id: string, collection: FeatureCollection) {
    ;(map.getSource(id) as GeoJSONSource | undefined)?.setData(collection)
  }

  function ensure() {
    if (disposed) return
    try {
      if (!map.getStyle()) return
    } catch {
      return
    }
    if (!map.hasImage(FIRE_SQUARE_IMAGE))
      map.addImage(FIRE_SQUARE_IMAGE, fireSquareSprite(), { sdf: true, pixelRatio: 2 })
    if (!map.getSource(FIRE_POINT_SOURCE)) {
      clusterEnabled = data.length >= FIRE_CLUSTER_THRESHOLD && !focusedDay
      map.addSource(FIRE_POINT_SOURCE, {
        type: 'geojson',
        data: pointCollection,
        promoteId: 'id',
        maxzoom: 18,
        buffer: 64,
        cluster: clusterEnabled,
        clusterRadius: 22,
        clusterMaxZoom: 11,
        clusterProperties: {
          maxFrp: ['max', ['coalesce', ['get', 'frpMw'], -1]],
          latestEpoch: ['max', ['get', 'acquiredEpoch']],
          earliestEpoch: ['min', ['get', 'acquiredEpoch']],
          modisCount: ['+', ['case', ['==', ['get', 'sensor'], 'MODIS'], 1, 0]],
          viirsCount: ['+', ['case', ['==', ['get', 'sensor'], 'VIIRS'], 1, 0]],
        },
      })
    }
    if (!map.getSource(FIRE_FOOTPRINT_SOURCE))
      map.addSource(FIRE_FOOTPRINT_SOURCE, {
        type: 'geojson',
        data: pixelCollection,
        promoteId: 'id',
        maxzoom: 18,
        buffer: 128,
      })
    for (const layer of fireLayerSpecifications()) {
      if (map.getLayer(layer.id)) continue
      if (focusedDay)
        layer.filter =
          layer.id === FIRE_MAP_LAYERS.clusters
            ? ['==', ['get', 'utcDay'], '__no-clusters-during-day-focus__']
            : ['all', ['!', ['has', 'point_count']], ['==', ['get', 'utcDay'], focusedDay]]
      map.addLayer(layer, map.getLayer(FIRE_LAYER_BEFORE_ID) ? FIRE_LAYER_BEFORE_ID : undefined)
    }
  }

  function updateClustering() {
    const enabled = data.length >= FIRE_CLUSTER_THRESHOLD && !focusedDay
    if (enabled === clusterEnabled) return
    clusterEnabled = enabled
    const source = map.getSource(FIRE_POINT_SOURCE) as GeoJSONSource | undefined
    void source?.setClusterOptions({ cluster: enabled }).catch(() => {})
  }

  function state(id: string | null, name: 'hover' | 'selected', value: boolean) {
    if (!id) return
    for (const source of [FIRE_POINT_SOURCE, FIRE_FOOTPRINT_SOURCE]) {
      if (map.getSource(source)) map.setFeatureState({ source, id }, { [name]: value })
    }
  }

  function cancelFootprints() {
    revision++
    worker?.terminate()
    worker = null
    clearTimeout(fallbackTimer)
    fallbackTimer = undefined
  }

  function clearFootprints(status: FireFootprintStatus) {
    cancelFootprints()
    if (pixelCollection.features.length) {
      pixelCollection = EMPTY_PIXELS
      sourceData(FIRE_FOOTPRINT_SOURCE, pixelCollection)
    }
    footprintKey = ''
    publishStatus(status)
  }

  function refreshFootprints() {
    if (disposed) return
    if (map.getZoom() < FOOTPRINT_MIN_ZOOM) {
      clearFootprints({
        state: 'hidden',
        count: 0,
        label: 'Approximate sensor footprints appear at close zoom.',
      })
      return
    }
    const bounds = map.getBounds()
    const west = bounds.getWest(),
      east = bounds.getEast(),
      south = bounds.getSouth(),
      north = bounds.getNorth()
    const visible: FireFeature[] = []
    for (const feature of data) {
      if (focusedDay && feature.properties.utcDay !== focusedDay) continue
      if (!firePixelDimensions(feature)) continue
      const [lng, lat] = feature.geometry.coordinates
      const margin = Math.max(
        0.02,
        (feature.properties.scanKm ?? 1) / (111 * Math.max(0.01, Math.cos((lat * Math.PI) / 180))),
      )
      if (lat < south - margin || lat > north + margin) continue
      if (![lng - 360, lng, lng + 360].some((x) => x >= west - margin && x <= east + margin))
        continue
      visible.push(feature)
      if (visible.length > MAX_VISIBLE_FOOTPRINTS) {
        clearFootprints({
          state: 'dense',
          count: visible.length,
          label:
            'All detection squares remain visible. Zoom in for approximate sensor footprints (limit ' +
            MAX_VISIBLE_FOOTPRINTS +
            ').',
        })
        return
      }
    }
    const key = visible.map((feature) => feature.properties.id).join('|')
    if (key === footprintKey) return
    footprintKey = key
    cancelFootprints()
    if (!visible.length) {
      pixelCollection = EMPTY_PIXELS
      sourceData(FIRE_FOOTPRINT_SOURCE, pixelCollection)
      publishStatus({
        state: 'ready',
        count: 0,
        label: 'No approximate sensor footprints in this view.',
      })
      return
    }
    const current = revision
    publishStatus({
      state: 'loading',
      count: visible.length,
      label: 'Preparing approximate sensor footprints.',
    })
    const publish = (features: Feature<Polygon, FireProperties>[]) => {
      if (disposed || current !== revision) return
      worker?.terminate()
      worker = null
      clearTimeout(fallbackTimer)
      pixelCollection = { type: 'FeatureCollection', features }
      sourceData(FIRE_FOOTPRINT_SOURCE, pixelCollection)
      state(hovered, 'hover', true)
      state(selected, 'selected', true)
      publishStatus({
        state: 'ready',
        count: features.length,
        label:
          'Approximate sensor footprints: ' +
          features.length +
          '. Scan/track do not establish rotated corners.',
      })
    }
    const fallback = () => {
      if (disposed || current !== revision) return
      worker?.terminate()
      worker = null
      clearTimeout(fallbackTimer)
      const output: Feature<Polygon, FireProperties>[] = []
      let cursor = 0
      const step = () => {
        if (disposed || current !== revision) return
        output.push(...firePixelFeatures(visible.slice(cursor, cursor + 40)))
        cursor += 40
        if (cursor < visible.length) fallbackTimer = setTimeout(step, 0)
        else publish(output)
      }
      fallbackTimer = setTimeout(step, 0)
    }
    try {
      worker = new Worker(new URL('./fire-footprints.worker.ts', import.meta.url), {
        type: 'module',
      })
      worker.onmessage = (
        event: MessageEvent<{ revision: number; features: Feature<Polygon, FireProperties>[] }>,
      ) => {
        if (event.data.revision === current) publish(event.data.features)
      }
      worker.onerror = fallback
      worker.onmessageerror = fallback
      worker.postMessage({ revision: current, features: visible })
      fallbackTimer = setTimeout(fallback, 10000)
    } catch {
      fallback()
    }
  }

  function leave() {
    state(hovered, 'hover', false)
    hovered = null
    if (!popupPinned) popup.remove()
    if (map.getCanvas().style.cursor === 'pointer') map.getCanvas().style.cursor = ''
  }

  function hits(event: MapMouseEvent) {
    const layers = [FIRE_MAP_LAYERS.observations, FIRE_MAP_LAYERS.footprints].filter(
      (id) => !!map.getLayer(id),
    )
    if (!layers.length) return []
    const seen = new Set<string>()
    return map
      .queryRenderedFeatures(
        [
          [event.point.x - 4, event.point.y - 4],
          [event.point.x + 4, event.point.y + 4],
        ],
        { layers },
      )
      .flatMap((hit) => {
        const id = String(hit.properties?.id ?? hit.id ?? '')
        const original = byId.get(id)
        if (!original || seen.has(id)) return []
        seen.add(id)
        return [original]
      })
      .sort((a, b) => b.properties.acquiredEpoch - a.properties.acquiredEpoch)
  }

  function clusterAt(event: MapMouseEvent) {
    if (!map.getLayer(FIRE_MAP_LAYERS.clusters)) return undefined
    return map.queryRenderedFeatures(event.point, { layers: [FIRE_MAP_LAYERS.clusters] })[0]
  }

  function field(root: HTMLElement, label: string, value: string) {
    const row = document.createElement('p')
    const name = document.createElement('strong')
    name.textContent = label + ': '
    row.append(name, document.createTextNode(value || 'Not reported'))
    root.append(row)
  }

  function mountPopup(anchor: [number, number], root: HTMLElement) {
    popup.setLngLat(anchor).setDOMContent(root)
    if (!popup.isOpen()) popup.addTo(map)
  }

  function show(feature: FireFeature, detailed: boolean) {
    const properties = feature.properties
    const root = document.createElement('div')
    root.className = 'fire-popup'
    root.style.maxHeight = 'min(420px, 55vh)'
    root.style.overflowY = 'auto'
    const title = document.createElement('strong')
    title.textContent = 'Satellite hotspot'
    root.append(title)
    field(root, 'Acquired', formatFireTime(properties.acquiredAt))
    field(
      root,
      'FRP',
      properties.frpMw === null ? 'Unknown / not reported' : properties.frpMw.toFixed(1) + ' MW',
    )
    field(
      root,
      'Instrument / satellite',
      [properties.sensor, firePlatformLabel(properties.platform)].filter(Boolean).join(' / '),
    )
    if (detailed) {
      const ageNow = (Date.now() - Date.parse(properties.acquiredAt)) / 3600000
      field(
        root,
        'Observation age now',
        Number.isFinite(ageNow) ? Math.max(0, ageNow).toFixed(1) + ' hours' : '',
      )
      const age = (Date.parse(referenceTime) - Date.parse(properties.acquiredAt)) / 3600000
      field(
        root,
        'Age at selected interval end',
        Number.isFinite(age) ? Math.max(0, age).toFixed(1) + ' hours' : '',
      )
      const [lng, lat] = feature.geometry.coordinates
      const coordinateText = lat.toFixed(6) + ', ' + lng.toFixed(6)
      field(root, 'Reported center', coordinateText)
      const copy = document.createElement('button')
      copy.type = 'button'
      copy.textContent = 'Copy coordinates'
      copy.addEventListener('click', () => {
        if (!navigator.clipboard) {
          copy.textContent = 'Copy unavailable: ' + coordinateText
          return
        }
        void navigator.clipboard
          ?.writeText(coordinateText)
          .then(() => {
            copy.textContent = 'Copied'
          })
          .catch(() => {
            copy.textContent = coordinateText
          })
      })
      root.append(copy)
      const confidence = properties.confidence
      field(
        root,
        'Native confidence',
        confidence && typeof confidence === 'object'
          ? String((confidence as Record<string, unknown>).value ?? '')
          : String(properties.confidencePct ?? properties.confidenceClass ?? confidence ?? ''),
      )
      field(root, 'Day / night', String(properties.dayNight ?? ''))
      field(
        root,
        'Reported pixel scan / track',
        (properties.scanKm === undefined ? 'Not reported' : properties.scanKm + ' km') +
          ' / ' +
          (properties.trackKm === undefined ? 'Not reported' : properties.trackKm + ' km'),
      )
      field(
        root,
        'Footprint',
        firePixelDimensions(feature)
          ? 'Approximate sensor footprint; missing scan/track uses known instrument nominal resolution. Orientation is approximate.'
          : 'Not available: sensor dimensions are not reported.',
      )
      field(
        root,
        'Processing tier / version',
        [properties.processingTier, properties.productVersion].filter(Boolean).join(' / '),
      )
      field(root, 'Source', String(properties.provenance ?? properties.source ?? 'NASA FIRMS'))
      field(
        root,
        'Interpretation',
        'FRP is radiative power, not temperature or a danger score. A detection does not establish ignition time, distinct incidents, or burned area.',
      )
      if (overlaps.length > 1) {
        field(
          root,
          'Overlapping observations',
          overlapIndex + 1 + ' of ' + overlaps.length + ', newest first',
        )
        for (const delta of [-1, 1]) {
          const button = document.createElement('button')
          button.type = 'button'
          button.textContent = delta < 0 ? 'Previous' : 'Next'
          button.disabled = overlapIndex + delta < 0 || overlapIndex + delta >= overlaps.length
          button.addEventListener('click', () => {
            state(selected, 'selected', false)
            overlapIndex += delta
            selected = overlaps[overlapIndex].properties.id
            state(selected, 'selected', true)
            show(overlaps[overlapIndex], true)
          })
          root.append(button)
        }
      }
      if (activeCluster) {
        const back = document.createElement('button')
        back.type = 'button'
        back.textContent = 'Back to aggregated observations'
        back.addEventListener('click', () => {
          if (activeCluster) void showCluster(activeCluster, clusterOffset)
        })
        root.append(back)
      }
    }
    mountPopup(feature.geometry.coordinates as [number, number], root)
  }

  async function showCluster(feature: MapGeoJSONFeature, offset = 0, preview = false) {
    const properties = feature.properties ?? {}
    const clusterId = Number(properties.cluster_id)
    const count = Number(properties.point_count)
    const root = document.createElement('div')
    root.className = 'fire-popup'
    root.style.maxHeight = 'min(420px, 55vh)'
    root.style.overflowY = 'auto'
    const title = document.createElement('strong')
    title.textContent = 'Aggregated satellite hotspots'
    root.append(title)
    field(root, 'Detection records', String(count))
    field(
      root,
      'Maximum FRP',
      Number(properties.maxFrp) >= 0 ? Number(properties.maxFrp).toFixed(1) + ' MW' : 'Unknown',
    )
    const epochTime = (value: unknown) =>
      typeof value === 'number' && Number.isFinite(value) && value > 0
        ? formatFireTime(new Date(value).toISOString())
        : 'Not reported'
    field(
      root,
      'Time span',
      epochTime(properties.earliestEpoch) + ' - ' + epochTime(properties.latestEpoch),
    )
    if (feature.geometry.type !== 'Point') return
    const anchor = feature.geometry.coordinates as [number, number]
    if (preview) {
      mountPopup(anchor, root)
      return
    }
    activeCluster = feature
    clusterOffset = offset
    popupPinned = true
    const current = ++popupRevision
    field(
      root,
      'Instruments',
      'MODIS ' +
        Number(properties.modisCount ?? 0) +
        ' / VIIRS ' +
        Number(properties.viirsCount ?? 0),
    )
    field(
      root,
      'Representation',
      'Outlined aggregate square, colored by maximum reported FRP. Counts are detections, not distinct fires.',
    )
    const zoom = document.createElement('button')
    zoom.type = 'button'
    zoom.textContent = 'Zoom into observations'
    zoom.addEventListener('click', () => {
      const source = map.getSource(FIRE_POINT_SOURCE) as GeoJSONSource | undefined
      void source?.getClusterExpansionZoom(clusterId).then((value) => {
        if (!disposed) map.easeTo({ center: anchor, zoom: value })
      })
    })
    root.append(zoom)
    field(
      root,
      'Observation page',
      offset +
        1 +
        ' - ' +
        Math.min(count, offset + 100) +
        ' of ' +
        count +
        ', newest first within page',
    )
    const list = document.createElement('div')
    list.textContent = 'Loading cached observation records.'
    root.append(list)
    for (const delta of [-100, 100]) {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = delta < 0 ? 'Previous page' : 'Next page'
      button.disabled = offset + delta < 0 || offset + delta >= count
      button.addEventListener('click', () => {
        void showCluster(feature, offset + delta)
      })
      root.append(button)
    }
    mountPopup(anchor, root)
    try {
      const source = map.getSource(FIRE_POINT_SOURCE) as GeoJSONSource | undefined
      const leaves = await source?.getClusterLeaves(clusterId, 100, offset)
      if (disposed || current !== popupRevision || !popupPinned) return
      const seen = new Set<string>()
      const originals = (leaves ?? [])
        .flatMap((leaf) => {
          const id = String(leaf.properties?.id ?? leaf.id ?? '')
          const original = byId.get(id)
          if (!original || seen.has(id)) return []
          seen.add(id)
          return [original]
        })
        .sort((a, b) => b.properties.acquiredEpoch - a.properties.acquiredEpoch)
      list.replaceChildren()
      for (const original of originals) {
        const button = document.createElement('button')
        button.type = 'button'
        button.textContent =
          formatFireTime(original.properties.acquiredAt) +
          ' / ' +
          firePlatformLabel(original.properties.platform)
        button.style.display = 'block'
        button.addEventListener('click', () => {
          state(selected, 'selected', false)
          overlaps = originals
          overlapIndex = originals.indexOf(original)
          selected = original.properties.id
          state(selected, 'selected', true)
          show(original, true)
        })
        list.append(button)
      }
    } catch {
      if (current === popupRevision)
        list.textContent = 'Cached observation records are unavailable; zoom in or retry the page.'
    }
  }

  function onMove(event: MapMouseEvent) {
    if (!interactive || disposed || popupPinned) return
    hoverEvent = event
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      if (!hoverEvent || !interactive || disposed || popupPinned) return
      const feature = hits(hoverEvent)[0]
      if (!feature) {
        const cluster = clusterAt(hoverEvent)
        if (cluster) {
          map.getCanvas().style.cursor = 'pointer'
          void showCluster(cluster, 0, true)
          return
        }
        leave()
        return
      }
      map.getCanvas().style.cursor = 'pointer'
      if (hovered === feature.properties.id) return
      state(hovered, 'hover', false)
      hovered = feature.properties.id
      state(hovered, 'hover', true)
      show(feature, false)
    })
  }

  function onClick(event: MapMouseEvent) {
    if (!interactive || disposed) return
    const cluster = clusterAt(event)
    if (cluster) {
      state(selected, 'selected', false)
      selected = null
      void showCluster(cluster)
      return
    }
    const found = hits(event)
    if (!found.length) return
    state(selected, 'selected', false)
    overlaps = found
    activeCluster = null
    overlapIndex = 0
    selected = found[0].properties.id
    popupPinned = true
    state(selected, 'selected', true)
    show(found[0], true)
  }

  function onClose() {
    state(selected, 'selected', false)
    selected = null
    popupPinned = false
    activeCluster = null
    popupRevision++
  }
  function onStyleLoad() {
    ensure()
    state(hovered, 'hover', true)
    state(selected, 'selected', true)
  }
  map.on('style.load', onStyleLoad)
  map.on('mousemove', onMove)
  map.on('click', onClick)
  map.on('moveend', refreshFootprints)
  map.getCanvas().addEventListener('mouseleave', leave)
  popup.on('close', onClose)
  ensure()

  return {
    setData(next: FireFeature[]) {
      if (disposed || data === next) return
      data = next
      popup.remove()
      leave()
      cancelFootprints()
      if (pixelCollection.features.length) {
        pixelCollection = EMPTY_PIXELS
        sourceData(FIRE_FOOTPRINT_SOURCE, pixelCollection)
      }
      byId.clear()
      for (const feature of next) byId.set(feature.properties.id, feature)
      pointCollection = { type: 'FeatureCollection', features: Array.from(byId.values()) }
      footprintKey = ''
      ensure()
      sourceData(FIRE_POINT_SOURCE, pointCollection)
      updateClustering()
      refreshFootprints()
    },
    setDisplay(display: FireDisplay) {
      if (display.endUtcExclusive) referenceTime = display.endUtcExclusive
      const day = display.focusedDay ?? null
      if (day === focusedDay) return
      focusedDay = day
      for (const layer of fireLayerSpecifications())
        if (map.getLayer(layer.id)) {
          const filter = day
            ? layer.id === FIRE_MAP_LAYERS.clusters
              ? ['==', ['get', 'utcDay'], '__no-clusters-during-day-focus__']
              : ['all', ['!', ['has', 'point_count']], ['==', ['get', 'utcDay'], day]]
            : (layer.filter ?? null)
          map.setFilter(layer.id, filter as typeof layer.filter)
        }
      updateClustering()
      popup.remove()
      leave()
      refreshFootprints()
    },
    setInteractive(next: boolean) {
      interactive = next
      if (!next) {
        popup.remove()
        leave()
      }
    },
    getFootprintStatus() {
      return footprintStatus
    },
    destroy() {
      if (disposed) return
      cancelFootprints()
      popup.remove()
      leave()
      disposed = true
      if (frame) cancelAnimationFrame(frame)
      map.off('style.load', onStyleLoad)
      map.off('mousemove', onMove)
      map.off('click', onClick)
      map.off('moveend', refreshFootprints)
      map.getCanvas().removeEventListener('mouseleave', leave)
      popup.off('close', onClose)
      for (const id of Object.values(FIRE_MAP_LAYERS).reverse())
        if (map.getLayer(id)) map.removeLayer(id)
      for (const id of [FIRE_POINT_SOURCE, FIRE_FOOTPRINT_SOURCE])
        if (map.getSource(id)) map.removeSource(id)
      if (map.hasImage(FIRE_SQUARE_IMAGE)) map.removeImage(FIRE_SQUARE_IMAGE)
    },
  }
}
