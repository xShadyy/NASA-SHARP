import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canonicalDashboard,
  fullIntervalObservationScope,
  chartFilter,
  observationDays,
  scopeExportIdentity,
  scopeObservationOptions,
  type ObservationPage,
} from '../src/lib/analytics-investigation'
import {
  createGlobalInvestigation,
  createInvestigation,
  investigationKey,
} from '../src/lib/investigation'
import {
  fetchObservationPage,
  exportInvestigation,
  investigationExportFilename,
  ObservationRequestError,
  requiresObservationReselection,
} from '../src/lib/observation-client'
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
const scope = createInvestigation(
  area,
  { start: '2024-02-28', end: '2024-03-02' },
  { sourceGeneration: 'immutable' },
  '2024-02-29',
  { frpMin: 10 },
  { selectionToken: 'frozen', sourceGeneration: 'immutable' },
)
const page: ObservationPage = {
  data: {
    rows: [],
    total: 920,
    page: 2,
    pageSize: 25,
    groups: [],
    summary: {
      matchingCount: 920,
      selectedCount: 1000,
      wholeAreaCount: 1500,
      earliestAcquisition: null,
      latestAcquisition: '2024-03-02T12:00:00Z',
      platforms: ['aqua'],
      maxFrpMw: 99,
      facets: {
        daily: [{ key: '2024-02-29', label: '29 Feb', count: 920, options: { day: '2024-02-29' } }],
        platform: [{ key: 'aqua', label: 'aqua', count: 920, options: { platform: 'aqua' } }],
        hour: [
          {
            key: '2024-02-29T13',
            label: '29 Feb 13:00',
            count: 300,
            options: { acquiredStart: '2024-02-29T13:00:00Z' },
          },
          {
            key: '2024-03-01T13',
            label: '1 Mar 13:00',
            count: 620,
            options: { acquiredStart: '2024-03-01T13:00:00Z' },
          },
        ],
      },
      dailyCoverage: {
        '2024-02-28': 'complete',
        '2024-02-29': 'partial',
        '2024-03-01': 'unavailable',
        '2024-03-02': 'partial',
      },
      statistics: { medianFrp: 15, frpReported: 800, latest: null, highestFrp: null, topCells: [] },
    },
  },
  meta: {
    sourceGeneration: 'immutable',
    completeness: 'partial',
    fetchedAt: '2024-03-03T00:00:00Z',
  },
}

test('dashboard cards use full matching server summaries rather than the current page or old 500-row sample', () => {
  const result = canonicalDashboard(page, scope)
  assert.ok(result)
  assert.equal(result.count, 920)
  assert.equal(result.features.length, 0)
  assert.equal(result.summary.products[0].count, 920)
  assert.equal(result.summary.hourly[13].count, 920)
  assert.equal(result.summary.medianFrp, 15)
  assert.equal(result.summary.frpReported, 800)
  assert.equal(result.partial, true)
})

test('missing reporting support never becomes a zero-activity overview, while complete zero and observed records remain usable', () => {
  const empty = {
    ...page,
    data: {
      ...page.data,
      total: 0,
      summary: {
        ...page.data.summary,
        matchingCount: 0,
        selectedCount: 0,
        wholeAreaCount: 0,
        facets: {},
        dailyCoverage: {},
        statistics: {
          medianFrp: null,
          frpReported: 0,
          latest: null,
          highestFrp: null,
          topCells: [],
        },
      },
    },
  }
  for (const completeness of ['unavailable', 'unknown', 'partial', undefined])
    assert.equal(
      canonicalDashboard({ ...empty, meta: { ...page.meta, completeness } }, scope),
      null,
    )
  const complete = canonicalDashboard(
    { ...empty, meta: { ...page.meta, completeness: 'complete' } },
    scope,
  )
  assert.ok(complete)
  assert.equal(complete.count, 0)
  assert.equal(complete.partial, false)
  const observed = canonicalDashboard(
    { ...page, meta: { ...page.meta, completeness: 'unknown' } },
    scope,
  )
  assert.ok(observed)
  assert.equal(observed.count, 920)
  assert.equal(observed.partial, true)
  const noMatches = canonicalDashboard(
    {
      ...empty,
      data: {
        ...empty.data,
        summary: { ...empty.data.summary, selectedCount: 1000, wholeAreaCount: 1500 },
      },
      meta: { ...page.meta, completeness: 'partial' },
    },
    scope,
  )
  assert.ok(noMatches)
  assert.equal(noMatches.count, 0)
  assert.equal(noMatches.partial, true)
  assert.equal(empty.data.total, 0)
})

