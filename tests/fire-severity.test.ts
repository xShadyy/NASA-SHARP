import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyFire, fireMapFeatures, firePixelFeatures } from '../src/lib/fire-severity'
import { geodesicDistanceKm } from '../src/lib/geodesy'

test('fire pixels preserve sensor dimensions and stay local across the dateline', () => {
  const features = fireMapFeatures({ data: { data: { features: [point(22, 'pixel')] } } })
  features[0].geometry.coordinates = [179.9999, 70]
  const nominal = firePixelFeatures(features)[0].geometry.coordinates[0]
  assert.ok(
    Math.abs(
      geodesicDistanceKm(nominal[0] as [number, number], nominal[1] as [number, number]) - 0.375,
    ) < 0.0001,
  )
  assert.ok(Math.max(...nominal.map((p) => p[0])) - Math.min(...nominal.map((p) => p[0])) < 0.1)
  features[0].properties.scanKm = 0.7
  features[0].properties.trackKm = 0.5
  const measured = firePixelFeatures(features)[0].geometry.coordinates[0]
  assert.ok(
    Math.abs(
      geodesicDistanceKm(measured[0] as [number, number], measured[1] as [number, number]) - 0.7,
    ) < 0.0001,
  )
  assert.ok(
    Math.abs(
      geodesicDistanceKm(measured[1] as [number, number], measured[2] as [number, number]) - 0.5,
    ) < 0.0001,
  )
  assert.deepEqual(measured[0], measured.at(-1))
})

test('fire radiative power maps to yellow, orange, and red severity', () => {
  assert.equal(classifyFire(null), 'unknown')
  assert.equal(classifyFire(undefined), 'unknown')
  assert.equal(classifyFire(Number.NaN), 'unknown')
  assert.equal(classifyFire(Infinity), 'unknown')
  assert.equal(classifyFire(-Infinity), 'unknown')
  assert.equal(classifyFire(-1), 'unknown')
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

test('map parser retains stable canonical IDs, coordinates, and observation metadata', () => {
  const sample = {
    ...point(12, 'canonical-id'),
    properties: {
      ...point(12, '').properties,
      confidence: { kind: 'numeric', value: 87 },
      dayNight: 'night',
      productVersion: 'C6.1',
      processingTier: 'standard',
      provenance: 'NASA FIRMS',
      scanKm: 0.44,
      trackKm: 0.65,
    },
  }
  const parsed = fireMapFeatures({ data: { data: { features: [sample] } } })[0]
  assert.equal(parsed.id, 'canonical-id')
  assert.equal(parsed.properties.id, 'canonical-id')
  assert.deepEqual(parsed.geometry.coordinates, sample.geometry.coordinates)
  assert.deepEqual(parsed.properties.confidence, { kind: 'numeric', value: 87 })
  assert.equal(parsed.properties.provenance, 'NASA FIRMS')
  assert.equal(parsed.properties.productVersion, 'C6.1')
  assert.equal(parsed.properties.utcDay, '2026-11-14')
  assert.equal(parsed.properties.acquiredEpoch, Date.parse('2026-11-14T12:30:00Z'))
})

test('unknown sensor resolution never fabricates footprint dimensions or FRP values', () => {
  const sample = point(Infinity, 'unknown-dimensions')
  sample.properties.sensor = ''
  sample.properties.platform = ''
  const parsed = fireMapFeatures({ data: { data: { features: [sample] } } })[0]
  assert.equal(parsed.properties.frpMw, null)
  assert.equal(parsed.properties.severity, 'unknown')
  assert.equal(firePixelFeatures([parsed]).length, 0)
  parsed.properties.scanKm = 0.8
  assert.equal(firePixelFeatures([parsed]).length, 0)
  parsed.properties.trackKm = 0.5
  assert.equal(firePixelFeatures([parsed]).length, 1)
})

test('reported nominal resolution overrides instrument defaults for approximate footprints', () => {
  const parsed = fireMapFeatures({ data: { data: { features: [point(15, 'nominal')] } } })[0]
  parsed.properties.nominalResolutionM = 750
  const ring = firePixelFeatures([parsed])[0].geometry.coordinates[0]
  assert.ok(
    Math.abs(geodesicDistanceKm(ring[0] as [number, number], ring[1] as [number, number]) - 0.75) <
      0.0001,
  )
})
