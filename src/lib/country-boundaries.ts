import type { MultiPolygon, Polygon } from 'geojson'
import { readCountryGeometry } from './country-boundary-geometry'
import {
  boundaryGeometryUrl,
  boundaryReference,
  GEOBOUNDARIES_COMMIT,
  GEOBOUNDARIES_RELEASE,
  loadBoundaryCatalog,
  type BoundaryCatalog,
  type BoundaryRecord,
} from './boundary-catalog'

export type CountryBoundary = {
  geometry: Polygon | MultiPolygon
  boundaryRef: string
  source: {
    name: string
    dataset: string
    url: string
    version: string
    commit: string
    iso3: string
    year: string
    attribution: string
    license: string
  }
}

type PendingBoundary = {
  controller: AbortController
  consumers: number
  settled: boolean
  promise: Promise<CountryBoundary>
}

const ISO_ALIASES: Record<string, string> = {
  ALD: 'ALA',
  KOS: 'XKX',
  PSX: 'PSE',
  SAH: 'ESH',
  SDS: 'SSD',
}

function sourceMetadata(record: BoundaryRecord): CountryBoundary['source'] {
  return {
    name: `geoBoundaries gbOpen / ${record.originalSource}`,
    dataset: `${record.iso} ADM0 full-resolution source polygons`,
    url: boundaryGeometryUrl(record.iso),
    version: GEOBOUNDARIES_RELEASE,
    commit: GEOBOUNDARIES_COMMIT,
    iso3: record.iso,
    year: record.year,
    attribution: `geoBoundaries (Runfola et al., 2020); ${record.originalSource}. Original license: ${record.license}${record.licenseUrl ? ` (${record.licenseUrl})` : ''}`,
    license: record.license,
  }
}

export function createCountryBoundaryLoader(
  options: {
    fetch?: typeof fetch
    catalog?: () => Promise<BoundaryCatalog>
  } = {},
) {
  const fetchBoundary = options.fetch ?? fetch
  const catalog = options.catalog ?? loadBoundaryCatalog
  const resolved = new Map<string, CountryBoundary>()
  const pending = new Map<string, PendingBoundary>()

  function start(iso: string) {
    const request: PendingBoundary = {
      controller: new AbortController(),
      consumers: 0,
      settled: false,
      promise: null!,
    }
    request.promise = (async () => {
      const index = await catalog()
      request.controller.signal.throwIfAborted()
      const record = index.records.find((record) => record.iso === iso && record.level === 'ADM0')
      if (!record)
        throw new Error(
          'This country has no boundary in the pinned source. Choose another country or draw an area.',
        )
      const response = await fetchBoundary(boundaryGeometryUrl(iso), {
        signal: AbortSignal.any([request.controller.signal, AbortSignal.timeout(90_000)]),
      })
      if (!response.ok)
        throw new Error(
          `The country boundary could not be loaded (HTTP ${response.status}). Try again.`,
        )
      const data = await response.json()
      request.controller.signal.throwIfAborted()
      if (
        Array.isArray(data?.features) &&
        data.features.some(
          (feature: { properties?: { shapeGroup?: unknown } } | null) =>
            feature?.properties?.shapeGroup && feature.properties.shapeGroup !== iso,
        )
      )
        throw new Error('The boundary source returned a different country.')
      const boundary: CountryBoundary = {
        geometry: readCountryGeometry(data),
        boundaryRef: boundaryReference(iso),
        source: sourceMetadata(record),
      }
      request.controller.signal.throwIfAborted()
      resolved.delete(iso)
      resolved.set(iso, boundary)
      while (resolved.size > 4) resolved.delete(resolved.keys().next().value!)
      return boundary
    })().finally(() => {
      request.settled = true
      if (pending.get(iso) === request) pending.delete(iso)
    })
    pending.set(iso, request)
    return request
  }

  return (countryId: string, options: { signal?: AbortSignal } = {}): Promise<CountryBoundary> => {
    const signal = options.signal
    if (signal?.aborted) return Promise.reject(signal.reason)
    const code = countryId.replace(/^country:/, '')
    const iso = ISO_ALIASES[code] ?? code
    if (!/^[A-Z]{3}$/.test(iso))
      return Promise.reject(new Error('This country has no detailed boundary identifier.'))
    const cached = resolved.get(iso)
    if (cached) {
      resolved.delete(iso)
      resolved.set(iso, cached)
      return Promise.resolve().then(() => {
        signal?.throwIfAborted()
        return cached
      })
    }
    const request = pending.get(iso) ?? start(iso)
    request.consumers++
    return new Promise((resolve, reject) => {
      let done = false
      const release = () => {
        signal?.removeEventListener('abort', abort)
        request.consumers--
        if (!request.consumers && !request.settled) {
          request.controller.abort()
          if (pending.get(iso) === request) pending.delete(iso)
        }
      }
      const abort = () => {
        if (done) return
        done = true
        release()
        reject(signal?.reason ?? new DOMException('Canceled', 'AbortError'))
      }
      signal?.addEventListener('abort', abort, { once: true })
      request.promise.then(
        (boundary) => {
          if (done) return
          done = true
          release()
          resolve(boundary)
        },
        (error: unknown) => {
          if (done) return
          done = true
          release()
          reject(error)
        },
      )
      if (signal?.aborted) abort()
    })
  }
}

export const loadCountryBoundary = createCountryBoundaryLoader()
