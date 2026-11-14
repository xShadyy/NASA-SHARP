import type { MeasurementColor } from '@/map/measurement-colors'

export const LOCATION_ICONS = [
  { id: 'pin', label: 'Pin' },
  { id: 'star', label: 'Star' },
  { id: 'flag', label: 'Flag' },
  { id: 'house', label: 'House' },
  { id: 'mountain', label: 'Mountain' },
  { id: 'tree', label: 'Tree' },
  { id: 'fire', label: 'Fire' },
  { id: 'planet', label: 'Planet' },
] as const

export type LocationIcon = (typeof LOCATION_ICONS)[number]['id']
export type LocationAppearance = { icon: LocationIcon; color: MeasurementColor }

export const DEFAULT_LOCATION_APPEARANCE: LocationAppearance = { icon: 'pin', color: 'blue' }

export function isLocationIcon(value: unknown): value is LocationIcon {
  return LOCATION_ICONS.some((option) => option.id === value)
}
