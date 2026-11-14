export type LocationTarget = {
  id: string
  name: string

  coordinates: [number, number]

  bounds?: [[number, number], [number, number]]
  kind: 'country' | 'continent' | 'coordinates' | 'place' | 'current'

  accuracy?: number
  source?: string
  description?: string
  country?: string
}

export type SearchPlace = LocationTarget & { aliases?: string[] }

const STORAGE_KEY = 'ethereal-saved-locations-v1'
const MAX_SAVED = 100
const kinds = new Set(['country', 'continent', 'coordinates', 'place', 'current'])

function pair(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((item) => typeof item === 'number' && Number.isFinite(item))
  )
}

export function isLocationTarget(value: unknown): value is LocationTarget {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  if (
    typeof item.id !== 'string' ||
    !item.id ||
    item.id.length > 300 ||
    typeof item.name !== 'string' ||
    !item.name.trim() ||
    item.name.length > 300
  )
    return false
  if (typeof item.kind !== 'string' || !kinds.has(item.kind) || !pair(item.coordinates))
    return false
  const [longitude, latitude] = item.coordinates
  if (Math.abs(longitude) > 180 || Math.abs(latitude) > 90) return false
  if (
    item.accuracy !== undefined &&
    (typeof item.accuracy !== 'number' || !Number.isFinite(item.accuracy) || item.accuracy < 0)
  )
    return false
  if (item.bounds !== undefined) {
    if (
      !Array.isArray(item.bounds) ||
      item.bounds.length !== 2 ||
      !pair(item.bounds[0]) ||
      !pair(item.bounds[1])
    )
      return false
    const [[west, south], [east, north]] = item.bounds
    if (
      west < -180 ||
      west > 180 ||
      east < west ||
      east - west > 360 ||
      south < -90 ||
      north > 90 ||
      north < south
    )
      return false
  }
  return (
    (item.source === undefined || typeof item.source === 'string') &&
    (item.description === undefined || typeof item.description === 'string') &&
    (item.country === undefined ||
      (typeof item.country === 'string' &&
        item.country.trim().length > 0 &&
        item.country.length <= 150))
  )
}

export function locationKey(location: LocationTarget): string {
  return location.coordinates.map((value) => value.toFixed(6)).join(',')
}

export function formatCoordinates([longitude, latitude]: [number, number]): string {
  return `${latitude.toFixed(6)}°, ${longitude.toFixed(6)}°`
}

export function parseCoordinateTarget(input: string): LocationTarget | null {
  const text = input.trim().replace(/^\(/, '').replace(/\)$/, '')
  const match = text.match(
    /^([+-]?\d+(?:\.\d+)?)\s*°?\s*([NS])?\s*[,;]\s*([+-]?\d+(?:\.\d+)?)\s*°?\s*([EW])?$/i,
  )
  if (!match) return null
  let latitude = Number(match[1]),
    longitude = Number(match[3])
  if (match[2]) latitude = Math.abs(latitude) * (match[2].toUpperCase() === 'S' ? -1 : 1)
  if (match[4]) longitude = Math.abs(longitude) * (match[4].toUpperCase() === 'W' ? -1 : 1)
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null
  return {
    id: `coordinates:${longitude},${latitude}`,
    name: `${latitude}, ${longitude}`,
    coordinates: [longitude, latitude],
    kind: 'coordinates',
    source: 'Entered coordinates',
  }
}

function cleanLocation(location: LocationTarget): LocationTarget {
  return {
    id: location.id,
    name: location.name,
    coordinates: [...location.coordinates],
    kind: location.kind,
    ...(location.bounds ? { bounds: [[...location.bounds[0]], [...location.bounds[1]]] } : {}),
    ...(location.accuracy !== undefined ? { accuracy: location.accuracy } : {}),
    ...(location.source ? { source: location.source } : {}),
    ...(location.description ? { description: location.description } : {}),
    ...(location.country ? { country: location.country } : {}),
  }
}

export function loadSavedLocations(): LocationTarget[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    if (!Array.isArray(raw)) return []
    const seen = new Set<string>()
    return raw
      .filter(isLocationTarget)
      .filter((location) => {
        const key = locationKey(location)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .slice(0, MAX_SAVED)
      .map(cleanLocation)
  } catch {
    return []
  }
}

export function persistSavedLocations(locations: LocationTarget[]): boolean {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(locations.filter(isLocationTarget).slice(0, MAX_SAVED).map(cleanLocation)),
    )
    return true
  } catch {
    return false
  }
}

export function normalizePlaceName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

export function matchLocalPlaces(places: SearchPlace[], query: string, limit = 7): SearchPlace[] {
  const needle = normalizePlaceName(query)
  if (!needle) return []
  return places
    .map((place) => {
      const name = normalizePlaceName(place.name)
      const aliases = (place.aliases ?? []).map(normalizePlaceName)
      const score =
        name === needle
          ? 0
          : aliases.includes(needle)
            ? 1
            : name.startsWith(needle)
              ? 2
              : name.includes(needle)
                ? 3
                : aliases.some((alias) => alias.startsWith(needle))
                  ? 4
                  : 99
      return { place, score }
    })
    .filter(({ score }) => score < 99)
    .sort(
      (a, b) =>
        a.score - b.score ||
        Number(a.place.kind === 'continent') - Number(b.place.kind === 'continent') ||
        a.place.name.localeCompare(b.place.name),
    )
    .slice(0, limit)
    .map(({ place }) => place)
}

let placesPromise: Promise<SearchPlace[]> | undefined

export function loadSearchPlaces(): Promise<SearchPlace[]> {
  placesPromise ??= fetch(`${import.meta.env.BASE_URL}map-data/search-places.json`)
    .then(async (response) => {
      if (!response.ok) throw new Error('Country index could not be loaded.')
      const data: unknown = await response.json()
      if (!Array.isArray(data)) throw new Error('Country index is invalid.')
      return data.filter(isLocationTarget).map((place) => ({
        ...place,
        ...(place.kind === 'country' ? { country: place.name } : {}),
        aliases: Array.isArray((place as SearchPlace).aliases)
          ? (place as SearchPlace).aliases?.filter((alias) => typeof alias === 'string')
          : [],
      }))
    })
    .catch((error: unknown) => {
      placesPromise = undefined
      throw error
    })
  return placesPromise
}
