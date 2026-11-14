import type { MeasurementMode } from '@/lib/measurement-units'

/** Official Space Apps accents, bright enough to distinguish over imagery. */
export const MEASUREMENT_COLORS = [
  { id: 'white', label: 'White', value: '#FFFFFF' },
  { id: 'blue', label: 'Blue Yonder', value: '#2E96F5' },
  { id: 'yellow', label: 'Neon Yellow', value: '#EAFE07' },
  { id: 'red', label: 'Rocket Red', value: '#E43700' },
] as const

export type MeasurementColor = (typeof MEASUREMENT_COLORS)[number]['id']
export type MeasurementColors = Record<MeasurementMode, MeasurementColor>

export const DEFAULT_MEASUREMENT_COLORS: MeasurementColors = { ruler: 'white', area: 'white' }

export function isMeasurementColor(value: unknown): value is MeasurementColor {
  return MEASUREMENT_COLORS.some((option) => option.id === value)
}

export function measurementColorValue(color: MeasurementColor) {
  return MEASUREMENT_COLORS.find((option) => option.id === color)!.value
}
