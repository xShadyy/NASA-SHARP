import type { Map as MapLibreMap } from 'maplibre-gl'
import { GRATICULE_LINE_LAYER_ID } from './graticule'

const PHOSPHOR_MOUNTAINS_PATH = 'M254.88,195.92l-54.56-92.08A15.87,15.87,0,0,0,186.55,96h0a15.85,15.85,0,0,0-13.76,7.84l-15.64,26.39a4,4,0,0,0,0,4.07l26.8,45.47a8.13,8.13,0,0,1-1.89,10.55,8,8,0,0,1-11.8-2.26L101.79,71.88a16,16,0,0,0-27.58,0L1.11,195.94a8,8,0,0,0,1,9.52A8.23,8.23,0,0,0,8.23,208H247.77a8.29,8.29,0,0,0,6.09-2.55A8,8,0,0,0,254.88,195.92ZM64.43,120,88,80l23.57,40ZM140,52a24,24,0,1,1,24,24A24,24,0,0,1,140,52Z'

export const VOLCANO_SOURCE = 'smithsonian-holocene-volcanoes'
export const VOLCANO_ATTRIBUTION = '<a href="https://doi.org/10.5479/si.GVP.VOTW5-2026.5.4" target="_blank" rel="noopener">Global Volcanism Program / Smithsonian Institution · Volcanoes of the World v5.4.0</a>'
export const WDPA_SOURCE = 'unep-wcmc-wdpa-protected-areas'
export const WDPA_SERVICE = 'https://data-gis.unep-wcmc.org/server/rest/services/ProtectedSites/The_World_Database_of_Protected_Areas/MapServer'
export const WDPA_RELEASE = 'October 2026'
export const WDPA_ATTRIBUTION = `<a href="https://www.protectedplanet.net/" target="_blank" rel="noopener">UNEP-WCMC and IUCN (2026), Protected Planet: WDPCA · protected areas only (${WDPA_RELEASE})</a>`
export const WDPA_CAPTURE_CREDIT = `UNEP-WCMC and IUCN (2026), Protected Planet: The World Database on Protected and Conserved Areas (WDPCA) [On-line], [${WDPA_RELEASE}], Cambridge, UK: UNEP-WCMC and IUCN · protectedplanet.net`
export const CONTEXT_LAYER_IDS = {
  showProtectedAreas: ['context-protected-areas'],
  showVolcanoes: ['context-volcanoes', 'context-volcano-labels'],
} as const
export type ContextSettings = { showProtectedAreas: boolean, showBuiltUp: boolean, showVolcanoes: boolean }
function volcanoIconPixels(): ImageData {
  const canvas = document.createElement('canvas')
  canvas.width = 48; canvas.height = 48
  const ctx = canvas.getContext('2d')!
  ctx.scale(48 / 256, 48 / 256)
  const mountain = new Path2D(PHOSPHOR_MOUNTAINS_PATH)
  ctx.lineJoin = 'round'
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = 18
  ctx.stroke(mountain)
  ctx.fillStyle = '#ef5b4b'
  ctx.fill(mountain)
  return ctx.getImageData(0, 0, 48, 48)
}

export function applyContextVisibility(map: MapLibreMap, settings: ContextSettings) {
  if (settings.showProtectedAreas && !map.getSource(WDPA_SOURCE)) {
    map.addSource(WDPA_SOURCE, {
      type: 'raster', tiles: [`${WDPA_SERVICE}/tile/{z}/{y}/{x}`],
      tileSize: 256, minzoom: 0, maxzoom: 14, attribution: WDPA_ATTRIBUTION,
    })
    map.addLayer({
      id: 'context-protected-areas', type: 'raster', source: WDPA_SOURCE,
      paint: { 'raster-opacity': 0.42, 'raster-fade-duration': 0 },
    }, map.getLayer(GRATICULE_LINE_LAYER_ID) ? GRATICULE_LINE_LAYER_ID : 'geography-coastlines')
  }
  if (settings.showVolcanoes && !map.getSource(VOLCANO_SOURCE)) {
    map.addSource(VOLCANO_SOURCE, { type: 'geojson', data: '/map-data/holocene-volcanoes.geojson', maxzoom: 10, attribution: VOLCANO_ATTRIBUTION })
    map.addImage('known-volcano', volcanoIconPixels(), { pixelRatio: 2 })
    map.addLayer({ id: 'context-volcanoes', type: 'symbol', source: VOLCANO_SOURCE, minzoom: 2,
      layout: { 'icon-image': 'known-volcano', 'icon-size': ['interpolate', ['linear'], ['zoom'], 2, 0.55, 6, 0.85], 'icon-pitch-alignment': 'map', 'icon-overlap': 'always', 'icon-ignore-placement': true, 'icon-padding': 3 } }, 'geography-sea-labels')
    map.addLayer({ id: 'context-volcano-labels', type: 'symbol', source: VOLCANO_SOURCE, minzoom: 6,
      layout: { 'text-field': ['get', 'name'], 'text-font': ['Fira Sans'], 'text-size': 11, 'text-offset': [0, 0.9], 'text-anchor': 'top', 'text-max-width': 10, 'text-pitch-alignment': 'map' },
      paint: { 'text-color': '#fff', 'text-halo-color': '#15222d', 'text-halo-width': 1.5 } }, 'geography-sea-labels')
  }
  for (const [key, ids] of Object.entries(CONTEXT_LAYER_IDS)) {
    for (const id of ids) {
      if (!map.getLayer(id)) continue
      const value = settings[key as keyof ContextSettings] ? 'visible' : 'none'
      if (map.getLayoutProperty(id, 'visibility') !== value) map.setLayoutProperty(id, 'visibility', value)
    }
  }
}
