import type { CustomLayerInterface, Map as MapLibreMap } from 'maplibre-gl'
import { GLOBE_PROJECTION, HOME_CENTER } from './projection'

export const SKY_BACKGROUND_LAYER_ID = 'sky-background'
export const SKY_BACKGROUND_IMAGE = '/sky/starmap-2020-4k.webp'
export const SKY_BACKGROUND_ERROR = 'The sky image could not load. Earth is still available; you can retry.'
export const SKY_BACKGROUND_CAPTURE_CREDIT = 'Sky: NASA/Goddard Space Flight Center Scientific Visualization Studio · Gaia DR2: ESA/Gaia/DPAC · display-converted panorama'

const vertexSource = `#version 300 es
out vec2 screen;
void main() {
  vec2 positions[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  screen = positions[gl_VertexID];
  gl_Position = vec4(screen, 1.0, 1.0);
}`

const fragmentSource = `#version 300 es
precision highp float;
uniform sampler2D panorama;
uniform mat3 camera;
uniform float aspect;
in vec2 screen;
out vec4 color;
const float PI = 3.141592653589793;
void main() {
  // A wide, fixed 90-degree vertical view presents the supplied panorama.
  // Infinite-distance scenery changes orientation, not scale, as Earth zooms.
  vec3 direction = normalize(camera * vec3(screen.x * aspect, screen.y, 1.0));
  vec2 uv = vec2(0.5 + atan(direction.y, direction.x) / (2.0 * PI),
                 0.5 - asin(clamp(direction.z, -1.0, 1.0)) / PI);
  // atan wraps longitude from 1 to 0. Implicit derivatives treat that
  // continuous sky edge as an entire panorama per pixel, select its coarsest
  // mip, and draw a thin dark/dotted line. Unwrap only those derivatives;
  // retain normal mip filtering and the original panorama coordinates.
  vec2 dx = dFdx(uv);
  vec2 dy = dFdy(uv);
  dx.x -= round(dx.x);
  dy.x -= round(dy.x);
  color = vec4(textureGrad(panorama, uv, dx, dy).rgb, 1.0);
}`

type Resources = {
  program: WebGLProgram
  texture: WebGLTexture
  vertexArray: WebGLVertexArrayObject
  camera: WebGLUniformLocation
  aspect: WebGLUniformLocation
  panorama: WebGLUniformLocation
}

function compile(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('Could not create the sky shader.')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const reason = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error(reason ?? 'Could not compile the sky shader.')
  }
  return shader
}

function createResources(gl: WebGL2RenderingContext): Resources {
  const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource)
  let fragment: WebGLShader | null = null
  let program: WebGLProgram | null = null
  let texture: WebGLTexture | null = null
  let vertexArray: WebGLVertexArrayObject | null = null
  try {
    fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource)
    program = gl.createProgram()
    if (!program) throw new Error('Could not create the sky program.')
    gl.attachShader(program, vertex)
    gl.attachShader(program, fragment)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'Could not link the sky program.')
    texture = gl.createTexture()
    vertexArray = gl.createVertexArray()
    const camera = gl.getUniformLocation(program, 'camera')
    const aspect = gl.getUniformLocation(program, 'aspect')
    const panorama = gl.getUniformLocation(program, 'panorama')
    if (!texture || !vertexArray || !camera || !aspect || !panorama) throw new Error('Could not initialize the sky renderer.')
    return { program, texture, vertexArray, camera, aspect, panorama }
  } catch (error) {
    if (program) gl.deleteProgram(program)
    if (texture) gl.deleteTexture(texture)
    if (vertexArray) gl.deleteVertexArray(vertexArray)
    throw error
  } finally {
    gl.deleteShader(vertex)
    if (fragment) gl.deleteShader(fragment)
  }
}

/** NASA's Deep Star Maps 2020, with illustrative camera-linked orientation.
 * It is not an observer/time-calibrated Galactic or equatorial sky chart.
 * One full-screen triangle uses MapLibre's own context and normal render cycle:
 * no extra canvas, WebGL renderer, idle animation or React pointer updates. */
