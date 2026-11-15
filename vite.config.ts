import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import { readFileSync } from 'node:fs'

function legalNotices(): Plugin {
  const notices = new Map([
    ['/legal/LICENSE', path.resolve(import.meta.dirname, 'LICENSE')],
    [
      '/legal/THIRD-PARTY-LICENSES.txt',
      path.resolve(import.meta.dirname, 'THIRD-PARTY-LICENSES.txt'),
    ],
  ])
  return {
    name: 'sharp-legal-notices',
    generateBundle() {
      for (const [url, file] of notices)
        this.emitFile({ type: 'asset', fileName: url.slice(1), source: readFileSync(file, 'utf8') })
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const file = notices.get((request.url ?? '').split('?')[0])
        if (!file) return next()
        response.setHeader('Content-Type', 'text/plain; charset=utf-8')
        response.setHeader('X-Content-Type-Options', 'nosniff')
        response.end(readFileSync(file, 'utf8'))
      })
    },
  }
}

const apiTarget = process.env.SHARP_API_PROXY_TARGET || 'http://127.0.0.1:8000'
const apiProxy = {
  '/firms-api': {
    target: apiTarget,
    rewrite: (requestPath: string) => requestPath.replace(/^\/firms-api/, ''),
  },
  '/api': {
    target: apiTarget,
    changeOrigin: true,
    rewrite: (requestPath: string) => requestPath.replace(/^\/api/, ''),
  },
}

export default defineConfig(({ mode }) => {
  const configuredBase =
    process.env.VITE_FIRMS_API_BASE_URL ?? loadEnv(mode, process.cwd(), '').VITE_FIRMS_API_BASE_URL
  const configuredProxy = configuredBase?.startsWith('/')
    ? {
        [configuredBase.replace(/\/+$/, '')]: {
          target: apiTarget,
          rewrite: (requestPath: string) =>
            requestPath.slice(configuredBase.replace(/\/+$/, '').length) || '/',
        },
      }
    : {}
  return {
    plugins: [react(), tailwindcss(), legalNotices()],
    resolve: {
      alias: { '@': path.resolve(import.meta.dirname, './src') },
    },
    server: { proxy: { ...apiProxy, ...configuredProxy } },
    preview: { proxy: { ...apiProxy, ...configuredProxy } },
  }
})
