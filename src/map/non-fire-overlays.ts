import { addProtocol, removeProtocol, type GeoJSONSource, type Map as MapLibreMap, type MapEventType } from 'maplibre-gl'
import type { Feature, FeatureCollection, Polygon } from 'geojson'
import type { MapReferenceLayers } from './basemaps'
import { decodePixels, pixelBitmap } from './imagery-pixels'
import { GRATICULE_LINE_LAYER_ID } from './graticule'
const GIBS_ROOT = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best'
export const HBASE_PRODUCT = 'Landsat_Human_Built-up_And_Settlement_Extent'
export const EUROPE_SERVICE = 'https://bio.discomap.eea.europa.eu/arcgis/rest/services/ProtectedSites/Natura2000Sites/MapServer'
const EUROPE_BOUNDS: [number, number, number, number] = [-32.37, 24.59, 34.11, 70.9]
// NASA SEDAC HBASE has no imagery south of about 58.35° S or north of 82.79° N.
// Within these bounds a pixel can still be unclassified or unavailable.
const HBASE_BOUNDS: [number, number, number, number] = [-180, -58.35, 180, 82.79]
export type OverlayStatus = Partial<Record<'showBuiltUp' | 'showEuropeanProtectedAreas' | 'showLandsat8Swaths' | 'showLandsat9Swaths', string>>
const HBASE_SOURCE = 'context-hbase'
const EUROPE_SOURCE = 'context-europe-protected'
export const OVERLAY_CREDITS = {
  showBuiltUp: 'NASA GIBS / SEDAC · HBASE, Landsat (2010)',
  showEuropeanProtectedAreas: '© European Environment Agency, Copenhagen (2025) · Natura 2000 (2024)',
  showLandsat8Swaths: 'NASA CMR / LP DAAC / USGS · Landsat 8 HLS L30 v2.0 MGRS scene footprints',
  showLandsat9Swaths: 'NASA CMR / LP DAAC / USGS · Landsat 9 HLS L30 v2.0 MGRS scene footprints',
} as const
let nextId = 0
const empty: FeatureCollection = { type: 'FeatureCollection', features: [] }

