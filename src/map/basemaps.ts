import { applyContextVisibility, type ContextSettings } from './context-overlays'
import type {
  ExpressionSpecification,
  LayerSpecification,
  Map as MapLibreMap,
  StyleSpecification,
} from 'maplibre-gl'
import {
  applyGeographicAppearance,
  geographyLayers,
  geographySources,
  GEOGRAPHIC_LABEL_IDS,
  CITY_LABEL_LAYER_IDS,
  OPENFREEMAP_GLYPHS,
} from './geography'
import { GLOBE_PROJECTION, type MapView } from './projection'
import {
  GRATICULE_LAYER_IDS,
  GRATICULE_SOURCE_ID,
  graticuleLayers,
  graticuleSource,
} from './graticule'
export {
  applyGeographicAppearance,
  BOUNDARY_LAYER_IDS,
  FIRE_LAYER_BEFORE_ID,
  registerGeographicImages,
} from './geography'

export const NASA_SOURCE_ID = 'nasa-blue-marble'
export const NASA_LAYER_ID = 'earth-blue-marble'
export const NASA_FALLBACK_LAYER_ID = 'earth-blue-marble-fallback'
export const NASA_FALLBACK_WATER_LAYER_ID = 'earth-blue-marble-fallback-water'
export const DETAIL_SOURCE_ID = 'openfreemap'

export type MapBackground = 'topographic' | 'dark-gray' | 'light-gray' | 'firefly' | 'blue-marble'
export const DEFAULT_MAP_BACKGROUND: MapBackground = 'blue-marble'
export const MAP_BACKGROUND_OPTIONS: {
  value: MapBackground
  label: string
  description: string
}[] = [
  {
    value: 'topographic',
    label: 'Topographic',
    description: 'Terrain, land cover and geographic context',
  },
  { value: 'dark-gray', label: 'Dark Gray', description: 'Quiet monochrome cartography' },
  { value: 'light-gray', label: 'Light Gray', description: 'Light monochrome cartography' },
  { value: 'firefly', label: 'Firefly', description: 'Muted NASA imagery · Firefly-inspired' },
  { value: 'blue-marble', label: 'Blue Marble', description: 'NASA Earth imagery' },
]

export function isMapBackground(value: unknown): value is MapBackground {
  return MAP_BACKGROUND_OPTIONS.some((option) => option.value === value)
}

export const NASA_BLUE_MARBLE_URL =
  'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg'

export const NASA_ATTRIBUTION =
  '<a href="https://nasa-gibs.github.io/gibs-api-docs/" target="_blank" rel="noopener">NASA GIBS</a> · <a href="https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/base-topography-bathymetry/" target="_blank" rel="noopener">Blue Marble / NASA Earth Observatory</a>'

export const DETAIL_ATTRIBUTION =
  '<a href="https://openfreemap.org/" target="_blank" rel="noopener">OpenFreeMap</a> · <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">© OpenMapTiles</a> · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a> · <a href="https://www.naturalearthdata.com/about/terms-of-use/" target="_blank" rel="noopener">Natural Earth</a> · <a href="/map-data/STYLE-NOTICES.md" target="_blank" rel="noopener">Style credits</a>'

export const DETAIL_LAYER_IDS = [
  'detail-land',
  'detail-relief',
  'detail-wood',
  'detail-grass',
  'detail-ice',
  'detail-water',
  'detail-waterways',
  'detail-roads-minor',
  'detail-roads-major-casing',
  'detail-roads-major',
  'detail-motorways',
  'detail-buildings',
] as const

const DETAIL_LABEL_LAYER_IDS = [
  'detail-road-labels',
  'detail-town-labels',
  'detail-peak-labels',
] as const

export const LABEL_LAYER_IDS = [...GEOGRAPHIC_LABEL_IDS, ...DETAIL_LABEL_LAYER_IDS]

export const ROAD_LAYER_IDS = [
  'detail-roads-minor',
  'detail-roads-major-casing',
  'detail-roads-major',
  'detail-motorways',
  'detail-road-labels',
] as const

export const SETTLEMENT_LAYER_IDS = ['detail-town-labels', 'detail-buildings'] as const

export const COUNTRY_BORDER_LAYER_IDS = [
  'geography-country-borders',
  'geography-disputed-borders',
] as const

