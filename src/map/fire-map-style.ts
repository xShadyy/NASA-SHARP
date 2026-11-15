import type {
  ExpressionSpecification,
  FillLayerSpecification,
  LineLayerSpecification,
  SymbolLayerSpecification,
} from 'maplibre-gl'

export const FIRE_POINT_SOURCE = 'analysis-observations'
export const FIRE_FOOTPRINT_SOURCE = 'analysis-fire-footprints'
export const FIRE_SQUARE_IMAGE = 'analysis-hotspot-square'
export const FIRE_MAP_LAYERS = {
  footprints: 'analysis-fire-footprint-fills',
  footprintEdges: 'analysis-fire-footprint-edges',
  observations: 'analysis-fire-centers',
  clusters: 'analysis-fire-clusters',
} as const
export const FOOTPRINT_MIN_ZOOM = 12
export const MAX_VISIBLE_FOOTPRINTS = 1500
export const FIRE_CLUSTER_THRESHOLD = 20000

export const FIRE_COLOR_EXPRESSION: ExpressionSpecification = [
  'match',
  ['get', 'severity'],
  'high',
  '#dc2626',
  'moderate',
  '#f97316',
  'low',
  '#f5c518',
  '#9ca3af',
]

export function fireSquareSprite() {
  const width = 32
  const data = new Uint8Array(width * width * 4)
  for (let y = 0; y < width; y++)
    for (let x = 0; x < width; x++) {
      const distance = Math.min(x - 4, 27 - x, y - 4, 27 - y)
      const index = (y * width + x) * 4
      data[index] = data[index + 1] = data[index + 2] = 255
      data[index + 3] = Math.max(0, Math.min(255, Math.round(192 + distance * 32)))
    }
  return { width, height: width, data }
}

export function fireLayerSpecifications(): (
  FillLayerSpecification | LineLayerSpecification | SymbolLayerSpecification
)[] {
  const highlight: ExpressionSpecification = [
    'any',
    ['boolean', ['feature-state', 'hover'], false],
    ['boolean', ['feature-state', 'selected'], false],
  ]
  return [
    {
      id: FIRE_MAP_LAYERS.footprints,
      type: 'fill',
      source: FIRE_FOOTPRINT_SOURCE,
      minzoom: FOOTPRINT_MIN_ZOOM,
      paint: {
        'fill-color': FIRE_COLOR_EXPRESSION,
        'fill-opacity': ['case', highlight, 0.85, 0.48],
        'fill-antialias': false,
      },
    },
    {
      id: FIRE_MAP_LAYERS.footprintEdges,
      type: 'line',
      source: FIRE_FOOTPRINT_SOURCE,
      minzoom: FOOTPRINT_MIN_ZOOM,
      paint: {
        'line-color': ['case', highlight, '#ffffff', FIRE_COLOR_EXPRESSION],
        'line-width': ['case', highlight, 1.5, 0.6],
        'line-opacity': 0.9,
      },
    },
    {
      id: FIRE_MAP_LAYERS.observations,
      type: 'symbol',
      source: FIRE_POINT_SOURCE,
      filter: ['!', ['has', 'point_count']],
      layout: {
        'icon-image': FIRE_SQUARE_IMAGE,
        'icon-size': ['interpolate', ['linear'], ['zoom'], 0, 0.375, 8, 0.51, 14, 0.63],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'icon-padding': 0,
        'icon-anchor': 'center',
        'icon-pitch-alignment': 'viewport',
        'icon-rotation-alignment': 'viewport',
        'symbol-sort-key': ['coalesce', ['get', 'acquiredEpoch'], 0],
      },
      paint: {
        'icon-color': FIRE_COLOR_EXPRESSION,
        'icon-halo-color': '#ffffff',
        'icon-halo-width': ['case', highlight, 1.5, 0],
        'icon-opacity': 1,
      },
    },
    {
      id: FIRE_MAP_LAYERS.clusters,
      type: 'symbol',
      source: FIRE_POINT_SOURCE,
      filter: ['has', 'point_count'],
      layout: {
        'icon-image': FIRE_SQUARE_IMAGE,
        'icon-size': 2,
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'icon-padding': 0,
        'icon-anchor': 'center',
        'symbol-sort-key': ['coalesce', ['get', 'latestEpoch'], 0],
        'text-field': ['to-string', ['get', 'point_count_abbreviated']],
        'text-size': 10,
        'text-font': ['Fira Sans'],
        'text-allow-overlap': true,
        'text-ignore-placement': true,
        'text-padding': 0,
        'text-anchor': 'center',
      },
      paint: {
        'icon-color': [
          'case',
          ['<', ['get', 'maxFrp'], 0],
          '#9ca3af',
          ['>=', ['get', 'maxFrp'], 50],
          '#dc2626',
          ['>=', ['get', 'maxFrp'], 10],
          '#f97316',
          '#f5c518',
        ],
        'icon-halo-color': '#25292e',
        'icon-halo-width': 0.85,
        'text-color': '#111827',
        'text-halo-color': '#ffffff',
        'text-halo-width': 0.75,
      },
    },
  ]
}
