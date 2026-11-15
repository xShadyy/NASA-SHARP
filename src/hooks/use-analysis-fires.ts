import { useEffect, useEffectEvent, useMemo, useState } from 'react'
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { AnalysisArea } from '@/lib/analysis-area'
import {
  crossesDateline,
  MAX_ANALYSIS_DAYS,
  MAX_HISTORICAL_DAYS,
  focusRange,
  utcMidnight,
  type AnalysisRange,
} from '@/lib/analysis-activity'
import type { FireFeature } from '@/lib/fire-severity'
import type { FrozenSelection, ObservationFilters } from '@/lib/investigation'
import {
  analysisSelectionKey,
  fetchAnalysisSelection,
  fetchAnalysisMap,
  type AnalysisSelectionData,
} from '@/lib/analysis-api'
import {
  subscribeAnalysisSourceRecovery,
  type AnalysisSourceRecovery,
} from '@/lib/observation-client'

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

export function useAnalysisFires(
  area: AnalysisArea | null,
  range: AnalysisRange,
  focusedDay: string | null = null,
  observationScope: { filters?: ObservationFilters; selection?: FrozenSelection } = {},
) {
  const geometry = area?.sourceGeometry ?? area?.geometry
  const client = useQueryClient()
  const [clock, setClock] = useState(() => Date.now())
  const key = useMemo(
    () =>
      area && geometry
        ? analysisSelectionKey(area.id, geometry, range)
        : ['analysis-selection', 'idle'],
    [area, geometry, range],
  )
  const dateline =
    !!area && area.type !== 'country' && crossesDateline(area.fullBounds ?? area.bounds)
  const days = (utcMidnight(range.end) - utcMidnight(range.start)) / 86400000 + 1
  const historical = days > MAX_ANALYSIS_DAYS
  const invalidRange =
    !Number.isFinite(days) ||
    days < 1 ||
    days > MAX_HISTORICAL_DAYS ||
    (range.startAt && range.endAt && Date.parse(range.endAt) <= Date.parse(range.startAt))
  const query = useQuery({
    queryKey: key,
    queryFn: async ({ signal }) => {
      const result = await fetchAnalysisSelection(area!.id, area!.name, geometry!, range, signal)
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
  const filters = observationScope.filters ?? {}
  const selection = observationScope.selection?.global ? undefined : observationScope.selection
  const mapDay = focusedDay ?? filters.day ?? null
  const dayRange = focusRange(range, mapDay)
  const dense = data?.meta.representation === 'bounded-display-aggregates'
  const hasObservationFilters = Object.values(filters).some(
    (value) =>
      value !== undefined &&
      value !== '' &&
      value !== false &&
      (!Array.isArray(value) || value.length > 0),
  )
  const historicalFocus = historical && !!mapDay
  const scopedMap =
    historicalFocus ||
    !!selection?.selectionToken ||
    !!selection?.observationIds?.length ||
    (dense && (!!mapDay || hasObservationFilters))
  const mapOptions = {
    ...filters,
    day: mapDay ?? undefined,
    sourceGeneration:
      selection?.sourceGeneration ?? (historicalFocus ? undefined : data?.meta.sourceGeneration),
    selectionToken: selection?.selectionToken,
    observationIds: selection?.selectionToken ? undefined : selection?.observationIds,
  }
  const focusedMap = useQuery({
    queryKey: [
      'analysis-map-focus',
      area?.id,
      geometry,
      historicalFocus ? dayRange : range,
      selection?.query,
      mapOptions,
    ],
    queryFn: ({ signal }) =>
      fetchAnalysisMap(
        area!.id,
        geometry!,
        historicalFocus ? dayRange : range,
        signal,
        mapOptions,
        selection?.query,
      ),
    enabled: !!area && scopedMap && !dateline && !invalidRange,
    staleTime: 5 * 60_000,
    gcTime: 5 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
  })
  const restoreMapSource = useEffectEvent((recovery: AnalysisSourceRecovery) => {
    if (!area || !geometry || dateline || invalidRange) return
    const recoveredQuery = JSON.stringify(recovery.query)
    if (recoveredQuery === key[2]) {
      if (recovery.metadata.sourceGeneration !== query.data?.meta.sourceGeneration)
        void query.refetch({ cancelRefetch: false })
    } else if (
      scopedMap &&
      recoveredQuery ===
        (selection?.query
          ? JSON.stringify(selection.query)
          : analysisSelectionKey(area.id, geometry, historicalFocus ? dayRange : range)[2]) &&
      recovery.metadata.sourceGeneration !== focusedMap.data?.meta?.sourceGeneration
    )
      void focusedMap.refetch({ cancelRefetch: false })
  })
  useEffect(
    () => subscribeAnalysisSourceRecovery((recovery) => restoreMapSource(recovery)),
    [],
  )
  const meta = scopedMap
    ? (focusedMap.data?.meta ?? data?.meta ?? null)
    : (data?.meta ?? null)
  const expires = Date.parse(meta?.expiresAt ?? '')
  useEffect(() => {
    if (!Number.isFinite(expires)) return
    const delay = expires - Date.now()
    const timer = setTimeout(
      () => setClock(Date.now()),
      Math.max(0, Math.min(delay + 1, 2147483647)),
    )
    return () => clearTimeout(timer)
  }, [expires])
  const stale = meta?.freshness === 'stale' || (Number.isFinite(expires) && expires <= clock)
  const focusedLoading = scopedMap && (focusedMap.isFetching || focusedMap.isPending)
  const focusedError = scopedMap && focusedMap.isError
  const loading =
    !!area && !dateline && !invalidRange && (query.isFetching || query.isPending || focusedLoading)
  const status: AnalysisFireStatus = !area
    ? 'idle'
    : dateline || invalidRange || query.isError || focusedError
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
      ? 'Select a valid UTC interval shorter than 100 years.'
      : focusedError
        ? focusedMap.error instanceof Error
          ? focusedMap.error.message
          : 'Observations for this date could not be loaded.'
        : query.isError
          ? query.error instanceof Error
            ? query.error.message
            : 'Observations could not be loaded.'
          : loading
            ? 'Loading observations for the selected period.'
            : status === 'unavailable'
              ? data?.meta.coverage || 'No source coverage is available for the selected period.'
              : status === 'partial'
                ? 'Some source data is unavailable. Counts reflect loaded observations.'
                : status === 'stale'
                  ? 'Cached observations are stale. Refresh to check for updated source data.'
                  : data && !meta?.freshness && !meta?.expiresAt
                    ? 'Source freshness was not reported.'
                    : ''
  return {
    status,
    features: scopedMap
      ? (focusedMap.data?.features ?? EMPTY_FEATURES)
      : historical
        ? EMPTY_FEATURES
        : (data?.features ?? EMPTY_FEATURES),
    activity: data?.activity ?? null,
    meta: stale && meta ? { ...meta, freshness: 'stale' } : meta,
    message,
    count: scopedMap
      ? (focusedMap.data?.meta?.matchingObservations ?? focusedMap.data?.features.length ?? 0)
      : (data?.meta.matchingObservations ?? data?.features.length ?? 0),
    appliedRange: data?.activity.range ?? range,
    appliedAreaName: data?.activity.areaName ?? area?.name ?? '',
    retry: () => {
      if (area && !dateline && !invalidRange) {
        if (scopedMap) void focusedMap.refetch()
        else void query.refetch()
      }
    },
  }
}
