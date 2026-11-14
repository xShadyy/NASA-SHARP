import type { FeatureCollection, Point } from 'geojson'
import { Popup, type GeoJSONSource, type Map as MapLibreMap, type MapMouseEvent } from 'maplibre-gl'
import {
  FIRE_LEVELS,
  fireLevel,
  firePlatformLabel,
  formatFireTime,
  type FireFeature,
  type FireProperties,
} from '@/lib/fire-severity'
import { FIRE_LAYER_BEFORE_ID } from '@/map/geography'

const SOURCE = 'analysis-observations'
const LAYER = 'analysis-observations-dots'
const empty: FeatureCollection<Point, FireProperties> = { type: 'FeatureCollection', features: [] }

export function createFireDotController(map: MapLibreMap) {
  let disposed = false
  let interactive = true
  let features: FeatureCollection<Point, FireProperties> = empty
  const popup = new Popup({ closeButton: true, maxWidth: '240px', className: 'fire-popup-wrap' })

  function collection(next: FireFeature[]): FeatureCollection<Point, FireProperties> {
    return { type: 'FeatureCollection', features: next }
  }

  function ensure() {
    if (disposed) return
    let style: { layers?: { id: string }[] }
    try {
      style = map.getStyle()
    } catch {
      return
    }
    if (!style) return
    if (!map.getSource(SOURCE)) map.addSource(SOURCE, { type: 'geojson', data: features })
    if (!map.getLayer(LAYER)) {
      const before = map.getLayer(FIRE_LAYER_BEFORE_ID) ? FIRE_LAYER_BEFORE_ID : undefined
      map.addLayer(
        {
          id: LAYER,
          type: 'circle',
          source: SOURCE,
          paint: {
            'circle-color': [
              'match',
              ['get', 'severity'],
              'high',
              FIRE_LEVELS[2].color,
              'moderate',
              FIRE_LEVELS[1].color,
              FIRE_LEVELS[0].color,
            ],
            'circle-radius': [
              'interpolate',
              ['linear'],
              ['zoom'],
              1,
              ['match', ['get', 'severity'], 'high', 3.5, 'moderate', 3, 2.5],
              6,
              ['match', ['get', 'severity'], 'high', 7, 'moderate', 5.5, 4.5],
              12,
              ['match', ['get', 'severity'], 'high', 11, 'moderate', 8.5, 6.5],
            ],
            'circle-stroke-color': '#1a1206',
            'circle-stroke-width': 1.25,
            'circle-opacity': 0.94,
          },
        },
        before,
      )
    }
  }

  function paint() {
    ensure()
    const source = map.getSource(SOURCE) as GeoJSONSource | undefined
    source?.setData(features)
  }

  function onStyleLoad() {
    paint()
  }

  function showPopup(event: MapMouseEvent) {
    if (!interactive || disposed || !map.getLayer(LAYER)) return
    const hit = map.queryRenderedFeatures(event.point, { layers: [LAYER] })[0]
    if (!hit) return
    const properties = hit.properties ?? {}
    const severity = typeof properties.severity === 'string' ? properties.severity : 'low'
    const level = fireLevel(severity)
    const frp = typeof properties.frpMw === 'number' ? properties.frpMw : null
    const root = document.createElement('div')
    root.className = 'fire-popup'
    const title = document.createElement('strong')
    title.textContent = `${level.label} severity`
    const power = document.createElement('p')
    power.textContent = frp === null ? 'Fire radiative power not reported' : `${frp.toFixed(1)} MW`
    root.append(title, power)
    const when = formatFireTime(
      typeof properties.acquiredAt === 'string' ? properties.acquiredAt : '',
    )
    const platform = firePlatformLabel(
      typeof properties.platform === 'string' ? properties.platform : '',
    )
    const sensor = typeof properties.sensor === 'string' ? properties.sensor : ''
    const detail = [when, [sensor, platform].filter(Boolean).join(' · ')].filter(Boolean).join('\n')
    if (detail) {
      const meta = document.createElement('p')
      meta.textContent = detail
      root.append(meta)
    }
    popup.setLngLat(event.lngLat).setDOMContent(root).addTo(map)
  }

  function onEnter() {
    if (interactive) map.getCanvas().style.cursor = 'pointer'
  }

  function onLeave() {
    if (map.getCanvas().style.cursor === 'pointer') map.getCanvas().style.cursor = ''
  }

  map.on('style.load', onStyleLoad)
  map.on('click', LAYER, showPopup)
  map.on('mouseenter', LAYER, onEnter)
  map.on('mouseleave', LAYER, onLeave)
  ensure()

  return {
    setData(next: FireFeature[]) {
      features = collection(next)
      if (!next.length) popup.remove()
      paint()
    },
    setInteractive(next: boolean) {
      interactive = next
      if (!next) {
        popup.remove()
        onLeave()
      }
    },
    destroy() {
      if (disposed) return
      disposed = true
      popup.remove()
      map.off('style.load', onStyleLoad)
      map.off('click', LAYER, showPopup)
      map.off('mouseenter', LAYER, onEnter)
      map.off('mouseleave', LAYER, onLeave)
      onLeave()
      if (map.getLayer(LAYER)) map.removeLayer(LAYER)
      if (map.getSource(SOURCE)) map.removeSource(SOURCE)
    },
  }
}
