import assert from 'node:assert/strict'
import test from 'node:test'
import type { Map as MapLibreMap, Popup } from 'maplibre-gl'
import type { FeatureCollection } from 'geojson'
import {
  createGlobalFireController,
  GLOBAL_AGGREGATE_SOURCE,
  GLOBAL_AGGREGATE_LAYER,
} from '../src/map/global-fire-controller'
import type { GlobalManifest } from '../src/hooks/use-global-fires'
import { FIRE_COLOR_EXPRESSION } from '../src/map/fire-map-style'

class FakePopup {
  callbacks = new Map<string, () => void>()
  on(type: string, callback: () => void) {
    this.callbacks.set(type, callback)
    return this
  }
  off(type: string) {
    this.callbacks.delete(type)
    return this
  }
  remove() {
    this.callbacks.get('close')?.()
    return this
  }
  isOpen() {
    return false
  }
}
class FakeMap {
  bounds = { west: 10, east: 10.001, south: 50, north: 50.001 }
  sources = new Map<
    string,
    {
      data: FeatureCollection
      updates: number
      setData: (data: FeatureCollection) => Promise<void>
    }
  >()
  layers = new Map<string, unknown>()
  images = new Set<string>()
  events = new Map<string, Set<() => void>>()
  getStyle() {
    return { version: 8, layers: [] }
  }
  getSource(id: string) {
    return this.sources.get(id)
  }
  addSource(id: string, spec: { data: FeatureCollection }) {
    const source = {
      data: spec.data,
      updates: 0,
      setData(data: FeatureCollection) {
        source.data = data
        source.updates++
        return Promise.resolve()
      },
    }
    this.sources.set(id, source)
  }
  removeSource(id: string) {
    this.sources.delete(id)
  }
  getLayer(id: string) {
    return this.layers.get(id)
  }
  addLayer(layer: { id: string }) {
    this.layers.set(layer.id, layer)
  }
  removeLayer(id: string) {
    this.layers.delete(id)
  }
  setLayoutProperty() {}
  hasImage(id: string) {
    return this.images.has(id)
  }
  addImage(id: string) {
    this.images.add(id)
  }
  on(type: string, callback: () => void) {
    const list = this.events.get(type) ?? new Set()
    list.add(callback)
    this.events.set(type, list)
  }
  off(type: string, callback: () => void) {
    this.events.get(type)?.delete(callback)
  }
  emit(type: string) {
    for (const callback of this.events.get(type) ?? []) callback()
  }
  getBounds() {
    return {
      getWest: () => this.bounds.west,
      getEast: () => this.bounds.east,
      getSouth: () => this.bounds.south,
      getNorth: () => this.bounds.north,
    }
  }
  getZoom() {
    return 12
  }
}
const manifest = (snapshotId = 'version1'): GlobalManifest => ({
  status: 'ready',
  snapshotId,
  window: '24h',
  count: 200,
  interval: { start: '2026-11-14T12:00:00Z', endExclusive: '2026-11-15T12:00:00Z' },
  tiles: `/firms-api/global/tiles/${snapshotId}/24h/{z}/{x}/{y}.json`,
})
const tile = (id = 'group') => ({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id,
      geometry: { type: 'Point', coordinates: [10, 50] },
      properties: {
        id,
        kind: 'aggregate',
        aggregateId: id,
        count: 200,
        severity: 'high',
        frpMw: 100,
      },
    },
  ],
})
const flush = () => new Promise((resolve) => setTimeout(resolve, 20))

test('display-only global pixels keep FRP colors without count labels or inspection requests', async (context) => {
  const map = new FakeMap()
  let requests = 0
  let inspections = 0
  const loadedSnapshots: Array<string | undefined> = []
  const renderer = createGlobalFireController(map as unknown as MapLibreMap, {
    displayOnly: true,
    createPopup: () => new FakePopup() as unknown as Popup,
    onObservations: () => {},
    onStatus: (status) => loadedSnapshots.push(status.snapshotId),
    onOpenAnalytics: () => inspections++,
    fetch: (async () => {
      requests++
      return new Response(JSON.stringify(tile()))
    }) as typeof fetch,
  })
  context.after(() => renderer.destroy())
  renderer.setManifest(manifest())
  await flush()
  const source = map.getSource(GLOBAL_AGGREGATE_SOURCE)!
  const updates = source.updates
  const layer = map.getLayer(GLOBAL_AGGREGATE_LAYER) as {
    layout: Record<string, unknown>
    paint: Record<string, unknown>
  }
  assert.equal(layer.layout['text-field'], '')
  assert.deepEqual(loadedSnapshots, ['version1', 'version1'])
  assert.deepEqual(layer.paint['icon-color'], FIRE_COLOR_EXPRESSION)
  assert.equal(map.events.get('click')?.size ?? 0, 0)
  renderer.setInteractive(true)
  map.emit('click')
  map.emit('click')
  await flush()
  assert.equal(requests, 1)
  assert.equal(inspections, 0)
  assert.equal(source.updates, updates)
  map.sources.clear()
  map.layers.clear()
  map.images.clear()
  map.emit('style.load')
  await flush()
  assert.equal((map.getLayer(GLOBAL_AGGREGATE_LAYER) as typeof layer).layout['text-field'], '')
  assert.equal(requests, 1)
})

