import type { AnalysisArea } from './analysis-area'
import { rangeQuery, type AnalysisRange } from './analysis-activity'
import type { AnalysisMetadata } from './analysis-api'
import { apiUrl } from './api-config'

export type GlobalSelection = {
  snapshotId: string
  window: '24h' | '48h' | '7d'
  aggregateId?: string
  interval: { start: string; endExclusive: string }
  bbox?: [number, number, number, number]
}

export type ObservationFilters = {
  acquisitionHour?: number
  search?: string
  platform?: string
  sensor?: string
  source?: string
  dayNight?: string
  day?: string
  acquiredStart?: string
  acquiredEndExclusive?: string
  frpMin?: number
  frpMax?: number
  frpMaxExclusive?: number
  frpUnknown?: boolean
  modisConfidenceMin?: number
  modisConfidenceMax?: number
  modisConfidenceUnknown?: boolean
  viirsConfidence?: string[]
  observationId?: string
}
export type FrozenSelection = {
  /** Exact query under which an AOI token was frozen; overall scope may be longer. */
  query?: InvestigationScope['query']
  global?: GlobalSelection
  filters?: ObservationFilters
  selectionToken?: string
  observationIds?: string[]
  sourceGeneration?: string
  queryIdentity?: string
}

export function investigationKey(scope: InvestigationScope) {
  return JSON.stringify([
    scope.query,
    scope.filters,
    scope.focusedDay,
    scope.selection?.global,
    scope.selection?.query,
    scope.selection?.selectionToken ?? scope.selection?.observationIds,
    scope.selection?.sourceGeneration,
    scope.metadata?.sourceGeneration,
  ])
}

export function createGlobalInvestigation(
  global: GlobalSelection,
  filters: ObservationFilters = {},
  metadata: AnalysisMetadata | null = null,
): InvestigationScope {
  const box = global.bbox
  const polygon = (west: number, south: number, east: number, north: number) => [
    [
      [west, south],
      [east, south],
      [east, north],
      [west, north],
      [west, south],
    ],
  ]
  const geometry: AnalysisArea['geometry'] =
    box && box[0] < box[2] && box[2] - box[0] < 180
      ? { type: 'Polygon', coordinates: polygon(...box) }
      : {
          type: 'MultiPolygon',
          coordinates: [
            polygon(-180, -90, -60, 90),
            polygon(-60, -90, 60, 90),
            polygon(60, -90, 180, 90),
          ],
        }
  const area: AnalysisArea = {
    id: `global:${global.snapshotId}:${global.aggregateId ?? global.window}`,
    name: global.aggregateId
      ? 'Selected global observation group'
      : 'Worldwide satellite observations',
    type: 'polygon',
    geometry,
    bounds: box
      ? [
          [box[0], box[1]],
          [box[2], box[3]],
        ]
      : [
          [-180, -90],
          [180, 90],
        ],
  }
  const range: AnalysisRange = {
    start: global.interval.start.slice(0, 10),
    end: new Date(Date.parse(global.interval.endExclusive) - 1).toISOString().slice(0, 10),
    startAt: global.interval.start,
    endAt: global.interval.endExclusive,
  }
  return createInvestigation(area, range, metadata, null, filters, {
    global,
    sourceGeneration: global.snapshotId,
  })
}
export type InvestigationScope = {
  version: 1
  area: AnalysisArea
  range: AnalysisRange
  query: ReturnType<typeof rangeQuery>
  filters: ObservationFilters
  focusedDay: string | null
  selection?: FrozenSelection
  metric: 'harmonizedActiveCells'
  method: 'afternoon-active-cells-2km-1'
  metadata: AnalysisMetadata | null
}
export function createInvestigation(
  area: AnalysisArea,
  range: AnalysisRange,
  metadata: AnalysisMetadata | null = null,
  focusedDay: string | null = null,
  filters: ObservationFilters = {},
  selection?: FrozenSelection,
): InvestigationScope {
  return structuredClone({
    version: 1,
    area,
    range,
    query: rangeQuery(area.id, area.sourceGeometry ?? area.geometry, range),
    filters,
    focusedDay,
    selection,
    metric: 'harmonizedActiveCells',
    method: 'afternoon-active-cells-2km-1',
    metadata,
  })
}

export async function investigationRequest<T>(
  path: string,
  query: unknown,
  options: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(apiUrl(`/analysis/${path}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, options }),
    signal,
  })
  const body = await response.json()
  if (!response.ok)
    throw new Error(
      typeof body.detail === 'string'
        ? body.detail
        : (body.message ?? `Analysis request failed (${response.status}).`),
    )
  return body as T
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
