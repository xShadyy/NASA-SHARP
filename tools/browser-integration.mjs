



import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, join, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { productionPreview } from './browser-production-server.mjs'

const pause = (ms) => new Promise((done) => setTimeout(done, ms))
const chromePath =
  process.env.SHARP_TEST_CHROME ??
  [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ].find(existsSync)
const pythonPath =
  process.env.SHARP_TEST_PYTHON ??
  ['src/backend_api/.venv/Scripts/python.exe', 'src/backend_api/.venv/bin/python'].find(
    existsSync,
  ) ??
  (process.platform === 'win32' ? 'python' : 'python3')
async function availablePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  return port
}
const rasterPrefix = 'global-hotspot-raster-'


export const liveMap = `(()=>{const node=document.querySelector('.earth-map-canvas');const key=node&&Object.keys(node).find(key=>key.startsWith('__reactFiber$'));for(let fiber=key&&node[key];fiber;fiber=fiber.return){for(let hook=fiber.memoizedState,n=0;hook&&n++<150;hook=hook.next){const candidate=hook.memoizedState?.current;if(candidate&&typeof candidate.getStyle==='function'&&typeof candidate.getCanvas==='function')return candidate;}}return null})()`
const rasterSources = `Object.entries(${liveMap}.getStyle().sources).filter(([id])=>id.startsWith(${JSON.stringify(rasterPrefix)}))`

async function redPixelSample(cdp, longitude, latitude, size = 5, saveAs) {
  const geometry = await cdp.eval(
    `(()=>{const map=${liveMap},point=map.project([${longitude},${latitude}]),r=map.getCanvas().getBoundingClientRect(),x=r.left+point.x,y=r.top+point.y;return{clip:{x:Math.floor(x)-${Math.floor(size / 2)},y:Math.floor(y)-${Math.floor(size / 2)},width:${size},height:${size},scale:1},target:{x,y},camera:{center:map.getCenter().toArray(),zoom:map.getZoom(),projection:map.getProjection()},sources:${rasterSources}.map(([id,spec])=>({id,loaded:map.isSourceLoaded(id),tiles:spec.tiles}))}})()`,
  )
  const clip = geometry.clip
  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    clip,
    captureBeyondViewport: false,
  })
  if (saveAs) await writeFile(saveAs, Buffer.from(shot.data, 'base64'))
  const sample = await cdp.eval(
    `(async()=>{const bitmap=await createImageBitmap(await(await fetch('data:image/png;base64,${shot.data}')).blob());const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;const context=canvas.getContext('2d');context.drawImage(bitmap,0,0);const data=context.getImageData(0,0,canvas.width,canvas.height).data;let redPixels=0,minX=canvas.width,maxX=-1,minY=canvas.height,maxY=-1,nearest=null;for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++){const i=(y*canvas.width+x)*4;if(data[i]>200&&data[i+1]<100&&data[i+2]<100){redPixels++;minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);const distance=Math.hypot(x+${clip.x}+.5-${geometry.target.x},y+${clip.y}+.5-${geometry.target.y});if(!nearest||distance<nearest.distance)nearest={distance,x:x+${clip.x}+.5,y:y+${clip.y}+.5,rgb:[data[i],data[i+1],data[i+2]]}}}return{redPixels,width:redPixels?maxX-minX+1:0,height:redPixels?maxY-minY+1:0,nearest}})()`,
  )
  return { ...sample, ...geometry }
}
export function blankRaster() {
  const chunk = (name, body) => {
    const type = Buffer.from(name)
    const bytes = Buffer.concat([type, body])
    let crc = 0xffffffff
    for (const byte of bytes) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
    const output = Buffer.alloc(body.length + 12)
    output.writeUInt32BE(body.length)
    bytes.copy(output, 4)
    output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4)
    return output
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(256, 0)
  header.writeUInt32BE(256, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc(256 * (256 * 4 + 1)))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
export class CDP {
  next = 0
  pending = new Map()
  handlers = new Map()
  constructor(socket) {
    this.socket = socket
    socket.addEventListener('message', ({ data }) => {
      const item = JSON.parse(data)
      if (item.id) {
        const pending = this.pending.get(item.id)
        if (!pending) return
        this.pending.delete(item.id)
        clearTimeout(pending.timer)
        if (item.error) pending.reject(new Error(JSON.stringify(item.error)))
        else pending.resolve(item.result)
      } else
        for (const handle of this.handlers.get(item.method) ?? [])
          handle(item.params, item.sessionId)
    })
  }
  on(name, handle) {
    const list = this.handlers.get(name) ?? []
    list.push(handle)
    this.handlers.set(name, list)
  }
  send(method, params = {}, sessionId) {
    const id = ++this.next
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP timeout: ${method}`))
      }, 20000)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.text + ': ' + result.exceptionDetails.exception?.description,
      )
    return result.result.value
  }
  async until(expression, label, ms = 25000) {
    const end = Date.now() + ms
    do {
      if (await this.eval(expression)) return
      await pause(120)
    } while (Date.now() < end)
    throw new Error(`Browser condition failed: ${label}`)
  }
  async click(text, within = 'document') {
    const expression = `Array.from(${within}.querySelectorAll('button')).find(e=>e.textContent.trim()===${JSON.stringify(text)} && !e.disabled && e.getClientRects().length)`
    await this.until(`!!(${expression})`, `button ${text}`)
    await this.eval(`(${expression}).click()`)
  }
  async input(selector, value) {
    await this.eval(
      `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error('Missing input '+${JSON.stringify(selector)});const proto=el instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    )
  }
}

