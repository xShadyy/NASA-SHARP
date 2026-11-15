export function resolveApiBase(configured?: string) {
  return (configured?.trim() || '/firms-api').replace(/\/+$/, '')
}

export const API_BASE = resolveApiBase(import.meta.env?.VITE_FIRMS_API_BASE_URL)

/** All hotspot clients, including immutable URLs returned by the API, use one deployment base. */
export function apiUrl(path: string, base = API_BASE) {
  if (/^https?:\/\//i.test(path)) return path
  const relative = path.replace(/^\/(?:firms-api|api)(?=\/|$)/, '').replace(/^\/+/, '')
  return `${resolveApiBase(base)}/${relative}`
}
