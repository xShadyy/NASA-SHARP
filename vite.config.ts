import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

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
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { '@': path.resolve(import.meta.dirname, './src') },
    },
    server: { proxy: { ...apiProxy, ...configuredProxy } },
    preview: { proxy: { ...apiProxy, ...configuredProxy } },
  }
})
