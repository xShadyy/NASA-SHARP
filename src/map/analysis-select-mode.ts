import type { Polygon } from 'geojson'
import {
  TerraDrawSelectMode,
  type GeoJSONStoreFeatures,
  type TerraDrawMouseEvent,
} from 'terra-draw'

class AnalysisRectangleSelectMode extends TerraDrawSelectMode {
  private rectangleResize: { feature: GeoJSONStoreFeatures<Polygon>; index: number } | null = null

  private onSurface(event: TerraDrawMouseEvent) {
    if (!Number.isFinite(event.lng) || !Number.isFinite(event.lat) || Math.abs(event.lat) > 90)
      return false
    const projected = this.project(event.lng, event.lat)
    return Math.hypot(projected.x - event.containerX, projected.y - event.containerY) <= 2
  }

  onDragStart(event: TerraDrawMouseEvent, setMapDraggability: (enabled: boolean) => void) {
    if (!this.allowPointerEvent(this.pointerEvents.onDragStart, event) || !this.onSurface(event))
      return
    const selected = this.store.copyAllWhere(
      (properties) => properties.mode === 'rectangle' && properties.selected === true,
    )[0]
    if (selected?.geometry.type === 'Polygon') {
      const ring = selected.geometry.coordinates[0]
      let nearest = this.pointerDistance
      let index = -1
      for (let current = 0; current < ring.length - 1; current++) {
        const position = this.project(ring[current][0], ring[current][1])
        const distance = Math.hypot(position.x - event.containerX, position.y - event.containerY)
        if (distance < nearest) {
          nearest = distance
          index = current
        }
      }
      if (ring.length === 5 && index !== -1) {
        this.rectangleResize = { feature: selected as GeoJSONStoreFeatures<Polygon>, index }
        this.setCursor('grabbing')
        setMapDraggability(false)
        return
      }
    }
    super.onDragStart(event, setMapDraggability)
  }

  onDrag(event: TerraDrawMouseEvent, setMapDraggability: (enabled: boolean) => void) {
    if (!this.allowPointerEvent(this.pointerEvents.onDrag, event) || !this.onSurface(event)) return
    const resize = this.rectangleResize
    if (!resize) {
      super.onDrag(event, setMapDraggability)
      return
    }
    const ring = resize.feature.geometry.coordinates[0]
    const corner = ring[resize.index]
    const opposite = ring[(resize.index + 2) % 4]
    const longitude = Number(
      (((((event.lng + 180) % 360) + 360) % 360) - 180).toFixed(this.coordinatePrecision),
    )
    const latitude = Number(event.lat.toFixed(this.coordinatePrecision))
    const longitudeOffset = (lng: number) => ((((lng - opposite[0] + 180) % 360) + 360) % 360) - 180
    if (
      longitudeOffset(longitude) * longitudeOffset(corner[0]) <= 0 ||
      (latitude - opposite[1]) * (corner[1] - opposite[1]) <= 0
    )
      return
    const geometry: Polygon = {
      type: 'Polygon',
      coordinates: [
        ring.map(([lng, lat]) => [
          lng === corner[0] ? longitude : lng,
          lat === corner[1] ? latitude : lat,
        ]),
      ],
    }
    const handles = this.store.copyAllWhere(
      (properties) => properties.selectionPointFeatureId === resize.feature.id,
    )
    this.store.updateGeometry(
      [
        { id: resize.feature.id!, geometry },
        ...handles.map((handle) => ({
          id: handle.id!,
          geometry: {
            type: 'Point' as const,
            coordinates: geometry.coordinates[0][Number(handle.properties.index)],
          },
        })),
      ],
      { target: 'geometry' },
    )
    setMapDraggability(false)
  }

  onDragEnd(event: TerraDrawMouseEvent, setMapDraggability: (enabled: boolean) => void) {
    const resize = this.rectangleResize
    if (!resize) {
      super.onDragEnd(event, setMapDraggability)
      return
    }
    this.onDrag(event, setMapDraggability)
    this.rectangleResize = null
    this.setCursor('grab')
    setMapDraggability(true)
    this.onFinish(resize.feature.id!, { mode: this.mode, action: 'dragCoordinateResize' })
  }

  stop() {
    this.rectangleResize = null
    super.stop()
  }
}

export function createAnalysisSelectMode(tool: 'polygon' | 'rectangle') {
  const SelectMode = tool === 'rectangle' ? AnalysisRectangleSelectMode : TerraDrawSelectMode
  return new SelectMode({
    projection: 'globe',
    keyEvents: null,
    allowManualDeselection: false,
    flags: {
      polygon: {
        feature: {
          selfIntersectable: true,
          draggable: true,
          coordinates: { draggable: true, deletable: true, midpoints: true },
        },
      },
      rectangle: { feature: { draggable: true, coordinates: { resizable: 'opposite' } } },
    },
    cursors: {
      pointerOverFeature: 'move',
      pointerOverResizeHandle: 'grab',
      dragStart: 'grabbing',
    },
    styles: {
      selectedPolygonFillOpacity: 0,
      selectedPolygonOutlineColor: '#ffffff',
      selectedPolygonOutlineWidth: 2,
      selectionPointColor: '#2E96F5',
      selectionPointWidth: tool === 'rectangle' ? 8 : 6,
      selectionPointOutlineColor: '#ffffff',
      selectionPointOutlineWidth: 2,
      midPointColor: '#ffffff',
    },
  })
}
