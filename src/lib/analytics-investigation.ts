import type { AnalysisMetadata } from './analysis-api'
import type { HotspotDetection, HotspotResponse } from './area-analytics'
import type { InvestigationScope, ObservationFilters } from './investigation'

export type CanonicalObservation = {
  id: string
  acquiredAt: string
  sensor: string
  platform: string
  longitude: number
  latitude: number
  frpMw: number | null
  dayNight: string
  confidence: {
    kind: string
    value: string | number | null
    unit?: string
    nativeValue?: string | number
  }
  scanKm: number | null
  trackKm: number | null
  nominalResolutionM: number | null
  provenance: string | null
  sourceProduct: string | null
  productVersion: string | null
  processingTier: string | null
  groupKey?: string
}
export type ObservationFacet = {
  key: string
  label: string
  count: number
  options: ObservationFilters
}
export type ObservationPage = {
  data: {
    rows: CanonicalObservation[]
    total: number
    page: number
    pageSize: number
    groups: Array<{ key: string; label: string; count: number }>
    summary: {
      wholeAreaCount: number
      selectedCount: number
      matchingCount: number
      earliestAcquisition: string | null
      latestAcquisition: string | null
      platforms: string[]
      maxFrpMw: number | null
      facets?: Record<string, ObservationFacet[]>
      dailyCoverage?: Record<string, string>
      statistics?: {
        medianFrp: number | null
        frpReported: number
        latest: CanonicalObservation | null
        highestFrp: CanonicalObservation | null
        topCells: Array<{ label: string; count: number; longitude: number; latitude: number }>
      }
    }
  }
  meta: AnalysisMetadata & { sources?: unknown[]; snapshotId?: string; selectionScope?: string }
}

export type ObservationDay = { date: string; count: number | null; coverage: string }
export function fullIntervalObservationScope(scope: InvestigationScope): InvestigationScope {
  return { ...scope, focusedDay: null, filters: { ...scope.filters, day: undefined } }
}
/** Reporting coverage, rather than hotspot presence, determines reported zeroes. */
export function observationDays(
  page: ObservationPage,
  scope: InvestigationScope,
): ObservationDay[] {
  const counts = new Map(
    (page.data.summary.facets?.daily ?? []).map((item) => [item.key, item.count]),
  )
  const coverage = page.data.summary.dailyCoverage ?? {}
  const days: ObservationDay[] = []
  for (
    let time = Date.parse(scope.range.start);
    time <= Date.parse(scope.range.end);
    time += 86400000
  ) {
    const date = new Date(time).toISOString().slice(0, 10)
    const state = coverage[date] ?? 'unavailable'
    days.push({
      date,
      count: counts.get(date) ?? (state === 'complete' ? 0 : null),
      coverage: state,
    })
  }
  return days
}

export function scopeObservationOptions(
  scope: InvestigationScope,
  page = 1,
  pageSize = 25,
  sort = 'newest',
  groupBy = 'none',
) {
  return {
    ...scope.filters,
    day: scope.focusedDay ?? scope.filters.day,
    sourceGeneration: scope.selection?.sourceGeneration ?? scope.metadata?.sourceGeneration,
    selectionToken: scope.selection?.selectionToken,
    page,
    pageSize,
    sort,
    groupBy,
  }
}

export function scopeExportIdentity(scope: InvestigationScope) {
  const copy = structuredClone(scope)
  if (copy.selection?.selectionToken || copy.selection?.global) delete copy.selection.observationIds
  return copy
}

export function chartFilter(
  kind: 'product' | 'confidence' | 'frp' | 'hour',
  label: string | number,
): ObservationFilters {
  if (kind === 'hour') return { acquisitionHour: Number(label) }
  const text = String(label).toLowerCase()
  if (kind === 'product') {
    const platforms: Record<string, string> = {
      aqua: 'aqua',
      terra: 'terra',
      'suomi npp': 'suomi-npp',
      'suomi-npp': 'suomi-npp',
      'noaa-20': 'noaa-20',
      'noaa-21': 'noaa-21',
    }
    const platform = platforms[text]
    return platform ? { platform } : { source: String(label) }
  }
  if (kind === 'confidence') {
    if (text.startsWith('viirs')) {
      const native = text.replace(/^viirs\s*/, '')
      return {
        sensor: 'VIIRS',
        modisConfidenceMin: undefined,
        modisConfidenceMax: undefined,
        modisConfidenceUnknown: undefined,
        viirsConfidence: [{ l: 'low', n: 'nominal', h: 'high' }[native] ?? native],
      }
    }
    if (text.includes('unknown'))
      return {
        sensor: 'MODIS',
        viirsConfidence: undefined,
        modisConfidenceMin: undefined,
        modisConfidenceMax: undefined,
        modisConfidenceUnknown: true,
      }
    const numbers = text.match(/\d+/g)?.map(Number) ?? []
    return {
      sensor: 'MODIS',
      viirsConfidence: undefined,
      modisConfidenceUnknown: undefined,
      modisConfidenceMin: numbers[0],
      modisConfidenceMax: numbers[1],
    }
  }
  if (/unknown|not reported|unavailable/.test(text))
    return { frpMin: undefined, frpMax: undefined, frpMaxExclusive: undefined, frpUnknown: true }
  const numbers = text.match(/\d+/g)?.map(Number) ?? []
  return numbers.length > 1
    ? { frpUnknown: undefined, frpMax: undefined, frpMin: numbers[0], frpMaxExclusive: numbers[1] }
    : {
        frpUnknown: undefined,
        frpMax: undefined,
        frpMaxExclusive: undefined,
        frpMin: numbers[0] ?? 100,
      }
}

