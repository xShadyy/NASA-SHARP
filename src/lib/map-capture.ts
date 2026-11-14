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

export type CaptureResult = {
  preview: Blob
  image: Blob
}

/** CSS pixels measured from the map container's top-left corner. */
export type CaptureRegion = { x: number; y: number; width: number; height: number }

const BASE_CREDITS = 'OpenFreeMap · © OpenMapTiles · © OpenStreetMap contributors · Natural Earth'

function clampRegion(map: MapLibreMap, requested?: CaptureRegion | null): CaptureRegion {
  const width = map.getContainer().clientWidth
  const height = map.getContainer().clientHeight
  if (width < 1 || height < 1)
    throw new Error('The map is not visible. Open the map and try again.')
  if (!requested) return { x: 0, y: 0, width, height }
  if (!Object.values(requested).every(Number.isFinite))
    throw new Error('Select the screenshot area again.')
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
  if (!Number.isFinite(location.lat) || Math.hypot(projected.x - x, projected.y - y) > 1)
    return null
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
      const distance =
        [5, 2, 1].map((factor) => factor * magnitude).find((value) => value <= maximum) ??
        magnitude / 2
      let lower = 0
      let upper = maxWidth
      for (let step = 0; step < 18; step++) {
        const span = (lower + upper) / 2
        const right = groundAt(map, x - maxWidth / 2 + span, y)
        if (!right || geodesicDistanceKm(from.toArray(), right.toArray()) / conversion > distance)
          upper = span
        else lower = span
      }
      const label = miles
        ? distance < 0.1
          ? `${Math.round(distance * 5280)} ft`
          : `${Number(distance.toPrecision(3))} mi`
        : distance < 1
          ? `${Math.round(distance * 1_000)} m`
          : `${distance.toLocaleString('en', { maximumFractionDigits: 2 })} km`
      return { width: (lower + upper) / 2, label }
    }
  }
  // A region containing only space has no meaningful ground scale.
  return null
}

type PreparedPin = { element: SVGSVGElement; image: HTMLImageElement }

function visibleOpacity(element: Element, container: HTMLElement) {
  let opacity = 1
  for (let current: Element | null = element; current; current = current.parentElement) {
    const style = getComputedStyle(current)
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse'
    )
      return 0
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
  const prepared = await Promise.all(
    pins.map(async (element): Promise<PreparedPin | null> => {
      if (!visibleOpacity(element, container)) return null
      const svg = element.cloneNode(true) as SVGSVGElement
      const style = getComputedStyle(element)
      svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
      svg.style.color = style.color
      const markup = new XMLSerializer()
        .serializeToString(svg)
        .replace(/currentColor/gi, style.color)
      const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }))
      try {
        const image = await new Promise<HTMLImageElement | null>((resolve) => {
          const img = new Image()
          const timer = setTimeout(() => resolve(null), 2_000)
          img.onload = () => {
            clearTimeout(timer)
            resolve(img)
          }
          img.onerror = () => {
            clearTimeout(timer)
            resolve(null)
          }
          img.src = url
        })
        return image ? { element, image } : null
      } finally {
        URL.revokeObjectURL(url)
      }
    }),
  )
  return prepared.filter((pin): pin is PreparedPin => pin !== null)
}

/** Draw only geographic DOM fallbacks, never pin cards or tool windows. Native
 * vector labels are already in the WebGL canvas; these markers cover the polar
 * region that MapLibre's Mercator symbol pipeline cannot represent. */
function drawGeographicOverlays(
  context: CanvasRenderingContext2D,
  map: MapLibreMap,
  region: CaptureRegion,
  pins: PreparedPin[],
  ratioX: number,
  ratioY: number,
) {
  const container = map.getContainer()
  const mapBounds = container.getBoundingClientRect()
  const boundsFor = (element: Element) => {
    if (!element.isConnected) return null
    const opacity = visibleOpacity(element, container)
    if (!(opacity > 0)) return null
    const bounds = element.getBoundingClientRect()
    const x = bounds.left - mapBounds.left - region.x
    const y = bounds.top - mapBounds.top - region.y
    if (
      !bounds.width ||
      !bounds.height ||
      x + bounds.width < -6 ||
      y + bounds.height < -6 ||
      x > region.width + 6 ||
      y > region.height + 6
    )
      return null
    return { x, y, width: bounds.width, height: bounds.height, opacity }
  }

  // These are z-index 4, below the z-index 5 polar measurement values.
  for (const { element, image } of pins) {
    const bounds = boundsFor(element)
    if (!bounds) continue
    context.save()
    context.globalAlpha = bounds.opacity
    const pixelRatio = Math.sqrt(ratioX * ratioY)
    context.filter = getComputedStyle(element).filter.replace(
      /(-?[\d.]+)px/g,
      (_, value: string) => `${Number.parseFloat(value) * pixelRatio}px`,
    )
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
    context.drawImage(
      label,
      bounds.x - padding,
      bounds.y - padding,
      label.width / ratioX,
      label.height / ratioY,
    )
    context.restore()
  }
}

