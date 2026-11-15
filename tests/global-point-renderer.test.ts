import assert from 'node:assert/strict'
import test from 'node:test'
import type { Feature, MultiPoint, Point } from 'geojson'
import {
  createGlobalPointRenderer,
  prepareGlobalPointBatches,
} from '../src/map/global-point-renderer'

type QueriedPoint = Feature<Point | MultiPoint> & { tile?: { z: number; x: number; y: number } }
function point(id: number, longitude = 0, latitude = 0): QueriedPoint {
  return {
    type: 'Feature',
    id,
    properties: { frpMw: null },
    geometry: { type: 'Point', coordinates: [longitude, latitude] },
  }
}

test('GPU preparation retains every individual observation beyond the symbol bucket bound', () => {
  const records = Array.from({ length: 40_000 }, (_, id) => point(id, 10 + id / 100_000, 20))
  const prepared = prepareGlobalPointBatches(records, 2)
  assert.equal(prepared.count, 40_000)
  assert.equal(prepared.bytes, 40_000 * 8)
  assert.equal(
    prepared.batches.reduce((sum, batch) => sum + batch.count, 0),
    40_000,
  )
  assert.ok(prepared.batches.every((batch) => batch.positions instanceof Float32Array))
})

test('GPU preparation deduplicates tile buffers and wraps while retaining coincident records and unknown FRP', () => {
  const original = point(1, -180, 0)
  const wrapped: QueriedPoint = {
    ...original,
    geometry: {
      type: 'MultiPoint',
      coordinates: [
        [-180, 0],
        [180, 0],
      ],
    },
  }
  const prepared = prepareGlobalPointBatches(
    [original, wrapped, point(2, -180, 0), point(3, 10, 20)],
    1,
  )
  assert.equal(prepared.count, 3)
  assert.equal(prepared.bytes, 24)
  const coordinates = prepared.batches.flatMap((batch) => Array.from(batch.positions))
  assert.ok(coordinates.every(Number.isFinite))
})

test('loaded child coordinates take precedence over a coarser parent copy', () => {
  const parent = { ...point(7, 10, 20), tile: { z: 0, x: 0, y: 0 } }
  const child = { ...point(7, 10.000001, 20.000001), tile: { z: 8, x: 135, y: 113 } }
  const prepared = prepareGlobalPointBatches([parent, child])
  assert.equal(prepared.count, 1)
  assert.deepEqual(prepared.batches[0].tile, child.tile)
})

test('the z0 antimeridian keeps its canonical left edge before rendering wrapped copies', () => {
  const prepared = prepareGlobalPointBatches([point(1, -180, 0)])
  assert.equal(prepared.batches[0].positions[0], 0)
})

test('tile-local GPU coordinates retain subpixel precision at close zoom', () => {
  const longitude = 17.123456789
  const latitude = 54.987654321
  const zoom = 18
  const scale = 2 ** zoom
  const mx = (longitude + 180) / 360
  const my = (1 - Math.asinh(Math.tan((latitude * Math.PI) / 180)) / Math.PI) / 2
  const tile = { z: zoom, x: Math.floor(mx * scale), y: Math.floor(my * scale) }
  const prepared = prepareGlobalPointBatches([{ ...point(5, longitude, latitude), tile }])
  const [x, y] = prepared.batches[0].positions
  assert.ok(Math.abs(x - (mx * scale - tile.x) * 8192) < 0.001)
  assert.ok(Math.abs(y - (my * scale - tile.y) * 8192) < 0.001)
  assert.equal(prepared.count, 1)
})

test('an empty successfully loaded source prepares a successful zero without fake observations', () => {
  assert.deepEqual(prepareGlobalPointBatches([]).batches, [])
  assert.equal(prepareGlobalPointBatches([]).count, 0)
})

test('identical source refreshes retain GPU revision while changed coordinates request a new upload', () => {
  const renderer = createGlobalPointRenderer()
  const first = { ...point(1, -100, 30), tile: { z: 2, x: 0, y: 1 } }
  const second = { ...point(2, 10, 20), tile: { z: 2, x: 2, y: 1 } }
  const original = renderer.setFeatures([first, second])
  assert.equal(original.revision, 1)
  assert.deepEqual(renderer.setFeatures([{ ...first }, { ...second }]), original)
  assert.deepEqual(
    renderer.setFeatures([second, first]),
    original,
    'Tile iteration order does not invalidate identical GPU data',
  )
  assert.equal(
    renderer.setFeatures([first, { ...point(2, 10.1, 20), tile: second.tile }]).revision,
    2,
  )
  assert.equal(renderer.setFeatures([]).revision, 3)
  assert.equal(
    renderer.setFeatures([]).revision,
    3,
    'Repeated successful zero keeps its existing empty upload',
  )
})
