import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { useAnalysisCountrySelection } from '../src/hooks/use-analysis-country-selection'
import { drawnArea } from '../src/lib/analysis-area'
import {
  analysisReducer,
  initialAnalysisState,
  type AnalysisAction,
  type AnalysisState,
} from '../src/lib/analysis-state'

function shape(tool: 'polygon' | 'rectangle', id: string, offset = 0) {
  return drawnArea(
    {
      type: 'Polygon',
      coordinates: [
        tool === 'polygon'
          ? [
              [offset, 0],
              [offset + 2, 0],
              [offset + 1, 2],
              [offset, 0],
            ]
          : [
              [offset, 0],
              [offset + 2, 0],
              [offset + 2, 2],
              [offset, 2],
              [offset, 0],
            ],
      ],
    },
    tool,
    id,
  )
}

function editingCommands(initial: AnalysisState) {
  let state = initial
  let country!: ReturnType<typeof useAnalysisCountrySelection>
  const actions: AnalysisAction[] = []
  function dispatch(action: AnalysisAction) {
    actions.push(action)
    state = analysisReducer(state, action)
  }
  function Harness() {
    country = useAnalysisCountrySelection(false, state, dispatch)
    return null
  }
  renderToStaticMarkup(createElement(Harness))
  return {
    state: () => state,
    actions,
    edit() {
      country.stopPicking()
      dispatch({ type: 'edit' })
    },
    cancel: () => dispatch({ type: 'cancel' }),
  }
}

for (const tool of ['polygon', 'rectangle'] as const) {
  test(`Edit area preserves an unconfirmed ${tool} and opens its editable copy`, () => {
    const area = shape(tool, `draft-${tool}`)
    const state = analysisReducer(initialAnalysisState, { type: 'preview', area })
    const commands = editingCommands(state)
    commands.edit()
    const editing = commands.state()
    assert.deepEqual(commands.actions, [{ type: 'edit' }])
    assert.equal(editing.phase, 'editing')
    assert.equal(editing.tool, tool)
    assert.equal(editing.confirmed, null)
    assert.equal(editing.draft?.id, area.id)
    assert.deepEqual(editing.draft?.geometry, area.geometry)
    assert.notEqual(editing.draft?.geometry, area.geometry)
    assert.equal(editing.drawRequest, state.drawRequest + 1)
  })

  test(`Edit area uses the latest ${tool} draft instead of replacing it with the confirmed shape`, () => {
    const original = shape(tool, `confirmed-${tool}`)
    const draft = shape(tool, `replacement-${tool}`, 10)
    const confirmed = analysisReducer(
      analysisReducer(initialAnalysisState, { type: 'preview', area: original }),
      { type: 'confirm' },
    )
    const commands = editingCommands(analysisReducer(confirmed, { type: 'preview', area: draft }))
    commands.edit()
    assert.equal(commands.state().draft?.id, draft.id)
    assert.deepEqual(commands.state().draft?.geometry, draft.geometry)
    assert.equal(commands.state().confirmed, original)
    commands.cancel()
    assert.equal(commands.state().draft, null)
    assert.equal(commands.state().confirmed, original)
  })

  test(`a confirmed ${tool} can be edited without mutating its saved geometry`, () => {
    const area = shape(tool, `confirmed-${tool}`)
    const state = analysisReducer(
      analysisReducer(initialAnalysisState, { type: 'preview', area }),
      { type: 'confirm' },
    )
    const original = structuredClone(area.geometry)
    const commands = editingCommands(state)
    commands.edit()
    const editing = commands.state()
    assert.equal(editing.phase, 'editing')
    assert.equal(editing.tool, tool)
    assert.notEqual(editing.draft?.geometry, area.geometry)
    editing.draft!.geometry.coordinates[0][0][0] = 20
    assert.deepEqual(area.geometry, original)
    commands.cancel()
    assert.equal(commands.state().confirmed, area)
    assert.deepEqual(commands.state().confirmed?.geometry, original)
  })

  test(`editing a saved ${tool} clears obsolete pending country status`, () => {
    const area = shape(tool, `saved-${tool}`)
    const confirmed = analysisReducer(
      analysisReducer(initialAnalysisState, { type: 'preview', area }),
      { type: 'confirm' },
    )
    const pending = analysisReducer(confirmed, {
      type: 'country-loading',
      country: { id: 'country:POL', name: 'Poland' },
    })
    const commands = editingCommands(pending)
    commands.edit()
    assert.equal(commands.state().phase, 'editing')
    assert.equal(commands.state().pendingCountry, null)
    assert.equal(commands.state().draft?.id, area.id)
    assert.equal(commands.state().confirmed, area)
  })
}