export const TERRAIN_LAYER_IDS = [
  'detail-relief',
  'detail-wood',
  'detail-grass',
  'detail-peak-labels',
] as const
const REFERENCE_DETAIL_LAYER_IDS = new Set<string>([
  ...ROAD_LAYER_IDS,
  ...SETTLEMENT_LAYER_IDS,
  ...TERRAIN_LAYER_IDS,
])

export type MapReferenceLayers = ContextSettings & {
  showGraticule: boolean
  showEuropeanProtectedAreas: boolean
  showLandsat8Swaths: boolean
  showLandsat9Swaths: boolean
  showCoastlines: boolean
  showCities: boolean
  showRoads: boolean
  showSettlements: boolean
  showBorders: boolean
  showLabels: boolean
  showTerrain: boolean
}

export const DEFAULT_REFERENCE_LAYERS: MapReferenceLayers = {
  showGraticule: false,
  showEuropeanProtectedAreas: false,
  showLandsat8Swaths: false,
  showLandsat9Swaths: false,
  showCoastlines: true,
  showCities: true,
  showProtectedAreas: false,
  showBuiltUp: false,
  showVolcanoes: false,
  showRoads: true,
  showSettlements: true,
  showBorders: true,
  showLabels: true,
  showTerrain: true,
}

export type MapLayerSettings = MapReferenceLayers & {
  view: MapView
  background?: MapBackground
}

export type ZoomDependentLayerAvailability = {
  available: boolean

  minZoom: number | null
  visibleAtCurrentZoom: boolean
}

export type ReferenceLayerAvailability = {
  roads: ZoomDependentLayerAvailability
  settlements: ZoomDependentLayerAvailability
}

export function getReferenceLayerAvailability(map: MapLibreMap): ReferenceLayerAvailability {
  const layers = map.getStyle()?.layers ?? []
  const zoom = map.getZoom()
  const group = (ids: readonly string[]): ZoomDependentLayerAvailability => {
    const candidates = layers.filter(
      (layer) => ids.includes(layer.id) && 'source' in layer && !!map.getSource(layer.source),
    )
    return {
      available: candidates.length > 0,
      minZoom: candidates.length
        ? Math.min(...candidates.map((layer) => layer.minzoom ?? 0))
        : null,
      visibleAtCurrentZoom: candidates.some(
        (layer) => zoom >= (layer.minzoom ?? 0) && zoom < (layer.maxzoom ?? 24),
      ),
    }
  }
  return { roads: group(ROAD_LAYER_IDS), settlements: group(SETTLEMENT_LAYER_IDS) }
}

export function applyLayerVisibility(map: MapLibreMap, settings: MapLayerSettings) {
  const {
    background = DEFAULT_MAP_BACKGROUND,
    showRoads,
    showSettlements,
    showBorders,
    showLabels,
    showTerrain,
  } = settings
  const imagery = background === 'blue-marble' || background === 'firefly'
  const detailed = !imagery || map.getZoom() >= 8
  const appearance =
    background === 'dark-gray' || background === 'firefly'
      ? background === 'firefly'
        ? 'firefly'
        : 'dark'
      : imagery && map.getZoom() < 8.5
        ? 'globe'
        : 'map'
  applyBackgroundAppearance(map, background)
  applyGeographicAppearance(map, appearance)
  const visibility = (id: string, visible: boolean) => {
    if (!map.getLayer(id)) return
    const next = visible ? 'visible' : 'none'
    if (map.getLayoutProperty(id, 'visibility') !== next)
      map.setLayoutProperty(id, 'visibility', next)
  }
  visibility(NASA_FALLBACK_LAYER_ID, imagery && map.getZoom() < 9)
  visibility(NASA_FALLBACK_WATER_LAYER_ID, imagery && map.getZoom() < 9)
  visibility(NASA_LAYER_ID, imagery && map.getZoom() < 9)
  for (const id of DETAIL_LAYER_IDS) {
    if (!REFERENCE_DETAIL_LAYER_IDS.has(id)) visibility(id, detailed)
  }
  for (const id of GRATICULE_LAYER_IDS) visibility(id, settings.showGraticule)
  visibility('geography-coastlines', settings.showCoastlines)
  for (const id of COUNTRY_BORDER_LAYER_IDS) visibility(id, showBorders)
  for (const id of GEOGRAPHIC_LABEL_IDS)
    visibility(
      id,
      (CITY_LABEL_LAYER_IDS as readonly string[]).includes(id) ? settings.showCities : showLabels,
    )
  for (const id of ROAD_LAYER_IDS) visibility(id, showRoads)
  for (const id of SETTLEMENT_LAYER_IDS) visibility(id, showSettlements)
  for (const id of TERRAIN_LAYER_IDS) visibility(id, detailed && showTerrain)
  applyContextVisibility(map, settings)
}
const terrainColors = {
  land: '#f0eee5',
  water: '#bad8e8',
  wood: '#b8cfb0',
  grass: '#d4dec0',
  ice: '#f8fcff',
  minorRoad: '#ffffff',
  majorRoad: '#fff8e4',
  casing: '#c4bca9',
  motorway: '#dfb789',
  building: '#d5d1c7',
  text: '#263b50',
  halo: '#ffffff',
  reliefOpacity: 0.78,
  reliefBrightness: 1,
} as const

