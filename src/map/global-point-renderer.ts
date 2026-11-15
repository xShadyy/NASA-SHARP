import type { Feature, GeoJsonProperties, Geometry } from 'geojson'
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl'
import { globalFirePixelSize } from './fire-map-style'

const EXTENT = 8192
const MERCATOR_LATITUDE = 85.0511287798066
type Tile = { z: number; x: number; y: number }
type QueriedPoint = Pick<Feature<Geometry, GeoJsonProperties>, 'id' | 'geometry'> & { tile?: Tile }
type Batch = { tile: Tile; positions: Float32Array; count: number }
type GpuBatch = Batch & { buffer: WebGLBuffer; vertexArray: WebGLVertexArrayObject }
type Program = {
  program: WebGLProgram
  uniforms: Map<string, WebGLUniformLocation | null>
}

function sameBatches(previous: readonly Batch[], next: readonly Batch[]) {
  if (previous.length !== next.length) return false
  const byTile = new Map(
    previous.map((batch) => [`${batch.tile.z}/${batch.tile.x}/${batch.tile.y}`, batch]),
  )
  for (const batch of next) {
    const old = byTile.get(`${batch.tile.z}/${batch.tile.x}/${batch.tile.y}`)
    if (!old || old.count !== batch.count || old.positions.length !== batch.positions.length)
      return false
    for (let index = 0; index < batch.positions.length; index++)
      if (old.positions[index] !== batch.positions[index]) return false
  }
  return true
}
export type GlobalPointRenderStats = {
  count: number
  bytes: number
  batches: number
  preparationMs: number
  revision: number
  renderedRevision: number
  drawCalls: number
  renderCpuMs: number
}
export type GlobalPointRenderer = CustomLayerInterface & {
  setFeatures(features: readonly QueriedPoint[]): GlobalPointRenderStats
  setEnabled(enabled: boolean): void
  getStats(): GlobalPointRenderStats
}

function validTile(tile: Tile | undefined): tile is Tile {
  return Boolean(
    tile &&
    Number.isInteger(tile.z) &&
    tile.z >= 0 &&
    tile.z <= 18 &&
    Number.isInteger(tile.x) &&
    tile.x >= 0 &&
    tile.x < 2 ** tile.z &&
    Number.isInteger(tile.y) &&
    tile.y >= 0 &&
    tile.y < 2 ** tile.z,
  )
}


export function prepareGlobalPointBatches(features: readonly QueriedPoint[], fallbackZoom = 0) {
  const started = performance.now()
  const unique = new Map<string | number, QueriedPoint>()
  for (const feature of features) {
    if (feature.id === undefined || feature.id === null) continue
    const previous = unique.get(feature.id)
    
    if (!previous || (feature.tile?.z ?? -1) > (previous.tile?.z ?? -1))
      unique.set(feature.id, feature)
  }
  const grouped = new Map<string, { tile: Tile; points: number[] }>()
  let count = 0
  for (const feature of unique.values()) {
    const geometry = feature.geometry
    if (geometry?.type !== 'Point' && geometry?.type !== 'MultiPoint') continue
    
    
    const coordinate = geometry.type === 'Point' ? geometry.coordinates : geometry.coordinates[0]
    if (!coordinate) continue
    const [longitude, latitude] = coordinate
    if (
      !Number.isFinite(longitude) ||
      !Number.isFinite(latitude) ||
      Math.abs(latitude) > MERCATOR_LATITUDE
    )
      continue
    const mx = ((((longitude + 180) / 360) % 1) + 1) % 1
    const my = Math.max(
      0,
      Math.min(
        1 - Number.EPSILON,
        (1 - Math.asinh(Math.tan((latitude * Math.PI) / 180)) / Math.PI) / 2,
      ),
    )
    const zoom = Math.max(0, Math.min(18, Math.floor(fallbackZoom)))
    const size = 2 ** zoom
    const tile = validTile(feature.tile)
      ? feature.tile
      : { z: zoom, x: Math.floor(mx * size), y: Math.floor(my * size) }
    const key = `${tile.z}/${tile.x}/${tile.y}`
    let batch = grouped.get(key)
    if (!batch) {
      batch = { tile, points: [] }
      grouped.set(key, batch)
    }
    const scale = 2 ** tile.z
    const unwrappedX = tile.z ? mx + Math.round((tile.x + 0.5) / scale - mx) : mx
    batch.points.push((unwrappedX * scale - tile.x) * EXTENT, (my * scale - tile.y) * EXTENT)
    count++
  }
  const batches: Batch[] = Array.from(grouped.values(), ({ tile, points }) => ({
    tile,
    positions: new Float32Array(points),
    count: points.length / 2,
  }))
  return { batches, count, bytes: count * 8, preparationMs: performance.now() - started }
}

