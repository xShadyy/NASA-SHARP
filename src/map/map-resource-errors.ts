export type MapResourceFailure = 'imagery' | 'labels' | 'observations' | 'overlay' | 'rendering'

export function classifyMapResourceError(
  sourceId: unknown,
  sourceType: unknown,
  message: string,
): MapResourceFailure {
  const id = typeof sourceId === 'string' ? sourceId : ''
  if (/^(?:analysis-(?:observations|fire)|global-hotspot)/.test(id)) return 'observations'
  if (/^(?:context-|sharp-|measurement-|analysis-|terra-)/.test(id)) return 'overlay'
  if (/glyph|fontstack|font face|\.pbf.*font|\/fonts\//i.test(message)) return 'labels'
  if (sourceType === 'raster' || sourceType === 'vector' || sourceType === 'raster-dem')
    return 'imagery'
  if (
    /https?:\/\/.*(?:gibs\.earthdata\.nasa\.gov|tiles\.openfreemap\.org)/i.test(message) &&
    /(?:fetch|load|HTTP|network|status|request)/i.test(message)
  )
    return 'imagery'
  return 'rendering'
}
