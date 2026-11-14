import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  boundaryGeometryUrl,
  boundaryReference,
  createBoundaryCatalogLoader,
  GEOBOUNDARIES_COMMIT,
  GEOBOUNDARIES_RELEASE,
  type BoundaryCatalog,
} from '../src/lib/boundary-catalog'
import { countriesFromCatalog } from '../src/lib/analysis-countries'
import { matchLocalPlaces, type SearchPlace } from '../src/lib/locations'

const catalog = JSON.parse(
  readFileSync(new URL('../public/boundaries/catalog.json', import.meta.url), 'utf8'),
) as BoundaryCatalog
const overview = JSON.parse(
  readFileSync(new URL('../public/boundaries/country-overview.geojson', import.meta.url), 'utf8'),
)
const places = JSON.parse(
  readFileSync(new URL('../public/map-data/search-places.json', import.meta.url), 'utf8'),
) as SearchPlace[]
const json = (value: unknown) => new Response(JSON.stringify(value))

function provider() {
  const urls: string[] = []
  const fetchCatalog: typeof fetch = async (input) => {
    urls.push(String(input))
    return json(String(input).endsWith('catalog.json') ? catalog : overview)
  }
  return {
    urls,
    loader: createBoundaryCatalogLoader({ fetch: fetchCatalog, baseUrl: '/boundaries/' }),
  }
}

test('the reused overview retains 220 country outlines and maps every shape to its pinned detailed record', async () => {
  const { urls, loader } = provider()
  const result = await loader.overview()
  assert.equal(overview.features.length, 220)
  assert.equal(result.features.length, 220)
  const records = new Map(
    catalog.records
      .filter((record) => record.level === 'ADM0')
      .map((record) => ['country:' + record.iso, record]),
  )
  for (let index = 0; index < result.features.length; index++) {
    const feature = result.features[index]
    const record = records.get(String(feature.id))!
    assert.ok(record)
    assert.equal(feature.properties?.countryId, feature.id)
    assert.equal(feature.properties?.iso3, record.iso)
    assert.equal(feature.properties?.name, record.name)
    assert.equal(feature.properties?.boundaryRef, boundaryReference(record.iso))
    assert.equal(feature.properties?.displayOnly, true)
    assert.deepEqual(feature.geometry, overview.features[index].geometry)
  }
  assert.deepEqual(urls.sort(), [
    '/boundaries/catalog.json',
    '/boundaries/country-overview.geojson',
  ])
})

test('overview and catalog load once and remain local across later map hover sessions', async () => {
  const { urls, loader } = provider()
  const [first, second] = await Promise.all([loader.overview(), loader.overview()])
  assert.equal(first, second)
  assert.equal(await loader.overview(), first)
  await loader.catalog()
  assert.equal(urls.length, 2)
})

test('catalog search includes ISO codes, multilingual aliases, and search-only small countries', () => {
  const countries = countriesFromCatalog(catalog, places)
  assert.equal(countries.length, 228)
  for (const query of ['Poland', 'Polska', 'POL', 'PL']) {
    assert.equal(matchLocalPlaces(countries, query, 1)[0]?.id, 'country:POL')
  }
  for (const [query, iso] of [
    ['Indonesie', 'IDN'],
    ['Fiji', 'FJI'],
    ['France', 'FRA'],
    ['MC', 'MCO'],
    ['Vatican', 'VAT'],
  ]) {
    assert.equal(matchLocalPlaces(countries, query, 1)[0]?.id, 'country:' + iso)
  }
  assert.ok(countries.some((country) => country.id === 'country:GIB'))
})

test('every catalog country references only the pinned release and full ADM0 geometry', () => {
  assert.equal(catalog.release, GEOBOUNDARIES_RELEASE)
  assert.equal(catalog.commit, GEOBOUNDARIES_COMMIT)
  const records = catalog.records.filter((record) => record.level === 'ADM0')
  for (const record of records) assert.equal(record.geometryUrl, boundaryGeometryUrl(record.iso))
})

test('a mismatched source catalog is rejected and remains retryable', async () => {
  let requests = 0
  const loader = createBoundaryCatalogLoader({
    fetch: async () => json(requests++ === 0 ? { ...catalog, commit: 'different' } : catalog),
    baseUrl: '/boundaries/',
  })
  await assert.rejects(loader.catalog(), /does not match/)
  assert.equal((await loader.catalog()).commit, GEOBOUNDARIES_COMMIT)
  assert.equal(requests, 2)
})
