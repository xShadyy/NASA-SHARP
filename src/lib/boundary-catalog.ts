import type { Feature, FeatureCollection } from 'geojson'
import type { AreaGeometry } from './analysis-area'

export const GEOBOUNDARIES_RELEASE = '6.0.0'
export const GEOBOUNDARIES_COMMIT = '1289e40e366c7b320550be1ee0614a9472d572d4'

export type BoundaryRecord = {
  id: string
  iso: string
  name: string
  officialName: string
  level: string
  year: string
  originalSource: string
  license: string
  licenseDetail: string
  licenseUrl: string
  originalSourceUrl: string
  geometryUrl: string
  aliases: string[]
}

export type BoundaryCatalog = {
  release: string
  commit: string
  records: BoundaryRecord[]
}

export function boundaryGeometryUrl(iso3: string) {
  return `https://media.githubusercontent.com/media/wmgeolab/geoBoundaries/${GEOBOUNDARIES_COMMIT}/releaseData/gbOpen/${iso3}/ADM0/geoBoundaries-${iso3}-ADM0.geojson`
}

export function boundaryReference(iso3: string) {
  return `gbOpen:${GEOBOUNDARIES_RELEASE}:${iso3}:ADM0:${GEOBOUNDARIES_COMMIT}`
}

export function createBoundaryCatalogLoader(
  options: { fetch?: typeof fetch; baseUrl?: string } = {},
) {
  const fetchCatalog = options.fetch ?? fetch
  const base = options.baseUrl ?? `${import.meta.env?.BASE_URL ?? '/'}boundaries/`
  let catalogPromise: Promise<BoundaryCatalog> | null = null
  let overviewPromise: Promise<FeatureCollection<AreaGeometry>> | null = null

  async function json(url: string) {
    const response = await fetchCatalog(url)
    if (!response.ok) throw new Error('The country selection data could not be loaded. Try again.')
    return response.json()
  }

  function catalog(): Promise<BoundaryCatalog> {
    catalogPromise ??= json(`${base}catalog.json`)
      .then((value: unknown) => {
        if (
          !value ||
          typeof value !== 'object' ||
          !('commit' in value) ||
          value.commit !== GEOBOUNDARIES_COMMIT ||
          !('release' in value) ||
          value.release !== GEOBOUNDARIES_RELEASE ||
          !('records' in value) ||
          !Array.isArray(value.records)
        )
          throw new Error('The country catalog does not match the pinned boundary source.')
        const records = value.records.filter(
          (record): record is BoundaryRecord =>
            record &&
            typeof record.id === 'string' &&
            typeof record.iso === 'string' &&
            /^[A-Z]{3}$/.test(record.iso) &&
            typeof record.name === 'string' &&
            typeof record.level === 'string' &&
            Array.isArray(record.aliases) &&
            record.aliases.every((alias: unknown) => typeof alias === 'string'),
        )
        if (!records.some((record) => record.level === 'ADM0'))
          throw new Error('The country catalog has no country boundaries.')
        return { release: GEOBOUNDARIES_RELEASE, commit: GEOBOUNDARIES_COMMIT, records }
      })
      .catch((error: unknown) => {
        catalogPromise = null
        throw error
      })
    return catalogPromise
  }

  function overview(): Promise<FeatureCollection<AreaGeometry>> {
    overviewPromise ??= Promise.all([catalog(), json(`${base}country-overview.geojson`)])
      .then(([index, value]) => {
        if (value?.type !== 'FeatureCollection' || !Array.isArray(value.features))
          throw new Error('The country selection overview is invalid.')
        const records = new Map(
          index.records
            .filter((record) => record.level === 'ADM0')
            .map((record) => [record.id, record]),
        )
        return {
          type: 'FeatureCollection' as const,
          features: value.features.flatMap((feature: Feature<AreaGeometry, { id?: string }>) => {
            const sourceId = feature.properties?.id
            const record = typeof sourceId === 'string' ? records.get(sourceId) : undefined
            if (!record || !['Polygon', 'MultiPolygon'].includes(feature.geometry?.type)) return []
            const id = `country:${record.iso}`
            return [
              {
                type: 'Feature' as const,
                id,
                geometry: feature.geometry as AreaGeometry,
                properties: {
                  countryId: id,
                  name: record.name,
                  iso3: record.iso,
                  boundaryRef: boundaryReference(record.iso),
                  displayOnly: true,
                },
              },
            ]
          }),
        }
      })
      .catch((error: unknown) => {
        overviewPromise = null
        throw error
      })
    return overviewPromise
  }

  return { catalog, overview }
}

const provider = createBoundaryCatalogLoader()
export const loadBoundaryCatalog = provider.catalog
export const loadCountryOverview = provider.overview