type BackgroundPalette = {
  [Key in keyof typeof terrainColors]: (typeof terrainColors)[Key] extends number ? number : string
}
const palettes: Record<MapBackground, BackgroundPalette> = {
  topographic: terrainColors,
  'blue-marble': terrainColors,
  'light-gray': {
    ...terrainColors,
    land: '#e8e9e8',
    water: '#cdd3d5',
    wood: '#d9ddda',
    grass: '#e1e3df',
    ice: '#f5f6f6',
    minorRoad: '#fafbfb',
    majorRoad: '#ffffff',
    motorway: '#c3c8ca',
    casing: '#bdc3c5',
    building: '#ced2d2',
    text: '#39464e',
    halo: '#f4f5f4',
    reliefOpacity: 0.12,
  },
  'dark-gray': {
    land: '#292e32',
    water: '#171d22',
    wood: '#303936',
    grass: '#343b37',
    ice: '#aab6bd',
    minorRoad: '#596269',
    majorRoad: '#909aa1',
    casing: '#1b2228',
    motorway: '#b3bdc3',
    building: '#3c464e',
    text: '#d9e1e6',
    halo: '#222a30',
    reliefOpacity: 0.15,
    reliefBrightness: 0.42,
  },
  firefly: {
    land: '#0b1720',
    water: '#06111a',
    wood: '#172c2d',
    grass: '#1a2b2c',
    ice: '#7c9298',
    minorRoad: '#627b81',
    majorRoad: '#9fb4b6',
    casing: '#07121d',
    motorway: '#b5c9cb',
    building: '#233741',
    text: '#dae8eb',
    halo: '#07131d',
    reliefOpacity: 0.38,
    reliefBrightness: 0.45,
  },
}
const backgroundByMap = new WeakMap<MapLibreMap, string>()

function applyBackgroundAppearance(map: MapLibreMap, background: MapBackground) {
  const signature = background
  if (backgroundByMap.get(map) === signature) return
  backgroundByMap.set(map, signature)
  const colors = palettes[background]
  const imagery = background === 'blue-marble' || background === 'firefly'
  const opacity: number | ExpressionSpecification = imagery
    ? ['interpolate', ['linear'], ['zoom'], 8, 0, 9, 1]
    : 1
  const paint = (
    id: string,
    property: Parameters<MapLibreMap['setPaintProperty']>[1],
    value: Parameters<MapLibreMap['setPaintProperty']>[2],
  ) => {
    if (map.getLayer(id)) map.setPaintProperty(id, property, value)
  }
  paint('detail-land', 'background-color', colors.land)
  paint('detail-land', 'background-opacity', opacity)
  for (const [id, color] of [
    ['detail-wood', colors.wood],
    ['detail-grass', colors.grass],
    ['detail-ice', colors.ice],
    ['detail-water', colors.water],
    ['detail-buildings', colors.building],
  ])
    paint(id, 'fill-color', color)
  for (const [id, multiplier] of [
    ['detail-wood', 0.65],
    ['detail-grass', 0.45],
    ['detail-ice', 1],
    ['detail-water', 1],
  ] as const) {
    paint(
      id,
      'fill-opacity',
      typeof opacity === 'number'
        ? multiplier
        : ['interpolate', ['linear'], ['zoom'], 8, 0, 9, multiplier],
    )
  }
  for (const [id, color] of [
    ['detail-waterways', colors.water],
    ['detail-roads-minor', colors.minorRoad],
    ['detail-roads-major-casing', colors.casing],
    ['detail-roads-major', colors.majorRoad],
    ['detail-motorways', colors.motorway],
  ])
    paint(id, 'line-color', color)
  for (const id of DETAIL_LABEL_LAYER_IDS) {
    paint(id, 'text-color', colors.text)
    paint(id, 'text-halo-color', colors.halo)
  }
  paint('detail-relief', 'raster-opacity', [
    'interpolate',
    ['linear'],
    ['zoom'],
    5,
    colors.reliefOpacity,
    7,
    0,
  ])
  paint('detail-relief', 'raster-brightness-max', colors.reliefBrightness)
  paint(
    'detail-relief',
    'raster-saturation',
    background === 'topographic' || background === 'blue-marble' ? 0 : -1,
  )
  paint(NASA_LAYER_ID, 'raster-saturation', background === 'firefly' ? -0.9 : 0)
  paint(NASA_LAYER_ID, 'raster-brightness-max', background === 'firefly' ? 0.52 : 1)
  paint(NASA_LAYER_ID, 'raster-contrast', background === 'firefly' ? 0.12 : 0)
}

