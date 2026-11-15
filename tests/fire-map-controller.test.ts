import assert from 'node:assert/strict'
import test from 'node:test'
import type { FeatureCollection } from 'geojson'
import type { Map as MapLibreMap, Popup } from 'maplibre-gl'
import { GeoJSONVT } from '@maplibre/geojson-vt'
import { featureFilter } from '@maplibre/maplibre-gl-style-spec'
import { createFireDotController } from '../src/map/fire-dots'
import {
  FIRE_POINT_SOURCE,
  FIRE_FOOTPRINT_SOURCE,
  FIRE_MAP_LAYERS,
  FIRE_SQUARE_IMAGE,
} from '../src/map/fire-map-style'
import { fireMapFeatures, type FireFeature } from '../src/lib/fire-severity'

class FakePopup {
  events = new Map<string, () => void>()
  anchor: unknown = null
  root: FakeElement | null = null
  open = false
  additions = 0
  maxWidth = ''
  element = new FakeElement()
  setMaxWidth(value: string) {
    this.maxWidth = value
    return this
  }
  getElement() {
    return this.element
  }
  on(name: string, callback: () => void) {
    this.events.set(name, callback)
    return this
  }
  off(name: string) {
    this.events.delete(name)
    return this
  }
  remove() {
    this.open = false
    this.events.get('close')?.()
    return this
  }
  setLngLat(anchor: unknown) {
    this.anchor = anchor
    return this
  }
  setDOMContent(root: FakeElement) {
    this.root = root
    return this
  }
  isOpen() {
    return this.open
  }
  addTo() {
    this.additions++
    this.open = true
    return this
  }
}

class FakeElement {
  children: FakeElement[] = []
  parent: FakeElement | null = null
  textContent = ''
  className = ''
  type = ''
  disabled = false
  style: Record<string, string> = {}
  attributes = new Map<string, string>()
  classList = {
    contains: (value: string) => this.className.split(/\s+/).includes(value),
    toggle: (value: string, force?: boolean) => {
      const names = new Set(this.className.split(/\s+/).filter(Boolean))
      const enabled = force ?? !names.has(value)
      if (enabled) names.add(value)
      else names.delete(value)
      this.className = [...names].join(' ')
      return enabled
    },
  }
  events = new Map<string, () => void>()
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value)
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null
  }
  contains(element: FakeElement) {
    return this.flatten().includes(element)
  }
  append(...elements: FakeElement[]) {
    for (const element of elements) {
      element.remove()
      element.parent = this
    }
    this.children.push(...elements)
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this)
    this.parent = null
  }
  replaceChildren(...elements: FakeElement[]) {
    this.children = elements
    this.textContent = ''
  }
  addEventListener(name: string, callback: () => void) {
    this.events.set(name, callback)
  }
  flatten(): FakeElement[] {
    return [this, ...this.children.flatMap((child) => child.flatten())]
  }
  text(): string {
    return this.textContent + this.children.map((child) => child.text()).join('')
  }
}

class FakeSource {
  updates: FeatureCollection[] = []
  clustering: boolean[] = []
  leaves: FireFeature[] = []
  leafCalls = 0
  getClusterLeaves(_id: number, limit: number, offset: number) {
    this.leafCalls++
    return Promise.resolve(this.leaves.slice(offset, offset + limit))
  }
  setData(data: FeatureCollection) {
    this.updates.push(data)
    return Promise.resolve()
  }
  setClusterOptions(options: { cluster: boolean }) {
    this.clustering.push(options.cluster)
    return Promise.resolve()
  }
}

