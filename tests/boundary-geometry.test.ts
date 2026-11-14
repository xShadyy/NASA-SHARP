import assert from 'node:assert/strict'
import test from 'node:test'
import type { MultiPolygon, Polygon, Position } from 'geojson'
import { countryFocusBounds } from '../src/lib/analysis-area'
import { prepareCountryDisplayGeometry } from '../src/map/analysis-geometry'

function circle(longitude: number, latitude: number, radius: number, vertices: number) {
  const ring: Position[] = []
  for (let index = 0; index < vertices; index++) {
    const angle = (index / vertices) * Math.PI * 2
    ring.push([longitude + radius * Math.cos(angle), latitude + radius * Math.sin(angle)])
  }
  ring.push([...ring[0]])
  return ring
}

function contains(geometry: MultiPolygon, point: Position) {
  const inRing = (ring: Position[]) => {
    let inside = false
    for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
      const [x, y] = ring[index]
      const [a, b] = ring[previous]
      if (y > point[1] !== b > point[1] && point[0] < ((a - x) * (point[1] - y)) / (b - y) + x)
        inside = !inside
    }
    return inside
  }
  return geometry.coordinates.some((rings) => inRing(rings[0]) && !rings.slice(1).some(inRing))
}

test('country preparation reduces display vertices while retaining exact source geometry, islands and holes', () => {
  const source: MultiPolygon = {
    type: 'MultiPolygon',
    coordinates: [
      [circle(5, 52, 2, 10_000), circle(5, 52, 0.2, 1_000)],
      [
        [
          [12.123456789, -5],
          [13, -5],
          [13, -4],
          [12.123456789, -5],
        ],
      ],
    ],
  }
  const original = structuredClone(source)
  const prepared = prepareCountryDisplayGeometry(source)
  assert.deepEqual(source, original)
  assert.equal(prepared.displayGeometry.type, 'MultiPolygon')
  const display = prepared.displayGeometry as MultiPolygon
  assert.equal(display.coordinates.length, 2)
  assert.equal(display.coordinates[0].length, 2)
  assert.ok(display.coordinates[0][0].length < source.coordinates[0][0].length / 4)
  assert.deepEqual(display.coordinates[1], source.coordinates[1])
  assert.ok(prepared.displayMask)
  assert.equal(contains(prepared.displayMask, [5, 53]), false)
  assert.equal(contains(prepared.displayMask, [5, 52]), true)
  assert.equal(contains(prepared.displayMask, [12.8, -4.8]), false)
  assert.equal(contains(prepared.displayMask, [0, 0]), true)
})

test('single polygons and arbitrarily small interior holes retain their structures for display', () => {
  const source: Polygon = {
    type: 'Polygon',
    coordinates: [circle(7, 45, 0.01, 200), circle(7, 45, 0.0000001, 20)],
  }
  const prepared = prepareCountryDisplayGeometry(source)
  assert.equal(prepared.displayGeometry.type, 'Polygon')
  const display = prepared.displayGeometry as Polygon
  assert.equal(display.coordinates.length, 2)
  for (const ring of display.coordinates) {
    assert.ok(ring.length >= 4)
    assert.deepEqual(ring[0], ring.at(-1))
  }
})

test('the display boundary and outside mask agree across both sides of the antimeridian and holes', () => {
  const source: Polygon = {
    type: 'Polygon',
    coordinates: [
      [
        [179.7, -18],
        [-179.7, -18],
        [-179.7, -17],
        [179.7, -17],
        [179.7, -18],
      ],
      [
        [179.8, -17.8],
        [179.8, -17.4],
        [-179.8, -17.4],
        [-179.8, -17.8],
        [179.8, -17.8],
      ],
    ],
  }
  const original = structuredClone(source)
  const prepared = prepareCountryDisplayGeometry(source)
  assert.deepEqual(source, original)
  assert.equal(prepared.displayBoundary.coordinates.length, 2)
  assert.ok(prepared.displayMask)
  for (const longitude of [179.75, -179.75]) {
    assert.equal(contains(prepared.displayBoundary, [longitude, -17.5]), true)
    assert.equal(contains(prepared.displayMask, [longitude, -17.5]), false)
  }
  for (const longitude of [179.9, -179.9]) {
    assert.equal(contains(prepared.displayBoundary, [longitude, -17.5]), false)
    assert.equal(contains(prepared.displayMask, [longitude, -17.5]), true)
  }
  assert.equal(prepared.bounds[1][0] - prepared.bounds[0][0], 0.6000000000000227)
})

test('country fitting selects the largest main territory rather than remote smaller islands', () => {
  const source: MultiPolygon = {
    type: 'MultiPolygon',
    coordinates: [
      [
        [
          [-5, 42],
          [8, 42],
          [8, 51],
          [-5, 51],
          [-5, 42],
        ],
      ],
      [
        [
          [-55, 2],
          [-51, 2],
          [-51, 6],
          [-55, 6],
          [-55, 2],
        ],
      ],
      [
        [
          [9, 41.5],
          [9.5, 41.5],
          [9.5, 43],
          [9, 41.5],
        ],
      ],
    ],
  }
  const prepared = prepareCountryDisplayGeometry(source, [
    [-6, 41],
    [10, 52],
  ])
  assert.deepEqual(prepared.bounds, [
    [-5, 42],
    [8, 51],
  ])
  assert.ok(prepared.fullBounds[0][0] <= -55)
  assert.equal((prepared.displayGeometry as MultiPolygon).coordinates.length, 3)
})

test('archipelago fitting prioritizes the largest island and keeps all islands in the AOI', () => {
  const source: MultiPolygon = {
    type: 'MultiPolygon',
    coordinates: [
      [
        [
          [179, -18],
          [-179, -18],
          [-179, -16],
          [179, -16],
          [179, -18],
        ],
      ],
      [
        [
          [150, -25],
          [150.1, -25],
          [150.1, -24.9],
          [150, -25],
        ],
      ],
    ],
  }
  assert.deepEqual(countryFocusBounds(source), [
    [179, -18],
    [181, -16],
  ])
  assert.equal(source.coordinates.length, 2)
})
