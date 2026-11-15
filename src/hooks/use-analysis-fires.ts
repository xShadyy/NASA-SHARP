import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { AnalysisArea } from '@/lib/analysis-area'
import {
  crossesDateline,
  MAX_ANALYSIS_DAYS,
  utcMidnight,
  type AnalysisRange,
} from '@/lib/analysis-activity'
import type { FireFeature } from '@/lib/fire-severity'
import {
  analysisSelectionKey,
  fetchAnalysisSelection,
  type AnalysisSelectionData,
} from '@/lib/analysis-api'

export type AnalysisFireStatus =
  'idle' | 'loading' | 'ready' | 'partial' | 'unavailable' | 'stale' | 'error'
const EMPTY_FEATURES: FireFeature[] = []
const CACHE_LIMIT = 4
const CACHE_BYTES = 64 * 1024 * 1024

export function trimAnalysisCache(client: QueryClient) {
  const entries = client
    .getQueryCache()
    .findAll({ queryKey: ['analysis-selection'] })
    .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt)
  let bytes = 0
  let kept = 0
  for (const entry of entries) {
    const data = entry.state.data as AnalysisSelectionData | undefined
    const cost =
      (data?.features.length ?? 0) * 640 + JSON.stringify(data?.activity ?? {}).length * 2
    if (entry.getObserversCount() > 0 || (kept < CACHE_LIMIT && bytes + cost <= CACHE_BYTES)) {
      bytes += cost
      kept += 1
    } else if (entry.state.fetchStatus !== 'fetching') client.getQueryCache().remove(entry)
  }
}

export function useAnalysisFires(area: AnalysisArea | null, range: AnalysisRange) {
  const client = useQueryClient()
  const [clock, setClock] = useState(() => Date.now())
  const key = useMemo(
    () =>
      area ? analysisSelectionKey(area.id, area.geometry, range) : ['analysis-selection', 'idle'],
    [area?.id, area?.geometry, range.start, range.end, range.startAt, range.endAt],
  )
  const dateline = !!area && crossesDateline(area.fullBounds ?? area.bounds)
  const days = (utcMidnight(range.end) - utcMidnight(range.start)) / 86400000 + 1
  const invalidRange =
    !Number.isFinite(days) ||
    days < 1 ||
    days > MAX_ANALYSIS_DAYS ||
    (range.startAt && range.endAt && Date.parse(range.endAt) <= Date.parse(range.startAt))
  const query = useQuery({
    queryKey: key,
    queryFn: async ({ signal }) => {
      const result = await fetchAnalysisSelection(
        area!.id,
        area!.name,
        area!.geometry,
        range,
        signal,
      )
      setTimeout(() => trimAnalysisCache(client), 0)
      return result
    },
    enabled: (item) => !!area && !dateline && !invalidRange && item.state.data === undefined,
    staleTime: (item) => {
      const expires = Date.parse(
        (item.state.data as AnalysisSelectionData | undefined)?.meta.expiresAt ?? '',
      )
      return Number.isFinite(expires) ? Math.max(0, expires - item.state.dataUpdatedAt) : 60_000
    },
    gcTime: 10 * 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
  })
  const data = area && !dateline && !invalidRange ? (query.data ?? null) : null
  const meta = data?.meta ?? null
  const expires = Date.parse(meta?.expiresAt ?? '')
  useEffect(() => {
    if (!Number.isFinite(expires)) return
    const delay = expires - Date.now()
    if (delay <= 0) {
      setClock(Date.now())
      return
    }
    const timer = setTimeout(() => setClock(Date.now()), Math.min(delay + 1, 2147483647))
    return () => clearTimeout(timer)
  }, [expires])
  const stale =
    meta?.freshness === 'stale' ||
    (Number.isFinite(expires) && expires <= Math.max(clock, Date.now()))
  const loading = !!area && !dateline && !invalidRange && (query.isFetching || query.isPending)
  const status: AnalysisFireStatus = !area
    ? 'idle'
    : dateline || invalidRange || query.isError
      ? 'error'
      : loading
        ? 'loading'
        : meta?.completeness === 'unavailable'
          ? 'unavailable'
          : meta?.completeness === 'partial'
            ? 'partial'
            : stale
              ? 'stale'
              : 'ready'
  const message = dateline
    ? 'This area crosses 180 degrees longitude. Select an area on one side of the date line.'
    : invalidRange
      ? 'Select between 1 and 31 UTC calendar days.'
      : query.isError
        ? query.error instanceof Error
          ? query.error.message
          : 'Observations could not be loaded.'
        : loading
          ? 'Loading observations for the selected period.'
          : status === 'unavailable'
            ? 'No source coverage is available for the selected period.'
            : status === 'partial'
              ? 'Some source data is unavailable. Counts reflect loaded observations.'
              : status === 'stale'
                ? 'Cached observations are stale. Refresh to check for updated source data.'
                : data && !meta?.freshness && !meta?.expiresAt
                  ? 'Source freshness was not reported.'
                  : ''
  return {
    status,
    features: data?.features ?? EMPTY_FEATURES,
    activity: data?.activity ?? null,
    meta: stale && meta ? { ...meta, freshness: 'stale' } : meta,
    message,
    count: data?.features.length ?? 0,
    appliedRange: data?.activity.range ?? range,
    appliedAreaName: data?.activity.areaName ?? area?.name ?? '',
    retry: () => {
      if (area && !dateline && !invalidRange) void query.refetch()
    },
  }
}
