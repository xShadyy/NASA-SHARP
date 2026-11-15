export type AnalysisRequestStatus =
  'idle' | 'loading' | 'ready' | 'partial' | 'unavailable' | 'stale' | 'error'

export function analysisRequestStatus(input: {
  hasArea: boolean
  invalid: boolean
  failed: boolean
  loading: boolean
  stale: boolean
  completeness?: string
}): AnalysisRequestStatus {
  if (!input.hasArea) return 'idle'
  if (input.invalid || input.failed) return 'error'
  if (input.loading) return 'loading'
  if (input.completeness === 'unavailable') return 'unavailable'
  if (input.stale) return 'stale'
  if (input.completeness === 'partial') return 'partial'
  return 'ready'
}

export function missingActivityDescription(status: AnalysisRequestStatus) {
  return status === 'loading'
    ? 'Loading activity'
    : status === 'error'
      ? 'Activity request failed'
      : 'Activity unavailable'
}

export function formatAnalysisRetrieval(value?: string | null) {
  const time = value ? Date.parse(value) : NaN
  return Number.isFinite(time)
    ? `${new Date(time).toLocaleString('en-GB', { timeZone: 'UTC' })} UTC`
    : 'unavailable'
}
