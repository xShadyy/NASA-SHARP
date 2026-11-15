import assert from 'node:assert/strict'
import test from 'node:test'
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec'
import type { Feature, FeatureCollection, Point } from 'geojson'
import type {
  CustomLayerInterface,
  LayerSpecification,
  Map as MapLibreMap,
  SourceSpecification,
} from 'maplibre-gl'
import type { GlobalManifest } from '../src/hooks/use-global-fires'
import type { FireFeature } from '../src/lib/fire-severity'
import type { GlobalDisplayStatus } from '../src/map/global-fire-controller'
import { FIRE_PIXEL_COLOR, FIRE_SQUARE_IMAGE } from '../src/map/fire-map-style'
import {
  createGlobalPointController,
  GLOBAL_POINT_INDEX_LAYER,
  GLOBAL_POINT_LAYER,
  GLOBAL_POINT_SOURCE,
  isGlobalPointSourceReady,
} from '../src/map/global-point-controller'
import type {
  createGlobalPointRenderer,
  GlobalPointRenderer,
  GlobalPointRenderStats,
} from '../src/map/global-point-renderer'

const SOURCE = GLOBAL_POINT_SOURCE,
  LAYER = GLOBAL_POINT_LAYER
type QueriedFeature = Feature<Point> & { tile?: { z: number; x: number; y: number } }
type Event = {
  type?: string
  sourceId?: string
  sourceDataType?: string
  source?: { tiles?: string[] }
  tile?: { state: string }
  error?: Error
}
type StoredSource = {
  spec: SourceSpecification
  data?: unknown
  setData: (data: FeatureCollection) => void
}
type FakeRenderer = GlobalPointRenderer & {
  deliveries: Array<readonly Pick<Feature, 'id' | 'geometry'>[]>
  removed: number
  completeFrame: () => void
  fail: (message: string) => void
}

