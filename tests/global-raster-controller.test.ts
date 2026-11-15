import assert from 'node:assert/strict'
import test from 'node:test'
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec'
import type { FeatureCollection } from 'geojson'
import type { LayerSpecification, Map as MapLibreMap, SourceSpecification } from 'maplibre-gl'
import type { GlobalManifest } from '../src/hooks/use-global-fires'
import type { FireFeature } from '../src/lib/fire-severity'
import {
  createGlobalRasterController,
  GLOBAL_RASTER_PREFIX,
  type GlobalRasterDisplayStatus,
} from '../src/map/global-raster-controller'

type Event = {
  type?: string
  sourceId?: string
  sourceDataType?: string
  source?: { tiles?: string[] }
  tile?: { state: string }
  coord?: { canonical: { z: number; x: number; y: number } }
  error?: { message: string }
}
type StoredSource = {
  spec: SourceSpecification
  data?: unknown
  updates: number
  setData: (data: FeatureCollection) => void
}
class FakeMap {
  sources = new Map<string, StoredSource>()
  layers = new Map<string, LayerSpecification>()
  images = new Set<string>()
  events = new Map<string, Set<(event: Event) => void>>()
  loaded = new Set<string>()
  readinessChecks: string[] = []
  additions: Array<{ id: string; spec: SourceSpecification }> = []
  queries = 0
  repaints = 0
  getStyle() {
    return { version: 8, layers: [...this.layers.values()] }
  }
  getSource(id: string) {
    return this.sources.get(id)
  }
  addSource(id: string, spec: SourceSpecification) {
    assert.ok(!this.sources.has(id), `Source ${id} must be removed before reuse`)
    const source: StoredSource = {
      spec,
      data: spec.type === 'geojson' ? spec.data : undefined,
      updates: 0,
      setData(data) {
        source.data = data
        source.updates++
      },
    }
    this.sources.set(id, source)
    this.additions.push({ id, spec })
  }
  removeSource(id: string) {
    this.sources.delete(id)
    this.loaded.delete(id)
  }
  isSourceLoaded(id: string) {
    assert.ok(this.sources.has(id), 'Removed sources must not be queried')
    this.readinessChecks.push(id)
    return this.loaded.has(id)
  }
  querySourceFeatures() {
    this.queries++
    throw new Error('Global raster browsing cannot query observations')
  }
  queryRenderedFeatures() {
    this.queries++
    throw new Error('Global raster browsing cannot inspect observations')
  }
  getLayer(id: string) {
    return this.layers.get(id)
  }
  addLayer(layer: LayerSpecification) {
    this.layers.set(layer.id, structuredClone(layer))
  }
  removeLayer(id: string) {
    this.layers.delete(id)
  }
  setPaintProperty(id: string, name: string, value: unknown) {
    const layer = this.layers.get(id)
    assert.ok(layer, `Missing layer ${id}`)
    Object.assign((layer.paint ??= {}), { [name]: value })
  }
  hasImage(id: string) {
    return this.images.has(id)
  }
  addImage(id: string) {
    this.images.add(id)
  }
  triggerRepaint() {
    this.repaints++
  }
  on(type: string, callback: (event: Event) => void) {
    const listeners = this.events.get(type) ?? new Set()
    listeners.add(callback)
    this.events.set(type, listeners)
  }
  off(type: string, callback: (event: Event) => void) {
    this.events.get(type)?.delete(callback)
  }
  emit(type: string, event: Event = {}) {
    for (const callback of this.events.get(type) ?? []) callback({ type, ...event })
  }
  styleReload() {
    this.sources.clear()
    this.layers.clear()
    this.images.clear()
    this.loaded.clear()
    this.emit('style.load')
  }
}
function manifest(snapshotId = 'version1', count = 96_054): GlobalManifest {
  return {
    status: 'ready',
    snapshotId,
    window: '24h',
    count,
    interval: { start: '2026-11-14T13:00:00Z', endExclusive: '2026-11-15T13:00:00Z' },
    tiles: `/firms-api/global/tiles/${snapshotId}/24h/{z}/{x}/{y}.json`,
    rasterTiles: `/firms-api/global/raster/${snapshotId}/24h/red-pixels-1/{z}/{x}/{y}.png`,
    rasterTileSize: 512,
    rasterMaxZoom: 18,
  }
}
function setup() {
  const map = new FakeMap(),
    statuses: GlobalRasterDisplayStatus[] = []
  const controller = createGlobalRasterController(map as unknown as MapLibreMap, {
    onStatus: (status) => statuses.push(status),
  })
  return { map, controller, statuses }
}
const rasterIds = (map: FakeMap) =>
  [...map.sources].filter(([, source]) => source.spec.type === 'raster').map(([id]) => id)