export function createSkyBackgroundLayer(options: { onError: () => void, onReady: () => void, visible?: boolean }): CustomLayerInterface & { retry: () => void, setVisible: (visible: boolean) => void } {
  let map: MapLibreMap | null = null
  let context: WebGL2RenderingContext | null = null
  let resources: Resources | null = null
  let image: HTMLImageElement | null = null
  let uploadPending = false
  let failed = false
  let visible = options.visible ?? true
  const basis = new Float32Array(9)
  const radians = Math.PI / 180

  function release() {
    if (context && resources) {
      context.deleteProgram(resources.program)
      context.deleteTexture(resources.texture)
      context.deleteVertexArray(resources.vertexArray)
    }
    resources = null
  }

  function fail(error: unknown) {
    if (!map) return
    failed = true
    map.getContainer().dataset.skyBackground = 'error'
    options.onError()
    console.warn('Sky background:', error)
  }

  function load() {
    if (!map) return
    failed = false
    if (image) { image.onload = null; image.onerror = null }
    map.getContainer().dataset.skyBackground = 'loading'
    const next = new Image()
    image = next
    next.onload = () => {
      if (!map || image !== next) return
      uploadPending = true
      map.triggerRepaint()
    }
    next.onerror = () => fail('Could not load the local panorama.')
    next.src = SKY_BACKGROUND_IMAGE
  }

  return {
    id: SKY_BACKGROUND_LAYER_ID,
    type: 'custom',
    renderingMode: '2d',
    onAdd(attachedMap, gl) {
      map = attachedMap
      context = gl
      map.getContainer().dataset.skyBackgroundEnabled = String(visible)
      if (visible) load()
    },
    render(gl) {
      if (!map || !visible || failed || gl.isContextLost() || map.getProjection().type !== GLOBE_PROJECTION || !image?.complete || !image.naturalWidth) return
      try {
        // Context restoration invalidates GPU objects; the decoded local image
        // can be uploaded again without a second download or renderer.
        if (!resources || !gl.isProgram(resources.program)) {
          release()
          resources = createResources(gl)
          uploadPending = true
        }
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, resources.texture)
        if (uploadPending) {
          const flip = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL) as boolean
          const premultiply = gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL) as boolean
          try {
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, imageWithinTextureLimit(gl, image))
          } finally {
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flip)
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiply)
          }
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT)
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
          gl.generateMipmap(gl.TEXTURE_2D)
          uploadPending = false
          map.getContainer().dataset.skyBackground = 'ready'
          options.onReady()
        }

        const center = map.getCenter()
        const longitude = (center.lng - HOME_CENTER[0]) * radians
        const latitude = (center.lat - HOME_CENTER[1]) * radians
        const bearing = (map.getBearing() + map.getRoll()) * radians
        const pitch = map.getPitch() * radians
        const sinLongitude = Math.sin(longitude), cosLongitude = Math.cos(longitude)
        const sinLatitude = Math.sin(latitude), cosLatitude = Math.cos(latitude)
        const sinBearing = Math.sin(bearing), cosBearing = Math.cos(bearing)
        const sinPitch = Math.sin(pitch), cosPitch = Math.cos(pitch)
        const right = [-sinLongitude, cosLongitude, 0]
        const up = [-sinLatitude * cosLongitude, -sinLatitude * sinLongitude, cosLatitude]
        const forward = [cosLatitude * cosLongitude, cosLatitude * sinLongitude, sinLatitude]
        for (let axis = 0; axis < 3; axis++) {
          const rotatedRight = right[axis] * cosBearing - up[axis] * sinBearing
          const rotatedUp = right[axis] * sinBearing + up[axis] * cosBearing
          basis[axis] = rotatedRight
          basis[axis + 3] = rotatedUp * cosPitch - forward[axis] * sinPitch
          basis[axis + 6] = forward[axis] * cosPitch + rotatedUp * sinPitch
        }
        gl.useProgram(resources.program)
        gl.bindVertexArray(resources.vertexArray)
        gl.uniform1i(resources.panorama, 0)
        gl.uniform1f(resources.aspect, gl.drawingBufferWidth / Math.max(1, gl.drawingBufferHeight))
        gl.uniformMatrix3fv(resources.camera, false, basis)
        // The far-plane triangle fills only space, respecting the native globe
        // depth buffer. MapLibre resets custom-layer GL state after this call.
        gl.enable(gl.DEPTH_TEST)
        gl.depthFunc(gl.LEQUAL)
        gl.depthMask(false)
        gl.depthRange(0, 1)
        gl.disable(gl.CULL_FACE)
        gl.disable(gl.STENCIL_TEST)
        gl.disable(gl.BLEND)
        gl.colorMask(true, true, true, true)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
      } catch (error) { fail(error) }
    },
    retry() {
      if (failed && map) { release(); load() }
    },
    setVisible(next) {
      if (next === visible) return
      visible = next
      if (!map) return
      map.getContainer().dataset.skyBackgroundEnabled = String(visible)
      if (visible && !image && !failed) load()
      map.triggerRepaint()
    },
    onRemove() {
      if (image) { image.onload = null; image.onerror = null; image = null }
      if (map) {
        delete map.getContainer().dataset.skyBackground
        delete map.getContainer().dataset.skyBackgroundEnabled
      }
      release()
      map = null
      context = null
    },
  }
}

// WebGL2 permits a 2048px texture limit. Keep the supplied 4K resolution on
// capable GPUs, with a one-time upload downscale on lower-limit devices.
function imageWithinTextureLimit(gl: WebGL2RenderingContext, image: HTMLImageElement): TexImageSource {
  const maximum = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number
  if (image.naturalWidth <= maximum && image.naturalHeight <= maximum) return image
  const scale = maximum / Math.max(image.naturalWidth, image.naturalHeight)
  const resized = document.createElement('canvas')
  resized.width = Math.max(1, Math.floor(image.naturalWidth * scale))
  resized.height = Math.max(1, Math.floor(image.naturalHeight * scale))
  const context = resized.getContext('2d')
  if (!context) throw new Error('Could not prepare the sky texture for this device.')
  context.imageSmoothingQuality = 'high'
  context.drawImage(image, 0, 0, resized.width, resized.height)
  return resized
}

export function skyBackgroundVisible(map: MapLibreMap) {
  const { skyBackground, skyBackgroundEnabled } = map.getContainer().dataset
  return map.getProjection().type === GLOBE_PROJECTION && skyBackgroundEnabled !== 'false' && skyBackground === 'ready'
}
