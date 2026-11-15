import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'

export type GlobalWindow = '24h' | '48h' | '7d'
export type GlobalManifest = {
  status: 'ready' | 'partial' | 'stale' | 'unavailable' | 'building'
  snapshotId?: string
  window: GlobalWindow
  interval?: { start: string; endExclusive: string }
  count?: number
  polarCount?: number
  renderingExtent?: number[]
  tiles?: string
  completeness?: string
  publishedAt?: string
  retrievedAt?: string
  latestAcquisition?: string
  reason?: string
  sources?: unknown[]
}

export function validateGlobalManifest(body: unknown, window: GlobalWindow): GlobalManifest {
  if (!body || typeof body !== 'object') throw new Error('The global dataset manifest is invalid.')
  const manifest = body as GlobalManifest
  if (manifest.window !== window)
    throw new Error('The published dataset does not match the requested global interval.')
  if (!['ready', 'partial', 'stale', 'unavailable', 'building'].includes(manifest.status))
    throw new Error('The global dataset status is invalid.')
  if (
    manifest.snapshotId &&
    (!manifest.interval ||
      !Number.isFinite(Date.parse(manifest.interval.start)) ||
      !(Date.parse(manifest.interval.endExclusive) > Date.parse(manifest.interval.start)) ||
      !manifest.tiles)
  )
    throw new Error('The global snapshot has no valid UTC interval or tile source.')
  return manifest
}

/** A lightweight stored manifest poll; no browser operation initiates ingestion. */
export function useGlobalFires() {
  const [window, setWindow] = useState<GlobalWindow>('24h')
  const query = useQuery({
    queryKey: ['global-hotspot-manifest', window],
    queryFn: async ({ signal }) => {
      const response = await fetch(`/firms-api/global/manifest?window=${window}`, { signal })
      const body: unknown = await response.json()
      if (!response.ok)
        throw new Error(
          body && typeof body === 'object' && 'message' in body
            ? String(body.message)
            : `Global observations are unavailable (${response.status}).`,
        )
      return validateGlobalManifest(body, window)
    },
    staleTime: 45_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
  })
  return {
    window,
    setWindow,
    manifest: query.data ?? null,
    loading: query.isPending,
    error: query.error instanceof Error ? query.error.message : '',
    refresh: () => void query.refetch(),
  }
}
