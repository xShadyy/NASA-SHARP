import type { Map as MapLibreMap } from 'maplibre-gl'
import { geodesicDistanceKm } from '@/lib/geodesy'
import { NASA_LAYER_ID } from '@/map/basemaps'
import { VOLCANO_SOURCE, WDPA_CAPTURE_CREDIT, WDPA_SOURCE } from '@/map/context-overlays'
import { SKY_BACKGROUND_CAPTURE_CREDIT, skyBackgroundVisible } from '@/map/sky-background'

export type CaptureSettings = {
  format: 'jpg' | 'png'
  header: boolean
  timestamp: boolean
  scalebar: boolean
}

/** CSS pixels measured from the map container's top-left corner. */
export type CaptureRegion = { x: number, y: number, width: number, height: number }

const BASE_CREDITS = 'OpenFreeMap · © OpenMapTiles · © OpenStreetMap contributors · Natural Earth'

function clampRegion(map: MapLibreMap, requested?: CaptureRegion | null): CaptureRegion {
  const width = map.getContainer().clientWidth
  const height = map.getContainer().clientHeight
  if (width < 1 || height < 1) throw new Error('The map is not visible. Open the map and try again.')
  if (!requested) return { x: 0, y: 0, width, height }
  if (!Object.values(requested).every(Number.isFinite)) throw new Error('Select the screenshot area again.')
  const x = Math.max(0, Math.min(width, requested.x))
  const y = Math.max(0, Math.min(height, requested.y))
  const right = Math.max(x, Math.min(width, requested.x + requested.width))
  const bottom = Math.max(y, Math.min(height, requested.y + requested.height))
  if (right - x < 24 || bottom - y < 24) throw new Error('Select a larger screenshot area.')
  return { x, y, width: right - x, height: bottom - y }
}

function wrappedLines(context: CanvasRenderingContext2D, value: string, width: number) {
  const lines: string[] = []
  let line = ''
  for (const word of value.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word
    if (line && context.measureText(next).width > width) {
      lines.push(line)
      line = word
    } else line = next
  }
  if (line) lines.push(line)
  return lines
}

/** In globe mode, unproject clamps space to the horizon; reject those samples. */
function groundAt(map: MapLibreMap, x: number, y: number) {
  const location = map.unproject([x, y])
  const projected = map.project(location)
  if (!Number.isFinite(location.lat) || Math.hypot(projected.x - x, projected.y - y) > 1) return null
  return location
}

/** A local ellipsoidal scale, sampled in the captured region, not a Mercator guess. */
function localScale(map: MapLibreMap, region: CaptureRegion) {
  const miles = map.getContainer().dataset.distanceUnit === 'mi'
  const conversion = miles ? 1.609344 : 1
  const maxWidth = Math.min(120, region.width - 32)
  if (maxWidth < 30) return null
  for (const yRatio of [0.5, 0.35, 0.65]) {
    for (const xRatio of [0.5, 0.35, 0.65]) {
      const x = region.x + region.width * xRatio
      const y = region.y + region.height * yRatio
      const from = groundAt(map, x - maxWidth / 2, y)
      const to = groundAt(map, x + maxWidth / 2, y)
      if (!from || !to) continue
      const maximum = geodesicDistanceKm(from.toArray(), to.toArray()) / conversion
      if (!(maximum > 0)) continue
      const magnitude = 10 ** Math.floor(Math.log10(maximum))
      const distance = [5, 2, 1].map((factor) => factor * magnitude).find((value) => value <= maximum) ?? magnitude / 2
      let lower = 0
      let upper = maxWidth
      for (let step = 0; step < 18; step++) {
        const span = (lower + upper) / 2
        const right = groundAt(map, x - maxWidth / 2 + span, y)
        if (!right || geodesicDistanceKm(from.toArray(), right.toArray()) / conversion > distance) upper = span
        else lower = span
      }
      const label = miles
        ? distance < 0.1 ? `${Math.round(distance * 5280)} ft` : `${Number(distance.toPrecision(3))} mi`
        : distance < 1 ? `${Math.round(distance * 1_000)} m` : `${distance.toLocaleString('en', { maximumFractionDigits: 2 })} km`
      return { width: (lower + upper) / 2, label }
    }
  }
  // A region containing only space has no meaningful ground scale.
  return null
}

