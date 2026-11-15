/** Read-only startup probe of the running local canonical store; never initiates ingestion. */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { CDP, blankRaster, liveMap } from './browser-integration.mjs'
import { productionPreview } from './browser-production-server.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const listener = createServer()
await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve))
const port = listener.address().port
await new Promise((resolve) => listener.close(resolve))
const apiListener = createServer()
await new Promise((resolve) => apiListener.listen(0, '127.0.0.1', resolve))
const apiPort = apiListener.address().port
await new Promise((resolve) => apiListener.close(resolve))
const apiUrl = `http://127.0.0.1:${apiPort}`
const profile = await mkdtemp(join(tmpdir(), 'sharp-startup-probe-'))
const children = []
let browser,
  log = '',
  cdp
const records = [],
  errors = [],
  requests = [],
  navigations = []
const transfers = [],
  networkRequests = new Map()
let requestPhase = 'startup'
const settings = await readFile('.cache/browser-tests/startup-diagnostic', 'utf8')
  .then(JSON.parse)
  .catch(() => ({}))
const mode = settings.mode || process.argv[2] || 'successful-imagery'
let frozenManifest = settings.frozenManifest
  ? JSON.parse(await readFile(settings.frozenManifest, 'utf8'))
  : null
const launch = (command, args, options = {}) => {
  const child = spawn(command, args, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
    env: options.env || process.env,
  })
  children.push(child)
  return child
}
try {
  const runId = randomUUID()
  const server = launch(
    resolve('src/backend_api/.venv/Scripts/python.exe'),
    [
      'tools/browser-fixture-server.py',
      '--port',
      String(apiPort),
      '--global-database',
      resolve(settings.globalDatabase || 'src/backend_api/data/global-hotspots.sqlite'),
    ],
    { env: { ...process.env, SHARP_TEST_FIXTURE_ID: runId } },
  )
  for (const stream of [server.stdout, server.stderr])
    stream.on('data', (chunk) => {
      log += chunk
    })
  let fixture
  for (let i = 0; i < 150; i++) {
    try {
      const candidate = await fetch(`${apiUrl}/test-fixture`).then((response) => response.json())
      if (candidate.runId === runId) {
        fixture = candidate
        break
      }
    } catch {}
    if (server.exitCode !== null) throw new Error(`Read-only fixture failed: ${log}`)
    await sleep(100)
  }
  assert.ok(fixture, 'Read-only global fixture starts with a unique process identity')
  assert.equal(fixture.globalStoreMode, 'read-only existing')
  const newManifest = await fetch(`${apiUrl}/global/manifest?window=24h`).then((response) =>
    response.json(),
  )
  if (frozenManifest) {
    frozenManifest = {
      ...frozenManifest,
      rasterTiles: newManifest.rasterTiles.replace(
        newManifest.snapshotId,
        frozenManifest.snapshotId,
      ),
      rasterTileSize: newManifest.rasterTileSize,
      rasterMaxZoom: newManifest.rasterMaxZoom,
      rasterStyle: newManifest.rasterStyle,
    }
  }
  const production = await productionPreview({
    launch,
    apiUrl,
    port,
    legacy: Boolean(settings.legacy),
    reuseDirectory: settings.reuseDirectory,
    onLog: (chunk) => {
      log += chunk
    },
  })
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/`)).ok) break
    } catch {}
    await sleep(100)
  }
  browser = launch(
    process.env.SHARP_TEST_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    [
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-port=0',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
  )
  browser.stderr.on('data', (chunk) => {
    log += chunk
  })
  for (let i = 0; i < 100 && !log.includes('DevTools listening'); i++) await sleep(100)
  const debugPort = new URL(log.match(/ws:\/\/[^\s]+/)[0]).port
  const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((r) => r.json())
  const socket = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }))
  cdp = new CDP(socket)
  cdp.on('Runtime.exceptionThrown', (item) =>
    errors.push(item.exceptionDetails.exception?.description || item.exceptionDetails.text),
  )
  cdp.on('Network.requestWillBeSent', (item) => {
    requests.push(item.request.url)
    networkRequests.set(item.requestId, {
      url: item.request.url,
      started: item.timestamp,
      phase: requestPhase,
    })
  })
  cdp.on('Network.responseReceived', (item) => {
    const request = networkRequests.get(item.requestId)
    if (request)
      Object.assign(request, {
        status: item.response.status,
        cached: Boolean(item.response.fromDiskCache),
        headers: item.response.headers,
      })
  })
  cdp.on('Network.requestServedFromCache', (item) => {
    const request = networkRequests.get(item.requestId)
    if (request) request.cached = true
  })
  cdp.on('Network.loadingFinished', (item) => {
    const request = networkRequests.get(item.requestId)
    if (request)
      transfers.push({
        ...request,
        encodedBytes: item.encodedDataLength,
        elapsedMs: (item.timestamp - request.started) * 1000,
      })
  })
  cdp.on('Page.frameNavigated', (item) => {
    navigations.push({ url: item.frame.url, loaderId: item.frame.loaderId, at: performance.now() })
  })
  cdp.on('Fetch.requestPaused', (item) => {
    if (frozenManifest && item.request.url.includes('/global/manifest?window=24h')) {
      void cdp
        .send('Fetch.fulfillRequest', {
          requestId: item.requestId,
          responseCode: 200,
          responseHeaders: [
            { name: 'Content-Type', value: 'application/json' },
            { name: 'Cache-Control', value: 'no-store' },
          ],
          body: Buffer.from(JSON.stringify(frozenManifest)).toString('base64'),
        })
        .catch(() => {})
      return
    }
    if (mode === 'pending-imagery') return
    const json = item.request.url.endsWith('/planet')
    const image = /\.(?:png|jpe?g)(?:\?|$)/.test(item.request.url)
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
    const fulfill = () =>
      cdp
        .send('Fetch.fulfillRequest', {
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
        })
        .catch(() => {})
    if (mode === 'delayed-raster' && image) void sleep(4000).then(fulfill)
    else void fulfill()
  })
  await cdp.send('Runtime.enable')
  await cdp.send('Network.enable')
  await cdp.send('Page.enable')
  await cdp.send('Fetch.enable', {
    patterns: [
      { urlPattern: '*gibs.earthdata.nasa.gov*' },
      { urlPattern: '*tiles.openfreemap.org*' },
      ...(frozenManifest ? [{ urlPattern: '*/global/manifest?window=24h*' }] : []),
    ],
  })
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1500,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await cdp.send('Performance.enable')
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__sharpStartupProbe={startedAt:performance.now(),enteredAt:null,seenGate:false};new MutationObserver(()=>{const p=window.__sharpStartupProbe;if(document.querySelector('[data-slot="startup-loading"]'))p.seenGate=true;else if(p.seenGate&&document.querySelector('[data-slot="app-content"]')?.inert===false&&p.enteredAt===null)p.enteredAt=performance.now()}).observe(document,{childList:true,subtree:true,attributes:true,attributeFilter:['inert']})`,
  })
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__sharpLongTasks=[];window.__sharpLongTaskObserver=new PerformanceObserver(list=>{for(const entry of list.getEntries())window.__sharpLongTasks.push({startTime:entry.startTime,duration:entry.duration})});window.__sharpLongTaskObserver.observe({type:'longtask',buffered:true})`,
  })
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__sharpGeoJSONUpdates=[];(()=>{const started=performance.now(),last=new WeakMap();const timer=setInterval(()=>{try{const node=document.querySelector('.earth-map-canvas'),key=node&&Object.keys(node).find(key=>key.startsWith('__reactFiber$'));for(let fiber=key&&node[key];fiber;fiber=fiber.return)for(let hook=fiber.memoizedState,n=0;hook&&n++<150;hook=hook.next){const map=hook.memoizedState?.current;if(!map||typeof map.getStyle!=='function'||typeof map.getCanvas!=='function')continue;for(const [id,spec]of Object.entries(map.getStyle()?.sources||{})){if(spec.type!=='geojson')continue;const source=map.getSource(id),proto=source&&Object.getPrototypeOf(source);if(!proto||typeof proto.setData!=='function')continue;if(!proto.__sharpBenchmarkWrapped){const original=proto.setData;proto.setData=function(data,...args){if(this.id.startsWith('global-hotspot-')||this.id==='analysis-observations'){window.__sharpGeoJSONUpdates.push({source:this.id,features:data?.features?.length??null,sameReference:last.get(this)===data,at:performance.now()});last.set(this,data)}return original.call(this,data,...args)};Object.defineProperty(proto,'__sharpBenchmarkWrapped',{value:true})}clearInterval(timer);return}}}catch{}if(performance.now()-started>10000)clearInterval(timer)},4)})()`,
  })
  const started = performance.now()
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/` })
  for (let i = 0; i < (settings.seconds || 35); i++) {
    await sleep(1000)
    const state = await cdp.eval(
      `(()=>{
        const node=document.querySelector('.earth-map-canvas');
        const key=node&&Object.keys(node).find(key=>key.startsWith('__reactFiber$'));
        let map=null,display=null,appStartup=null,earthHooks=[],signatures=[];
        for(let fiber=key&&node[key];fiber;fiber=fiber.return){
          const values=[];
          for(let hook=fiber.memoizedState,n=0;hook&&n++<150;hook=hook.next){
            const value=hook.memoizedState;values.push(value);
            if(value&&typeof value==='object'&&'visibleTiles'in value&&'displayFeatures'in value)display={snapshotId:value.snapshotId,loading:value.loading,error:value.error,visibleTiles:value.visibleTiles,displayFeatures:value.displayFeatures,sourceId:value.sourceId,displayedSnapshotId:value.displayedManifest?.snapshotId};
            if(value&&typeof value==='object'&&typeof value.ready==='boolean'&&'phase'in value&&'error'in value)appStartup=value;
            const current=value?.current;
            if(typeof current==='string'&&current.includes('"ready"'))signatures.push(current);
            if(current&&typeof current.getStyle==='function'&&typeof current.getCanvas==='function'){map=current;earthHooks=values;}
          }
          if(typeof fiber.memoizedProps?.onStartupChange==='function')earthHooks=values;
        }
        const result={gate:document.querySelector('[data-slot="startup-loading"]')?.innerText||null,display,appStartup,signatures};
        if(!map)return result;
        const mapStateIndex=earthHooks.findIndex(value=>value===map);
        result.readyState=earthHooks[mapStateIndex-1];
        result.booleanRefs=earthHooks.map((value,index)=>typeof value?.current==='boolean'?{index,current:value.current}:null).filter(Boolean);
        result.renderListeners=(map._listeners?.render||[]).map(callback=>callback.name);
        result.visibility=document.visibilityState;
        result.scheduledFrame=Boolean(map._frame);
        result.styleLoaded=map.isStyleLoaded();
        result.sources=Object.fromEntries(Object.keys(map.getStyle().sources).map(id=>[id,{loaded:map.isSourceLoaded(id),type:map.getStyle().sources[id].type}]));
        result.globalSources=Object.entries(map.getStyle().sources).filter(([id])=>id.startsWith('global-hotspot-')).map(([id,source])=>({id,type:source.type}));
        result.rendered=display&&!display.loading&&display.visibleTiles?display.displayFeatures:0;
        result.renderedCountBasis='Canonical investigation count; overlapping raster pixels or legacy aggregate symbols are not distinct visible incidents';
        result.legacyDisplayFeatures=Number(map.getContainer().dataset.legacyGlobalDisplayFeatures)||null;
        return result
      })()`,
    )
    records.push({
      elapsedMs: Math.round(performance.now() - started),
      ...state,
      errors: errors.slice(-2),
    })
    console.log(JSON.stringify(records.at(-1)))
    if (!state.gate && state.rendered) break
  }
  let navigationProfile
  let cpuProfile
  if (settings.analyticsOnly) {
    navigationProfile = {
      label: settings.profile,
      representation: production.representation,
      snapshotId: records.find((record) => record.display)?.display.snapshotId,
      observationCount: records.find((record) => record.display)?.display.displayFeatures,
      kind: 'Targeted production analytics-open motion proof; world/dense measurements retained from prior final production run',
      contextLost: false,
      geoJSONSetData: await cdp.eval(`window.__sharpGeoJSONUpdates||[]`),
    }
  }
  if (
    settings.profile &&
    !settings.analyticsOnly &&
    records.some((record) => !record.gate && record.rendered > 0)
  ) {
    await sleep(500)
    const initialHeap = await cdp.send('Runtime.getHeapUsage')
    const beforeMetrics = Object.fromEntries(
      (await cdp.send('Performance.getMetrics')).metrics.map(({ name, value }) => [name, value]),
    )
    requestPhase = 'navigation'
    const box = await cdp.eval(
      `(()=>{const r=document.querySelector('.maplibregl-canvas').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`,
    )
    await cdp.eval(
      `window.__sharpNavigationProbe={frames:[],running:true,startedAt:performance.now()};requestAnimationFrame(function step(t){const p=window.__sharpNavigationProbe;if(p.last!==undefined)p.frames.push(t-p.last);p.last=t;if(p.running)requestAnimationFrame(step)})`,
    )
    if (settings.cpuProfile) {
      await cdp.send('Profiler.enable')
      await cdp.send('Profiler.setSamplingInterval', { interval: 1000 })
      await cdp.send('Profiler.start')
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...box })
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      ...box,
      button: 'left',
      clickCount: 1,
    })
    for (let i = 1; i <= 20; i++) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: box.x + i * 9,
        y: box.y + i * 2,
        button: 'left',
        buttons: 1,
      })
      await sleep(35)
    }
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: box.x + 180,
      y: box.y + 40,
      button: 'left',
      clickCount: 1,
    })
    await sleep(500)
    for (const deltaY of [-80, 80]) {
      for (let i = 0; i < 8; i++) {
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          ...box,
          deltaX: 0,
          deltaY,
        })
        await sleep(60)
      }
      await sleep(400)
    }
    await sleep(700)
    if (settings.cpuProfile) cpuProfile = (await cdp.send('Profiler.stop')).profile
    const probe = await cdp.eval(
      `(()=>{const p=window.__sharpNavigationProbe;if(!p)return{frames:[],durationMs:0,startup:window.__sharpStartupProbe||{},contextLost:true};p.running=false;for(const entry of window.__sharpLongTaskObserver.takeRecords())window.__sharpLongTasks.push({startTime:entry.startTime,duration:entry.duration});return{frames:p.frames,durationMs:performance.now()-p.startedAt,startup:window.__sharpStartupProbe,longTasks:window.__sharpLongTasks.filter(entry=>entry.startTime>=p.startedAt)}})()`,
    )
    requestPhase = 'complete'
    const afterMetrics = Object.fromEntries(
      (await cdp.send('Performance.getMetrics')).metrics.map(({ name, value }) => [name, value]),
    )
    const finalHeap = await cdp.send('Runtime.getHeapUsage')
    const sorted = probe.frames.toSorted((a, b) => a - b)
    const percentile = (p) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]
    navigationProfile = {
      label: settings.profile,
      kind: 'Production build/preview, headless Chrome SwiftShader, real stored snapshot, substituted basemap; fixed left-drag + 8 zoom-in and 8 zoom-out wheel inputs',
      representation: production.representation,
      snapshotId: records.find((record) => record.display)?.display?.snapshotId,
      observationCount: records.find((record) => record.display)?.display?.displayFeatures,
      startupMs: probe.startup.enteredAt - probe.startup.startedAt,
      durationMs: probe.durationMs,
      frameCount: sorted.length,
      frameMedianMs: percentile(0.5),
      frameP95Ms: percentile(0.95),
      frameMaxMs: sorted.at(-1),
      initialJsHeapBytes: initialHeap.usedSize,
      finalJsHeapBytes: finalHeap.usedSize,
      mainThreadTaskSeconds: afterMetrics.TaskDuration - beforeMetrics.TaskDuration,
      scriptSeconds: afterMetrics.ScriptDuration - beforeMetrics.ScriptDuration,
      layoutSeconds: afterMetrics.LayoutDuration - beforeMetrics.LayoutDuration,
      contextLost: Boolean(probe.contextLost),
      frames: probe.frames,
      geoJSONSetData: await cdp.eval(`window.__sharpGeoJSONUpdates||[]`),
      longTasks: {
        count: probe.longTasks?.length ?? 0,
        totalMs: (probe.longTasks || []).reduce((sum, entry) => sum + entry.duration, 0),
        maxMs: Math.max(0, ...(probe.longTasks || []).map((entry) => entry.duration)),
        entries: probe.longTasks || [],
      },
    }
    if (cpuProfile) {
      const nodes = new Map(cpuProfile.nodes.map((node) => [node.id, node]))
      const parents = new Map()
      for (const node of cpuProfile.nodes)
        for (const child of node.children || []) parents.set(child, node.id)
      const self = new Map(),
        inclusive = new Map()
      for (let i = 0; i < cpuProfile.samples.length; i++) {
        const id = cpuProfile.samples[i],
          seconds = (cpuProfile.timeDeltas?.[i] || 1000) / 1e6
        self.set(id, (self.get(id) || 0) + seconds)
        for (let current = id, n = 0; current && n++ < 200; current = parents.get(current))
          inclusive.set(current, (inclusive.get(current) || 0) + seconds)
      }
      const top = (values) =>
        [...values]
          .toSorted((a, b) => b[1] - a[1])
          .filter(([id]) => nodes.get(id).callFrame.functionName !== '(root)')
          .slice(0, 18)
          .map(([id, seconds]) => ({ seconds, ...nodes.get(id).callFrame }))
      navigationProfile.cpuTopSelf = top(self)
      navigationProfile.cpuTopInclusive = top(inclusive)
    }
    if (frozenManifest)
      assert.equal(
        navigationProfile.snapshotId,
        frozenManifest.snapshotId,
        'Navigation comparison retains the exact immutable baseline snapshot',
      )
    console.log(JSON.stringify({ navigationProfile }))
  }
  if (settings.warm && navigationProfile) {
    requestPhase = 'warm-startup'
    await cdp.send('Page.reload', { ignoreCache: false })
    await cdp.until(
      `window.__sharpStartupProbe?.enteredAt!==null&&!!document.querySelector('[data-slot="app-content"]')&&!document.querySelector('[data-slot="startup-loading"]')&&!document.querySelector('[data-slot="app-content"]').inert`,
      'Warm production startup renders the same frozen scope',
      30000,
    )
    navigationProfile.warmStartupMs = await cdp.eval(
      `window.__sharpStartupProbe.enteredAt-window.__sharpStartupProbe.startedAt`,
    )
    navigationProfile.warmJsHeapBytes = (await cdp.send('Runtime.getHeapUsage')).usedSize
    navigationProfile.warmGeoJSONSetData = await cdp.eval(`window.__sharpGeoJSONUpdates||[]`)
    console.log(
      JSON.stringify({
        warmStartupMs: navigationProfile.warmStartupMs,
        warmJsHeapBytes: navigationProfile.warmJsHeapBytes,
      }),
    )
  }
  const additionalCases = {}
  async function animatedCameraCase() {
    requestPhase = 'analytics-navigation'
    const before = await cdp.eval(
      `(()=>{const map=${liveMap},canvas=map.getCanvas().getBoundingClientRect(),workspace=document.querySelector('.map-workspace').getBoundingClientRect();return{center:map.getCenter().toArray(),zoom:map.getZoom(),canvas:{left:canvas.left,top:canvas.top,width:canvas.width,height:canvas.height},workspace:{left:workspace.left,top:workspace.top,width:workspace.width,height:workspace.height}}})()`,
    )
    const taskBefore = Object.fromEntries(
      (await cdp.send('Performance.getMetrics')).metrics.map(({ name, value }) => [name, value]),
    )
    await cdp.eval(
      `(()=>{const map=${liveMap};const state=window.__sharpAnimationProbe={frames:[],startedAt:performance.now()};const frame=()=>{const now=performance.now();if(map.isMoving()){if(state.last!==undefined)state.frames.push(now-state.last);state.last=now}else state.last=undefined};map.on('render',frame);state.stop=()=>map.off('render',frame);map.easeTo({center:[${before.center[0] + 1},${before.center[1] + 0.3}],zoom:${before.zoom + 0.5},duration:1200});return true})()`,
    )
    await sleep(1350)
    const during = await cdp.eval(
      `({center:${liveMap}.getCenter().toArray(),zoom:${liveMap}.getZoom()})`,
    )
    assert.ok(
      Math.abs(during.center[0] - before.center[0]) > 0.01 ||
        Math.abs(during.zoom - before.zoom) > 0.01,
      'Analytics motion changes the actual live map camera',
    )
    await cdp.eval(
      `void ${liveMap}.easeTo({center:${JSON.stringify(before.center)},zoom:${before.zoom},duration:1200})`,
    )
    await sleep(1350)
    const result = await cdp.eval(
      `(()=>{const s=window.__sharpAnimationProbe;s.stop();return{frames:s.frames,durationMs:performance.now()-s.startedAt,longTasks:window.__sharpLongTasks.filter(e=>e.startTime>=s.startedAt)}})()`,
    )
    const tasksAfter = Object.fromEntries(
      (await cdp.send('Performance.getMetrics')).metrics.map(({ name, value }) => [name, value]),
    )
    const sorted = result.frames.toSorted((a, b) => a - b)
    return {
      kind: 'Camera-verified easeTo/pan/zoom; intervals between actual map render events during motion, excluding idle RAF',
      cameraChanged: true,
      before,
      during,
      durationMs: result.durationMs,
      frameCount: sorted.length,
      frameMedianMs: sorted[Math.ceil(sorted.length * 0.5) - 1],
      frameP95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
      frameMaxMs: sorted.at(-1),
      taskSeconds: tasksAfter.TaskDuration - taskBefore.TaskDuration,
      scriptSeconds: tasksAfter.ScriptDuration - taskBefore.ScriptDuration,
      longTasks: {
        count: result.longTasks.length,
        totalMs: result.longTasks.reduce((sum, e) => sum + e.duration, 0),
        maxMs: Math.max(0, ...result.longTasks.map((e) => e.duration)),
      },
    }
  }
  async function shortCameraCase(label) {
    requestPhase = label
    const heapBefore = (await cdp.send('Runtime.getHeapUsage')).usedSize
    const metricsBefore = Object.fromEntries(
      (await cdp.send('Performance.getMetrics')).metrics.map(({ name, value }) => [name, value]),
    )
    const point = await cdp.eval(
      `(()=>{const r=document.querySelector('.maplibregl-canvas').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`,
    )
    await cdp.eval(
      `window.__sharpCaseProbe={frames:[],startedAt:performance.now(),running:true};requestAnimationFrame(function tick(t){const p=window.__sharpCaseProbe;if(p.last!==undefined)p.frames.push(t-p.last);p.last=t;if(p.running)requestAnimationFrame(tick)})`,
    )
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      ...point,
      button: 'left',
      clickCount: 1,
    })
    for (let i = 1; i <= 12; i++) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: point.x + i * 8,
        y: point.y + i,
        button: 'left',
        buttons: 1,
      })
      await sleep(25)
    }
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: point.x + 96,
      y: point.y + 12,
      button: 'left',
      clickCount: 1,
    })
    for (const deltaY of [-40, 40]) {
      for (let i = 0; i < 4; i++) {
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          ...point,
          deltaX: 0,
          deltaY,
        })
        await sleep(40)
      }
      await sleep(250)
    }
    await sleep(400)
    const sample = await cdp.eval(
      `(()=>{const p=window.__sharpCaseProbe;p.running=false;return{frames:p.frames,durationMs:performance.now()-p.startedAt,longTasks:window.__sharpLongTasks.filter(e=>e.startTime>=p.startedAt)}})()`,
    )
    const metricsAfter = Object.fromEntries(
      (await cdp.send('Performance.getMetrics')).metrics.map(({ name, value }) => [name, value]),
    )
    const frames = sample.frames.toSorted((a, b) => a - b)
    return {
      durationMs: sample.durationMs,
      frameCount: frames.length,
      frameMedianMs: frames[Math.ceil(frames.length * 0.5) - 1],
      frameP95Ms: frames[Math.ceil(frames.length * 0.95) - 1],
      frameMaxMs: frames.at(-1),
      jsHeapBeforeBytes: heapBefore,
      jsHeapAfterBytes: (await cdp.send('Runtime.getHeapUsage')).usedSize,
      taskSeconds: metricsAfter.TaskDuration - metricsBefore.TaskDuration,
      scriptSeconds: metricsAfter.ScriptDuration - metricsBefore.ScriptDuration,
      longTasks: {
        count: sample.longTasks.length,
        totalMs: sample.longTasks.reduce((sum, e) => sum + e.duration, 0),
        maxMs: Math.max(0, ...sample.longTasks.map((e) => e.duration)),
      },
    }
  }
  if (settings.cases && navigationProfile) {
    if (!settings.analyticsOnly) {
      requestPhase = 'dense-load'
      const dense = await fetch(
        `${apiUrl}/test-fixture/dense-region?snapshot=${navigationProfile.snapshotId}&zoom=5`,
      ).then((response) => response.json())
      assert.equal(dense.snapshotId, navigationProfile.snapshotId)
      const loadStarted = performance.now()
      await cdp.eval(`void ${liveMap}.jumpTo({center:${JSON.stringify(dense.center)},zoom:6})`)
      await sleep(250)
      const settled = `(()=>{const map=${liveMap};return map.getContainer().dataset.legacyGlobalLoading!=='true'&&Object.entries(map.getStyle().sources).filter(([id])=>id.startsWith('global-hotspot-raster-')||id==='global-hotspot-aggregates').every(([id])=>map.isSourceLoaded(id))})()`
      await cdp.until(settled, 'Dense stored regional viewport settles', 30000)
      additionalCases.denseRegion = {
        ...dense,
        viewportSettledMs: performance.now() - loadStarted,
        navigation: await shortCameraCase('dense-navigation'),
      }
    }
    requestPhase = 'analytics-open'
    const analyticsStarted = performance.now()
    await cdp.click('Area Analytics')
    await cdp.click('Records')
    await cdp.until(
      `!!document.querySelector('.analytics-records tbody tr')&&document.querySelector('.analytics-records').textContent.includes('matching observations')`,
      'Complete real stored records load beside the mounted map',
      30000,
    )
    additionalCases.analytics = {
      openRecordsMs: performance.now() - analyticsStarted,
      recordRows: await cdp.eval(`document.querySelectorAll('.analytics-records tbody tr').length`),
      scopeLabel: await cdp.eval(
        `document.querySelector('.analytics-records').textContent.slice(0,220)`,
      ),
      navigation: await animatedCameraCase(),
    }
    console.log(JSON.stringify({ additionalCases }))
  }
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  await mkdir('.cache/browser-tests', { recursive: true })
  const artifact = settings.profile ? `navigation-${settings.profile}` : `real-startup-${mode}`
  const fixtureMetrics = await fetch(`${apiUrl}/test-fixture`).then((response) => response.json())
  assert.equal(
    fixtureMetrics.upstreamAttempts.length,
    0,
    'Production browsing uses only stored canonical observations',
  )
  const localTransfers = transfers.filter((response) => response.url.includes('/science-api/'))
  const tileTransfers = localTransfers.filter((response) =>
    /\/global\/(?:raster|tiles|point-tiles)\//.test(response.url),
  )
  const networkSummary = {
    apiRequests: localTransfers.length,
    tileRequests: tileTransfers.length,
    uniqueTileURLs: new Set(tileTransfers.map((response) => response.url)).size,
    duplicateTileRequests:
      tileTransfers.length - new Set(tileTransfers.map((response) => response.url)).size,
    tileEncodedBytes: tileTransfers.reduce((sum, response) => sum + response.encodedBytes, 0),
    cachedTileResponses: tileTransfers.filter((response) => response.cached).length,
    byPhase: Object.fromEntries(
      [
        'startup',
        'navigation',
        'warm-startup',
        'dense-load',
        'dense-navigation',
        'analytics-open',
        'analytics-navigation',
      ].map((phase) => {
        const phaseTiles = tileTransfers.filter((response) => response.phase === phase)
        return [
          phase,
          {
            requests: phaseTiles.length,
            encodedBytes: phaseTiles.reduce((sum, response) => sum + response.encodedBytes, 0),
            cached: phaseTiles.filter((response) => response.cached).length,
          },
        ]
      }),
    ),
  }
  if (!settings.legacy) {
    assert.equal(
      requests.some((url) => /\/global\/(?:tiles|point-tiles)\//.test(url)),
      false,
      'Native raster browsing requests no GeoJSON aggregates or MVT',
    )
    assert.equal(
      navigationProfile?.geoJSONSetData.length ?? 0,
      0,
      'Native raster browsing makes no global GeoJSON setData updates',
    )
  }
  await writeFile(`.cache/browser-tests/${artifact}.png`, Buffer.from(shot.data, 'base64'))
  await writeFile(
    `.cache/browser-tests/${artifact}.json`,
    JSON.stringify(
      {
        mode,
        productionDirectory: production.directory,
        representation: production.representation,
        navigationProfile,
        additionalCases,
        networkSummary,
        records,
        errors,
        requests,
        navigations,
        localTransfers,
        fixtureMetrics,
        log,
      },
      null,
      2,
    ),
  )
  if (cpuProfile)
    await writeFile(`.cache/browser-tests/${artifact}.cpuprofile`, JSON.stringify(cpuProfile))
  assert.ok(
    records.some((record) => !record.gate && record.rendered > 0),
    'Real stored individual observations open the startup gate',
  )
  assert.deepEqual(errors, [], 'Dense canonical observations render without browser exceptions')
  if (navigationProfile)
    assert.equal(
      navigationProfile.contextLost,
      false,
      'The fixed navigation gesture retains one document context',
    )
} catch (error) {
  await mkdir('.cache/browser-tests', { recursive: true })
  await writeFile(
    '.cache/browser-tests/startup-diagnostic-failure.json',
    JSON.stringify({ error: String(error), records, errors, requests, navigations, log }, null, 2),
  )
  throw error
} finally {
  try {
    await fetch(`${apiUrl}/test-fixture/shutdown`, { method: 'POST' })
  } catch {}
  cdp?.socket.close()
  for (const child of children) if (child.exitCode == null) child.kill()
  await sleep(500)
  if (
    resolve(profile).startsWith(resolve(tmpdir()) + sep) &&
    profile.includes('sharp-startup-probe-')
  )
    await rm(profile, { recursive: true, force: true }).catch(() => {})
}
