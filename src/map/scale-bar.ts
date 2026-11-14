import type { Map as MapLibreMap } from 'maplibre-gl'
import { geodesicDistanceKm } from '@/lib/geodesy'
import type { MapView } from './projection'

/** Two local WGS84 scales, sampled from the real map view. At full-Earth scale
 * there is no uniform screen scale; regional globe values refer to map center. */
export function createScaleBar(map: MapLibreMap, output: HTMLOutputElement, getView: () => MapView) {
  const bars = ['km', 'mi'].map((unit) => {
    const bar = document.createElement('span')
    bar.className = 'map-scale-line'
    bar.dataset.unit = unit
    output.append(bar)
    return bar
  })
  let frame = 0
  function ground(x: number, y: number) {
    const p = map.unproject([x, y])
    const screen = map.project(p)
    return Math.hypot(screen.x - x, screen.y - y) < 0.5 ? p.toArray() : null
  }
  function update() {
    frame = 0
    const globe = getView() === 'globe'
    output.hidden = true
    const latitude = Math.min(85.051129, Math.abs(map.getCenter().lat))
    const surfaceZoom = map.getZoom() - Math.log2(Math.cos(latitude * Math.PI / 180))
    if (globe && surfaceZoom < 3.5) return
    const { clientWidth: width, clientHeight: height } = map.getContainer()
    const maximumPixels = Math.min(120, width * 0.25)
    const x = width / 2 - maximumPixels / 2, y = height / 2
    const a = ground(x, y), b = ground(x + maximumPixels, y), mid = ground(x + maximumPixels / 2, y)
    if (!a || !b || !mid) return
    const left = geodesicDistanceKm(a, mid), right = geodesicDistanceKm(mid, b)
    if (!(left + right > 0) || (globe && Math.abs(left - right) / (left + right) > 0.1)) return
    const maxKm = geodesicDistanceKm(a, b)
    bars.forEach((bar, index) => {
      const conversion = index === 1 ? 1.609344 : 1
      const maximum = maxKm / conversion
      const magnitude = 10 ** Math.floor(Math.log10(maximum))
      const distance = [5, 2, 1].map((factor) => factor * magnitude).find((value) => value <= maximum) ?? magnitude / 2
      let lower = 0, upper = maximumPixels
      for (let step = 0; step < 16; step++) {
        const pixels = (lower + upper) / 2
        const p = ground(x + pixels, y)
        if (!p || geodesicDistanceKm(a, p) > distance * conversion) upper = pixels
        else lower = pixels
      }
      const label = `${Number(distance.toPrecision(3))} ${index ? 'mi' : 'km'}`
      bar.style.width = `${(lower + upper) / 2}px`
      bar.textContent = label
    })
    output.setAttribute('aria-label', `Local scale at map center: ${bars.map((bar) => bar.textContent).join(' and ')}`)
    output.title = globe ? 'Local scale at map center' : 'Scale at map center latitude'
    output.hidden = false
  }
  function schedule() { if (!frame) frame = requestAnimationFrame(update) }
  map.on('move', schedule); map.on('resize', schedule)
  update()
  return {
    refresh: schedule,
    destroy() { cancelAnimationFrame(frame); map.off('move', schedule); map.off('resize', schedule); output.hidden = true; output.replaceChildren() },
  }
}
