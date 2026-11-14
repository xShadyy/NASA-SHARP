export type MeasurementMode = 'ruler' | 'area'
export type DistanceUnit = 'km' | 'mi'
export type AreaUnit = 'ha' | 'ac' | 'km2' | 'mi2'
export type MeasurementUnit = DistanceUnit | AreaUnit

export const measurementUnits = {
  km: { label: 'Kilometers', symbol: 'km', factor: 1, mode: 'ruler' },
  mi: { label: 'Miles', symbol: 'mi', factor: 0.621371192237, mode: 'ruler' },
  ha: { label: 'Hectares', symbol: 'ha', factor: 100, mode: 'area' },
  ac: { label: 'Acres', symbol: 'ac', factor: 247.105381467, mode: 'area' },
  km2: { label: 'Square kilometers', symbol: 'km²', factor: 1, mode: 'area' },
  mi2: { label: 'Square miles', symbol: 'mi²', factor: 0.386102158542, mode: 'area' },
} as const

export function isDistanceUnit(value: string | null): value is DistanceUnit {
  return value === 'km' || value === 'mi'
}

export function isAreaUnit(value: string | null): value is AreaUnit {
  return value === 'ha' || value === 'ac' || value === 'km2' || value === 'mi2'
}
