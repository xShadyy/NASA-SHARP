import type { LocationTarget } from '@/lib/locations'

type Coordinate = [number, number]
type Ring = Coordinate[]
type CountryPolygon = { name: string, rings: Ring[], bounds: [number, number, number, number] }

let countryPromise: Promise<CountryPolygon[]> | undefined

function isRing(value: unknown): value is Ring {
  return Array.isArray(value) && value.length >= 4 && value.every((point) => Array.isArray(point) && point.length === 2 && point.every((component) => typeof component === 'number' && Number.isFinite(component)))
}

function loadCountryPolygons(): Promise<CountryPolygon[]> {
  countryPromise ??= fetch(`${import.meta.env.BASE_URL}map-data/country-lookup.json`).then(async (response) => {
    if (!response.ok) throw new Error('Country lookup could not be loaded.')
    const records: unknown = await response.json()
    if (!Array.isArray(records)) throw new Error('Country lookup is invalid.')
    const polygons: CountryPolygon[] = []
    for (const value of records) {
      if (!value || typeof value !== 'object' || typeof value.name !== 'string' || !Array.isArray(value.polygons)) continue
      for (const rings of value.polygons) {
        if (!Array.isArray(rings) || !rings.length || !rings.every(isRing)) continue
        let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity
        for (const [longitude, latitude] of rings[0]) {
          west = Math.min(west, longitude); south = Math.min(south, latitude)
          east = Math.max(east, longitude); north = Math.max(north, latitude)
        }
        polygons.push({ name: value.name, rings, bounds: [west, south, east, north] })
      }
    }
    if (!polygons.length) throw new Error('Country lookup has no polygons.')
    // Overview polygons can cover a microstate omitted at that scale. Prefer its
    // smaller detailed polygon when both sources contain the same point.
    return polygons.sort((a, b) => (a.bounds[2] - a.bounds[0]) * (a.bounds[3] - a.bounds[1]) - (b.bounds[2] - b.bounds[0]) * (b.bounds[3] - b.bounds[1]))
  }).catch((error: unknown) => { countryPromise = undefined; throw error })
  return countryPromise
}

/** Boundary-inclusive ray casting in the source's WGS84 coordinates. */
function pointInRing([longitude, latitude]: Coordinate, ring: Ring): boolean {
  let inside = false
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [ax, ay] = ring[previous], [bx, by] = ring[index]
    const cross = (longitude - ax) * (by - ay) - (latitude - ay) * (bx - ax)
    if (Math.abs(cross) < 1e-9 && longitude >= Math.min(ax, bx) - 1e-9 && longitude <= Math.max(ax, bx) + 1e-9 && latitude >= Math.min(ay, by) - 1e-9 && latitude <= Math.max(ay, by) + 1e-9) return true
    if ((ay > latitude) !== (by > latitude) && longitude < (bx - ax) * (latitude - ay) / (by - ay) + ax) inside = !inside
  }
  return inside
}

/** Local generalized country lookup. No coordinates leave the browser. */
export async function lookupCountry(coordinates: Coordinate): Promise<string | undefined> {
  if (!coordinates.every(Number.isFinite) || Math.abs(coordinates[1]) > 90) return undefined
  const longitude = ((coordinates[0] + 180) % 360 + 360) % 360 - 180
  const latitude = coordinates[1]
  try {
    const polygons = await loadCountryPolygons()
    return polygons.find(({ rings, bounds: [west, south, east, north] }) => longitude >= west && longitude <= east && latitude >= south && latitude <= north && pointInRing([longitude, latitude], rings[0]) && !rings.slice(1).some((hole) => pointInRing([longitude, latitude], hole)))?.name
  } catch { return undefined }
}

export async function resolveLocationCountry(location: LocationTarget): Promise<LocationTarget> {
  if (location.country) return location
  const country = await lookupCountry(location.coordinates)
  return country ? { ...location, country } : location
}