class FakeMap {
  sources = new Map<string, FakeSource>()
  specifications = new Map<string, Record<string, unknown>>()
  layers = new Map<string, { id: string }>()
  images = new Set<string>()
  events = new Map<string, Set<() => void>>()
  canvas = { style: { cursor: '' }, addEventListener() {}, removeEventListener() {} }
  filters = new Map<string, unknown>()
  cluster: unknown = null
  rendered: {
    id: string
    properties: { id: string }
    geometry: { type: string; coordinates: number[] }
  }[] = []
  getStyle() {
    return {}
  }
  getSource(id: string) {
    return this.sources.get(id)
  }
  getLayer(id: string) {
    return this.layers.get(id)
  }
  addSource(id: string, specification: Record<string, unknown>) {
    this.sources.set(id, new FakeSource())
    this.specifications.set(id, specification)
  }
  addLayer(layer: { id: string }) {
    assert.ok(
      !Object.hasOwn(layer, 'filter') || Array.isArray((layer as { filter?: unknown }).filter),
      'MapLibre filter must be an array when present',
    )
    this.layers.set(layer.id, layer)
  }
  removeSource(id: string) {
    this.sources.delete(id)
  }
  removeLayer(id: string) {
    this.layers.delete(id)
  }
  hasImage(id: string) {
    return this.images.has(id)
  }
  addImage(id: string) {
    this.images.add(id)
  }
  removeImage(id: string) {
    this.images.delete(id)
  }
  setFilter(id: string, filter: unknown) {
    this.filters.set(id, filter)
  }
  featureStates: { target: { source: string; id: string }; value: Record<string, unknown> }[] = []
  setFeatureState(target: { source: string; id: string }, value: Record<string, unknown>) {
    this.featureStates.push({ target, value })
  }
  getCanvas() {
    return this.canvas
  }
  getZoom() {
    return 5
  }
  on(name: string, callback: () => void) {
    const listeners = this.events.get(name) ?? new Set()
    listeners.add(callback)
    this.events.set(name, listeners)
  }
  off(name: string, callback: () => void) {
    this.events.get(name)?.delete(callback)
  }
  emit(name: string, event?: unknown) {
    for (const callback of this.events.get(name) ?? [])
      (callback as (event?: unknown) => void)(event)
  }
  queryRenderedFeatures(_point: unknown, options: { layers: string[] }) {
    return options.layers.length === 1 && options.layers[0] === FIRE_MAP_LAYERS.clusters
      ? this.cluster
        ? [this.cluster]
        : []
      : this.rendered
  }
}

function observation(id: string): FireFeature {
  return {
    type: 'Feature',
    id,
    geometry: { type: 'Point', coordinates: [10, 20] },
    properties: {
      id,
      latitude: 20,
      longitude: 10,
      severity: 'low',
      frpMw: 3,
      platform: 'noaa-20',
      sensor: 'VIIRS',
      acquiredAt: '2026-11-14T13:00:00Z',
      acquiredEpoch: Date.parse('2026-11-14T13:00:00Z'),
      utcDay: '2026-11-14',
    },
  }
}

function controller(map: FakeMap) {
  return createFireDotController(map as unknown as MapLibreMap, {
    createPopup: () => new FakePopup() as unknown as Popup,
  })
}

test('display-only pixels skip footprint work at close zoom and AOI footprints can resume', async (context) => {
  class CloseZoomMap extends FakeMap {
    boundsReads = 0
    getZoom() {
      return 14
    }
    getBounds() {
      this.boundsReads++
      return { getWest: () => 9, getEast: () => 11, getSouth: () => 19, getNorth: () => 21 }
    }
  }
  const map = new CloseZoomMap()
  const renderer = controller(map)
  context.after(() => renderer.destroy())
  renderer.setDisplay({ disableFootprints: true })
  renderer.setData([observation('pixel')])
  map.emit('moveend')
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(map.boundsReads, 0)
  assert.equal(renderer.getFootprintStatus().state, 'hidden')
  const points = map.sources.get(FIRE_POINT_SOURCE)!
  const updates = points.updates.length
  renderer.setDisplay({ disableFootprints: false })
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.ok(map.boundsReads > 0)
  assert.equal(renderer.getFootprintStatus().state, 'ready')
  assert.equal(map.sources.get(FIRE_FOOTPRINT_SOURCE)!.updates.at(-1)?.features.length, 1)
  assert.equal(points.updates.length, updates)
  renderer.setDisplay({ disableFootprints: true })
  assert.equal(map.sources.get(FIRE_FOOTPRINT_SOURCE)!.updates.at(-1)?.features.length, 0)
  assert.equal(renderer.getFootprintStatus().state, 'hidden')
})

