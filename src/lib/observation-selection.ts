import { firePlatformLabel, type FireFeature } from './fire-severity'

export type ObservationSelectionFilters = {
  search: string
  platform: string
  sensor: string
  dayNight: string
  start: string
  end: string
  frpMin: string
  frpMax: string
  confidence: string
  sort: 'newest' | 'oldest' | 'frp'
  groupBy: 'none' | 'date' | 'hour' | 'satellite'
}

export const emptyObservationFilters = (): ObservationSelectionFilters => ({
  search: '',
  platform: '',
  sensor: '',
  dayNight: '',
  start: '',
  end: '',
  frpMin: '',
  frpMax: '',
  confidence: '',
  sort: 'newest',
  groupBy: 'none',
})

export function nativeConfidence(feature: FireFeature) {
  const p = feature.properties
  const confidence = p.confidence
  if (confidence && typeof confidence === 'object')
    return String((confidence as Record<string, unknown>).value ?? 'unknown')
  return String(p.confidencePct ?? p.confidenceClass ?? confidence ?? 'unknown')
}

export function observationDayNight(feature: FireFeature) {
  const value = String(feature.properties.dayNight ?? '').toLowerCase()
  return value === 'd' || value === 'day'
    ? 'day'
    : value === 'n' || value === 'night'
      ? 'night'
      : 'unknown'
}

export function observationGroup(
  feature: FireFeature,
  groupBy: ObservationSelectionFilters['groupBy'],
) {
  const p = feature.properties
  if (groupBy === 'satellite') return firePlatformLabel(p.platform) || 'Unknown satellite'
  if (groupBy === 'date') return p.utcDay ? p.utcDay + ' UTC' : 'Unknown UTC date'
  if (groupBy === 'hour')
    return p.acquiredAt
      ? p.acquiredAt.slice(0, 13).replace('T', ', ') +
          ':00–' +
          p.acquiredAt.slice(11, 13) +
          ':59 UTC'
      : 'Unknown UTC hour'
  return ''
}

/** Works on frozen canonical membership, never on a rendered page or camera bounds. */
export function queryObservationSelection(
  features: readonly FireFeature[],
  filters: ObservationSelectionFilters,
) {
  const search = filters.search.trim().toLowerCase()
  const start = filters.start ? Date.parse(filters.start + 'Z') : -Infinity
  const end = filters.end ? Date.parse(filters.end + 'Z') : Infinity
  const minimum = filters.frpMin === '' ? -Infinity : Number(filters.frpMin)
  const maximum = filters.frpMax === '' ? Infinity : Number(filters.frpMax)
  const matching = features.filter((feature) => {
    const p = feature.properties
    if (
      search &&
      ![
        p.id,
        p.platform,
        firePlatformLabel(p.platform),
        p.sensor,
        p.source,
        p.sourceProduct,
        p.product,
        p.provenance,
      ]
        .join(' ')
        .toLowerCase()
        .includes(search)
    )
      return false
    if (filters.platform && p.platform !== filters.platform) return false
    if (filters.sensor && p.sensor !== filters.sensor) return false
    if (filters.dayNight && observationDayNight(feature) !== filters.dayNight) return false
    if (p.acquiredEpoch < start || p.acquiredEpoch >= end) return false
    if (
      (filters.frpMin !== '' || filters.frpMax !== '') &&
      (p.frpMw === null || p.frpMw < minimum || p.frpMw > maximum)
    )
      return false
    if (
      filters.confidence &&
      p.sensor + ':' + nativeConfidence(feature).toLowerCase() !== filters.confidence
    )
      return false
    return true
  })
  matching.sort((a, b) => {
    const value =
      filters.sort === 'oldest'
        ? a.properties.acquiredEpoch - b.properties.acquiredEpoch
        : filters.sort === 'frp'
          ? (b.properties.frpMw ?? -Infinity) - (a.properties.frpMw ?? -Infinity)
          : b.properties.acquiredEpoch - a.properties.acquiredEpoch
    return (Number.isNaN(value) ? 0 : value) || a.properties.id.localeCompare(b.properties.id)
  })
  if (filters.groupBy !== 'none')
    matching.sort((a, b) =>
      observationGroup(a, filters.groupBy).localeCompare(observationGroup(b, filters.groupBy)),
    )
  const counts = new Map<string, number>()
  for (const feature of matching) {
    const group = observationGroup(feature, filters.groupBy)
    counts.set(group, (counts.get(group) ?? 0) + 1)
  }
  return { matching, counts }
}

export function matchesObservationFilters(feature: FireFeature, filters: Record<string, unknown>) {
  const local = emptyObservationFilters()
  for (const key of ['search', 'platform', 'sensor', 'dayNight'] as const)
    if (typeof filters[key] === 'string') local[key] = filters[key] as string
  if (typeof filters.frpMin === 'number') local.frpMin = String(filters.frpMin)
  if (typeof filters.frpMax === 'number') local.frpMax = String(filters.frpMax)
  if (!queryObservationSelection([feature], local).matching.length) return false
  const p = feature.properties
  if (filters.observationId && p.id !== filters.observationId) return false
  if (filters.day && p.utcDay !== filters.day) return false
  if (
    typeof filters.source === 'string' &&
    filters.source &&
    ![p.sourceProduct, p.source, p.provenance].includes(filters.source)
  )
    return false
  if (
    typeof filters.acquiredStart === 'string' &&
    p.acquiredEpoch < Date.parse(filters.acquiredStart)
  )
    return false
  if (
    typeof filters.acquiredEndExclusive === 'string' &&
    p.acquiredEpoch >= Date.parse(filters.acquiredEndExclusive)
  )
    return false
  if (filters.frpUnknown === true && p.frpMw !== null) return false
  if (
    typeof filters.frpMaxExclusive === 'number' &&
    (p.frpMw === null || p.frpMw >= filters.frpMaxExclusive)
  )
    return false
  const confidence = nativeConfidence(feature).toLowerCase()
  if (
    typeof filters.modisConfidenceMin === 'number' ||
    typeof filters.modisConfidenceMax === 'number' ||
    filters.modisConfidenceUnknown
  ) {
    if (p.sensor !== 'MODIS') return false
    if (filters.modisConfidenceUnknown && confidence !== 'unknown') return false
    if (
      !filters.modisConfidenceUnknown &&
      (confidence === 'unknown' || !Number.isFinite(Number(confidence)))
    )
      return false
    if (
      typeof filters.modisConfidenceMin === 'number' &&
      Number(confidence) < filters.modisConfidenceMin
    )
      return false
    if (
      typeof filters.modisConfidenceMax === 'number' &&
      Number(confidence) > filters.modisConfidenceMax
    )
      return false
  }
  if (
    Array.isArray(filters.viirsConfidence) &&
    filters.viirsConfidence.length &&
    (p.sensor !== 'VIIRS' || !filters.viirsConfidence.includes(confidence))
  )
    return false
  return true
}
