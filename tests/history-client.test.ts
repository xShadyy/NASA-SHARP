import assert from 'node:assert/strict'
import test from 'node:test'
import { createInvestigation } from '../src/lib/investigation'
import {
  readHistoricalSummary,
  readHistoricalPreparation,
  startHistoricalPreparation,
} from '../src/lib/history-client'

const scope = createInvestigation(
  {
    id: 'region',
    name: 'Selected region',
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
  },
  { start: '2024-02-01', end: '2024-02-29' },
)

test('reading stored history and polling progress never invoke preparation', async (context) => {
  const requests: Array<{ url: string; body: unknown }> = []
  context.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) })
      return new Response(JSON.stringify({ state: 'partial', active: false }), { status: 200 })
    },
  )
  const controller = new AbortController()
  await readHistoricalSummary(scope.query, {}, controller.signal)
  await readHistoricalPreparation(scope.query, {}, controller.signal)
  await readHistoricalPreparation(scope.query, {}, controller.signal)
  assert.equal(requests.length, 3)
  assert.ok(requests.every((request) => !request.url.endsWith('/prepare')))
  assert.ok(requests[0].url.endsWith('/analysis/history'))
  assert.ok(requests[1].url.endsWith('/analysis/history/status'))
  assert.deepEqual(requests[1].body, { query: scope.query, options: {} })
})

test('only the explicit start action submits preparation for the selected geometry and period', async (context) => {
  let request: { url: string; body: unknown; signal?: AbortSignal | null } | undefined
  context.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, init?: RequestInit) => {
      request = { url: String(input), body: JSON.parse(String(init?.body)), signal: init?.signal }
      return new Response(JSON.stringify({ state: 'queued', active: true }), { status: 200 })
    },
  )
  const controller = new AbortController()
  const status = await startHistoricalPreparation(
    scope.query,
    { month: 2, year: 2024 },
    controller.signal,
  )
  assert.ok(request?.url.endsWith('/analysis/history/prepare'))
  assert.deepEqual(request?.body, { query: scope.query, options: { month: 2, year: 2024 } })
  assert.equal(request?.signal, controller.signal)
  assert.equal(status.active, true)
})
