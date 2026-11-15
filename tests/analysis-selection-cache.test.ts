import assert from 'node:assert/strict'
import test from 'node:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import type { Polygon } from 'geojson'
import {
  analysisSelectionKey,
  fetchAnalysisSelection,
  selectedActivityStats,
  type AnalysisSelectionData,
} from '../src/lib/analysis-api'
import { trimAnalysisCache, useAnalysisFires } from '../src/hooks/use-analysis-fires'
import type { AnalysisArea } from '../src/lib/analysis-area'
import type { AnalysisRange } from '../src/lib/analysis-activity'

const geometry: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [14, 50],
      [15, 50],
      [15, 51],
      [14, 51],
      [14, 50],
    ],
  ],
}

test('one initial analysis query caches authoritative daily medians and day focus makes no requests', async () => {
  const previousFetch = globalThis.fetch
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  })
  let requests = 0
  const range = { start: '2026-11-01', end: '2026-11-02' }
  const key = analysisSelectionKey('test-area', geometry, range)
  const daily = [
    {
      date: '2026-11-01',
      detectionCount: 2,
      daysWithDetections: 1,
      peakDate: '2026-11-01',
      medianFrp: 15,
    },
    {
      date: '2026-11-02',
      detectionCount: 1,
      daysWithDetections: 1,
      peakDate: '2026-11-02',
      medianFrp: 30,
    },
  ]
  globalThis.fetch = async (input, options) => {
    requests += 1
    const query = JSON.parse(String(options?.body)).query
    assert.equal(query.interval.start, '2026-11-01T00:00:00.000Z')
    assert.equal(query.interval.endExclusive, '2026-11-03T00:00:00.000Z')
    const path = String(input)
    const meta = {
      queryId: query.id,
      completeness: 'complete',
      fetchedAt: '2026-11-03T00:01:00Z',
      freshness: 'fresh',
    }
    const data = path.endsWith('/map-source')
      ? { data: { features: [] } }
      : path.endsWith('/overview')
        ? {
            detectionCount: { value: 3 },
            daysWithDetections: { value: 2 },
            peakDate: { value: '2026-11-01' },
            medianFrp: { value: 20 },
            daily,
          }
        : path.endsWith('/calendar')
          ? daily.map((day) => ({ date: day.date, count: 1, state: 'complete', coverage: '' }))
          : daily.map((day) => ({
              date: day.date,
              platform: 'aqua',
              count: day.detectionCount,
              state: 'complete',
            }))
    return new Response(JSON.stringify({ data, meta }), { status: 200 })
  }
  try {
    const queryFn = ({ signal }: { signal: AbortSignal }) =>
      fetchAnalysisSelection('test-area', 'Test area', geometry, range, signal)
    const [loaded, shared] = await Promise.all([
      client.fetchQuery({ queryKey: key, queryFn }),
      client.fetchQuery({ queryKey: key, queryFn }),
    ])
    assert.equal(loaded, shared)
    assert.equal(requests, 4)
    const beforeFocus = requests
    for (let index = 0; index < 5; index += 1) {
      const cached = client.getQueryData<AnalysisSelectionData>(key)!
      assert.equal(selectedActivityStats(cached.activity, '2026-11-01')?.medianFrp, 15)
      assert.equal(selectedActivityStats(cached.activity, '2026-11-02')?.detections, 1)
      assert.equal(selectedActivityStats(cached.activity, null)?.detections, 3)
      await client.fetchQuery({ queryKey: key, queryFn })
    }
    assert.equal(requests, beforeFocus)
    assert.equal(loaded.meta.freshness, 'fresh')
  } finally {
    globalThis.fetch = previousFetch
    client.clear()
  }
})

test('the browser query cache bounds retained full-selection entries', () => {
  const client = new QueryClient()
  for (let index = 0; index < 9; index += 1) {
    client.setQueryData(['analysis-selection', String(index)], {
      features: [],
      activity: { range: {}, days: [], series: [] },
      meta: {},
    })
  }
  trimAnalysisCache(client)
  assert.ok(client.getQueryCache().findAll({ queryKey: ['analysis-selection'] }).length <= 4)
  client.clear()
})

