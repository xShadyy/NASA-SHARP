import assert from 'node:assert/strict'
import test from 'node:test'
import type { Polygon } from 'geojson'
import { createBoundaryGeometryClient } from '../src/map/boundary-geometry-client'
import { prepareCountryDisplayGeometry } from '../src/map/analysis-geometry'

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

const source: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [3, 50],
      [7, 50],
      [7, 54],
      [3, 54],
      [3, 50],
    ],
  ],
}

test('boundary worker preparation resolves separate display geometry and releases its worker', async () => {
  const worker = new FakeWorker()
  const prepare = createBoundaryGeometryClient(() => worker as unknown as Worker)
  const preferredBounds: [[number, number], [number, number]] = [
    [3, 49],
    [8, 55],
  ]
  const pending = prepare(source, { preferredBounds })
  assert.deepEqual(worker.messages, [{ type: 'country', geometry: source, preferredBounds }])
  const result = prepareCountryDisplayGeometry(source, preferredBounds)
  worker.onmessage!({ data: { result } })
  assert.equal(await pending, result)
  assert.equal(worker.terminations, 1)
  assert.equal(worker.onmessage, null)
})

test('cancellation terminates preparation and a late country result cannot resolve it', async () => {
  const worker = new FakeWorker()
  const prepare = createBoundaryGeometryClient(() => worker as unknown as Worker)
  const controller = new AbortController()
  const pending = prepare(source, { signal: controller.signal })
  const lateMessage = worker.onmessage!
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  controller.abort()
  lateMessage({ data: { result: prepareCountryDisplayGeometry(source) } })
  await rejected
  assert.equal(worker.terminations, 1)
})

test('worker failure rejects without returning a partial boundary', async () => {
  const worker = new FakeWorker()
  const prepare = createBoundaryGeometryClient(() => worker as unknown as Worker)
  const pending = prepare(source)
  const rejected = assert.rejects(pending, /worker failed/)
  worker.onerror!()
  await rejected
  assert.equal(worker.terminations, 1)
})

test('an already-canceled request never starts a worker', async () => {
  let workers = 0
  const prepare = createBoundaryGeometryClient(() => {
    workers++
    return new FakeWorker() as unknown as Worker
  })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(prepare(source, { signal: controller.signal }), { name: 'AbortError' })
  assert.equal(workers, 0)
})

test('a blocked worker uses a cancellable precise preparation fallback', async () => {
  const prepare = createBoundaryGeometryClient(() => {
    throw new Error('Worker blocked')
  })
  const result = await prepare(source)
  assert.equal(result.displayGeometry.type, 'Polygon')
  assert.deepEqual(source.coordinates, [
    [
      [3, 50],
      [7, 50],
      [7, 54],
      [3, 54],
      [3, 50],
    ],
  ])
  const controller = new AbortController()
  const pending = prepare(source, { signal: controller.signal })
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  controller.abort()
  await rejected
})
