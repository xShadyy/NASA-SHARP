import assert from 'node:assert/strict'
import test from 'node:test'
import type { MultiPolygon, Polygon, Position } from 'geojson'
import Point from '@mapbox/point-geometry'
import { GeoJSONVT } from '@maplibre/geojson-vt'
import { classifyRings } from '@maplibre/maplibre-gl-style-spec'
import {
  NORTH_POLE_Y,
  SOUTH_POLE_Y,
  subdividePolygon,
} from '../node_modules/maplibre-gl/src/render/subdivision'
import { outsideAreaMask } from '../src/lib/analysis-area'

const country: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [14, 49],
      [24, 49],
      [24, 55],
      [14, 55],
      [14, 49],
    ],
  ],
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

function tilePosition([longitude, latitude]: Position) {
  const sine = Math.sin((latitude * Math.PI) / 180)
  return [
    ((longitude + 180) / 360) * 8192,
    (0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)) * 8192,
  ]
}

function triangleContains(vertices: number[], indices: number[], point: number[]) {
  const turn = (a: number[], b: number[], c: number[]) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
  const vertex = (index: number) => vertices.slice(index * 2, index * 2 + 2)
  for (let index = 0; index < indices.length; index += 3) {
    const a = vertex(indices[index])
    const b = vertex(indices[index + 1])
    const c = vertex(indices[index + 2])
    const values = [turn(a, b, point), turn(b, c, point), turn(c, a, point)]
    if (values.every((value) => value >= 0) || values.every((value) => value <= 0)) return true
  }
  return false
}

test('the geographic mask grays all world regions while preserving the country and its interior holes', () => {
  const geometry: Polygon = {
    type: 'Polygon',
    coordinates: [
      country.coordinates[0],
      [
        [18, 51],
        [18, 53],
        [20, 53],
        [20, 51],
        [18, 51],
      ],
    ],
  }
  const mask = outsideAreaMask(geometry)
  for (const longitude of [-150, -90, -30, 30, 90, 150]) {
    for (const latitude of [-75, -45, -15, 15, 45, 75])
      assert.equal(contains(mask, [longitude, latitude]), true)
  }
  assert.equal(contains(mask, [15, 50]), false)
  assert.equal(contains(mask, [19, 52]), true)
  assert.equal(contains(mask, [0, 89]), true)
  assert.equal(contains(mask, [0, -89]), true)
})

test('globe mask parts use closed local geographic cells rather than a globe-spanning outer polygon', () => {
  const geometry: Polygon = {
    type: 'Polygon',
    coordinates: [
      [
        [179, -18],
        [-179, -18],
        [-179, -16],
        [179, -16],
        [179, -18],
      ],
    ],
  }
  const mask = outsideAreaMask(geometry)
  assert.equal(contains(mask, [179.5, -17]), false)
  assert.equal(contains(mask, [-179.5, -17]), false)
  assert.equal(contains(mask, [178, -17]), true)
  assert.equal(contains(mask, [-178, -17]), true)
  for (const polygon of mask.coordinates) {
    const longitude = polygon[0].map(([value]) => value)
    const latitude = polygon[0].map(([, value]) => value)
    assert.ok(Math.max(...longitude) - Math.min(...longitude) <= 60)
    assert.ok(Math.max(...latitude) - Math.min(...latitude) <= 30)
    for (const ring of polygon) {
      assert.ok(ring.length >= 4)
      assert.deepEqual(ring[0], ring.at(-1))
      for (const [lng, lat] of ring) {
        assert.ok(Number.isFinite(lng) && Number.isFinite(lat))
        assert.ok(Math.abs(lng) <= 180 && Math.abs(lat) <= 90)
      }
    }
  }
})

test('the installed MapLibre globe tessellator retains the AOI cutout and extends the mask to both poles', () => {
  const mask = outsideAreaMask(country)
  const tiles = new GeoJSONVT(
    { type: 'Feature', properties: {}, geometry: mask },
    { extent: 8192, buffer: 2048, tolerance: 0, maxZoom: 4 },
  )
  const tile = tiles.getTile(0, 0, 0)
  assert.ok(tile)
  let north = false
  let south = false
  let coversCountry = false
  let coversOutside = false
  let triangles = 0
  for (const feature of tile.features) {
    assert.equal(feature.type, 3)
    const rings = (feature.geometry as number[][][]).map((ring) =>
      ring.map(([x, y]) => new Point(x, y)),
    )
    for (const polygon of classifyRings(rings, 500)) {
      const mesh = subdividePolygon(polygon, { z: 0, x: 0, y: 0 } as never, 8, false)
      assert.ok(mesh.verticesFlattened.every(Number.isFinite))
      triangles += mesh.indicesTriangles.length / 3
      for (let index = 1; index < mesh.verticesFlattened.length; index += 2) {
        north ||= mesh.verticesFlattened[index] === NORTH_POLE_Y
        south ||= mesh.verticesFlattened[index] === SOUTH_POLE_Y
      }
      for (const index of mesh.indicesTriangles) {
        assert.ok(index >= 0 && index < mesh.verticesFlattened.length / 2)
        assert.ok(mesh.verticesFlattened[index * 2] >= 0)
        assert.ok(mesh.verticesFlattened[index * 2] <= 8192)
      }
      coversCountry ||= triangleContains(
        mesh.verticesFlattened,
        mesh.indicesTriangles,
        tilePosition([19, 52]),
      )
      coversOutside ||= triangleContains(
        mesh.verticesFlattened,
        mesh.indicesTriangles,
        tilePosition([0, 0]),
      )
    }
  }
  assert.ok(triangles > 0)
  assert.equal(north, true)
  assert.equal(south, true)
  assert.equal(coversCountry, false)
  assert.equal(coversOutside, true)
})