type PreparedPin = { element: SVGSVGElement, image: HTMLImageElement }

function visibleOpacity(element: Element, container: HTMLElement) {
  let opacity = 1
  for (let current: Element | null = element; current; current = current.parentElement) {
    const style = getComputedStyle(current)
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return 0
    opacity *= Number.parseFloat(style.opacity)
    if (current === container) break
  }
  return opacity
}

/** Pin geometry is already local Phosphor SVG; resolve its inherited color so
 * the standalone SVG image does not depend on the surrounding document CSS. */
async function preparePins(map: MapLibreMap): Promise<PreparedPin[]> {
  const container = map.getContainer()
  const pins = [...container.querySelectorAll<SVGSVGElement>('.destination-pin-symbol')]
  const prepared = await Promise.all(pins.map(async (element): Promise<PreparedPin | null> => {
    if (!visibleOpacity(element, container)) return null
    const svg = element.cloneNode(true) as SVGSVGElement
    const style = getComputedStyle(element)
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    svg.style.color = style.color
    const markup = new XMLSerializer().serializeToString(svg).replace(/currentColor/gi, style.color)
    const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }))
    try {
      const image = await new Promise<HTMLImageElement | null>((resolve) => {
        const img = new Image()
        const timer = setTimeout(() => resolve(null), 2_000)
        img.onload = () => { clearTimeout(timer); resolve(img) }
        img.onerror = () => { clearTimeout(timer); resolve(null) }
        img.src = url
      })
      return image ? { element, image } : null
    } finally { URL.revokeObjectURL(url) }
  }))
  return prepared.filter((pin): pin is PreparedPin => pin !== null)
}

/** Draw only geographic DOM fallbacks, never pin cards or tool windows. Native
 * vector labels are already in the WebGL canvas; these markers cover the polar
 * region that MapLibre's Mercator symbol pipeline cannot represent. */
function drawGeographicOverlays(context: CanvasRenderingContext2D, map: MapLibreMap, region: CaptureRegion, pins: PreparedPin[], ratioX: number, ratioY: number) {
  const container = map.getContainer()
  const mapBounds = container.getBoundingClientRect()
  const boundsFor = (element: Element) => {
    if (!element.isConnected) return null
    const opacity = visibleOpacity(element, container)
    if (!(opacity > 0)) return null
    const bounds = element.getBoundingClientRect()
    const x = bounds.left - mapBounds.left - region.x
    const y = bounds.top - mapBounds.top - region.y
    if (!bounds.width || !bounds.height || x + bounds.width < -6 || y + bounds.height < -6 || x > region.width + 6 || y > region.height + 6) return null
    return { x, y, width: bounds.width, height: bounds.height, opacity }
  }

  // These are z-index 4, below the z-index 5 polar measurement values.
  for (const { element, image } of pins) {
    const bounds = boundsFor(element)
    if (!bounds) continue
    context.save()
    context.globalAlpha = bounds.opacity
    const pixelRatio = Math.sqrt(ratioX * ratioY)
    context.filter = getComputedStyle(element).filter.replace(/(-?[\d.]+)px/g, (_, value: string) => `${Number.parseFloat(value) * pixelRatio}px`)
    context.drawImage(image, bounds.x, bounds.y, bounds.width, bounds.height)
    context.restore()
  }

  for (const element of container.querySelectorAll<HTMLElement>('.measurement-polar-label')) {
    const bounds = boundsFor(element)
    const text = element.textContent
    if (!bounds || !text) continue
    const style = getComputedStyle(element)
    // Composite a label as one group so its halo and glyph share the marker's
    // exact fade opacity, including MapLibre's fade behind the globe.
    const padding = 5
    const label = document.createElement('canvas')
    label.width = Math.ceil((bounds.width + padding * 2) * ratioX)
    label.height = Math.ceil((bounds.height + padding * 2) * ratioY)
    const labelContext = label.getContext('2d')
    if (!labelContext) continue
    labelContext.scale(ratioX, ratioY)
    labelContext.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
    labelContext.textBaseline = 'alphabetic'
    const metrics = labelContext.measureText(text)
    const fontSize = Number.parseFloat(style.fontSize)
    const ascent = metrics.fontBoundingBoxAscent ?? fontSize * 0.8
    const descent = metrics.fontBoundingBoxDescent ?? fontSize * 0.2
    const baseline = padding + (bounds.height - ascent - descent) / 2 + ascent
    labelContext.fillStyle = style.color
    const shadows = style.textShadow === 'none' ? [] : style.textShadow.split(/,(?![^(]*\))/)
    for (const shadow of shadows) {
      const color = shadow.match(/rgba?\([^)]+\)|#[\da-f]+|transparent/i)?.[0]
      const offsets = shadow.match(/-?[\d.]+px/g)?.map(Number.parseFloat)
      if (!color || !offsets || offsets.length < 2) continue
      labelContext.shadowColor = color
      // Canvas shadow lengths use device pixels independently of its transform.
      labelContext.shadowOffsetX = (offsets[0] + 10_000) * ratioX
      labelContext.shadowOffsetY = offsets[1] * ratioY
      labelContext.shadowBlur = (offsets[2] ?? 0) * Math.sqrt(ratioX * ratioY)
      // The glyph is outside this tiny canvas; only its shadow is painted.
      labelContext.fillText(text, padding - 10_000, baseline)
    }
    labelContext.shadowColor = 'transparent'
    labelContext.shadowOffsetX = 0
    labelContext.shadowOffsetY = 0
    labelContext.shadowBlur = 0
    labelContext.fillText(text, padding, baseline)
    context.save()
    context.globalAlpha = bounds.opacity
    context.drawImage(label, bounds.x - padding, bounds.y - padding, label.width / ratioX, label.height / ratioY)
    context.restore()
  }
}

