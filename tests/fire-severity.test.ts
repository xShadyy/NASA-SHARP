import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyFire, fireMapFeatures } from '../src/lib/fire-severity'

test('fire radiative power maps to yellow, orange, and red severity', () => {
  assert.equal(classifyFire(null), 'low')
  assert.equal(classifyFire(undefined), 'low')
  assert.equal(classifyFire(0), 'low')
  assert.equal(classifyFire(9.9), 'low')
  assert.equal(classifyFire(10), 'moderate')
  assert.equal(classifyFire(49.9), 'moderate')
  assert.equal(classifyFire(50), 'high')
  assert.equal(classifyFire(240), 'high')
})

test('map detections keep coordinates and severity', () => {
  const features = fireMapFeatures({
    data: {
      data: {
        type: 'FeatureCollection',
        features: [
          point(120, 'high-fire'),
          point(4, 'low-fire'),
          point(22, 'mid-fire'),
          { type: 'Feature', geometry: { type: 'Polygon', coordinates: [] }, properties: {} },
        ],
      },
    },
  })
  assert.deepEqual(
    features.map((feature) => [feature.properties.severity, feature.properties.frpMw]),
    [
      ['low', 4],
      ['moderate', 22],
      ['high', 120],
    ],
  )
  assert.deepEqual(features[2].geometry.coordinates, [10, 20])
})

function point(frpMw: number, id: string) {
  return {
    type: 'Feature',
    id,
    geometry: { type: 'Point', coordinates: [10, 20] },
    properties: {
      frpMw,
      acquiredAt: '2026-11-14T12:30:00Z',
      platform: 'noaa-20',
      sensor: 'VIIRS',
    },
  }
}
