import type { ExpressionSpecification, FilterSpecification, LayerSpecification, Map, SourceSpecification, SymbolLayerSpecification } from 'maplibre-gl'
import type { MapView } from './projection'

export const OPENFREEMAP_GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf'
export const GEOGRAPHY_ATTRIBUTION = '<a href="https://www.naturalearthdata.com/about/terms-of-use/" target="_blank" rel="noopener">Natural Earth</a>'

export const BOUNDARY_LAYER_IDS = ['geography-coastlines', 'geography-country-borders', 'geography-disputed-borders'] as const
export const GEOGRAPHIC_LABEL_IDS = [
  'geography-sea-labels', 'geography-ocean-labels', 'geography-continent-labels',
  'geography-city-labels-overview', 'geography-city-labels-local', 'geography-city-labels-regional', 'geography-city-labels-global',
  'geography-country-labels-minor', 'geography-country-labels-major',
] as const
export const CITY_LABEL_LAYER_IDS = [
  'geography-city-labels-overview', 'geography-city-labels-local',
  'geography-city-labels-regional', 'geography-city-labels-global',
] as const
export const FIRE_LAYER_BEFORE_ID = GEOGRAPHIC_LABEL_IDS[0]
const CITY_DOT = 'geography-city-dot'
const NAME: ExpressionSpecification = [
  'coalesce', ['get', 'name:en'], ['get', 'name_en'], ['get', 'name:latin'], ['get', 'name_int'], ['get', 'name'],
]
const FONT = ['Fira Sans']
const GLOBE_HALO = 'rgba(8, 22, 31, 0.88)'
type GeographicAppearance = MapView | 'dark' | 'firefly'
const appearanceByMap = new WeakMap<Map, GeographicAppearance>()

export function geographySources(): Record<string, SourceSpecification> {
  return {
    'geography-coastline': {
      type: 'geojson', data: '/map-data/coastline.geojson',
      maxzoom: 6, tolerance: 0.4, attribution: GEOGRAPHY_ATTRIBUTION,
    },
    'geography-global-cities': {
      type: 'geojson', data: '/map-data/global-cities.geojson',
      maxzoom: 2, attribution: GEOGRAPHY_ATTRIBUTION,
    },
    'geography-oceans': {
      type: 'geojson', data: '/map-data/ocean-labels.geojson',
      maxzoom: 6, attribution: GEOGRAPHY_ATTRIBUTION,
    },
  }
}

function cityLayer(id: string, minzoom: number, filter: FilterSpecification): SymbolLayerSpecification {
  return {
    id, type: 'symbol', source: 'openfreemap', 'source-layer': 'place', minzoom,
    filter,
    layout: {
      'text-field': NAME, 'text-font': FONT,
      'text-size': ['interpolate', ['linear'], ['zoom'], 0, 10.5, 3, 11, 7, 13, 12, 15],
      'text-variable-anchor': ['left', 'right', 'top', 'bottom'],
      'text-radial-offset': 0.55, 'text-justify': 'auto', 'text-max-width': 8,
      'text-padding': 5, 'text-optional': false, 'icon-optional': false,
      'text-allow-overlap': false, 'icon-allow-overlap': false,
      'icon-image': CITY_DOT, 'icon-size': 0.65, 'icon-padding': 2,
      'symbol-sort-key': ['coalesce', ['get', 'rank'], 99],
    },
    paint: { 'text-color': '#eef1f3', 'text-halo-color': GLOBE_HALO, 'text-halo-width': 1.2, 'text-halo-blur': 0.5 },
  }
}

