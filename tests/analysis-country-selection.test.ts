import assert from 'node:assert/strict'
import test from 'node:test'
import type { AnalysisArea } from '../src/lib/analysis-area'
import { drawnArea } from '../src/lib/analysis-area'
import { createCountrySelectionRequest } from '../src/lib/analysis-country-selection'
import { analysisReducer, initialAnalysisState } from '../src/lib/analysis-state'

function area(id: string): AnalysisArea {
  return drawnArea(
    {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ],
    },
    'polygon',
    id,
  )
}

function deferred() {
  let resolve!: (value: AnalysisArea) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<AnalysisArea>((success, failure) => {
    resolve = success
    reject = failure
  })
  return { promise, resolve, reject }
}

test('rapid country switching aborts the old request and ignores its late result', async () => {
  const first = deferred()
  const second = deferred()
  const signals: AbortSignal[] = []
  const selected: string[] = []
  const request = createCountrySelectionRequest({
    resolve: (country, signal) => {
      signals.push(signal)
      return country.id === 'country:POL' ? first.promise : second.promise
    },
    onLoading() {},
    onResolved: (value) => selected.push(value.id),
    onFailure: (error) => assert.fail(error),
  })
  const old = request.select({ id: 'country:POL', name: 'Poland' })
  const current = request.select({ id: 'country:IDN', name: 'Indonesia' })
  assert.equal(signals[0].aborted, true)
  assert.equal(signals[1].aborted, false)
  second.resolve(area('indonesia'))
  await current
  first.resolve(area('poland'))
  await old
  assert.deepEqual(selected, ['indonesia'])
  request.destroy()
})

test('a failed country replacement keeps the confirmed AOI and reports the latest failure', async () => {
  const original = area('confirmed')
  let state = analysisReducer(
    analysisReducer(initialAnalysisState, { type: 'preview', area: original }),
    { type: 'confirm' },
  )
  const pending = deferred()
  const request = createCountrySelectionRequest({
    resolve: () => pending.promise,
    onLoading: (country) => {
      state = analysisReducer(state, { type: 'country-loading', country })
    },
    onResolved: (value) => {
      state = analysisReducer(state, { type: 'preview', area: value })
    },
    onFailure: (error) => {
      state = analysisReducer(state, { type: 'country-failure', error })
    },
  })
  const replacement = request.select({ id: 'country:FRA', name: 'France' })
  assert.equal(state.confirmed, original)
  assert.equal(state.phase, 'loading')
  pending.reject(new Error('Boundary fetch failed'))
  await replacement
  assert.equal(state.confirmed, original)
  assert.equal(state.draft, null)
  assert.equal(state.phase, 'idle')
  assert.equal(state.error, 'Boundary fetch failed')
  request.destroy()
})

test('canceling and clearing during loading prevent an uncooperative late response from restoring an AOI', async () => {
  const pending = deferred()
  let state = initialAnalysisState
  let signal: AbortSignal | undefined
  const request = createCountrySelectionRequest({
    resolve: (_, current) => {
      signal = current
      return pending.promise
    },
    onLoading: (country) => {
      state = analysisReducer(state, { type: 'country-loading', country })
    },
    onResolved: (value) => {
      state = analysisReducer(state, { type: 'preview', area: value })
    },
    onFailure: (error) => assert.fail(error),
  })
  const loading = request.select({ id: 'country:FJI', name: 'Fiji' })
  request.cancel()
  state = analysisReducer(state, { type: 'clear' })
  assert.equal(signal?.aborted, true)
  pending.resolve(area('fiji'))
  await loading
  assert.equal(state.confirmed, null)
  assert.equal(state.draft, null)
  assert.equal(state.phase, 'idle')
  request.destroy()
})

test('a canceled request failure remains silent and the next selection can succeed', async () => {
  const old = deferred()
  const selected: string[] = []
  let calls = 0
  const request = createCountrySelectionRequest({
    resolve: () => (calls++ === 0 ? old.promise : Promise.resolve(area('monaco'))),
    onLoading() {},
    onResolved: (value) => selected.push(value.id),
    onFailure: (error) => assert.fail(error),
  })
  const canceled = request.select({ id: 'country:POL', name: 'Poland' })
  request.cancel()
  old.reject(new Error('Canceled fetch'))
  await canceled
  await request.select({ id: 'country:MCO', name: 'Monaco' })
  assert.deepEqual(selected, ['monaco'])
  request.destroy()
})

test('destroying the workflow aborts loading and prevents subsequent selection callbacks', async () => {
  const pending = deferred()
  let loads = 0
  let signal: AbortSignal | undefined
  const request = createCountrySelectionRequest({
    resolve: (_, current) => {
      signal = current
      return pending.promise
    },
    onLoading: () => {
      loads++
    },
    onResolved: () => assert.fail('A destroyed request cannot resolve'),
    onFailure: (error) => assert.fail(error),
  })
  const loading = request.select({ id: 'country:POL', name: 'Poland' })
  request.destroy()
  assert.equal(signal?.aborted, true)
  pending.resolve(area('poland'))
  await loading
  await request.select({ id: 'country:FRA', name: 'France' })
  assert.equal(loads, 1)
})
