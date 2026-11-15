import assert from 'node:assert/strict'
import test from 'node:test'
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec'
import {
  FIRE_MAP_LAYERS,
  FIRE_POINT_SOURCE,
  FIRE_FOOTPRINT_SOURCE,
  fireLayerSpecifications,
  fireSquareSprite,
} from '../src/map/fire-map-style'

test('hotspot square and footprint layers validate against installed MapLibre', () => {
  const layers = fireLayerSpecifications()
  const errors = validateStyleMin({
    version: 8,
    glyphs: 'https://example.test/{fontstack}/{range}.pbf',
    sources: {
      [FIRE_POINT_SOURCE]: {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
        promoteId: 'id',
      },
      [FIRE_FOOTPRINT_SOURCE]: {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
        promoteId: 'id',
      },
    },
    layers,
  })
  assert.deepEqual(
    errors.map((error) => error.message),
    [],
  )
  const centers = layers.find((layer) => layer.id === FIRE_MAP_LAYERS.observations)
  if (centers?.type !== 'symbol') throw new Error('Missing symbol centers')
  assert.equal(centers.layout?.['icon-allow-overlap'], true)
  assert.equal(centers.layout?.['icon-ignore-placement'], true)
  assert.equal(centers.layout?.['icon-padding'], 0)
  assert.equal(layers.find((layer) => layer.id === FIRE_MAP_LAYERS.footprints)?.minzoom, 12)
  const clusters = layers.find((layer) => layer.id === FIRE_MAP_LAYERS.clusters)
  if (clusters?.type !== 'symbol') throw new Error('Missing aggregate symbols')
  assert.deepEqual(clusters.layout?.['text-field'], [
    'to-string',
    ['get', 'point_count_abbreviated'],
  ])
})

test('square sprite has a symmetric signed distance field for high-DPI rendering', () => {
  const sprite = fireSquareSprite()
  const alpha = (x: number, y: number) => sprite.data[(y * sprite.width + x) * 4 + 3]
  assert.equal(sprite.width, 32)
  assert.equal(alpha(0, 0), 64)
  assert.equal(alpha(16, 16), 255)
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++) {
      assert.equal(alpha(x, y), alpha(31 - x, y))
      assert.equal(alpha(x, y), alpha(x, 31 - y))
    }
})
