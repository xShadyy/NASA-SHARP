import { performance } from 'node:perf_hooks'
import { GeoJSONVT } from '@maplibre/geojson-vt'

let seed = 235711
function random() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  return seed / 4294967296
}

function tileAt(longitude, latitude, zoom) {
  const scale = 2 ** zoom
  const sine = Math.sin((latitude * Math.PI) / 180)
  return [
    Math.floor(((longitude + 180) / 360) * scale),
    Math.floor((0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)) * scale),
  ]
}

function fixture(count, days, span) {
  return {
    type: 'FeatureCollection',
    features: Array.from({ length: count }, (_, index) => ({
      type: 'Feature',
      id: 'observation-' + index,
      geometry: {
        type: 'Point',
        coordinates: [19 + (random() - 0.5) * span, 52 + (random() - 0.5) * span],
      },
      properties: {
        observationId: 'observation-' + index,
        queryId: 'benchmark',
        acquiredAt: new Date(Date.UTC(2026, 9, 1 + (index % days), 12, index % 60)).toISOString(),
        frpMw: index % 11 === 0 ? null : index % 150,
        platform: 'noaa-20',
        sensor: 'VIIRS',
        confidence: { kind: 'categorical', value: 'nominal' },
        dayNight: 'day',
        provenance: 'deterministic synthetic fixture',
        nominalResolutionM: 375,
        processingTier: 'firms-active-fire',
      },
    })),
  }
}

function measure(collection, cluster) {
  global.gc?.()
  const heapBefore = process.memoryUsage().heapUsed
  const started = performance.now()
  const index = new GeoJSONVT(collection, {
    maxZoom: 18,
    indexMaxZoom: 6,
    indexMaxPoints: 50000,
    cluster,
    clusterOptions: { maxZoom: 11, radius: 22 },
  })
  const indexMs = performance.now() - started
  const times = []
  let overviewSymbols = 0
  for (let step = 0; step < 120; step++) {
    const zoom = 3 + (step % 12)
    const [x, y] = tileAt(17 + (step % 5), 50 + (step % 5), zoom)
    const before = performance.now()
    const tile = index.getTile(zoom, x, y)
    times.push(performance.now() - before)
    if (!step) overviewSymbols = tile?.features.length ?? 0
  }
  const warmStart = performance.now()
  for (let step = 0; step < 120; step++) {
    const zoom = 3 + (step % 12)
    const [x, y] = tileAt(17 + (step % 5), 50 + (step % 5), zoom)
    index.getTile(zoom, x, y)
  }
  times.sort((a, b) => a - b)
  return {
    indexMs: +indexMs.toFixed(2),
    tileQueryP95Ms: +times[Math.floor(times.length * 0.95)].toFixed(2),
    warmTileQueries120Ms: +(performance.now() - warmStart).toFixed(2),
    heapDeltaMiB: +((process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024).toFixed(2),
    overviewSymbols,
  }
}

for (const [name, count, days, span] of [
  ['small-region-day', 1000, 1, 0.5],
  ['dense-country-week', 25000, 7, 8],
  ['representative-31-days', 100000, 31, 10],
]) {
  const collection = fixture(count, days, span)
  const started = performance.now()
  const json = JSON.stringify(collection)
  const serializationMs = performance.now() - started
  const parseStarted = performance.now()
  JSON.parse(json)
  const parseMs = performance.now() - parseStarted
  console.log(
    JSON.stringify({
      name,
      observations: count,
      fixture: 'synthetic, not live NASA measurements',
      payloadMiB: +(Buffer.byteLength(json) / 1024 / 1024).toFixed(2),
      serializationMs: +serializationMs.toFixed(2),
      parseMs: +parseMs.toFixed(2),
      plain: measure(collection, false),
      clustered: measure(collection, true),
      browserFrameTime: 'not measured; application was not started',
    }),
  )
}