function shader(gl: WebGL2RenderingContext, type: number, source: string) {
  const result = gl.createShader(type)
  if (!result) throw new Error('The hotspot pixel shader could not be allocated.')
  gl.shaderSource(result, source)
  gl.compileShader(result)
  if (!gl.getShaderParameter(result, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(result)
    gl.deleteShader(result)
    throw new Error(`The hotspot pixel shader could not compile: ${message ?? 'unknown error'}`)
  }
  return result
}

function createProgram(
  gl: WebGL2RenderingContext,
  description: CustomRenderMethodInput['shaderData'],
): Program {
  const vertex = shader(
    gl,
    gl.VERTEX_SHADER,
    `#version 300 es
precision highp float;
${description.define}
${description.vertexShaderPrelude}
layout(location=0) in vec2 a_position;
uniform float u_pixel_size;
void main() {
  gl_Position = projectTile(a_position);
  gl_PointSize = u_pixel_size;
}`,
  )
  const fragment = shader(
    gl,
    gl.FRAGMENT_SHADER,
    `#version 300 es
precision highp float;
out vec4 fragColor;
void main() { fragColor = vec4(1.0, 0.0, 0.0, 1.0); }`,
  )
  const program = gl.createProgram()
  if (!program) {
    gl.deleteShader(vertex)
    gl.deleteShader(fragment)
    throw new Error('The hotspot pixel program could not be allocated.')
  }
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program)
    gl.deleteProgram(program)
    throw new Error(`The hotspot pixel program could not link: ${message ?? 'unknown error'}`)
  }
  return {
    program,
    uniforms: new Map(
      [
        'u_pixel_size',
        'u_projection_matrix',
        'u_projection_fallback_matrix',
        'u_projection_tile_mercator_coords',
        'u_projection_clipping_plane',
        'u_projection_transition',
      ].map((name) => [name, gl.getUniformLocation(program, name)]),
    ),
  }
}