test('daily charts preserve leap day and distinguish reported zero, partial observations and unknown reporting', () => {
  assert.deepEqual(observationDays(page, scope), [
    { date: '2024-02-28', count: 0, coverage: 'complete' },
    { date: '2024-02-29', count: 920, coverage: 'partial' },
    { date: '2024-03-01', count: null, coverage: 'unavailable' },
    { date: '2024-03-02', count: null, coverage: 'partial' },
  ])
})

test('day focus does not crop chart context or turn dates outside the focus into reported zeroes', () => {
  const focused = { ...scope, filters: { ...scope.filters, day: '2024-02-29' } }
  const context = fullIntervalObservationScope(focused)
  assert.equal(context.focusedDay, null)
  assert.equal(context.filters.day, undefined)
  assert.equal(context.filters.frpMin, 10)
  assert.deepEqual(context.query, focused.query)
  assert.deepEqual(context.selection, focused.selection)
  assert.equal(context.method, focused.method)
  assert.equal(focused.focusedDay, '2024-02-29')
  assert.equal(focused.filters.day, '2024-02-29')
})

test('native confidence and FRP chart selections keep correct inclusive/exclusive scales and remove conflicting filters', () => {
  assert.deepEqual(chartFilter('confidence', 'VIIRS nominal').viirsConfidence, ['nominal'])
  assert.equal(chartFilter('confidence', 'VIIRS nominal').modisConfidenceMin, undefined)
  assert.equal(chartFilter('confidence', 'MODIS 30–79').modisConfidenceMax, 79)
  assert.equal(chartFilter('confidence', 'MODIS unknown').modisConfidenceUnknown, true)
  assert.equal(chartFilter('frp', '10–<50 MW').frpMaxExclusive, 50)
  assert.equal(chartFilter('frp', 'Unknown FRP').frpUnknown, true)
  assert.equal(chartFilter('hour', 13).acquisitionHour, 13)
  assert.equal(chartFilter('product', 'NOAA-20').platform, 'noaa-20')
})

test('records and exports preserve frozen membership, focused UTC day and source generation without huge ID bodies', () => {
  const selected = { ...scope, selection: { ...scope.selection, observationIds: ['one', 'two'] } }
  const options = scopeObservationOptions(selected, 3, 25, 'oldest', 'hour')
  assert.equal(options.day, '2024-02-29')
  assert.equal(options.sourceGeneration, 'immutable')
  assert.equal(options.selectionToken, 'frozen')
  assert.equal(options.page, 3)
  assert.equal(options.groupBy, 'hour')
  assert.equal(scopeExportIdentity(selected).selection?.observationIds, undefined)
  assert.deepEqual(selected.selection.observationIds, ['one', 'two'])
})

test('global investigation retains exact rolling instants, snapshot and deterministic group identity', () => {
  const global = createGlobalInvestigation({
    snapshotId: 'snapshot-a',
    window: '24h',
    aggregateId: 'cell-123',
    interval: { start: '2026-11-14T13:00:00Z', endExclusive: '2026-11-15T13:00:00Z' },
  })
  assert.equal(global.query.interval.start, '2026-11-14T13:00:00Z')
  assert.equal(global.query.interval.endExclusive, '2026-11-15T13:00:00Z')
  assert.equal(global.selection?.global?.aggregateId, 'cell-123')
  assert.equal(scopeObservationOptions(global).sourceGeneration, 'snapshot-a')
})

test('historical frozen-day records keep their exact token query while the investigation retains its full interval', async (context) => {
  const period = createInvestigation(
    area,
    { start: '2024-02-01', end: '2024-03-31' },
    { sourceGeneration: 'archive-v2' },
    '2024-02-29',
  )
  const day = createInvestigation(area, { start: '2024-02-29', end: '2024-02-29' })
  const frozen = {
    ...period,
    selection: {
      query: day.query,
      selectionToken: 'focused-membership',
      sourceGeneration: 'archive-v2',
      observationIds: ['stable-one'],
    },
  }
  const requests: Array<{
    url: string
    body: { query: typeof period.query; options: Record<string, unknown> }
    signal: AbortSignal | null | undefined
  }> = []
  context.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
        signal: init?.signal,
      })
      return new Response(JSON.stringify(page), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  )
  const controller = new AbortController()
  await fetchObservationPage(frozen, scopeObservationOptions(frozen), controller.signal)
  assert.equal(requests.length, 1)
  assert.match(requests[0].url, /\/analysis\/observations$/)
  assert.deepEqual(requests[0].body.query, day.query)
  assert.equal(requests[0].body.options.selectionToken, 'focused-membership')
  assert.equal(requests[0].body.options.sourceGeneration, 'archive-v2')
  assert.equal(requests[0].signal, controller.signal)
  assert.equal(frozen.query.interval.start, '2024-02-01T00:00:00.000Z')
  assert.equal(frozen.query.interval.endExclusive, '2024-04-01T00:00:00.000Z')
  assert.notEqual(
    investigationKey(frozen),
    investigationKey({ ...frozen, selection: { ...frozen.selection, query: period.query } }),
  )

  const wholeArea = { ...period, focusedDay: null, filters: {}, selection: undefined }
  await fetchObservationPage(wholeArea, scopeObservationOptions(wholeArea), controller.signal)
  assert.deepEqual(requests[1].body.query, period.query)
  assert.equal(requests[1].body.options.selectionToken, undefined)
  assert.equal(requests[1].body.options.day, undefined)
})