const name: ExpressionSpecification = [
  'coalesce',
  ['get', 'name:en'],
  ['get', 'name_en'],
  ['get', 'name:latin'],
  ['get', 'name_int'],
  ['get', 'name'],
]

function detailedLayers(): LayerSpecification[] {
  const colors = terrainColors
  const layers: LayerSpecification[] = [
    {
      id: 'detail-land',
      type: 'background',
      paint: { 'background-color': colors.land },
    },
    {
      id: 'detail-relief',
      type: 'raster',
      source: 'natural-earth-relief',
      maxzoom: 7,
      paint: {
        'raster-opacity': ['interpolate', ['linear'], ['zoom'], 5, colors.reliefOpacity, 7, 0],
        'raster-brightness-max': colors.reliefBrightness,
        'raster-fade-duration': 0,
      },
    },
    {
      id: 'detail-wood',
      type: 'fill',
      source: DETAIL_SOURCE_ID,
      'source-layer': 'landcover',
      filter: ['==', 'class', 'wood'],
      paint: { 'fill-color': colors.wood, 'fill-opacity': 0.65 },
    },
    {
      id: 'detail-grass',
      type: 'fill',
      source: DETAIL_SOURCE_ID,
      'source-layer': 'landcover',
      filter: ['in', 'class', 'grass', 'scrub', 'farmland'],
      paint: { 'fill-color': colors.grass, 'fill-opacity': 0.45 },
    },
    {
      id: 'detail-ice',
      type: 'fill',
      source: DETAIL_SOURCE_ID,
      'source-layer': 'landcover',
      filter: ['==', 'class', 'ice'],
      paint: { 'fill-color': colors.ice },
    },
    {
      id: 'detail-water',
      type: 'fill',
      source: DETAIL_SOURCE_ID,
      'source-layer': 'water',
      paint: { 'fill-color': colors.water },
    },
    {
      id: 'detail-waterways',
      type: 'line',
      source: DETAIL_SOURCE_ID,
      'source-layer': 'waterway',
      minzoom: 7,
      paint: {
        'line-color': colors.water,
        'line-width': ['interpolate', ['linear'], ['zoom'], 7, 0.5, 14, 2],
      },
    },
    {
      id: 'detail-roads-minor',
      type: 'line',
      source: DETAIL_SOURCE_ID,
      'source-layer': 'transportation',
      minzoom: 11,
      filter: ['in', 'class', 'minor', 'service', 'track', 'path'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': colors.minorRoad,
        'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.5, 18, 5],
      },
    },
    {
      id: 'detail-roads-major-casing',
      type: 'line',
      source: DETAIL_SOURCE_ID,
      'source-layer': 'transportation',
      minzoom: 6,
      filter: ['in', 'class', 'trunk', 'primary', 'secondary', 'tertiary'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': colors.casing,
        'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.5, 14, 4, 18, 12],
      },
    },
    {
      id: 'detail-roads-major',
      type: 'line',
      source: DETAIL_SOURCE_ID,
      'source-layer': 'transportation',
      minzoom: 6,
      filter: ['in', 'class', 'trunk', 'primary', 'secondary', 'tertiary'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': colors.majorRoad,
        'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.25, 14, 2.5, 18, 10],
      },
    },
    {
      id: 'detail-motorways',
      type: 'line',
      source: DETAIL_SOURCE_ID,
      'source-layer': 'transportation',
      minzoom: 5,
      filter: ['==', 'class', 'motorway'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': colors.motorway,
        'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.5, 14, 3, 18, 12],
      },
    },
    {
      id: 'detail-buildings',
      type: 'fill',
      source: DETAIL_SOURCE_ID,
      'source-layer': 'building',
      minzoom: 14,
      paint: { 'fill-color': colors.building, 'fill-opacity': 0.8 },
    },
    {
      id: 'detail-road-labels',
      type: 'symbol',
      source: DETAIL_SOURCE_ID,
      'source-layer': 'transportation_name',
      minzoom: 13,
      layout: {
        'text-field': name,
        'text-font': ['Fira Sans'],
        'text-size': 11,
        'symbol-placement': 'line',
        'text-max-angle': 30,
      },
      paint: { 'text-color': colors.text, 'text-halo-color': colors.halo, 'text-halo-width': 1.5 },
    },
    {
      id: 'detail-town-labels',
      type: 'symbol',
      source: DETAIL_SOURCE_ID,
      'source-layer': 'place',
      minzoom: 8,
      filter: ['in', 'class', 'town', 'village', 'hamlet', 'suburb', 'neighbourhood'],
      layout: {
        'text-field': name,
        'text-font': ['Fira Sans'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 7, 10, 14, 13],
      },
      paint: { 'text-color': colors.text, 'text-halo-color': colors.halo, 'text-halo-width': 1.5 },
    },
    {
      id: 'detail-peak-labels',
      type: 'symbol',
      source: DETAIL_SOURCE_ID,
      'source-layer': 'mountain_peak',
      minzoom: 10,
      layout: {
        'text-field': ['concat', name, '\n', ['to-string', ['get', 'ele']], ' m'],
        'text-font': ['Fira Sans'],
        'text-size': 11,
        'text-max-width': 8,
      },
      paint: { 'text-color': colors.text, 'text-halo-color': colors.halo, 'text-halo-width': 1.5 },
    },
  ]
  return layers.map((layer) => ({ ...layer, layout: { ...layer.layout, visibility: 'none' } }))
}

