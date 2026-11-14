import assert from 'node:assert/strict'
import test from 'node:test'
import type { Polygon } from 'geojson'
import { createAnalysisGeometryPreparer } from '../src/map/analysis-geometry-preparer'
import {
  fallbackAnalysisDisplayGeometry,
  prepareAnalysisDisplayGeometry,
} from '../src/map/analysis-geometry'

class FakeWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onmessageerror: (() => void) | null = null
  messages: unknown[] = []
  terminations = 0

  postMessage(value: unknown) {
    this.messages.push(value)
  }

  terminate() {
    this.terminations++
  }
}

const geometry: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [3.123456789, 50],
      [7, 50],
      [7, 54],
      [3.123456789, 54],
      [3.123456789, 50],
    ],
  ],
}

function workers() {
  const created: FakeWorker[] = []
  const factory = () => {
    const worker = new FakeWorker()
    created.push(worker)
    return worker as unknown as Worker
  }
  return { created, factory }
}

test('completed geometry terminates its worker and is reused on a style reload', (context) => {
  const { created, factory } = workers()
  const preparer = createAnalysisGeometryPreparer(factory)
  context.after(() => preparer.destroy())
  const results: unknown[] = []
  preparer.prepare(geometry, (result) => results.push(result))
  assert.deepEqual(created[0].messages, [geometry])
  const result = prepareAnalysisDisplayGeometry(geometry)
  created[0].onmessage!({ data: { result } })
  assert.deepEqual(results, [result])
  assert.equal(created[0].terminations, 1)
  assert.equal(created[0].onmessage, null)
  preparer.prepare(geometry, (value) => results.push(value))
  assert.equal(created.length, 1)
  assert.deepEqual(results, [result, result])
})

test('changing countries terminates pending work and ignores a late previous result', (context) => {
  const { created, factory } = workers()
  const preparer = createAnalysisGeometryPreparer(factory)
  context.after(() => preparer.destroy())
  const results: unknown[] = []
  preparer.prepare(geometry, (result) => results.push(result))
  const lateMessage = created[0].onmessage!
  const other = structuredClone(geometry)
  preparer.prepare(other, (result) => results.push(result))
  assert.equal(created[0].terminations, 1)
  const result = prepareAnalysisDisplayGeometry(geometry)
  lateMessage({ data: { result } })
  assert.deepEqual(results, [])
  created[1].onmessage!({ data: { result } })
  assert.deepEqual(results, [result])
})

test('clear and destruction prevent pending results from restoring a selection', () => {
  const { created, factory } = workers()
  const preparer = createAnalysisGeometryPreparer(factory)
  let updates = 0
  preparer.prepare(geometry, () => updates++)
  const lateMessage = created[0].onmessage!
  preparer.cancel()
  lateMessage({ data: { result: prepareAnalysisDisplayGeometry(geometry) } })
  assert.equal(created[0].terminations, 1)
  assert.equal(updates, 0)
  preparer.prepare(geometry, () => updates++)
  const afterDestruction = created[1].onmessage!
  preparer.destroy()
  afterDestruction({ data: { result: prepareAnalysisDisplayGeometry(geometry) } })
  preparer.prepare(geometry, () => updates++)
  assert.equal(created[1].terminations, 1)
  assert.equal(updates, 0)
  assert.equal(created.length, 2)
})

test('a blocked or unavailable worker falls back without changing precise coordinates', async () => {
  const preparer = createAnalysisGeometryPreparer(() => {
    throw new Error('Worker blocked by policy')
  })
  try {
    const result = await new Promise<ReturnType<typeof prepareAnalysisDisplayGeometry>>((resolve) =>
      preparer.prepare(geometry, resolve),
    )
    assert.deepEqual(result.boundary.coordinates[0], geometry.coordinates)
    assert.ok(result.outside?.coordinates.length)
  } finally {
    preparer.destroy()
  }
})

test('worker errors terminate the worker and the scheduled fallback remains cancellable', async () => {
  const { created, factory } = workers()
  const preparer = createAnalysisGeometryPreparer(factory)
  let updates = 0
  preparer.prepare(geometry, () => updates++)
  created[0].onerror!()
  assert.equal(created[0].terminations, 1)
  preparer.cancel()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(updates, 0)
  preparer.destroy()
})

test('failed mask preparation preserves the original boundary and omits incorrect dimming', () => {
  const problematic: Polygon = { type: 'Polygon', coordinates: [] }
  const result = fallbackAnalysisDisplayGeometry(problematic)
  assert.equal(result.boundary, problematic)
  assert.equal(result.outside, null)
})
