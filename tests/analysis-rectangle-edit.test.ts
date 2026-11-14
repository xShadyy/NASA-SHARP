import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import type { Polygon } from 'geojson'
import { TerraDraw, TerraDrawExtend, TerraDrawRectangleMode } from 'terra-draw'
import { createAnalysisSelectMode } from '../src/map/analysis-select-mode'

class MemoryDrawAdapter extends TerraDrawExtend.TerraDrawBaseAdapter {
  constructor() {
    super({ coordinatePrecision: 9 })
  }

  register(callbacks: TerraDrawExtend.TerraDrawCallbacks) {
    callbacks.onReady?.()
  }

  unregister() {}
  clear() {}
  render() {}
  setCursor() {}
  setDraggability() {}
  setDoubleClickToZoom() {}

  getMapEventElement(): HTMLElement {
    throw new Error('The memory adapter does not attach DOM listeners.')
  }

  getLngLatFromEvent() {
    return null
  }

  project(lng: number, lat: number) {
    return { x: lng * 100, y: lat * 100 }
  }

  unproject(x: number, y: number) {
    return { lng: x / 100, lat: y / 100 }
  }
}

function editableRectangle(context: TestContext) {
  const id = crypto.randomUUID()
  const select = createAnalysisSelectMode('rectangle')
  const draw = new TerraDraw({
    adapter: new MemoryDrawAdapter(),
    modes: [new TerraDrawRectangleMode({ projection: 'globe' }), select],
  })
  draw.start()
  context.after(() => draw.stop())
  draw.addFeatures([
    {
      type: 'Feature',
      id,
      properties: { mode: 'rectangle' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [4, 45],
            [8, 45],
            [8, 48],
            [4, 48],
            [4, 45],
          ],
        ],
      },
    },
  ])
  draw.selectFeature(id)

  const event = ([lng, lat]: number[]) => ({
    lng,
    lat,
    containerX: lng * 100,
    containerY: lat * 100,
    button: 'left' as const,
    heldKeys: [],
    isContextMenu: false,
  })

  return {
    draw,
    resize(from: number[], to: number[], pointerOffset = [0, 0]) {
      const dragStart = event(from)
      const dragEnd = event(to)
      dragEnd.containerX += pointerOffset[0]
      dragEnd.containerY += pointerOffset[1]
      const draggable: boolean[] = []
      const setDraggable = (value: boolean) => draggable.push(value)
      select.onMouseMove(dragStart)
      select.onDragStart(dragStart, setDraggable)
      select.onDrag(dragEnd, setDraggable)
      select.onDragEnd(dragEnd, setDraggable)
      assert.ok(draggable.includes(false))
      return draw.getSnapshotFeature(id)!.geometry as Polygon
    },
  }
}

function assertRectangle(
  geometry: Polygon,
  west: number,
  south: number,
  east: number,
  north: number,
) {
  const ring = geometry.coordinates[0]
  assert.equal(ring.length, 5)
  assert.deepEqual(ring[0], ring[4])
  assert.deepEqual(new Set(ring.map(([x]) => x)), new Set([west, east]))
  assert.deepEqual(new Set(ring.map(([, y]) => y)), new Set([south, north]))
  for (let index = 1; index < ring.length; index++) {
    assert.ok(ring[index][0] === ring[index - 1][0] || ring[index][1] === ring[index - 1][1])
  }
}

test('editing a rectangle displays four visible resize handles', (context) => {
  const { draw } = editableRectangle(context)
  const handles = draw.getSnapshot().filter((feature) => feature.properties.selectionPoint)
  assert.equal(handles.length, 4)
  const select = createAnalysisSelectMode('rectangle')
  for (const handle of handles) {
    const style = select.styleFeature(handle)
    assert.equal(style.pointWidth, 8)
    assert.equal(style.pointOpacity, 1)
  }
})

test('dragging a rectangle corner resizes both axes and fixes the opposite corner', (context) => {
  const { resize } = editableRectangle(context)
  assertRectangle(resize([8, 48], [10, 50]), 4, 45, 10, 50)
})

test('a rectangle corner can move upward without changing the width', (context) => {
  const { resize } = editableRectangle(context)
  assertRectangle(resize([8, 48], [8, 51]), 4, 45, 8, 51)
})

test('a rectangle corner can move downward without changing the width', (context) => {
  const { resize } = editableRectangle(context)
  assertRectangle(resize([4, 45], [4, 42]), 4, 42, 8, 48)
})

test('resize handles track the changed corners without being recreated', (context) => {
  const { draw, resize } = editableRectangle(context)
  const before = draw.getSnapshot().filter((feature) => feature.properties.selectionPoint)
  const geometry = resize([8, 48], [10, 50])
  const after = draw.getSnapshot().filter((feature) => feature.properties.selectionPoint)
  assert.deepEqual(
    new Set(after.map((feature) => feature.id)),
    new Set(before.map((feature) => feature.id)),
  )
  for (const handle of after) {
    assert.equal(handle.geometry.type, 'Point')
    assert.deepEqual(
      handle.geometry.coordinates,
      geometry.coordinates[0][Number(handle.properties.index)],
    )
  }
})

test('dragging inside the rectangle still moves the shape and preserves rectangular edges', (context) => {
  const { resize } = editableRectangle(context)
  const geometry = resize([6, 46.5], [7, 47.5])
  assertRectangle(geometry, 5, 46, 9, 49)
})

test('dragging outside the globe leaves the rectangle at its last valid position', (context) => {
  const { resize } = editableRectangle(context)
  const geometry = resize([8, 48], [10, 50], [100, 100])
  assertRectangle(geometry, 4, 45, 8, 48)
})