test('requested observation reconciles after asynchronous data and style/source restoration', () => {
  const map = new FakeMap()
  const renderer = controller(map)
  renderer.setDisplay({ selectedObservationId: 'later' })
  assert.equal(
    map.featureStates.some((s) => s.target.id === 'later' && s.value.selected),
    false,
  )
  renderer.setData([observation('later')])
  assert.ok(map.featureStates.some((s) => s.target.id === 'later' && s.value.selected))
  map.featureStates = []
  map.sources.clear()
  map.layers.clear()
  map.images.clear()
  map.emit('style.load')
  assert.ok(map.featureStates.some((s) => s.target.id === 'later' && s.value.selected))
  map.featureStates = []
  map.emit('sourcedata', { sourceId: FIRE_POINT_SOURCE })
  assert.ok(map.featureStates.some((s) => s.target.id === 'later' && s.value.selected))
  renderer.destroy()
  assert.equal(map.events.get('sourcedata')?.size, 0)
})

test('camera and interaction changes never rewrite the point data source', () => {
  const map = new FakeMap()
  const renderer = controller(map)
  const features = [observation('one')]
  renderer.setData(features)
  const source = map.sources.get(FIRE_POINT_SOURCE)!
  assert.equal(source.updates.length, 1)
  renderer.setData(features)
  renderer.setInteractive(false)
  renderer.setInteractive(true)
  map.emit('moveend')
  map.emit('moveend')
  renderer.setDisplay({ focusedDay: '2026-11-14', endUtcExclusive: '2026-11-15T00:00:00Z' })
  assert.equal(source.updates.length, 1)
  assert.equal(map.specifications.get(FIRE_POINT_SOURCE)?.promoteId, 'id')
  assert.deepEqual(source.updates[0].features[0].geometry, features[0].geometry)
  renderer.destroy()
})

test('every focused day retains its observations from a cached 138-detection month', () => {
  const map = new FakeMap()
  const renderer = controller(map)
  const features = fireMapFeatures({
    data: {
      data: {
        type: 'FeatureCollection',
        features: Array.from({ length: 138 }, (_, index) => ({
          type: 'Feature',
          id: 'month-' + index,
          geometry: { type: 'Point', coordinates: [10, 20] },
          properties: {
            acquiredAt: new Date(Date.UTC(2026, 9, 17 + (index % 30), 12)).toISOString(),
            platform: 'noaa-20',
            sensor: 'VIIRS',
            frpMw: index,
          },
        })),
      },
    },
  })
  renderer.setData(features)
  const source = map.sources.get(FIRE_POINT_SOURCE)!
  const collection = source.updates[0]
  const tile = new GeoJSONVT(collection).getTile(0, 0, 0)!
  let allFocusedDetections = 0
  for (let index = 0; index < 30; index++) {
    const day = new Date(Date.UTC(2026, 9, 17 + index)).toISOString().slice(0, 10)
    renderer.setDisplay({ focusedDay: day })
    const filter = featureFilter(
      map.filters.get(FIRE_MAP_LAYERS.observations) as Parameters<typeof featureFilter>[0],
      'filter',
    )
    const matching = tile.features.filter((feature) =>
      filter.filter({ zoom: 5 }, { type: 'Point', properties: feature.tags }),
    )
    assert.ok(matching.length > 0, day)
    assert.equal(
      matching.length,
      features.filter((feature) => feature.properties.utcDay === day).length,
    )
    allFocusedDetections += matching.length
  }
  assert.equal(allFocusedDetections, 138)
  assert.equal(source.updates.length, 1)
  assert.deepEqual(source.clustering, [])
  renderer.setDisplay({ focusedDay: null })
  assert.equal(source.updates.length, 1)
  renderer.destroy()
})

test('dense overview aggregation disables for a focused day without resending observations', () => {
  const map = new FakeMap()
  const renderer = controller(map)
  const features = Array.from({ length: 20000 }, (_, index) => observation(String(index)))
  renderer.setData(features)
  const source = map.sources.get(FIRE_POINT_SOURCE)!
  assert.deepEqual(source.clustering, [true])
  renderer.setDisplay({ focusedDay: '2026-11-14' })
  assert.deepEqual(source.clustering, [true, false])
  assert.equal(source.updates.length, 1)
  assert.deepEqual(map.filters.get(FIRE_MAP_LAYERS.observations), [
    'all',
    ['!', ['has', 'point_count']],
    [
      'any',
      ['==', ['get', 'displayFiltersApplied'], true],
      ['==', ['get', 'utcDay'], '2026-11-14'],
    ],
  ])
  renderer.setDisplay({ focusedDay: null })
  assert.deepEqual(source.clustering, [true, false, true])
  assert.equal(source.updates[0].features.length, 20000)
  renderer.destroy()
})

