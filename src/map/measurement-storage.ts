import { isAreaUnit, isDistanceUnit, type MeasurementMode, type MeasurementUnit } from '@/lib/measurement-units'
import type { GeographicPosition } from '@/lib/geodesy'
import { isMeasurementColor, type MeasurementColor } from './measurement-colors'

export type StoredMeasurement = {
  id: string
  mode: MeasurementMode
  name: string
  color: MeasurementColor
  unit: MeasurementUnit
  points: GeographicPosition[]
}

export const MEASUREMENT_STORAGE_KEY = 'ethereal-finished-measurements-v1'
export const MEASUREMENT_NAME_LIMIT = 80

function validRecord(value: unknown): value is StoredMeasurement {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  if (typeof item.id !== 'string' || !item.id || item.id.length > 100 || typeof item.name !== 'string' || item.name.length > MEASUREMENT_NAME_LIMIT || !isMeasurementColor(item.color)) return false
  if (item.mode !== 'ruler' && item.mode !== 'area') return false
  if (typeof item.unit !== 'string' || !(item.mode === 'ruler' ? isDistanceUnit(item.unit) : isAreaUnit(item.unit))) return false
  return Array.isArray(item.points) && item.points.length >= (item.mode === 'area' ? 3 : 2) && item.points.every((point) => Array.isArray(point) && point.length === 2 && point.every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate)) && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90)
}

function clean(record: StoredMeasurement): StoredMeasurement {
  return { id: record.id, mode: record.mode, name: record.name.trim(), color: record.color, unit: record.unit, points: record.points.map((point) => [...point]) }
}

export function loadFinishedMeasurements(): { records: StoredMeasurement[], failed: boolean } {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(MEASUREMENT_STORAGE_KEY) ?? '[]')
    if (!Array.isArray(value)) return { records: [], failed: true }
    const seen = new Set<string>()
    return {
      records: value.filter(validRecord).filter((record) => {
        if (seen.has(record.id)) return false
        seen.add(record.id)
        return true
      }).map(clean),
      failed: false,
    }
  } catch { return { records: [], failed: true } }
}

/** Save the full collection. Storage quota failures never discard older records. */
export function persistFinishedMeasurements(records: StoredMeasurement[]): boolean {
  try {
    localStorage.setItem(MEASUREMENT_STORAGE_KEY, JSON.stringify(records.map(clean)))
    return true
  } catch { return false }
}
