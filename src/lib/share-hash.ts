export type SharedCoordinates = { latitude: number; longitude: number }

const DECIMAL = /^-?\d+(?:\.\d+)?$/

function parsePoint(latitudeText: string, longitudeText: string): SharedCoordinates | null {
  if (!DECIMAL.test(latitudeText) || !DECIMAL.test(longitudeText)) return null
  const latitude = Number(latitudeText)
  const longitude = Number(longitudeText)
  if (
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180
  )
    return null
  return { latitude, longitude }
}

/** The shared URL contains only the map center, in latitude, longitude order. */
export function readShareHash(hash: string): SharedCoordinates | null {
  const value = hash.replace(/^#/, '')
  const coordinates = value.split(',')
  if (coordinates.length === 2 && DECIMAL.test(coordinates[0]) && DECIMAL.test(coordinates[1])) {
    return parsePoint(coordinates[0], coordinates[1])
  }

  // Open older links, but use only their coordinates. The next camera report
  // replaces the old state-heavy hash with the new coordinates-only form.
  const legacy = new URLSearchParams(value)
  const camera = legacy.get('v') === '1' ? legacy.get('map')?.split('/') : undefined
  return camera?.length === 3 && DECIMAL.test(camera[0]) ? parsePoint(camera[1], camera[2]) : null
}

export function writeShareHash({ latitude, longitude }: SharedCoordinates) {
  const hash = `#${latitude.toFixed(5)},${longitude.toFixed(5)}`
  if (window.location.hash === hash) return
  try {
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${window.location.search}${hash}`,
    )
  } catch {
    /* Browsing still works if URL mutation is restricted by the host. */
  }
}
