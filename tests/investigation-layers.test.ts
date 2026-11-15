import assert from 'node:assert/strict'
import test from 'node:test'
import type { FeatureCollection } from 'geojson'
import type { Map as MapLibreMap } from 'maplibre-gl'
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec'
import {
  createInvestigationLayerController,
  DIAGNOSTIC_LAYERS,
} from '../src/map/investigation-layers'
import { FIRE_MAP_LAYERS } from '../src/map/fire-map-style'

class FakeMap {
  sources = new Map<
    string,
    {
      data: FeatureCollection
      updates: number
      setData: (next: FeatureCollection) => Promise<void>
    }
  >()
  layers = new Map<
    string,
    { id: string; source: string; paint: Record<string, unknown>; layout: Record<string, unknown> }
  >()
  events = new Map<string, Set<() => void>>()
  insertions: (string | undefined)[] = []
  sourceRemovals = 0
  layerRemovals = 0
  hasFireLayer = true
  layerOrder: string[] = [FIRE_MAP_LAYERS.observations]
  isStyleLoaded() {
    return true
  }
  getStyle() {
    return { version: 8, layers: [] }
  }
  getSource(id: string) {
    return this.sources.get(id)
  }
  addSource(id: string, specification: { data: FeatureCollection }) {
    const source = {
      data: specification.data,
      updates: 0,
      setData(next: FeatureCollection) {
        source.data = next
        source.updates++
        return Promise.resolve()
      },
    }
    this.sources.set(id, source)
  }
  getLayer(id: string) {
    return (
      this.layers.get(id) ??
      (this.hasFireLayer && id === FIRE_MAP_LAYERS.observations ? { id } : undefined)
    )
  }
  addLayer(
    layer: {
      id: string
      source: string
      paint: Record<string, unknown>
      layout: Record<string, unknown>
    },
    before?: string,
  ) {
    this.layers.set(layer.id, layer)
    this.insertions.push(before)
    this.moveLayer(layer.id, before)
  }
  moveLayer(id: string, before?: string) {
    this.layerOrder = this.layerOrder.filter((layerId) => layerId !== id)
    const index = before ? this.layerOrder.indexOf(before) : -1
    if (index < 0) this.layerOrder.push(id)
    else this.layerOrder.splice(index, 0, id)
  }
  setPaintProperty(id: string, name: string, value: unknown) {
    this.layers.get(id)!.paint[name] = value
  }
  setLayoutProperty(id: string, name: string, value: unknown) {
    this.layers.get(id)!.layout[name] = value
  }
  removeLayer(id: string) {
    this.layers.delete(id)
    this.layerOrder = this.layerOrder.filter((layerId) => layerId !== id)
    this.layerRemovals++
  }
  removeSource(id: string) {
    this.sources.delete(id)
    this.sourceRemovals++
  }
  on(event: string, listener: () => void) {
    if (!this.events.has(event)) this.events.set(event, new Set())
    this.events.get(event)!.add(listener)
  }
  off(event: string, listener: () => void) {
    this.events.get(event)?.delete(listener)
  }
  emit(event: string) {
    for (const listener of this.events.get(event) ?? []) listener()
  }
}

const collection: FeatureCollection = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [10, 20],
            [10.1, 20],
            [10.1, 20.1],
            [10, 20.1],
            [10, 20],
          ],
        ],
      },
      properties: { distinctDates: 4, observationCount: 6 },
    },
  ],
}