function url(map: FakeMap, id: string) {
  const source = map.getSource(id)
  if (source?.spec.type !== 'raster') assert.fail('Missing native raster source')
  return source.spec.tiles![0]
}
function opacity(map: FakeMap, id: string) {
  const layer = map.getLayer(`${id}-pixels`)
  if (layer?.type !== 'raster') return undefined
  return layer.paint?.['raster-opacity']
}
function tile(map: FakeMap, id: string, extra: Partial<Event> = {}) {
  map.emit('sourcedata', {
    sourceId: id,
    tile: { state: 'loaded' },
    coord: { canonical: { z: 0, x: 0, y: 0 } },
    ...extra,
  })
}
function finish(map: FakeMap, id: string) {
  map.loaded.add(id)
  tile(map, id)
  map.emit('render')
  map.emit('render')
}

test('default worldwide browsing uses only native nearest-neighbor 512px raster tiles', (context) => {
  const { map, controller } = setup()
  context.after(() => controller.destroy())
  controller.setManifest(manifest())
  const [id] = rasterIds(map),
    source = map.getSource(id)!
  assert.ok(id.startsWith(GLOBAL_RASTER_PREFIX))
  assert.equal(map.sources.size, 1)
  if (source.spec.type !== 'raster') assert.fail('Missing raster source')
  assert.equal(source.spec.tileSize, 512)
  assert.equal(source.spec.maxzoom, 18)
  assert.match(url(map, id), /version1\/24h\/red-pixels-1\/\{z\}\/\{x\}\/\{y\}\.png/)
  const layer = map.getLayer(`${id}-pixels`)
  if (layer?.type !== 'raster') assert.fail('Missing native raster layer')
  assert.equal(layer.paint?.['raster-resampling'], 'nearest')
  assert.equal(layer.paint?.['raster-fade-duration'], 0)
  assert.deepEqual(
    validateStyleMin({ version: 8, sources: { [id]: source.spec }, layers: [layer] }),
    [],
  )
  for (const event of ['click', 'mousemove', 'move', 'moveend', 'zoom'])
    assert.equal(map.events.get(event)?.size ?? 0, 0)
  finish(map, id)
  for (let index = 0; index < 100; index++) {
    map.emit('render')
    map.emit('move')
    map.emit('zoom')
  }
  assert.equal(map.queries, 0)
  assert.equal(source.updates, 0)
  assert.equal(map.additions.length, 1)
  assert.equal(map.images.size, 0)
})

test('unchanged manifest and filter identity reuse the current native source', (context) => {
  const { map, controller } = setup()
  context.after(() => controller.destroy())
  controller.setManifest(manifest())
  controller.setInvestigation({ sensor: 'VIIRS', frpMin: 10 }, 'group')
  const [id] = rasterIds(map),
    source = map.getSource(id),
    count = map.additions.length
  controller.setManifest(structuredClone(manifest()))
  controller.setInvestigation({ sensor: 'VIIRS', frpMin: 10 }, 'group')
  assert.equal(map.getSource(id), source)
  assert.equal(map.additions.length, count)
  assert.match(decodeURIComponent(url(map, id)), /frpMin.*10/)
  assert.equal(new URL(url(map, id), 'https://sharp.test').searchParams.get('aggregateId'), 'group')
  finish(map, id)
  controller.setManifest(structuredClone(manifest()))
  controller.setInvestigation({ sensor: 'VIIRS', frpMin: 10 }, 'group')
  assert.equal(map.getSource(id), source)
  assert.equal(map.additions.length, count)
})

for (const count of [96_054, 0])
  test(`a ${count}-record snapshot needs one visible tile and two completed render callbacks`, (context) => {
    const { map, controller, statuses } = setup()
    context.after(() => controller.destroy())
    controller.setManifest(manifest('current', count))
    const [id] = rasterIds(map)
    assert.equal(statuses.at(-1)?.loading, true)
    map.emit('sourcedata', { sourceId: id, sourceDataType: 'metadata' })
    map.emit('render')
    map.emit('render')
    assert.equal(statuses.at(-1)?.loading, true)
    tile(map, 'optional-imagery')
    tile(map, id)
    map.emit('render')
    assert.equal(opacity(map, id), 0)
    map.loaded.add(id)
    map.emit('render')
    assert.equal(opacity(map, id), 1)
    assert.equal(statuses.at(-1)?.loading, true)
    map.emit('render')
    assert.equal(statuses.at(-1)?.loading, false)
    assert.equal(statuses.at(-1)?.visibleTiles, 1)
    assert.equal(statuses.at(-1)?.displayedManifest?.snapshotId, 'current')
    assert.equal(statuses.at(-1)?.displayFeatures, count)
    assert.ok(
      map.readinessChecks.every((source) => source === id),
      'AOI and optional imagery cannot block entry',
    )
  })

