import type { AnalysisArea } from './analysis-area'
import { rangeQuery, type AnalysisRange } from './analysis-activity'
import type { AnalysisMetadata } from './analysis-api'

export type ObservationFilters = {
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
  filters?: ObservationFilters
  selectionToken?: string
  observationIds?: string[]
  sourceGeneration?: string
  queryIdentity?: string
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
  const response = await fetch(`/firms-api/analysis/${path}`, {
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
