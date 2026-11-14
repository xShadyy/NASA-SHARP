import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import type { MultiPolygon, Polygon, Position } from 'geojson'
import {
  areaBounds,
  drawnArea,
  outsideAreaMask,
  validateDrawnArea,
  wrappedArea,
} from '../src/lib/analysis-area'

const polygon = (ring: number[][]): Polygon => ({ type: 'Polygon', coordinates: [ring] })
const crossing = polygon([
  [179, -18],
  [-179, -18],
  [-179, -16],
  [179, -16],
  [179, -18],
])

function contains(geometry: MultiPolygon, point: Position) {
  const inRing = (ring: Position[]) => {
    let inside = false
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x, y] = ring[i],
        [a, b] = ring[j]
      if (y > point[1] !== b > point[1] && point[0] < ((a - x) * (point[1] - y)) / (b - y) + x)
        inside = !inside
    }
    return inside
  }
  return geometry.coordinates.some((rings) => inRing(rings[0]) && !rings.slice(1).some(inRing))
}

test('antimeridian bounds choose the short extent and masks retain both sides', () => {
  const bounds = areaBounds(crossing)
  assert.equal(bounds[1][0] - bounds[0][0], 2)
  const mask = outsideAreaMask(crossing)
  assert.equal(contains(mask, [179.5, -17]), false)
  assert.equal(contains(mask, [-179.5, -17]), false)
  assert.equal(contains(mask, [0, -17]), true)
  assert.equal(wrappedArea(crossing).coordinates.length, 2)
})

test('the outside mask preserves detached parts and treats interior holes as outside', () => {
  const geometry: MultiPolygon = {
    type: 'MultiPolygon',
    coordinates: [
      [
        [
          [10, 10],
          [20, 10],
          [20, 20],
          [10, 20],
          [10, 10],
        ],
        [
          [12, 12],
          [12, 14],
          [14, 14],
          [14, 12],
          [12, 12],
        ],
      ],
      [
        [
          [40, 10],
          [42, 10],
          [42, 12],
          [40, 12],
          [40, 10],
        ],
      ],
    ],
  }
  const original = structuredClone(geometry)
  const mask = outsideAreaMask(geometry)
  assert.equal(contains(mask, [11, 11]), false)
  assert.equal(contains(mask, [13, 13]), true)
  assert.equal(contains(mask, [41, 11]), false)
  assert.equal(contains(mask, [35, 15]), true)
  assert.deepEqual(geometry, original)
})

test('drawn geometry rejects empty, zero-area, overlapping and crossing boundaries', () => {
  assert.ok(validateDrawnArea(null))
  assert.ok(
    validateDrawnArea(
      polygon([
        [0, 0],
        [1, 1],
        [0, 0],
      ]),
    ),
  )
  assert.ok(
    validateDrawnArea(
      polygon([
        [0, 0],
        [1, 0],
        [2, 0],
        [0, 0],
      ]),
    ),
  )
  assert.match(
    validateDrawnArea(
      polygon([
        [0, 0],
        [2, 2],
        [0, 2],
        [2, 0],
        [0, 0],
      ]),
    )!,
    /crosses/,
  )
  assert.ok(
    validateDrawnArea(
      polygon([
        [0, 0],
        [2, 0],
        [2, 0],
        [2, 2],
        [0, 0],
      ]),
    ),
  )
  assert.equal(validateDrawnArea(crossing), null)
  assert.equal(
    validateDrawnArea(
      polygon([
        [0, 0],
        [2, 0],
        [2, 2],
        [0, 2],
        [0, 0],
      ]),
    ),
    null,
  )
})

test('custom coordinates remain at drawing precision so they can be reopened for editing', () => {
  const area = drawnArea(
    polygon([
      [7.123456789, 43],
      [8.123456789, 43],
      [8.123456789, 44],
      [7.123456789, 43],
    ]),
    'polygon',
    'stable-id',
  )
  assert.equal(area.id, 'stable-id')
  assert.equal(area.geometry.coordinates[0][0][0], 7.123456789)
  assert.equal(validateDrawnArea(area.geometry), null)
})

test('the existing island, small-country and antimeridian boundary records render without losing source geometry', () => {
  const records = JSON.parse(
    readFileSync(new URL('../public/map-data/country-lookup.json', import.meta.url), 'utf8'),
  ) as { name: string; polygons: number[][][][] }[]
  for (const name of ['Poland', 'Indonesia', 'Monaco', 'Fiji', 'South Africa']) {
    const source = records.find((record) => record.name === name)!
    assert.ok(source, name)
    const geometry: MultiPolygon = {
      type: 'MultiPolygon',
      coordinates: structuredClone(source.polygons),
    }
    assert.ok(outsideAreaMask(geometry).coordinates.length, name)
    assert.deepEqual(geometry.coordinates, source.polygons, name)
    if (name === 'Fiji') assert.ok(areaBounds(geometry)[1][0] - areaBounds(geometry)[0][0] < 10)
  }
})
