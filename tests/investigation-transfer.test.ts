import assert from 'node:assert/strict'
import test from 'node:test'
import { apiUrl, resolveApiBase } from '../src/lib/api-config'
import { drawnArea } from '../src/lib/analysis-area'
import { initialAnalysisState, analysisReducer } from '../src/lib/analysis-state'
import {
  createGlobalInvestigation,
  createInvestigation,
  investigationKey,
} from '../src/lib/investigation'

const area = drawnArea(
  {
    type: 'Polygon',
    coordinates: [
      [
        [10, 20],
        [11, 20],
        [11, 21],
        [10, 20],
      ],
    ],
  },
  'polygon',
  'old-area',
)

test('deployment-aware API URLs remap server links and preserve absolute external URLs', () => {
  assert.equal(
    resolveApiBase(' https://sharp.example/custom/api/// '),
    'https://sharp.example/custom/api',
  )
  for (const path of [
    '/analysis/observations',
    '/firms-api/analysis/observations',
    '/api/analysis/observations',
  ]) {
    assert.equal(apiUrl(path, '/custom/backend/'), '/custom/backend/analysis/observations')
  }
  assert.equal(
    apiUrl('/firms-api/global/tiles/immutable/24h/1/0/1.json', '/custom'),
    '/custom/global/tiles/immutable/24h/1/0/1.json',
  )
  assert.equal(apiUrl('https://other.example/data', '/custom'), 'https://other.example/data')
})

test('serializable handoff preserves historical scope and frozen observation membership independently', () => {
  const scope = createInvestigation(
    area,
    { start: '2019-02-01', end: '2019-02-28' },
    { sourceGeneration: 'archive-v1' },
    '2019-02-03',
    { sensor: 'VIIRS', frpUnknown: true },
    { selectionToken: 'frozen-one', sourceGeneration: 'archive-v1' },
  )
  const transferred = structuredClone(scope)
  transferred.filters.sensor = 'MODIS'
  assert.equal(scope.filters.sensor, 'VIIRS')
  assert.equal(transferred.query.interval.start, '2019-02-01T00:00:00.000Z')
  assert.equal(transferred.query.interval.endExclusive, '2019-03-01T00:00:00.000Z')
  assert.equal(transferred.method, 'afternoon-active-cells-2km-1')
  assert.equal(transferred.focusedDay, '2019-02-03')
  assert.equal(transferred.selection?.selectionToken, 'frozen-one')
  assert.notEqual(investigationKey(scope), investigationKey(transferred))
})

test('global handoff keeps immutable snapshot, hierarchy, and rolling interval exact', () => {
  const global = {
    snapshotId: 'snapshot1',
    window: '24h' as const,
    aggregateId: 'cell-filter-id',
    interval: { start: '2026-11-14T13:00:00Z', endExclusive: '2026-11-15T13:00:00Z' },
  }
  const scope = createGlobalInvestigation(global, { platform: 'noaa-20' })
  assert.equal(scope.range.startAt, global.interval.start)
  assert.equal(scope.range.endAt, global.interval.endExclusive)
  assert.deepEqual(scope.selection?.global, global)
  assert.equal(scope.selection?.sourceGeneration, 'snapshot1')
  assert.equal(scope.area.geometry.type, 'MultiPolygon')
  assert.equal(scope.query.interval.start, global.interval.start)
})

test('explicit analytics Apply preserves unfinished AOI edits and camera requests', () => {
  const replacement = { ...area, id: 'new-area' }
  const state = {
    ...initialAnalysisState,
    confirmed: area,
    draft: structuredClone(area),
    phase: 'editing' as const,
    tool: 'polygon' as const,
    vertices: 4,
    drawRequest: 3,
    fitRequest: 5,
  }
  const applied = analysisReducer(state, { type: 'apply-investigation', area: replacement })
  assert.equal(applied.confirmed, replacement)
  assert.equal(applied.draft, state.draft)
  assert.equal(applied.phase, 'editing')
  assert.equal(applied.drawRequest, 3)
  assert.equal(applied.fitRequest, 5)
  const global = analysisReducer(applied, { type: 'apply-investigation', area: null })
  assert.equal(global.confirmed, null)
  assert.equal(global.draft, state.draft)
})