test('a new immutable snapshot is staged while the previous one stays visible until replacement renders', (context) => {
  const { map, controller, statuses } = setup()
  context.after(() => controller.destroy())
  controller.setManifest(manifest('old'))
  const [oldId] = rasterIds(map)
  finish(map, oldId)
  controller.setManifest(manifest('new'))
  const newId = rasterIds(map).find((id) => id !== oldId)!
  assert.equal(rasterIds(map).length, 2)
  assert.equal(opacity(map, oldId), 1)
  assert.equal(opacity(map, newId), 0)
  assert.equal(statuses.at(-1)?.displayedManifest?.snapshotId, 'old')
  assert.equal(statuses.at(-1)?.loading, false)
  map.loaded.add(newId)
  tile(map, newId)
  map.emit('render')
  assert.ok(map.getSource(oldId), 'Old source is retained until a replacement frame completes')
  assert.equal(statuses.at(-1)?.displayedManifest?.snapshotId, 'old')
  map.emit('render')
  assert.equal(map.getSource(oldId), undefined)
  assert.equal(map.getLayer(`${oldId}-pixels`), undefined)
  assert.equal(opacity(map, newId), 1)
  assert.equal(statuses.at(-1)?.displayedManifest?.snapshotId, 'new')
})

test('superseded pending generations reject late tile completions and errors', (context) => {
  const { map, controller, statuses } = setup()
  context.after(() => controller.destroy())
  controller.setManifest(manifest('old'))
  const [oldId] = rasterIds(map)
  finish(map, oldId)
  controller.setManifest(manifest('skipped'))
  const pendingId = rasterIds(map).find((id) => id !== oldId)!,
    previousUrl = url(map, pendingId)
  controller.setManifest(manifest('latest'))
  map.loaded.add(pendingId)
  tile(map, pendingId, { source: { tiles: [previousUrl] } })
  map.emit('error', {
    sourceId: pendingId,
    source: { tiles: [previousUrl] },
    error: { message: 'Old snapshot expired' },
  })
  map.emit('render')
  map.emit('render')
  assert.equal(statuses.at(-1)?.displayedManifest?.snapshotId, 'old')
  assert.equal(statuses.at(-1)?.error, '')
  tile(map, pendingId, { source: { tiles: [url(map, pendingId)] } })
  map.emit('render')
  map.emit('render')
  assert.equal(statuses.at(-1)?.displayedManifest?.snapshotId, 'latest')
})

test('an unavailable publication keeps the last completed viewport and its actual metadata', (context) => {
  const { map, controller, statuses } = setup()
  context.after(() => controller.destroy())
  controller.setManifest(manifest('last-good'))
  const [id] = rasterIds(map)
  finish(map, id)
  const source = map.getSource(id)
  controller.setManifest({ window: '24h', status: 'unavailable', reason: 'Source update failed.' })
  assert.equal(map.getSource(id), source)
  assert.equal(opacity(map, id), 1)
  assert.equal(statuses.at(-1)?.displayedManifest?.snapshotId, 'last-good')
  assert.equal(statuses.at(-1)?.visibleTiles, 1)
  assert.match(statuses.at(-1)?.error ?? '', /previous snapshot/)
})

test('a filtered replacement remains marked updating until its matching image renders', (context) => {
  const { map, controller, statuses } = setup()
  context.after(() => controller.destroy())
  controller.setManifest(manifest('same-generation'))
  const [original] = rasterIds(map)
  finish(map, original)
  controller.setInvestigation({ platform: 'aqua' })
  const replacement = rasterIds(map).find((id) => id !== original)!
  assert.equal(statuses.at(-1)?.snapshotId, 'same-generation')
  assert.equal(statuses.at(-1)?.loading, false, 'The prior view remains usable')
  assert.equal(statuses.at(-1)?.updating, true, 'Exports must not capture an outdated filter view')
  finish(map, replacement)
  assert.equal(statuses.at(-1)?.updating, false)
})