function prepareAnnotations(map: MapLibreMap, context: CanvasRenderingContext2D, region: CaptureRegion, settings: CaptureSettings, scale: ReturnType<typeof localScale>, capturedAt: Date, includeSkyCredit: boolean) {
  const width = region.width
  const compact = width < 420
  const fontSize = compact ? 9 : 11
  const padding = Math.min(12, width / 12)
  const lineHeight = fontSize + 3
  context.font = `400 ${fontSize}px "Fira Sans", sans-serif`
  const container = map.getContainer()
  const nasaVisible = map.getLayer(NASA_LAYER_ID) && map.getLayoutProperty(NASA_LAYER_ID, 'visibility') !== 'none'
  const overlayCredits = container.dataset.overlayCredits?.split(' | ').filter(Boolean) ?? []
  const credits = [BASE_CREDITS,
    ...(nasaVisible ? ['NASA GIBS · Blue Marble / NASA Earth Observatory'] : []),
    ...overlayCredits,
    ...(map.getZoom() >= 4 && map.getLayer('context-protected-areas') && map.getLayoutProperty('context-protected-areas', 'visibility') !== 'none' && map.getSource(WDPA_SOURCE) ? [WDPA_CAPTURE_CREDIT] : []),
    ...(map.getLayer('context-volcanoes') && map.getLayoutProperty('context-volcanoes', 'visibility') !== 'none' && map.getSource(VOLCANO_SOURCE) ? ['Smithsonian / GVP · Volcanoes of the World v5.4.0 (Venzke, 2026)'] : []),
    ...(includeSkyCredit ? [SKY_BACKGROUND_CAPTURE_CREDIT] : [])]
    .flatMap((credit) => wrappedLines(context, credit, Math.max(12, width - padding * 2)))
  const footerLines = [...(settings.timestamp ? [capturedAt.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')] : []), ...credits]
  const tailPadding = padding * 0.75
  const scaleHeight = settings.scalebar && scale ? lineHeight + 20 : 0
  const footerHeight = footerLines.length * lineHeight + tailPadding * 2 + scaleHeight
  const titleHeight = settings.header ? compact ? 29 : 36 : 0

  return { titleHeight, footerHeight, draw(context: CanvasRenderingContext2D, footerY: number) {
    context.fillStyle = '#05122d'
    context.fillRect(0, footerY, width, footerHeight)
    context.fillStyle = '#fff'
    context.textBaseline = 'top'
    context.font = `400 ${fontSize}px "Fira Sans", sans-serif`
    const textWidth = width - padding * 2
    footerLines.forEach((line, index) => {
      context.fillText(line, padding, footerY + tailPadding + index * lineHeight, textWidth)
    })
    if (settings.header) {
      context.fillStyle = '#05122d'
      context.fillRect(0, 0, width, titleHeight)
      context.fillStyle = '#fff'
      const titleFontSize = compact ? 13 : 17
      context.font = `700 ${titleFontSize}px "Fira Sans", sans-serif`
      context.fillText('Ethereal · Earth explorer', padding, (titleHeight - titleFontSize) / 2, textWidth)
    }
    if (scaleHeight && scale) {
      const labelY = footerY + tailPadding + footerLines.length * lineHeight
      const barY = labelY + lineHeight + 11
      context.font = `400 ${fontSize}px "Fira Sans", sans-serif`
      context.fillText(`${scale.label} · local scale`, padding, labelY, textWidth)
      context.strokeStyle = '#fff'
      context.lineWidth = 2
      context.beginPath()
      context.moveTo(padding, barY - 6)
      context.lineTo(padding, barY)
      context.lineTo(padding + scale.width, barY)
      context.lineTo(padding + scale.width, barY - 6)
      context.stroke()
    }
  } }
}

/** Capture during MapLibre's next render, while the WebGL buffer is valid.
 * Geographic measurement layers, visible polar label fallbacks and the selected
 * pin symbol are included. Pin cards and interface panels are excluded.
 * No permanently preserved WebGL drawing buffer or extra renderer is needed. */
export async function captureMapImage(map: MapLibreMap, settings: CaptureSettings, requested?: CaptureRegion | null): Promise<Blob> {
  // Validate immediately and recheck against the dimensions at render time.
  clampRegion(map, requested)
  const pins = await preparePins(map)
  await document.fonts.load('400 12px "Fira Sans"').catch(() => undefined)
  await document.fonts.load('700 17px "Fira Sans"').catch(() => undefined)
  const source = map.getCanvas()
  const output = document.createElement('canvas')
  const context = output.getContext('2d')
  if (!context) throw new Error('Your browser could not create an image. Please try again.')
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      map.off('render', snapshot)
      reject(new Error('The map did not finish rendering. Please try again.'))
    }, 6_000)
    function snapshot() {
      clearTimeout(timer)
      map.off('render', snapshot)
      try {
        const region = clampRegion(map, requested)
        const ratioX = source.width / source.clientWidth
        const ratioY = source.height / source.clientHeight
        if (![ratioX, ratioY].every((ratio) => Number.isFinite(ratio) && ratio > 0)) {
          throw new Error('The map is not visible. Open the map and try again.')
        }
        const imageWidth = Math.max(1, Math.round(region.width * ratioX))
        const imageHeight = Math.max(1, Math.round(region.height * ratioY))
        const outputRatioX = imageWidth / region.width
        const outputRatioY = imageHeight / region.height
        const scale = settings.scalebar ? localScale(map, region) : null
        const annotations = prepareAnnotations(map, context!, region, settings, scale, new Date(), skyBackgroundVisible(map))
        const headerPixels = Math.ceil(annotations.titleHeight * outputRatioY)
        const footerPixels = Math.ceil(annotations.footerHeight * outputRatioY)
        output.width = imageWidth
        output.height = headerPixels + imageHeight + footerPixels
        context!.fillStyle = '#05122d'
        context!.fillRect(0, 0, output.width, output.height)

        context!.save()
        context!.translate(0, headerPixels)
        context!.scale(outputRatioX, outputRatioY)
        context!.beginPath()
        context!.rect(0, 0, region.width, region.height)
        context!.clip()
        context!.fillStyle = '#000'
        context!.fillRect(0, 0, region.width, region.height)
        context!.drawImage(source, region.x * ratioX, region.y * ratioY, region.width * ratioX, region.height * ratioY, 0, 0, region.width, region.height)
        drawGeographicOverlays(context!, map, region, pins, outputRatioX, outputRatioY)
        context!.restore()

        context!.scale(outputRatioX, outputRatioY)
        annotations.draw(context!, (headerPixels + imageHeight) / outputRatioY)
        resolve()
      } catch (error) { reject(error) }
    }
    map.on('render', snapshot)
    map.triggerRepaint()
  })
  return new Promise<Blob>((resolve, reject) => {
    try {
      output.toBlob((blob) => blob ? resolve(blob) : reject(new Error('The browser could not encode this image. Please try PNG.')), settings.format === 'png' ? 'image/png' : 'image/jpeg', 0.94)
    } catch (error) {
      reject(error instanceof DOMException && error.name === 'SecurityError'
        ? new Error('This imagery provider does not allow image export. Choose another background and try again.')
        : error)
    }
  })
}

