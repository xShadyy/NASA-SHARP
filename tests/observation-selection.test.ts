import assert from 'node:assert/strict'
import test from 'node:test'
import {
  emptyObservationFilters,
  matchesObservationFilters,
  observationGroup,
  queryObservationSelection,
} from '../src/lib/observation-selection'
import type { FireFeature } from '../src/lib/fire-severity'

function observation(index: number, overrides: Record<string, unknown> = {}): FireFeature {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [10, 20] },
    properties: {
      id: String(index).padStart(5, '0'),
      longitude: 10,
      latitude: 20,
      acquiredAt: '2026-11-14T13:00:00Z',
      acquiredEpoch: Date.parse('2026-11-14T13:00:00Z'),
      utcDay: '2026-11-14',
      sensor: 'VIIRS',
      platform: 'noaa-20',
      severity: 'low',
      frpMw: index,
      ...overrides,
    },
  }
}

test('frozen group search sees all membership beyond the old 500 record sample', () => {
  const members = Array.from({ length: 1001 }, (_, index) => observation(index))
  const query = { ...emptyObservationFilters(), search: '01000' }
  const result = queryObservationSelection(members, query)
  assert.equal(result.matching.length, 1)
  assert.equal(result.matching[0].properties.id, '01000')
  assert.equal(members.length, 1001)
})

test('global sorting and native filters precede pagination with deterministic ID ties', () => {
  const members = Array.from({ length: 100 }, (_, index) => observation(99 - index))
  const ordered = queryObservationSelection(members, emptyObservationFilters()).matching
  assert.equal(ordered[0].properties.id, '00000')
  assert.equal(ordered.slice(10, 20)[0].properties.id, '00010')
  const highest = queryObservationSelection(members, {
    ...emptyObservationFilters(),
    sort: 'frp',
    frpMin: '90',
  }).matching
  assert.equal(highest.length, 10)
  assert.equal(highest[0].properties.frpMw, 99)
  const missing = observation(101, { frpMw: null, dayNight: null, confidence: null })
  assert.equal(
    queryObservationSelection([missing], { ...emptyObservationFilters(), dayNight: 'unknown' })
      .matching.length,
    1,
  )
  assert.equal(
    queryObservationSelection([missing], { ...emptyObservationFilters(), frpMin: '0' }).matching
      .length,
    0,
  )
  assert.equal(
    matchesObservationFilters(missing, { frpUnknown: true, viirsConfidence: ['unknown'] }),
    true,
  )
})

test('hour groups retain UTC date and counts across pages', () => {
  const first = observation(1)
  const second = observation(2, {
    acquiredAt: '2026-11-15T13:00:00Z',
    acquiredEpoch: Date.parse('2026-11-15T13:00:00Z'),
    utcDay: '2026-11-15',
  })
  const result = queryObservationSelection([second, first], {
    ...emptyObservationFilters(),
    groupBy: 'hour',
  })
  assert.equal(result.counts.size, 2)
  assert.equal(observationGroup(first, 'hour'), '2026-11-14, 13:00–13:59 UTC')
  assert.equal(result.counts.get('2026-11-15, 13:00–13:59 UTC'), 1)
})

test('native MODIS numeric confidence is distinct from VIIRS classes and UTC end is exclusive', () => {
  const modis = observation(1, { sensor: 'MODIS', confidence: { kind: 'numeric', value: 85 } })
  const viirs = observation(2, { confidence: { kind: 'class', value: 'high' } })
  assert.equal(matchesObservationFilters(modis, { modisConfidenceMin: 80 }), true)
  assert.equal(matchesObservationFilters(viirs, { modisConfidenceMin: 80 }), false)
  assert.equal(matchesObservationFilters(viirs, { viirsConfidence: ['high'] }), true)
  assert.equal(matchesObservationFilters(modis, { viirsConfidence: ['high'] }), false)
  assert.equal(
    matchesObservationFilters(viirs, { acquiredEndExclusive: '2026-11-14T13:00:00Z' }),
    false,
  )
  assert.equal(matchesObservationFilters(viirs, { acquiredStart: '2026-11-14T13:00:00Z' }), true)
})