export function createEarthStyle(view: MapView = 'globe'): StyleSpecification {
  const details = detailedLayers()
  const grid = graticuleLayers()
  return {
    version: 8,
    name: 'Ethereal Earth',
    projection: { type: view === 'globe' ? GLOBE_PROJECTION : 'mercator' },
    glyphs: OPENFREEMAP_GLYPHS,
    'font-faces': { 'Fira Sans': '/brand/fonts/fira-sans-latin-400.woff2' },
    transition: { duration: 0, delay: 0 },
    sources: {
      ...geographySources(),
      [GRATICULE_SOURCE_ID]: graticuleSource(),
      [NASA_SOURCE_ID]: {
        type: 'raster',
        tiles: [NASA_BLUE_MARBLE_URL],
        tileSize: 256,
        minzoom: 0,
        maxzoom: 8,
        attribution: NASA_ATTRIBUTION,
      },
      [DETAIL_SOURCE_ID]: {
        type: 'vector',
        url: 'https://tiles.openfreemap.org/planet',
        attribution: DETAIL_ATTRIBUTION,
      },
      'natural-earth-relief': {
        type: 'raster',
        tiles: ['https://tiles.openfreemap.org/natural_earth/ne2sr/{z}/{x}/{y}.png'],
        tileSize: 512,
        minzoom: 0,
        maxzoom: 6,
        attribution: DETAIL_ATTRIBUTION,
      },
    },
    layers: [
      { id: 'earth-loading-surface', type: 'background', paint: { 'background-color': '#000000' } },

      {
        id: NASA_FALLBACK_LAYER_ID,
        type: 'raster',
        source: 'natural-earth-relief',
        paint: { 'raster-fade-duration': 0 },
        layout: { visibility: 'none' },
      },
      {
        id: NASA_FALLBACK_WATER_LAYER_ID,
        type: 'fill',
        source: DETAIL_SOURCE_ID,
        'source-layer': 'water',
        paint: { 'fill-color': '#113c66' },
        layout: { visibility: 'none' },
      },
      {
        id: NASA_LAYER_ID,
        type: 'raster',
        source: NASA_SOURCE_ID,
        paint: { 'raster-fade-duration': 250 },
      },
      ...details.filter((layer) => layer.type !== 'symbol'),
      ...grid.filter((layer) => layer.type !== 'symbol'),
      ...geographyLayers(),
      ...details.filter((layer) => layer.type === 'symbol'),
      ...grid.filter((layer) => layer.type === 'symbol'),
    ],
  }
}
