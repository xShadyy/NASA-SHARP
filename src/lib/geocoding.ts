import { isLocationTarget, normalizePlaceName, type LocationTarget } from '@/lib/locations'

const DEFAULT_ENDPOINT = 'https://photon.komoot.io/api/'
const MIN_REQUEST_INTERVAL = 1200
const cache = new Map<string, LocationTarget[]>()
let nextRequestAt = 0

function abortError() { return new DOMException('Search cancelled.', 'AbortError') }

function waitForSlot(signal: AbortSignal): Promise<void> {
  const delay = Math.max(0, nextRequestAt - Date.now())
  nextRequestAt = Date.now() + delay + MIN_REQUEST_INTERVAL
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const cancel = () => { window.clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(abortError()) }
    const timer = window.setTimeout(() => { signal.removeEventListener('abort', cancel); resolve() }, delay)
    signal.addEventListener('abort', cancel, { once: true })
  })
}

function photonFeatureToLocation(feature: unknown): LocationTarget | null {
  if (!feature || typeof feature !== 'object') return null
  const { properties, geometry } = feature as { properties?: Record<string, unknown>, geometry?: { type?: string, coordinates?: unknown } }
  if (!properties || geometry?.type !== 'Point' || !Array.isArray(geometry.coordinates)) return null
  const [longitude, latitude] = geometry.coordinates
  if (typeof longitude !== 'number' || typeof latitude !== 'number') return null
  const text = (key: string) => typeof properties[key] === 'string' ? properties[key] as string : ''
  const name = text('name') || [text('street'), text('housenumber')].filter(Boolean).join(' ') || text('city') || text('country')
  if (!name) return null
  const description = [...new Set([text('city'), text('state'), text('country')])].filter((part) => part && part !== name).join(', ')
  const extent = properties.extent
  let bounds: LocationTarget['bounds']
  if (Array.isArray(extent) && extent.length === 4 && extent.every((value) => typeof value === 'number' && Number.isFinite(value))) {
    const [west, north, east, south] = extent as number[]
    if (west <= east && south <= north) bounds = [[west, south], [east, north]]
  }
  const result: LocationTarget = {
    id: `osm:${String(properties.osm_type ?? '')}:${String(properties.osm_id ?? `${longitude},${latitude}`)}`,
    name, coordinates: [longitude, latitude], kind: text('osm_value') === 'country' ? 'country' : 'place',
    source: 'OpenStreetMap / Photon', description, ...(text('country') ? { country: text('country') } : {}), ...(bounds ? { bounds } : {}),
  }
  return isLocationTarget(result) ? result : null
}

/** Explicit submitted searches only. No remote requests are made while typing. */
export async function geocodeDestination(query: string, signal: AbortSignal): Promise<LocationTarget[]> {
  const key = normalizePlaceName(query)
  if (!key || query.length > 250) return []
  if (signal.aborted) throw abortError()
  const cached = cache.get(key)
  if (cached) return cached
  await waitForSlot(signal)
  if (signal.aborted) throw abortError()
  const controller = new AbortController()
  const cancel = () => controller.abort(signal.reason)
  signal.addEventListener('abort', cancel, { once: true })
  const timeout = window.setTimeout(() => controller.abort(new DOMException('Search timed out.', 'TimeoutError')), 12_000)
  try {
    // Configurable for a hosted/self-managed Photon instance as traffic grows.
    const url = new URL(import.meta.env.VITE_GEOCODER_URL || DEFAULT_ENDPOINT)
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Invalid geocoder URL.')
    url.searchParams.set('q', query.trim())
    url.searchParams.set('limit', '6')
    url.searchParams.set('lang', 'en')
    const response = await fetch(url, { signal: controller.signal, referrerPolicy: 'strict-origin-when-cross-origin' })
    if (!response.ok) throw new Error(response.status === 429 ? 'Place search is busy. Try again in a moment.' : 'Place search is unavailable. Try again or enter coordinates.')
    const data: unknown = await response.json()
    const features = data && typeof data === 'object' && 'features' in data ? data.features : []
    const seen = new Set<string>()
    const results = Array.isArray(features) ? features.map(photonFeatureToLocation).filter((place): place is LocationTarget => place !== null).filter((place) => {
      // Administrative relations can duplicate the same town and extent.
      const identity = `${normalizePlaceName(place.name)}|${place.description ?? ''}|${JSON.stringify(place.bounds ?? place.coordinates.map((value) => Number(value.toFixed(5))))}`
      if (seen.has(identity)) return false
      seen.add(identity)
      return true
    }) : []
    if (cache.size >= 80) cache.delete(cache.keys().next().value as string)
    cache.set(key, results)
    return results
  } catch (error) {
    if (signal.aborted) throw abortError()
    if (controller.signal.aborted) throw new Error('Place search timed out. Try again or enter coordinates.', { cause: error })
    throw error
  } finally {
    window.clearTimeout(timeout)
    signal.removeEventListener('abort', cancel)
  }
}