class FakeMap {
  sources = new Map<string, StoredSource>()
  layers = new Map<string, LayerSpecification | CustomLayerInterface>()
  images = new Set<string>()
  events = new Map<string, Set<(event: Event) => void>>()
  additions: Array<{ id: string; spec: SourceSpecification }> = []
  loaded = false
  moving = false
  features: QueriedFeature[] = []
  queries: Array<{ source: string; sourceLayer: string }> = []
  getStyle() {
    return { version: 8, layers: [...this.layers.values()] }
  }
  isSourceLoaded(id: string) {
    assert.ok(this.sources.has(id), 'Readiness must not query a removed source')
    return this.loaded
  }
  isMoving() {
    return this.moving
  }
  getSource(id: string) {
    return this.sources.get(id)
  }
  addSource(id: string, spec: SourceSpecification) {
    const source: StoredSource = {
      spec,
      data: spec.type === 'geojson' ? spec.data : undefined,
      setData(data) {
        source.data = data
      },
    }
    this.sources.set(id, source)
    this.additions.push({ id, spec })
  }
  removeSource(id: string) {
    this.sources.delete(id)
  }
  getLayer(id: string) {
    return this.layers.get(id)
  }
  addLayer(layer: LayerSpecification | CustomLayerInterface) {
    this.layers.set(layer.id, layer.type === 'custom' ? layer : structuredClone(layer))
  }
  removeLayer(id: string) {
    const layer = this.layers.get(id)
    if (layer?.type === 'custom')
      layer.onRemove?.(this as unknown as MapLibreMap, {} as WebGLRenderingContext)
    this.layers.delete(id)
  }
  hasImage(id: string) {
    return this.images.has(id)
  }
  addImage(id: string) {
    this.images.add(id)
  }
  querySourceFeatures(source: string, options: { sourceLayer: string }) {
    this.queries.push({ source, sourceLayer: options.sourceLayer })
    return this.features
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
}

function manifest(snapshotId = 'version1', count = 200): GlobalManifest {
  return {
    status: 'ready',
    snapshotId,
    window: '24h',
    count,
    interval: { start: '2026-11-14T12:00:00Z', endExclusive: '2026-11-15T12:00:00Z' },
    tiles: `/firms-api/global/tiles/${snapshotId}/24h/{z}/{x}/{y}.json`,
    pointTiles: `/firms-api/global/point-tiles/${snapshotId}/24h/{z}/{x}/{y}.pbf`,
    pointSourceLayer: 'observations',
    pointMaxZoom: 8,
  }
}
function setup() {
  const map = new FakeMap(),
    statuses: GlobalDisplayStatus[] = [],
    renderers: FakeRenderer[] = []
  const factory: typeof createGlobalPointRenderer = (options = {}) => {
    let stats: GlobalPointRenderStats = {
      count: 0,
      bytes: 0,
      batches: 0,
      preparationMs: 0,
      revision: 0,
      renderedRevision: -1,
      drawCalls: 0,
      renderCpuMs: 0,
    }
    const renderer: FakeRenderer = {
      id: options.id ?? LAYER,
      type: 'custom',
      deliveries: [],
      removed: 0,
      render() {},
      onRemove() {
        renderer.removed++
      },
      setFeatures(features) {
        renderer.deliveries.push(features)
        stats = {
          ...stats,
          count: features.length,
          bytes: features.length * 8,
          revision: stats.revision + 1,
        }
        return { ...stats }
      },
      getStats() {
        return { ...stats }
      },
      setEnabled() {},
      completeFrame() {
        stats = { ...stats, renderedRevision: stats.revision }
        options.onRendered?.({ ...stats })
      },
      fail(message) {
        options.onError?.(message)
      },
    }
    renderers.push(renderer)
    return renderer
  }
  const controller = createGlobalPointController(map as unknown as MapLibreMap, {
    onStatus: (status) => statuses.push({ ...status }),
    createRenderer: factory,
  })
  return { map, controller, statuses, renderers, renderer: () => renderers.at(-1)! }
}
const flush = (delay = 10) => new Promise((resolve) => setTimeout(resolve, delay))
function loadedTile(map: FakeMap, extra: Partial<Event> = {}) {
  map.emit('sourcedata', { sourceId: SOURCE, tile: { state: 'loaded' }, ...extra })
}
function tileUrl(map: FakeMap) {
  const source = map.getSource(SOURCE)
  if (source?.spec.type !== 'vector') assert.fail('Missing native vector observation source')
  return source.spec.tiles![0]
}

test('global startup ignores pending AOI and imagery sources', () => {
  const checked: string[] = []
  const map = {
    getSource: (id: string) => (id === SOURCE ? {} : undefined),
    isSourceLoaded: (id: string) => {
      checked.push(id)
      assert.equal(id, SOURCE)
      return true
    },
  } as Pick<MapLibreMap, 'getSource' | 'isSourceLoaded'>
  assert.equal(isGlobalPointSourceReady(map), true)
  map.getSource = () => undefined
  assert.equal(isGlobalPointSourceReady(map), false)
  assert.deepEqual(checked, [SOURCE])
})

test('one transparent native index and one GPU layer replace global symbol placement', (context) => {
  const { map, controller } = setup()
  context.after(() => controller.destroy())
  controller.setManifest(manifest())
  const source = map.getSource(SOURCE)!
  assert.equal(source.spec.type, 'vector')
  assert.equal(source.data, undefined)
  if (source.spec.type === 'vector') assert.equal(source.spec.maxzoom, 8)
  assert.match(tileUrl(map), /version1\/24h\/\{z\}\/\{x\}\/\{y\}\.pbf/)
  assert.equal(map.layers.size, 2)
  assert.equal(map.getLayer(LAYER)?.type, 'custom')
  const index = map.getLayer(GLOBAL_POINT_INDEX_LAYER)
  if (index?.type !== 'circle') assert.fail('Missing native observation tile index')
  assert.equal(index.source, SOURCE)
  assert.equal(index['source-layer'], 'observations')
  assert.equal(index.paint?.['circle-opacity'], 0)
  assert.equal(index.paint?.['circle-stroke-width'], 0)
  assert.equal(index.paint?.['circle-radius'], 1)
  assert.notEqual(index.layout?.visibility, 'none')
  assert.deepEqual(
    validateStyleMin({ version: 8, sources: { [SOURCE]: source.spec }, layers: [index] }),
    [],
  )
  assert.equal([...map.layers.values()].filter((layer) => layer.type === 'symbol').length, 0)
  assert.equal(map.events.get('click')?.size ?? 0, 0)
  assert.equal(map.additions.filter((item) => item.spec.type === 'geojson').length, 0)
})

test('96,054 canonical points reach the GPU once without per-frame queries or full-source updates', async (context) => {
  const { map, controller, renderer, statuses } = setup()
  context.after(() => controller.destroy())
  map.features = Array.from({ length: 96_054 }, (_, index) => ({
    type: 'Feature',
    id: 1_000_001 + index,
    geometry: { type: 'Point', coordinates: [index / 1000 - 100, 50.123456] },
    properties: {},
    tile: { z: 0, x: 0, y: 0 },
  }))
  controller.setManifest(manifest('dense', map.features.length))
  assert.equal(map.queries.length, 0)
  map.loaded = true
  for (let index = 0; index < 20; index++) loadedTile(map)
  await flush()
  assert.deepEqual(map.queries, [{ source: SOURCE, sourceLayer: 'observations' }])
  assert.equal(renderer().deliveries.length, 1)
  const submitted = renderer().deliveries[0]
  assert.equal(submitted, map.features)
  assert.equal(new Set(submitted.map((feature) => feature.id)).size, 96_054)
  assert.deepEqual(submitted.at(-1)?.geometry, map.features.at(-1)?.geometry)
  assert.equal(statuses.at(-1)?.loading, true, 'Decoded records still need a completed GPU frame')
  renderer().completeFrame()
  assert.equal(statuses.at(-1)?.loading, false)
  for (let index = 0; index < 100; index++) {
    map.emit('render')
    map.emit('zoom')
    map.emit('move')
  }
  await flush()
  assert.equal(map.queries.length, 1)
  assert.equal(renderer().deliveries.length, 1)
  assert.equal(map.additions.length, 1)
})

test('unchanged manifests reuse native data while filters create new immutable tile sources', (context) => {
  const { map, controller, renderer } = setup()
  context.after(() => controller.destroy())
  controller.setManifest(manifest())
  const source = map.getSource(SOURCE),
    firstRenderer = renderer(),
    url = tileUrl(map)
  controller.setManifest(structuredClone(manifest()))
  assert.equal(map.getSource(SOURCE), source)
  assert.equal(renderer(), firstRenderer)
  assert.equal(map.additions.length, 1)
  controller.setInvestigation({ platform: 'noaa-20', frpMin: 10 }, 'stable-group')
  assert.notEqual(map.getSource(SOURCE), source)
  assert.equal(firstRenderer.removed, 1)
  assert.match(decodeURIComponent(tileUrl(map)), /frpMin.*10/)
  assert.equal(
    new URL(tileUrl(map), 'https://sharp.test').searchParams.get('aggregateId'),
    'stable-group',
  )
  controller.setInvestigation({})
  assert.equal(tileUrl(map), url)
})

test('readiness waits for an actual loaded native tile and corresponding GPU frame', async (context) => {
  const { map, controller, statuses, renderer } = setup()
  context.after(() => controller.destroy())
  controller.setManifest(manifest())
  map.loaded = true
  loadedTile(map, { sourceId: 'unrelated' })
  map.emit('sourcedata', { sourceId: SOURCE, sourceDataType: 'metadata' })
  map.emit('sourcedata', { sourceId: SOURCE, sourceDataType: 'content' })
  await flush()
  assert.equal(map.queries.length, 0)
  assert.equal(statuses.at(-1)?.loading, true)
  map.loaded = false
  loadedTile(map)
  await flush()
  assert.equal(map.queries.length, 0)
  map.loaded = true
  map.emit('render')
  await flush()
  assert.equal(map.queries.length, 1)
  assert.equal(statuses.at(-1)?.loading, true)
  assert.equal(statuses.at(-1)?.visibleTiles, 0)
  renderer().completeFrame()
  assert.equal(statuses.at(-1)?.loading, false)
  assert.equal(statuses.at(-1)?.visibleTiles, 1)
  assert.equal(statuses.at(-1)?.snapshotId, 'version1')
})

test('valid empty snapshots require a completed empty GPU frame', async (context) => {
  const { map, controller, statuses, renderer } = setup()
  context.after(() => controller.destroy())
  controller.setManifest(manifest('empty', 0))
  map.loaded = true
  loadedTile(map)
  await flush()
  assert.deepEqual(renderer().deliveries, [[]])
  assert.equal(statuses.at(-1)?.loading, true)
  renderer().completeFrame()
  assert.equal(statuses.at(-1)?.loading, false)
})

test('old tiles and old GPU callbacks cannot complete a newer snapshot', async (context) => {
  const { map, controller, statuses, renderer } = setup()
  context.after(() => controller.destroy())
  controller.setManifest(manifest('old'))
  const oldUrl = tileUrl(map),
    previousRenderer = renderer()
  controller.setManifest(manifest('new'))
  map.loaded = true
  loadedTile(map, { source: { tiles: [oldUrl] } })
  previousRenderer.completeFrame()
  await flush()
  assert.equal(map.queries.length, 0)
  assert.equal(statuses.at(-1)?.loading, true)
  loadedTile(map, { source: { tiles: [tileUrl(map)] } })
  await flush()
  assert.equal(statuses.at(-1)?.loading, true)
  renderer().completeFrame()
  assert.equal(statuses.at(-1)?.loading, false)
  assert.equal(statuses.at(-1)?.snapshotId, 'new')
})

test('camera completion coalesces cached-tile preparation without recreating native sources', async (context) => {
  const { map, controller, renderer } = setup()
  context.after(() => controller.destroy())
  controller.setManifest(manifest())
  map.loaded = true
  loadedTile(map)
  await flush()
  renderer().completeFrame()
  const source = map.getSource(SOURCE)
  for (let index = 0; index < 50; index++) map.emit('moveend')
  assert.equal(map.queries.length, 1)
  await flush(280)
  assert.equal(map.queries.length, 2)
  assert.equal(renderer().deliveries.length, 2)
  assert.equal(map.getSource(SOURCE), source)
  assert.equal(map.additions.length, 1)
})

test('style reload restores index, GPU renderer and filters; disable removes both display layers', async (context) => {
  const { map, controller, renderer, statuses } = setup()
  context.after(() => controller.destroy())
  controller.setManifest(manifest())
  controller.setInvestigation({ sensor: 'VIIRS' })
  const url = tileUrl(map),
    previousRenderer = renderer()
  map.sources.clear()
  map.layers.clear()
  map.images.clear()
  assert.doesNotThrow(() => map.emit('render'))
  map.emit('style.load')
  assert.equal(tileUrl(map), url)
  assert.notEqual(renderer(), previousRenderer)
  assert.equal(map.layers.size, 2)
  assert.equal(map.getLayer(GLOBAL_POINT_INDEX_LAYER)?.type, 'circle')
  assert.equal(statuses.at(-1)?.loading, true)
  controller.setEnabled(false)
  assert.equal(map.getLayer(LAYER), undefined)
  assert.equal(map.getLayer(GLOBAL_POINT_INDEX_LAYER), undefined)
  assert.equal(map.getSource(SOURCE), undefined)
  controller.setEnabled(true)
  assert.equal(tileUrl(map), url)
  map.loaded = true
  loadedTile(map)
  await flush()
  renderer().completeFrame()
  assert.equal(statuses.at(-1)?.loading, false)
})

test('canonical highlights preserve exact coordinates and red appearance across style restoration', (context) => {
  const { map, controller } = setup()
  context.after(() => controller.destroy())
  const feature: FireFeature = {
    type: 'Feature',
    id: 'canonical-id',
    geometry: { type: 'Point', coordinates: [179.99999, 50.123456] },
    properties: {
      id: 'canonical-id',
      longitude: 179.99999,
      latitude: 50.123456,
      acquiredEpoch: Date.parse('2026-11-15T10:00:00Z'),
      acquiredAt: '2026-11-15T10:00:00Z',
      utcDay: '2026-11-15',
      platform: 'noaa-20',
      sensor: 'VIIRS',
      severity: 'unknown',
      frpMw: null,
    },
  }
  controller.setHighlight(feature)
  controller.setManifest(manifest())
  const selected = () => map.getSource('global-hotspot-selected')?.data as FeatureCollection
  assert.deepEqual(selected().features, [feature])
  map.sources.clear()
  map.layers.clear()
  map.images.clear()
  map.emit('style.load')
  assert.deepEqual(selected().features, [feature])
  assert.ok(map.images.has(FIRE_SQUARE_IMAGE))
  const highlight = map.getLayer('global-hotspot-selected-square')
  if (highlight?.type !== 'symbol') assert.fail('Missing selected observation highlight')
  assert.equal(highlight.paint?.['icon-color'], FIRE_PIXEL_COLOR)
  controller.setHighlight(null)
  assert.deepEqual(selected().features, [])
})

test('missing tile support and native/GPU errors stay explicit and retry recovers', async (context) => {
  const { map, controller, statuses, renderer } = setup()
  context.after(() => controller.destroy())
  const older = manifest()
  delete older.pointTiles
  controller.setManifest(older)
  assert.equal(map.getSource(SOURCE), undefined)
  assert.match(statuses.at(-1)?.error ?? '', /individual.*unavailable/i)
  controller.setManifest(manifest())
  map.emit('error', { sourceId: 'unrelated', error: new Error('Imagery error') })
  assert.equal(statuses.at(-1)?.error, '')
  map.emit('error', { sourceId: SOURCE, error: new Error('Point tile failed') })
  assert.match(statuses.at(-1)?.error ?? '', /Point tile failed/)
  controller.retry()
  assert.equal(statuses.at(-1)?.error, '')
  renderer().fail('GPU allocation failed')
  assert.match(statuses.at(-1)?.error ?? '', /GPU allocation failed/)
  controller.retry()
  map.loaded = true
  loadedTile(map)
  await flush()
  renderer().completeFrame()
  assert.equal(statuses.at(-1)?.loading, false)
  assert.equal(statuses.at(-1)?.error, '')
})

test('destroy cancels queued preparation and releases owned sources, layers and listeners', async () => {
  const { map, controller, statuses, renderer } = setup()
  controller.setManifest(manifest())
  map.loaded = true
  loadedTile(map)
  const previousRenderer = renderer()
  controller.destroy()
  await flush()
  assert.equal(map.queries.length, 0)
  assert.equal(previousRenderer.removed, 1)
  assert.equal(map.sources.size, 0)
  assert.equal(map.layers.size, 0)
  for (const listeners of map.events.values()) assert.equal(listeners.size, 0)
  const count = statuses.length
  previousRenderer.completeFrame()
  map.emit('style.load')
  loadedTile(map)
  assert.equal(statuses.length, count)
  controller.destroy()
})
