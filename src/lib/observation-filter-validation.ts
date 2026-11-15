import type { ObservationFilters } from './investigation'

export const RECORD_SEARCH_DEBOUNCE_MS = 300

export type ObservationFilterErrors = Partial<Record<keyof ObservationFilters, string>>

export function validateObservationFilters(filters: ObservationFilters): ObservationFilterErrors {
  const errors: ObservationFilterErrors = {}
  for (const key of ['frpMin', 'frpMax', 'frpMaxExclusive'] as const) {
    const value = filters[key]
    if (value !== undefined && (!Number.isFinite(value) || value < 0))
      errors[key] = 'Enter a finite FRP value of 0 MW or more.'
  }
  if (
    filters.frpMin !== undefined &&
    filters.frpMax !== undefined &&
    filters.frpMin > filters.frpMax
  )
    errors.frpMax = 'Maximum FRP must be at least the minimum FRP.'
  if (
    filters.frpMin !== undefined &&
    filters.frpMaxExclusive !== undefined &&
    filters.frpMin >= filters.frpMaxExclusive
  )
    errors.frpMaxExclusive = 'The exclusive maximum FRP must exceed the minimum.'
  for (const key of ['modisConfidenceMin', 'modisConfidenceMax'] as const) {
    const value = filters[key]
    if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > 100))
      errors[key] = 'MODIS confidence must be a whole number from 0 to 100.'
  }
  if (
    filters.modisConfidenceMin !== undefined &&
    filters.modisConfidenceMax !== undefined &&
    filters.modisConfidenceMin > filters.modisConfidenceMax
  )
    errors.modisConfidenceMax = 'Maximum MODIS confidence must be at least the minimum.'
  if (
    filters.viirsConfidence &&
    (!filters.viirsConfidence.length ||
      filters.viirsConfidence.some(
        (value) => !['low', 'nominal', 'high', 'unknown'].includes(value),
      ))
  )
    errors.viirsConfidence = 'Choose a native VIIRS confidence class.'
  for (const key of ['acquiredStart', 'acquiredEndExclusive'] as const) {
    const value = filters[key]
    if (value !== undefined) {
      const valid =
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?Z$/.test(value) &&
        Number.isFinite(Date.parse(value)) &&
        new Date(value).toISOString().slice(0, 16) === value.slice(0, 16)
      if (!valid) errors[key] = 'Enter a valid UTC acquisition date and time.'
    }
  }
  if (
    filters.acquiredStart &&
    filters.acquiredEndExclusive &&
    Date.parse(filters.acquiredStart) >= Date.parse(filters.acquiredEndExclusive)
  )
    errors.acquiredEndExclusive = 'The exclusive end must be after the start.'
  return errors
}

export function recordFilterDelay(previous: ObservationFilters, next: ObservationFilters) {
  return previous.search !== next.search || previous.source !== next.source
    ? RECORD_SEARCH_DEBOUNCE_MS
    : 0
}
