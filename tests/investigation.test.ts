import assert from 'node:assert/strict'
import test from 'node:test'
import { createInvestigation } from '../src/lib/investigation'
import { analysisReducer, initialAnalysisState } from '../src/lib/analysis-state'
import type { AnalysisArea } from '../src/lib/analysis-area'

const area: AnalysisArea = {
  id: 'region',
  name: 'Regional AOI',
  type: 'rectangle',
  bounds: [
    [1, 2],
    [3, 4],
  ],
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [1, 2],
        [3, 2],
        [3, 4],
        [1, 4],
        [1, 2],
      ],
    ],
  },
}

test('investigation transfer freezes exact geometry historical UTC interval and independent observation filters', () => {
  const filters = { platform: 'aqua', frpMin: 10 }
  const scope = createInvestigation(
    area,
    { start: '2016-02-28', end: '2016-02-29' },
    { datasetVersion: 'v1', queryId: 'query' },
    '2016-02-29',
    filters,
    { selectionToken: 'frozen', sourceGeneration: 'generation' },
  )
  assert.equal(scope.query.interval.start, '2016-02-28T00:00:00.000Z')
  assert.equal(scope.query.interval.endExclusive, '2016-03-01T00:00:00.000Z')
  assert.equal(scope.method, 'afternoon-active-cells-2km-1')
  assert.equal(scope.query.filters.platforms.length, 4)
  assert.equal(scope.query.processingMode, 'harmonized')
  filters.frpMin = 500
  assert.equal(scope.filters.frpMin, 10)
  scope.area.name = 'Explored separately'
  assert.equal(area.name, 'Regional AOI')
  assert.deepEqual(JSON.parse(JSON.stringify(scope)), scope)
})

test('explicit Apply to map changes confirmed AOI while preserving unfinished draft state and camera fit request', () => {
  const draft = { ...area, id: 'unfinished' }
  const state = {
    ...initialAnalysisState,
    confirmed: area,
    draft,
    phase: 'editing' as const,
    tool: 'rectangle' as const,
    vertices: 4,
    fitRequest: 8,
    drawRequest: 3,
  }
  const replacement = { ...area, id: 'explored' }
  const next = analysisReducer(state, { type: 'apply-investigation', area: replacement })
  assert.equal(next.confirmed, replacement)
  assert.equal(next.draft, draft)
  assert.equal(next.phase, 'editing')
  assert.equal(next.fitRequest, 8)
  assert.equal(next.drawRequest, 3)
})

test('rolling 24-hour transfer preserves exact UTC instants rather than whole-day substitution', () => {
  const scope = createInvestigation(area, {
    start: '2026-11-14',
    end: '2026-11-15',
    startAt: '2026-11-14T13:45:00.000Z',
    endAt: '2026-11-15T13:45:00.000Z',
    preset: '24h',
  })
  assert.equal(scope.query.interval.start, '2026-11-14T13:45:00.000Z')
  assert.equal(scope.query.interval.endExclusive, '2026-11-15T13:45:00.000Z')
})
