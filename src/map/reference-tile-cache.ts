import {
  addProtocol,
  removeProtocol,
  AJAXError,
  type GetResourceResponse,
  type RequestTransformFunction,
} from 'maplibre-gl'

type CachedTile = GetResourceResponse<ArrayBuffer> & { validUntil: number }
type TileCacheOptions = {
  fetch?: typeof fetch
  maxBytes?: number
  maxEntries?: number
  maxAge?: number
  now?: () => number
}

let nextId = 0

export function createTileResponseCache(options: TileCacheOptions = {}) {
  const fetchTile = options.fetch ?? fetch
  const maxBytes = options.maxBytes ?? 32 * 1024 * 1024
  const maxEntries = options.maxEntries ?? 128
  const maxAge = options.maxAge ?? 5 * 60_000
  const now = options.now ?? Date.now
  const tiles = new Map<string, CachedTile>()
  const pending = new Map<string, Promise<CachedTile>>()
  const lifetime = new AbortController()
  let bytes = 0

  function remove(url: string) {
    const tile = tiles.get(url)
    if (tile) bytes -= tile.data.byteLength
    tiles.delete(url)
  }

  async function download(url: string): Promise<CachedTile> {
    const response = await fetchTile(url, {
      signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(20_000)]),
    })
    if (!response.ok)
      throw new AJAXError(response.status, response.statusText, url, await response.blob())
    const data = await response.arrayBuffer()
    lifetime.signal.throwIfAborted()
    const cacheControl = response.headers.get('cache-control') ?? undefined
    const expires = response.headers.get('expires') ?? undefined
    const serverAge = cacheControl?.match(/(?:^|,)\s*max-age=(\d+)/i)
    const age = Math.max(0, Number(response.headers.get('age') ?? 0)) * 1000
    const expiration = expires ? Date.parse(expires) - now() : maxAge
    const duration = /(?:^|,)\s*no-(?:cache|store)\b/i.test(cacheControl ?? '')
      ? 0
      : Math.max(0, Math.min(maxAge, serverAge ? Number(serverAge[1]) * 1000 - age : expiration))
    const tile: CachedTile = { data, cacheControl, expires, validUntil: now() + duration }
    if (duration > 0 && data.byteLength <= maxBytes && maxEntries > 0) {
      remove(url)
      tiles.set(url, tile)
      bytes += data.byteLength
      while (tiles.size > maxEntries || bytes > maxBytes) remove(tiles.keys().next().value!)
    }
    return tile
  }

  return {
    async get(url: string, signal?: AbortSignal): Promise<GetResourceResponse<ArrayBuffer>> {
      lifetime.signal.throwIfAborted()
      signal?.throwIfAborted()
      let tile = tiles.get(url)
      if (tile && tile.validUntil <= now()) {
        remove(url)
        tile = undefined
      }
      if (tile) {
        tiles.delete(url)
        tiles.set(url, tile)
      } else {
        let request = pending.get(url)
        if (!request) {
          request = download(url).finally(() => pending.delete(url))
          pending.set(url, request)
        }
        tile = await request
      }
      lifetime.signal.throwIfAborted()
      signal?.throwIfAborted()
      const cacheControl = tile.cacheControl?.replace(
        /\bmax-age=\d+/i,
        `max-age=${Math.max(0, Math.floor((tile.validUntil - now()) / 1000))}`,
      )
      return { data: tile.data.slice(0), cacheControl, expires: tile.expires }
    },
    destroy() {
      lifetime.abort()
      tiles.clear()
      pending.clear()
      bytes = 0
    },
  }
}

export function createReferenceTileCache() {
  const protocol = `sharp-reference-${++nextId}`
  const cache = createTileResponseCache()
  addProtocol(protocol, (request, abort) =>
    cache.get(request.url.slice(protocol.length + 3), abort.signal),
  )
  const transformRequest: RequestTransformFunction = (url, type) => ({
    url:
      type === 'Tile' && /^https:\/\/tiles\.openfreemap\.org\/.*\.pbf(?:\?|$)/.test(url)
        ? `${protocol}://${url}`
        : url,
  })
  return {
    transformRequest,
    destroy() {
      cache.destroy()
      removeProtocol(protocol)
    },
  }
}