function annotate(
  map: MapLibreMap,
  context: CanvasRenderingContext2D,
  region: CaptureRegion,
  settings: CaptureSettings,
  scale: ReturnType<typeof localScale>,
  capturedAt: Date,
  includeSkyCredit: boolean,
  measureOnly = false,
) {
  const width = region.width
  const height = region.height
  const compact = width < 420
  const fontSize = compact ? 9 : 11
  const padding = Math.min(12, width / 12)
  const lineHeight = fontSize + 3
  context.font = `400 ${fontSize}px "Fira Sans", sans-serif`
  const container = map.getContainer()
  const nasaVisible =
    map.getLayer(NASA_LAYER_ID) && map.getLayoutProperty(NASA_LAYER_ID, 'visibility') !== 'none'
  const overlayCredits = container.dataset.overlayCredits?.split(' | ').filter(Boolean) ?? []
  const credits = [
    BASE_CREDITS,
    ...(nasaVisible ? ['NASA GIBS · Blue Marble / NASA Earth Observatory'] : []),
    ...overlayCredits,
    ...(map.getZoom() >= 4 &&
    map.getLayer('context-protected-areas') &&
    map.getLayoutProperty('context-protected-areas', 'visibility') !== 'none' &&
    map.getSource(WDPA_SOURCE)
      ? [WDPA_CAPTURE_CREDIT]
      : []),
    ...(map.getLayer('context-volcanoes') &&
    map.getLayoutProperty('context-volcanoes', 'visibility') !== 'none' &&
    map.getSource(VOLCANO_SOURCE)
      ? ['Smithsonian / GVP · Volcanoes of the World v5.4.0 (Venzke, 2026)']
      : []),
    ...(includeSkyCredit ? [SKY_BACKGROUND_CAPTURE_CREDIT] : []),
  ].flatMap((credit) => wrappedLines(context, credit, Math.max(12, width - padding * 2)))
  context.font = `700 ${compact ? 13 : 17}px "Fira Sans", sans-serif`
  const titleLines = settings.header
    ? wrappedLines(
        context,
        'SHARP - Satellite Harmonization and Activity Records Platform',
        Math.max(12, width - padding * 2),
      )
    : []
  context.font = `400 ${fontSize}px "Fira Sans", sans-serif`
  const footerLines = [
    ...(settings.timestamp
      ? [
          capturedAt
            .toISOString()
            .replace('T', ' ')
            .replace(/\.\d+Z$/, ' UTC'),
        ]
      : []),
    ...credits,
  ]
  const titleLineHeight = compact ? 17 : 21
  const headerHeight = titleLines.length ? titleLines.length * titleLineHeight + padding * 2 : 0
  const footerHeight = footerLines.length * lineHeight + padding * 2
  if (measureOnly) return { headerHeight, footerHeight }
  const style = getComputedStyle(container)
  const background = style.getPropertyValue('--surface').trim() || '#05122d'
  const foreground = style.getPropertyValue('--text').trim() || '#fff'
  context.save()
  context.translate(0, -headerHeight)
  context.fillStyle = background
  context.fillRect(0, 0, width, headerHeight)
  context.restore()
  context.fillStyle = background
  context.fillRect(0, height, width, footerHeight)
  context.fillStyle = foreground
  context.textBaseline = 'top'
  context.font = `700 ${compact ? 13 : 17}px "Fira Sans", sans-serif`
  titleLines.forEach((line, index) =>
    context.fillText(
      line,
      padding,
      -headerHeight + padding + index * titleLineHeight,
      width - padding * 2,
    ),
  )
  context.font = `400 ${fontSize}px "Fira Sans", sans-serif`
  footerLines.forEach((line, index) =>
    context.fillText(line, padding, height + padding + index * lineHeight, width - padding * 2),
  )
  if (settings.scalebar && scale && height > 55) {
    const y = height - 13
    context.save()
    context.fillStyle = '#fff'
    context.font = '400 10px "Fira Sans", sans-serif'
    context.textAlign = 'center'
    context.shadowColor = '#000'
    context.shadowBlur = 2 * map.getPixelRatio()
    context.shadowOffsetY = map.getPixelRatio()
    context.fillText(scale.label, padding + 3 + scale.width / 2, y - 20)
    context.strokeStyle = '#fff'
    context.lineWidth = 2
    context.beginPath()
    context.moveTo(padding + 3, y - 8)
    context.lineTo(padding + 3, y - 1)
    context.lineTo(padding + 3 + scale.width, y - 1)
    context.lineTo(padding + 3 + scale.width, y - 8)
    context.stroke()
    context.restore()
  }
  return { headerHeight, footerHeight }
}