test('style reload restores retained data, images, filters and layers and destruction cleans up', () => {
  const map = new FakeMap()
  const renderer = controller(map)
  renderer.setData([observation('retained')])
  renderer.setDisplay({ focusedDay: '2026-11-14' })
  map.sources.clear()
  map.layers.clear()
  map.images.clear()
  map.emit('style.load')
  assert.ok(map.sources.has(FIRE_POINT_SOURCE))
  assert.ok(map.sources.has(FIRE_FOOTPRINT_SOURCE))
  assert.ok(map.images.has(FIRE_SQUARE_IMAGE))
  assert.equal(
    (map.specifications.get(FIRE_POINT_SOURCE)?.data as FeatureCollection).features[0].id,
    'retained',
  )
  assert.equal(map.layers.size, 4)
  renderer.destroy()
  assert.equal(map.sources.size, 0)
  assert.equal(map.layers.size, 0)
  assert.equal(map.images.size, 0)
  assert.ok(Array.from(map.events.values()).every((listeners) => listeners.size === 0))
})

test('overlapping world-copy hits deduplicate canonical IDs and popup navigation preserves exact centers', (context) => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement() {
        return new FakeElement()
      },
      createTextNode(text: string) {
        const node = new FakeElement()
        node.textContent = text
        return node
      },
    },
  })
  context.after(() => {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
    else Reflect.deleteProperty(globalThis, 'document')
  })
  const map = new FakeMap()
  const popup = new FakePopup()
  const renderer = createFireDotController(map as unknown as MapLibreMap, {
    createPopup: () => popup as unknown as Popup,
  })
  const newest = observation('newest')
  newest.geometry.coordinates = [10.123456789, 20.987654321]
  newest.properties.confidence = { kind: 'numeric', value: 97 }
  const older = observation('older')
  older.properties.acquiredAt = '2026-11-14T12:00:00Z'
  older.properties.acquiredEpoch = Date.parse(older.properties.acquiredAt)
  renderer.setData([older, newest])
  renderer.setDisplay({ endUtcExclusive: '2026-11-15T00:00:00Z' })
  map.rendered = [newest, older, newest].map((feature) => ({
    id: feature.properties.id,
    properties: { id: feature.properties.id },
    geometry: { type: 'Point', coordinates: [10.12, 20.98] },
  }))
  map.emit('click', { point: { x: 10, y: 20 } })
  assert.deepEqual(popup.anchor, newest.geometry.coordinates)
  assert.match(popup.root!.text(), /1 of 2, newest first/)
  assert.match(popup.root!.text(), /Native confidence: 97/)
  popup
    .root!.flatten()
    .find((node) => node.textContent === 'Next')!
    .events.get('click')!()
  assert.deepEqual(popup.anchor, older.geometry.coordinates)
  assert.match(popup.root!.text(), /2 of 2, newest first/)
  assert.equal(popup.additions, 1)
  assert.match(popup.root!.text(), /Scientific observation details/)
  assert.match(popup.root!.text(), /Footprint interpretation: Approximate sensor footprint/)
  assert.equal(popup.maxWidth, '320px')
  map.rendered = []
  map.emit('click', { point: { x: 100, y: 100 } })
  assert.equal(popup.isOpen(), false)
  renderer.destroy()
})