export function createGlobalPointRenderer(
  options: {
    id?: string
    pixelSize?: (zoom: number) => number
    onError?: (message: string) => void
    onRendered?: (stats: GlobalPointRenderStats) => void
  } = {},
): GlobalPointRenderer {
  let map: MapLibreMap | null = null
  let context: WebGL2RenderingContext | null = null
  let batches: Batch[] = []
  let gpu: GpuBatch[] = []
  const programs = new Map<string, Program>()
  let enabled = true
  let hasData = false
  let pendingUpload = true
  let pendingFrame = false
  let failed = false
  let stats: GlobalPointRenderStats = {
    count: 0,
    bytes: 0,
    batches: 0,
    preparationMs: 0,
    revision: 0,
    renderedRevision: -1,
    drawCalls: 0,
    renderCpuMs: 0,
  }

  function releaseBuffers() {
    if (context && !context.isContextLost())
      for (const batch of gpu) {
        context.deleteBuffer(batch.buffer)
        context.deleteVertexArray(batch.vertexArray)
      }
    gpu = []
  }
  function release() {
    releaseBuffers()
    if (context && !context.isContextLost())
      for (const item of programs.values()) context.deleteProgram(item.program)
    programs.clear()
    pendingUpload = true
    pendingFrame = hasData
  }
  function restored() {
    release()
    failed = false
    map?.triggerRepaint()
  }
  function contextLost() {
    
    gpu = []
    programs.clear()
    pendingUpload = true
    pendingFrame = hasData
  }
  function wraps() {
    if (!map?.getRenderWorldCopies()) return [0]
    const bounds = map.getBounds()
    const first = Math.ceil((bounds.getWest() + 180) / 360 - 1)
    const last = Math.floor((bounds.getEast() + 180) / 360)
    if (!Number.isFinite(first) || !Number.isFinite(last)) return [0]
    return Array.from({ length: Math.max(1, last - first + 1) }, (_, index) => first + index)
  }
  const layer: GlobalPointRenderer = {
    id: options.id ?? 'global-hotspot-gpu-squares',
    type: 'custom',
    renderingMode: '2d',
    onAdd(attachedMap, gl) {
      map = attachedMap
      context = gl
      pendingUpload = true
      pendingFrame = hasData
      failed = false
      map.getCanvas().addEventListener('webglcontextrestored', restored)
      map.getCanvas().addEventListener('webglcontextlost', contextLost)
    },
    onRemove() {
      map?.getCanvas().removeEventListener('webglcontextrestored', restored)
      map?.getCanvas().removeEventListener('webglcontextlost', contextLost)
      release()
      map = null
      context = null
    },
    render(gl, args) {
      if (!map || !enabled || failed || gl.isContextLost()) return
      const started = performance.now()
      try {
        if (pendingUpload) {
          releaseBuffers()
          for (const batch of batches) {
            const buffer = gl.createBuffer()
            const vertexArray = gl.createVertexArray()
            if (!buffer || !vertexArray) {
              if (buffer) gl.deleteBuffer(buffer)
              if (vertexArray) gl.deleteVertexArray(vertexArray)
              throw new Error('Hotspot pixel buffers could not be allocated.')
            }
            gl.bindVertexArray(vertexArray)
            gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
            gl.bufferData(gl.ARRAY_BUFFER, batch.positions, gl.STATIC_DRAW)
            gl.enableVertexAttribArray(0)
            gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0)
            gpu.push({ ...batch, buffer, vertexArray })
          }
          pendingUpload = false
        }
        let program = programs.get(args.shaderData.variantName)
        if (!program || !gl.isProgram(program.program)) {
          program = createProgram(gl, args.shaderData)
          programs.set(args.shaderData.variantName, program)
        }
        gl.useProgram(program.program)
        gl.disable(gl.DEPTH_TEST)
        gl.depthMask(false)
        gl.disable(gl.STENCIL_TEST)
        gl.disable(gl.CULL_FACE)
        gl.disable(gl.BLEND)
        gl.colorMask(true, true, true, true)
        const canvas = map.getCanvas()
        const ratio = gl.drawingBufferWidth / Math.max(1, canvas.clientWidth)
        const pixelSize = (options.pixelSize ?? globalFirePixelSize)(map.getZoom())
        gl.uniform1f(program.uniforms.get('u_pixel_size') ?? null, Math.max(1, pixelSize * ratio))
        const worldWraps = args.shaderData.define.includes('GLOBE') ? [0] : wraps()
        let drawCalls = 0
        for (const batch of gpu) {
          gl.bindVertexArray(batch.vertexArray)
          for (const wrap of worldWraps) {
            const projection = args.getProjectionData({
              tileID: { wrap, canonical: batch.tile },
              applyGlobeMatrix: true,
            })
            gl.uniformMatrix4fv(
              program.uniforms.get('u_projection_matrix') ?? null,
              false,
              projection.mainMatrix,
            )
            gl.uniformMatrix4fv(
              program.uniforms.get('u_projection_fallback_matrix') ?? null,
              false,
              projection.fallbackMatrix,
            )
            gl.uniform4fv(
              program.uniforms.get('u_projection_tile_mercator_coords') ?? null,
              projection.tileMercatorCoords,
            )
            gl.uniform4fv(
              program.uniforms.get('u_projection_clipping_plane') ?? null,
              projection.clippingPlane,
            )
            gl.uniform1f(
              program.uniforms.get('u_projection_transition') ?? null,
              projection.projectionTransition,
            )
            gl.drawArrays(gl.POINTS, 0, batch.count)
            drawCalls++
          }
        }
        gl.bindVertexArray(null)
        stats = { ...stats, drawCalls, renderCpuMs: performance.now() - started }
        if (pendingFrame) {
          pendingFrame = false
          stats.renderedRevision = stats.revision
          options.onRendered?.({ ...stats })
        }
      } catch (error) {
        failed = true
        options.onError?.(
          error instanceof Error ? error.message : 'Hotspot pixels could not be rendered.',
        )
      }
    },
    setFeatures(features) {
      const prepared = prepareGlobalPointBatches(features, map?.getZoom() ?? 0)
      
      
      if (hasData && !failed && sameBatches(batches, prepared.batches)) return { ...stats }
      hasData = true
      batches = prepared.batches
      stats = {
        ...stats,
        count: prepared.count,
        bytes: prepared.bytes,
        batches: batches.length,
        preparationMs: prepared.preparationMs,
        revision: stats.revision + 1,
      }
      pendingUpload = true
      pendingFrame = true
      failed = false
      map?.triggerRepaint()
      return { ...stats }
    },
    setEnabled(next) {
      if (next === enabled) return
      enabled = next
      if (enabled) pendingFrame = hasData
      map?.triggerRepaint()
    },
    getStats() {
      return { ...stats }
    },
  }
  return layer
}
