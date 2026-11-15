import assert from 'node:assert/strict'
import test from 'node:test'
import {
  GLOBAL_STARTUP_TIMEOUT_MS,
  mergeGlobalStartupState,
  type GlobalStartupState,
} from '../src/lib/global-startup'

const pending = (phase: GlobalStartupState['phase']): GlobalStartupState => ({
  ready: false,
  phase,
  error: '',
})

test('the startup watchdog has a bounded 30-second retry deadline', () => {
  assert.equal(GLOBAL_STARTUP_TIMEOUT_MS, 30_000)
})

test('manifest polling and tile progress cannot erase the startup timeout error', () => {
  let state: GlobalStartupState = {
    ...pending('rendering'),
    error: 'Loading the last 24 hours is taking longer than expected.',
  }
  const timeoutError = state.error
  for (const phase of ['rendering', 'fetching', 'rendering'] as const) {
    state = mergeGlobalStartupState(state, pending(phase))
    assert.equal(state.ready, false)
    assert.equal(state.error, timeoutError)
  }
})

test('a later source failure replaces the timeout with its actionable error', () => {
  const timeout = { ...pending('rendering'), error: 'Loading took too long.' }
  const sourceFailure = { ...pending('fetching'), error: 'The hotspot snapshot expired. Retry.' }
  const state = mergeGlobalStartupState(timeout, sourceFailure)
  assert.equal(state.error, sourceFailure.error)
  assert.equal(state.phase, 'fetching')
  assert.equal(mergeGlobalStartupState(state, pending('rendering')).error, sourceFailure.error)
})

test('a completed observation frame recovers an error and readiness stays latched', () => {
  const failure = { ...pending('rendering'), error: 'Loading took too long.' }
  const ready: GlobalStartupState = { ready: true, phase: 'rendering', error: '' }
  const entered = mergeGlobalStartupState(failure, ready)
  assert.deepEqual(entered, ready)
  assert.equal(mergeGlobalStartupState(entered, pending('fetching')), entered)
  assert.equal(
    mergeGlobalStartupState(entered, { ...pending('rendering'), error: 'Later tile failed.' }),
    entered,
  )
})

test('an explicit retry starts a clean attempt while ordinary progress retains any failure', () => {
  const failure = { ...pending('fetching'), error: 'The service is unavailable.' }
  assert.equal(mergeGlobalStartupState(failure, pending('fetching')), failure)
  
  const reset = pending('fetching')
  const retryProgress = mergeGlobalStartupState(reset, pending('rendering'))
  assert.deepEqual(retryProgress, pending('rendering'))
  assert.equal(failure.error, 'The service is unavailable.')
})

test('identical progress retains its reference to avoid redundant state updates', () => {
  const state = pending('rendering')
  assert.equal(mergeGlobalStartupState(state, { ...state }), state)
})
