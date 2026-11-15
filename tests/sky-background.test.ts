import assert from 'node:assert/strict'
import test from 'node:test'
import type { Map as MapLibreMap } from 'maplibre-gl'
import { createSkyBackgroundLayer, SKY_BACKGROUND_IMAGE } from '../src/map/sky-background'
import { GLOBE_PROJECTION, globeSurfaceVisible } from '../src/map/projection'

test('the public globe mode keeps the star background at overview and uses native close-zoom precision', () => {
  assert.equal(GLOBE_PROJECTION, 'globe')
  let type: unknown = 'globe',
    zoom = 2
  const map = { getProjection: () => ({ type }), getZoom: () => zoom } as Pick<
    MapLibreMap,
    'getProjection' | 'getZoom'
  >
  assert.equal(globeSurfaceVisible(map), true)
  type = ['interpolate', ['linear'], ['zoom'], 11, 'vertical-perspective', 12, 'mercator']
  assert.equal(globeSurfaceVisible(map), true)
  zoom = 12
  assert.equal(globeSurfaceVisible(map), false)
  type = 'mercator'
  zoom = 2
  assert.equal(globeSurfaceVisible(map), false)
})

class FakeCanvas {
  listeners = new Map<string, Set<() => void>>()
  addEventListener(type: string, listener: () => void) {
    const list = this.listeners.get(type) ?? new Set()
    list.add(listener)
    this.listeners.set(type, list)
  }
  removeEventListener(type: string, listener: () => void) {
    this.listeners.get(type)?.delete(listener)
  }
  emit(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener()
  }
}
class FakeImage {
  static instances: FakeImage[] = []
  complete = false
  naturalWidth = 2048
  naturalHeight = 1024
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  src = ''
  constructor() {
    FakeImage.instances.push(this)
  }
  finish() {
    this.complete = true
    this.onload?.()
  }
}

function setup(context: { after: (callback: () => void) => void }) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Image')
  FakeImage.instances = []
  Object.defineProperty(globalThis, 'Image', {
    configurable: true,
    writable: true,
    value: FakeImage,
  })
  context.after(() => {
    if (original) Object.defineProperty(globalThis, 'Image', original)
    else Reflect.deleteProperty(globalThis, 'Image')
  })
  const calls = new Map<string, number>()
  const properties: Record<string, unknown> = {
    drawingBufferWidth: 1500,
    drawingBufferHeight: 1000,
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    MAX_TEXTURE_SIZE: 5,
    UNPACK_FLIP_Y_WEBGL: 6,
    UNPACK_PREMULTIPLY_ALPHA_WEBGL: 7,
  }
  const gl = new Proxy(properties, {
    get(target, key) {
      if (typeof key !== 'string') return undefined
      if (key in target) return target[key]
      return (...args: unknown[]) => {
        calls.set(key, (calls.get(key) ?? 0) + 1)
        if (key.startsWith('create') || key === 'getUniformLocation') return { kind: key }
        if (key === 'getShaderParameter' || key === 'getProgramParameter') return true
        if (key === 'isContextLost') return false
        if (key === 'getParameter') return args[0] === properties.MAX_TEXTURE_SIZE ? 8192 : false
        if (key === 'isProgram')
          throw new Error('Synchronous program validation is forbidden during navigation')
        return undefined
      }
    },
  }) as unknown as WebGL2RenderingContext
  const canvas = new FakeCanvas(),
    container = { dataset: {} as Record<string, string> }
  let repaints = 0,
    ready = 0,
    failed = 0
  const map = {
    getCanvas: () => canvas,
    getContainer: () => container,
    getProjection: () => ({ type: 'vertical-perspective' }),
    getCenter: () => ({ lng: 18, lat: 12 }),
    getBearing: () => 0,
    getRoll: () => 0,
    getPitch: () => 0,
    triggerRepaint: () => {
      repaints++
    },
  } as unknown as MapLibreMap
  const layer = createSkyBackgroundLayer({
    onReady: () => {
      ready++
    },
    onError: () => {
      failed++
    },
  })
  layer.onAdd?.(map, gl)
  const render = () => layer.render(gl, {} as never)
  const count = (name: string) => calls.get(name) ?? 0
  context.after(() => layer.onRemove?.(map, gl))
  return {
    layer,
    render,
    gl,
    map,
    canvas,
    container,
    count,
    state: () => ({ repaints, ready, failed }),
  }
}

test('sky navigation compiles once and avoids synchronous isProgram checks on every frame', (context) => {
  const { layer, render, count, state, container } = setup(context)
  assert.equal(FakeImage.instances.length, 1)
  assert.equal(FakeImage.instances[0].src, SKY_BACKGROUND_IMAGE)
  render()
  assert.equal(count('compileShader'), 0)
  FakeImage.instances[0].finish()
  for (let index = 0; index < 120; index++) render()
  assert.equal(count('isProgram'), 0)
  assert.equal(count('compileShader'), 2)
  assert.equal(count('linkProgram'), 1)
  assert.equal(count('texImage2D'), 1)
  assert.equal(count('drawArrays'), 120)
  assert.equal(state().ready, 1)
  assert.equal(state().failed, 0)
  assert.equal(container.dataset.skyBackground, 'ready')
  layer.setVisible(false)
  render()
  assert.equal(count('drawArrays'), 120)
  layer.setVisible(true)
  render()
  assert.equal(count('drawArrays'), 121)
  assert.equal(count('compileShader'), 2)
  assert.equal(FakeImage.instances.length, 1)
})

test('context restoration recreates resources once and removal cleans callbacks and GL handles', (context) => {
  const { layer, render, gl, map, canvas, container, count, state } = setup(context)
  const image = FakeImage.instances[0]
  image.finish()
  render()
  assert.equal(canvas.listeners.get('webglcontextrestored')?.size, 1)
  canvas.emit('webglcontextrestored')
  assert.equal(
    count('compileShader'),
    2,
    'Restoration defers compilation until the next rendered frame',
  )
  for (let index = 0; index < 60; index++) render()
  assert.equal(count('compileShader'), 4)
  assert.equal(count('linkProgram'), 2)
  assert.equal(count('texImage2D'), 2)
  assert.equal(count('isProgram'), 0)
  assert.equal(state().ready, 2)
  assert.equal(state().failed, 0)
  layer.onRemove?.(map, gl)
  assert.equal(canvas.listeners.get('webglcontextrestored')?.size, 0)
  assert.equal(image.onload, null)
  assert.equal(image.onerror, null)
  assert.equal(container.dataset.skyBackground, undefined)
  assert.equal(container.dataset.skyBackgroundEnabled, undefined)
  assert.equal(count('deleteProgram'), 1)
  assert.equal(count('deleteTexture'), 1)
  assert.equal(count('deleteVertexArray'), 1)
  const repaints = state().repaints,
    draws = count('drawArrays')
  canvas.emit('webglcontextrestored')
  render()
  assert.equal(state().repaints, repaints)
  assert.equal(count('drawArrays'), draws)
})
