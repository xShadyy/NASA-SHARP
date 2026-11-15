import assert from 'node:assert/strict'
import test from 'node:test'
import {
  fetchGlobalManifest,
  GlobalManifestError,
  globalHotspotLoadingMessage,
  globalManifestPollInterval,
  validateGlobalManifest,
} from '../src/hooks/use-global-fires'

test('a raster-only manifest preserves its exact rolling 24-hour UTC window and 512px tile contract', () => {
  const body = {
    window: '24h',
    status: 'partial',
    snapshotId: 'immutable-raster',
    count: 96054,
    interval: { start: '2026-11-14T13:15:00Z', endExclusive: '2026-11-15T13:15:00Z' },
    rasterTiles: '/firms-api/global/raster/immutable-raster/24h/red-pixels-1/{z}/{x}/{y}.png',
    rasterTileSize: 512,
    rasterMaxZoom: 18,
  }
  const manifest = validateGlobalManifest(body, '24h')
  assert.equal(manifest, body)
  assert.equal(manifest.rasterTileSize, 512)
  assert.equal(
    Date.parse(manifest.interval!.endExclusive) - Date.parse(manifest.interval!.start),
    86400000,
  )
  assert.equal(manifest.tiles, undefined)
  assert.equal(manifest.pointTiles, undefined)
  assert.throws(() => validateGlobalManifest({ ...body, rasterTileSize: 256 }, '24h'), /512-pixel/)
  assert.throws(
    () =>
      validateGlobalManifest(
        {
          ...body,
          interval: {
            start: '2026-11-13T13:15:00Z',
            endExclusive: body.interval.endExclusive,
          },
        },
        '24h',
      ),
    /requested rolling window/,
  )
  assert.throws(() => validateGlobalManifest(body, '7d'), /requested global interval/)
  assert.throws(
    () => validateGlobalManifest({ ...body, rasterTiles: undefined }, '24h'),
    /tile source/,
  )
  assert.throws(
    () =>
      validateGlobalManifest(
        {
          ...body,
          interval: { start: body.interval.endExclusive, endExclusive: body.interval.start },
        },
        '24h',
      ),
    /UTC interval/,
  )
})

test('missing global route remains unavailable without exposing developer setup instructions', async (context) => {
  const signal = new AbortController().signal
  context.mock.method(globalThis, 'fetch', async (_input: unknown, options: RequestInit) => {
    assert.equal(options.signal, signal)
    assert.equal(options.cache, 'no-cache')
    return new Response(JSON.stringify({ detail: 'Not Found' }), { status: 404 })
  })
  await assert.rejects(fetchGlobalManifest('24h', signal), (error: unknown) => {
    assert.ok(error instanceof GlobalManifestError)
    assert.equal(error.status, 404)
    assert.match(error.message, /temporarily unavailable.*retry/i)
    assert.doesNotMatch(error.message, /backend|\.ps1|127\.0\.0\.1/)
    return true
  })
})

test('cold startup polls shared fetch progress quickly and labels the exact selected interval', () => {
  assert.equal(globalHotspotLoadingMessage('24h'), 'Fetching hotspots from the last 24 hours…')
  assert.equal(globalHotspotLoadingMessage('48h'), 'Fetching hotspots from the last 48 hours…')
  assert.equal(globalHotspotLoadingMessage('7d'), 'Fetching hotspots from the last 7 days…')
  assert.equal(globalManifestPollInterval({ window: '24h', status: 'building' }), 2000)
  assert.equal(
    globalManifestPollInterval({
      window: '24h',
      status: 'partial',
      snapshotId: 'first-satellite',
      refreshing: true,
    }),
    2000,
  )
  assert.equal(
    globalManifestPollInterval({ window: '24h', status: 'ready', snapshotId: 'complete' }),
    60000,
  )
  assert.equal(globalManifestPollInterval({ window: '24h', status: 'unavailable' }), 5000)
  assert.equal(
    globalManifestPollInterval(undefined, new GlobalManifestError('Restart backend', 404)),
    60000,
  )
})

test('a supported global route with no stored data remains a truthful successful unavailable state', async (context) => {
  const body = {
    window: '24h',
    status: 'unavailable',
    reason: 'No shared global snapshot has been published.',
  }
  context.mock.method(
    globalThis,
    'fetch',
    async () => new Response(JSON.stringify(body), { status: 200 }),
  )
  assert.deepEqual(await fetchGlobalManifest('24h', new AbortController().signal), body)
})
