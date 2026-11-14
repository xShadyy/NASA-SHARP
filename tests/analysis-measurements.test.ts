import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import type { Feature, Polygon } from 'geojson'
import {
  TerraDraw,
  TerraDrawExtend,
  TerraDrawPolygonMode,
  TerraDrawRectangleMode,
} from 'terra-draw'
import { analysisDrawingMeasurements } from '../src/lib/analysis-measurements'

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

function drawing(tool: 'polygon' | 'rectangle', context: TestContext) {
  const mode =
    tool === 'polygon'
      ? new TerraDrawPolygonMode({ projection: 'globe' })
      : new TerraDrawRectangleMode({ projection: 'globe', drawInteraction: 'click-move' })
  const draw = new TerraDraw({ adapter: new MemoryDrawAdapter(), modes: [mode] })
  draw.start()
  draw.setMode(tool)
  context.after(() => draw.stop())

  const event = (lng: number, lat: number) => ({
    lng,
    lat,
    containerX: lng * 100,
    containerY: lat * 100,
    button: 'left' as const,
    heldKeys: [],
    isContextMenu: false,
  })

  return {
    click: (lng: number, lat: number) => mode.onClick(event(lng, lat)),
    move: (lng: number, lat: number) => mode.onMouseMove(event(lng, lat)),
    snapshot: () => {
      const feature = draw.getSnapshot().find((item) => item.geometry.type === 'Polygon')
      assert.ok(feature)
      return feature as Feature<Polygon>
    },
  }
}

function near(actual: number | null | undefined, expected: number, tolerance = 0.001) {
  assert.equal(typeof actual, 'number')
  assert.ok(Math.abs(actual! - expected) < tolerance, `${actual} should be near ${expected}`)
}

test('the first polygon edge displays distance without an area', (context) => {
  const draw = drawing('polygon', context)
  draw.click(0, 0)
  draw.move(1, 0)

  const values = analysisDrawingMeasurements(draw.snapshot(), false)
  near(values?.edgeKm, 111.319490793)
  assert.equal(values?.areaKm2, null)
  assert.equal(values?.widthKm, null)
  assert.equal(values?.heightKm, null)
})

test('two committed vertices and the moving cursor preview the enclosed polygon area', (context) => {
  const draw = drawing('polygon', context)
  draw.click(0, 0)
  draw.click(1, 0)
  draw.move(1, 1)

  const values = analysisDrawingMeasurements(draw.snapshot(), false)
  near(values?.edgeKm, 110.574388558)
  near(values?.areaKm2, 6154.854786721)
})

test('snapping to close previews the same area as the finished polygon', (context) => {
  const draw = drawing('polygon', context)
  draw.click(0, 0)
  draw.click(1, 0)
  draw.click(1, 1)
  draw.move(0.01, 0.01)

  const snapped = draw.snapshot()
  assert.deepEqual(snapped.geometry.coordinates[0].at(-2), [0, 0])
  const preview = analysisDrawingMeasurements(snapped, false)
  draw.click(0.01, 0.01)
  const finished = analysisDrawingMeasurements(draw.snapshot(), true)

  near(preview?.edgeKm, 156.899568291)
  near(preview?.areaKm2, 6154.854786721)
  assert.equal(preview?.areaKm2, finished?.areaKm2)
  assert.equal(finished?.edgeKm, null)
})

test('rectangle drawing previews width, height and area before the opposite corner is clicked', (context) => {
  const draw = drawing('rectangle', context)
  draw.click(0, 0)
  draw.move(1, 1)

  const preview = analysisDrawingMeasurements(draw.snapshot(), false)
  near(preview?.widthKm, 111.319490793)
  near(preview?.heightKm, 110.574388558)
  near(preview?.areaKm2, 12308.778361469)
  assert.equal(preview?.edgeKm, null)

  draw.click(1, 1)
  assert.deepEqual(analysisDrawingMeasurements(draw.snapshot(), true), preview)
})

test('a polygon edge crossing the antimeridian takes the short geodesic distance', (context) => {
  const draw = drawing('polygon', context)
  draw.click(179, 0)
  draw.move(-179, 0)

  const values = analysisDrawingMeasurements(draw.snapshot(), false)
  near(values?.edgeKm, 222.638981587)
  assert.equal(values?.areaKm2, null)
})

test('rectangle dimensions stay consistent when finishing reverses clockwise ring orientation', (context) => {
  const draw = drawing('rectangle', context)
  draw.click(0, 0)
  draw.move(2, -1)

  const previewFeature = draw.snapshot()
  const preview = analysisDrawingMeasurements(previewFeature, false)
  near(preview?.widthKm, 222.638981587)
  near(preview?.heightKm, 110.574388558)
  assert.ok(preview?.areaKm2 && preview.areaKm2 > 24_600)

  draw.click(2, -1)
  const finishedFeature = draw.snapshot()
  assert.notDeepEqual(finishedFeature.geometry.coordinates, previewFeature.geometry.coordinates)
  assert.deepEqual(analysisDrawingMeasurements(finishedFeature, true), preview)
})

test('duplicate polygon coordinates do not display area before three distinct points exist', () => {
  const feature: Feature<Polygon> = {
    type: 'Feature',
    properties: { mode: 'polygon', committedCoordinateCount: 2 },
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [0, 0],
          [0, 0],
        ],
      ],
    },
  }

  const values = analysisDrawingMeasurements(feature, false)
  near(values?.edgeKm, 111.319490793)
  assert.equal(values?.areaKm2, null)
})