test('adding empty viewport tiles preserves identical canonical source objects', async (context) => {
  const map = new FakeMap()
  let firstUrl = '',
    requests = 0
  const delivered: unknown[] = []
  const renderer = createGlobalFireController(map as unknown as MapLibreMap, {
    createPopup: () => new FakePopup() as unknown as Popup,
    onObservations: (data) => delivered.push(data),
    onStatus: () => {},
    fetch: (async (url) => {
      requests += 1
      firstUrl ||= String(url)
      const features =
        String(url) === firstUrl
          ? [
              {
                type: 'Feature',
                id: 'canonical',
                geometry: { type: 'Point', coordinates: [10, 50] },
                properties: {
                  id: 'canonical',
                  kind: 'observation',
                  acquiredAt: '2026-11-15T10:00:00Z',
                  platform: 'noaa-20',
                  sensor: 'VIIRS',
                  frpMw: 2,
                },
              },
            ]
          : []
      return new Response(JSON.stringify({ type: 'FeatureCollection', features }))
    }) as typeof fetch,
  })
  context.after(() => renderer.destroy())
  renderer.setManifest(manifest())
  await flush()
  assert.equal(delivered.length, 1)
  const updates = map.getSource(GLOBAL_AGGREGATE_SOURCE)!.updates
  map.bounds.east += 0.1
  map.emit('moveend')
  await flush()
  assert.ok(requests > 1)
  assert.equal(delivered.length, 1)
  assert.equal(map.getSource(GLOBAL_AGGREGATE_SOURCE)!.updates, updates)
})

test('global browsing works without an AOI; navigation, sidebar-equivalent toggles and style reload reuse immutable local tiles', async (context) => {
  const map = new FakeMap()
  let requests = 0
  const urls: string[] = []
  const renderer = createGlobalFireController(map as unknown as MapLibreMap, {
    createPopup: () => new FakePopup() as unknown as Popup,
    onObservations: () => {},
    onStatus: () => {},
    fetch: (async (url) => {
      requests++
      urls.push(String(url))
      return new Response(JSON.stringify(tile()))
    }) as typeof fetch,
  })
  context.after(() => renderer.destroy())
  renderer.setManifest(manifest())
  await flush()
  assert.equal(requests, 1)
  assert.ok(map.getLayer(GLOBAL_AGGREGATE_LAYER))
  assert.equal(map.getSource(GLOBAL_AGGREGATE_SOURCE)?.data.features.length, 1)
  const source = map.getSource(GLOBAL_AGGREGATE_SOURCE)!
  const updates = source.updates
  map.emit('moveend')
  map.emit('moveend')
  renderer.setManifest({ ...manifest() })
  await flush()
  assert.equal(requests, 1)
  assert.equal(source.updates, updates)
  renderer.setEnabled(false)
  map.emit('moveend')
  await flush()
  assert.equal(requests, 1)
  renderer.setEnabled(true)
  await flush()
  assert.equal(requests, 1)
  map.sources.clear()
  map.layers.clear()
  map.images.clear()
  map.emit('style.load')
  await flush()
  assert.equal(requests, 1)
  assert.equal(map.getSource(GLOBAL_AGGREGATE_SOURCE)?.data.features.length, 1)
  assert.ok(urls.every((url) => url.startsWith('/firms-api/global/tiles/version1/24h/')))
})
test('obsolete global tile responses cannot mix snapshot generations', async (context) => {
  const map = new FakeMap()
  let release: ((response: Response) => void) | undefined
  const renderer = createGlobalFireController(map as unknown as MapLibreMap, {
    createPopup: () => new FakePopup() as unknown as Popup,
    onObservations: () => {},
    onStatus: () => {},
    fetch: (async (url) =>
      String(url).includes('version1')
        ? await new Promise<Response>((resolve) => {
            release = resolve
          })
        : new Response(JSON.stringify(tile('version2-group')))) as typeof fetch,
  })
  context.after(() => renderer.destroy())
  renderer.setManifest(manifest())
  renderer.setManifest(manifest('version2'))
  await flush()
  release?.(new Response(JSON.stringify(tile('obsolete-group'))))
  await flush()
  const features = map.getSource(GLOBAL_AGGREGATE_SOURCE)!.data.features
  assert.equal(features.length, 1)
  assert.equal(features[0].id, 'version2-group')
})
