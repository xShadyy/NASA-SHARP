import assert from 'node:assert/strict'
import test from 'node:test'
import { createReferenceTileCache, createTileResponseCache } from '../src/map/reference-tile-cache'

function fetcher(headers?: HeadersInit) {
  const urls: string[] = []
  const fetchTile: typeof fetch = async (input) => {
    urls.push(String(input))
    return new Response(new Uint8Array([1, 2, 3]), { headers })
  }
  return { urls, fetchTile }
}

test('cached tiles reuse a download and remain intact after worker transfer', async () => {
  const { urls, fetchTile } = fetcher()
  const cache = createTileResponseCache({ fetch: fetchTile })
  try {
    const first = await cache.get('road')
    structuredClone(first.data, { transfer: [first.data] })
    assert.equal(first.data.byteLength, 0)
    assert.deepEqual(new Uint8Array((await cache.get('road')).data), new Uint8Array([1, 2, 3]))
    assert.deepEqual(urls, ['road'])
  } finally {
    cache.destroy()
  }
})

test('overlapping viewport requests share a download despite one viewport cancellation', async () => {
  let finish!: (response: Response) => void
  let requests = 0
  const fetchTile: typeof fetch = async () => {
    requests++
    return new Promise<Response>((resolve) => {
      finish = resolve
    })
  }
  const cache = createTileResponseCache({ fetch: fetchTile })
  const abort = new AbortController()
  try {
    const canceled = cache.get('road', abort.signal)
    const active = cache.get('road')
    const rejection = assert.rejects(canceled, { name: 'AbortError' })
    abort.abort()
    finish(new Response(new Uint8Array([7])))
    await rejection
    assert.deepEqual(new Uint8Array((await active).data), new Uint8Array([7]))
    await cache.get('road')
    assert.equal(requests, 1)
  } finally {
    cache.destroy()
  }
})

test('tile retention evicts least recently used entries within the memory budget', async () => {
  const { urls, fetchTile } = fetcher()
  const cache = createTileResponseCache({ fetch: fetchTile, maxBytes: 6, maxEntries: 2 })
  try {
    await cache.get('first')
    await cache.get('second')
    await cache.get('first')
    await cache.get('third')
    await cache.get('first')
    await cache.get('second')
    assert.deepEqual(urls, ['first', 'second', 'third', 'second'])
  } finally {
    cache.destroy()
  }
})

test('expired and non-cacheable tiles are fetched again', async () => {
  let now = 0
  const { urls, fetchTile } = fetcher({ 'cache-control': 'public, max-age=2' })
  const cache = createTileResponseCache({ fetch: fetchTile, now: () => now })
  const noStore = fetcher({ 'cache-control': 'no-store' })
  const transient = createTileResponseCache({ fetch: noStore.fetchTile })
  try {
    await cache.get('road')
    now = 1999
    await cache.get('road')
    assert.equal(urls.length, 1)
    now = 2000
    await cache.get('road')
    assert.equal(urls.length, 2)
    await transient.get('road')
    await transient.get('road')
    assert.equal(noStore.urls.length, 2)
  } finally {
    cache.destroy()
    transient.destroy()
  }
})

test('cache hits keep provider expiration rather than resetting the freshness period', async () => {
  let now = 0
  const { urls, fetchTile } = fetcher({ 'cache-control': 'public, max-age=10', age: '2' })
  const cache = createTileResponseCache({ fetch: fetchTile, now: () => now })
  try {
    assert.equal((await cache.get('road')).cacheControl, 'public, max-age=8')
    now = 5000
    assert.equal((await cache.get('road')).cacheControl, 'public, max-age=3')
    assert.equal(urls.length, 1)
    now = 8000
    await cache.get('road')
    assert.equal(urls.length, 2)
  } finally {
    cache.destroy()
  }
})

test('oversized tiles are delivered without remaining in memory', async () => {
  const { urls, fetchTile } = fetcher()
  const cache = createTileResponseCache({ fetch: fetchTile, maxBytes: 2 })
  try {
    assert.equal((await cache.get('road')).data.byteLength, 3)
    await cache.get('road')
    assert.deepEqual(urls, ['road', 'road'])
  } finally {
    cache.destroy()
  }
})

test('disposing the cache aborts downloads and prevents future requests', async () => {
  let requestSignal: AbortSignal | null = null
  const fetchTile: typeof fetch = async (_, init) => {
    requestSignal = init!.signal!
    return new Promise<Response>((_, reject) => {
      requestSignal!.addEventListener('abort', () => reject(requestSignal!.reason), { once: true })
    })
  }
  const cache = createTileResponseCache({ fetch: fetchTile })
  const pending = assert.rejects(cache.get('road'), { name: 'AbortError' })
  cache.destroy()
  assert.equal(requestSignal!.aborted, true)
  await pending
  await assert.rejects(cache.get('road'), { name: 'AbortError' })
})

test('a failed tile request is retried and its HTTP status is preserved', async () => {
  let requests = 0
  const fetchTile: typeof fetch = async () => {
    requests++
    return requests === 1
      ? new Response('Unavailable', { status: 503 })
      : new Response(new Uint8Array([4]))
  }
  const cache = createTileResponseCache({ fetch: fetchTile })
  try {
    await assert.rejects(cache.get('road'), { status: 503 })
    assert.deepEqual(new Uint8Array((await cache.get('road')).data), new Uint8Array([4]))
    assert.equal(requests, 2)
  } finally {
    cache.destroy()
  }
})

test('only OpenFreeMap vector tiles use the reference tile protocol', async () => {
  const cache = createReferenceTileCache()
  try {
    const tile = 'https://tiles.openfreemap.org/planet/20261111/14/9000/6000.pbf'
    assert.match((await cache.transformRequest(tile, 'Tile'))!.url, /^sharp-reference-\d+:\/\//)
    assert.equal((await cache.transformRequest(tile, 'Source'))!.url, tile)
    const image = 'https://tiles.openfreemap.org/natural_earth/ne2sr/6/20/20.png'
    assert.equal((await cache.transformRequest(image, 'Tile'))!.url, image)
    const other = 'https://example.com/14/9000/6000.pbf'
    assert.equal((await cache.transformRequest(other, 'Tile'))!.url, other)
  } finally {
    cache.destroy()
  }
})