export function geographyLayers(): LayerSpecification[] {
  const layers: LayerSpecification[] = [
    {
      id: 'geography-coastlines', type: 'line', source: 'geography-coastline', maxzoom: 6,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#b7cbd6', 'line-width': ['interpolate', ['linear'], ['zoom'], 0, 0.45, 4, 0.8, 6, 0.8],
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 0, 0.42, 4, 0.42, 6, 0],
      },
    },
    {
      id: 'geography-country-borders', type: 'line', source: 'openfreemap', 'source-layer': 'boundary',
      filter: ['all', ['==', 'admin_level', 2], ['!=', 'maritime', 1], ['!=', 'disputed', 1]],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#c7d3dc', 'line-opacity': 0.48,
        'line-width': ['interpolate', ['linear'], ['zoom'], 0, 0.45, 3, 0.6, 8, 1.1, 14, 1.6],
      },
    },
    {
      id: 'geography-disputed-borders', type: 'line', source: 'openfreemap', 'source-layer': 'boundary',
      filter: ['all', ['==', 'admin_level', 2], ['!=', 'maritime', 1], ['==', 'disputed', 1]],
      paint: {
        'line-color': '#c7d3dc', 'line-opacity': 0.48, 'line-dasharray': [2, 2],
        'line-width': ['interpolate', ['linear'], ['zoom'], 0, 0.45, 8, 1.1],
      },
    },
    {
      id: 'geography-sea-labels', type: 'symbol', source: 'openfreemap', 'source-layer': 'water_name', minzoom: 3,
      filter: ['!=', 'class', 'ocean'],
      layout: {
        'text-field': NAME, 'text-font': FONT, 'text-size': ['interpolate', ['linear'], ['zoom'], 3, 10, 8, 12],
        'text-letter-spacing': 0.15, 'text-max-width': 9, 'text-padding': 8,
        'symbol-sort-key': ['coalesce', ['get', 'rank'], 99],
      },
      paint: { 'text-color': '#adc6d1', 'text-halo-color': GLOBE_HALO, 'text-halo-width': 1, 'text-opacity': 0.8 },
    },
    {
      id: 'geography-ocean-labels', type: 'symbol', source: 'geography-oceans', maxzoom: 5,
      layout: {
        'text-field': ['get', 'name'], 'text-font': FONT, 'text-transform': 'uppercase',
        'text-size': ['interpolate', ['linear'], ['zoom'], 0, 10, 2, 12, 4, 15],
        'text-letter-spacing': 0.24, 'text-max-width': 10, 'text-padding': 5,
        'symbol-sort-key': ['coalesce', ['get', 'rank'], 0],
      },
      paint: { 'text-color': '#adc6d1', 'text-halo-color': GLOBE_HALO, 'text-halo-width': 1, 'text-opacity': 0.78 },
    },
    {
      id: 'geography-continent-labels', type: 'symbol', source: 'openfreemap', 'source-layer': 'place', maxzoom: 2.7,
      filter: ['all', ['==', ['get', 'class'], 'continent'], ['!', ['in', NAME, ['literal', ['Americas', 'Australia']]]]],
      layout: {
        'text-field': NAME, 'text-font': FONT, 'text-transform': 'uppercase',
        'text-size': ['interpolate', ['linear'], ['zoom'], 0, 10, 2.5, 13],
        'text-letter-spacing': 0.22, 'text-max-width': 9, 'text-padding': 5,
      },
      paint: { 'text-color': '#d4dfe5', 'text-halo-color': GLOBE_HALO, 'text-halo-width': 1.2, 'text-opacity': 0.7 },
    },
    {
      ...cityLayer('geography-city-labels-overview', 0, ['<=', 'rank', 1]),
      source: 'geography-global-cities', 'source-layer': undefined, maxzoom: 2,
    },
    cityLayer('geography-city-labels-local', 5, ['all', ['==', 'class', 'city'], ['>', 'rank', 4]]),
    cityLayer('geography-city-labels-regional', 3, ['all', ['==', 'class', 'city'], ['>', 'rank', 1], ['<=', 'rank', 4]]),
    cityLayer('geography-city-labels-global', 2, ['all', ['==', 'class', 'city'], ['<=', 'rank', 1]]),
    {
      id: 'geography-country-labels-minor', type: 'symbol', source: 'openfreemap', 'source-layer': 'place', minzoom: 2, maxzoom: 8,
      filter: ['all', ['==', 'class', 'country'], ['>=', 'rank', 2]],
      layout: {
        'text-field': NAME, 'text-font': FONT, 'text-transform': 'uppercase',
        'text-size': ['interpolate', ['linear'], ['zoom'], 2, 10, 5, 12, 8, 14],
        'text-letter-spacing': 0.06, 'text-max-width': 8, 'text-padding': 7,
        'symbol-sort-key': ['coalesce', ['get', 'rank'], 99],
      },
      paint: { 'text-color': '#e0e6eb', 'text-halo-color': GLOBE_HALO, 'text-halo-width': 1.2 },
    },
    {
      id: 'geography-country-labels-major', type: 'symbol', source: 'openfreemap', 'source-layer': 'place', maxzoom: 8,
      filter: ['all', ['==', 'class', 'country'], ['<=', 'rank', 1]],
      layout: {
        'text-field': NAME, 'text-font': FONT, 'text-transform': 'uppercase',
        'text-size': ['interpolate', ['linear'], ['zoom'], 0, 10, 2, 11, 5, 14, 8, 16],
        'text-letter-spacing': 0.07, 'text-max-width': 8, 'text-padding': 8,
        'symbol-sort-key': ['coalesce', ['get', 'rank'], 99],
      },
      paint: { 'text-color': '#e0e6eb', 'text-halo-color': GLOBE_HALO, 'text-halo-width': 1.2 },
    },
  ]
  const context = new Set(['geography-continent-labels', 'geography-ocean-labels'])
  return [...layers.filter((layer) => !context.has(layer.id)), ...layers.filter((layer) => context.has(layer.id))]
}