export function createNonFireOverlayController(map: MapLibreMap, onStatus: (status: OverlayStatus) => void) {
  const protocol = `ethereal-hbase-${++nextId}`
  let destroyed = false, frame = 0, date: string | null = null, flags: MapReferenceLayers | null = null
  let statuses: OverlayStatus = {}
  const footprintRequests = new Map<string, AbortController>()
  const queryKeys = new Map<string, string>()
  const failedSources = new Set<string>()
  function publish() { if (!frame && !destroyed) frame = requestAnimationFrame(() => { frame = 0; onStatus({ ...statuses }) }) }
  function status(key: keyof OverlayStatus, value: string) { if (statuses[key] !== value) { statuses[key] = value; publish() } }
  addProtocol(protocol, async (request, abort) => {
    const path = request.url.slice(protocol.length + 3)
    const response = await fetch(`${GIBS_ROOT}/${HBASE_PRODUCT}/default/GoogleMapsCompatible_Level12/${path}.png`, { signal: abort.signal })
    if (!response.ok) throw new Error(`HBASE tile returned ${response.status}`)
    const pixels = await decodePixels(await response.blob())
    // Official categorical colormap: 201 = HBASE (217,95,2). Class 200,
    // road class 202 and no-data stay transparent. No duplicate road switch.
    for (let i = 0; i < pixels.data.length; i += 4) if (pixels.data[i] !== 217 || pixels.data[i + 1] !== 95 || pixels.data[i + 2] !== 2) pixels.data[i + 3] = 0
    if (abort.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    return { data: pixelBitmap(pixels) }
  })
  function remove(id: string) { if (map.getLayer(id)) map.removeLayer(id); if (map.getSource(id)) map.removeSource(id); failedSources.delete(id) }
  function visibility(id: string, visible: boolean) { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none') }
  function viewIntersects(bounds: [number, number, number, number]) {
    const view = map.getBounds()
    if (view.getNorth() < bounds[1] || view.getSouth() > bounds[3]) return false
    // MapLibre can return wrapped longitudes after rotating the globe.
    for (let wrap = -2; wrap <= 2; wrap++) {
      if (view.getWest() <= bounds[2] + wrap * 360 && view.getEast() >= bounds[0] + wrap * 360) return true
    }
    return false
  }
  function raster(id: string, tiles: string[], maxzoom: number, credit: string, minzoom = 0, bounds: [number, number, number, number] = [-180, -85.051129, 180, 85.051129]) {
    if (map.getSource(id)) return
    map.addSource(id, { type: 'raster', tiles, tileSize: 256, minzoom, maxzoom, bounds, attribution: credit })
    map.addLayer({ id, type: 'raster', source: id, minzoom, paint: { 'raster-opacity': id === HBASE_SOURCE ? .8 : .7, 'raster-fade-duration': 0 } }, map.getLayer(GRATICULE_LINE_LAYER_ID) ? GRATICULE_LINE_LAYER_ID : 'geography-coastlines')
  }
  function clearFootprints(id: string) { footprintRequests.get(id)?.abort(); footprintRequests.delete(id); (map.getSource(id) as GeoJSONSource | undefined)?.setData(empty) }
  async function footprints(platform: 8 | 9) {
    const key = platform === 8 ? 'showLandsat8Swaths' : 'showLandsat9Swaths'
    const id = `context-landsat-${platform}-swaths`
    if (!flags?.[key]) { clearFootprints(id); visibility(id, false); queryKeys.delete(id); return }
    if (!map.getSource(id)) {
      map.addSource(id, { type: 'geojson', data: empty, attribution: OVERLAY_CREDITS[key], maxzoom: 12 })
      map.addLayer({ id, type: 'line', source: id, paint: { 'line-color': platform === 8 ? '#ed945e' : '#79d6ac', 'line-width': 1.2, 'line-opacity': .85 } }, 'geography-sea-labels')
    }
    visibility(id, true)
    const latitude = Math.min(85, Math.abs(map.getCenter().lat)), surfaceZoom = map.getZoom() - Math.log2(Math.cos(latitude * Math.PI / 180))
    // HLS granules are roughly MGRS-sized scene footprints, with many records
    // per day. Query the visible region only once it is small enough to avoid
    // thousands of records for a full-globe or continent-scale view.
    if (surfaceZoom < 5 || !date) { clearFootprints(id); queryKeys.delete(id); status(key, 'Zoom in for dated HLS scene footprints. These are MGRS granules, not orbit swath outlines.'); return }
    const bounds = map.getBounds()
    const west = bounds.getWest(), east = bounds.getEast(), south = Math.max(-85, bounds.getSouth()), north = Math.min(85, bounds.getNorth())
    const width = Math.min(360, east - west), start = ((west + 180) % 360 + 360) % 360 - 180
    const boxes = start + width > 180 ? [[start, south, 180, north], [-180, south, start + width - 360, north]] : [[start, south, start + width, north]]
    const selectedDate = date
    const signature = `${date}:${boxes.map((box) => box.map((n) => n.toFixed(2)).join(',')).join(';')}`
    if (queryKeys.get(id) === signature) return
    queryKeys.set(id, signature); clearFootprints(id)
    const abort = new AbortController(); footprintRequests.set(id, abort)
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(20_000)])
    status(key, `${date} UTC · loading scene outlines…`)
    const features: Feature<Polygon>[] = []
    const seen = new Set<string>()
    let truncated = false
    try {
      for (const box of boxes) {
        for (let page = 1; page <= 4; page++) {
          const params = new URLSearchParams({ collection_concept_id: 'C2021957657-LPCLOUD', platform: `LANDSAT-${platform}`, temporal: `${selectedDate}T00:00:00Z,${selectedDate}T23:59:59.999Z`, bounding_box: box.join(','), page_size: '500', page_num: String(page) })
          const response = await fetch(`https://cmr.earthdata.nasa.gov/search/granules.json?${params}`, { signal })
          if (!response.ok) throw new Error(`NASA CMR returned ${response.status}`)
          const data = await response.json() as { feed?: { entry?: { id: string, time_start?: string, polygons?: string[][] }[] } }
          const entries = data.feed?.entry ?? []
          for (const entry of entries) {
            if (seen.has(entry.id)) continue
            seen.add(entry.id)
            for (const [index, rings] of (entry.polygons ?? []).entries()) {
              const coordinates = rings.map((raw) => {
                const values = raw.trim().split(/\s+/).map(Number)
                const ring: number[][] = []
                for (let i = 0; i + 1 < values.length; i += 2) {
                  let longitude = values[i + 1]
                  if (ring.length) longitude += 360 * Math.round((ring.at(-1)![0] - longitude) / 360)
                  ring.push([longitude, values[i]])
                }
                return ring
              })
              if (coordinates[0]?.length >= 4 && coordinates.flat(2).every(Number.isFinite)) features.push({ type: 'Feature', id: `${entry.id}:${index}`, properties: { platform: `Landsat ${platform}`, date: selectedDate, time: entry.time_start ?? '' }, geometry: { type: 'Polygon', coordinates } })
            }
          }
          if (entries.length < 500) break
          if (page === 4) truncated = true
        }
      }
      if (destroyed || abort.signal.aborted || queryKeys.get(id) !== signature) return
      ;(map.getSource(id) as GeoJSONSource).setData({ type: 'FeatureCollection', features })
      status(key, `${selectedDate} UTC · ${features.length} HLS L30 MGRS scene footprints in this view.${truncated ? ' Partial results; zoom in for all scene footprints.' : ''}${!features.length ? ' No archived scene was returned for this place and day; no alternate date is used.' : ' These are granule footprints, not orbit swath boundaries.'}`)
    } catch (error) { if (!destroyed && !abort.signal.aborted) status(key, signal.aborted ? 'Scene metadata timed out. Move the map or retry.' : error instanceof Error ? error.message : 'Scene metadata unavailable.') }
  }
  function updateStaticStatus() {
    if (!flags) return
    for (const [key, id] of [['showBuiltUp', HBASE_SOURCE], ['showEuropeanProtectedAreas', EUROPE_SOURCE]] as const) {
      if (!flags[key] || failedSources.has(id)) continue
      if (key === 'showBuiltUp' && map.getZoom() < 4) {
        status(key, 'Zoom in to see this overlay.')
      } else if (key === 'showEuropeanProtectedAreas' && !viewIntersects(EUROPE_BOUNDS)) {
        status(key, 'Europe only · outside this view.')
      } else if (key === 'showBuiltUp' && !viewIntersects(HBASE_BOUNDS)) {
        status(key, 'Outside the mapped HBASE extent.')
      } else if (!map.getSource(id) || !map.isSourceLoaded(id)) {
        status(key, 'Loading requested overlay tiles…')
      } else {
        status(key, key === 'showBuiltUp'
          ? '2010 HBASE settlement class · requested tiles loaded.'
          : 'Europe only · Natura 2000 (2024) · requested tiles loaded.')
      }
    }
  }
  function refresh() { updateStaticStatus(); void footprints(8); void footprints(9) }
  const onData = (event: { sourceId?: string }) => { if ([HBASE_SOURCE, EUROPE_SOURCE].includes(event.sourceId ?? '')) updateStaticStatus() }
  const onError = (event: MapEventType['error']) => {
    const sourceId = 'sourceId' in event && typeof event.sourceId === 'string' ? event.sourceId : null
    const key = sourceId === HBASE_SOURCE ? 'showBuiltUp' : sourceId === EUROPE_SOURCE ? 'showEuropeanProtectedAreas' : null
    if (key && sourceId) { failedSources.add(sourceId); status(key, 'Some overlay tiles failed. The base map remains visible; retry when connected.') }
  }
  map.on('moveend', refresh); map.on('sourcedata', onData); map.on('sourcedataloading', onData); map.on('error', onError)
  return {
    set(next: MapReferenceLayers, nextDate: string | null) {
      const dateChanged = date !== nextDate
      flags = next; date = nextDate
      if (next.showBuiltUp) raster(HBASE_SOURCE, [`${protocol}://{z}/{y}/{x}`], 12, OVERLAY_CREDITS.showBuiltUp, 4, HBASE_BOUNDS)
      visibility(HBASE_SOURCE, next.showBuiltUp)
      if (next.showEuropeanProtectedAreas) raster(EUROPE_SOURCE, [`${EUROPE_SERVICE}/export?f=image&bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true&layers=show:0,1,2`], 14, OVERLAY_CREDITS.showEuropeanProtectedAreas, 0, EUROPE_BOUNDS)
      visibility(EUROPE_SOURCE, next.showEuropeanProtectedAreas)
      if (dateChanged) queryKeys.clear()
      updateStaticStatus(); void footprints(8); void footprints(9)
      map.getContainer().dataset.overlayCredits = Object.entries(OVERLAY_CREDITS).filter(([key]) => next[key as keyof typeof OVERLAY_CREDITS]).map(([, credit]) => credit).join(' | ')
    },
    retry() { failedSources.clear(); queryKeys.clear(); for (const id of [HBASE_SOURCE, EUROPE_SOURCE]) if (map.getSource(id)) map.refreshTiles(id); refresh() },
    destroy() { destroyed = true; for (const request of footprintRequests.values()) request.abort(); cancelAnimationFrame(frame); map.off('moveend', refresh); map.off('sourcedata', onData); map.off('sourcedataloading', onData); map.off('error', onError); for (const id of [HBASE_SOURCE, EUROPE_SOURCE, 'context-landsat-8-swaths', 'context-landsat-9-swaths']) remove(id); removeProtocol(protocol); statuses = {} },
  }
}
