import { resolve, sep } from 'node:path'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

/** Build and preview the same production bundle, using an isolated output directory. */
export async function productionPreview({
  launch,
  apiUrl,
  port,
  legacy = false,
  reuseDirectory,
  onLog = () => {},
}) {
  const directory = reuseDirectory
    ? resolve(reuseDirectory)
    : resolve('.cache/browser-tests', `${legacy ? 'legacy-json' : 'raster'}-${randomUUID()}-dist`)
  const environment = {
    ...process.env,
    VITE_FIRMS_API_BASE_URL: '/science-api',
    SHARP_API_PROXY_TARGET: apiUrl,
    SHARP_LEGACY_GLOBAL_BENCHMARK: legacy ? '1' : '0',
  }
  let buildLog = ''
  if (reuseDirectory) {
    if (
      !directory.startsWith(resolve('.cache/browser-tests') + sep) ||
      !existsSync(resolve(directory, 'index.html'))
    )
      throw new Error('Only an existing isolated production browser bundle may be reused')
    buildLog = `Reused production bundle: ${directory}`
  } else {
    const build = launch(
      process.execPath,
      [
        'node_modules/vite/bin/vite.js',
        'build',
        '--config',
        'tools/browser-production-config.mjs',
        '--outDir',
        directory,
      ],
      { env: environment },
    )
    for (const stream of [build.stdout, build.stderr])
      stream.on('data', (chunk) => {
        buildLog += chunk
        onLog(String(chunk))
      })
    await new Promise((done, fail) => {
      build.once('error', fail)
      build.once('exit', (code) =>
        code === 0
          ? done()
          : fail(new Error(`Production browser build failed (${code}): ${buildLog}`)),
      )
    })
  }
  const preview = launch(
    process.execPath,
    [
      'node_modules/vite/bin/vite.js',
      'preview',
      '--config',
      'tools/browser-production-config.mjs',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
      '--outDir',
      directory,
    ],
    { env: environment },
  )
  for (const stream of [preview.stdout, preview.stderr])
    stream.on('data', (chunk) => onLog(String(chunk)))
  return {
    preview,
    directory,
    frontendUrl: `http://127.0.0.1:${port}`,
    representation: legacy
      ? 'legacy JSON GeoJSON aggregates and observation symbols'
      : 'native transparent raster tiles',
    buildLog,
  }
}