test('legacy overview responses retain cached day counts for a 138-observation period without day requests', async () => {
  const previousFetch = globalThis.fetch
  let requests = 0
  const range = { start: '2026-11-01', end: '2026-11-04' }
  const series = [
    { date: '2026-11-01', platform: 'aqua', count: 100, state: 'complete' },
    { date: '2026-11-02', platform: 'aqua', count: 38, state: 'partial' },
    { date: '2026-11-03', platform: 'aqua', count: 0, state: 'complete' },
    { date: '2026-11-04', platform: 'aqua', count: 0, state: 'unavailable' },
  ]
  const observations = Array.from({ length: 138 }, (_, index) => ({
    type: 'Feature',
    id: `observation-${index}`,
    geometry: { type: 'Point', coordinates: [14.5, 50.5] },
    properties: {
      acquiredAt: `${index < 100 ? '2026-11-01' : '2026-11-02'}T12:00:00Z`,
      platform: 'aqua',
      sensor: 'MODIS',
      frpMw: index < 100 ? index + 1 : null,
    },
  }))
  globalThis.fetch = async (input) => {
    requests += 1
    const path = String(input)
    const data = path.endsWith('/map-source')
      ? { type: 'geojson', data: { type: 'FeatureCollection', features: observations } }
      : path.endsWith('/overview')
        ? {
            detectionCount: { value: 138 },
            daysWithDetections: { value: 2 },
            peakDate: { value: '2026-11-01' },
            medianFrp: { value: 50.5 },
          }
        : path.endsWith('/calendar')
          ? series.map((point) => ({
              date: point.date,
              count: point.count ? 1 : 0,
              state: point.state,
            }))
          : series
    return new Response(JSON.stringify({ data, meta: { completeness: 'partial' } }), {
      status: 200,
    })
  }
  try {
    const loaded = await fetchAnalysisSelection(
      'legacy',
      'Legacy area',
      geometry,
      range,
      new AbortController().signal,
    )
    assert.equal(requests, 4)
    assert.equal(loaded.features.length, 138)
    assert.equal(selectedActivityStats(loaded.activity, null)?.detections, 138)
    assert.deepEqual(selectedActivityStats(loaded.activity, '2026-11-01'), {
      detections: 100,
      daysWithDetections: 1,
      peakDate: '2026-11-01',
      medianFrp: 50.5,
    })
    assert.deepEqual(selectedActivityStats(loaded.activity, '2026-11-02'), {
      detections: 38,
      daysWithDetections: 1,
      peakDate: '2026-11-02',
      medianFrp: null,
    })
    assert.deepEqual(selectedActivityStats(loaded.activity, '2026-11-03'), {
      detections: 0,
      daysWithDetections: 0,
      peakDate: null,
      medianFrp: null,
    })
    assert.deepEqual(selectedActivityStats(loaded.activity, '2026-11-04'), {
      detections: null,
      daysWithDetections: null,
      peakDate: null,
      medianFrp: null,
    })
    const olderCached = { ...loaded.activity, dailyStats: undefined }
    assert.equal(selectedActivityStats(olderCached, '2026-11-01')?.detections, 100)
    assert.equal(selectedActivityStats(olderCached, '2026-11-02')?.detections, 38)
    assert.equal(selectedActivityStats(loaded.activity, '2026-10-31'), null)
    assert.equal(requests, 4)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('geometry clones and presentation-only preset changes reuse the applied query identity', () => {
  const range = { start: '2026-11-01', end: '2026-11-07' }
  assert.deepEqual(
    analysisSelectionKey('same', geometry, range),
    analysisSelectionKey('same', structuredClone(geometry), { ...range, preset: '7d' }),
  )
  assert.notDeepEqual(
    analysisSelectionKey('same', geometry, range),
    analysisSelectionKey('same', geometry, { ...range, end: '2026-11-08' }),
  )
})

test('cached hook states preserve partial and unavailable coverage and clear observations for a new interval', () => {
  const client = new QueryClient()
  const range = { start: '2026-11-01', end: '2026-11-02' }
  const area: AnalysisArea = {
    id: 'render-test',
    name: 'Test area',
    type: 'polygon',
    geometry,
    bounds: [
      [14, 50],
      [15, 51],
    ],
  }
  const data: AnalysisSelectionData = {
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [14.5, 50.5] },
        properties: {
          severity: 'high',
          frpMw: 70,
          acquiredAt: '2026-11-01T12:00:00Z',
          platform: 'aqua',
          sensor: 'MODIS',
        },
      },
    ],
    activity: {
      month: '2026-11',
      start: range.start,
      end: range.end,
      range,
      areaName: area.name,
      days: [],
      series: [],
      medianFrp: 70,
      completeness: 'complete',
    },
    meta: {},
  }
  function render(selected: AnalysisRange) {
    function Probe() {
      const loaded = useAnalysisFires(area, selected)
      return createElement(
        'span',
        { 'data-status': loaded.status, 'data-count': loaded.count },
        loaded.message,
      )
    }
    return renderToString(createElement(QueryClientProvider, { client }, createElement(Probe)))
  }
  try {
    for (const status of ['partial', 'unavailable']) {
      client.setQueryData(analysisSelectionKey(area.id, geometry, range), {
        ...data,
        meta: { completeness: status },
      })
      assert.match(render(range), new RegExp('data-status="' + status + '"'))
    }
    client.setQueryData(analysisSelectionKey(area.id, geometry, range), {
      ...data,
      meta: { completeness: 'complete', expiresAt: '2001-01-01T00:00:00Z' },
    })
    assert.match(render(range), /data-status="stale"/)
    client.setQueryData(analysisSelectionKey(area.id, geometry, range), data)
    assert.match(render(range), /Source freshness was not reported/)
    const changed = render({ start: '2026-11-03', end: '2026-11-03' })
    assert.match(changed, /data-status="loading"/)
    assert.match(changed, /data-count="0"/)
  } finally {
    client.clear()
  }
})

test('a canceled obsolete selection cannot populate the replacement query cache', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const first = analysisSelectionKey('old', geometry, { start: '2026-11-01', end: '2026-11-01' })
  const second = analysisSelectionKey('new', geometry, { start: '2026-11-02', end: '2026-11-02' })
  let aborted = false
  const obsolete = client
    .fetchQuery({
      queryKey: first,
      queryFn: ({ signal }) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true
            resolve({ area: 'old' })
          })
        }),
    })
    .catch(() => null)
  await client.cancelQueries({ queryKey: first })
  const current = await client.fetchQuery({
    queryKey: second,
    queryFn: async () => ({ area: 'new' }),
  })
  await obsolete
  assert.equal(aborted, true)
  assert.deepEqual(current, { area: 'new' })
  assert.equal(client.getQueryData(first), undefined)
  assert.deepEqual(client.getQueryData(second), { area: 'new' })
  client.clear()
})