test('expired frozen export preserves both membership query and overall investigation without substituting newer data', async (context) => {
  const period = createInvestigation(
    area,
    { start: '2024-02-01', end: '2024-03-31' },
    { sourceGeneration: 'archive-v2' },
    '2024-02-29',
  )
  const day = createInvestigation(area, { start: '2024-02-29', end: '2024-02-29' })
  const frozen = {
    ...period,
    selection: {
      query: day.query,
      selectionToken: 'expired-membership',
      sourceGeneration: 'archive-v2',
      observationIds: ['stable-one'],
    },
  }
  let request:
    | {
        query: typeof day.query
        options: Record<string, unknown>
        investigation: typeof frozen
        format: string
      }
    | undefined
  let attempts = 0
  context.mock.method(
    globalThis,
    'fetch',
    async (_input: string | URL | Request, init?: RequestInit) => {
      attempts++
      request = JSON.parse(String(init?.body))
      return new Response(
        JSON.stringify({ detail: 'The selected group expired. Select it again on the map.' }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      )
    },
  )
  await assert.rejects(
    exportInvestigation(frozen, 'json', scopeObservationOptions(frozen)),
    /selected group expired/,
  )
  assert.equal(attempts, 1)
  assert.deepEqual(request?.query, day.query)
  assert.equal(request?.format, 'json')
  assert.equal(request?.options.selectionToken, 'expired-membership')
  assert.deepEqual(request?.investigation.query, period.query)
  assert.deepEqual(request?.investigation.selection.query, day.query)
  assert.equal(request?.investigation.selection.observationIds, undefined)
  assert.equal(request?.investigation.method, 'afternoon-active-cells-2km-1')
  assert.deepEqual(frozen.selection.observationIds, ['stable-one'])
})

test('bounded frozen IDs are sent when a token is absent and never replace token membership', () => {
  const selected = {
    ...scope,
    selection: { sourceGeneration: 'immutable', observationIds: ['stable-one'] },
  }
  assert.deepEqual(scopeObservationOptions(selected).observationIds, ['stable-one'])
  assert.equal(
    scopeObservationOptions({
      ...selected,
      selection: { ...selected.selection, selectionToken: 'token' },
    }).observationIds,
    undefined,
  )
})

test('exports include the AOI name without unsafe filename characters', () => {
  assert.equal(
    investigationExportFilename(
      { ...scope, area: { ...area, name: 'Côte d’Ivoire / Region: 1' } },
      'csv',
    ),
    'sharp-cote-d-ivoire-region-1-2024-02-28-2024-03-02.csv',
  )
  assert.ok(investigationExportFilename(scope, 'geojson').startsWith('sharp-regional-aoi-'))
})

test('structured frozen expiry and generation errors offer reselection instead of retrying membership', async (context) => {
  let attempts = 0
  context.mock.method(globalThis, 'fetch', async () => {
    attempts++
    return new Response(
      JSON.stringify({
        message: 'Select this group again.',
        code: 'selection-source-changed',
        action: 'refresh-selected-group',
        recoverable: false,
      }),
      { status: 409 },
    )
  })
  const frozen = {
    ...scope,
    selection: { selectionToken: 'frozen', sourceGeneration: 'immutable' },
  }
  await assert.rejects(
    fetchObservationPage(frozen, scopeObservationOptions(frozen), new AbortController().signal),
    (error: unknown) => requiresObservationReselection(error),
  )
  assert.equal(attempts, 1)
  assert.equal(
    requiresObservationReselection(
      new ObservationRequestError(new Response('', { status: 503 }), {
        message: 'Service unavailable.',
      }),
    ),
    false,
  )
})