export function registerGeographicImages(map: Map) {
  if (map.hasImage(CITY_DOT)) return
  const size = 16
  const data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2)
      const offset = (y * size + x) * 4
      const center = distance <= 2.4
      data[offset] = center ? 243 : 16
      data[offset + 1] = center ? 246 : 31
      data[offset + 2] = center ? 248 : 42
      data[offset + 3] = Math.round(Math.max(0, Math.min(1, 4.2 - distance)) * 255)
    }
  }
  map.addImage(CITY_DOT, { width: size, height: size, data }, { pixelRatio: 1 })
}

export function applyGeographicAppearance(map: Map, view: GeographicAppearance) {
  if (appearanceByMap.get(map) === view) return
  appearanceByMap.set(map, view)
  const flat = view === 'map'
  for (const id of GEOGRAPHIC_LABEL_IDS) {
    if (!map.getLayer(id)) continue
    const water = id.includes('sea-') || id.includes('ocean-')
    const continent = id.includes('continent-')
    const city = id.includes('city-')
    const color = flat
      ? water ? '#54758b' : continent ? '#586d7c' : '#293f52'
      : view === 'dark' ? water ? '#9baebc' : continent ? '#b1bec8' : '#dce4e8'
      : view === 'firefly' ? water ? '#8daab5' : continent ? '#a8bdc4' : '#e3eef0'
      : water ? '#adc6d1' : continent ? '#d4dfe5' : city ? '#eef1f3' : '#e0e6eb'
    map.setPaintProperty(id, 'text-color', color)
    map.setPaintProperty(id, 'text-halo-color', flat ? 'rgba(250, 251, 248, 0.92)' : view === 'dark' ? '#222a30' : GLOBE_HALO)
  }
  for (const id of BOUNDARY_LAYER_IDS) {
    if (!map.getLayer(id)) continue
    map.setPaintProperty(id, 'line-color', flat ? '#647d91' : view === 'dark' || view === 'firefly' ? '#94a9b6' : id === 'geography-coastlines' ? '#b7cbd6' : '#c7d3dc')
  }
}
