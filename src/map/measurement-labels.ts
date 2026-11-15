import type { ExpressionSpecification } from 'maplibre-gl'

export type MeasurementLabelScale = {
  spanKm: number
  labelSize: number
  labelMinSize: number
  labelFadeStart: number
}

const MAX_LABEL_SIZE = 22
const FADE_ZOOM_SPAN = 2
const EARTH_CIRCUMFERENCE_KM = 40_075.017
const MAGNITUDE_SIZES = [12, 13, 15, 18, MAX_LABEL_SIZE]
const SIZE_ZOOM_STOPS = [
  [0, 0.9],
  [5, 0.95],
  [10, 1],
  [18, 1.08],
] as const





export function measurementLabelScale(value: number, area: boolean): MeasurementLabelScale {
  const spanKm = Math.max(0.000_001, area ? Math.sqrt(Math.abs(value)) : Math.abs(value))
  const magnitude = Math.max(0, Math.min(4, Math.log10(spanKm)))
  const index = Math.min(3, Math.floor(magnitude))
  const labelMinSize = area ? 13 : 12
  return {
    spanKm,
    labelSize: Math.max(
      labelMinSize,
      MAGNITUDE_SIZES[index] +
        (MAGNITUDE_SIZES[index + 1] - MAGNITUDE_SIZES[index]) * (magnitude - index),
    ),
    labelMinSize,
    labelFadeStart: Math.max(3.25, Math.log2((10 * EARTH_CIRCUMFERENCE_KM) / (512 * spanKm))),
  }
}

function sizeFactor(zoom: number) {
  for (let index = 1; index < SIZE_ZOOM_STOPS.length; index++) {
    const [end, endFactor] = SIZE_ZOOM_STOPS[index]
    if (zoom > end) continue
    const [start, startFactor] = SIZE_ZOOM_STOPS[index - 1]
    return startFactor + (endFactor - startFactor) * Math.max(0, (zoom - start) / (end - start))
  }
  return SIZE_ZOOM_STOPS.at(-1)![1]
}

function interpolateZoomStops(zoom: number, valueAt: (stop: number) => number) {
  const boundedZoom = Math.max(0, Math.min(20, zoom))
  const start = Math.floor(boundedZoom * 2) / 2
  const startValue = valueAt(start)
  return startValue + (valueAt(Math.min(20, start + 0.5)) - startValue) * (boundedZoom - start) * 2
}

export function measurementLabelSize(scale: MeasurementLabelScale, zoom: number) {
  return interpolateZoomStops(zoom, (stop) =>
    Math.min(MAX_LABEL_SIZE, Math.max(scale.labelMinSize, scale.labelSize * sizeFactor(stop))),
  )
}

export function measurementLabelOpacity(scale: MeasurementLabelScale, zoom: number) {
  return interpolateZoomStops(zoom, (stop) =>
    Math.max(0, Math.min(1, (stop - scale.labelFadeStart) / FADE_ZOOM_SPAN)),
  )
}




const zoomStops = Array.from({ length: 41 }, (_, index) => index / 2)
export const measurementLabelSizeExpression: ExpressionSpecification = [
  'interpolate',
  ['linear'],
  ['zoom'],
  ...zoomStops.flatMap((zoom): [number, ExpressionSpecification] => [
    zoom,
    [
      'min',
      MAX_LABEL_SIZE,
      ['max', ['get', 'labelMinSize'], ['*', ['get', 'labelSize'], sizeFactor(zoom)]],
    ],
  ]),
]
export const measurementLabelOpacityExpression: ExpressionSpecification = [
  'interpolate',
  ['linear'],
  ['zoom'],
  ...zoomStops.flatMap((zoom): [number, ExpressionSpecification] => [
    zoom,
    ['min', 1, ['max', 0, ['/', ['-', zoom, ['get', 'labelFadeStart']], FADE_ZOOM_SPAN]]],
  ]),
]
