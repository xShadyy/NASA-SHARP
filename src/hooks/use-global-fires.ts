import { apiUrl } from '@/lib/api-config'
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
  pointTiles?: string
  pointSourceLayer?: string
  pointSchema?: string
  pointExtent?: number
  pointMaxZoom?: number
  rasterTiles?: string
  rasterTileSize?: number
  rasterMaxZoom?: number
  rasterStyle?: string
  completeness?: string
  publishedAt?: string
  retrievedAt?: string
  latestAcquisition?: string
  reason?: string
  sources?: unknown[]
  refreshing?: boolean
  refresh?: { active: boolean; phase?: string; window?: string }
}

export function globalHotspotLoadingMessage(window: GlobalWindow) {
  const period = window === '24h' ? '24 hours' : window === '48h' ? '48 hours' : '7 days'
  return `Fetching hotspots from the last ${period}…`
}

export function globalManifestPollInterval(manifest?: GlobalManifest, error?: Error | null) {
  if (error instanceof GlobalManifestError && error.status === 404) return 60_000
  if (manifest?.refreshing || manifest?.status === 'building') return 2_000
  return manifest?.snapshotId ? 60_000 : 5_000
}

export function validateGlobalManifest(body: unknown, window: GlobalWindow): GlobalManifest {
  if (!body || typeof body !== 'object') throw new Error('The global dataset manifest is invalid.')
  const manifest = body as GlobalManifest
  if (manifest.window !== window)
    throw new Error('The hotspot data does not match the requested global interval.')
  if (!['ready', 'partial', 'stale', 'unavailable', 'building'].includes(manifest.status))
    throw new Error('The global dataset status is invalid.')
  if (
    manifest.snapshotId &&
    (!manifest.interval ||
      !Number.isFinite(Date.parse(manifest.interval.start)) ||
      !(Date.parse(manifest.interval.endExclusive) > Date.parse(manifest.interval.start)) ||
      !(manifest.rasterTiles || manifest.tiles || manifest.pointTiles))
  )
    throw new Error('The global snapshot has no valid UTC interval or tile source.')
  if (manifest.snapshotId && manifest.interval) {
    const expectedHours = window === '24h' ? 24 : window === '48h' ? 48 : 168
    if (
      Date.parse(manifest.interval.endExclusive) - Date.parse(manifest.interval.start) !==
      expectedHours * 3_600_000
    )
      throw new Error(
        'The global snapshot UTC interval does not match the requested rolling window.',
      )
  }
  if (
    manifest.rasterTiles &&
    (typeof manifest.rasterTiles !== 'string' || manifest.rasterTileSize !== 512)
  )
    throw new Error('The global raster service must provide 512-pixel image tiles.')
  return manifest
}

export class GlobalManifestError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export async function fetchGlobalManifest(window: GlobalWindow, signal: AbortSignal) {
  const response = await fetch(apiUrl(`/global/manifest?window=${window}`), {
    signal,
    cache: 'no-cache',
  })
  if (response.status === 404)
    throw new GlobalManifestError(
      'Satellite hotspot data is temporarily unavailable. Please retry.',
      404,
    )
  const body: unknown = await response.json()
  if (!response.ok)
    throw new GlobalManifestError(
      body && typeof body === 'object' && 'message' in body
        ? String(body.message)
        : `Global observations are unavailable (${response.status}).`,
      response.status,
    )
  return validateGlobalManifest(body, window)
}


export function useGlobalFires() {
  const window: GlobalWindow = '24h'
  const query = useQuery({
    queryKey: ['global-hotspot-manifest', window],
    queryFn: ({ signal }) => fetchGlobalManifest(window, signal),
    staleTime: 45_000,
    refetchInterval: (query) => globalManifestPollInterval(query.state.data, query.state.error),
    refetchOnWindowFocus: false,
    retry: (attempt, error) =>
      !(error instanceof GlobalManifestError && error.status === 404) && attempt < 1,
  })
  return {
    window,
    manifest: query.data ?? null,
    loading: query.isPending || (query.data?.status === 'building' && !query.data.snapshotId),
    error: query.error instanceof Error ? query.error.message : '',
    refresh: () => query.refetch(),
  }
}
