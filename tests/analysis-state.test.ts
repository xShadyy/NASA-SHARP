import assert from 'node:assert/strict'
import test from 'node:test'
import { drawnArea } from '../src/lib/analysis-area'
import { analysisReducer, initialAnalysisState } from '../src/lib/analysis-state'

const original = drawnArea(
  {
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [2, 0],
        [2, 2],
        [0, 0],
      ],
    ],
  },
  'polygon',
  'original',
)
const replacement = drawnArea(
  {
    type: 'Polygon',
    coordinates: [
      [
        [10, 10],
        [12, 10],
        [12, 12],
        [10, 10],
      ],
    ],
  },
  'rectangle',
  'replacement',
)

test('a preview does not replace the confirmed area until confirmation', () => {
  let state = analysisReducer(initialAnalysisState, { type: 'preview', area: original })
  assert.equal(state.confirmed, null)
  state = analysisReducer(state, { type: 'confirm' })
  state = analysisReducer(state, { type: 'preview', area: replacement })
  assert.equal(state.confirmed?.id, 'original')
  assert.equal(state.draft?.id, 'replacement')
  state = analysisReducer(state, { type: 'cancel' })
  assert.equal(state.confirmed?.id, 'original')
  assert.equal(state.draft, null)
})

test('editing works on a copy and cancel preserves the original geometry', () => {
  const confirmed = analysisReducer(
    analysisReducer(initialAnalysisState, { type: 'preview', area: original }),
    { type: 'confirm' },
  )
  const editing = analysisReducer(confirmed, { type: 'edit' })
  assert.notEqual(editing.draft?.geometry, confirmed.confirmed?.geometry)
  const changed = analysisReducer(editing, {
    type: 'drawing',
    area: replacement,
    error: null,
    vertices: 4,
  })
  assert.deepEqual(analysisReducer(changed, { type: 'cancel' }).confirmed, original)
})

test('an invalid drawing stays editable and cannot be confirmed', () => {
  let state = analysisReducer(initialAnalysisState, { type: 'draw', tool: 'polygon' })
  state = analysisReducer(state, {
    type: 'finish',
    area: original,
    error: 'The boundary crosses itself.',
  })
  assert.equal(state.phase, 'editing')
  state = analysisReducer(state, { type: 'confirm' })
  assert.equal(state.confirmed, null)
  state = analysisReducer(state, { type: 'drawing', area: original, error: null, vertices: 3 })
  state = analysisReducer(state, { type: 'confirm' })
  assert.equal(state.confirmed?.id, 'original')
})

test('clear removes both draft and confirmed areas and stops drawing', () => {
  const confirmed = analysisReducer(
    analysisReducer(initialAnalysisState, { type: 'preview', area: original }),
    { type: 'confirm' },
  )
  const cleared = analysisReducer(analysisReducer(confirmed, { type: 'draw', tool: 'rectangle' }), {
    type: 'clear',
  })
  assert.equal(cleared.confirmed, null)
  assert.equal(cleared.draft, null)
  assert.equal(cleared.phase, 'idle')
  assert.equal(cleared.tool, null)
})
