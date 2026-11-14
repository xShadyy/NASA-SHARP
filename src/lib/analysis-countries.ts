import { loadCountryPolygons } from '@/lib/country-lookup'
import { loadSearchPlaces, normalizePlaceName, type SearchPlace } from '@/lib/locations'
import { areaBounds, type AnalysisArea, type AreaGeometry } from '@/lib/analysis-area'

export async function loadAnalysisCountries() {
  return (await loadSearchPlaces())
    .filter((place) => place.kind === 'country')
    .sort((a, b) => a.name.localeCompare(b.name))
}

export async function resolveAnalysisCountry(country: SearchPlace): Promise<AnalysisArea> {
  const names = new Set([country.name, ...(country.aliases ?? [])].map(normalizePlaceName))
  const polygons = (await loadCountryPolygons()).filter((polygon) =>
    names.has(normalizePlaceName(polygon.name)),
  )
  if (!polygons.length)
    throw new Error(`A boundary for ${country.name} is not available in the local dataset.`)
  const geometry: AreaGeometry =
    polygons.length === 1
      ? { type: 'Polygon', coordinates: structuredClone(polygons[0].rings) }
      : {
          type: 'MultiPolygon',
          coordinates: polygons.map((polygon) => structuredClone(polygon.rings)),
        }
  return {
    id: country.id,
    name: country.name,
    type: 'country',
    geometry,
    bounds: areaBounds(geometry),
    source: {
      name: country.source ?? 'Natural Earth',
      dataset: 'Generalized country boundaries',
      url: 'map-data/country-lookup.json',
    },
  }
}
