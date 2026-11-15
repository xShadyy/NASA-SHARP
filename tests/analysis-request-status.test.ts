import assert from 'node:assert/strict'
import test from 'node:test'
import {
  analysisRequestStatus,
  formatAnalysisRetrieval,
  missingActivityDescription,
} from '../src/lib/analysis-request-status'

const ready = {
  hasArea: true,
  invalid: false,
  failed: false,
  loading: false,
  stale: false,
  completeness: 'complete',
}

test('failed requests never appear loading or as successful zero activity', () => {
  assert.equal(analysisRequestStatus({ ...ready, failed: true, loading: true }), 'error')
  assert.equal(missingActivityDescription('error'), 'Activity request failed')
  assert.equal(missingActivityDescription('unavailable'), 'Activity unavailable')
  assert.equal(missingActivityDescription('loading'), 'Loading activity')
})

test('retrieval metadata is explicit UTC or unavailable, never an invalid local date', () => {
  assert.equal(formatAnalysisRetrieval(null), 'unavailable')
  assert.equal(formatAnalysisRetrieval('not-a-date'), 'unavailable')
  assert.match(formatAnalysisRetrieval('2026-11-15T13:00:00Z'), /15\/11\/2026, 13:00:00 UTC/)
})

test('idle, successful empty, missing coverage, and expired partial coverage stay distinct', () => {
  assert.equal(analysisRequestStatus({ ...ready, hasArea: false }), 'idle')
  assert.equal(analysisRequestStatus(ready), 'ready')
  assert.equal(analysisRequestStatus({ ...ready, completeness: 'unavailable' }), 'unavailable')
  assert.equal(analysisRequestStatus({ ...ready, completeness: 'partial' }), 'partial')
  assert.equal(analysisRequestStatus({ ...ready, completeness: 'partial', stale: true }), 'stale')
  assert.equal(analysisRequestStatus({ ...ready, invalid: true }), 'error')
})
