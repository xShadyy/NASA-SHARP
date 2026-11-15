import assert from 'node:assert/strict'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import {
  visibleGlobalTiles,
  mergeGlobalTiles,
  type GlobalPoint,
  type GlobalTileCollection,
} from '../src/lib/global-tiles'
import { validateGlobalManifest } from '../src/hooks/use-global-fires'
import { clampPopupOffset } from '../src/map/draggable-popup'
import { classifyMapResourceError } from '../src/map/map-resource-errors'

test('global viewport budget coarsens the complete worldwide extent rather than dropping tiles', () => {
  const tiles = visibleGlobalTiles({ west: -180, east: 180, south: -90, north: 90 }, 18)
  assert.ok(tiles.length <= 24)
  const zoom = tiles[0].z,
    n = 2 ** zoom
  assert.equal(tiles.length, n * n)
  assert.equal(new Set(tiles.map((t) => `${t.z}/${t.x}/${t.y}`)).size, tiles.length)
  assert.ok(tiles.some((t) => t.x === 0 && t.y === 0))
  assert.ok(tiles.some((t) => t.x === n - 1 && t.y === n - 1))
})
test('global tiles handle the antimeridian, wrapped world copies and polar limits', () => {
  const one = visibleGlobalTiles({ west: 170, east: -170, south: -20, north: 20 }, 4)
  const wrapped = visibleGlobalTiles({ west: 530, east: 550, south: -20, north: 20 }, 4)
  assert.deepEqual(one, wrapped)
  assert.ok(one.some((t) => t.x === 0))
  assert.ok(one.some((t) => t.x === 2 ** t.z - 1))
  assert.ok(
    visibleGlobalTiles({ west: 0, east: 1, south: 89, north: 90 }, 18).every((t) => t.y === 0),
  )
})
function observation(id: string, longitude: number, platform = 'noaa-20'): GlobalPoint {
  return {
    type: 'Feature',
    id,
    geometry: { type: 'Point', coordinates: [longitude, 80] },
    properties: {
      id,
      kind: 'observation',
      acquiredAt: '2026-11-15T10:00:00Z',
      platform,
      sensor: 'VIIRS',
      frpMw: null,
      dayNight: 'unknown',
      confidence: { kind: 'categorical', value: null },
      scanKm: null,
      trackKm: null,
    },
  }
}
test('tile-buffer duplicates dedupe by canonical ID while coincident satellites and original coordinates remain distinct', () => {
  const a = observation('one', 180),
    b = observation('two', -180, 'noaa-21')
  const merged = mergeGlobalTiles([
    { type: 'FeatureCollection', features: [a, b] },
    { type: 'FeatureCollection', features: [a] },
  ])
  assert.equal(merged.observations.length, 2)
  assert.deepEqual(
    merged.observations.map((f) => f.geometry.coordinates[0]),
    [180, -180],
  )
  assert.equal(merged.observations[0].properties.frpMw, null)
  assert.equal(merged.observations[0].properties.severity, 'unknown')
  assert.deepEqual(merged.observations[0].properties.confidence, {
    kind: 'categorical',
    value: null,
  })
})
test('manifest interval identity never substitutes a rolling day for a requested seven-day window', () => {
  assert.throws(
    () => validateGlobalManifest({ status: 'ready', window: '24h' }, '7d'),
    /requested global interval/,
  )
  const manifest = {
    status: 'ready',
    window: '24h',
    snapshotId: 'version1',
    interval: { start: '2026-11-14T13:45:00Z', endExclusive: '2026-11-15T13:45:00Z' },
    tiles: '/global/version1/{z}/{x}/{y}.json',
  }
  assert.equal(validateGlobalManifest(manifest, '24h').interval?.start, manifest.interval.start)
  assert.throws(
    () =>
      validateGlobalManifest(
        {
          ...manifest,
          interval: { start: manifest.interval.start, endExclusive: manifest.interval.start },
        },
        '24h',
      ),
    /valid UTC interval/,
  )
})
test('expanded and dragged popup content remains within map viewport margins', () => {
  assert.deepEqual(
    clampPopupOffset(
      { left: -50, top: -40, width: 400, height: 300 },
      { left: 0, top: 0, width: 800, height: 600 },
      { x: 0, y: 0 },
    ),
    { x: 60, y: 50 },
  )
  assert.deepEqual(
    clampPopupOffset(
      { left: 600, top: 500, width: 190, height: 200 },
      { left: 0, top: 0, width: 800, height: 600 },
      { x: 0, y: 0 },
    ),
    { x: 0, y: -110 },
  )
})
test('nonimagery observation and glyph errors do not become a misleading imagery connection failure', () => {
  assert.equal(
    classifyMapResourceError('analysis-observations', 'geojson', 'Failed to prepare source'),
    'observations',
  )
  assert.equal(
    classifyMapResourceError(
      undefined,
      undefined,
      'Could not load glyphs from /fonts/Fira Sans/0-255.pbf',
    ),
    'labels',
  )
  assert.equal(classifyMapResourceError('openfreemap', 'vector', 'HTTP 503'), 'imagery')
  assert.equal(
    classifyMapResourceError('sharp-recurrence', 'geojson', 'Invalid feature'),
    'overlay',
  )
})
test('measure bounded client source preparation using explicit synthetic fixture', () => {
  const tiles: GlobalTileCollection[] = Array.from({ length: 24 }, (_, tile) => ({
    type: 'FeatureCollection',
    features: Array.from({ length: 1024 }, (_, index) =>
      observation(`${tile}:${index}`, 10 + index / 10000),
    ),
  }))
  const before = process.memoryUsage().heapUsed,
    start = performance.now()
  const merged = mergeGlobalTiles(tiles)
  const elapsed = performance.now() - start
  const payload = JSON.stringify({ type: 'FeatureCollection', features: merged.observations })
  const measurements = {
    kind: 'synthetic Node preparation fixture, not browser memory/frame-time or live-network measurements',
    tileCount: 24,
    sourceFeatures: merged.observations.length,
    prepareMs: Number(elapsed.toFixed(3)),
    approximateNodeHeapDeltaBytes: Math.max(0, process.memoryUsage().heapUsed - before),
    sourceJsonBytes: Buffer.byteLength(payload),
    sourceGzipBytes: gzipSync(payload).byteLength,
  }
  writeFileSync('tools/benchmark-global-client-results.json', JSON.stringify(measurements, null, 2))
  assert.equal(merged.observations.length, 24576)
})
