import test from 'node:test'
import assert from 'node:assert/strict'
import { fetchAnalysisSelection } from '../src/lib/analysis-api'
import { customAnalysisRange, historicalUtcDays, eachUtcDay } from '../src/lib/analysis-activity'

const geometry = {
  type: 'Polygon' as const,
  coordinates: [
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 0],
    ],
  ],
}

test('long calendar selections use stored summaries without a large raw observation request', async () => {
  const previous = globalThis.fetch
  const paths: string[] = []
  globalThis.fetch = async (input) => {
    paths.push(String(input))
    return new Response(
      JSON.stringify({
        status: 'available',
        datasetVersion: 'regional-v1',
        daily: [
          {
            date: '2024-01-01',
            value: 0,
            state: 'complete',
            coverage: 'Complete reporting window',
          },
          {
            date: '2024-02-29',
            value: 3,
            state: 'complete',
            coverage: 'Complete reporting window',
          },
        ],
      }),
      { status: 200 },
    )
  }
  try {
    const range = customAnalysisRange('2024-01-01', '2024-03-01')
    const data = await fetchAnalysisSelection(
      'region',
      'Region',
      geometry,
      range,
      new AbortController().signal,
    )
    assert.equal(data.activity.days.length, 61)
    assert.equal(data.activity.days[0].count, 0)
    assert.equal(data.activity.days[1].count, null)
    assert.equal(data.activity.days[59].count, 3)
    assert.equal(data.activity.summaryOnly, true)
    assert.equal(data.meta.completeness, 'partial')
    assert.equal(data.activity.stats?.detections, null)
    assert.deepEqual(data.features, [])
    assert.deepEqual(paths, ['/firms-api/analysis/history'])
    assert.equal(eachUtcDay(range.start, range.end).length, 31)
    assert.equal(historicalUtcDays(range.start, range.end).length, 61)
  } finally {
    globalThis.fetch = previous
  }
})

test('missing stored history remains unavailable with its real reason', async () => {
  const previous = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        status: 'unavailable',
        reason: 'No regional historical reporting dataset has been loaded.',
        daily: [],
      }),
      { status: 200 },
    )
  try {
    const data = await fetchAnalysisSelection(
      'region',
      'Region',
      geometry,
      { start: '2024-01-01', end: '2024-12-31' },
      new AbortController().signal,
    )
    assert.equal(data.meta.completeness, 'unavailable')
    assert.match(data.meta.coverage ?? '', /No regional/)
    assert.equal(data.activity.days.length, 366)
    assert.ok(data.activity.days.every((day) => day.count === null))
  } finally {
    globalThis.fetch = previous
  }
})
