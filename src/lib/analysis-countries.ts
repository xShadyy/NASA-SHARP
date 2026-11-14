import { loadCountryBoundary } from '@/lib/country-boundaries'
import { loadBoundaryCatalog, type BoundaryCatalog } from '@/lib/boundary-catalog'
import { loadSearchPlaces, normalizePlaceName, type SearchPlace } from '@/lib/locations'
import { prepareBoundaryGeometry } from '@/map/boundary-geometry-client'
import type { AnalysisArea, AreaGeometry } from '@/lib/analysis-area'

export { loadCountryOverview } from '@/lib/boundary-catalog'

export function countriesFromCatalog(
  index: BoundaryCatalog,
  places: SearchPlace[] = [],
): SearchPlace[] {
  return index.records
    .filter((record) => record.level === 'ADM0')
    .map((record) => {
      const names = new Set(
        [record.name, record.officialName, ...record.aliases].map(normalizePlaceName),
      )
      const place = places.find(
        (place) =>
          place.kind === 'country' &&
          (place.id === `country:${record.iso}` || names.has(normalizePlaceName(place.name))),
      )
      return {
        id: `country:${record.iso}`,
        name: record.name,
        coordinates: place?.coordinates ?? [0, 0],
        bounds: place?.bounds,
        kind: 'country',
        aliases: [
          ...new Set([
            record.iso,
            record.officialName,
            ...record.aliases,
            ...(place?.aliases ?? []),
          ]),
        ],
        source: 'geoBoundaries gbOpen 6.0.0',
      } satisfies SearchPlace
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

let countries: Promise<SearchPlace[]> | null = null
const displays = new WeakMap<
  AreaGeometry,
  { bounds: string; result: Awaited<ReturnType<typeof prepareBoundaryGeometry>> }
>()

export function loadAnalysisCountries() {
  countries ??= Promise.all([loadBoundaryCatalog(), loadSearchPlaces()])
    .then(([catalog, places]) => countriesFromCatalog(catalog, places))
    .catch((error: unknown) => {
      countries = null
      throw error
    })
  return countries
}

export async function resolveAnalysisCountry(
  country: SearchPlace,
  options: { signal?: AbortSignal } = {},
): Promise<AnalysisArea> {
  const boundary = await loadCountryBoundary(country.id, options)
  options.signal?.throwIfAborted()
  const bounds = JSON.stringify(country.bounds ?? null)
  const cached = displays.get(boundary.geometry)
  const prepared =
    cached?.bounds === bounds
      ? cached.result
      : await prepareBoundaryGeometry(boundary.geometry, {
          ...options,
          preferredBounds: country.bounds,
        })
  options.signal?.throwIfAborted()
  displays.set(boundary.geometry, { bounds, result: prepared })
  return {
    id: country.id,
    name: country.name,
    type: 'country',
    geometry: boundary.geometry,
    sourceGeometry: boundary.geometry,
    ...prepared,
    boundaryRef: boundary.boundaryRef,
    source: boundary.source,
  }
}