test('diagnostic opacity, navigation and unchanged collections never resend data or recreate layers', () => {
  const map = new FakeMap()
  const controller = createInvestigationLayerController(map as unknown as MapLibreMap)
  const data = {
    recurrence: collection,
    outlook: null,
    recurrenceEnabled: true,
    outlookEnabled: false,
    forecastValidated: false,
  }
  controller.setData(data)
  const source = map.sources.get(DIAGNOSTIC_LAYERS[0])!
  for (let i = 0; i < 20; i++) {
    controller.setOpacity(0.1 + i * 0.03)
    controller.setData({ ...data })
    map.emit('moveend')
  }
  assert.equal(source.updates, 0)
  assert.equal(map.insertions.length, 2)
  assert.equal(map.sourceRemovals, 0)
  assert.equal(map.layerRemovals, 0)
  assert.deepEqual(map.insertions, [FIRE_MAP_LAYERS.observations, FIRE_MAP_LAYERS.observations])
  controller.setData({ ...data, recurrenceEnabled: false })
  assert.equal(map.layers.get(DIAGNOSTIC_LAYERS[0])!.layout.visibility, 'none')
  assert.equal(source.updates, 0)
  controller.setData({ ...data, recurrence: { ...collection } })
  assert.equal(source.updates, 1)
  controller.destroy()
  assert.equal(map.sourceRemovals, 2)
  assert.equal(map.layerRemovals, 2)
  assert.equal(map.events.get('style.load')!.size, 0)
})

test('local diagnostics render while remote imagery tiles are pending or failed', () => {
  const map = new FakeMap()
  map.isStyleLoaded = () => false
  const controller = createInvestigationLayerController(map as unknown as MapLibreMap)
  controller.setData({
    recurrence: collection,
    outlook: null,
    recurrenceEnabled: true,
    outlookEnabled: false,
    forecastValidated: false,
  })
  assert.equal(map.sources.get(DIAGNOSTIC_LAYERS[0])!.data, collection)
  assert.equal(map.layers.get(DIAGNOSTIC_LAYERS[0])!.layout.visibility, 'visible')
  controller.destroy()
})

test('diagnostics restore source data, layer order and opacity after style changes', async () => {
  const map = new FakeMap()
  const controller = createInvestigationLayerController(map as unknown as MapLibreMap)
  controller.setData({
    recurrence: collection,
    outlook: null,
    recurrenceEnabled: true,
    outlookEnabled: false,
    forecastValidated: false,
  })
  controller.setOpacity(0.8)
  map.sources.clear()
  map.layers.clear()
  map.emit('style.load')
  await Promise.resolve()
  assert.equal(map.sources.get(DIAGNOSTIC_LAYERS[0])!.data, collection)
  assert.equal(map.sources.get(DIAGNOSTIC_LAYERS[0])!.updates, 0)
  assert.equal(map.layers.get(DIAGNOSTIC_LAYERS[0])!.paint['fill-opacity'], 0.8)
  assert.equal(map.layers.get(DIAGNOSTIC_LAYERS[0])!.layout.visibility, 'visible')
  controller.destroy()
})

test('diagnostics stay below observations restored by a later style.load listener and cancel deferred work on destruction', async () => {
  const map = new FakeMap()
  const controller = createInvestigationLayerController(map as unknown as MapLibreMap)
  controller.setData({
    recurrence: collection,
    outlook: null,
    recurrenceEnabled: true,
    outlookEnabled: false,
    forecastValidated: false,
  })
  // Register after the diagnostic listener, matching the React hook/controller effect order.
  map.on('style.load', () => {
    map.hasFireLayer = true
    map.layerOrder.push(FIRE_MAP_LAYERS.observations)
  })
  map.sources.clear()
  map.layers.clear()
  map.layerOrder = []
  map.hasFireLayer = false
  map.emit('style.load')
  assert.deepEqual(map.layerOrder, [FIRE_MAP_LAYERS.observations])
  await Promise.resolve()
  assert.deepEqual(map.layerOrder, [...DIAGNOSTIC_LAYERS, FIRE_MAP_LAYERS.observations])
  assert.equal(map.sources.get(DIAGNOSTIC_LAYERS[0])!.updates, 0)
  const errors = validateStyleMin({
    version: 8,
    sources: Object.fromEntries(
      [...map.sources].map(([id, source]) => [id, { type: 'geojson', data: source.data }]),
    ),
    layers: [...map.layers.values()],
  })
  assert.deepEqual(
    errors.map((error) => error.message),
    [],
  )
  map.emit('style.load')
  controller.destroy()
  await Promise.resolve()
  assert.equal(map.layers.size, 0)
  assert.equal(map.sources.size, 0)
})