/** Capture during MapLibre's next render, while the WebGL buffer is valid.
 * Geographic measurement layers, visible polar label fallbacks and the selected
 * pin symbol are included. Pin cards and interface panels are excluded.
 * No permanently preserved WebGL drawing buffer or extra renderer is needed. */
export async function captureMapImage(
  map: MapLibreMap,
  settings: CaptureSettings,
  requested?: CaptureRegion | null,
): Promise<CaptureResult> {
  const region = clampRegion(map, requested)
  const pins = await preparePins(map)
  await document.fonts.load('400 12px "Fira Sans"').catch(() => undefined)
  await document.fonts.load('700 17px "Fira Sans"').catch(() => undefined)
  const source = map.getCanvas()
  const ratioX = source.width / source.clientWidth
  const ratioY = source.height / source.clientHeight
  const output = document.createElement('canvas')
  output.width = Math.max(1, Math.round(region.width * ratioX))
  output.height = Math.max(1, Math.round(region.height * ratioY))
  const preview = document.createElement('canvas')
  preview.width = output.width
  preview.height = output.height
  const previewContext = preview.getContext('2d')
  const context = output.getContext('2d')
  if (!context || !previewContext)
    throw new Error('Your browser could not create an image. Please try again.')
  const scale = settings.scalebar ? localScale(map, region) : null
  const capturedAt = new Date()
  const includeSkyCredit = skyBackgroundVisible(map)
  const { headerHeight, footerHeight } = annotate(
    map,
    context,
    region,
    settings,
    scale,
    capturedAt,
    includeSkyCredit,
    true,
  )
  output.height = Math.max(1, Math.ceil((headerHeight + region.height + footerHeight) * ratioY))
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      map.off('render', snapshot)
      reject(new Error('The map did not finish rendering. Please try again.'))
    }, 6_000)
    function snapshot() {
      clearTimeout(timer)
      map.off('render', snapshot)
      try {
        previewContext!.scale(ratioX, ratioY)
        previewContext!.fillStyle = '#000'
        previewContext!.fillRect(0, 0, region.width, region.height)
        previewContext!.drawImage(
          source,
          region.x * ratioX,
          region.y * ratioY,
          region.width * ratioX,
          region.height * ratioY,
          0,
          0,
          region.width,
          region.height,
        )
        drawGeographicOverlays(previewContext!, map, region, pins, ratioX, ratioY)
        context!.scale(ratioX, ratioY)
        context!.translate(0, headerHeight)
        context!.drawImage(preview, 0, 0, region.width, region.height)
        annotate(map, context!, region, settings, scale, capturedAt, includeSkyCredit)
        resolve()
      } catch (error) {
        reject(error)
      }
    }
    map.on('render', snapshot)
    map.triggerRepaint()
  })
  const [previewBlob, image] = await Promise.all([
    encodeCaptureImage(preview, settings.format),
    encodeCaptureImage(output, settings.format),
  ])
  return { preview: previewBlob, image }
}

function encodeCaptureImage(canvas: HTMLCanvasElement, format: CaptureSettings['format']) {
  return new Promise<Blob>((resolve, reject) => {
    try {
      canvas.toBlob(
        (blob) =>
          blob
            ? resolve(blob)
            : reject(new Error('The browser could not encode this image. Please try PNG.')),
        format === 'png' ? 'image/png' : 'image/jpeg',
        0.94,
      )
    } catch (error) {
      reject(
        error instanceof DOMException && error.name === 'SecurityError'
          ? new Error(
              'This imagery provider does not allow image export. Choose another background and try again.',
            )
          : error,
      )
    }
  })
}
