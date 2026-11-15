import assert from 'node:assert/strict'
import test from 'node:test'
import {
  recordFilterDelay,
  validateObservationFilters,
} from '../src/lib/observation-filter-validation'

test('FRP inclusive and exclusive bounds are validated before queries and exports', () => {
  assert.deepEqual(validateObservationFilters({ frpMin: 10, frpMax: 10 }), {})
  assert.match(validateObservationFilters({ frpMin: 20, frpMax: 10 }).frpMax!, /at least/)
  assert.match(
    validateObservationFilters({ frpMin: 10, frpMaxExclusive: 10 }).frpMaxExclusive!,
    /exceed/,
  )
  assert.ok(validateObservationFilters({ frpMin: -1 }).frpMin)
  assert.ok(validateObservationFilters({ frpMax: Infinity }).frpMax)
  assert.deepEqual(validateObservationFilters({ frpUnknown: true }), {})
})

test('native confidence constraints preserve the MODIS and VIIRS distinction', () => {
  assert.deepEqual(
    validateObservationFilters({ modisConfidenceMin: 0, modisConfidenceMax: 100 }),
    {},
  )
  assert.ok(validateObservationFilters({ modisConfidenceMin: 0.5 }).modisConfidenceMin)
  assert.ok(validateObservationFilters({ modisConfidenceMax: 101 }).modisConfidenceMax)
  assert.ok(
    validateObservationFilters({ modisConfidenceMin: 80, modisConfidenceMax: 70 })
      .modisConfidenceMax,
  )
  assert.deepEqual(validateObservationFilters({ viirsConfidence: ['low', 'nominal', 'high'] }), {})
  assert.deepEqual(validateObservationFilters({ viirsConfidence: ['unknown'] }), {})
  assert.ok(validateObservationFilters({ viirsConfidence: [] }).viirsConfidence)
  assert.ok(validateObservationFilters({ viirsConfidence: ['80'] }).viirsConfidence)
  assert.deepEqual(validateObservationFilters({ modisConfidenceUnknown: true }), {})
})

test('UTC acquisition filters enforce an exclusive end without shifting midnight', () => {
  assert.deepEqual(
    validateObservationFilters({
      acquiredStart: '2026-11-14T23:59:00Z',
      acquiredEndExclusive: '2026-11-15T00:00:00Z',
    }),
    {},
  )
  assert.ok(
    validateObservationFilters({
      acquiredStart: '2026-11-15T00:00:00Z',
      acquiredEndExclusive: '2026-11-15T00:00:00Z',
    }).acquiredEndExclusive,
  )
  assert.ok(
    validateObservationFilters({ acquiredStart: '2026-11-15T00:00:00+01:00' }).acquiredStart,
  )
  assert.ok(validateObservationFilters({ acquiredEndExclusive: 'invalid' }).acquiredEndExclusive)
  assert.ok(validateObservationFilters({ acquiredStart: '2026-02-30T00:00:00Z' }).acquiredStart)
})

test('search and product edits debounce while structured selections apply promptly', () => {
  assert.equal(recordFilterDelay({}, { search: 'NOAA' }), 300)
  assert.equal(recordFilterDelay({ search: 'NOAA' }, { search: '' }), 300)
  assert.equal(recordFilterDelay({}, { source: 'MODIS_SP' }), 300)
  assert.equal(recordFilterDelay({ search: 'NOAA' }, { search: 'NOAA', platform: 'noaa-20' }), 0)
})
