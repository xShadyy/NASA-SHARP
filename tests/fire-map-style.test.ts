import assert from 'node:assert/strict'
import test from 'node:test'
import { createExpression, validateStyleMin } from '@maplibre/maplibre-gl-style-spec'
import {
  FIRE_COLOR_EXPRESSION,
  FIRE_MAP_LAYERS,
  FIRE_POINT_SOURCE,
  FIRE_FOOTPRINT_SOURCE,
  FIRE_SQUARE_IMAGE,
  GLOBAL_FIRE_PIXEL_COLOR,
  GLOBAL_FIRE_PIXEL_SIZE_EXPRESSION,
  fireLayerSpecifications,
  fireSquareSprite,
  globalFirePixelSize,
} from '../src/map/fire-map-style'

test('individual global pixels validate with solid red independent of native FRP metadata', () => {
  const errors = validateStyleMin({
    version: 8,
    sources: {
      global: {
        type: 'vector',
        tiles: ['https://example.test/{z}/{x}/{y}.pbf'],
      },
    },
    layers: [
      {
        id: 'global-pixels',
        type: 'symbol',
        source: 'global',
        'source-layer': 'observations',
        layout: {
          'icon-image': FIRE_SQUARE_IMAGE,
          'icon-size': GLOBAL_FIRE_PIXEL_SIZE_EXPRESSION,
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          'icon-padding': 0,
        },
        paint: { 'icon-color': GLOBAL_FIRE_PIXEL_COLOR },
      },
    ],
  })
  assert.deepEqual(
    errors.map((error) => error.message),
    [],
  )
  assert.equal(GLOBAL_FIRE_PIXEL_COLOR, '#ff0000')
})

test('individual global pixels shrink smoothly to a fixed visible minimum', () => {
  const expression = createExpression(GLOBAL_FIRE_PIXEL_SIZE_EXPRESSION, 'icon-size')
  if (expression.result === 'error') assert.fail(JSON.stringify(expression.value))
  const solidCssPixels = (zoom: number) => 12 * expression.value.evaluate({ zoom })
  assert.equal(solidCssPixels(-1), 2.25)
  assert.equal(solidCssPixels(0), 2.25)
  assert.equal(solidCssPixels(12), 1)
  for (let zoom = 0.25; zoom <= 12; zoom += 0.25) {
    assert.ok(solidCssPixels(zoom) < solidCssPixels(zoom - 0.25))
    assert.ok(solidCssPixels(zoom) >= 1)
  }
  for (let zoom = 12; zoom <= 24; zoom += 0.25) assert.equal(solidCssPixels(zoom), 1)
  for (let zoom = -1; zoom <= 24; zoom += 0.125)
    assert.ok(Math.abs(globalFirePixelSize(zoom) - solidCssPixels(zoom)) < 1e-12)
  assert.equal(globalFirePixelSize(-Infinity), 2.25)
  assert.equal(globalFirePixelSize(Infinity), 1)
  assert.equal(globalFirePixelSize(NaN), 2.25)
})

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
  assert.deepEqual(centers.paint?.['icon-color'], FIRE_COLOR_EXPRESSION)
  assert.equal(layers.find((layer) => layer.id === FIRE_MAP_LAYERS.footprints)?.minzoom, 12)
  const footprints = layers.find((layer) => layer.id === FIRE_MAP_LAYERS.footprints)
  if (footprints?.type !== 'fill') throw new Error('Missing sensor footprints')
  assert.deepEqual(footprints.paint?.['fill-color'], FIRE_COLOR_EXPRESSION)
  const clusters = layers.find((layer) => layer.id === FIRE_MAP_LAYERS.clusters)
  if (clusters?.type !== 'symbol') throw new Error('Missing aggregate symbols')
  const clusterColor = createExpression(clusters.paint!['icon-color'], 'color')
  if (clusterColor.result === 'error') assert.fail(JSON.stringify(clusterColor.value))
  for (const [maxFrp, expected] of [
    [-1, '#9ca3af'],
    [0, '#f5c518'],
    [10, '#f97316'],
    [50, '#dc2626'],
  ])
    assert.equal(clusterColor.value.evaluate({ zoom: 0 }, { properties: { maxFrp } }), expected)
  assert.deepEqual(clusters.layout?.['text-field'], [
    'to-string',
    ['coalesce', ['get', 'detectionCount'], ['get', 'point_count']],
  ])
  const count = createExpression(clusters.layout?.['text-field'], 'string')
  if (count.result === 'error') assert.fail(JSON.stringify(count.value))
  assert.equal(
    count.value.evaluate({ zoom: 0 }, { properties: { detectionCount: 1201, point_count: 30 } }),
    '1201',
  )
  assert.equal(count.value.evaluate({ zoom: 0 }, { properties: { point_count: 30 } }), '30')
})

test('native FRP severity colors remain available to analytical scales', () => {
  const expression = createExpression(FIRE_COLOR_EXPRESSION, 'color')
  if (expression.result === 'error') assert.fail(JSON.stringify(expression.value))
  for (const [severity, expected] of [
    ['low', '#f5c518'],
    ['moderate', '#f97316'],
    ['high', '#dc2626'],
    ['unknown', '#9ca3af'],
  ]) {
    assert.equal(expression.value.evaluate({ zoom: 0 }, { properties: { severity } }), expected)
  }
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