for (const afterFirstFrame of [false, true])
  test(`a replacement failure ${afterFirstFrame ? 'during' : 'before'} staging keeps the previous snapshot visible`, (context) => {
    const { map, controller, statuses } = setup()
    context.after(() => controller.destroy())
    controller.setManifest(manifest('old'))
    const [oldId] = rasterIds(map)
    finish(map, oldId)
    controller.setManifest(manifest('failed'))
    const pendingId = rasterIds(map).find((id) => id !== oldId)!
    if (afterFirstFrame) {
      map.loaded.add(pendingId)
      tile(map, pendingId)
      map.emit('render')
    }
    map.emit('error', {
      sourceId: pendingId,
      error: { message: 'AJAXError: Gone (410): snapshot expired' },
    })
    map.emit('render')
    map.emit('render')
    assert.equal(opacity(map, oldId), 1)
    assert.equal(opacity(map, pendingId), 0)
    assert.equal(statuses.at(-1)?.displayedManifest?.snapshotId, 'old')
    assert.match(statuses.at(-1)?.error ?? '', /expired/)
    assert.match(statuses.at(-1)?.error ?? '', /previous snapshot/i)
  })

test('native style and projection changes restore current scope without an observation source', (context) => {
  const { map, controller, statuses } = setup()
  context.after(() => controller.destroy())
  controller.setManifest(manifest())
  controller.setInvestigation({ platform: 'noaa-21' })
  const [id] = rasterIds(map),
    template = url(map, id)
  finish(map, id)
  map.emit('projectiontransition')
  assert.equal(url(map, id), template)
  map.styleReload()
  const [restored] = rasterIds(map)
  assert.equal(url(map, restored), template)
  assert.equal(statuses.at(-1)?.loading, true)
  finish(map, restored)
  assert.equal(statuses.at(-1)?.loading, false)
  assert.ok([...map.sources.values()].every((source) => source.spec.type === 'raster'))
  assert.equal(map.queries, 0)
})

test('AOI display disables native worldwide layers and re-enables the same immutable URL', (context) => {
  const { map, controller } = setup()
  context.after(() => controller.destroy())
  controller.setManifest(manifest())
  const [id] = rasterIds(map),
    template = url(map, id)
  finish(map, id)
  controller.setEnabled(false)
  assert.equal(map.sources.size, 0)
  assert.equal(map.layers.size, 0)
  map.emit('style.load')
  assert.equal(map.sources.size, 0)
  controller.setEnabled(true)
  const [restored] = rasterIds(map)
  assert.equal(url(map, restored), template)
  finish(map, restored)
  assert.equal(map.queries, 0)
})

test('only explicit single-observation highlighting introduces a one-point vector source', (context) => {
  const { map, controller } = setup()
  context.after(() => controller.destroy())
  controller.setManifest(manifest())
  assert.equal(map.images.size, 0)
  const point: FireFeature = {
    type: 'Feature',
    id: 'canonical',
    geometry: { type: 'Point', coordinates: [179.99999, 52.123456] },
    properties: {
      id: 'canonical',
      longitude: 179.99999,
      latitude: 52.123456,
      acquiredEpoch: 1,
      acquiredAt: '2026-11-15T12:00:00Z',
      utcDay: '2026-11-15',
      platform: 'noaa-20',
      sensor: 'VIIRS',
      severity: 'unknown',
      frpMw: null,
    },
  }
  controller.setHighlight(point)
  const selected = () => map.getSource('global-hotspot-selected')?.data as FeatureCollection
  assert.deepEqual(selected().features, [point])
  assert.equal(map.sources.size, 2)
  map.styleReload()
  assert.deepEqual(selected().features, [point])
  controller.setHighlight(null)
  assert.deepEqual(selected().features, [])
  assert.equal(map.queries, 0)
})

test('unsupported backend status and snapshot expiry stay actionable; destruction removes owned state', () => {
  const { map, controller, statuses } = setup()
  const unsupported = manifest()
  delete unsupported.rasterTiles
  controller.setManifest(unsupported)
  assert.match(statuses.at(-1)?.error ?? '', /backend.*raster.*restart/i)
  controller.setManifest(manifest())
  const [id] = rasterIds(map)
  map.emit('error', {
    sourceId: id,
    error: { message: 'Snapshot expired (410). Refresh the dataset.' },
  })
  assert.match(statuses.at(-1)?.error ?? '', /410.*refresh/i)
  controller.retry()
  assert.equal(statuses.at(-1)?.error, '')
  controller.destroy()
  assert.equal(map.sources.size, 0)
  assert.equal(map.layers.size, 0)
  for (const listeners of map.events.values()) assert.equal(listeners.size, 0)
  const count = statuses.length
  map.emit('style.load')
  tile(map, id)
  map.emit('render')
  assert.equal(statuses.length, count)
  controller.destroy()
})
