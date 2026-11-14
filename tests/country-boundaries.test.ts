import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import type { MultiPolygon } from 'geojson'
import { createCountryBoundaryLoader } from '../src/lib/country-boundaries'
import {
  boundaryGeometryUrl,
  boundaryReference,
  GEOBOUNDARIES_COMMIT,
  GEOBOUNDARIES_RELEASE,
  type BoundaryCatalog,
} from '../src/lib/boundary-catalog'

const catalog = JSON.parse(
  readFileSync(new URL('../public/boundaries/catalog.json', import.meta.url), 'utf8'),
) as BoundaryCatalog
const geometry: MultiPolygon = {
  type: 'MultiPolygon',
  coordinates: [
    [
      [
        [3, 50],
        [7, 50],
        [7, 54],
        [3, 54],
        [3, 50],
      ],
      [
        [4, 51],
        [4, 52],
        [5, 52],
        [5, 51],
        [4, 51],
      ],
    ],
    [
      [
        [12.123456789, -5],
        [13, -5],
        [13, -4],
        [12.123456789, -5],
      ],
    ],
  ],
}

function json(value: unknown) {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
}

function data(shape = geometry, iso?: string) {
  return {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: iso ? { shapeGroup: iso } : {}, geometry: shape }],
  }
}

function provider() {
  const urls: string[] = []
  const fetchBoundary: typeof fetch = async (input, options) => {
    urls.push(String(input))
    assert.ok(options?.signal)
    return json(data())
  }
  return { urls, fetchBoundary }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

test('one pinned full-resolution download preserves all coordinates, holes, islands and source identity', async () => {
  const { urls, fetchBoundary } = provider()
  const load = createCountryBoundaryLoader({ fetch: fetchBoundary, catalog: async () => catalog })
  const result = await load('country:NLD')
  assert.deepEqual(urls, [boundaryGeometryUrl('NLD')])
  assert.deepEqual(result.geometry, geometry)
  assert.equal(result.boundaryRef, boundaryReference('NLD'))
  assert.equal(result.source.version, GEOBOUNDARIES_RELEASE)
  assert.equal(result.source.commit, GEOBOUNDARIES_COMMIT)
  assert.equal(result.source.iso3, 'NLD')
  assert.match(result.source.attribution, /National Georegister/)
  assert.equal(result.source.url, boundaryGeometryUrl('NLD'))
})

test('France follows the same pinned ADM0 source as search and map selections for every other country', async () => {
  const { urls, fetchBoundary } = provider()
  const load = createCountryBoundaryLoader({ fetch: fetchBoundary, catalog: async () => catalog })
  const result = await load('country:FRA')
  assert.deepEqual(urls, [boundaryGeometryUrl('FRA')])
  assert.equal(result.source.commit, GEOBOUNDARIES_COMMIT)
  assert.deepEqual(result.geometry, geometry)
})

test('the detailed cache contains only the four most recently used countries and refreshes recency on hits', async () => {
  const { urls, fetchBoundary } = provider()
  const load = createCountryBoundaryLoader({ fetch: fetchBoundary, catalog: async () => catalog })
  for (const iso of ['POL', 'NLD', 'FRA', 'IDN']) await load('country:' + iso)
  await load('country:POL')
  await load('country:FJI')
  await load('country:POL')
  await load('country:NLD')
  assert.deepEqual(urls, ['POL', 'NLD', 'FRA', 'IDN', 'FJI', 'NLD'].map(boundaryGeometryUrl))
  await load('country:FRA')
  assert.equal(urls.at(-1), boundaryGeometryUrl('FRA'))
  assert.equal(urls.length, 7)
})

test('overlapping consumers share a download and canceling one does not cancel another', async () => {
  let finish!: (value: Response) => void
  let sourceSignal!: AbortSignal
  let downloads = 0
  const load = createCountryBoundaryLoader({
    catalog: async () => catalog,
    fetch: async (_, options) => {
      downloads++
      sourceSignal = options!.signal!
      return new Promise<Response>((resolve) => {
        finish = resolve
      })
    },
  })
  const cancel = new AbortController()
  const first = load('country:POL', { signal: cancel.signal })
  const second = load('country:POL')
  const rejection = assert.rejects(first, { name: 'AbortError' })
  await tick()
  cancel.abort()
  await rejection
  assert.equal(sourceSignal.aborted, false)
  finish(json(data()))
  const boundary = await second
  assert.equal(await load('country:POL'), boundary)
  assert.equal(downloads, 1)
})

test('canceling the last consumer aborts the download and a later selection starts fresh', async () => {
  const signals: AbortSignal[] = []
  let finish!: (value: Response) => void
  const load = createCountryBoundaryLoader({
    catalog: async () => catalog,
    fetch: async (_, options) => {
      const signal = options!.signal!
      signals.push(signal)
      return new Promise<Response>((resolve, reject) => {
        finish = resolve
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    },
  })
  const cancel = new AbortController()
  const first = load('country:POL', { signal: cancel.signal })
  const rejection = assert.rejects(first, { name: 'AbortError' })
  await tick()
  cancel.abort()
  await rejection
  assert.equal(signals[0].aborted, true)
  const second = load('country:POL')
  await tick()
  assert.equal(signals.length, 2)
  finish(json(data()))
  assert.deepEqual((await second).geometry, geometry)
})

test('a late canceled response cannot populate the current detailed cache', async () => {
  const finishes: ((value: Response) => void)[] = []
  let downloads = 0
  const load = createCountryBoundaryLoader({
    catalog: async () => catalog,
    fetch: async () => {
      downloads++
      return new Promise<Response>((resolve) => {
        finishes.push(resolve)
      })
    },
  })
  const cancel = new AbortController()
  const abandoned = load('country:POL', { signal: cancel.signal })
  const rejection = assert.rejects(abandoned, { name: 'AbortError' })
  await tick()
  cancel.abort()
  await rejection
  const current = load('country:POL')
  await tick()
  finishes[0](json(data()))
  finishes[1](json(data()))
  const result = await current
  assert.equal(await load('country:POL'), result)
  assert.equal(downloads, 2)
})

test('an HTTP failure remains retryable and never falls back to the display overview', async () => {
  let requests = 0
  const load = createCountryBoundaryLoader({
    catalog: async () => catalog,
    fetch: async () => (requests++ === 0 ? new Response(null, { status: 503 }) : json(data())),
  })
  await assert.rejects(load('country:POL'), /HTTP 503/)
  assert.deepEqual((await load('country:POL')).geometry, geometry)
  assert.equal(requests, 2)
})

test('invalid polygons and a response belonging to another country cannot become an AOI', async () => {
  const wrongCountry = createCountryBoundaryLoader({
    catalog: async () => catalog,
    fetch: async () => json(data(geometry, 'BEL')),
  })
  await assert.rejects(wrongCountry('country:NLD'), /different country/)
  const invalid = createCountryBoundaryLoader({
    catalog: async () => catalog,
    fetch: async () =>
      json({
        type: 'FeatureCollection',
        features: [
          {
            geometry: {
              type: 'Polygon',
              coordinates: [
                [
                  [0, 0],
                  [1, 1],
                  [2, 0],
                ],
              ],
            },
          },
        ],
      }),
  })
  await assert.rejects(invalid('country:NLD'), /no usable polygons/)
})

test('unavailable country records do not request invented dataset URLs', async () => {
  const { urls, fetchBoundary } = provider()
  const load = createCountryBoundaryLoader({ fetch: fetchBoundary, catalog: async () => catalog })
  await assert.rejects(load('country:ZZZ'), /no boundary in the pinned source/)
  assert.deepEqual(urls, [])
})

test('existing Natural Earth country aliases resolve to pinned ISO country identifiers', async () => {
  const { urls, fetchBoundary } = provider()
  const load = createCountryBoundaryLoader({ fetch: fetchBoundary, catalog: async () => catalog })
  await load('country:SDS')
  assert.deepEqual(urls, [boundaryGeometryUrl('SSD')])
})

test('already canceled selections do not start a source request', async () => {
  const { urls, fetchBoundary } = provider()
  const load = createCountryBoundaryLoader({ fetch: fetchBoundary, catalog: async () => catalog })
  const cancel = new AbortController()
  cancel.abort()
  await assert.rejects(load('country:POL', { signal: cancel.signal }), { name: 'AbortError' })
  assert.deepEqual(urls, [])
})