function previewMapCapture(blob: Blob, filename: string): Promise<void> {
  const dialog = document.createElement('dialog')
  const heading = document.createElement('h2')
  heading.textContent = 'Screenshot preview'
  heading.style.cssText = 'margin:0;font-size:1.15rem'
  dialog.setAttribute('aria-label', heading.textContent)
  dialog.style.cssText = 'width:min(60rem, calc(100% - 2rem));max-height:90dvh;box-sizing:border-box;padding:1rem;border:1px solid #60708b;border-radius:.75rem;background:#101c31;color:#fff;font:inherit'

  const frame = document.createElement('div')
  frame.style.cssText = 'display:grid;place-items:center;margin:1rem 0;background:#071020;border-radius:.375rem;overflow:auto'
  const image = document.createElement('img')
  image.alt = 'Map screenshot with export information'
  image.style.cssText = 'display:block;max-width:100%;max-height:65dvh;width:auto;height:auto;object-fit:contain'
  frame.append(image)

  const actions = document.createElement('div')
  actions.style.cssText = 'display:flex;justify-content:flex-end;align-items:center;flex-wrap:wrap;gap:.75rem'
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.autofocus = true
  cancel.textContent = 'Cancel'
  cancel.style.cssText = 'font:inherit;color:inherit;background:transparent;border:1px solid #8191ad;border-radius:.375rem;padding:.5rem .875rem;cursor:pointer'
  const download = document.createElement('a')
  download.textContent = 'Download'
  download.download = filename
  download.style.cssText = 'color:#fff;background:#2455a6;border-radius:.375rem;padding:.55rem .875rem;text-decoration:none'
  actions.append(cancel, download)
  dialog.append(heading, frame, actions)

  const url = URL.createObjectURL(blob)
  image.src = url
  download.href = url
  const previouslyFocused = document.activeElement
  return new Promise<void>((resolve, reject) => {
    const cleanup = (downloaded: boolean) => {
      dialog.remove()
      if (downloaded) {
        // Give the browser time to start saving before revoking the URL.
        setTimeout(() => URL.revokeObjectURL(url), 60_000)
      } else {
        URL.revokeObjectURL(url)
      }
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) {
        previouslyFocused.focus({ preventScroll: true })
      }
    }

    cancel.addEventListener('click', () => dialog.close('cancel'))
    download.addEventListener('click', (event) => {
      if (!event.defaultPrevented) dialog.close('download')
    })
    image.addEventListener('error', () => {
      if (dialog.open) dialog.close('error')
    })
    dialog.addEventListener('close', () => {
      cleanup(dialog.returnValue === 'download')
      if (dialog.returnValue === 'error') reject(new Error('The screenshot could not be previewed. Please try again.'))
      else resolve()
    }, { once: true })

    document.body.append(dialog)
    try {
      dialog.showModal()
    } catch (error) {
      cleanup(false)
      reject(error)
    }
  })
}

export async function downloadMapCapture(map: MapLibreMap, settings: CaptureSettings, region?: CaptureRegion | null): Promise<void> {
  const blob = await captureMapImage(map, settings, region)
  const extension = blob.type === 'image/png' ? 'png' : settings.format
  const filename = `ethereal-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`
  await previewMapCapture(blob, filename)
}