export function canonicalToHotspot(row: CanonicalObservation): HotspotDetection {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [row.longitude, row.latitude] },
    properties: {
      acquired_at: row.acquiredAt,
      sensor: row.sensor as 'MODIS' | 'VIIRS',
      satellite: row.platform,
      source: row.sourceProduct ?? row.provenance ?? 'Unknown',
      processing: row.processingTier ?? 'Unknown',
      confidence: row.confidence.value as HotspotDetection['properties']['confidence'],
      confidence_class:
        row.confidence.kind === 'categorical' ? String(row.confidence.value ?? 'unknown') : null,
      confidence_scale:
        row.confidence.unit ?? (row.sensor === 'MODIS' ? 'native 0–100' : 'native VIIRS class'),
      frp_mw: row.frpMw,
      brightness_k: null,
      daynight: row.dayNight === 'day' ? 'D' : row.dayNight === 'night' ? 'N' : null,
    },
  }
}

/** Adapter preserves the established cards and charts using complete server summaries. */
export function canonicalDashboard(
  page: ObservationPage,
  scope: InvestigationScope,
): HotspotResponse {
  const { summary } = page.data
  const facets = summary.facets ?? {}
  const stats = summary.statistics
  const buckets = (kind: string) =>
    (facets[kind] ?? []).map(({ label, count }) => ({ label, count }))
  const daily = (facets.daily ?? []).map(({ key, count }) => ({ date: key, count }))
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }))
  for (const facet of facets.hour ?? []) {
    const hour = Number((facet.options.acquiredStart ?? facet.key).slice(11, 13))
    if (Number.isInteger(hour) && hours[hour]) hours[hour].count += facet.count
  }
  const sources = Array.isArray(page.meta.sources)
    ? (page.meta.sources as Array<Record<string, unknown>>)
    : []
  return {
    type: 'FeatureCollection',
    features: [],
    count: page.data.total,
    partial: page.meta.completeness !== 'complete',
    window: {
      start_utc: scope.query.interval.start,
      end_utc_exclusive: scope.query.interval.endExclusive,
      timezone: 'UTC',
    },
    sources: sources.length
      ? sources.map((source) => ({
          source: String(source.source ?? source.product ?? 'Unknown'),
          status:
            source.status === 'ok'
              ? 'ok'
              : source.status === 'error' || source.status === 'unavailable'
                ? 'error'
                : 'partial',
          count: 0,
          successful_days: typeof source.successful_days === 'number' ? source.successful_days : 0,
          oldest_fetched_at:
            typeof source.retrievedAt === 'string'
              ? source.retrievedAt
              : typeof source.fetchedAt === 'string'
                ? source.fetchedAt
                : (page.meta.fetchedAt ?? null),
          failed_days: [],
        }))
      : [
          {
            source: page.meta.datasetVersion ?? 'Canonical observations',
            status: page.meta.completeness === 'complete' ? 'ok' : 'partial',
            count: page.data.total,
            successful_days: 0,
            oldest_fetched_at: page.meta.fetchedAt ?? null,
            failed_days: [],
          },
        ],
    summary: {
      daily,
      products: buckets('platform'),
      confidence: buckets('confidence'),
      frp: buckets('frp'),
      daynight: buckets('dayNight'),
      hourly: hours,
      frpReported: stats?.frpReported ?? 0,
      medianFrp: stats?.medianFrp ?? null,
      latest: stats?.latest ? canonicalToHotspot(stats.latest) : null,
      highestFrp: stats?.highestFrp ? canonicalToHotspot(stats.highestFrp) : null,
      topCells: stats?.topCells ?? [],
    },
  }
}