export async function browserIntegration() {
  assert.ok(
    chromePath && existsSync(chromePath),
    'Set SHARP_TEST_CHROME to a local Chromium executable',
  )
  const apiPort = process.env.SHARP_TEST_API_PORT
    ? Number(process.env.SHARP_TEST_API_PORT)
    : await availablePort()
  const vitePort = await availablePort()
  const apiUrl = `http://127.0.0.1:${apiPort}`
  const frontendUrl = `http://127.0.0.1:${vitePort}`
  const fixtureRunId = randomUUID()
  await mkdir('.cache/browser-tests', { recursive: true })
  const profile = await mkdtemp(join(tmpdir(), 'sharp-browser-'))
  const downloads = join(profile, 'test-downloads')
  await mkdir(downloads)
  const children = []
  let cdp,
    fixture,
    chromeLog = '',
    serverLog = '',
    viteLog = ''
  const failures = [],
    requests = [],
    results = []
  const mutedTextContrast = {}
  let narrowMobileLayout, reducedMotionDuration
  const requestUrls = new Map()
  const responseHeaders = new Map()
  const responseStatuses = new Map()
  const deliberatelyExpiredSnapshots = new Set()
  const rasterReads = [],
    rasterResponses = []
  let totalEncodedResponseBytes = 0,
    apiEncodedResponseBytes = 0,
    globalTilesCompleted = 0,
    rasterBodyFallbacks = 0,
    rasterCachedBodyReuses = 0,
    expectedExpiredRasterResponses = 0
  const start = performance.now()
  const launch = (executable, args, options = {}) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    })
    children.push(child)
    return child
  }
  try {
    const server = launch(
      pythonPath,
      [
        'tools/browser-fixture-server.py',
        '--port',
        String(apiPort),
        '--building-manifest-count',
        '2',
        '--manifest-failures',
        '4',
        '--partial-global',
        '--individual-point-layout',
      ],
      { env: { ...process.env, SHARP_TEST_FIXTURE_ID: fixtureRunId } },
    )
    server.stdout.on('data', (chunk) => {
      serverLog += chunk
    })
    server.stderr.on('data', (chunk) => {
      serverLog += chunk
    })
    server.on('error', (error) => {
      serverLog += String(error)
    })
    const ready = Date.now() + 20000
    while (Date.now() < ready) {
      try {
        const candidate = await fetch(`${apiUrl}/test-fixture`).then((r) => r.json())
        if (candidate.kind === 'synthetic browser test only' && candidate.runId === fixtureRunId) {
          fixture = candidate
          break
        }
      } catch {}
      if (server.exitCode != null) throw Error(`Fixture server could not start: ${serverLog}`)
      await pause(150)
    }
    assert.ok(fixture, 'Temporary fixture API must start')
    assert.equal(fixture.kind, 'synthetic browser test only')
    const production = await productionPreview({
      launch,
      apiUrl,
      port: vitePort,
      onLog: (chunk) => {
        viteLog += chunk
      },
    })
    const vite = production.preview
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(frontendUrl)).ok) break
      } catch {}
      if (vite.exitCode != null) throw Error(viteLog)
      await pause(100)
    }
    for (const [path, expected] of [
      ['/legal/LICENSE', /Apache License/],
      ['/legal/THIRD-PARTY-LICENSES.txt', /MapLibre|MIT License|Third.party/i],
      ['/brand/fonts/OFL.txt', /SIL OPEN FONT LICENSE/i],
    ]) {
      const response = await fetch(frontendUrl + path)
      assert.equal(response.status, 200, `Production legal asset ${path} is served`)
      assert.match(
        await response.text(),
        expected,
        `Production legal asset ${path} contains its actual license`,
      )
    }
    results.push(
      'Production Apache, third-party notices and bundled font license URLs serve the actual texts',
    )
    const chrome = launch(chromePath, [
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-port=0',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      `--user-data-dir=${profile}`,
      'about:blank',
    ])
    chrome.stderr.on('data', (chunk) => {
      chromeLog += chunk
    })
    for (let i = 0; i < 100 && !chromeLog.includes('DevTools listening'); i++) await pause(100)
    const endpoint = chromeLog.match(/ws:\/\/[^\s]+/)?.[0]
    assert.ok(endpoint, chromeLog)
    const port = new URL(endpoint).port
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())
    const socket = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
    await new Promise((done, fail) => {
      socket.addEventListener('open', done, { once: true })
      socket.addEventListener('error', fail, { once: true })
    })
    cdp = new CDP(socket)
    cdp.on('Runtime.exceptionThrown', (item) =>
      failures.push(item.exceptionDetails.exception?.description ?? item.exceptionDetails.text),
    )
    cdp.on('Runtime.consoleAPICalled', (item) => {
      if (item.type === 'error')
        failures.push(item.args.map((arg) => arg.description ?? arg.value ?? arg.type).join(' '))
    })
    cdp.on('Network.requestWillBeSent', (item, sessionId) => {
      requestUrls.set(`${sessionId ?? 'page'}:${item.requestId}`, item.request.url)
      requests.push({
        url: item.request.url,
        method: item.request.method,
        body: item.request.postData,
        target: sessionId ? 'worker' : 'page',
      })
    })
    cdp.on('Network.responseReceived', (item, sessionId) => {
      responseStatuses.set(`${sessionId ?? 'page'}:${item.requestId}`, item.response.status)
      responseHeaders.set(
        `${sessionId ?? 'page'}:${item.requestId}`,
        Object.fromEntries(
          Object.entries(item.response.headers).map(([key, value]) => [
            key.toLowerCase(),
            String(value),
          ]),
        ),
      )
    })
    cdp.on('Network.loadingFinished', (item, sessionId) => {
      totalEncodedResponseBytes += item.encodedDataLength
      const url = requestUrls.get(`${sessionId ?? 'page'}:${item.requestId}`)
      if (url?.includes('/science-api/')) apiEncodedResponseBytes += item.encodedDataLength
      const raster = url?.match(
        /\/global\/raster\/([^/]+)\/24h\/[^/]+\/(\d+)\/(\d+)\/(\d+)\.png(?:\?|$)/,
      )
      if (raster) {
        const expectedExpiry = deliberatelyExpiredSnapshots.has(raster[1])
        if (
          expectedExpiry &&
          responseStatuses.get(`${sessionId ?? 'page'}:${item.requestId}`) === 410
        ) {
          expectedExpiredRasterResponses++
          return
        }
        globalTilesCompleted++
        rasterReads.push(
          cdp
            .send('Network.getResponseBody', { requestId: item.requestId }, sessionId)
            .catch(async () => {
              rasterBodyFallbacks++
              const response = await fetch(url)
              if (expectedExpiry && response.status === 410) {
                expectedExpiredRasterResponses++
                return null
              }
              assert.ok(response.ok, 'The exact rendered raster tile remains available locally')
              return {
                body: Buffer.from(await response.arrayBuffer()).toString('base64'),
                base64Encoded: true,
              }
            })
            .then(async (response) => {
              if (response === null) return
              let bytes = Buffer.from(response.body, response.base64Encoded ? 'base64' : 'utf8')
              if (!bytes.length) {
                const previous = rasterResponses.find((tile) => tile.url === url)
                if (previous) {
                  rasterCachedBodyReuses++
                  rasterResponses.push({ ...previous, encodedBytes: item.encodedDataLength })
                  return
                }
                const recovered = await fetch(url)
                if (expectedExpiry && recovered.status === 410) {
                  expectedExpiredRasterResponses++
                  return
                }
                assert.ok(
                  recovered.ok,
                  'An uncaptured cached PNG remains available under its exact immutable URL',
                )
                rasterBodyFallbacks++
                bytes = Buffer.from(await recovered.arrayBuffer())
              }
              assert.equal(
                bytes.subarray(0, 8).toString('hex'),
                '89504e470d0a1a0a',
                'Native global response is a real PNG',
              )
              assert.equal(bytes.readUInt32BE(16), 512)
              assert.equal(bytes.readUInt32BE(20), 512)
              const [snapshot, z, x, y] = raster.slice(1)
              const headers = responseHeaders.get(`${sessionId ?? 'page'}:${item.requestId}`) || {}
              assert.equal(headers['x-snapshot-id'], snapshot)
              rasterResponses.push({
                url,
                snapshot,
                z: Number(z),
                x: Number(x),
                y: Number(y),
                observations: Number(headers['x-observation-count']),
                pngBytes: bytes.length,
                encodedBytes: item.encodedDataLength,
              })
            })
            .catch((error) => {
              failures.push(`Native raster tile verification failed: ${error}`)
            }),
        )
      }
    })
    cdp.on('Fetch.requestPaused', (item, sessionId) => {
      const url = item.request.url
      const json = url.endsWith('/planet')
      const image = /\.(?:png|jpe?g)(?:\?|$)/.test(url)
      const body = json
        ? Buffer.from(
            JSON.stringify({
              tilejson: '3.0.0',
              tiles: ['https://tiles.openfreemap.org/__test-empty/{z}/{x}/{y}.pbf'],
              minzoom: 0,
              maxzoom: 14,
            }),
          )
        : image
          ? blankRaster()
          : Buffer.alloc(0)
      void cdp
        .send(
          'Fetch.fulfillRequest',
          {
            requestId: item.requestId,
            responseCode: 200,
            responseHeaders: [
              {
                name: 'Content-Type',
                value: json ? 'application/json' : image ? 'image/png' : 'application/x-protobuf',
              },
              { name: 'Access-Control-Allow-Origin', value: '*' },
            ],
            body: body.toString('base64'),
          },
          sessionId,
        )
        .catch(() => {})
    })
    await cdp.send('Runtime.enable')
    await cdp.send('Network.enable')
    await cdp.send('Page.enable')
    const interceptedProviders = {
      patterns: [
        { urlPattern: '*gibs.earthdata.nasa.gov*' },
        { urlPattern: '*tiles.openfreemap.org*' },
      ],
    }
    await cdp.send('Fetch.enable', interceptedProviders)
    cdp.on('Target.attachedToTarget', (item) => {
      void (async () => {
        
        
        
        try {
          await cdp.send('Network.enable', {}, item.sessionId)
          await cdp.send('Runtime.enable', {}, item.sessionId)
        } finally {
          await cdp.send('Runtime.runIfWaitingForDebugger', {}, item.sessionId)
        }
      })().catch((error) => failures.push(`Worker inspection failed: ${error}`))
    })
    await cdp.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    })
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1500,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await cdp.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloads,
    })
    await cdp.send('Page.navigate', { url: frontendUrl })
    await cdp.until(
      `!!document.querySelector('[data-slot="startup-loading"] [data-slot="spinner"]')`,
      'startup spinner blocks entry until hotspots have loaded',
    )
    const bootStarted = performance.now()
    const loadingShot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    await writeFile('.cache/browser-tests/startup.png', Buffer.from(loadingShot.data, 'base64'))
    assert.ok(
      await cdp.eval(`document.querySelector('[data-slot="app-content"]').inert`),
      'The application is inert during startup',
    )
    await cdp.until(
      `Array.from(document.querySelectorAll('[data-slot="startup-loading"] button')).some(button=>button.textContent.trim()==='Retry')`,
      'A failed initial fetch offers retry instead of an infinite spinner',
    )
    assert.ok(
      await cdp.eval(`document.querySelector('[data-slot="app-content"]').inert`),
      'Failed loading cannot expose an empty app',
    )
    await cdp.click('Retry', `document.querySelector('[data-slot="startup-loading"]')`)
    await cdp.until(
      `!document.querySelector('[data-slot="startup-loading"]')`,
      '24-hour hotspots rendered before startup gate opens',
      40000,
    )
    assert.ok(
      performance.now() - bootStarted >= 1000,
      'Building progress cannot be mistaken for ready observations',
    )
    await cdp.until(`!!document.querySelector('.maplibregl-canvas')`, 'live map canvas')
    assert.equal(
      await cdp.eval(`!!document.querySelector('.global-hotspot-status')`),
      false,
      'Global status box is removed',
    )
    assert.equal(
      await cdp.eval(`!!document.querySelector('[aria-label="Global observation interval"]')`),
      false,
      'No alternate global time window selector',
    )
    assert.ok(
      requests.some((request) => request.url.includes('/global/raster/')),
      'Native global PNG tiles load at the initial globe zoom',
    )
    assert.equal(
      requests.some((request) => /\/global\/(?:tiles|point-tiles)\//.test(request.url)),
      false,
      'The initial globe requests neither aggregate JSON nor MVT observations',
    )
    assert.ok(
      globalTilesCompleted > 0,
      'The gate only opens after local hotspot tile responses have finished',
    )
    await Promise.all(rasterReads)
    const initialRasters = new Map(rasterResponses.map((tile) => [tile.url, tile]))
    const initialRasterLevel = Math.max(...[...initialRasters.values()].map((tile) => tile.z))
    const representedObservations = [...initialRasters.values()]
      .filter((tile) => tile.z === initialRasterLevel)
      .reduce((sum, tile) => sum + tile.observations, 0)
    assert.equal(
      representedObservations,
      702,
      'Initial PNG tile core counts include every canonical fixture observation before any zoom',
    )
    await cdp.until(
      `!!${liveMap}`,
      'live MapLibre instance available without production test hooks',
    )
    const initialRasterSources = await cdp.eval(rasterSources)
    assert.ok(initialRasterSources.length > 0)
    for (const [, source] of initialRasterSources) {
      assert.equal(source.type, 'raster')
      assert.equal(source.tileSize, 512)
    }
    assert.equal(
      await cdp.eval(`!!${liveMap}.getLayer('global-hotspot-individual-squares')`),
      false,
      'No custom global GPU renderer is installed',
    )
    const redSamples = []
    for (const id of fixture.observationIds.slice(0, 3)) {
      const point = fixture.pointObservations.find((point) => point.observationId === id)
      const sample = await redPixelSample(cdp, point.longitude, point.latitude)
      assert.ok(
        sample.redPixels > 0,
        `Actual global pixels are red for ${id}, including native unknown and differing FRP values`,
      )
      redSamples.push(sample)
    }
    const overviewRedSample = await redPixelSample(cdp, 18, 12)
    assert.ok(
      overviewRedSample.redPixels > 0,
      'A canonical center observation is visibly red at overview',
    )
    const initialRasterTileCount = rasterResponses.length
    results.push(
      'Production globe uses only512px native PNG tiles; core counts retain all702 observations and sampled canonical positions show red pixels',
    )
    const initialCamera = await cdp.eval(
      `(()=>{const map=${liveMap};return {center:map.getCenter().toArray(),zoom:map.getZoom()}})()`,
    )
    const initialProjection = await cdp.eval(`${liveMap}.getProjection().type`)
    await cdp.eval(`void ${liveMap}.jumpTo({center:[18,12],zoom:13})`)
    await pause(1000)
    await cdp.until(
      `${rasterSources}.some(([id])=>${liveMap}.isSourceLoaded(id))`,
      'Globe close-zoom raster viewport loaded',
    )
    const globeCloseDiagnostic = await redPixelSample(
      cdp,
      18,
      12,
      201,
      '.cache/browser-tests/globe-close-pixels.png',
    )
    await writeFile(
      '.cache/browser-tests/globe-close-diagnostic.json',
      JSON.stringify(
        { sample: globeCloseDiagnostic, tiles: rasterResponses.filter((tile) => tile.z === 13) },
        null,
        2,
      ),
    )
    await cdp.click('Map', `document.querySelector('.map-view-control')`)
    await cdp.until(
      `${liveMap}.getProjection().type==='mercator'`,
      'Flat projection ready for exact close-zoom pixel inspection',
    )
    await pause(400)
    await cdp.eval(`void ${liveMap}.jumpTo({center:[18,12],zoom:13})`)
    await cdp.until(
      `${rasterSources}.some(([id])=>${liveMap}.isSourceLoaded(id))`,
      'Native raster pixels remain available at close zoom',
    )
    let closeRedSample = await redPixelSample(cdp, 18, 12, 25)
    for (let attempt = 0; !closeRedSample.redPixels && attempt < 30; attempt++) {
      await pause(100)
      closeRedSample = await redPixelSample(cdp, 18, 12, 25)
    }
    assert.ok(
      closeRedSample.redPixels > 0,
      `The fixed minimum pixel remains visible at its canonical position: ${JSON.stringify(closeRedSample)}`,
    )
    assert.ok(
      closeRedSample.width > overviewRedSample.width &&
        closeRedSample.height > overviewRedSample.height &&
        closeRedSample.width >= 10 &&
        closeRedSample.width <= 18 &&
        closeRedSample.height >= 10 &&
        closeRedSample.height <= 18,
      'Close-zoom pixels grow to a readable approximately 14 px mark while overview pixels remain small',
    )
    await cdp.click('Globe', `document.querySelector('.map-view-control')`)
    await cdp.eval(`void ${liveMap}.jumpTo(${JSON.stringify(initialCamera)})`)
    await cdp.until(
      `${liveMap}.getProjection().type===${JSON.stringify(initialProjection)}`,
      'Globe projection restored with native raster source',
    )
    await cdp.until(
      `${rasterSources}.some(([id])=>${liveMap}.isSourceLoaded(id))`,
      'Zooming back out restores every individual pixel without aggregate substitution',
    )
    await cdp.eval(`document.querySelector('button[aria-label="Switch to dark theme"]').click()`)
    await cdp.until(`document.documentElement.dataset.theme==='dark'`, 'dark theme applied')
    const darkRedSample = await redPixelSample(cdp, 18, 12)
    assert.ok(darkRedSample.redPixels > 0, 'Actual global pixels remain red in dark theme')
    await cdp.eval(`document.querySelector('button[aria-label="Switch to light theme"]').click()`)
    await cdp.until(`document.documentElement.dataset.theme==='light'`, 'light theme restored')
    results.push(
      'Native raster pixels remain visible at close zoom, restore after zooming out, and stay red in dark theme',
    )
    assert.ok(
      requests
        .filter((request) => request.url.includes('/global/manifest'))
        .every((request) => request.url.includes('window=24h')),
      'The default global layer requests only the last24hours',
    )
    const loadedManifest = await fetch(`${apiUrl}/global/manifest?window=24h`).then((response) =>
      response.json(),
    )
    assert.equal(loadedManifest.count, 702)
    assert.ok(
      ['partial', 'stale'].includes(loadedManifest.status),
      'Useful partial satellite coverage can open the loaded map',
    )
    assert.equal(loadedManifest.completeness, 'partial')
    results.push(
      'Startup spinner blocks entry, recovers through Retry, and waits for mapped24-hour data; partial coverage opens; no status box or alternate window selector',
    )
    
    await pause(1800)
    const clickMap = async (dx = 0, dy = 0) => {
      const box = await cdp.eval(
        `(()=>{const r=document.querySelector('.maplibregl-canvas').getBoundingClientRect();return{x:r.left+r.width/2+${dx},y:r.top+r.height/2+${dy}}})()`,
      )
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...box })
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        ...box,
        button: 'left',
        clickCount: 1,
      })
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        ...box,
        button: 'left',
        clickCount: 1,
      })
    }
    await clickMap(12, -14)
    await pause(300)
    assert.equal(
      await cdp.eval(`!!document.querySelector('.fire-popup')`),
      false,
      'Worldwide hotspots are display-only pixels',
    )
    assert.equal(
      requests.filter((request) => request.url.includes('/global/observations')).length,
      0,
      'Clicking the global layer does not inspect or acquire observations',
    )
    results.push('Global pixel layer has no popup or click-driven observation query')
    const globalShot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    await writeFile(
      '.cache/browser-tests/global-pixels.png',
      Buffer.from(globalShot.data, 'base64'),
    )
    await cdp.click('Area Analytics')
    await cdp.until(
      `document.querySelector('main')?.dataset.investigationLayout==='split'`,
      'desktop map/analytics split',
    )
    assert.equal(
      await cdp.eval(`!!document.querySelector('#area-analytics-days:not(:disabled)')`),
      false,
      'The regional duration slider cannot alter an immutable global snapshot',
    )
    assert.ok(
      await cdp.eval(
        `document.querySelector('.area-analytics-controls').textContent.includes(${JSON.stringify(loadedManifest.interval.start)}) && document.querySelector('.area-analytics-controls').textContent.includes(${JSON.stringify(loadedManifest.interval.endExclusive)})`,
      ),
      'Global analytics shows its exact available UTC interval',
    )
    for (const section of ['Overview', 'Method', 'History']) await cdp.click(section)
    assert.equal(
      requests.filter((request) => request.url.endsWith('/analysis/history/prepare')).length,
      0,
      'Opening global analytics sections never starts historical acquisition',
    )
    assert.ok(
      await cdp.eval(
        `Array.from(document.querySelectorAll('.area-analytics button')).some(button=>button.textContent.trim()==='Choose a regional area')`,
      ),
      'Global scope offers an explicit regional investigation transition',
    )
    await cdp.click('Choose a regional area')
    await cdp.until(
      `!!document.querySelector('.analysis-panel')`,
      'Explicit global-to-regional transition opens area selection',
    )
    await cdp.click('Area Analytics')
    await cdp.click('Records')
    await cdp.until(
      `document.querySelector('.analytics-records')?.textContent.includes('702 matching observations')`,
      'Area Analytics starts with the complete global24-hour scope',
    )
    const recordQueriesBeforeSearch = requests.filter((request) =>
      request.url.endsWith('/global/observations'),
    ).length
    await cdp.input('.analytics-record-search input', fixture.observationIds[2].slice(0, 8))
    await pause(80)
    await cdp.input('.analytics-record-search input', fixture.observationIds[2])
    await cdp.until(
      `document.querySelector('.analytics-records')?.textContent.includes(${JSON.stringify(fixture.observationIds[2])})`,
      'query-wide search beyond the old sample finds its canonical record',
    )
    assert.equal(
      requests.filter((request) => request.url.endsWith('/global/observations')).length -
        recordQueriesBeforeSearch,
      1,
      'Fast search edits coalesce into one query-wide request',
    )
    assert.ok(
      await cdp.eval(`!document.querySelector('.map-workspace').inert`),
      'Map stays interactive',
    )
    results.push(
      'Area Analytics retains complete24-hour global scope and searches beyond the old sample',
    )
    assert.ok(
      await cdp.eval(
        `(()=>{const analytics=document.querySelector('.analytics-workspace').getBoundingClientRect(),map=document.querySelector('.map-workspace').getBoundingClientRect();return analytics.right<=map.left+1})()`,
      ),
      'Desktop analytics is left of the mounted globe',
    )
    const separator = `document.querySelector(${JSON.stringify('[role="separator"][aria-label="Resize map and analytics"]')})`
    await cdp.eval(`${separator}.focus()`)
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'ArrowLeft',
      code: 'ArrowLeft',
    })
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'ArrowLeft',
      code: 'ArrowLeft',
    })
    assert.equal(await cdp.eval(`${separator}.getAttribute('aria-valuenow')`), '47')
    const desktopLight = await cdp.send('Page.captureScreenshot', { format: 'png' })
    await writeFile(
      '.cache/browser-tests/desktop-light.png',
      Buffer.from(desktopLight.data, 'base64'),
    )
    const measureMutedContrast = () =>
      cdp.eval(
        `(()=>{const text=document.querySelector('.area-analytics-control-note'),surface=document.querySelector('.area-analytics'),color=getComputedStyle(text).color,background=getComputedStyle(surface).backgroundColor,canvas=document.createElement('canvas');canvas.width=canvas.height=1;const context=canvas.getContext('2d');context.fillStyle=background;context.fillRect(0,0,1,1);const bg=Array.from(context.getImageData(0,0,1,1).data).slice(0,3);context.fillStyle=color;context.fillRect(0,0,1,1);const fg=Array.from(context.getImageData(0,0,1,1).data).slice(0,3);const luminance=rgb=>rgb.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0),a=luminance(bg),b=luminance(fg);return{color,background,foregroundRgb:fg,backgroundRgb:bg,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)}})()`,
      )
    mutedTextContrast.light = await measureMutedContrast()
    await cdp.eval(`document.querySelector('.analytics-records .analytics-record-link').click()`)
    await cdp.until(
      `!!document.querySelector('[aria-label="Selected satellite observation"]')`,
      'row selection detail',
    )
    await cdp.click('Export matching CSV')
    await cdp.click('Export matching GEOJSON')
    await cdp.click('Reproducibility manifest')
    let exported = []
    for (let attempt = 0; attempt < 50; attempt++) {
      exported = await readdir(downloads)
      if (
        ['.csv', '.geojson', '.json'].every((extension) =>
          exported.some((file) => file.endsWith(extension)),
        )
      )
        break
      await pause(100)
    }
    const matchingExports = {}
    for (const extension of ['.csv', '.geojson', '.json']) {
      const filename = exported.find((file) => file.endsWith(extension))
      assert.ok(filename, `Downloaded full matching ${extension}`)
      const contents = await readFile(join(downloads, filename), 'utf8')
      matchingExports[extension] =
        extension === '.csv' ? contents.trim().split(/\r?\n/).length - 1 : JSON.parse(contents)
    }
    assert.equal(matchingExports['.csv'], 1)
    assert.equal(matchingExports['.geojson'].features.length, 1)
    assert.equal(matchingExports['.json'].observations.length, 1)
    assert.equal(matchingExports['.json'].reproducibility.snapshotId, fixture.snapshotId)
    await cdp.click('Apply and capture map')
    await cdp.until(
      `!!document.querySelector('.analytics-brief-print img')`,
      'matching map capture in analysis brief',
    )
    await cdp.eval(`document.querySelector('button[aria-label="Switch to dark theme"]').click()`)
    await cdp.until(`document.documentElement.dataset.theme==='dark'`, 'Dark analytics theme')
    const desktopDark = await cdp.send('Page.captureScreenshot', { format: 'png' })
    await writeFile(
      '.cache/browser-tests/desktop-dark.png',
      Buffer.from(desktopDark.data, 'base64'),
    )
    mutedTextContrast.dark = await measureMutedContrast()
    assert.ok(
      mutedTextContrast.light.ratio >= 4.5 && mutedTextContrast.dark.ratio >= 4.5,
      `Actual muted text contrast meets 4.5:1 in both themes: ${JSON.stringify(mutedTextContrast)}`,
    )
    await cdp.send('Emulation.setEmulatedMedia', { media: 'print' })
    assert.equal(
      await cdp.eval(`getComputedStyle(document.querySelector('.analytics-brief-print p')).color`),
      'rgb(17, 17, 17)',
      'Dark-theme brief prints with readable dark text',
    )
    const pdf = await cdp.send('Page.printToPDF', { printBackground: true })
    const pdfBytes = Buffer.from(pdf.data, 'base64')
    assert.equal(pdfBytes.subarray(0, 4).toString(), '%PDF')
    await writeFile('.cache/browser-tests/analysis-brief.pdf', pdfBytes)
    await cdp.send('Emulation.setEmulatedMedia', { media: '' })
    await cdp.eval(`document.querySelector('button[aria-label="Switch to light theme"]').click()`)
    results.push(
      'Interactive split, keyboard resize, row selection, complete matching exports and print-ready brief',
    )
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 650,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await cdp.until(
      `document.querySelector('main').dataset.investigationLayout==='mobile'`,
      'mobile tabs',
    )
    await cdp.click('Map', `document.querySelector('[aria-label="Investigation views"]')`)
    await cdp.until(
      `document.querySelector('main').dataset.investigationTab==='map'`,
      'mobile map tab',
    )
    await cdp.click('Analytics', `document.querySelector('[aria-label="Investigation views"]')`)
    await cdp.until(
      `document.querySelector('.analytics-records')?.textContent.includes(${JSON.stringify(fixture.observationIds[2])})`,
      'mobile state retained',
    )
    const mobileShot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    await writeFile(
      '.cache/browser-tests/mobile-analytics.png',
      Buffer.from(mobileShot.data, 'base64'),
    )
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await cdp.until(
      `innerWidth===390 && document.querySelector('main').dataset.investigationLayout==='mobile'`,
      '390px mobile analytics viewport',
    )
    narrowMobileLayout = await cdp.eval(
      `(()=>{const content=document.querySelector('.area-analytics-content');const selectors=['.area-analytics-header','.area-analytics-controls','.area-analytics-header button','.area-analytics-controls button','.analytics-record-controls input','.analytics-record-controls select','.area-analytics-range-foot>span'];const bounds=selectors.flatMap(selector=>Array.from(document.querySelectorAll(selector)).map(element=>{const r=element.getBoundingClientRect();return{selector,text:element.textContent.trim().slice(0,80),left:r.left,right:r.right}}));return{width:innerWidth,bodyWidth:document.body.scrollWidth,contentWidth:content.clientWidth,contentScrollWidth:content.scrollWidth,bounds,overflow:bounds.filter(r=>r.left<-.5||r.right>innerWidth+.5)}})()`,
    )
    const narrowShot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    await writeFile('.cache/browser-tests/mobile-390.png', Buffer.from(narrowShot.data, 'base64'))
    await writeFile(
      '.cache/browser-tests/mobile-390-layout.json',
      JSON.stringify(narrowMobileLayout, null, 2),
    )
    assert.ok(
      narrowMobileLayout.bodyWidth <= 390,
      `390px page has no horizontal overflow: ${JSON.stringify(narrowMobileLayout)}`,
    )
    assert.ok(
      narrowMobileLayout.contentScrollWidth <= narrowMobileLayout.contentWidth + 1,
      `390px analytics content has no horizontal overflow: ${JSON.stringify(narrowMobileLayout)}`,
    )
    assert.deepEqual(
      narrowMobileLayout.overflow,
      [],
      '390px analytics header and controls remain within the viewport',
    )
    await cdp.click('Map', `document.querySelector('[aria-label="Investigation views"]')`)
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    })
    await cdp.click('Map & layers')
    await cdp.until(
      `!!document.querySelector('[data-slot="popover-content"][data-state="open"]')`,
      'Map layers popover with reduced-motion preference',
    )
    reducedMotionDuration = await cdp.eval(
      `Math.max(...getComputedStyle(document.querySelector('[data-slot="popover-content"][data-state="open"]')).animationDuration.split(',').map(value=>parseFloat(value)*(value.trim().endsWith('ms')?.001:1)))`,
    )
    assert.ok(reducedMotionDuration <= 0.001, 'Reduced-motion popover animation is at most 1 ms')
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' })
    await cdp.send('Emulation.setEmulatedMedia', { features: [] })
    await cdp.click('Analytics', `document.querySelector('[aria-label="Investigation views"]')`)
    await cdp.until(
      `document.querySelector('.analytics-records')?.textContent.includes(${JSON.stringify(fixture.observationIds[2])})`,
      '390px Map/Analytics tabs preserve selected records',
    )
    results.push(
      '390x844 mobile analytics has no horizontal overflow, preserves records across tabs, and honors reduced motion',
    )
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1500,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await cdp.until(
      `document.querySelector('main').dataset.investigationLayout==='split'`,
      'desktop restored after mobile',
    )
    results.push('Mobile Map / Analytics tabs preserve investigation state')
    const expired = await fetch(`${apiUrl}/test-fixture/expire-snapshot`, { method: 'POST' }).then(
      (response) => response.json(),
    )
    deliberatelyExpiredSnapshots.add(expired.expiredSnapshotId)
    await cdp.eval(
      `(()=>{const select=Array.from(document.querySelectorAll('.analytics-record-controls label')).find(e=>e.textContent.trim().startsWith('Sort')).querySelector('select');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'oldest');select.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    )
    await cdp.until(
      `Array.from(document.querySelectorAll('.analytics-records [role="alert"] button')).some(button=>button.textContent.trim()==='Refresh worldwide observations')`,
      'expired frozen membership requires explicit refresh',
    )
    results.push('Expired snapshot stays unavailable with an explicit refresh action')
    const beforeRefresh = await cdp.eval(
      `(()=>{globalThis.__sharpTestMapBeforeRefresh=${liveMap};const map=${liveMap};return{center:map.getCenter().toArray(),zoom:map.getZoom(),bearing:map.getBearing(),pitch:map.getPitch()}})()`,
    )
    const refreshRequestStart = requests.length
    await cdp.click('Refresh worldwide observations')
    await cdp.until(
      `${rasterSources}.some(([id,source])=>source.tiles?.[0].includes(${JSON.stringify(expired.replacementSnapshotId)}) && ${liveMap}.isSourceLoaded(id))`,
      'Explicit refresh renders the fresh worldwide snapshot',
    )
    assert.equal(
      await cdp.eval(`${liveMap}===globalThis.__sharpTestMapBeforeRefresh`),
      true,
      'Explicit refresh preserves the mounted map',
    )
    const afterRefresh = await cdp.eval(
      `(()=>{const map=${liveMap};return{center:map.getCenter().toArray(),zoom:map.getZoom(),bearing:map.getBearing(),pitch:map.getPitch()}})()`,
    )
    assert.deepEqual(afterRefresh, beforeRefresh, 'Explicit refresh preserves the exact map camera')
    assert.equal(
      await cdp.eval(`!!document.querySelector('[data-slot="startup-loading"]')`),
      false,
      'Refreshing an expired investigation never reopens the startup gate',
    )
    assert.equal(
      requests
        .slice(refreshRequestStart)
        .some((request) =>
          request.url.includes('/global/raster/' + expired.expiredSnapshotId + '/'),
        ),
      false,
      'Explicit refresh causes no new requests for expired raster URLs',
    )
    results.push(
      'Explicit expired-global refresh replaces membership and pixels while preserving the live map, camera and entered app',
    )
    
    await cdp.click('Burning Activity Calendar')
    await cdp.until(
      `!!document.querySelector('.analysis-panel')`,
      'Burning Activity Calendar opened',
    )
    await cdp.eval(`void ${liveMap}.jumpTo({center:[18,12],zoom:5})`)
    await pause(500)
    
    await cdp.click('Draw area')
    await cdp.click('Draw rectangle')
    await pause(400)
    await clickMap(-45, -40)
    await clickMap(45, 40)
    await cdp.until(
      `!!document.querySelector('.analysis-confirm:not(:disabled)')`,
      'rectangle drawn',
    )
    await cdp.click('Use this area')
    await cdp.click('Area', `document.querySelector('.analysis-panel')`)
    
    await cdp.eval(
      `document.querySelector('.analysis-date-nav button[aria-label="Previous"]').click()`,
    )
    const dates = await cdp.eval(
      `Array.from(document.querySelectorAll('[data-period-day]')).filter(e=>!e.disabled).map(e=>e.dataset.periodDay)`,
    )
    const first = dates[7],
      last = dates[14]
    const chooseDay = async (day, shift = false) => {
      await cdp.eval(`document.querySelector('[data-period-day="${day}"]').focus()`)
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        text: '\r',
        modifiers: shift ? 8 : 0,
      })
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        modifiers: shift ? 8 : 0,
      })
    }
    await chooseDay(first)
    await pause(80)
    await chooseDay(last, true)
    await cdp.click('Edit area', `document.querySelector('.analysis-panel-footer')`)
    await cdp.until(
      `Array.from(document.querySelectorAll('.analysis-panel button')).some(e=>e.textContent.trim()==='Finish editing')`,
      'draft AOI edit remains pending',
    )
    await cdp.click('Activity', `document.querySelector('.analysis-panel')`)
    await cdp.click('Open in Area Analytics')
    const periodEnd = new Date(Date.parse(last + 'T00:00:00Z') + 86400000).toISOString()
    const observationRequests = () =>
      requests
        .filter(
          (request) =>
            new URL(request.url).pathname.endsWith('/analysis/observations') &&
            request.method === 'POST',
        )
        .map((request) => JSON.parse(request.body))
    for (
      let attempt = 0;
      attempt < 100 &&
      !observationRequests().some(
        (request) =>
          request.query.interval.start === first + 'T00:00:00.000Z' &&
          request.query.interval.endExclusive === periodEnd,
      );
      attempt++
    )
      await pause(100)
    assert.ok(
      observationRequests().some(
        (request) =>
          request.query.interval.start === first + 'T00:00:00.000Z' &&
          request.query.interval.endExclusive === periodEnd,
      ),
      'Calendar handoff retains the actual first date and exclusive end in canonical requests',
    )
    await cdp.click('Overview')
    await cdp.click('Method')
    await cdp.click('History')
    assert.equal(
      requests.filter((request) => request.url.endsWith('/analysis/history/prepare')).length,
      0,
      'Opening regional Overview, Method and History reads stored data without preparation',
    )
    await cdp.click('Load historical data')
    for (
      let attempt = 0;
      attempt < 50 &&
      !requests.some((request) => request.url.endsWith('/analysis/history/prepare'));
      attempt++
    )
      await pause(100)
    assert.equal(
      requests.filter((request) => request.url.endsWith('/analysis/history/prepare')).length,
      1,
      'Historical preparation starts only after the explicit Load historical data action',
    )
    await cdp.until(
      `!!document.querySelector('.investigation-section .history-heatmap tbody tr:nth-child(3) td button:not(:disabled)')`,
      'integrated History section',
    )
    await cdp.eval(
      `document.querySelector('.history-heatmap tbody tr:nth-child(3) td button').click()`,
    )
    await cdp.until(
      `!!document.querySelector('.history-daily button:not(:disabled)')`,
      'Historical monthly detail contains actual daily data',
    )
    const historicalDay = await cdp.eval(
      `document.querySelector('.history-daily button:not(:disabled)').title.slice(0,10)`,
    )
    await cdp.eval(`document.querySelector('.history-daily button:not(:disabled)').click()`)
    const historicalEnd = new Date(
      Date.parse(historicalDay + 'T00:00:00Z') + 86400000,
    ).toISOString()
    for (
      let attempt = 0;
      attempt < 100 &&
      !observationRequests().some(
        (request) =>
          request.query.interval.start === historicalDay + 'T00:00:00.000Z' &&
          request.query.interval.endExclusive === historicalEnd,
      );
      attempt++
    )
      await pause(100)
    assert.ok(
      observationRequests().some(
        (request) =>
          request.query.interval.start === historicalDay + 'T00:00:00.000Z' &&
          request.query.interval.endExclusive === historicalEnd,
      ),
      'Historical day detail becomes the exact canonical investigation',
    )
    results.push(
      'AOI drawing, pending edits and custom calendar range transfer; historical month/day linked to records',
    )
    await cdp.until(
      `!!document.querySelector('.analytics-records tbody tr')`,
      'AOI complete records',
    )
    await cdp.eval(`document.querySelector('.analytics-records .analytics-record-link').click()`)
    await cdp.click('Apply to map')
    await cdp.until(
      `!!document.querySelector('.maplibregl-canvas')`,
      'explicit Apply retains mounted map',
    )
    await cdp.click('Return to map', `document.querySelector('.area-analytics-header')`)
    await cdp.click('Burning Activity Calendar')
    await cdp.until(
      `Array.from(document.querySelectorAll('.analysis-panel button')).some(e=>e.textContent.trim()==='Finish editing')`,
      'Apply to map preserved pending AOI draft',
    )
    results.push('Explicit Apply to map preserves the pending AOI edit')
    await cdp.eval(
      `Array.from(document.querySelectorAll('.analysis-panel button')).find(e=>e.textContent.trim()==='Finish editing').focus()`,
    )
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' })
    await cdp.eval(
      `document.querySelector('[aria-label="Close Burning Activity Calendar"]').click()`,
    )
    await cdp.until(
      `!!document.querySelector('.maplibregl-canvas')`,
      'map remains mounted after closing calendar',
    )
    await pause(800)
    for (const [dx, dy] of [
      [4, -4],
      [0, 0],
      [8, -8],
      [-5, -5],
      [12, 0],
      [-10, 0],
      [0, 12],
    ]) {
      await clickMap(dx, dy)
      await pause(120)
      if (await cdp.eval(`!!document.querySelector('.fire-popup')`)) break
    }
    await cdp.until(
      `!!document.querySelector('.fire-popup')`,
      'AOI observations remain interactive after calendar closes',
    )
    if (await cdp.eval(`!!document.querySelector('.fire-popup-list button')`))
      await cdp.eval(`document.querySelector('.fire-popup-list button').click()`)
    await cdp.until(
      `Array.from(document.querySelectorAll('.fire-popup strong')).some(e=>e.textContent==='Satellite hotspot')`,
      'individual AOI observation inspection',
    )
    await cdp.click('Open in Area Analytics', `document.querySelector('.fire-popup')`)
    await cdp.click('Records')
    await cdp.until(
      `!!document.querySelector('.analytics-records tbody tr')`,
      'AOI popup canonical membership handed to complete records',
    )
    assert.ok(
      await cdp.eval(
        `document.querySelector('.area-analytics-controls').textContent.includes(${JSON.stringify(historicalDay + 'T00:00:00.000Z')})`,
      ),
      'Popup handoff retains the historical UTC date',
    )
    const selectedRequest = requests
      .filter(
        (request) => request.url.includes('/analysis/observations') && request.method === 'POST',
      )
      .map((request) => JSON.parse(request.body))
      .findLast((request) => request.options?.observationId)
    assert.ok(selectedRequest?.options.observationId)
    assert.ok(
      await cdp.eval(
        `document.querySelector('.analytics-records').textContent.includes(${JSON.stringify(selectedRequest.options.observationId)})`,
      ),
    )
    results.push(
      'Closing calendar preserves AOI observations; individual popup hands exact canonical record and historical date to analytics',
    )
    const before = (await fetch(`${apiUrl}/test-fixture`).then((r) => r.json())).upstreamAttempts
      .length
    const navigationPoint = await cdp.eval(
      `(()=>{const rect=document.querySelector('.maplibregl-canvas').getBoundingClientRect();return{x:rect.left+rect.width/2,y:rect.top+rect.height/2}})()`,
    )
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      ...navigationPoint,
      deltaX: 0,
      deltaY: -100,
    })
    await pause(500)
    const after = await fetch(`${apiUrl}/test-fixture`).then((r) => r.json())
    assert.equal(after.upstreamAttempts.length, before)
    assert.equal(before, 0)
    results.push('Navigation and popup/analytics inspection cause zero FIRMS requests')
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    await writeFile('.cache/browser-tests/split.png', Buffer.from(shot.data, 'base64'))
    const empty = await fetch(`${apiUrl}/test-fixture/zero-observations`, { method: 'POST' }).then(
      (response) => response.json(),
    )
    const tilesBeforeZero = globalTilesCompleted
    await cdp.send('Page.reload', { ignoreCache: true })
    await cdp.until(
      `!!document.querySelector('[data-slot="startup-loading"] [data-slot="spinner"]')`,
      'A fresh page still starts through the spinner for a successful empty dataset',
    )
    await cdp.until(
      `!document.querySelector('[data-slot="startup-loading"]')`,
      'Successful zero observations opens the app after empty hotspot tiles render',
    )
    assert.ok(globalTilesCompleted > tilesBeforeZero, 'Empty hotspot tiles were actually prepared')
    const emptyManifest = await fetch(`${apiUrl}/global/manifest?window=24h`).then((response) =>
      response.json(),
    )
    assert.equal(emptyManifest.snapshotId, empty.snapshotId)
    assert.equal(emptyManifest.count, 0)
    assert.equal(await cdp.eval(`document.querySelector('[data-slot="app-content"]').inert`), false)
    results.push('A successful zero-observation snapshot opens the app after rendering empty tiles')
    const finalFixture = await fetch(`${apiUrl}/test-fixture`).then((response) => response.json())
    assert.equal(finalFixture.upstreamAttempts.length, 0)
    assert.equal(
      requests.some((request) => /\/global\/(?:tiles|point-tiles)\//.test(request.url)),
      false,
    )
    const heap = await cdp.send('Runtime.getHeapUsage')
    const frames = await cdp.eval(
      `new Promise(resolve=>{let prev=performance.now(),d=[];function step(t){d.push(t-prev);prev=t;if(d.length===30)resolve(d);else requestAnimationFrame(step)}requestAnimationFrame(step)})`,
    )
    assert.deepEqual(failures, [], 'No uncaught browser exceptions')
    const metrics = {
      kind: 'Production Vite build/preview; real headless Chrome software rendering, temporary synthetic backend; external basemap imagery substituted',
      productionDirectory: production.directory,
      checks: results,
      durationMs: Math.round(performance.now() - start),
      browserJsHeapBytes: heap.usedSize,
      idleFrameMedianMs: frames.sort((a, b) => a - b)[15],
      apiRequests: finalFixture.requests,
      upstreamRequests: finalFixture.upstreamAttempts.length,
      exceptions: failures,
      configuredApiRequests: requests.filter((r) => r.url.includes('/science-api/')).length,
      mutedTextContrast,
      narrowMobileLayout,
      reducedMotionDuration,
      totalEncodedResponseBytes,
      apiEncodedResponseBytes,
      initialCanonicalCoreCount: representedObservations,
      initialRasterLevel,
      initialNativeRasterTileCount: initialRasterTileCount,
      initialRasterSourceCount: initialRasterSources.length,
      actualRedPixelSamples: {
        nativeMetadataSamples: redSamples,
        overview: overviewRedSample,
        close: closeRedSample,
        darkTheme: darkRedSample,
        globeCloseDiagnostic,
      },
      nativeRasterTileResponses: rasterResponses.length,
      rasterBodyFallbacks,
      rasterCachedBodyReuses,
      expectedExpiredRasterResponses,
      nativeRasterTileEncodedBytes: rasterResponses.reduce(
        (sum, tile) => sum + tile.encodedBytes,
        0,
      ),
      nativeRasterPngBytes: rasterResponses.reduce((sum, tile) => sum + tile.pngBytes, 0),
      transferMeasure:
        'Chrome Network.loadingFinished encodedDataLength; includes intercepted basemap substitutes and locally served development assets in the total',
    }
    await writeFile('.cache/browser-tests/results.json', JSON.stringify(metrics, null, 2))
    return metrics
  } catch (error) {
    if (cdp) {
      try {
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
        await writeFile('.cache/browser-tests/failure.png', Buffer.from(shot.data, 'base64'))
        await writeFile(
          '.cache/browser-tests/failure.html',
          await cdp.eval('document.documentElement.outerHTML'),
        )
      } catch {}
    }
    await writeFile(
      '.cache/browser-tests/failure.json',
      JSON.stringify(
        {
          error: String(error),
          checks: results,
          serverLog,
          viteLog,
          chromeLog,
          failures,
          requests,
        },
        null,
        2,
      ),
    )
    throw error
  } finally {
    try {
      await fetch(`${apiUrl}/test-fixture/shutdown`, { method: 'POST' })
    } catch {}
    cdp?.socket.close()
    await pause(400)
    for (const child of children) if (child.exitCode == null) child.kill()
    await pause(400)
    if (resolve(profile).startsWith(resolve(tmpdir()) + sep) && profile.includes('sharp-browser-'))
      await rm(profile, { recursive: true, force: true }).catch(() => {})
  }
}