test('observation filters reuse the complete source and survive style reload', () => {
  const map = new FakeMap()
  const renderer = controller(map)
  const first = observation('first')
  const second = observation('second')
  second.properties.platform = 'aqua'
  second.properties.sensor = 'MODIS'
  renderer.setData([first, second])
  const source = map.sources.get(FIRE_POINT_SOURCE)!
  renderer.setDisplay({ observationFilters: { platform: 'aqua' } })
  assert.deepEqual(map.filters.get(FIRE_MAP_LAYERS.observations), [
    'all',
    ['!', ['has', 'point_count']],
    ['in', ['get', 'id'], ['literal', ['second']]],
  ])
  map.emit('moveend')
  renderer.setDisplay({ observationFilters: { platform: 'aqua' } })
  assert.equal(source.updates.length, 1)
  map.sources.clear()
  map.layers.clear()
  map.images.clear()
  map.emit('style.load')
  const layer = map.layers.get(FIRE_MAP_LAYERS.observations) as unknown as { filter: unknown }
  assert.deepEqual(layer.filter, [
    'all',
    ['!', ['has', 'point_count']],
    ['in', ['get', 'id'], ['literal', ['second']]],
  ])
  renderer.setDisplay({
    observationFilters: { platform: 'aqua' },
    selectedObservationIds: ['first'],
  })
  assert.deepEqual(map.filters.get(FIRE_MAP_LAYERS.observations), [
    'all',
    ['!', ['has', 'point_count']],
    ['in', ['get', 'id'], ['literal', []]],
  ])
  const retainedSource = map.sources.get(FIRE_POINT_SOURCE)!
  renderer.setDisplay({ selectedObservationIds: ['first'] })
  assert.deepEqual(map.filters.get(FIRE_MAP_LAYERS.observations), [
    'all',
    ['!', ['has', 'point_count']],
    ['in', ['get', 'id'], ['literal', ['first']]],
  ])
  assert.equal(retainedSource.updates.length, 0)
  renderer.destroy()
})

test('large aggregate freezes canonical membership in bounded batches across camera changes and invalidates source changes', async (context) => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const cleanup: { renderer?: ReturnType<typeof createFireDotController> } = {}
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement() {
        return new FakeElement()
      },
      createTextNode(text: string) {
        const node = new FakeElement()
        node.textContent = text
        return node
      },
    },
  })
  context.after(() => {
    cleanup.renderer?.destroy()
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
    else Reflect.deleteProperty(globalThis, 'document')
  })
  const map = new FakeMap()
  const popup = new FakePopup()
  let transferred: unknown
  const renderer = createFireDotController(map as unknown as MapLibreMap, {
    createPopup: () => popup as unknown as Popup,
    onOpenAnalytics: (selection) => {
      transferred = selection
    },
  })
  cleanup.renderer = renderer
  const members = Array.from({ length: 1201 }, (_, index) =>
    observation('group-' + String(index).padStart(4, '0')),
  )
  renderer.setData(members)
  renderer.setDisplay({ sourceGeneration: 'first-generation' })
  const source = map.sources.get(FIRE_POINT_SOURCE)!
  source.leaves = members
  map.cluster = {
    properties: { cluster_id: 42, point_count: 1201 },
    geometry: { type: 'Point', coordinates: [10, 20] },
  }
  map.emit('click', { point: { x: 10, y: 20 } })
  const readyBy = Date.now() + 3000
  while (
    !popup.root
      ?.flatten()
      .some((node) => node.textContent === 'Open in Area Analytics' && !node.disabled)
  ) {
    assert.ok(Date.now() < readyBy, 'The bounded observation membership should become ready')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(source.leafCalls, 3)
  assert.match(popup.root!.text(), /Satellite hotspots/)
  assert.equal(popup.maxWidth, '240px')
  assert.equal(
    popup.root!.flatten().some((node) => node.textContent === 'Next'),
    false,
  )
  map.cluster = {
    properties: { cluster_id: 98, point_count: 2 },
    geometry: { type: 'Point', coordinates: [30, 40] },
  }
  map.emit('moveend')
  assert.equal(source.leafCalls, 3)
  assert.equal(source.updates.length, 1)
  popup
    .root!.flatten()
    .find((node) => node.textContent === 'Open in Area Analytics')!
    .events.get('click')!()
  assert.equal((transferred as { observationIds: string[] }).observationIds.length, 1201)
  assert.deepEqual(
    (transferred as { observationIds: string[] }).observationIds,
    members.map((member) => member.properties.id),
  )
  assert.equal((transferred as { sourceGeneration: string }).sourceGeneration, 'first-generation')
  renderer.setDisplay({ sourceGeneration: 'second-generation' })
  assert.equal(popup.isOpen(), false)
  renderer.destroy()
})
