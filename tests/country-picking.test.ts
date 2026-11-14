import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import type { FeatureCollection } from 'geojson'
import type { Map as MapLibreMap } from 'maplibre-gl'
import {
  COUNTRY_PICK_LAYER,
  COUNTRY_PICK_SOURCE,
  createCountryPickingController,
} from '../src/map/country-picking'

type Point = { x: number; y: number }
type PickFeature = {
  id: string
  properties: { countryId: string; name: string }
}

class FakeElement {
  className = ''
  hidden = false
  textContent = ''
  style = { cursor: '', transform: '' }
  attributes = new Map<string, string>()
  children: FakeElement[] = []
  parent: FakeElement | null = null
  clientWidth = 900
  clientHeight = 600

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value)
  }

  append(element: FakeElement) {
    element.parent = this
    this.children.push(element)
  }

  remove() {
    if (this.parent)
      this.parent.children = this.parent.children.filter((element) => element !== this)
    this.parent = null
  }
}

type StoredLayer = { id: string; layout?: Record<string, unknown> }

class FakeMap {
  container = new FakeElement()
  canvas = new FakeElement()
  listeners = new Map<string, Set<(event: unknown) => void>>()
  layers = new Map<string, StoredLayer>()
  sources = new Map<string, { setData: (data: FeatureCollection) => void }>()
  sourceData: FeatureCollection[] = []
  operations: string[] = []
  queries: { point: Point; layers: string[] }[] = []
  featureStates: { source: string; id: string | number; hover: boolean }[] = []
  features: PickFeature[] = []
  projectionOffset = 0

  getContainer() {
    return this.container
  }

  getCanvas() {
    return this.canvas
  }

  getSource(id: string) {
    return this.sources.get(id)
  }

  addSource(id: string, specification: { data: FeatureCollection }) {
    this.operations.push(`addSource:${id}`)
    this.sourceData.push(specification.data)
    this.sources.set(id, {
      setData: (data) => {
        this.operations.push(`setData:${id}`)
        this.sourceData.push(data)
      },
    })
  }

  removeSource(id: string) {
    this.operations.push(`removeSource:${id}`)
    this.sources.delete(id)
  }

  getLayer(id: string) {
    return this.layers.get(id)
  }

  addLayer(layer: StoredLayer) {
    this.operations.push(`addLayer:${layer.id}`)
    this.layers.set(layer.id, layer)
  }

  removeLayer(id: string) {
    this.operations.push(`removeLayer:${id}`)
    this.layers.delete(id)
  }

  getLayoutProperty(id: string, name: string) {
    return this.layers.get(id)?.layout?.[name]
  }

  setLayoutProperty(id: string, name: string, value: unknown) {
    this.operations.push(`setLayout:${id}:${name}`)
    const layer = this.layers.get(id)!
    layer.layout = { ...layer.layout, [name]: value }
  }

  setPaintProperty(id: string, name: string) {
    this.operations.push(`setPaint:${id}:${name}`)
  }

  setFeatureState(target: { source: string; id: string | number }, state: { hover: boolean }) {
    this.featureStates.push({ ...target, hover: state.hover })
  }

  project(coordinates: { lng: number; lat: number }) {
    return { x: coordinates.lng + this.projectionOffset, y: coordinates.lat }
  }

  queryRenderedFeatures(point: Point, options: { layers: string[] }) {
    this.queries.push({ point, layers: options.layers })
    return this.features
  }

  on(type: string, listener: (event: unknown) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(listener)
  }

  off(type: string, listener: (event: unknown) => void) {
    this.listeners.get(type)?.delete(listener)
  }

  emit(type: string, point: Point = { x: 120, y: 60 }) {
    const event = { point, lngLat: { lng: point.x, lat: point.y } }
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

function dom(context: TestContext) {
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const styleDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle')
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => new FakeElement() },
  })
  Object.defineProperty(globalThis, 'getComputedStyle', {
    configurable: true,
    value: () => ({ getPropertyValue: () => '#0960e1' }),
  })
  context.after(() => {
    if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor)
    else Reflect.deleteProperty(globalThis, 'document')
    if (styleDescriptor) Object.defineProperty(globalThis, 'getComputedStyle', styleDescriptor)
    else Reflect.deleteProperty(globalThis, 'getComputedStyle')
  })
}

function feature(iso: string, name: string): PickFeature {
  return { id: `country:${iso}`, properties: { countryId: `country:${iso}`, name } }
}

const overview: FeatureCollection = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 'country:POL',
      properties: { countryId: 'country:POL', name: 'Poland' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [14, 49],
            [24, 49],
            [24, 55],
            [14, 55],
            [14, 49],
          ],
        ],
      },
    },
  ],
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

test('hover hit testing uses only the picking layer and feature state changes only with the country', async (context) => {
  dom(context)
  const map = new FakeMap()
  const controller = createCountryPickingController(map as unknown as MapLibreMap, {
    onPick: () => {},
    loadOverview: async () => overview,
  })
  context.after(() => controller.destroy())
  controller.setEnabled(true)
  await flush()
  map.features = [feature('POL', 'Poland')]
  map.emit('mousemove')
  map.emit('mousemove', { x: 121, y: 61 })
  map.emit('mousemove', { x: 122, y: 62 })
  assert.equal(map.featureStates.length, 1)
  assert.deepEqual(map.featureStates[0], {
    source: COUNTRY_PICK_SOURCE,
    id: 'country:POL',
    hover: true,
  })
  assert.ok(
    map.queries.every(
      (query) => query.layers.length === 1 && query.layers[0] === COUNTRY_PICK_LAYER,
    ),
  )
  assert.equal(map.container.children[0].textContent, 'Poland')
  assert.equal(map.canvas.style.cursor, 'pointer')
  map.features = [feature('IDN', 'Indonesia')]
  map.emit('mousemove')
  assert.deepEqual(map.featureStates.slice(1), [
    { source: COUNTRY_PICK_SOURCE, id: 'country:POL', hover: false },
    { source: COUNTRY_PICK_SOURCE, id: 'country:IDN', hover: true },
  ])
  map.features = []
  map.emit('mousemove')
  map.emit('mousemove')
  assert.equal(map.featureStates.length, 4)
  assert.equal(map.featureStates.at(-1)?.hover, false)
  assert.equal(map.container.children[0].hidden, true)
})

test('overview loading is lazy and hover, clicks and mode toggles reuse the local overview', async (context) => {
  dom(context)
  const map = new FakeMap()
  let downloads = 0
  const picks: string[] = []
  const controller = createCountryPickingController(map as unknown as MapLibreMap, {
    onPick: (id) => picks.push(id),
    loadOverview: async () => {
      downloads++
      return overview
    },
  })
  context.after(() => controller.destroy())
  assert.equal(downloads, 0)
  controller.setEnabled(false)
  assert.equal(downloads, 0)
  controller.setEnabled(true)
  await flush()
  map.features = [feature('POL', 'Poland')]
  for (let index = 0; index < 50; index++) map.emit('mousemove')
  map.emit('click')
  controller.setEnabled(false)
  controller.setEnabled(true)
  await flush()
  map.emit('click')
  assert.equal(downloads, 1)
  assert.deepEqual(picks, ['country:POL', 'country:POL'])
  assert.equal(map.sourceData.at(-1), overview)
})

test('disabled mode and pointer positions beyond the globe surface never pick a country', async (context) => {
  dom(context)
  const map = new FakeMap()
  map.canvas.style.cursor = 'grab'
  map.features = [feature('POL', 'Poland')]
  const picks: string[] = []
  const controller = createCountryPickingController(map as unknown as MapLibreMap, {
    onPick: (id) => picks.push(id),
    loadOverview: async () => overview,
  })
  context.after(() => controller.destroy())
  map.emit('mousemove')
  map.emit('click')
  assert.equal(map.queries.length, 0)
  controller.setEnabled(true)
  await flush()
  map.projectionOffset = 50
  map.emit('mousemove')
  map.emit('click')
  assert.equal(map.queries.length, 0)
  assert.deepEqual(picks, [])
  map.projectionOffset = 0
  map.emit('mousemove')
  assert.equal(map.canvas.style.cursor, 'pointer')
  controller.setEnabled(false)
  map.emit('click')
  map.emit('mousemove')
  assert.deepEqual(picks, [])
  assert.equal(map.canvas.style.cursor, 'grab')
  assert.equal(map.queries.length, 1)
})

test('style reload restores the retained overview without another download', async (context) => {
  dom(context)
  const map = new FakeMap()
  let downloads = 0
  const controller = createCountryPickingController(map as unknown as MapLibreMap, {
    onPick: () => {},
    loadOverview: async () => {
      downloads++
      return overview
    },
  })
  context.after(() => controller.destroy())
  controller.setEnabled(true)
  await flush()
  map.features = [feature('POL', 'Poland')]
  map.emit('mousemove')
  assert.equal(map.container.children[0].hidden, false)
  assert.equal(map.canvas.style.cursor, 'pointer')
  map.sources.clear()
  map.layers.clear()
  map.emit('style.load')
  await flush()
  assert.equal(downloads, 1)
  assert.equal(map.sourceData.at(-1), overview)
  assert.ok(map.getLayer(COUNTRY_PICK_LAYER))
  assert.equal(map.container.children[0].hidden, true)
  assert.equal(map.canvas.style.cursor, '')
})

test('a late overview response after destruction cannot restore map layers or sources', async (context) => {
  dom(context)
  const map = new FakeMap()
  let resolve!: (value: FeatureCollection) => void
  const pending = new Promise<FeatureCollection>((complete) => {
    resolve = complete
  })
  const controller = createCountryPickingController(map as unknown as MapLibreMap, {
    onPick: () => assert.fail('A destroyed controller cannot pick a country.'),
    loadOverview: () => pending,
  })
  controller.setEnabled(true)
  controller.destroy()
  const operations = [...map.operations]
  resolve(overview)
  await flush()
  map.emit('mousemove')
  map.emit('click')
  assert.deepEqual(map.operations, operations)
  assert.equal(map.sources.size, 0)
  assert.equal(map.layers.size, 0)
  assert.equal(map.container.children.length, 0)
})

test('failed overview loading reports an error and can retry without disrupting navigation', async (context) => {
  dom(context)
  const map = new FakeMap()
  let downloads = 0
  const errors: (string | null)[] = []
  const controller = createCountryPickingController(map as unknown as MapLibreMap, {
    onPick: () => {},
    onError: (error) => errors.push(error),
    loadOverview: async () => {
      if (downloads++ === 0) throw new Error('Temporary network error')
      return overview
    },
  })
  context.after(() => controller.destroy())
  controller.setEnabled(true)
  await flush()
  assert.match(errors.at(-1)!, /outlines could not load/)
  controller.setEnabled(false)
  controller.setEnabled(true)
  await flush()
  assert.equal(downloads, 2)
  assert.equal(map.sourceData.at(-1), overview)
  assert.equal(map.canvas.style.cursor, '')
})
